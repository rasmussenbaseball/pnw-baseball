"""
Articles / News backend.

A small CMS-lite for the public /news section. Articles are stored in
the `articles` table; the public side reads only `status='published'`,
and the portal-gated editor lets any authenticated user write drafts and
publish them.

Body is plain markdown — the frontend renders it with react-markdown.
Hero images and any inline images are pasted in as URLs for Phase 1; a
later phase will wire Supabase Storage uploads.
"""

from __future__ import annotations

import os
import re
import time
import uuid
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile, File

from pydantic import BaseModel, Field

from ..models.database import get_connection
from .auth import _extract_token, _get_supabase_url

router = APIRouter()


# ─────────────────────────────────────────────────────────────────
# Author allowlist — only these emails can write/publish articles or
# upload article images. Override via env var if needed (comma-separated).
# ─────────────────────────────────────────────────────────────────

_DEFAULT_AUTHORS = "nate.rasmussen26@gmail.com,pnwcbr@gmail.com"


def _allowed_emails() -> set[str]:
    raw = os.getenv("ARTICLE_AUTHOR_EMAILS", _DEFAULT_AUTHORS)
    return {e.strip().lower() for e in raw.split(",") if e.strip()}


def _resolve_author(request: Request) -> dict:
    """Verify the Supabase token, fetch the user's profile, and confirm the
    user's email is on the article-author allowlist. Returns
    {user_id, email} on success. Raises 401 (no token), 403 (not author)."""
    token = _extract_token(request)
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")

    supabase_url = _get_supabase_url()
    try:
        resp = httpx.get(
            f"{supabase_url}/auth/v1/user",
            headers={
                "Authorization": f"Bearer {token}",
                "apikey": os.getenv("SUPABASE_SERVICE_ROLE_KEY", ""),
            },
            timeout=5.0,
        )
    except httpx.RequestError:
        raise HTTPException(status_code=502, detail="Auth check failed")

    if resp.status_code != 200:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    data = resp.json() or {}
    user_id = data.get("id")
    email = (data.get("email") or "").strip().lower()
    if not user_id or not email:
        raise HTTPException(status_code=401, detail="No user info")

    if email not in _allowed_emails():
        raise HTTPException(status_code=403, detail="Not an authorized article author")

    return {"user_id": user_id, "email": email}


# ─────────────────────────────────────────────────────────────────
# Schemas
# ─────────────────────────────────────────────────────────────────

class ArticleCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    subtitle: Optional[str] = Field(None, max_length=300)
    body_md: str = Field(default="")
    body_html: Optional[str] = None   # rich-editor (TipTap) HTML; preferred over body_md when set
    hero_image_url: Optional[str] = None
    author_name: str = Field(..., min_length=1, max_length=120)
    slug: Optional[str] = None  # auto-generated from title if omitted
    requires_tier: Optional[str] = Field(default="free", pattern="^(free|premium|coach)$")


class ArticleUpdate(BaseModel):
    title: Optional[str] = Field(None, min_length=1, max_length=200)
    subtitle: Optional[str] = Field(None, max_length=300)
    body_md: Optional[str] = None
    body_html: Optional[str] = None
    hero_image_url: Optional[str] = None
    author_name: Optional[str] = Field(None, min_length=1, max_length=120)
    slug: Optional[str] = None
    requires_tier: Optional[str] = Field(None, pattern="^(free|premium|coach)$")


class ArticlePublishToggle(BaseModel):
    publish: bool


# ─────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────

_SLUG_RE = re.compile(r"[^a-z0-9]+")

# Paywall break marker. Authors insert this via a toolbar button in
# /articles/edit. It's an HTML comment so it never renders in any
# markdown processor — invisible to readers regardless of locked state.
#
# When a tier-locked viewer fetches the article, everything BEFORE the
# marker is sent as a free preview; everything AFTER is stripped. When
# an unlocked viewer fetches, the marker itself is stripped so the body
# reads continuously.
PAYWALL_MARKER = "<!-- nwbb:paywall -->"
# Rich-editor (TipTap) paywall break serializes to an <hr data-paywall> element.
PAYWALL_MARKER_HTML_RE = re.compile(r"<hr[^>]*data-paywall[^>]*>", re.IGNORECASE)


def _slugify(text: str) -> str:
    """Turn a title into a URL-safe slug. Trims to 80 chars to keep URLs sane."""
    s = (text or "").lower()
    s = _SLUG_RE.sub("-", s).strip("-")
    return s[:80] or "untitled"


