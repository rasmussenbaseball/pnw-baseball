"""
Favorites API endpoints.

Authenticated users can follow/unfollow teams and players.
Favorites are stored in the local SQLite database, keyed by
the Supabase user_id (UUID string).
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Literal, Optional

from ..models.database import get_connection
from .auth import get_current_user, get_optional_user

favorites_router = APIRouter(prefix="/favorites", tags=["favorites"])


class FavoriteRequest(BaseModel):
    favorite_type: Literal["team", "player"]
    target_id: int


# ── Add a favorite ──────────────────────────────────────────
@favorites_router.post("")
def add_favorite(body: FavoriteRequest, user_id: str = Depends(get_current_user)):
    conn = get_connection()
    try:
        conn.execute(
            """INSERT OR IGNORE INTO user_favorites (user_id, favorite_type, target_id)
               VALUES (?, ?, ?)""",
            (user_id, body.favorite_type, body.target_id),
        )
        conn.commit()
        return {"status": "ok", "action": "added"}
    finally:
        conn.close()


# ── Remove a favorite ───────────────────────────────────────
@favorites_router.delete("")
def remove_favorite(body: FavoriteRequest, user_id: str = Depends(get_current_user)):
    conn = get_connection()
    try:
        conn.execute(
            """DELETE FROM user_favorites
               WHERE user_id = ? AND favorite_type = ? AND target_id = ?""",
            (user_id, body.favorite_type, body.target_id),
        )
        conn.commit()
        return {"status": "ok", "action": "removed"}
    finally:
        conn.close()


# ── List all favorites for the current user ─────────────────
@favorites_router.get("")
def list_favorites(user_id: str = Depends(get_current_user)):
    conn = get_connection()
    conn.row_factory = _dict_factory
    try:
        rows = conn.execute(
            """SELECT favorite_type, target_id, created_at
               FROM user_favorites
               WHERE user_id = ?
               ORDER BY created_at DESC""",
            (user_id,),
        ).fetchall()

        # Enrich with team/player names and logos
        teams = []
        players = []
        for row in rows:
            if row["favorite_type"] == "team":
                team = conn.execute(
                    """SELECT t.id, t.name, t.short_name, t.logo_url,
                              d.level as division_level, c.abbreviation as conference_abbrev
                       FROM teams t
                       LEFT JOIN conferences c ON t.conference_id = c.id
                       LEFT JOIN divisions d ON c.division_id = d.id
                       WHERE t.id = ?""",
                    (row["target_id"],),
                ).fetchone()
                if team:
                    team["favorited_at"] = row["created_at"]
                    teams.append(team)
            else:
                player = conn.execute(
                    """SELECT p.id, p.first_name, p.last_name, p.position,
                              p.year, p.image_url,
                              t.name as team_name, t.id as team_id, t.logo_url as team_logo
                       FROM players p
                       LEFT JOIN teams t ON p.team_id = t.id
                       WHERE p.id = ?""",
                    (row["target_id"],),
                ).fetchone()
                if player:
                    player["favorited_at"] = row["created_at"]
                    players.append(player)

        return {"teams": teams, "players": players}
    finally:
        conn.close()


# ── Check if specific items are favorited (for UI star state) ──
@favorites_router.get("/check")
def check_favorites(
    favorite_type: str,
    target_ids: str,
    user_id: Optional[str] = Depends(get_optional_user),
):
    """
    Check which of the given target_ids are favorited.
    target_ids is a comma-separated list of IDs.
    Returns a dict mapping id -> True for favorited items.
    """
    if not user_id:
        return {"favorited": {}}

    try:
        ids = [int(x.strip()) for x in target_ids.split(",") if x.strip()]
    except ValueError:
        raise HTTPException(status_code=400, detail="target_ids must be comma-separated integers")

    if not ids:
        return {"favorited": {}}

    conn = get_connection()
    try:
        placeholders = ",".join("?" * len(ids))
        rows = conn.execute(
            f"""SELECT target_id FROM user_favorites
                WHERE user_id = ? AND favorite_type = ? AND target_id IN ({placeholders})""",
            [user_id, favorite_type] + ids,
        ).fetchall()

        favorited = {row[0]: True for row in rows}
        return {"favorited": favorited}
    finally:
        conn.close()


def _dict_factory(cursor, row):
    return {col[0]: row[i] for i, col in enumerate(cursor.description)}
