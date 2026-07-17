"""
Bushnell Kangaroo Court — hidden, password-gated team fine tracker.

Not linked anywhere on the site. The frontend page lives at /kcourt.
Two shared passwords gate everything:
  - PLAYER_PASSWORD: players can log in and submit fines (with proof
    images/videos), but never see anyone else's submissions.
  - ADMIN_PASSWORD: the court keeper can list every submission, delete
    submissions, and add their own.

Proof media goes to the public 'kcourt-media' Supabase Storage bucket
(same upload pattern as article images). The bucket URL is unguessable
per-file (uuid keys) but public-read, which is fine for team blooper
content — the fines themselves are only readable via the admin password.
"""

import json
import os
import time
import uuid

import httpx
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from psycopg2.extras import Json
from pydantic import BaseModel

from ..models.database import get_connection

router = APIRouter()

PLAYER_PASSWORD = "iggy"
ADMIN_PASSWORD = "wolfe"

_BUCKET = "kcourt-media"
_MAX_MEDIA_BYTES = 50 * 1024 * 1024  # matches the bucket's 50 MB cap
_MAX_FILES_PER_FINE = 4
_ALLOWED_MEDIA_MIME = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/heic": "heic",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
}


def _role_for(password: str) -> str:
    if password == ADMIN_PASSWORD:
        return "admin"
    if password == PLAYER_PASSWORD:
        return "player"
    raise HTTPException(status_code=403, detail="Wrong password")


def _require_admin(password: str):
    if password != ADMIN_PASSWORD:
        raise HTTPException(status_code=403, detail="Admin access required")


def _get_supabase_url() -> str:
    url = os.getenv("SUPABASE_URL", "").rstrip("/")
    if not url:
        raise HTTPException(status_code=500, detail="Server missing storage config")
    return url


class LoginBody(BaseModel):
    name: str
    password: str


@router.post("/kcourt/login")
def kcourt_login(body: LoginBody):
    """Validate the shared password and return the caller's role."""
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    return {"role": _role_for(body.password), "name": name}


@router.post("/kcourt/fines")
async def submit_fine(
    password: str = Form(...),
    submitted_by: str = Form(...),
    fined_players: str = Form(...),  # JSON array of names
    amount: float = Form(...),
    explanation: str = Form(...),
    files: list[UploadFile] = File(default=[]),
):
    _role_for(password)  # any valid password may submit

    submitted_by = submitted_by.strip()
    if not submitted_by:
        raise HTTPException(status_code=400, detail="Your name is required")

    try:
        players = [p.strip() for p in json.loads(fined_players) if p and p.strip()]
    except (json.JSONDecodeError, TypeError):
        raise HTTPException(status_code=400, detail="Bad fined_players payload")
    if not players:
        raise HTTPException(status_code=400, detail="Fine at least one player")

    if not (0 < amount <= 100):
        raise HTTPException(status_code=400, detail="Amount must be between $0 and $100")

    explanation = explanation.strip()
    if not explanation:
        raise HTTPException(status_code=400, detail="An explanation is required")

    if len(files) > _MAX_FILES_PER_FINE:
        raise HTTPException(
            status_code=400, detail=f"Max {_MAX_FILES_PER_FINE} proof files per fine"
        )

    media = []
    for f in files:
        ctype = (f.content_type or "").lower()
        if ctype not in _ALLOWED_MEDIA_MIME:
            raise HTTPException(status_code=400, detail=f"Unsupported file type: {ctype}")
        contents = await f.read()
        if not contents:
            continue
        if len(contents) > _MAX_MEDIA_BYTES:
            raise HTTPException(status_code=413, detail="File too large (50 MB max)")

        ext = _ALLOWED_MEDIA_MIME[ctype]
        key = f"{int(time.time())}-{uuid.uuid4().hex[:10]}.{ext}"
        supabase_url = _get_supabase_url()
        service_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
        if not service_key:
            raise HTTPException(status_code=500, detail="Server missing storage credentials")
        try:
            resp = httpx.post(
                f"{supabase_url}/storage/v1/object/{_BUCKET}/{key}",
                content=contents,
                headers={
                    "Authorization": f"Bearer {service_key}",
                    "apikey": service_key,
                    "Content-Type": ctype,
                    "x-upsert": "false",
                },
                timeout=120.0,
            )
        except httpx.RequestError as e:
            raise HTTPException(status_code=502, detail=f"Storage upload failed: {e}")
        if resp.status_code >= 300:
            raise HTTPException(
                status_code=502,
                detail=f"Storage upload failed ({resp.status_code}): {resp.text[:200]}",
            )
        media.append(
            {
                "url": f"{supabase_url}/storage/v1/object/public/{_BUCKET}/{key}",
                "path": key,
                "type": "video" if ctype.startswith("video/") else "image",
                "filename": f.filename,
            }
        )

    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """INSERT INTO kangaroo_court_fines
                   (submitted_by, fined_players, amount, explanation, media)
               VALUES (%s, %s, %s, %s, %s)
               RETURNING id, created_at""",
            (submitted_by, players, amount, explanation, Json(media)),
        )
        row = cur.fetchone()
        conn.commit()

    return {"ok": True, "id": row["id"], "created_at": row["created_at"].isoformat()}


@router.get("/kcourt/fines")
def list_fines(password: str):
    """Court keeper only — every submission, newest first."""
    _require_admin(password)
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """SELECT id, submitted_by, fined_players, amount, explanation,
                      media, created_at
               FROM kangaroo_court_fines
               ORDER BY created_at DESC"""
        )
        rows = [dict(r) for r in cur.fetchall()]
    for r in rows:
        r["amount"] = float(r["amount"])
        r["created_at"] = r["created_at"].isoformat()
    return {"fines": rows, "total": round(sum(r["amount"] for r in rows), 2)}


@router.delete("/kcourt/fines/{fine_id}")
def delete_fine(fine_id: int, password: str):
    """Court keeper only — removes the row and its proof files."""
    _require_admin(password)
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            "DELETE FROM kangaroo_court_fines WHERE id = %s RETURNING media",
            (fine_id,),
        )
        row = cur.fetchone()
        conn.commit()
    if not row:
        raise HTTPException(status_code=404, detail="Fine not found")

    # Best-effort cleanup of the storage objects; the row is already gone.
    paths = [m.get("path") for m in (row["media"] or []) if m.get("path")]
    if paths:
        supabase_url = _get_supabase_url()
        service_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
        if service_key:
            try:
                httpx.request(
                    "DELETE",
                    f"{supabase_url}/storage/v1/object/{_BUCKET}",
                    json={"prefixes": paths},
                    headers={
                        "Authorization": f"Bearer {service_key}",
                        "apikey": service_key,
                    },
                    timeout=30.0,
                )
            except httpx.RequestError:
                pass

    return {"ok": True, "deleted": fine_id}