def _unique_slug(cur, base: str, ignore_id: Optional[int] = None) -> str:
    """Append -2, -3, ... until the slug is unique. Idempotent on updates
    via the optional `ignore_id` exclusion."""
    candidate = base
    n = 2
    while True:
        if ignore_id is None:
            cur.execute("SELECT 1 FROM articles WHERE slug = %s LIMIT 1", (candidate,))
        else:
            cur.execute("SELECT 1 FROM articles WHERE slug = %s AND id <> %s LIMIT 1",
                        (candidate, ignore_id))
        if not cur.fetchone():
            return candidate
        candidate = f"{base}-{n}"
        n += 1


def _read_excerpt(body_md: str, max_chars: int = 200) -> str:
    """First-line-ish summary stripped of basic markdown syntax. Plenty good
    for an article-card preview; the full body is rendered on the detail page."""
    if not body_md:
        return ""
    # Drop markdown headings/quotes/list markers from the leading lines.
    stripped = re.sub(r"^[#>*\-\s]+", "", body_md.strip().splitlines()[0])
    # Collapse inline `code`, **bold**, *italics*, [text](url) → text.
    stripped = re.sub(r"`([^`]+)`", r"\1", stripped)
    stripped = re.sub(r"\*\*([^*]+)\*\*", r"\1", stripped)
    stripped = re.sub(r"\*([^*]+)\*", r"\1", stripped)
    stripped = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", stripped)
    if len(stripped) > max_chars:
        stripped = stripped[: max_chars - 1].rsplit(" ", 1)[0] + "…"
    return stripped


def _row_to_summary(r: dict) -> dict:
    """Shape for list endpoints — no body_md to keep payloads small."""
    return {
        "id": r["id"],
        "slug": r["slug"],
        "title": r["title"],
        "subtitle": r["subtitle"],
        "hero_image_url": r["hero_image_url"],
        "author_name": r["author_name"],
        "status": r["status"],
        "requires_tier": r.get("requires_tier") or "free",
        "published_at": r["published_at"].isoformat() if r["published_at"] else None,
        "created_at": r["created_at"].isoformat() if r["created_at"] else None,
        "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
        "excerpt": _read_excerpt(r.get("body_md") or "") or _html_excerpt(r.get("body_html") or ""),
    }


def _html_excerpt(body_html: str, max_chars: int = 200) -> str:
    """Plain-text excerpt from rich-editor HTML (strip tags, collapse space)."""
    if not body_html:
        return ""
    text = re.sub(r"<[^>]+>", " ", body_html)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > max_chars:
        text = text[: max_chars - 1].rsplit(" ", 1)[0] + "…"
    return text


def _row_to_full(r: dict) -> dict:
    return {**_row_to_summary(r),
            "body_md": r["body_md"] or "",
            "body_html": r.get("body_html") or ""}


def _tier_meets(actual: str, required: str) -> bool:
    """Mirror of frontend lib/tiers.js tierMeets — true if `actual` is
    at-or-above `required` on the tier ladder."""
    rank = {"none": 0, "free": 1, "premium": 2, "coach": 3, "dev": 99}
    return rank.get(actual, 0) >= rank.get(required, 0)


