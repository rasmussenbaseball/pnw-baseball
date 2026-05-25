"""
Email sender via Google Workspace SMTP relay.

Talks to `smtp-relay.gmail.com:587` over STARTTLS, authenticating with
an app-password generated for the Workspace user that owns the
`info@nwbaseballstats.com` alias.

Why Workspace and not a dedicated provider:
  • Already paying for Workspace ($0 marginal cost vs $20/mo Resend Pro)
  • SMTP relay caps at 10,000 / day per user — 10x our heaviest send
  • DKIM/SPF for nwbaseballstats.com are already set up under Google
  • Best deliverability into Gmail (most of our subscribers are there)

Each email is personalized: the unsubscribe link in the footer and the
RFC 8058 List-Unsubscribe header both use the recipient's per-row
`unsubscribe_token` so one click flips THEIR row, not anyone else's.

Sends are sequential over a single keep-alive SMTP connection. At our
scale (max ~1k/day, typical sends 600/blast) that's well under any rate
limit and finishes in well under a minute.

Env vars:
  WORKSPACE_RELAY_USER     — full Workspace user email (e.g.
                              nate@nwbaseballstats.com — the underlying
                              account, NOT the info@ alias)
  WORKSPACE_RELAY_PASSWORD — 16-char Google app password
  EMAIL_FROM               — header from address, default
                              "NW Baseball Stats <info@nwbaseballstats.com>"
  SITE_URL                 — base URL for unsubscribe links, default
                              https://nwbaseballstats.com
"""

from __future__ import annotations

import os
import re
import smtplib
from dataclasses import dataclass
from email.message import EmailMessage
from email.utils import make_msgid
from typing import Iterable, List, Optional


SMTP_HOST = "smtp-relay.gmail.com"
SMTP_PORT = 587


def _site_url() -> str:
    return os.getenv("SITE_URL", "https://nwbaseballstats.com").rstrip("/")


def _from_address() -> str:
    return os.getenv("EMAIL_FROM", "NW Baseball Stats <info@nwbaseballstats.com>")


def _relay_credentials() -> tuple[str, str]:
    user = os.getenv("WORKSPACE_RELAY_USER", "")
    pwd = os.getenv("WORKSPACE_RELAY_PASSWORD", "")
    if not user or not pwd:
        raise RuntimeError(
            "WORKSPACE_RELAY_USER / WORKSPACE_RELAY_PASSWORD not configured. "
            "Set both in the server's .env to enable broadcasts."
        )
    return user, pwd


# ─────────────────────────────────────────────────────────────────
# Markdown → HTML
# ─────────────────────────────────────────────────────────────────
# We render server-side so the email body is self-contained. The
# converter is small on purpose — emails have terrible CSS support and
# the simpler the HTML, the better it renders across Gmail/Apple/Outlook.
# ─────────────────────────────────────────────────────────────────

_LINK_RE   = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")
_BOLD_RE   = re.compile(r"\*\*([^*]+)\*\*")
_ITAL_RE   = re.compile(r"(?<!\*)\*([^*]+)\*(?!\*)")
_CODE_RE   = re.compile(r"`([^`]+)`")
_IMG_RE    = re.compile(r"!\[([^\]]*)\]\(([^)]+)\)")


def _escape_html(s: str) -> str:
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def _inline_md(text: str) -> str:
    # Images first (they look like links with a leading !).
    text = _IMG_RE.sub(
        lambda m: f'<img src="{_escape_html(m.group(2))}" alt="{_escape_html(m.group(1))}" '
                  f'style="max-width:100%;height:auto;border-radius:8px;margin:8px 0;">',
        text,
    )
    text = _LINK_RE.sub(
        lambda m: f'<a href="{_escape_html(m.group(2))}" '
                  f'style="color:#0f766e;text-decoration:underline;">'
                  f'{_escape_html(m.group(1))}</a>',
        text,
    )
    text = _BOLD_RE.sub(lambda m: f"<strong>{_escape_html(m.group(1))}</strong>", text)
    text = _ITAL_RE.sub(lambda m: f"<em>{_escape_html(m.group(1))}</em>", text)
    text = _CODE_RE.sub(lambda m: f'<code style="background:#f3f4f6;padding:1px 5px;border-radius:3px;">'
                                   f'{_escape_html(m.group(1))}</code>', text)
    return text


