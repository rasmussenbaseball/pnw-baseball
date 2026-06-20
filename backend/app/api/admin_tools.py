"""
Admin tools — dev-only write endpoints for small site edits.

Used by DEVELOPER_EMAILS (Nate + interns / friends) via the Commitment Editor
page (/commitment-editor). Three capabilities, all gated by require_developer
(strict — always enforced, not subject to soft-mode tier gating):

  1. Commitments — set / clear a player's commitment. Writes the players table
     (is_committed / committed_to / commitment_date), the single source read by
     the NWAC commitments tracker, the JUCO / transfer trackers, and the
     "Committed to X" profile badge. When the destination is a PNW school the
     text is normalized to that team's canonical short_name so the player lands
     on the school's 2027 projected roster every time (the projections writer
     exact-matches committed_to against team names).

  2. Transfer portal membership — add / remove a player from the Transfer Portal
     Tracker. Lives in the transfer_portal_members table (migrated off the old
     git-tracked JSON) so edits are live, no deploy.

  3. Player-page linking — link two player records (spring+spring via
     player_links, summer+spring via summer_player_links) so their pages /
     careers merge. Supports unlink.

Every edit is logged (commitment_audit for commitment + portal, link_audit for
links).
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from .auth import require_developer
from ..models.database import get_connection

router = APIRouter()

# PNW states whose schools we roster + project. A commitment to one of these is
# normalized to the team's canonical short_name.
_PNW_STATES = ["WA", "OR", "ID", "MT", "BC"]


# ─────────────────────────────────────────────────────────────────
# Tables (created lazily — no migration step needed)
# ─────────────────────────────────────────────────────────────────
def _ensure_tables(cur):
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS commitment_audit (
            id SERIAL PRIMARY KEY,
            player_id INTEGER NOT NULL,
            editor_email TEXT NOT NULL,
            action TEXT NOT NULL,            -- set | clear | portal_add | portal_remove
            old_committed_to TEXT,
            new_committed_to TEXT,
            created_at TIMESTAMP NOT NULL DEFAULT now()
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS transfer_portal_members (
            player_id INTEGER PRIMARY KEY,
            from_school TEXT,
            position TEXT,
            added_by TEXT,
            added_at TIMESTAMP NOT NULL DEFAULT now()
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS incoming_transfers (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            from_school TEXT,
            to_team_id INTEGER NOT NULL,
            position TEXT,
            added_by TEXT,
            added_at TIMESTAMP NOT NULL DEFAULT now()
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS link_audit (
            id SERIAL PRIMARY KEY,
            editor_email TEXT NOT NULL,
            action TEXT NOT NULL,            -- link | unlink
            table_name TEXT NOT NULL,        -- player_links | summer_player_links
            a_kind TEXT, a_id INTEGER,
            b_kind TEXT, b_id INTEGER,
            created_at TIMESTAMP NOT NULL DEFAULT now()
        )
        """
    )
    # WCL summer players: a curated spring school (works for non-PNW players the
    # auto-linker can't resolve) + membership in the WCL transfer-portal tracker.
    cur.execute("ALTER TABLE summer_players ADD COLUMN IF NOT EXISTS assigned_school TEXT")
    cur.execute("ALTER TABLE summer_players ADD COLUMN IF NOT EXISTS assigned_school_team_id INTEGER")
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS wcl_portal_members (
            summer_player_id INTEGER PRIMARY KEY,
            from_school TEXT,
            position TEXT,
            added_by TEXT,
            added_at TIMESTAMP NOT NULL DEFAULT now()
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS wcl_audit (
            id SERIAL PRIMARY KEY,
            summer_player_id INTEGER NOT NULL,
            editor_email TEXT NOT NULL,
            action TEXT NOT NULL,            -- school_set | school_clear | portal_add | portal_remove
            detail TEXT,
            created_at TIMESTAMP NOT NULL DEFAULT now()
        )
        """
    )


# ─────────────────────────────────────────────────────────────────
# PNW team matching
# ─────────────────────────────────────────────────────────────────
def _pnw_teams(cur):
    cur.execute(
        """
        SELECT t.id, t.short_name, t.name, t.school_name, d.level
        FROM teams t
        JOIN conferences c ON t.conference_id = c.id
        JOIN divisions d ON c.division_id = d.id
        WHERE COALESCE(t.is_active, 1) = 1 AND t.state = ANY(%s)
        ORDER BY t.short_name
        """,
        (_PNW_STATES,),
    )
    return [dict(r) for r in cur.fetchall()]


def _resolve_pnw_exact(cur, text):
    """Exact (case-insensitive) match of free text to a PNW team on
    short_name / name / school_name. Exact only — no fuzzy — so we never
    silently mis-normalize an ambiguous string like 'Washington'. Returns the
    team dict or None."""
    if not text:
        return None
    key = text.strip().lower()
    for t in _pnw_teams(cur):
        for nm in (t["short_name"], t["name"], t["school_name"]):
            if nm and nm.strip().lower() == key:
                return t
    return None


@router.get("/admin/teams/pnw")
def pnw_team_search(q: str = Query("", description="filter by name"), _email: str = Depends(require_developer)):
    """PNW teams for the commitment autocomplete. Returns every PNW team
    (optionally filtered) so the editor can pick the exact destination."""
    ql = q.strip().lower()
    with get_connection() as conn:
        cur = conn.cursor()
        teams = _pnw_teams(cur)
    if ql:
        teams = [t for t in teams if ql in (t["short_name"] or "").lower()
                 or ql in (t["name"] or "").lower()
                 or ql in (t["school_name"] or "").lower()]
    return [{"id": t["id"], "short_name": t["short_name"],
             "school_name": t["school_name"], "level": t["level"]} for t in teams]


# ─────────────────────────────────────────────────────────────────
# Player search (commitment + portal panel)
# ─────────────────────────────────────────────────────────────────
@router.get("/admin/commitment/search")
def commitment_search(q: str = Query(..., min_length=2), _email: str = Depends(require_developer)):
    """Search players by name. Returns level, current commitment, and whether
    the player is in the transfer portal, so the editor shows full status."""
    search = f"%{q.strip()}%"
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_tables(cur)
        cur.execute(
            """
            SELECT p.id, p.first_name, p.last_name, p.position, p.year_in_school,
                   p.bats, p.throws, p.is_committed, p.committed_to,
                   t.short_name AS team_short, t.name AS team_name, t.logo_url,
                   d.level AS division_level,
                   (tpm.player_id IS NOT NULL) AS in_portal
            FROM players p
            JOIN teams t ON p.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            LEFT JOIN player_links pl ON p.id = pl.linked_id
            LEFT JOIN transfer_portal_members tpm ON tpm.player_id = p.id
            WHERE pl.linked_id IS NULL
              AND COALESCE(p.is_phantom, FALSE) = FALSE
              AND p.id IN (
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
        r["in_portal"] = bool(r.get("in_portal"))
    return rows


# ─────────────────────────────────────────────────────────────────
# Commitments
# ─────────────────────────────────────────────────────────────────
class SetCommitment(BaseModel):
    player_id: int
    committed_to: str = Field(..., min_length=1, max_length=120)
    # When the editor picks a PNW school from the autocomplete it sends the
    # team id — we then store that team's canonical short_name (guaranteed
    # 2027-roster match) regardless of what was typed.
    committed_team_id: Optional[int] = None


class PlayerIdBody(BaseModel):
    player_id: int


def _audit_commit(cur, player_id, email, action, old, new):
    cur.execute(
        """INSERT INTO commitment_audit
             (player_id, editor_email, action, old_committed_to, new_committed_to)
           VALUES (%s, %s, %s, %s, %s)""",
        (player_id, email, action, old, new),
    )


@router.post("/admin/commitment/set")
def commitment_set(body: SetCommitment, email: str = Depends(require_developer)):
    """Set a player's commitment. PNW destinations are normalized to the
    team's canonical short_name so the player lands on the right 2027 roster."""
    school = body.committed_to.strip()
    if not school:
        raise HTTPException(status_code=400, detail="committed_to is required")
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_tables(cur)
        cur.execute("SELECT committed_to FROM players WHERE id = %s", (body.player_id,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Player not found")
        old = row.get("committed_to")

        matched = None
        if body.committed_team_id is not None:
            cur.execute(
                "SELECT id, short_name FROM teams WHERE id = %s AND state = ANY(%s)",
                (body.committed_team_id, _PNW_STATES),
            )
            t = cur.fetchone()
            if t:
                matched = dict(t)
                school = t["short_name"]
        if matched is None:
            # No explicit team id — try an EXACT PNW name match (safe, unambiguous).
            t = _resolve_pnw_exact(cur, school)
            if t:
                matched = t
                school = t["short_name"]

        cur.execute(
            """UPDATE players SET is_committed = 1, committed_to = %s,
                      commitment_date = COALESCE(commitment_date, now())
               WHERE id = %s""",
            (school, body.player_id),
        )
        _audit_commit(cur, body.player_id, email, "set", old, school)
        conn.commit()
    return {"ok": True, "player_id": body.player_id, "committed_to": school,
            "is_committed": True, "matched_pnw": bool(matched),
            "matched_team": (matched or {}).get("short_name")}


@router.post("/admin/commitment/clear")
def commitment_clear(body: PlayerIdBody, email: str = Depends(require_developer)):
    """Undo a commitment — set the player back to uncommitted."""
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_tables(cur)
        cur.execute("SELECT committed_to FROM players WHERE id = %s", (body.player_id,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Player not found")
        old = row.get("committed_to")
        cur.execute(
            "UPDATE players SET is_committed = 0, committed_to = NULL, commitment_date = NULL WHERE id = %s",
            (body.player_id,),
        )
        _audit_commit(cur, body.player_id, email, "clear", old, None)
        conn.commit()
    return {"ok": True, "player_id": body.player_id, "committed_to": None, "is_committed": False}


# ─────────────────────────────────────────────────────────────────
# Transfer portal membership
# ─────────────────────────────────────────────────────────────────
@router.post("/admin/portal/add")
def portal_add(body: PlayerIdBody, email: str = Depends(require_developer)):
    """Add a player to the Transfer Portal Tracker. from_school is derived from
    their current team."""
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_tables(cur)
        cur.execute(
            "SELECT t.short_name FROM players p JOIN teams t ON p.team_id = t.id WHERE p.id = %s",
            (body.player_id,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Player not found")
        from_school = row.get("short_name")
        cur.execute(
            """INSERT INTO transfer_portal_members (player_id, from_school, added_by)
               VALUES (%s, %s, %s)
               ON CONFLICT (player_id) DO NOTHING""",
            (body.player_id, from_school, email),
        )
        _audit_commit(cur, body.player_id, email, "portal_add", None, from_school)
        conn.commit()
    return {"ok": True, "player_id": body.player_id, "in_portal": True}


@router.post("/admin/portal/remove")
def portal_remove(body: PlayerIdBody, email: str = Depends(require_developer)):
    """Remove a player from the Transfer Portal Tracker."""
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_tables(cur)
        cur.execute("DELETE FROM transfer_portal_members WHERE player_id = %s", (body.player_id,))
        _audit_commit(cur, body.player_id, email, "portal_remove", None, None)
        conn.commit()
    return {"ok": True, "player_id": body.player_id, "in_portal": False}


# ─────────────────────────────────────────────────────────────────
# WCL summer players — school assignment + WCL transfer-portal tracker
# ─────────────────────────────────────────────────────────────────
class SummerSchool(BaseModel):
    summer_player_id: int
    school: str = Field(..., min_length=1, max_length=120)
    # When the editor picks a PNW school from the autocomplete it sends the team
    # id — we store the canonical short_name + team id (for logo/level chip).
    school_team_id: Optional[int] = None


class SummerIdBody(BaseModel):
    summer_player_id: int


def _audit_wcl(cur, spid, email, action, detail):
    cur.execute(
        "INSERT INTO wcl_audit (summer_player_id, editor_email, action, detail) VALUES (%s, %s, %s, %s)",
        (spid, email, action, detail),
    )


@router.get("/admin/summer/search")
def summer_search(q: str = Query(..., min_length=2), _email: str = Depends(require_developer)):
    """Search WCL/summer players for school assignment + WCL-portal toggling.
    Unlike the spring search this hits summer_players, so EVERY WCL player is
    reachable (including non-PNW spring players the auto-linker can't resolve)."""
    search = f"%{q.strip()}%"
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_tables(cur)
        cur.execute(
            """
            SELECT sp.id, sp.first_name, sp.last_name, sp.position, sp.year_in_school,
                   sp.bats, sp.throws, sp.college,
                   sp.assigned_school, sp.assigned_school_team_id,
                   st.short_name AS team_short, st.name AS team_name, st.logo_url,
                   l.abbreviation AS league,
                   lt.short_name AS linked_school, lt.id AS linked_school_team_id,
                   ld.level AS linked_level,
                   (wpm.summer_player_id IS NOT NULL) AS in_wcl_portal
            FROM summer_players sp
            JOIN summer_teams st ON sp.team_id = st.id
            JOIN summer_leagues l ON l.id = st.league_id
            LEFT JOIN wcl_portal_members wpm ON wpm.summer_player_id = sp.id
            -- existing spring link (auto-matched PNW school) so already-linked
            -- players show their school instead of reading "No school".
            LEFT JOIN summer_player_links spl ON spl.summer_player_id = sp.id
            LEFT JOIN players spr ON spr.id = spl.spring_player_id
            LEFT JOIN teams lt ON lt.id = spr.team_id
            LEFT JOIN conferences lc ON lc.id = lt.conference_id
            LEFT JOIN divisions ld ON ld.id = lc.division_id
            WHERE sp.first_name NOT IN ('Total:', 'Total')
              AND sp.id IN (
                SELECT id FROM summer_players
                WHERE first_name ILIKE %s OR last_name ILIKE %s
                   OR (first_name || ' ' || last_name) ILIKE %s
                OFFSET 0
            )
            ORDER BY sp.last_name, sp.first_name
            LIMIT 25
            """,
            (search, search, search),
        )
        rows = [dict(r) for r in cur.fetchall()]
    for r in rows:
        r["name"] = f"{r.get('first_name', '') or ''} {r.get('last_name', '') or ''}".strip()
        r["in_wcl_portal"] = bool(r.get("in_wcl_portal"))
        if r.get("linked_level") == "JUCO":
            r["linked_level"] = "NWAC"
        # Effective school shown in the editor: a manual assignment wins, else
        # the auto-linked PNW school (so linked players don't read "No school").
        r["school"] = r.get("assigned_school") or r.get("linked_school") or None
    return rows


@router.post("/admin/summer/school/set")
def summer_school_set(body: SummerSchool, email: str = Depends(require_developer)):
    """Assign a spring school to a WCL player. PNW destinations normalize to the
    team's canonical short_name (and store the team id for logo + level chip)."""
    school = body.school.strip()
    if not school:
        raise HTTPException(status_code=400, detail="school is required")
    team_id = None
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_tables(cur)
        cur.execute("SELECT id FROM summer_players WHERE id = %s", (body.summer_player_id,))
        if not cur.fetchone():
            raise HTTPException(status_code=404, detail="Summer player not found")
        if body.school_team_id is not None:
            cur.execute(
                "SELECT id, short_name FROM teams WHERE id = %s AND state = ANY(%s)",
                (body.school_team_id, _PNW_STATES),
            )
            t = cur.fetchone()
            if t:
                school = t["short_name"]; team_id = t["id"]
        if team_id is None:
            t = _resolve_pnw_exact(cur, school)
            if t:
                school = t["short_name"]; team_id = t["id"]
        cur.execute(
            "UPDATE summer_players SET assigned_school = %s, assigned_school_team_id = %s WHERE id = %s",
            (school, team_id, body.summer_player_id),
        )
        _audit_wcl(cur, body.summer_player_id, email, "school_set", school)
        conn.commit()
    return {"ok": True, "summer_player_id": body.summer_player_id, "school": school,
            "matched_pnw": bool(team_id)}


@router.post("/admin/summer/school/clear")
def summer_school_clear(body: SummerIdBody, email: str = Depends(require_developer)):
    """Remove a WCL player's curated school."""
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_tables(cur)
        cur.execute(
            "UPDATE summer_players SET assigned_school = NULL, assigned_school_team_id = NULL WHERE id = %s",
            (body.summer_player_id,),
        )
        _audit_wcl(cur, body.summer_player_id, email, "school_clear", None)
        conn.commit()
    return {"ok": True, "summer_player_id": body.summer_player_id, "school": None}


@router.post("/admin/wcl-portal/add")
def wcl_portal_add(body: SummerIdBody, email: str = Depends(require_developer)):
    """Add a WCL player to the WCL Transfer Portal Tracker."""
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_tables(cur)
        cur.execute(
            """SELECT sp.position, st.short_name FROM summer_players sp
               JOIN summer_teams st ON sp.team_id = st.id WHERE sp.id = %s""",
            (body.summer_player_id,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Summer player not found")
        cur.execute(
            """INSERT INTO wcl_portal_members (summer_player_id, from_school, position, added_by)
               VALUES (%s, %s, %s, %s) ON CONFLICT (summer_player_id) DO NOTHING""",
            (body.summer_player_id, row.get("short_name"), row.get("position"), email),
        )
        _audit_wcl(cur, body.summer_player_id, email, "portal_add", None)
        conn.commit()
    return {"ok": True, "summer_player_id": body.summer_player_id, "in_wcl_portal": True}


@router.post("/admin/wcl-portal/remove")
def wcl_portal_remove(body: SummerIdBody, email: str = Depends(require_developer)):
    """Remove a WCL player from the WCL Transfer Portal Tracker."""
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_tables(cur)
        cur.execute("DELETE FROM wcl_portal_members WHERE summer_player_id = %s", (body.summer_player_id,))
        _audit_wcl(cur, body.summer_player_id, email, "portal_remove", None)
        conn.commit()
    return {"ok": True, "summer_player_id": body.summer_player_id, "in_wcl_portal": False}


@router.get("/admin/wcl/recent")
def wcl_recent(limit: int = Query(15, ge=1, le=50), _email: str = Depends(require_developer)):
    """Recent WCL school / portal edits for the editor's activity feed."""
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_tables(cur)
        cur.execute(
            """SELECT wa.id, wa.summer_player_id, wa.editor_email, wa.action, wa.detail, wa.created_at,
                      sp.first_name, sp.last_name, st.short_name AS team_short
               FROM wcl_audit wa
               LEFT JOIN summer_players sp ON sp.id = wa.summer_player_id
               LEFT JOIN summer_teams st ON st.id = sp.team_id
               ORDER BY wa.created_at DESC LIMIT %s""",
            (limit,),
        )
        rows = [dict(r) for r in cur.fetchall()]
    for r in rows:
        r["name"] = f"{r.get('first_name', '') or ''} {r.get('last_name', '') or ''}".strip() or f"Player {r['summer_player_id']}"
    return rows


# ─────────────────────────────────────────────────────────────────
# Incoming freshmen — manual recruits PBR/BBNW missed
# ─────────────────────────────────────────────────────────────────
# Added straight into the `recruits` table with recruit_score = NULL and
# sources = ['manual'], so they appear in a team's Recruiting Class but DON'T
# move class_score (which averages over rated, ranked-state commits only).
class FreshmanAdd(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    to_team_id: int
    position: Optional[str] = Field(None, max_length=20)
    state: Optional[str] = Field(None, max_length=4)
    grad_year: int = 2026


@router.post("/admin/freshman/add")
def freshman_add(body: FreshmanAdd, email: str = Depends(require_developer)):
    """Add an incoming freshman PBR/BBNW didn't catch. Listed in the recruiting
    class as an unrated commit (no PBR/BBNW data => no class-weight impact)."""
    parts = body.name.strip().split()
    if not parts:
        raise HTTPException(status_code=400, detail="name is required")
    first = parts[0]
    last = " ".join(parts[1:]) if len(parts) > 1 else parts[0]
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id, short_name FROM teams WHERE id = %s", (body.to_team_id,))
        team = cur.fetchone()
        if not team:
            raise HTTPException(status_code=404, detail="Destination team not found")
        cur.execute(
            """
            INSERT INTO recruits
                (first_name, last_name, position, grad_year, state,
                 committed_team_id, committed_raw, recruit_score, sources, last_seen)
            VALUES (%s, %s, %s, %s, %s, %s, %s, NULL, ARRAY['manual'], now())
            ON CONFLICT (first_name, last_name, grad_year) DO UPDATE SET
                committed_team_id = EXCLUDED.committed_team_id,
                position          = COALESCE(EXCLUDED.position, recruits.position),
                state             = COALESCE(EXCLUDED.state, recruits.state),
                sources           = CASE WHEN 'manual' = ANY(recruits.sources)
                                         THEN recruits.sources ELSE array_append(recruits.sources, 'manual') END,
                last_seen         = now()
            RETURNING id
            """,
            (first, last, (body.position or None), body.grad_year,
             (body.state or None), team["id"], team["short_name"]),
        )
        new_id = cur.fetchone()["id"]
        conn.commit()
    return {"ok": True, "id": new_id, "to_team": team["short_name"]}


@router.get("/admin/freshman/list")
def freshman_list(_email: str = Depends(require_developer)):
    """Every manually-added incoming freshman, for the editor list."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """SELECT r.id, r.first_name, r.last_name, r.position, r.state, r.grad_year,
                      t.short_name AS to_team
               FROM recruits r
               LEFT JOIN teams t ON t.id = r.committed_team_id
               WHERE 'manual' = ANY(r.sources)
               ORDER BY t.short_name, r.last_name, r.first_name"""
        )
        rows = [dict(r) for r in cur.fetchall()]
    for r in rows:
        r["name"] = f"{r.get('first_name', '') or ''} {r.get('last_name', '') or ''}".strip()
    return rows


@router.post("/admin/freshman/remove")
def freshman_remove(body: dict, email: str = Depends(require_developer)):
    """Remove a manually-added freshman. Guarded to manual rows so a scraped
    recruit can never be deleted through this endpoint."""
    rid = body.get("id")
    if not rid:
        raise HTTPException(status_code=400, detail="id is required")
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM recruits WHERE id = %s AND 'manual' = ANY(sources)", (rid,))
        deleted = cur.rowcount
        conn.commit()
    return {"ok": True, "deleted": deleted}


# ─────────────────────────────────────────────────────────────────
# Player-page linking
# ─────────────────────────────────────────────────────────────────
@router.get("/admin/link/search")
def link_search(q: str = Query(..., min_length=2), _email: str = Depends(require_developer)):
    """Search spring AND summer players for the linking tool, each annotated
    with its existing link(s) so the editor can link or unlink."""
    search = f"%{q.strip()}%"
    out = []
    with get_connection() as conn:
        cur = conn.cursor()
        # Spring players
        cur.execute(
            """
            SELECT p.id, p.first_name, p.last_name, p.position, p.year_in_school,
                   t.short_name AS team_short, t.logo_url, d.level AS division_level
            FROM players p
            JOIN teams t ON p.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE COALESCE(p.is_phantom, FALSE) = FALSE
              AND p.id IN (SELECT id FROM players
                           WHERE first_name ILIKE %s OR last_name ILIKE %s
                              OR (first_name||' '||last_name) ILIKE %s OFFSET 0)
            ORDER BY p.last_name, p.first_name
            LIMIT 20
            """,
            (search, search, search),
        )
        spring = [dict(r) for r in cur.fetchall()]
        # Summer players
        cur.execute(
            """
            SELECT sp.id, sp.first_name, sp.last_name, sp.position, sp.year_in_school,
                   st.short_name AS team_short, st.logo_url, l.abbreviation AS division_level
            FROM summer_players sp
            JOIN summer_teams st ON sp.team_id = st.id
            JOIN summer_leagues l ON l.id = st.league_id
            WHERE sp.id IN (SELECT id FROM summer_players
                            WHERE first_name ILIKE %s OR last_name ILIKE %s
                               OR (first_name||' '||last_name) ILIKE %s OFFSET 0)
            ORDER BY sp.last_name, sp.first_name
            LIMIT 20
            """,
            (search, search, search),
        )
        summer = [dict(r) for r in cur.fetchall()]

        def _name(r):
            return f"{r.get('first_name') or ''} {r.get('last_name') or ''}".strip()

        # Annotate spring players with their player_links rows.
        for r in spring:
            r["kind"] = "spring"
            r["name"] = _name(r)
            links = []
            cur.execute(
                """SELECT pl.id, pl.canonical_id, pl.linked_id,
                          cp.first_name AS c_fn, cp.last_name AS c_ln, ct.short_name AS c_team,
                          lp.first_name AS l_fn, lp.last_name AS l_ln, lt.short_name AS l_team
                   FROM player_links pl
                   LEFT JOIN players cp ON cp.id = pl.canonical_id
                   LEFT JOIN teams ct ON cp.team_id = ct.id
                   LEFT JOIN players lp ON lp.id = pl.linked_id
                   LEFT JOIN teams lt ON lp.team_id = lt.id
                   WHERE pl.canonical_id = %s OR pl.linked_id = %s""",
                (r["id"], r["id"]),
            )
            for lk in cur.fetchall():
                is_canon = lk["canonical_id"] == r["id"]
                other_name = (f"{lk['l_fn']} {lk['l_ln']}".strip() if is_canon
                              else f"{lk['c_fn']} {lk['c_ln']}".strip())
                other_team = lk["l_team"] if is_canon else lk["c_team"]
                links.append({
                    "table": "player_links", "link_id": lk["id"],
                    "role": "canonical" if is_canon else "linked",
                    "other_name": other_name, "other_team": other_team,
                })
            r["links"] = links

        # Annotate summer players with their summer_player_links rows.
        for r in summer:
            r["kind"] = "summer"
            r["name"] = _name(r)
            links = []
            cur.execute(
                """SELECT spl.id, spl.spring_player_id,
                          p.first_name, p.last_name, t.short_name AS team
                   FROM summer_player_links spl
                   LEFT JOIN players p ON p.id = spl.spring_player_id
                   LEFT JOIN teams t ON p.team_id = t.id
                   WHERE spl.summer_player_id = %s""",
                (r["id"],),
            )
            for lk in cur.fetchall():
                links.append({
                    "table": "summer_player_links", "link_id": lk["id"], "role": "summer",
                    "other_name": f"{lk['first_name'] or ''} {lk['last_name'] or ''}".strip(),
                    "other_team": lk["team"],
                })
            r["links"] = links

    # Interleave so the most relevant names surface; spring first.
    return spring + summer


class LinkRef(BaseModel):
    kind: str   # 'spring' | 'summer'
    id: int


class CreateLink(BaseModel):
    a: LinkRef
    b: LinkRef
    canonical_id: Optional[int] = None   # spring+spring only: which id is primary


class RemoveLink(BaseModel):
    table: str   # 'player_links' | 'summer_player_links'
    link_id: int


@router.post("/admin/link/create")
def link_create(body: CreateLink, email: str = Depends(require_developer)):
    a, b = body.a, body.b
    if a.kind == b.kind == "spring" and a.id == b.id:
        raise HTTPException(status_code=400, detail="Can't link a player to itself")
    kinds = {a.kind, b.kind}
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_tables(cur)

        if kinds == {"spring"}:
            canonical = body.canonical_id
            if canonical not in (a.id, b.id):
                raise HTTPException(status_code=400, detail="canonical_id must be one of the two players")
            linked = b.id if canonical == a.id else a.id
            # Guard: neither may already be a linked_id (avoid chains/cycles).
            cur.execute("SELECT 1 FROM player_links WHERE linked_id IN (%s, %s)", (canonical, linked))
            if cur.fetchone():
                raise HTTPException(status_code=409, detail="One of these is already linked. Unlink it first.")
            cur.execute(
                """INSERT INTO player_links (canonical_id, linked_id, match_type, confidence)
                   VALUES (%s, %s, 'manual', 1.0)""",
                (canonical, linked),
            )
            table = "player_links"

        elif kinds == {"spring", "summer"}:
            summer_id = a.id if a.kind == "summer" else b.id
            spring_id = a.id if a.kind == "spring" else b.id
            cur.execute("SELECT 1 FROM summer_player_links WHERE summer_player_id = %s", (summer_id,))
            if cur.fetchone():
                raise HTTPException(status_code=409, detail="This summer player is already linked. Unlink it first.")
            cur.execute(
                """INSERT INTO summer_player_links (summer_player_id, spring_player_id, confidence)
                   VALUES (%s, %s, 'manual')""",
                (summer_id, spring_id),
            )
            table = "summer_player_links"
        else:
            raise HTTPException(status_code=400, detail="Link a spring+spring or a summer+spring pair (not summer+summer).")

        cur.execute(
            """INSERT INTO link_audit (editor_email, action, table_name, a_kind, a_id, b_kind, b_id)
               VALUES (%s, 'link', %s, %s, %s, %s, %s)""",
            (email, table, a.kind, a.id, b.kind, b.id),
        )
        conn.commit()
    return {"ok": True, "table": table}


@router.post("/admin/link/remove")
def link_remove(body: RemoveLink, email: str = Depends(require_developer)):
    if body.table not in ("player_links", "summer_player_links"):
        raise HTTPException(status_code=400, detail="Bad table")
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_tables(cur)
        # table is validated against an allowlist above — safe to interpolate.
        cur.execute(f"DELETE FROM {body.table} WHERE id = %s", (body.link_id,))
        deleted = cur.rowcount
        cur.execute(
            """INSERT INTO link_audit (editor_email, action, table_name, a_id)
               VALUES (%s, 'unlink', %s, %s)""",
            (email, body.table, body.link_id),
        )
        conn.commit()
    return {"ok": True, "deleted": deleted}


# ─────────────────────────────────────────────────────────────────
# Incoming out-of-region transfers (name-only — players not in our DB)
# ─────────────────────────────────────────────────────────────────
class IncomingAdd(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    from_school: str = Field("", max_length=120)
    to_team_id: int
    position: Optional[str] = Field(None, max_length=20)


@router.get("/admin/incoming/list")
def incoming_list(_email: str = Depends(require_developer)):
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_tables(cur)
        cur.execute(
            """SELECT it.id, it.name, it.from_school, it.to_team_id, it.position, it.added_at,
                      t.short_name AS to_team
               FROM incoming_transfers it JOIN teams t ON t.id = it.to_team_id
               ORDER BY t.short_name, it.name"""
        )
        return [dict(r) for r in cur.fetchall()]


@router.post("/admin/incoming/add")
def incoming_add(body: IncomingAdd, email: str = Depends(require_developer)):
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_tables(cur)
        cur.execute("SELECT short_name FROM teams WHERE id = %s", (body.to_team_id,))
        t = cur.fetchone()
        if not t:
            raise HTTPException(status_code=404, detail="Destination team not found")
        cur.execute(
            """INSERT INTO incoming_transfers (name, from_school, to_team_id, position, added_by)
               VALUES (%s, %s, %s, %s, %s) RETURNING id""",
            (body.name.strip(), body.from_school.strip() or None, body.to_team_id,
             (body.position or "").strip() or None, email),
        )
        new_id = cur.fetchone()["id"]
        conn.commit()
    return {"ok": True, "id": new_id, "to_team": t["short_name"]}


@router.post("/admin/incoming/remove")
def incoming_remove(body: dict, email: str = Depends(require_developer)):
    iid = body.get("id")
    if not iid:
        raise HTTPException(status_code=400, detail="id required")
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_tables(cur)
        cur.execute("DELETE FROM incoming_transfers WHERE id = %s", (iid,))
        conn.commit()
    return {"ok": True}


# ─────────────────────────────────────────────────────────────────
# Recent activity (shown in the editor)
# ─────────────────────────────────────────────────────────────────
@router.get("/admin/commitment/recent")
def commitment_recent(limit: int = Query(15, le=50), _email: str = Depends(require_developer)):
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_tables(cur)
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