def _viewer_context(request) -> dict:
    """Resolve the request's viewer: their user_id (if any) and tier.

    Honors TIER_GATING_ENABLED — when gating is off, returns 'coach'
    (max access) so paywalls are inert in soft mode.

    Returns {'user_id': str|None, 'tier': str}. Tier is one of
    'none' / 'free' / 'premium' / 'coach'."""
    if os.getenv("TIER_GATING_ENABLED", "").strip().lower() != "true":
        # Soft mode: we still want user_id so the author-bypass works
        # for unpublished article previews, but tier is effectively max.
        token = _extract_token(request)
        if not token:
            return {"user_id": None, "tier": "coach"}
        supabase_url = _get_supabase_url()
        try:
            resp = httpx.get(
                f"{supabase_url}/auth/v1/user",
                headers={
                    "Authorization": f"Bearer {token}",
                    "apikey": os.getenv("SUPABASE_SERVICE_ROLE_KEY", ""),
                },
                timeout=5.0,
            )
        except httpx.RequestError:
            return {"user_id": None, "tier": "coach"}
        if resp.status_code != 200:
            return {"user_id": None, "tier": "coach"}
        uid = (resp.json() or {}).get("id")
        return {"user_id": uid, "tier": "coach"}

    # Hard mode
    token = _extract_token(request)
    if not token:
        return {"user_id": None, "tier": "none"}
    supabase_url = _get_supabase_url()
    try:
        resp = httpx.get(
            f"{supabase_url}/auth/v1/user",
            headers={
                "Authorization": f"Bearer {token}",
                "apikey": os.getenv("SUPABASE_SERVICE_ROLE_KEY", ""),
            },
            timeout=5.0,
        )
    except httpx.RequestError:
        return {"user_id": None, "tier": "none"}
    if resp.status_code != 200:
        return {"user_id": None, "tier": "none"}
    body = resp.json() or {}
    uid = body.get("id")
    email = body.get("email")
    if not uid:
        return {"user_id": None, "tier": "none"}
    # Developers / comped emails (interns, staff) are granted a tier via
    # the allowlist regardless of their subscription row, so they can see
    # every article. This mirrors require_tier() in auth.py.
    comped = None
    try:
        from ._tier_allowlist import resolve_comped_tier
        comped = resolve_comped_tier(email) if email else None
    except Exception:
        comped = None
    if comped:
        return {"user_id": uid, "tier": comped}
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT tier FROM user_subscriptions WHERE user_id = %s", (uid,))
        row = cur.fetchone()
    tier = (row or {}).get("tier") or "free"
    return {"user_id": uid, "tier": tier}


# Kept for back-compat — call sites that only need the tier still work.
def _viewer_tier(request) -> str:
    return _viewer_context(request).get("tier", "none")


# ─────────────────────────────────────────────────────────────────
# Public endpoints
# ─────────────────────────────────────────────────────────────────

