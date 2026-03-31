"""
Favorites API endpoints.

Authenticated users can follow/unfollow teams and players.
Favorites are stored in Supabase Postgres, keyed by
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
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """INSERT INTO user_favorites (user_id, favorite_type, target_id)
               VALUES (%s, %s, %s) ON CONFLICT DO NOTHING""",
            (user_id, body.favorite_type, body.target_id),
        )
        conn.commit()
        return {"status": "ok", "action": "added"}


# ── Remove a favorite ───────────────────────────────────────
@favorites_router.delete("")
def remove_favorite(body: FavoriteRequest, user_id: str = Depends(get_current_user)):
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """DELETE FROM user_favorites
               WHERE user_id = %s AND favorite_type = %s AND target_id = %s""",
            (user_id, body.favorite_type, body.target_id),
        )
        conn.commit()
        return {"status": "ok", "action": "removed"}


# ── List all favorites for the current user ─────────────────
@favorites_router.get("")
def list_favorites(user_id: str = Depends(get_current_user)):
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """SELECT favorite_type, target_id, created_at
               FROM user_favorites
               WHERE user_id = %s
               ORDER BY created_at DESC""",
            (user_id,),
        )
        rows = cur.fetchall()

        # Enrich with team/player names and logos
        teams = []
        players = []
        for row in rows:
            if row["favorite_type"] == "team":
                cur.execute(
                    """SELECT t.id, t.name, t.short_name, t.logo_url,
                              d.level as division_level, c.abbreviation as conference_abbrev
                       FROM teams t
                       LEFT JOIN conferences c ON t.conference_id = c.id
                       LEFT JOIN divisions d ON c.division_id = d.id
                       WHERE t.id = %s""",
                    (row["target_id"],),
                )
                team = cur.fetchone()
                if team:
                    team["favorited_at"] = row["created_at"]
                    teams.append(team)
            else:
                cur.execute(
                    """SELECT p.id, p.first_name, p.last_name, p.position,
                              p.year_in_school as year,
                              t.name as team_name, t.id as team_id, t.logo_url as team_logo
                       FROM players p
                       LEFT JOIN teams t ON p.team_id = t.id
                       WHERE p.id = %s""",
                    (row["target_id"],),
                )
                player = cur.fetchone()
                if player:
                    player["favorited_at"] = row["created_at"]
                    players.append(player)

        return {"teams": teams, "players": players}


# ── Dashboard: rich data for favorites page ────────────────
@favorites_router.get("/dashboard")
def favorites_dashboard(user_id: str = Depends(get_current_user), season: int = 2026):
    """
    Returns enriched favorites data for the dashboard:
    - Players: season stats, last-5 game trend, headshot
    - Teams: W-L record, ranking, last-5 results, stat leaders
    """
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """SELECT favorite_type, target_id
               FROM user_favorites
               WHERE user_id = %s
               ORDER BY created_at DESC""",
            (user_id,),
        )
        rows = cur.fetchall()

        team_ids = [r["target_id"] for r in rows if r["favorite_type"] == "team"]
        player_ids = [r["target_id"] for r in rows if r["favorite_type"] == "player"]

        # ── PLAYERS ──
        players_out = []
        for pid in player_ids:
            # Basic info
            cur.execute("""
                SELECT p.id, p.first_name, p.last_name, p.position,
                       p.year_in_school, p.headshot_url,
                       t.id as team_id, t.short_name as team_short,
                       t.name as team_name, t.logo_url as team_logo,
                       d.level as division_level
                FROM players p
                LEFT JOIN teams t ON p.team_id = t.id
                LEFT JOIN conferences c ON t.conference_id = c.id
                LEFT JOIN divisions d ON c.division_id = d.id
                WHERE p.id = %s
            """, (pid,))
            player = cur.fetchone()
            if not player:
                continue
            p_data = dict(player)

            # Check for linked players (transfers)
            cur.execute(
                "SELECT linked_id FROM player_links WHERE canonical_id = %s",
                (pid,),
            )
            all_pids = [pid] + [r["linked_id"] for r in cur.fetchall()]
            pid_ph = ",".join(["%s"] * len(all_pids))

            # Season batting stats
            cur.execute(f"""
                SELECT bs.* FROM batting_stats bs
                WHERE bs.player_id IN ({pid_ph}) AND bs.season = %s
                ORDER BY bs.season DESC LIMIT 1
            """, (*all_pids, season))
            bat = cur.fetchone()
            p_data["batting"] = dict(bat) if bat else None

            # Season pitching stats
            cur.execute(f"""
                SELECT ps.* FROM pitching_stats ps
                WHERE ps.player_id IN ({pid_ph}) AND ps.season = %s
                ORDER BY ps.season DESC LIMIT 1
            """, (*all_pids, season))
            pit = cur.fetchone()
            p_data["pitching"] = dict(pit) if pit else None

            # Last 7 games batting (for trend)
            cur.execute(f"""
                SELECT g.game_date,
                       gb.at_bats, gb.hits, gb.home_runs, gb.rbi,
                       gb.walks, gb.strikeouts, gb.runs
                FROM game_batting gb
                JOIN games g ON g.id = gb.game_id
                WHERE gb.player_id IN ({pid_ph})
                  AND g.season = %s AND g.status = 'final'
                ORDER BY g.game_date DESC, g.id DESC
                LIMIT 7
            """, (*all_pids, season))
            recent_bat = [dict(r) for r in cur.fetchall()]
            # Compute last-7 slash line
            if recent_bat:
                ab7 = sum(r["at_bats"] or 0 for r in recent_bat)
                h7 = sum(r["hits"] or 0 for r in recent_bat)
                hr7 = sum(r["home_runs"] or 0 for r in recent_bat)
                rbi7 = sum(r["rbi"] or 0 for r in recent_bat)
                bb7 = sum(r["walks"] or 0 for r in recent_bat)
                k7 = sum(r["strikeouts"] or 0 for r in recent_bat)
                p_data["last7_batting"] = {
                    "games": len(recent_bat),
                    "avg": round(h7 / ab7, 3) if ab7 else None,
                    "ab": ab7, "h": h7, "hr": hr7,
                    "rbi": rbi7, "bb": bb7, "k": k7,
                }
            else:
                p_data["last7_batting"] = None

            # Last 3 pitching appearances (for trend)
            cur.execute(f"""
                SELECT g.game_date,
                       gp.innings_pitched, gp.earned_runs, gp.strikeouts,
                       gp.walks, gp.hits_allowed, gp.decision
                FROM game_pitching gp
                JOIN games g ON g.id = gp.game_id
                WHERE gp.player_id IN ({pid_ph})
                  AND g.season = %s AND g.status = 'final'
                ORDER BY g.game_date DESC, g.id DESC
                LIMIT 3
            """, (*all_pids, season))
            recent_pit = [dict(r) for r in cur.fetchall()]
            if recent_pit:
                ip3 = sum(r["innings_pitched"] or 0 for r in recent_pit)
                er3 = sum(r["earned_runs"] or 0 for r in recent_pit)
                k3 = sum(r["strikeouts"] or 0 for r in recent_pit)
                bb3 = sum(r["walks"] or 0 for r in recent_pit)
                p_data["last3_pitching"] = {
                    "games": len(recent_pit),
                    "ip": round(ip3, 1),
                    "era": round((er3 / ip3) * 9, 2) if ip3 > 0 else None,
                    "k": k3, "bb": bb3,
                    "recent": [
                        {
                            "date": str(r["game_date"]),
                            "ip": float(r["innings_pitched"] or 0),
                            "er": r["earned_runs"] or 0,
                            "k": r["strikeouts"] or 0,
                            "decision": r["decision"],
                        }
                        for r in recent_pit
                    ],
                }
            else:
                p_data["last3_pitching"] = None

            players_out.append(p_data)

        # ── TEAMS ──
        teams_out = []
        for tid in team_ids:
            # Basic info + record
            cur.execute("""
                SELECT t.id, t.name, t.short_name, t.logo_url,
                       d.level as division_level, c.abbreviation as conference_abbrev,
                       tss.wins, tss.losses, tss.ties,
                       tss.conference_wins, tss.conference_losses
                FROM teams t
                LEFT JOIN conferences c ON t.conference_id = c.id
                LEFT JOIN divisions d ON c.division_id = d.id
                LEFT JOIN team_season_stats tss ON tss.team_id = t.id AND tss.season = %s
                WHERE t.id = %s
            """, (season, tid))
            team = cur.fetchone()
            if not team:
                continue
            t_data = dict(team)

            # Last 5 results
            cur.execute("""
                SELECT g.id, g.game_date, g.home_score, g.away_score,
                       g.home_team_id, g.away_team_id,
                       COALESCE(ht.short_name, g.home_team_name) as home_name,
                       ht.logo_url as home_logo,
                       COALESCE(at2.short_name, g.away_team_name) as away_name,
                       at2.logo_url as away_logo
                FROM games g
                LEFT JOIN teams ht ON g.home_team_id = ht.id
                LEFT JOIN teams at2 ON g.away_team_id = at2.id
                WHERE (g.home_team_id = %s OR g.away_team_id = %s)
                  AND g.season = %s AND g.status = 'final'
                ORDER BY g.game_date DESC, g.id DESC
                LIMIT 10
            """, (tid, tid, season))
            raw_games = cur.fetchall()

            # Dedup (same game scraped from both teams)
            last5 = []
            seen = set()
            for g in raw_games:
                dk = (str(g["game_date"]), g["game_number"] if "game_number" in g.keys() else None,
                      min(g["home_team_id"] or 0, g["away_team_id"] or 0),
                      max(g["home_team_id"] or 0, g["away_team_id"] or 0))
                if dk in seen:
                    continue
                seen.add(dk)
                is_home = g["home_team_id"] == tid
                won = (g["home_score"] > g["away_score"]) if is_home else (g["away_score"] > g["home_score"])
                last5.append({
                    "game_date": str(g["game_date"]),
                    "opponent": g["away_name"] if is_home else g["home_name"],
                    "opp_logo": g["away_logo"] if is_home else g["home_logo"],
                    "home_away": "vs" if is_home else "@",
                    "team_score": g["home_score"] if is_home else g["away_score"],
                    "opp_score": g["away_score"] if is_home else g["home_score"],
                    "won": won,
                })
                if len(last5) >= 5:
                    break
            t_data["last5"] = last5

            # Top stat leaders (top 3 batting AVG + top 3 ERA)
            cur.execute("""
                SELECT p.id, p.first_name, p.last_name,
                       bs.batting_avg, bs.home_runs, bs.rbi, bs.ops
                FROM batting_stats bs
                JOIN players p ON bs.player_id = p.id
                WHERE bs.team_id = %s AND bs.season = %s
                  AND bs.plate_appearances >= 30
                ORDER BY bs.ops DESC
                LIMIT 3
            """, (tid, season))
            t_data["batting_leaders"] = [dict(r) for r in cur.fetchall()]

            cur.execute("""
                SELECT p.id, p.first_name, p.last_name,
                       ps.era, ps.strikeouts, ps.innings_pitched, ps.whip
                FROM pitching_stats ps
                JOIN players p ON ps.player_id = p.id
                WHERE ps.team_id = %s AND ps.season = %s
                  AND ps.innings_pitched >= 10
                ORDER BY ps.era ASC
                LIMIT 3
            """, (tid, season))
            t_data["pitching_leaders"] = [dict(r) for r in cur.fetchall()]

            teams_out.append(t_data)

        return {"players": players_out, "teams": teams_out}


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

    with get_connection() as conn:
        cur = conn.cursor()
        placeholders = ",".join(["%s"] * len(ids))
        cur.execute(
            f"""SELECT target_id FROM user_favorites
                WHERE user_id = %s AND favorite_type = %s AND target_id IN ({placeholders})""",
            [user_id, favorite_type] + ids,
        )
        rows = cur.fetchall()

        favorited = {row["target_id"]: True for row in rows}
        return {"favorited": favorited}
