"""
Recruiting Boards API.

Coaches (recruiting tier or higher) can build their own recruiting boards:
unlimited boards with custom titles, populated either from our player pages
("Add to board") or with manually-entered non-PNW players. Boards are
shareable with other coaches BY EMAIL — anyone whose email is on a board can
view it and add players to it.

Identity & access:
  - Every authenticated request resolves to {user_id, email} via current_member,
    which also enforces the recruiting tier.
  - A user can ACCESS a board if their email is the owner_email OR their email is
    in recruiting_board_members. Owner-only actions (rename, delete, manage
    members) additionally require owner_email == the caller's email.
  - Emails are stored lowercased so sharing is case-insensitive.

Tables are created lazily (IF NOT EXISTS) on first use, matching the pattern used
elsewhere (e.g. pickem).
"""

from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from ..models.database import get_connection
from .auth import _extract_token, require_tier
from ._tier_allowlist import email_for_token

router = APIRouter(prefix="/recruiting-boards", tags=["recruiting-boards"])

_recruiting_gate = require_tier("recruiting")


def current_member(request: Request) -> dict:
    """Enforce the recruiting tier and resolve {user_id, email} in one place.

    require_tier already verifies the token + tier and returns the user_id;
    email_for_token reads the email (cached) for sharing + attribution."""
    user_id = _recruiting_gate(request)
    token = _extract_token(request)
    email = (email_for_token(token) or "").strip().lower()
    if not email:
        raise HTTPException(status_code=400, detail="Could not resolve your account email.")
    return {"user_id": user_id, "email": email}