def md_to_html(body_md: str) -> str:
    """Minimal markdown → HTML conversion suitable for email bodies.
    Supports: headings (#, ##, ###), bold/italic/code, links, images,
    blockquotes, unordered/ordered lists, paragraphs."""
    if not body_md:
        return ""

    out: List[str] = []
    i = 0
    lines = body_md.replace("\r\n", "\n").split("\n")
    n = len(lines)

    def flush_para(buf: List[str]) -> None:
        if not buf:
            return
        joined = " ".join(buf).strip()
        if joined:
            # NOTE: we _escape_html BEFORE inline-MD substitutions so the
            # raw < > & in user text get encoded, but the <em> / <strong>
            # tags we emit afterwards stay live.
            joined = _inline_md(_escape_html(joined))
            out.append(f'<p style="margin:0 0 14px 0;line-height:1.55;">{joined}</p>')
        buf.clear()

    para_buf: List[str] = []
    while i < n:
        line = lines[i]
        stripped = line.strip()

        # Blank line → close current paragraph.
        if not stripped:
            flush_para(para_buf)
            i += 1
            continue

        # Headings.
        m = re.match(r"^(#{1,3})\s+(.*)$", stripped)
        if m:
            flush_para(para_buf)
            level = len(m.group(1))
            txt = _inline_md(_escape_html(m.group(2)))
            sizes = {1: "24px", 2: "20px", 3: "16px"}
            out.append(
                f'<h{level} style="font-size:{sizes[level]};'
                f'margin:22px 0 10px 0;font-weight:700;color:#111;">{txt}</h{level}>'
            )
            i += 1
            continue

        # Blockquote.
        if stripped.startswith("> "):
            flush_para(para_buf)
            quote_buf = []
            while i < n and lines[i].strip().startswith("> "):
                quote_buf.append(lines[i].strip()[2:])
                i += 1
            txt = _inline_md(_escape_html(" ".join(quote_buf)))
            out.append(
                f'<blockquote style="margin:14px 0;padding:8px 14px;border-left:3px solid #0f766e;'
                f'color:#374151;font-style:italic;">{txt}</blockquote>'
            )
            continue

        # Lists (unordered).
        if re.match(r"^[-*+]\s+", stripped):
            flush_para(para_buf)
            items = []
            while i < n and re.match(r"^[-*+]\s+", lines[i].strip()):
                items.append(re.sub(r"^[-*+]\s+", "", lines[i].strip()))
                i += 1
            li = "".join(
                f'<li style="margin:4px 0;line-height:1.55;">{_inline_md(_escape_html(it))}</li>'
                for it in items
            )
            out.append(f'<ul style="margin:8px 0 14px 22px;padding:0;">{li}</ul>')
            continue

        # Lists (ordered).
        if re.match(r"^\d+\.\s+", stripped):
            flush_para(para_buf)
            items = []
            while i < n and re.match(r"^\d+\.\s+", lines[i].strip()):
                items.append(re.sub(r"^\d+\.\s+", "", lines[i].strip()))
                i += 1
            li = "".join(
                f'<li style="margin:4px 0;line-height:1.55;">{_inline_md(_escape_html(it))}</li>'
                for it in items
            )
            out.append(f'<ol style="margin:8px 0 14px 22px;padding:0;">{li}</ol>')
            continue

        # Standalone image line (rendered as a block, not wrapped in <p>).
        if _IMG_RE.fullmatch(stripped):
            flush_para(para_buf)
            out.append(_inline_md(stripped))  # _inline_md handles ![alt](url)
            i += 1
            continue

        # Default: paragraph text. Buffer and concat.
        para_buf.append(stripped)
        i += 1

    flush_para(para_buf)
    return "\n".join(out)


# ─────────────────────────────────────────────────────────────────
# Email envelope
# ─────────────────────────────────────────────────────────────────

@dataclass
class Recipient:
    """One person to send to. The token is the per-user UUID from
    `email_preferences.unsubscribe_token` and is used to build a
    personalized unsubscribe URL."""
    email: str
    token: str


def unsubscribe_url(token: str) -> str:
    return f"{_site_url()}/unsubscribe?token={token}"