@router.get("/articles")
def list_published_articles(limit: int = 50):
    """List all published articles, newest first. Public."""
    limit = max(1, min(int(limit), 100))
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT id, slug, title, subtitle, body_md, body_html, hero_image_url,
                   author_id, author_name, status, requires_tier,
                   published_at, created_at, updated_at
            FROM articles
            WHERE status = 'published'
            ORDER BY published_at DESC NULLS LAST, id DESC
            LIMIT %s
            """,
            (limit,),
        )
        return {"articles": [_row_to_summary(dict(r)) for r in cur.fetchall()]}


@router.get("/articles/{slug}")
def get_published_article(slug: str, request: Request):
    """Fetch one published article by slug. Public, but the body_md is
    only returned if the viewer's tier meets the article's requires_tier
    (which defaults to 'free'). For paywalled articles, lower-tier
    viewers get back metadata + excerpt + locked=true; the frontend
    renders the paywall card."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT id, slug, title, subtitle, body_md, body_html, hero_image_url,
                   author_id, author_name, status, requires_tier,
                   published_at, created_at, updated_at
            FROM articles
            WHERE slug = %s AND status = 'published'
            """,
            (slug,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Article not found")
        r = dict(row)
        required = r.get("requires_tier") or "free"
        ctx = _viewer_context(request)
        actual = ctx["tier"]
        viewer_user_id = ctx["user_id"]
        is_author = bool(viewer_user_id) and str(r.get("author_id")) == str(viewer_user_id)
        full = _row_to_full(r)
        raw_body = full.get("body_md") or ""
        raw_html = full.get("body_html") or ""
        has_marker = PAYWALL_MARKER in raw_body
        has_marker_html = bool(PAYWALL_MARKER_HTML_RE.search(raw_html))

        # Authors always see their own articles unlocked — even paywalled
        # ones — so they can preview the rendered output. The published
        # version still locks for everyone else.
        if is_author or _tier_meets(actual, required):
            # Unlocked viewer: strip the break marker so the body reads
            # continuously (works for both markdown and rich-HTML bodies).
            full["body_md"] = raw_body.replace(PAYWALL_MARKER, "").strip()
            full["body_html"] = PAYWALL_MARKER_HTML_RE.sub("", raw_html)
            full["locked"] = False
            full["has_preview_break"] = has_marker or has_marker_html
        else:
            # Locked viewer: send only the free preview (everything before
            # the break). No marker → body fully hidden (frontend shows the
            # excerpt + paywall card).
            full["body_md"] = raw_body.split(PAYWALL_MARKER, 1)[0].rstrip() if has_marker else ""
            full["body_html"] = PAYWALL_MARKER_HTML_RE.split(raw_html, 1)[0] if has_marker_html else ""
            full["has_preview_break"] = has_marker or has_marker_html
            full["locked"] = True
            full["viewer_tier"] = actual
        return full


# ─────────────────────────────────────────────────────────────────
# Portal (authenticated) endpoints
# ─────────────────────────────────────────────────────────────────
#
# Any authenticated Supabase user can write articles in Phase 1.
# A stricter author allowlist can layer on later via env var or a
# users-extension table; for now we lean on the existing portal gate.

@router.get("/portal/articles")
def list_my_articles(author: dict = Depends(_resolve_author)):
    """List THIS author's articles (any status). Newest first."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT id, slug, title, subtitle, body_md, body_html, hero_image_url,
                   author_id, author_name, status, requires_tier,
                   published_at, created_at, updated_at
            FROM articles
            WHERE author_id = %s
            ORDER BY COALESCE(published_at, updated_at) DESC, id DESC
            """,
            (author["user_id"],),
        )
        return {"articles": [_row_to_summary(dict(r)) for r in cur.fetchall()]}


@router.get("/portal/articles/{article_id}")
def get_my_article(article_id: int, author: dict = Depends(_resolve_author)):
    """Fetch an article by ID for editing. Must be authored by current user."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT id, slug, title, subtitle, body_md, body_html, hero_image_url,
                   author_id, author_name, status, requires_tier,
                   published_at, created_at, updated_at
            FROM articles WHERE id = %s
            """,
            (article_id,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Article not found")
        if str(row["author_id"]) != str(author["user_id"]):
            raise HTTPException(status_code=403, detail="Not your article")
        return _row_to_full(dict(row))


@router.post("/portal/articles")
def create_article(body: ArticleCreate, author: dict = Depends(_resolve_author)):
    """Create a new article as a draft. The author can publish it later."""
    base = _slugify(body.slug or body.title)
    with get_connection() as conn:
        cur = conn.cursor()
        slug = _unique_slug(cur, base)
        cur.execute(
            """
            INSERT INTO articles
              (slug, title, subtitle, body_md, body_html, hero_image_url,
               author_id, author_name, status, requires_tier)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'draft', %s)
            RETURNING id, slug, title, subtitle, body_md, body_html, hero_image_url,
                      author_id, author_name, status, requires_tier,
                      published_at, created_at, updated_at
            """,
            (slug, body.title.strip(), (body.subtitle or "").strip() or None,
             body.body_md or "", body.body_html or None, body.hero_image_url,
             author["user_id"], body.author_name.strip(), body.requires_tier or "free"),
        )
        row = dict(cur.fetchone())
        conn.commit()
        return _row_to_full(row)


@router.put("/portal/articles/{article_id}")
def update_article(
    article_id: int,
    body: ArticleUpdate,
    author: dict = Depends(_resolve_author),
):
    """Update title / subtitle / body / hero / slug. Author-only."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT author_id, slug FROM articles WHERE id = %s", (article_id,))
        existing = cur.fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Article not found")
        if str(existing["author_id"]) != str(author["user_id"]):
            raise HTTPException(status_code=403, detail="Not your article")

        # Build the SET clause from non-None fields. If the slug is being
        # updated, run it through uniqueness check (excluding this row).
        sets, params = [], []
        if body.title is not None:
            sets.append("title = %s"); params.append(body.title.strip())
        if body.subtitle is not None:
            sets.append("subtitle = %s"); params.append((body.subtitle or "").strip() or None)
        if body.body_md is not None:
            sets.append("body_md = %s"); params.append(body.body_md)
        if body.body_html is not None:
            sets.append("body_html = %s"); params.append(body.body_html or None)
        if body.hero_image_url is not None:
            sets.append("hero_image_url = %s"); params.append(body.hero_image_url or None)
        if body.author_name is not None:
            sets.append("author_name = %s"); params.append(body.author_name.strip())
        if body.slug is not None:
            new_slug = _unique_slug(cur, _slugify(body.slug), ignore_id=article_id)
            sets.append("slug = %s"); params.append(new_slug)
        if body.requires_tier is not None:
            sets.append("requires_tier = %s"); params.append(body.requires_tier)

        if not sets:
            # No-op; still return the current row.
            cur.execute(
                """SELECT id, slug, title, subtitle, body_md, body_html, hero_image_url,
                          author_id, author_name, status, requires_tier,
                          published_at, created_at, updated_at
                   FROM articles WHERE id = %s""",
                (article_id,),
            )
            return _row_to_full(dict(cur.fetchone()))

        sets.append("updated_at = NOW()")
        params.append(article_id)
        cur.execute(
            f"""UPDATE articles SET {', '.join(sets)} WHERE id = %s
                RETURNING id, slug, title, subtitle, body_md, body_html, hero_image_url,
                          author_id, author_name, status, requires_tier,
                          published_at, created_at, updated_at""",
            tuple(params),
        )
        row = dict(cur.fetchone())
        conn.commit()
        return _row_to_full(row)