def _ensure_tables(cur):
    cur.execute("""
        CREATE TABLE IF NOT EXISTS recruiting_boards (
            id SERIAL PRIMARY KEY,
            owner_user_id TEXT NOT NULL,
            owner_email   TEXT NOT NULL,
            title         TEXT NOT NULL,
            created_at    TIMESTAMPTZ DEFAULT NOW(),
            updated_at    TIMESTAMPTZ DEFAULT NOW()
        )""")
    cur.execute("""
        CREATE TABLE IF NOT EXISTS recruiting_board_members (
            id        SERIAL PRIMARY KEY,
            board_id  INTEGER NOT NULL REFERENCES recruiting_boards(id) ON DELETE CASCADE,
            email     TEXT NOT NULL,
            added_by  TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE (board_id, email)
        )""")
    cur.execute("""
        CREATE TABLE IF NOT EXISTS recruiting_board_players (
            id         SERIAL PRIMARY KEY,
            board_id   INTEGER NOT NULL REFERENCES recruiting_boards(id) ON DELETE CASCADE,
            player_id  INTEGER,
            name       TEXT NOT NULL,
            position   TEXT,
            class_year TEXT,
            school     TEXT,
            height     TEXT,
            weight     TEXT,
            stats      TEXT,
            notes      TEXT,
            committed      BOOLEAN DEFAULT FALSE,
            offer_amount   TEXT,
            last_contacted DATE,
            added_by_email TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )""")
    # additive columns for boards created before these fields existed
    cur.execute("ALTER TABLE recruiting_board_players ADD COLUMN IF NOT EXISTS committed BOOLEAN DEFAULT FALSE")
    cur.execute("ALTER TABLE recruiting_board_players ADD COLUMN IF NOT EXISTS offer_amount TEXT")
    cur.execute("ALTER TABLE recruiting_board_players ADD COLUMN IF NOT EXISTS last_contacted DATE")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_rbp_board ON recruiting_board_players(board_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_rbm_email ON recruiting_board_members(LOWER(email))")


def _board_row(cur, board_id: int):
    cur.execute("SELECT * FROM recruiting_boards WHERE id = %s", (board_id,))
    return cur.fetchone()


def _can_access(cur, board, email: str) -> bool:
    if not board:
        return False
    if (board["owner_email"] or "").lower() == email:
        return True
    cur.execute(
        "SELECT 1 FROM recruiting_board_members WHERE board_id = %s AND LOWER(email) = %s",
        (board["id"], email),
    )
    return cur.fetchone() is not None


def _require_board(cur, board_id: int, email: str, *, owner_only: bool = False):
    board = _board_row(cur, board_id)
    if not board:
        raise HTTPException(status_code=404, detail="Board not found.")
    is_owner = (board["owner_email"] or "").lower() == email
    if owner_only:
        if not is_owner:
            raise HTTPException(status_code=403, detail="Only the board owner can do that.")
    elif not _can_access(cur, board, email):
        raise HTTPException(status_code=403, detail="You don't have access to this board.")
    return board, is_owner


def _f3(x):
    try: return f"{float(x):.3f}".lstrip("0") or ".000"
    except (TypeError, ValueError): return None


def _f2(x):
    try: return f"{float(x):.2f}"
    except (TypeError, ValueError): return None


def _attach_stat_lines(cur, players):
    """For players that are in OUR database (player_id set), attach a compact
    `stat_line` of their actual most-recent-season stats. Manually-entered
    (non-PNW) players get nothing here."""
    pids = [p["player_id"] for p in players if p.get("player_id")]
    if not pids:
        return
    cur.execute("""SELECT DISTINCT ON (player_id) player_id, season, batting_avg, on_base_pct,
                          slugging_pct, home_runs, stolen_bases, wrc_plus, plate_appearances
                   FROM batting_stats WHERE player_id = ANY(%s) AND plate_appearances >= 10
                   ORDER BY player_id, season DESC""", (pids,))
    bat = {r["player_id"]: r for r in cur.fetchall()}
    cur.execute("""SELECT DISTINCT ON (player_id) player_id, season, era, strikeouts,
                          innings_pitched, whip, batters_faced
                   FROM pitching_stats WHERE player_id = ANY(%s) AND batters_faced >= 10
                   ORDER BY player_id, season DESC""", (pids,))
    pit = {r["player_id"]: r for r in cur.fetchall()}
    for p in players:
        pid = p.get("player_id")
        if not pid:
            continue
        segs, season = [], None
        b = bat.get(pid)
        if b:
            season = b["season"]
            bits = [f"{_f3(b['batting_avg'])}/{_f3(b['on_base_pct'])}/{_f3(b['slugging_pct'])}"]
            if b["home_runs"]:
                bits.append(f"{b['home_runs']} HR")
            if b["stolen_bases"]:
                bits.append(f"{b['stolen_bases']} SB")
            if b["wrc_plus"] is not None:
                bits.append(f"{int(b['wrc_plus'])} wRC+")
            segs.append(", ".join(bits))
        pp = pit.get(pid)
        if pp:
            season = max(season or pp["season"], pp["season"])
            bits = [f"{_f2(pp['era'])} ERA"]
            if pp["innings_pitched"] is not None:
                bits.append(f"{pp['innings_pitched']} IP")
            if pp["strikeouts"]:
                bits.append(f"{pp['strikeouts']} K")
            if pp["whip"] is not None:
                bits.append(f"{_f2(pp['whip'])} WHIP")
            segs.append(", ".join(bits))
        if segs:
            p["stat_line"] = "  ·  ".join(segs)
            p["stat_season"] = season


# ── Pydantic bodies ──────────────────────────────────────────
class BoardCreate(BaseModel):
    title: str


class BoardRename(BaseModel):
    title: str


class MemberAdd(BaseModel):
    email: str


class PlayerAdd(BaseModel):
    player_id: Optional[int] = None
    name: str
    position: Optional[str] = None
    class_year: Optional[str] = None
    school: Optional[str] = None
    height: Optional[str] = None
    weight: Optional[str] = None
    stats: Optional[str] = None
    notes: Optional[str] = None


class PlayerUpdate(BaseModel):
    name: Optional[str] = None
    position: Optional[str] = None
    class_year: Optional[str] = None
    school: Optional[str] = None
    height: Optional[str] = None
    weight: Optional[str] = None
    stats: Optional[str] = None
    notes: Optional[str] = None
    committed: Optional[bool] = None
    offer_amount: Optional[str] = None
    last_contacted: Optional[str] = None    # 'YYYY-MM-DD' or '' to clear


# ── Boards ───────────────────────────────────────────────────
@router.get("")
def list_boards(member: dict = Depends(current_member)):
    """Every board the caller owns or has been shared on, with a player count
    and a shared/owner flag."""
    email = member["email"]
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_tables(cur)
        cur.execute("""
            SELECT b.id, b.title, b.owner_email, b.created_at, b.updated_at,
                   (SELECT COUNT(*) FROM recruiting_board_players p WHERE p.board_id = b.id) AS player_count,
                   (SELECT COUNT(*) FROM recruiting_board_members m WHERE m.board_id = b.id) AS member_count
            FROM recruiting_boards b
            WHERE LOWER(b.owner_email) = %s
               OR b.id IN (SELECT board_id FROM recruiting_board_members WHERE LOWER(email) = %s)
            ORDER BY b.updated_at DESC, b.id DESC
        """, (email, email))
        rows = cur.fetchall()
        conn.commit()
        out = []
        for r in rows:
            d = dict(r)
            d["is_owner"] = (r["owner_email"] or "").lower() == email
            out.append(d)
        return {"boards": out, "email": email}


@router.post("")
def create_board(body: BoardCreate, member: dict = Depends(current_member)):
    title = (body.title or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="Board title is required.")
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_tables(cur)
        cur.execute(
            """INSERT INTO recruiting_boards (owner_user_id, owner_email, title)
               VALUES (%s, %s, %s) RETURNING id""",
            (member["user_id"], member["email"], title),
        )
        board_id = cur.fetchone()["id"]
        conn.commit()
        return {"status": "ok", "id": board_id, "title": title}


@router.get("/{board_id}")
def get_board(board_id: int, member: dict = Depends(current_member)):
    email = member["email"]
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_tables(cur)
        board, is_owner = _require_board(cur, board_id, email)
        cur.execute("""SELECT id, player_id, name, position, class_year, school, height,
                              weight, stats, notes, committed, offer_amount, last_contacted,
                              added_by_email, created_at, updated_at
                       FROM recruiting_board_players WHERE board_id = %s
                       ORDER BY committed DESC, created_at DESC, id DESC""", (board_id,))
        players = [dict(r) for r in cur.fetchall()]
        _attach_stat_lines(cur, players)
        cur.execute("SELECT id, email, added_by, created_at FROM recruiting_board_members "
                    "WHERE board_id = %s ORDER BY created_at", (board_id,))
        members = [dict(r) for r in cur.fetchall()]
        conn.commit()
        return {
            "board": {"id": board["id"], "title": board["title"],
                      "owner_email": board["owner_email"], "is_owner": is_owner},
            "players": players,
            "members": members,
            "viewer_email": email,
        }


@router.patch("/{board_id}")
def rename_board(board_id: int, body: BoardRename, member: dict = Depends(current_member)):
    title = (body.title or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="Board title is required.")
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_tables(cur)
        _require_board(cur, board_id, member["email"], owner_only=True)
        cur.execute("UPDATE recruiting_boards SET title = %s, updated_at = NOW() WHERE id = %s",
                    (title, board_id))
        conn.commit()
        return {"status": "ok", "title": title}


@router.delete("/{board_id}")
def delete_board(board_id: int, member: dict = Depends(current_member)):
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_tables(cur)
        _require_board(cur, board_id, member["email"], owner_only=True)
        cur.execute("DELETE FROM recruiting_boards WHERE id = %s", (board_id,))
        conn.commit()
        return {"status": "ok"}


# ── Sharing (members) ────────────────────────────────────────
@router.post("/{board_id}/members")
def add_member(board_id: int, body: MemberAdd, member: dict = Depends(current_member)):
    new_email = (body.email or "").strip().lower()
    if not new_email or "@" not in new_email:
        raise HTTPException(status_code=400, detail="A valid email is required.")
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_tables(cur)
        board, _ = _require_board(cur, board_id, member["email"], owner_only=True)
        if new_email == (board["owner_email"] or "").lower():
            raise HTTPException(status_code=400, detail="That email already owns this board.")
        cur.execute(
            """INSERT INTO recruiting_board_members (board_id, email, added_by)
               VALUES (%s, %s, %s) ON CONFLICT (board_id, email) DO NOTHING""",
            (board_id, new_email, member["email"]),
        )
        conn.commit()
        return {"status": "ok", "email": new_email}


@router.delete("/{board_id}/members/{member_row_id}")
def remove_member(board_id: int, member_row_id: int, member: dict = Depends(current_member)):
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_tables(cur)
        _require_board(cur, board_id, member["email"], owner_only=True)
        cur.execute("DELETE FROM recruiting_board_members WHERE id = %s AND board_id = %s",
                    (member_row_id, board_id))
        conn.commit()
        return {"status": "ok"}


# ── Players on a board ───────────────────────────────────────
@router.post("/{board_id}/players")
def add_player(board_id: int, body: PlayerAdd, member: dict = Depends(current_member)):
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Player name is required.")
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_tables(cur)
        _require_board(cur, board_id, member["email"])
        cur.execute("""INSERT INTO recruiting_board_players
            (board_id, player_id, name, position, class_year, school, height, weight,
             stats, notes, added_by_email)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
            (board_id, body.player_id, name, body.position, body.class_year, body.school,
             body.height, body.weight, body.stats, body.notes, member["email"]))
        new_id = cur.fetchone()["id"]
        cur.execute("UPDATE recruiting_boards SET updated_at = NOW() WHERE id = %s", (board_id,))
        conn.commit()
        return {"status": "ok", "id": new_id}


@router.patch("/{board_id}/players/{rbp_id}")
def update_player(board_id: int, rbp_id: int, body: PlayerUpdate,
                  member: dict = Depends(current_member)):
    fields = {k: v for k, v in body.dict().items() if v is not None}
    # an empty last_contacted means "clear the date" → store NULL (not '')
    if fields.get("last_contacted") == "":
        fields["last_contacted"] = None
    if not fields:
        return {"status": "ok"}
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_tables(cur)
        _require_board(cur, board_id, member["email"])
        sets = ", ".join(f"{k} = %s" for k in fields) + ", updated_at = NOW()"
        cur.execute(f"UPDATE recruiting_board_players SET {sets} WHERE id = %s AND board_id = %s",
                    (*fields.values(), rbp_id, board_id))
        conn.commit()
        return {"status": "ok"}


@router.delete("/{board_id}/players/{rbp_id}")
def remove_player(board_id: int, rbp_id: int, member: dict = Depends(current_member)):
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_tables(cur)
        _require_board(cur, board_id, member["email"])
        cur.execute("DELETE FROM recruiting_board_players WHERE id = %s AND board_id = %s",
                    (rbp_id, board_id))
        conn.commit()
        return {"status": "ok"}