def build_html(subject: str, body_html: str, unsub_url: str) -> str:
    """Wrap rendered body HTML in a clean, table-based email shell so
    Gmail/Apple Mail/Outlook all render it consistently. Footer carries
    the unsubscribe link."""
    return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>{_escape_html(subject)}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1f2937;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f3f4f6;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="background:#ffffff;border-radius:12px;overflow:hidden;max-width:600px;width:100%;">
        <tr><td style="padding:24px 28px 8px 28px;">
          <a href="{_site_url()}" style="text-decoration:none;color:#0f766e;font-weight:800;font-size:14px;letter-spacing:0.08em;text-transform:uppercase;">NW Baseball Stats</a>
        </td></tr>
        <tr><td style="padding:8px 28px 24px 28px;font-size:15px;color:#1f2937;">
          {body_html}
        </td></tr>
        <tr><td style="padding:18px 28px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;">
          You're receiving this because you subscribed at <a href="{_site_url()}" style="color:#0f766e;">nwbaseballstats.com</a>.<br>
          <a href="{unsub_url}" style="color:#6b7280;text-decoration:underline;">Manage email preferences or unsubscribe</a>.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>"""


def build_text(body_md: str, unsub_url: str) -> str:
    """Plain-text fallback for clients that prefer text/plain. We just
    strip markdown formatting and append the unsubscribe URL."""
    txt = body_md or ""
    txt = _IMG_RE.sub(r"[image: \1]", txt)
    txt = _LINK_RE.sub(r"\1 (\2)", txt)
    txt = _BOLD_RE.sub(r"\1", txt)
    txt = _ITAL_RE.sub(r"\1", txt)
    txt = _CODE_RE.sub(r"\1", txt)
    txt = re.sub(r"^#{1,6}\s*", "", txt, flags=re.MULTILINE)
    return (
        f"{txt.strip()}\n\n"
        f"— NW Baseball Stats\n\n"
        f"Manage email preferences / unsubscribe: {unsub_url}\n"
    )


def _build_message(
    *,
    subject: str,
    body_md: str,
    body_html_inner: str,
    recipient: Recipient,
    from_addr: str,
    reply_to: Optional[str],
) -> EmailMessage:
    """Build one EmailMessage for one recipient. Sets the personalized
    List-Unsubscribe header so Gmail/Apple Mail show their native
    "Unsubscribe" button at the top of the message."""
    unsub = unsubscribe_url(recipient.token)
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"]    = from_addr
    msg["To"]      = recipient.email
    msg["Message-ID"] = make_msgid(domain="nwbaseballstats.com")
    if reply_to:
        msg["Reply-To"] = reply_to
    # RFC 8058 one-click unsubscribe — Gmail shows this as a native
    # "Unsubscribe" link at the top of the email.
    msg["List-Unsubscribe"] = f"<{unsub}>"
    msg["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"

    # Build the text + html multipart body.
    msg.set_content(build_text(body_md, unsub))
    msg.add_alternative(build_html(subject, body_html_inner, unsub), subtype="html")
    return msg


# ─────────────────────────────────────────────────────────────────
# Send
# ─────────────────────────────────────────────────────────────────

def send_broadcast(
    subject: str,
    body_md: str,
    recipients: Iterable[Recipient],
    *,
    reply_to: Optional[str] = None,
) -> dict:
    """Send `subject` + `body_md` to every Recipient. Returns
    {sent: int, failed: int, errors: [str]}. Each email is personalized
    with the recipient's unsubscribe URL + List-Unsubscribe header.

    Sends sequentially over a single keep-alive SMTP connection so a
    600-recipient blast completes in roughly 30-90 seconds depending on
    network latency."""
    relay_user, relay_pwd = _relay_credentials()
    from_addr = _from_address()
    body_html_inner = md_to_html(body_md)

    rcpts = list(recipients)
    if not rcpts:
        return {"sent": 0, "failed": 0, "errors": []}

    sent = 0
    failed = 0
    errors: List[str] = []

    try:
        # `with` ensures the connection is closed even if we throw.
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=30) as smtp:
            smtp.ehlo()
            smtp.starttls()
            smtp.ehlo()
            smtp.login(relay_user, relay_pwd)

            for r in rcpts:
                try:
                    msg = _build_message(
                        subject=subject,
                        body_md=body_md,
                        body_html_inner=body_html_inner,
                        recipient=r,
                        from_addr=from_addr,
                        reply_to=reply_to,
                    )
                    smtp.send_message(msg)
                    sent += 1
                except (smtplib.SMTPRecipientsRefused,
                        smtplib.SMTPDataError,
                        smtplib.SMTPSenderRefused) as e:
                    failed += 1
                    if len(errors) < 10:
                        errors.append(f"{r.email}: {e}")
                except smtplib.SMTPServerDisconnected as e:
                    # Server kicked us — record what's left as failed and
                    # bail out of the loop. Re-connect logic would be a
                    # nice add-on if this happens regularly.
                    failed += 1
                    if len(errors) < 10:
                        errors.append(f"{r.email}: server disconnected ({e})")
                    remaining = len(rcpts) - sent - failed
                    if remaining > 0:
                        failed += remaining
                        errors.append(f"abandoned {remaining} more recipients after disconnect")
                    break
    except (smtplib.SMTPAuthenticationError, smtplib.SMTPException, OSError) as e:
        # Connection / auth-level failure: everyone is unsent.
        unsent = len(rcpts) - sent
        failed += unsent
        errors.insert(0, f"SMTP connection failed: {e}")

    return {"sent": sent, "failed": failed, "errors": errors[:10]}
