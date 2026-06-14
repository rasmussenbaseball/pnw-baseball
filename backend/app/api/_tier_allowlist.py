"""
Tier allowlists — emails that are granted access tiers OUTSIDE the
normal Stripe-billed subscription system. Two non-paying categories:

  DEVELOPER_EMAILS   → tier='dev'   (site builders + interns).
                       Bypasses every gate. Hidden from /pricing
                       and the signup popup.

  COMPED_COACH_EMAILS → tier='coach' (free Coach & Scout forever).
                       Friends-of-the-site grant: complimentary
                       lifetime access, no payment, no expiration.

Both lists are case-insensitive (we lowercase on compare). They live
here as Python constants so updates don't require a DB migration.
Mirror DEVELOPER_EMAILS in frontend/src/lib/tiers.js if you change
that list.
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
}

COMPED_COACH_EMAILS = {
    "ethan.stacy@gmail.com",
    "jhussey1703@gmail.com",
    "dylanthomasha@gmail.com",
    "miyazawajoshua@gmail.com",
    "maxo2326@gmail.com",
    "jawomack@bushnell.edu",
    "pnwcbr@gmail.com",
    "tommy.richards@wsu.edu",
    "deven@drivelinebaseball.com",
    # June 12, 2026 batch (per Nate)
    "eryxawaya@gmail.com",
    "tdubgreen1024@gmail.com",
    "broderickbuhr1@gmail.com",
    "manaheff@gmail.com",
    "cameronkundig@gmail.com",
    "aswolfe44@gmail.com",
    "jtcourt2@centurylink.net",
    "tyler.baseball2026@gmail.com",
    # June 14, 2026 (per Nate)
    "blake.stavros24@gmail.com",
    "marshallchaser@gmail.com",
}


def resolve_comped_tier(email: Optional[str]) -> Optional[str]:
    """Map an email to a granted tier ('dev' or 'coach'), or None if
    the email is not on either allowlist. Case-insensitive."""
    if not email:
        return None
    e = email.lower()
    if e in DEVELOPER_EMAILS:
        return "dev"
    if e in COMPED_COACH_EMAILS:
        return "coach"
    return None


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
