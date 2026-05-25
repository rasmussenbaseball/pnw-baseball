"""
Resend email sender (Phase 2 of the newsletter pipeline).

Talks to https://resend.com via their REST API. We use Resend rather than
SES/Mailgun because the setup is dead simple (DKIM TXT + one API key) and
the free tier (3k/mo, 100/day) is plenty for an opt-in mailing list of a
few hundred subscribers.

Each email is personalized: the unsubscribe link in the footer and the
RFC 8058 List-Unsubscribe header both use the recipient's per-row
`unsubscribe_token` so one click flips THEIR row, not anyone else's.

We use Resend's /emails/batch endpoint (up to 100 messages per call) so
a broadcast of a few hundred names goes out in 2-3 round-trips rather
than N individual API calls.

Env vars:
  RESEND_API_KEY    — API key from resend.com → API Keys
  EMAIL_FROM        — "Display Name <info@nwbaseballstats.com>"
                      defaults to "NW Baseball Stats <info@nwbaseballstats.com>"
  SITE_URL          — base URL for unsubscribe links (defaults to
                      https://nwbaseballstats.com)
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Iterable, List, Optional

import httpx


_RESEND_URL = "https://api.resend.com/emails/batch"
_BATCH_SIZE = 100


def _site_url() -> str:
    return os.getenv("SITE_URL", "https://nwbaseballstats.com").rstrip("/")


def _from_address() -> str:
    return os.getenv("EMAIL_FROM", "NW Baseball Stats <info@nwbaseballstats.com>")


def _api_key() -> str:
    key = os.getenv("RESEND_API_KEY", "")
    if not key:
        raise RuntimeError("RESEND_API_KEY not configured on the server.")
    return key


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


def build_signature_html() -> str:
    """Branded sign-off block appended after the article body in every
    broadcast. Uses an inline image table layout so Gmail / Apple Mail /
    Outlook all render the logo next to the text consistently.

    The logo URL points at the public favicon.png served by the FastAPI
    SPA-fallback handler. If we ever publish a higher-res sender logo
    we can swap this single URL."""
    site = _site_url()
    logo_url = f"{site}/favicon.png"
    return f"""
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
               style="margin-top:28px;padding-top:18px;border-top:1px solid #e5e7eb;">
          <tr>
            <td width="60" style="vertical-align:middle;padding-right:14px;">
              <a href="{site}" style="text-decoration:none;">
                <img src="{logo_url}" alt="NW Baseball Stats"
                     width="48" height="48"
                     style="display:block;border-radius:10px;width:48px;height:48px;">
              </a>
            </td>
            <td style="vertical-align:middle;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
              <div style="font-weight:800;color:#0f766e;font-size:14px;letter-spacing:0.04em;line-height:1.2;">
                NW Baseball Stats
              </div>
              <div style="font-size:12px;color:#6b7280;line-height:1.4;margin-top:2px;">
                College baseball analytics for the Pacific Northwest.
              </div>
              <div style="font-size:12px;margin-top:4px;">
                <a href="{site}" style="color:#0f766e;text-decoration:none;font-weight:600;">nwbaseballstats.com</a>
              </div>
            </td>
          </tr>
        </table>
    """.strip()


def build_html(subject: str, body_html: str, unsub_url: str) -> str:
    """Wrap rendered body HTML in a clean, table-based email shell so
    Gmail/Apple Mail/Outlook all render it consistently. Includes a
    branded signature block after the body and an unsubscribe footer
    below that."""
    signature = build_signature_html()
    return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>{_escape_html(subject)}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1f2937;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f3f4f6;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="background:#ffffff;border-radius:12px;overflow:hidden;max-width:600px;width:100%;">
        <tr><td style="padding:24px 28px 8px 28px;">
          <a href="{_site_url()}" style="text-decoration:none;color:#0f766e;font-weight:800;font-size:14px;letter-spacing:0.08em;text-transform:uppercase;">NW Baseball Stats</a>
        </td></tr>
        <tr><td style="padding:8px 28px 12px 28px;font-size:15px;color:#1f2937;">
          {body_html}
          {signature}
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

    Batched 100/request via Resend's /emails/batch endpoint."""
    api_key = _api_key()
    from_addr = _from_address()
    body_html_inner = md_to_html(body_md)

    rcpts = list(recipients)
    if not rcpts:
        return {"sent": 0, "failed": 0, "errors": []}

    def make_email(r: Recipient) -> dict:
        unsub = unsubscribe_url(r.token)
        email = {
            "from": from_addr,
            "to": [r.email],
            "subject": subject,
            "html": build_html(subject, body_html_inner, unsub),
            "text": build_text(body_md, unsub),
            "headers": {
                # RFC 8058 one-click unsubscribe. Gmail/Apple Mail show
                # this as a native "Unsubscribe" link in the message header.
                "List-Unsubscribe": f"<{unsub}>",
                "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            },
        }
        if reply_to:
            email["reply_to"] = reply_to
        return email

    sent = 0
    failed = 0
    errors: List[str] = []

    # Batch in chunks of _BATCH_SIZE. Resend's batch endpoint accepts an
    # array body and returns a parallel array of per-email IDs.
    for start in range(0, len(rcpts), _BATCH_SIZE):
        batch = rcpts[start:start + _BATCH_SIZE]
        payload = [make_email(r) for r in batch]
        try:
            resp = httpx.post(
                _RESEND_URL,
                json=payload,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                timeout=30.0,
            )
        except httpx.RequestError as e:
            failed += len(batch)
            errors.append(f"network error on batch starting at {start}: {e}")
            continue

        if resp.status_code >= 300:
            failed += len(batch)
            errors.append(f"HTTP {resp.status_code} on batch starting at {start}: {resp.text[:200]}")
            continue

        # Resend returns {data: [{id: ...}, ...]} on success. We count
        # only entries that came back with an id; anything else is a
        # silent fail.
        try:
            data = resp.json().get("data") or []
        except Exception:
            data = []
        ok = sum(1 for d in data if isinstance(d, dict) and d.get("id"))
        sent += ok
        if ok < len(batch):
            failed += len(batch) - ok
            errors.append(
                f"batch starting at {start}: only {ok}/{len(batch)} emails accepted"
            )

    return {"sent": sent, "failed": failed, "errors": errors[:10]}  # cap error list
