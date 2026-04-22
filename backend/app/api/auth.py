"""
Authentication helpers using Supabase.

Supabase handles signup/login/password-reset on the frontend.
The backend verifies the user's access token by calling Supabase's
auth API, which avoids needing the JWT signing secret locally.
"""

import os
from typing import Optional

import httpx
from fastapi import HTTPException, Request


def _get_supabase_url() -> str:
    url = os.getenv("SUPABASE_URL", "")
    if not url:
        raise HTTPException(
            status_code=500,
            detail="SUPABASE_URL not configured on the server.",
        )
    return url.rstrip("/")


def _extract_token(request: Request) -> Optional[str]:
    """Pull the Bearer token from the Authorization header."""
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:]
    return None


def _verify_token(token: str) -> Optional[str]:
    """
    Verify a Supabase access token by calling the auth API.
    Returns the user_id (UUID) if valid, None otherwise.
    """
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
        if resp.status_code == 200:
            data = resp.json()
            return data.get("id")
        return None
    except httpx.RequestError:
        return None


def get_current_user(request: Request) -> str:
    """
    Dependency that verifies the Supabase token and returns the user_id.
    Raises 401 if the token is missing or invalid.
    """
    token = _extract_token(request)
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")

    user_id = _verify_token(token)
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    return user_id


def get_optional_user(request: Request) -> Optional[str]:
    """
    Same as get_current_user, but returns None instead of raising
    if there is no token. Useful for endpoints that work for both
    logged-in and anonymous users.
    """
    token = _extract_token(request)
    if not token:
        return None

    return _verify_token(token)


def _load_admin_emails() -> set:
    """
    Read the ADMIN_EMAILS env var (comma-separated) and return the
    lowercased set. Empty set means admin endpoints are locked down
    to no one, which is the correct fail-closed default if the env
    var is missing.
    """
    raw = os.getenv("ADMIN_EMAILS", "")
    return {e.strip().lower() for e in raw.split(",") if e.strip()}


def require_admin(request: Request) -> str:
    """
    Dependency that verifies the Supabase token AND confirms the
    user's email is in the ADMIN_EMAILS allowlist. Returns the user_id.

    Raises:
        401 if the token is missing, invalid, or expired.
        403 if the token is valid but the user is not in ADMIN_EMAILS.
        500 if ADMIN_EMAILS is unconfigured on the server.

    Why separate from get_current_user: the ADMIN_EMAILS check needs
    the user's email, not just their id, so we make a fresh Supabase
    call here to pull the full user object.
    """
    token = _extract_token(request)
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")

    admin_emails = _load_admin_emails()
    if not admin_emails:
        raise HTTPException(
            status_code=500,
            detail="ADMIN_EMAILS not configured on the server.",
        )

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
        raise HTTPException(status_code=401, detail="Could not verify token")

    if resp.status_code != 200:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    data = resp.json()
    user_email = (data.get("email") or "").lower()
    user_id = data.get("id")
    if user_email not in admin_emails:
        raise HTTPException(status_code=403, detail="Admin access required")

    return user_id