@router.patch("/portal/articles/{article_id}/publish")
def toggle_publish(
    article_id: int,
    body: ArticlePublishToggle,
    author: dict = Depends(_resolve_author),
):
    """Flip an article between draft and published. Author-only.

    When transitioning draft->published the published_at stamp is set;
    going back to draft preserves the original stamp (so re-publishing
    later doesn't shuffle the public ordering needlessly)."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT author_id, status, published_at FROM articles WHERE id = %s",
            (article_id,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Article not found")
        if str(row["author_id"]) != str(author["user_id"]):
            raise HTTPException(status_code=403, detail="Not your article")

        if body.publish:
            new_status = "published"
            stamp = row["published_at"] or datetime.now(timezone.utc)
        else:
            new_status = "draft"
            stamp = row["published_at"]

        cur.execute(
            """UPDATE articles
               SET status = %s, published_at = %s, updated_at = NOW()
               WHERE id = %s
               RETURNING id, slug, title, subtitle, body_md, body_html, hero_image_url,
                         author_id, author_name, status, requires_tier,
                         published_at, created_at, updated_at""",
            (new_status, stamp, article_id),
        )
        out = dict(cur.fetchone())
        conn.commit()
        return _row_to_full(out)


_BUCKET = "article-images"
_ALLOWED_IMAGE_MIME = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
}
_MAX_IMAGE_BYTES = 8 * 1024 * 1024  # 8 MB — plenty for in-article photos.


@router.post("/portal/articles/upload-image")
async def upload_article_image(
    request: Request,
    file: UploadFile = File(...),
    author: dict = Depends(_resolve_author),
):
    """Upload an image to the article-images Supabase Storage bucket
    (public read) and return its public URL. The frontend inserts the
    URL into the markdown body as `![alt](url)`.

    Authorized authors only (same allowlist as the article-write endpoints)."""
    ctype = (file.content_type or "").lower()
    if ctype not in _ALLOWED_IMAGE_MIME:
        raise HTTPException(status_code=400, detail=f"Unsupported file type: {ctype}")

    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(contents) > _MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="File too large (8 MB max)")

    ext = _ALLOWED_IMAGE_MIME[ctype]
    # Path: <author_id>/<timestamp>-<random>.<ext> — namespaces per author
    # and avoids collisions even on rapid back-to-back uploads.
    key = f"{author['user_id']}/{int(time.time())}-{uuid.uuid4().hex[:8]}.{ext}"

    supabase_url = _get_supabase_url()
    service_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    if not service_key:
        raise HTTPException(status_code=500, detail="Server missing storage credentials")

    upload_url = f"{supabase_url}/storage/v1/object/{_BUCKET}/{key}"
    try:
        resp = httpx.post(
            upload_url,
            content=contents,
            headers={
                "Authorization": f"Bearer {service_key}",
                "apikey": service_key,
                "Content-Type": ctype,
                "x-upsert": "false",
            },
            timeout=30.0,
        )
    except httpx.RequestError as e:
        raise HTTPException(status_code=502, detail=f"Storage upload failed: {e}")

    if resp.status_code >= 300:
        raise HTTPException(
            status_code=502,
            detail=f"Storage upload failed ({resp.status_code}): {resp.text[:200]}",
        )

    public_url = f"{supabase_url}/storage/v1/object/public/{_BUCKET}/{key}"
    return {"url": public_url, "path": key, "filename": file.filename}


@router.delete("/portal/articles/{article_id}")
def archive_article(article_id: int, author: dict = Depends(_resolve_author)):
    """Soft-delete: mark archived so it stops appearing anywhere public.

    Phase 1 keeps the row around (so undelete is just a status flip) — a
    later hard-delete admin endpoint can purge truly unwanted rows."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT author_id FROM articles WHERE id = %s", (article_id,))
        existing = cur.fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Article not found")
        if str(existing["author_id"]) != str(author["user_id"]):
            raise HTTPException(status_code=403, detail="Not your article")
        cur.execute(
            "UPDATE articles SET status = 'archived', updated_at = NOW() WHERE id = %s",
            (article_id,),
        )
        conn.commit()
        return {"ok": True}
