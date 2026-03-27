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
