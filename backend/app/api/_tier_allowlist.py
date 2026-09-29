"""
Developer allowlist plus token-to-email resolution.

DEVELOPER_EMAILS is the ONLY access grant left on the site (September
2026): everything built on public data is open to everyone, and the dev
list unlocks internal tools (commitment editor, in-progress pages, raw
TrackMan tables). Nate adds and removes emails here; mirror the list in
frontend/src/lib/tiers.js.

Case-insensitive (we lowercase on compare).
"""

from __future__ import annotations

import os
import time
from typing import Optional

import httpx


DEVELOPER_EMAILS = {
    "nate.rasmussen26@gmail.com",
    "zackaryahn2026@gmail.com",
    "naterpetz@gmail.com",
    "kai.malloch@gmail.com",
    "oliver.duthie1010@gmail.com",
    "connorbroschard@gmail.com",
    "trevorkazahaya@gmail.com",
    "zews2005@outlook.com",
    "pnwcbr@gmail.com",
    "jawomack@bushnell.edu",
    "cameronkundig@gmail.com",
    "tommy.richards@wsu.edu",
    "smith55@uw.edu",   # June 23, 2026 — lifetime dev account for TrackMan access (per Nate)
    "willytcell@gmail.com",   # June 27, 2026 — free forever dev tier (per Nate)
    "olearyjoe101@gmail.com",   # July 8, 2026 — full dev access forever (per Nate)
}

# Commitment Editor — narrower than the dev tier. Only these accounts may
# read/write the commitment / portal / freshman / link tools, even though the
# broader DEVELOPER_EMAILS set unlocks every other internal tool.
COMMITMENT_EDITOR_EMAILS = {
    "nate.rasmussen26@gmail.com",
    "pnwcbr@gmail.com",
}

def is_developer_email(email: Optional[str]) -> bool:
    """True when the email is on the developer allowlist."""
    return bool(email) and email.lower() in DEVELOPER_EMAILS


# ──────────────────────────────────────────────────────────────
# Token → email resolution (with small in-memory cache).
# Calling Supabase on every request just to read the email out of
# the JWT is wasteful — we cache by token hash for 10 minutes.
# ──────────────────────────────────────────────────────────────

# token_hash → (email, expires_at)
_EMAIL_CACHE: dict[str, tuple[str, float]] = {}
_EMAIL_CACHE_TTL = 600  # 10 min


def _hash_token(token: str) -> str:
    # Don't store the raw token in memory longer than the call; use
    # a short truncated hash as the cache key. Cheap and avoids
    # accidental token-in-memory exposure if a debug print fires.
    import hashlib
    return hashlib.sha256(token.encode("utf-8")).hexdigest()[:32]


def _supabase_url() -> str:
    return (os.getenv("SUPABASE_URL") or "").rstrip("/")


def email_for_token(token: str) -> Optional[str]:
    """Resolve a Supabase access token to the user's email.

    Returns None on any auth/network error. Cached for 10 minutes
    keyed by token hash so consecutive requests don't hammer the
    Supabase auth API.
    """
    if not token:
        return None

    key = _hash_token(token)
    hit = _EMAIL_CACHE.get(key)
    now = time.time()
    if hit and hit[1] > now:
        return hit[0]

    supabase_url = _supabase_url()
    if not supabase_url:
        return None

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
        return None

    if resp.status_code != 200:
        return None

    email = (resp.json().get("email") or "").lower() or None
    if email:
        _EMAIL_CACHE[key] = (email, now + _EMAIL_CACHE_TTL)
        # Bounded cache growth — drop the oldest 25% when over 1024 entries.
        if len(_EMAIL_CACHE) > 1024:
            victims = sorted(_EMAIL_CACHE.keys(), key=lambda k: _EMAIL_CACHE[k][1])[:256]
            for k in victims:
                _EMAIL_CACHE.pop(k, None)
    return email
