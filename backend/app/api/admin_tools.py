"""
Admin tools — dev-only write endpoints for small site edits.

Currently: the Commitment Editor. Lets DEVELOPER_EMAILS (Nate + interns /
friends) search any player and set or clear their commitment status. Writes
go straight to the players table (is_committed / committed_to / commitment_date),
which is the single source every commitment surface reads from:
  • NWAC commitments tracker
  • JUCO uncommitted tracker (committed players drop off it)
  • Transfer Portal tracker (reads committed_to from the DB)
  • the "Committed to X" badge on player profiles

Every edit is recorded in commitment_audit (who / what / old / new / when).

Gated by require_developer (strict — always enforced, not subject to the
soft-mode tier gating that require_tier honors pre-launch).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from .auth import require_developer
from ..models.database import get_connection

router = APIRouter()


def _ensure_audit_table(cur):
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS commitment_audit (
            id SERIAL PRIMARY KEY,
            player_id INTEGER NOT NULL,
            editor_email TEXT NOT NULL,
            action TEXT NOT NULL,            -- 'set' | 'clear'
            old_committed_to TEXT,
            new_committed_to TEXT,
            created_at TIMESTAMP NOT NULL DEFAULT now()
        )
        """
    )


class SetCommitment(BaseModel):
    player_id: int
    committed_to: str = Field(..., min_length=1, max_length=120)


class ClearCommitment(BaseModel):
    player_id: int


@router.get("/admin/commitment/search")
def commitment_search(q: str = Query(..., min_length=2), _email: str = Depends(require_developer)):
    """Search players by name for the commitment editor. Returns each
    player's level + current commitment so the editor shows who is being
    edited and their existing status."""
    search = f"%{q.strip()}%"
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT p.id, p.first_name, p.last_name, p.position, p.year_in_school,
                   p.bats, p.throws, p.is_committed, p.committed_to,
                   t.short_name AS team_short, t.name AS team_name, t.logo_url,
                   d.level AS division_level
            FROM players p
            JOIN teams t ON p.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            LEFT JOIN player_links pl ON p.id = pl.linked_id
            WHERE pl.linked_id IS NULL
              AND COALESCE(p.is_phantom, FALSE) = FALSE
              AND p.id IN (
                  -- OFFSET 0 optimizer fence → use the name trigram indexes
                  SELECT id FROM players
                  WHERE first_name ILIKE %s OR last_name ILIKE %s
                     OR (first_name || ' ' || last_name) ILIKE %s
                  OFFSET 0
              )
            ORDER BY p.last_name, p.first_name
            LIMIT 25
            """,
            (search, search, search),
        )
        rows = [dict(r) for r in cur.fetchall()]
    for r in rows:
        r["name"] = f"{r.get('first_name', '') or ''} {r.get('last_name', '') or ''}".strip()
        r["is_committed"] = bool(r.get("is_committed"))
    return rows


@router.post("/admin/commitment/set")
def commitment_set(body: SetCommitment, email: str = Depends(require_developer)):
    """Mark a player committed to a school. Updates the players table and
    logs the edit. Visible immediately everywhere commitments are shown."""
    school = body.committed_to.strip()
    if not school:
        raise HTTPException(status_code=400, detail="committed_to is required")
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_audit_table(cur)
        cur.execute("SELECT committed_to FROM players WHERE id = %s", (body.player_id,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Player not found")
        old = row.get("committed_to")
        cur.execute(
            """
            UPDATE players
               SET is_committed = 1, committed_to = %s,
                   commitment_date = COALESCE(commitment_date, now())
             WHERE id = %s
            """,
            (school, body.player_id),
        )
        cur.execute(
            """
            INSERT INTO commitment_audit
              (player_id, editor_email, action, old_committed_to, new_committed_to)
            VALUES (%s, %s, 'set', %s, %s)
            """,
            (body.player_id, email, old, school),
        )
        conn.commit()
    return {"ok": True, "player_id": body.player_id, "committed_to": school, "is_committed": True}


@router.post("/admin/commitment/clear")
def commitment_clear(body: ClearCommitment, email: str = Depends(require_developer)):
    """Undo a commitment — set the player back to uncommitted."""
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_audit_table(cur)
        cur.execute("SELECT committed_to FROM players WHERE id = %s", (body.player_id,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Player not found")
        old = row.get("committed_to")
        cur.execute(
            """
            UPDATE players
               SET is_committed = 0, committed_to = NULL, commitment_date = NULL
             WHERE id = %s
            """,
            (body.player_id,),
        )
        cur.execute(
            """
            INSERT INTO commitment_audit
              (player_id, editor_email, action, old_committed_to, new_committed_to)
            VALUES (%s, %s, 'clear', %s, NULL)
            """,
            (body.player_id, email, old),
        )
        conn.commit()
    return {"ok": True, "player_id": body.player_id, "committed_to": None, "is_committed": False}


@router.get("/admin/commitment/recent")
def commitment_recent(limit: int = Query(15, le=50), _email: str = Depends(require_developer)):
    """Recent commitment edits, newest first — shown in the editor so the
    team can see who changed what."""
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_audit_table(cur)
        cur.execute(
            """
            SELECT ca.id, ca.player_id, ca.editor_email, ca.action,
                   ca.old_committed_to, ca.new_committed_to, ca.created_at,
                   p.first_name, p.last_name, t.short_name AS team_short
            FROM commitment_audit ca
            LEFT JOIN players p ON p.id = ca.player_id
            LEFT JOIN teams t ON p.team_id = t.id
            ORDER BY ca.created_at DESC
            LIMIT %s
            """,
            (limit,),
        )
        rows = [dict(r) for r in cur.fetchall()]
    for r in rows:
        r["name"] = f"{r.get('first_name') or ''} {r.get('last_name') or ''}".strip()
    return rows
