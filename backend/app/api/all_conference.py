"""
All-conference team generator + league constants.

Extracted from routes.py (June 2026 split). Shared helpers that still
live in routes.py are imported as `from .routes import ...` — routes.py
never imports this module, so there is no circular import.
"""

import json
import math
import os
import re
import threading
from bisect import bisect_left, bisect_right
from datetime import datetime, date, timedelta

from fastapi import APIRouter, Depends, Query, HTTPException, Body
from fastapi.responses import JSONResponse, FileResponse
from psycopg2.extras import Json
from typing import Optional
from ..models.database import get_connection
from ..cache import cached_endpoint
from ..config import CURRENT_SEASON
from .auth import require_admin, require_tier
from .leverage import compute_li
from .lineup_helper import (
    compute_team_lineup_helper,
    compute_manual_lineup,
    compute_build_lineup,
)
from .team_scouting import compute_team_scouting

# Phase E: batted-ball + spray classifier (lives in scripts/ but is
# pure Python — import via path manipulation so the API can use it.)
import sys as _sys
import pathlib as _pathlib
_sys.path.insert(
    0,
    str(_pathlib.Path(__file__).resolve().parents[3] / "scripts"),
)
try:
    from classify_batted_ball import spray_for as _spray_for  # noqa: E402
except ImportError:
    _spray_for = lambda zone, bats: None  # noqa: E731
from ..stats.advanced import (
    BattingLine, PitchingLine,
    compute_batting_advanced, compute_pitching_advanced, compute_college_war,
    normalize_position, DEFAULT_WEIGHTS,
    POSITION_ADJUSTMENTS_FULL,
    compute_fip_constant, innings_to_outs,
)
from ..stats.tiebreakers import apply_head_to_head
from ..stats.projections import (
    load_future_schedules,
    project_remaining_games,
    run_monte_carlo,
    build_projected_standings,
    determine_playoff_fields,
    elo_win_prob,
    simulate_nwac_championship_odds,
    resolve_known_nwac_results,
    pct_to_american,
    NWAC_2026_CHAMP_SEEDS,
    NWAC_2026_CHAMP_HOST_ID,
    PLAYOFF_FORMATS,
    CONFERENCE_TO_FORMAT,
)

from .routes import QUALIFIED_PA_PER_GAME, QUALIFIED_IP_PER_GAME

router = APIRouter()

# ============================================================
# ALL-CONFERENCE GENERATOR
# Builds first team, second team, and top-3 honorable mentions
# for each conference (and aggregate groupings).
# ============================================================

def _get_conf_freeze(cur, conf_key):
    """Return the conference_freezes row for conf_key, or None if live.

    Presence of a row means the conference's regular season is over and the
    All-Conference page (and other frozen features) should serve the
    snapshot from the *_frozen tables instead of the live aggregates.
    """
    cur.execute(
        "SELECT conf_key, regular_season_end_date, frozen_at "
        "FROM conference_freezes WHERE conf_key = %s",
        (conf_key,),
    )
    return cur.fetchone()


# Maps the user-facing `conf` query param to the set of conference
# names/abbreviations stored in the `conferences` table.
ALL_CONF_GROUPS = {
    "gnac": {
        "label": "GNAC (D2)",
        "conf_names": ["Great Northwest Athletic Conference", "GNAC"],
        "conf_abbrevs": ["GNAC"],
        "rate_mode": False,
    },
    "nwc": {
        "label": "NWC (D3)",
        "conf_names": ["Northwest Conference", "NWC"],
        "conf_abbrevs": ["NWC"],
        "rate_mode": False,
    },
    "ccc": {
        "label": "CCC (NAIA)",
        "conf_names": ["Cascade Collegiate Conference", "CCC"],
        "conf_abbrevs": ["CCC"],
        "rate_mode": False,
    },
    "nwac-north": {
        "label": "NWAC North",
        "conf_names": ["NWAC North Division", "NWAC North"],
        "conf_abbrevs": ["NWAC-N"],
        "rate_mode": False,
    },
    "nwac-east": {
        "label": "NWAC East",
        "conf_names": ["NWAC East Division", "NWAC East"],
        "conf_abbrevs": ["NWAC-E"],
        "rate_mode": False,
    },
    "nwac-south": {
        "label": "NWAC South",
        "conf_names": ["NWAC South Division", "NWAC South"],
        "conf_abbrevs": ["NWAC-S"],
        "rate_mode": False,
    },
    "nwac-west": {
        "label": "NWAC West",
        "conf_names": ["NWAC West Division", "NWAC West"],
        "conf_abbrevs": ["NWAC-W"],
        "rate_mode": False,
    },
    "all-nwac": {
        "label": "All-NWAC",
        "conf_names": [
            "NWAC North Division", "NWAC East Division",
            "NWAC South Division", "NWAC West Division",
        ],
        "conf_abbrevs": ["NWAC-N", "NWAC-E", "NWAC-S", "NWAC-W"],
        "rate_mode": False,
    },
    "all-pnw": {
        "label": "All-PNW",
        "conf_names": None,  # every conference
        "conf_abbrevs": None,
        "rate_mode": True,   # use WAR/PA and WAR/IP, qualified only
    },
}

# 10 position slots in display order: 5 IF + 3 OF + DH + UTIL
AC_POSITION_SLOTS = ["C", "1B", "2B", "3B", "SS", "OF1", "OF2", "OF3", "DH", "UTIL"]
# Each slot maps to an underlying eligibility "category"
AC_SLOT_TO_CATEGORY = {
    "C": "C", "1B": "1B", "2B": "2B", "3B": "3B", "SS": "SS",
    "OF1": "OF", "OF2": "OF", "OF3": "OF",
    "DH": "DH", "UTIL": "UTIL",
}
# Distinct eligibility categories used for HM lists / candidate pools
AC_CATEGORIES = ["C", "1B", "2B", "3B", "SS", "OF", "DH", "UTIL"]
# Positions that qualify a player as an infielder (for UTIL)
AC_INFIELD = {"C", "1B", "2B", "3B", "SS"}
AC_OUTFIELD = {"LF", "CF", "RF", "OF"}
# Minimum games at a position to be eligible there
AC_POS_GAMES_MIN = 15
# DH share: DH games must be this fraction of games appeared (fielding+DH).
# No minimum game count — a player who appears in 20 games with 4+ at DH qualifies.
AC_DH_MIN_SHARE = 0.20
# Two-way UTIL thresholds
AC_UTIL_TWO_WAY_MIN_IP = 10.0
AC_UTIL_TWO_WAY_MIN_PA = 40
# Flex UTIL threshold (applies to each of the two position-based paths)
AC_UTIL_FLEX_POS_GAMES = 5
# Reliever thresholds
AC_REL_MIN_IP = 15.0
AC_REL_MAX_GS = 3  # < 4 starts


@router.get("/all-conference")
@cached_endpoint(ttl_seconds=1800)
def all_conference(
    conf: str = Query(..., description="Conference group key (e.g. gnac, nwc, ccc, nwac-east, all-nwac, all-pnw)"),
    season: int = Query(CURRENT_SEASON, description="Season year"),
):
    """
    Build mock first team, second team, and top-3 honorable mentions for
    a conference (or aggregate grouping).  10 position spots (C/1B/2B/3B/
    SS/OF1/OF2/OF3/DH/UTIL) plus 4 SP + 1 RP per team.

    Selection rules:
      - Position eligibility: 15+ games at that position in game_batting
      - OF1/OF2/OF3 share one combined outfield pool (any LF/CF/RF/OF
        appearance counts toward outfield games)
      - DH: 15+ games at DH AND DH games >= 50% of defensive games
      - UTIL: two-way player (10+ IP AND 40+ PA) OR 7+ games at both
        infield and outfield (catcher counts as infield)
      - Negative WAR players are excluded from every pool
      - Each player can only appear once on a conference page (across 1st
        team, 2nd team, and HM, and across hitter/pitcher pools)
      - Primary role for two-way players is whichever WAR is higher
      - Primary sort: WAR (rate-adjusted WAR/PA + WAR/IP for 'all-pnw')
      - Hitter tiebreak: wRC+
      - Pitcher tiebreak: FIP (lower is better)
      - Multi-position handling: maximize combined WAR across both slots
      - Starters: qualified (0.75 IP per team game), ranked by WAR
      - Reliever: 15+ IP, fewer than 4 starts, ranked by WAR/IP
      - all-pnw uses rate stats and is qualified-only
    """
    group = ALL_CONF_GROUPS.get(conf)
    if not group:
        return {"error": f"Unknown conference key: {conf}"}

    rate_mode = group["rate_mode"]

    with get_connection() as conn:
        cur = conn.cursor()

        # ── Freeze check ─────────────────────────────────────────
        # If this conference's regular season has ended, we serve data
        # from the *_frozen snapshot tables instead of the live ones so
        # playoff games don't change the All-Conference teams or awards.
        # all-pnw (which has None conf_names) can never be frozen directly
        # since it spans every division.
        freeze = _get_conf_freeze(cur, conf) if group["conf_names"] is not None else None
        is_frozen = freeze is not None
        batting_table = "batting_stats_frozen" if is_frozen else "batting_stats"
        pitching_table = "pitching_stats_frozen" if is_frozen else "pitching_stats"
        team_season_table = "team_season_stats_frozen" if is_frozen else "team_season_stats"
        # Frozen tables have a conf_key stamp; live tables do not.
        tss_conf_cond = " AND tss.conf_key = %s" if is_frozen else ""
        bs_conf_cond = " AND bs.conf_key = %s" if is_frozen else ""
        ps_conf_cond = " AND ps.conf_key = %s" if is_frozen else ""

        # ── Resolve the set of team_ids in scope ─────────────────
        if group["conf_names"] is None:
            # all-pnw: every active team with stats this season
            cur.execute(f"""
                SELECT t.id, t.name, t.short_name, t.logo_url,
                       c.name as conference_name, c.abbreviation as conference_abbrev,
                       d.level as division_level,
                       COALESCE(tss.wins,0) + COALESCE(tss.losses,0) + COALESCE(tss.ties,0) as team_games
                FROM teams t
                JOIN conferences c ON c.id = t.conference_id
                JOIN divisions d ON d.id = c.division_id
                LEFT JOIN {team_season_table} tss
                  ON tss.team_id = t.id AND tss.season = %s
                WHERE t.is_active = 1
            """, (season,))
        else:
            tss_params = (conf,) if is_frozen else ()
            cur.execute(f"""
                SELECT t.id, t.name, t.short_name, t.logo_url,
                       c.name as conference_name, c.abbreviation as conference_abbrev,
                       d.level as division_level,
                       COALESCE(tss.wins,0) + COALESCE(tss.losses,0) + COALESCE(tss.ties,0) as team_games
                FROM teams t
                JOIN conferences c ON c.id = t.conference_id
                JOIN divisions d ON d.id = c.division_id
                LEFT JOIN {team_season_table} tss
                  ON tss.team_id = t.id AND tss.season = %s{tss_conf_cond}
                WHERE t.is_active = 1
                  AND (c.name = ANY(%s) OR c.abbreviation = ANY(%s))
            """, (season, *tss_params, group["conf_names"], group["conf_abbrevs"]))

        team_rows = cur.fetchall()
        teams_by_id = {t["id"]: dict(t) for t in team_rows}
        team_ids = list(teams_by_id.keys())
        if not team_ids:
            return {"conf": conf, "label": group["label"], "season": season,
                    "first_team": {}, "second_team": {}, "honorable_mentions": {}, "teams": []}

        # ── Pull batting stats for players on these teams ─────────
        bs_params = (conf,) if is_frozen else ()
        cur.execute(f"""
            SELECT bs.player_id, bs.team_id,
                   p.first_name, p.last_name, p.headshot_url, p.position as listed_position,
                   p.year_in_school, p.bats, p.throws,
                   bs.plate_appearances, bs.at_bats, bs.hits, bs.home_runs,
                   bs.stolen_bases,
                   bs.strikeouts, bs.walks,
                   bs.batting_avg, bs.on_base_pct, bs.slugging_pct, bs.ops,
                   bs.iso, bs.woba, bs.k_pct, bs.bb_pct,
                   bs.wrc_plus, bs.offensive_war
            FROM {batting_table} bs
            JOIN players p ON p.id = bs.player_id
            WHERE bs.season = %s AND bs.team_id = ANY(%s){bs_conf_cond}
        """, (season, team_ids, *bs_params))
        batting_rows = [dict(r) for r in cur.fetchall()]
        batting_by_pid = {b["player_id"]: b for b in batting_rows}

        # ── Pull pitching stats for players on these teams ────────
        ps_params = (conf,) if is_frozen else ()
        cur.execute(f"""
            SELECT ps.player_id, ps.team_id,
                   p.first_name, p.last_name, p.headshot_url, p.position as listed_position,
                   p.year_in_school, p.bats, p.throws,
                   ps.innings_pitched, ps.games, ps.games_started,
                   ps.era, ps.fip, ps.fip_plus, ps.whip, ps.siera,
                   ps.strikeouts, ps.walks, ps.k_pct, ps.bb_pct,
                   ps.wins, ps.saves,
                   ps.pitching_war
            FROM {pitching_table} ps
            JOIN players p ON p.id = ps.player_id
            WHERE ps.season = %s AND ps.team_id = ANY(%s){ps_conf_cond}
        """, (season, team_ids, *ps_params))
        pitching_rows = [dict(r) for r in cur.fetchall()]
        pitching_by_pid = {p["player_id"]: p for p in pitching_rows}

        # ── Pull position-games per player from game_batting ──────
        # We use normalized position buckets: C, 1B, 2B, 3B, SS, LF, CF, RF,
        # DH, P.  Anything else is ignored. Postseason games are excluded
        # so playoff appearances don't affect position eligibility — the
        # all-conference pools should reflect the regular season only.
        cur.execute("""
            SELECT gb.player_id, gb.position,
                   COUNT(DISTINCT (g.game_date, COALESCE(g.game_number, 1))) as games
            FROM game_batting gb
            JOIN games g ON g.id = gb.game_id
            WHERE gb.player_id IS NOT NULL
              AND g.season = %s
              AND gb.team_id = ANY(%s)
              AND gb.position IS NOT NULL
              AND gb.position != ''
              AND gb.position != '-'
              AND (g.is_postseason IS NULL OR g.is_postseason = FALSE)
            GROUP BY gb.player_id, gb.position
        """, (season, team_ids))
        pos_rows = cur.fetchall()

        # ── First-season-at-team lookup (for Transfer of the Year) ──
        # A player is "first-year at program" if their earliest season
        # at the current team_id is this season.  Uses batting_stats
        # UNION pitching_stats so two-way guys get covered either way.
        cur.execute("""
            SELECT player_id, team_id, MIN(season) AS first_season
            FROM (
                SELECT player_id, team_id, season FROM batting_stats
                UNION
                SELECT player_id, team_id, season FROM pitching_stats
            ) s
            WHERE team_id = ANY(%s)
            GROUP BY player_id, team_id
        """, (team_ids,))
        first_season_rows = cur.fetchall()
        first_season_by_pid_team = {
            (r["player_id"], r["team_id"]): r["first_season"]
            for r in first_season_rows
        }

    # Normalize positions locally (same logic as update_positions.py uses,
    # but simple enough to inline)
    def norm_pos(raw):
        if not raw:
            return None
        s = raw.strip().upper()
        # Strip trailing slash parts ("2B/SS" -> first token)
        s = s.split("/")[0]
        aliases = {
            "C": "C", "1B": "1B", "2B": "2B", "3B": "3B", "SS": "SS",
            "LF": "LF", "CF": "CF", "RF": "RF", "DH": "DH", "PH": None,
            "PR": None, "P": "P", "RHP": "P", "LHP": "P", "OF": "OF",
            "IF": None,
        }
        return aliases.get(s, None)

    pos_games = {}  # player_id -> {pos: games}
    for row in pos_rows:
        pid = row["player_id"]
        np = norm_pos(row["position"])
        if not np:
            continue
        if pid not in pos_games:
            pos_games[pid] = {}
        pos_games[pid][np] = pos_games[pid].get(np, 0) + (row["games"] or 0)

    # OF bucket: some players have raw "OF" rows; also any LF/CF/RF counts
    for pid, pg in pos_games.items():
        of_total = pg.get("LF", 0) + pg.get("CF", 0) + pg.get("RF", 0) + pg.get("OF", 0)
        pg["_OF_TOTAL"] = of_total
        if_total = sum(pg.get(p, 0) for p in AC_INFIELD)
        pg["_IF_TOTAL"] = if_total

    # ── Build per-player candidate objects ───────────────────────
    # One entry per player, whether they hit, pitch, or both.
    def base_player(pid, team_id, first_name, last_name, headshot, listed, year_in_school):
        team = teams_by_id.get(team_id, {}) or {}
        return {
            "player_id": pid,
            "team_id": team_id,
            "team_name": team.get("name"),
            "team_short": team.get("short_name"),
            "team_logo": team.get("logo_url"),
            "conference_abbrev": team.get("conference_abbrev"),
            "division_level": team.get("division_level"),
            "team_games": team.get("team_games") or 0,
            "name": f"{first_name or ''} {last_name or ''}".strip(),
            "first_name": first_name,
            "last_name": last_name,
            "headshot_url": headshot,
            "listed_position": listed,
            "year_in_school": year_in_school,
        }

    players = {}  # pid -> merged record
    for b in batting_rows:
        pid = b["player_id"]
        rec = players.get(pid) or base_player(
            pid, b["team_id"], b["first_name"], b["last_name"],
            b["headshot_url"], b["listed_position"], b.get("year_in_school")
        )
        pa = float(b.get("plate_appearances") or 0)
        war = float(b.get("offensive_war") or 0)
        rec.update({
            "pa": pa,
            "war_bat": war,
            "war_bat_rate": (war / pa) if pa > 0 else 0.0,
            "wrc_plus": b.get("wrc_plus"),
            "avg": b.get("batting_avg"),
            "obp": b.get("on_base_pct"),
            "slg": b.get("slugging_pct"),
            "ops": b.get("ops"),
            "iso": b.get("iso"),
            "woba": b.get("woba"),
            "hr": b.get("home_runs"),
            "sb": b.get("stolen_bases"),
            "hits": b.get("hits"),
            "bat_k": b.get("strikeouts"),
            "bat_bb": b.get("walks"),
            "bat_k_pct": b.get("k_pct"),
            "bat_bb_pct": b.get("bb_pct"),
        })
        players[pid] = rec

    for p in pitching_rows:
        pid = p["player_id"]
        rec = players.get(pid) or base_player(
            pid, p["team_id"], p["first_name"], p["last_name"],
            p["headshot_url"], p["listed_position"], p.get("year_in_school")
        )
        ip = float(p.get("innings_pitched") or 0)
        pwar = float(p.get("pitching_war") or 0)
        rec.update({
            "ip": ip,
            "war_pit": pwar,
            "war_pit_rate": (pwar / ip) if ip > 0 else 0.0,
            "fip": p.get("fip"),
            "fip_plus": p.get("fip_plus"),
            "era": p.get("era"),
            "whip": p.get("whip"),
            "siera": p.get("siera"),
            "k": p.get("strikeouts"),
            "bb": p.get("walks"),
            "pit_k_pct": p.get("k_pct"),
            "pit_bb_pct": p.get("bb_pct"),
            "gs": p.get("games_started") or 0,
            "g_pitch": p.get("games") or 0,
        })
        players[pid] = rec

    # Attach position games to each player
    for pid, rec in players.items():
        pg = pos_games.get(pid, {})
        rec["pos_games"] = {k: v for k, v in pg.items() if not k.startswith("_")}
        rec["if_games"] = pg.get("_IF_TOTAL", 0)
        rec["of_games"] = pg.get("_OF_TOTAL", 0)
        rec.setdefault("pa", 0.0)
        rec.setdefault("war_bat", 0.0)
        rec.setdefault("war_bat_rate", 0.0)
        rec.setdefault("ip", 0.0)
        rec.setdefault("war_pit", 0.0)
        rec.setdefault("war_pit_rate", 0.0)
        rec.setdefault("gs", 0)

    # ── Helpers for sort keys ────────────────────────────────────
    def bat_war(rec):
        return rec["war_bat_rate"] if rate_mode else rec["war_bat"]

    def pit_war(rec):
        return rec["war_pit_rate"] if rate_mode else rec["war_pit"]

    def bat_tiebreak(rec):
        # Higher wRC+ is better
        return rec.get("wrc_plus") or -999

    def pit_tiebreak(rec):
        # Lower FIP is better (so negate for descending sort)
        fip = rec.get("fip")
        return -fip if fip is not None else -999

    # ── Qualification helpers ────────────────────────────────────
    def is_qualified_bat(rec):
        tg = rec["team_games"] or 0
        return rec["pa"] >= QUALIFIED_PA_PER_GAME * tg and tg > 0

    def is_qualified_pit(rec):
        tg = rec["team_games"] or 0
        return rec["ip"] >= QUALIFIED_IP_PER_GAME * tg and tg > 0

    # ── Position eligibility ─────────────────────────────────────
    def eligible_categories(rec):
        """Set of eligibility categories the player qualifies for
        (C, 1B, 2B, 3B, SS, OF, DH).  Does NOT include UTIL."""
        pg = rec.get("pos_games", {})
        eligible = set()
        for cat in ("C", "1B", "2B", "3B", "SS"):
            if pg.get(cat, 0) >= AC_POS_GAMES_MIN:
                eligible.add(cat)
        # Outfield: combined LF+CF+RF+OF >= 15 games
        if rec.get("of_games", 0) >= AC_POS_GAMES_MIN:
            eligible.add("OF")
        # DH: DH games must be at least AC_DH_MIN_SHARE (20%) of the games
        # in which the player appeared (fielding + DH). No minimum game count.
        dh_games = pg.get("DH", 0)
        total_def_games = sum(v for k, v in pg.items()
                              if k in {"C", "1B", "2B", "3B", "SS",
                                       "LF", "CF", "RF", "OF", "DH"})
        if dh_games > 0 and total_def_games > 0 \
                and (dh_games / total_def_games) >= AC_DH_MIN_SHARE:
            eligible.add("DH")
        return eligible

    def is_util_eligible(rec):
        """UTIL-eligible if any path applies:
          (a) Two-way player: 10+ IP AND 40+ PA.
          (b) 5+ games in the infield (excluding C) AND 5+ games in the
              outfield.
          (c) 5+ games at catcher AND 5+ games at another non-DH position
              (1B/2B/3B/SS/LF/CF/RF/OF).
        """
        pg = rec.get("pos_games", {})
        # (a) Two-way
        if rec["ip"] >= AC_UTIL_TWO_WAY_MIN_IP and rec["pa"] >= AC_UTIL_TWO_WAY_MIN_PA:
            return True
        # (b) IF (excluding C) and OF both >= threshold
        if_excl_c = rec["if_games"] - pg.get("C", 0)
        if if_excl_c >= AC_UTIL_FLEX_POS_GAMES and rec["of_games"] >= AC_UTIL_FLEX_POS_GAMES:
            return True
        # (c) Catcher plus another non-DH position
        c_games = pg.get("C", 0)
        if c_games >= AC_UTIL_FLEX_POS_GAMES:
            other_games = sum(v for k, v in pg.items()
                              if k in {"1B", "2B", "3B", "SS",
                                       "LF", "CF", "RF", "OF"})
            if other_games >= AC_UTIL_FLEX_POS_GAMES:
                return True
        return False

    # ── Primary role classification (one-role-per-player rule) ────
    # A player can only appear once on a conference page.  For two-way
    # guys (Donny Tober etc.) we pick whichever role's WAR is higher
    # and remove them from the other pool entirely.
    primary_role = {}  # pid -> "BAT" | "PIT" | None
    for pid, rec in players.items():
        b = bat_war(rec) if rec["pa"] > 0 else None
        p = pit_war(rec) if rec["ip"] > 0 else None
        if b is not None and p is not None:
            primary_role[pid] = "BAT" if b >= p else "PIT"
        elif b is not None:
            primary_role[pid] = "BAT"
        elif p is not None:
            primary_role[pid] = "PIT"
        else:
            primary_role[pid] = None

    # ── Build per-category candidate pools ────────────────────────
    # Each candidate is a (war_value, tiebreak_value, player_id) tuple.
    # Pools are keyed by CATEGORY (C/1B/2B/3B/SS/OF/DH/UTIL); slot-based
    # picks (OF1/OF2/OF3) all draw from the same OF pool.
    cat_candidates = {cat: [] for cat in AC_CATEGORIES}

    for pid, rec in players.items():
        if primary_role.get(pid) != "BAT":
            continue
        # Negative WAR: exclude entirely
        if bat_war(rec) < 0:
            continue
        # Rate mode: must be a qualified hitter to be in a hitter slot
        if rate_mode and not is_qualified_bat(rec):
            continue
        elig = eligible_categories(rec)
        for cat in elig:
            cat_candidates[cat].append((bat_war(rec), bat_tiebreak(rec), pid))
        if is_util_eligible(rec):
            # UTIL pool is ranked by TOTAL WAR (bat + pit) so two-way
            # players get credit for both sides of the ball. Non-two-way
            # UTIL candidates just get their bat_war (pit_war is 0).
            total_war = bat_war(rec)
            p_war = pit_war(rec) if rec.get("ip", 0) > 0 else 0
            if p_war:
                total_war = total_war + p_war
            cat_candidates["UTIL"].append((total_war, bat_tiebreak(rec), pid))

    # Sort each pool descending by war, then tiebreak
    for cat in cat_candidates:
        cat_candidates[cat].sort(key=lambda x: (x[0], x[1]), reverse=True)

    # ── Selection: greedy with combined-WAR swap ─────────────────
    # Build first team, then remove those players and repeat for second team,
    # then honorable mentions from the remainder.

    def select_team(candidates_by_cat, taken):
        """
        Assign one player per position slot, skipping anyone already taken.
        Slots map to categories (OF1/OF2/OF3 all draw from 'OF'), so the
        three outfield spots pick the top three eligible OF players.
        """
        # First pass: naive top pick per slot (excluding taken and players
        # already assigned to an earlier slot on this team)
        picks = {}
        for slot in AC_POSITION_SLOTS:
            cat = AC_SLOT_TO_CATEGORY[slot]
            for war_val, tb, pid in candidates_by_cat[cat]:
                if pid in taken:
                    continue
                if pid in picks.values():
                    continue
                picks[slot] = pid
                break

        # Swap pass: consider swaps between slots that would increase the
        # sum of WAR across both slots.
        def war_for(pid, slot):
            cat = AC_SLOT_TO_CATEGORY[slot]
            for war_val, tb, _pid in candidates_by_cat[cat]:
                if _pid == pid:
                    return war_val
            return None  # not eligible at this slot's category

        changed = True
        safety = 0
        while changed and safety < 3:
            changed = False
            safety += 1
            for i, slot_a in enumerate(AC_POSITION_SLOTS):
                for slot_b in AC_POSITION_SLOTS[i + 1:]:
                    pid_a = picks.get(slot_a)
                    pid_b = picks.get(slot_b)
                    if not pid_a or not pid_b:
                        continue
                    a_at_b = war_for(pid_a, slot_b)
                    b_at_a = war_for(pid_b, slot_a)
                    if a_at_b is None or b_at_a is None:
                        continue
                    current = (war_for(pid_a, slot_a) or 0) + (war_for(pid_b, slot_b) or 0)
                    swapped = a_at_b + b_at_a
                    if swapped > current + 1e-6:
                        picks[slot_a], picks[slot_b] = pid_b, pid_a
                        changed = True

        return picks

    first_picks = select_team(cat_candidates, taken=set())
    second_picks = select_team(cat_candidates, taken=set(first_picks.values()))

    # Honorable mentions: top 3 per category, with cross-category dedup
    # (a player can only appear once across all HM categories).
    already = set(first_picks.values()) | set(second_picks.values())
    hm_taken = set()  # players already used as HM somewhere
    honorable = {}
    for cat in AC_CATEGORIES:
        hm_list = []
        for war_val, tb, pid in cat_candidates[cat]:
            if pid in already:
                continue
            if pid in hm_taken:
                continue
            if pid in hm_list:
                continue
            hm_list.append(pid)
            hm_taken.add(pid)
            if len(hm_list) >= 3:
                break
        honorable[cat] = hm_list

    # ── Pitcher selection ────────────────────────────────────────
    # Starters: qualified pitchers, sorted by WAR (FIP tiebreak)
    # Reliever: IP >= 15 AND GS < 4, sorted by WAR/IP (rate) with FIP tiebreak
    # Both pools obey: primary_role == "PIT" and WAR > 0.
    starter_candidates = []
    reliever_candidates = []
    for pid, rec in players.items():
        if rec["ip"] <= 0:
            continue
        if primary_role.get(pid) != "PIT":
            continue
        # Negative pitching WAR: exclude entirely
        if pit_war(rec) < 0:
            continue
        # Starters must be qualified (always, even in non-rate mode)
        if is_qualified_pit(rec):
            starter_candidates.append((pit_war(rec), pit_tiebreak(rec), pid))
        # Reliever uses WAR/IP regardless of rate_mode
        if rec["ip"] >= AC_REL_MIN_IP and rec["gs"] < AC_REL_MAX_GS + 1:
            # Skip relievers with negative rate WAR too
            if rec["war_pit_rate"] < 0:
                continue
            reliever_candidates.append(
                (rec["war_pit_rate"], pit_tiebreak(rec), pid)
            )

    starter_candidates.sort(key=lambda x: (x[0], x[1]), reverse=True)
    reliever_candidates.sort(key=lambda x: (x[0], x[1]), reverse=True)

    def pick_n(pool, already_ids, n):
        picks = []
        for war_val, tb, pid in pool:
            if pid in already_ids:
                continue
            if pid in picks:
                continue
            picks.append(pid)
            if len(picks) >= n:
                break
        return picks

    first_sp = pick_n(starter_candidates, set(), 4)
    first_rp = pick_n(reliever_candidates, set(first_sp), 1)
    taken_pit = set(first_sp) | set(first_rp)

    second_sp = pick_n(starter_candidates, taken_pit, 4)
    taken_pit |= set(second_sp)
    second_rp = pick_n(reliever_candidates, taken_pit, 1)
    taken_pit |= set(second_rp)

    hm_sp = pick_n(starter_candidates, taken_pit, 3)
    taken_pit |= set(hm_sp)
    hm_rp = pick_n(reliever_candidates, taken_pit, 3)

    # ── Serialize output ─────────────────────────────────────────
    def serialize_hitter(pid, slot):
        rec = players[pid]
        pg = rec.get("pos_games", {})
        is_two_way = rec["ip"] >= AC_UTIL_TWO_WAY_MIN_IP and rec["pa"] >= AC_UTIL_TWO_WAY_MIN_PA
        out = {
            "player_id": pid,
            "name": rec["name"],
            "team_id": rec["team_id"],
            "team_short": rec["team_short"],
            "team_logo": rec["team_logo"],
            "conference": rec["conference_abbrev"],
            "division_level": rec["division_level"],
            "headshot_url": rec["headshot_url"],
            "slot": slot,
            "listed_position": rec["listed_position"],
            "pos_games": pg,
            "war": round(rec["war_bat"], 2),
            "war_rate": round(rec["war_bat_rate"], 4) if rec["pa"] > 0 else None,
            "wrc_plus": rec.get("wrc_plus"),
            "pa": int(rec["pa"]),
            "avg": rec.get("avg"),
            "obp": rec.get("obp"),
            "slg": rec.get("slg"),
            "ops": rec.get("ops"),
            "iso": rec.get("iso"),
            "woba": rec.get("woba"),
            "hr": rec.get("hr"),
            "sb": rec.get("sb"),
            "k_pct": rec.get("bat_k_pct"),
            "bb_pct": rec.get("bat_bb_pct"),
            "is_two_way": is_two_way,
        }
        # Include pitching info for two-way players (so UTIL/HM cards can show it)
        if is_two_way:
            out["pitching"] = {
                "ip": rec.get("ip"),
                "gs": rec.get("gs"),
                "era": rec.get("era"),
                "fip": rec.get("fip"),
                "fip_plus": rec.get("fip_plus"),
                "siera": rec.get("siera"),
                "war": round(rec["war_pit"], 2),
                "k": rec.get("k"),
                "bb": rec.get("bb"),
                "k_pct": rec.get("pit_k_pct"),
                "bb_pct": rec.get("pit_bb_pct"),
            }
        return out

    def serialize_pitcher(pid, role):
        rec = players[pid]
        return {
            "player_id": pid,
            "name": rec["name"],
            "team_id": rec["team_id"],
            "team_short": rec["team_short"],
            "team_logo": rec["team_logo"],
            "conference": rec["conference_abbrev"],
            "division_level": rec["division_level"],
            "headshot_url": rec["headshot_url"],
            "slot": role,
            "war": round(rec["war_pit"], 2),
            "war_rate": round(rec["war_pit_rate"], 4) if rec["ip"] > 0 else None,
            "fip": rec.get("fip"),
            "fip_plus": rec.get("fip_plus"),
            "era": rec.get("era"),
            "whip": rec.get("whip"),
            "siera": rec.get("siera"),
            "ip": rec.get("ip"),
            "k": rec.get("k"),
            "bb": rec.get("bb"),
            "k_pct": rec.get("pit_k_pct"),
            "bb_pct": rec.get("pit_bb_pct"),
            "gs": rec.get("gs"),
        }

    def build_team_obj(hitter_picks, sp_list, rp_list):
        out = {}
        for slot, pid in hitter_picks.items():
            out[slot] = serialize_hitter(pid, slot) if pid else None
        for i, pid in enumerate(sp_list, start=1):
            out[f"SP{i}"] = serialize_pitcher(pid, f"SP{i}")
        # pad to 4 SPs
        for i in range(len(sp_list) + 1, 5):
            out[f"SP{i}"] = None
        out["RP"] = serialize_pitcher(rp_list[0], "RP") if rp_list else None
        return out

    first_team = build_team_obj(first_picks, first_sp, first_rp)
    second_team = build_team_obj(second_picks, second_sp, second_rp)

    # HM is keyed by CATEGORY (C/1B/2B/3B/SS/OF/DH/UTIL) so OF is one
    # combined list rather than three slot-specific lists.
    hm_out = {}
    for cat in AC_CATEGORIES:
        hm_out[cat] = [serialize_hitter(pid, cat) for pid in honorable[cat]]
    hm_out["SP"] = [serialize_pitcher(pid, "SP") for pid in hm_sp]
    hm_out["RP"] = [serialize_pitcher(pid, "RP") for pid in hm_rp]

    # ── Awards (MVP, HoY, PoY, Transfer of Year, Freshman of Year) ──
    # Awards rank all players in the conference by their total WAR
    # (bat_war + pit_war for two-way guys).  The five awards are
    # mutually exclusive so each goes to a different player.
    FRESHMAN_YEARS = {"Fr", "R-Fr"}

    def award_total_war(rec):
        # Combine both sides of the ball for two-way players so
        # dominant two-way guys can win MVP off pure total value.
        b = rec["war_bat"] if rec["pa"] > 0 else 0
        p = rec["war_pit"] if rec["ip"] > 0 else 0
        return b + p

    def is_freshman(rec):
        y = rec.get("year_in_school")
        return y in FRESHMAN_YEARS

    def is_transfer(rec):
        # First-year at current program AND not a freshman.
        if is_freshman(rec):
            return False
        first_season = first_season_by_pid_team.get(
            (rec["player_id"], rec["team_id"])
        )
        return first_season == season

    # Sort all players by MVP-style total WAR descending
    award_ranked = sorted(
        [(pid, rec, award_total_war(rec)) for pid, rec in players.items()
         if award_total_war(rec) > 0],
        key=lambda x: x[2],
        reverse=True,
    )

    def find_award(predicate, taken):
        for pid, rec, war in award_ranked:
            if pid in taken:
                continue
            if predicate(pid, rec):
                return pid
        return None

    taken_awards = set()

    # MVP: top total WAR, any role
    mvp_pid = find_award(lambda pid, rec: True, taken_awards)
    if mvp_pid:
        taken_awards.add(mvp_pid)

    # Hitter of the Year: best qualified hitter by wRC+ (primary_role == BAT,
    # not already MVP). Uses wRC+ instead of total WAR because this award
    # rewards offensive rate performance — WAR bundles playing time and
    # baserunning that the wider MVP award already captures.
    hoy_candidates = sorted(
        [
            (pid, rec) for pid, rec in players.items()
            if primary_role.get(pid) == "BAT"
            and is_qualified_bat(rec)
            and rec.get("wrc_plus") is not None
        ],
        key=lambda x: (x[1]["wrc_plus"], x[1]["pa"]),
        reverse=True,
    )
    hoy_pid = None
    for pid, _rec in hoy_candidates:
        if pid in taken_awards:
            continue
        hoy_pid = pid
        break
    if hoy_pid:
        taken_awards.add(hoy_pid)

    # Pitcher of the Year: best non-MVP pitcher
    # Ranking by total WAR matches the MVP ordering, which is fine —
    # a two-way guy wins PoY only if their pitching WAR alone still
    # ranks them higher than all other pitchers' pitching WAR.
    def pitcher_war_only(rec):
        return rec["war_pit"] if rec["ip"] > 0 else 0

    pitchers_ranked = sorted(
        [(pid, rec) for pid, rec in players.items()
         if pitcher_war_only(rec) > 0 and primary_role.get(pid) == "PIT"],
        key=lambda x: pitcher_war_only(x[1]),
        reverse=True,
    )
    poy_pid = None
    for pid, rec in pitchers_ranked:
        if pid in taken_awards:
            continue
        poy_pid = pid
        break
    if poy_pid:
        taken_awards.add(poy_pid)

    # NWAC is a 2-year JUCO league: nearly every roster spot is a
    # freshman or a transfer, so Transfer-of-the-Year and Freshman-of-
    # the-Year don't carry meaningful signal there. Skip them for any
    # NWAC divisional team and for the All-NWAC aggregate.
    skip_class_awards = conf.startswith("nwac-") or conf == "all-nwac"

    transfer_pid = None
    freshman_pid = None
    if not skip_class_awards:
        # Transfer of the Year: first-year at program, not freshman
        transfer_pid = find_award(
            lambda pid, rec: is_transfer(rec),
            taken_awards,
        )
        if transfer_pid:
            taken_awards.add(transfer_pid)

        # Freshman of the Year: Fr/R-Fr with the most WAR
        freshman_pid = find_award(
            lambda pid, rec: is_freshman(rec),
            taken_awards,
        )
        if freshman_pid:
            taken_awards.add(freshman_pid)

    def serialize_award(pid):
        if not pid:
            return None
        rec = players[pid]
        # Pick a position label: the player's first_team slot if they
        # landed on the first team, else their listed_position, else
        # role-based fallback.
        slot = None
        for s, p in first_picks.items():
            if p == pid:
                slot = s
                break
        if not slot:
            for s, p in second_picks.items():
                if p == pid:
                    slot = s
                    break
        if not slot:
            if pid in first_sp or pid in second_sp:
                slot = "SP"
            elif pid in first_rp or pid in second_rp:
                slot = "RP"
            elif primary_role.get(pid) == "PIT":
                slot = "P"
            else:
                slot = rec.get("listed_position") or "UTIL"
        return {
            "player_id": pid,
            "name": rec["name"],
            "team_id": rec["team_id"],
            "team_short": rec["team_short"],
            "team_logo": rec["team_logo"],
            "conference": rec["conference_abbrev"],
            "division_level": rec["division_level"],
            "headshot_url": rec["headshot_url"],
            "position": slot,
            "year_in_school": rec.get("year_in_school"),
        }

    awards = {
        "mvp": serialize_award(mvp_pid),
        "hitter_of_year": serialize_award(hoy_pid),
        "pitcher_of_year": serialize_award(poy_pid),
        "transfer_of_year": serialize_award(transfer_pid),
        "freshman_of_year": serialize_award(freshman_pid),
    }

    return {
        "conf": conf,
        "label": group["label"],
        "season": season,
        "rate_mode": rate_mode,
        "team_count": len(team_ids),
        "teams": [
            {"id": t["id"], "name": t["name"], "short_name": t["short_name"],
             "logo_url": t["logo_url"], "conference_abbrev": t["conference_abbrev"]}
            for t in teams_by_id.values()
        ],
        "first_team": first_team,
        "second_team": second_team,
        "honorable_mentions": hm_out,
        "awards": awards,
        "frozen": is_frozen,
        "frozen_at": freeze["frozen_at"].isoformat() if is_frozen else None,
        "regular_season_end_date": (
            freeze["regular_season_end_date"].isoformat() if is_frozen else None
        ),
    }


# ── Historic Matchup (Coaching Tool) ────────────────────────────────────
#
# Returns aggregated batting + pitching player stats from every game played
# between two teams in a given season, plus a list of those games (scores,
# location, W/L/S decisions). Used by the "Historic" page in the Coaching
# tab to show how a team's players performed against a specific opponent.


# In-process cache for league constants. Keyed by (season, division_level).
# Constants change slowly relative to request rate, and recomputing them
# requires two SUMs over batting_stats/pitching_stats — fine to compute
# on-demand the first time for a given season+division and reuse after.
_LEAGUE_CONSTANTS_CACHE: dict = {}


def _get_league_constants(cur, season: int, division_level: str) -> dict:
    """Return league constants for a given division+season needed to compute
    advanced stats (FIP, wOBA, wRC+, etc.). Mirrors the multi-year run
    environment used by scripts/recalculate_league_adjusted.py — averages
    across 2022 through `season`, which keeps the FIP constant stable
    early in the year.
    """
    key = (season, division_level)
    if key in _LEAGUE_CONSTANTS_CACHE:
        return _LEAGUE_CONSTANTS_CACHE[key]

    # Batting aggregates for the division.
    cur.execute("""
        SELECT SUM(bs.plate_appearances) AS total_pa,
               SUM(bs.at_bats) AS total_ab,
               SUM(bs.hits) AS total_h,
               SUM(bs.doubles) AS total_2b,
               SUM(bs.triples) AS total_3b,
               SUM(bs.home_runs) AS total_hr,
               SUM(bs.runs) AS total_r,
               SUM(bs.walks) AS total_bb,
               SUM(bs.intentional_walks) AS total_ibb,
               SUM(bs.strikeouts) AS total_k,
               SUM(bs.hit_by_pitch) AS total_hbp,
               SUM(bs.sacrifice_flies) AS total_sf
        FROM batting_stats bs
        JOIN teams t ON bs.team_id = t.id
        JOIN conferences c ON t.conference_id = c.id
        JOIN divisions d ON c.division_id = d.id
        WHERE bs.season BETWEEN 2022 AND %s
          AND d.level = %s
          AND bs.plate_appearances >= 5
    """, (season, division_level))
    bat = cur.fetchone()

    cur.execute("""
        SELECT (SUM(ip_outs(ps.innings_pitched)) / 3.0)::float8 AS total_ip,
               SUM(ps.earned_runs) AS total_er,
               SUM(ps.hits_allowed) AS total_h,
               SUM(ps.walks) AS total_bb,
               SUM(ps.strikeouts) AS total_k,
               SUM(ps.home_runs_allowed) AS total_hr,
               SUM(ps.hit_batters) AS total_hbp
        FROM pitching_stats ps
        JOIN teams t ON ps.team_id = t.id
        JOIN conferences c ON t.conference_id = c.id
        JOIN divisions d ON c.division_id = d.id
        WHERE ps.season BETWEEN 2022 AND %s
          AND d.level = %s
          AND ps.innings_pitched >= 1
    """, (season, division_level))
    pit = cur.fetchone()

    weights = DEFAULT_WEIGHTS.get(division_level, DEFAULT_WEIGHTS["D1"])

    # Defaults if a division has no rows yet (e.g. season too early).
    fallback = {
        "lg_avg": 0.270, "lg_obp": 0.350, "lg_slg": 0.400,
        "lg_woba": 0.320, "lg_r_per_pa": weights.runs_per_pa,
        "lg_era": 4.50, "lg_fip": 4.20, "fip_constant": 3.10,
        "weights": weights, "division_level": division_level,
    }
    if not bat or not bat.get("total_pa") or not pit or not pit.get("total_ip"):
        _LEAGUE_CONSTANTS_CACHE[key] = fallback
        return fallback

    total_pa = bat["total_pa"] or 1
    total_ab = bat["total_ab"] or 1
    total_ip = pit["total_ip"] or 1

    lg_h = bat["total_h"] or 0
    lg_2b = bat["total_2b"] or 0
    lg_3b = bat["total_3b"] or 0
    lg_hr = bat["total_hr"] or 0
    lg_1b = lg_h - lg_2b - lg_3b - lg_hr
    lg_bb = bat["total_bb"] or 0
    lg_ibb = bat["total_ibb"] or 0
    lg_ubb = lg_bb - lg_ibb
    lg_hbp = bat["total_hbp"] or 0
    lg_sf = bat["total_sf"] or 0
    lg_runs = bat["total_r"] or 0

    lg_avg = lg_h / total_ab
    lg_obp = (lg_h + lg_bb + lg_hbp) / (total_ab + lg_bb + lg_hbp + lg_sf)
    lg_tb = lg_1b + 2 * lg_2b + 3 * lg_3b + 4 * lg_hr
    lg_slg = lg_tb / total_ab
    lg_r_per_pa = lg_runs / total_pa

    woba_num = (
        weights.w_bb * lg_ubb
        + weights.w_hbp * lg_hbp
        + weights.w_1b * lg_1b
        + weights.w_2b * lg_2b
        + weights.w_3b * lg_3b
        + weights.w_hr * lg_hr
    )
    woba_denom = total_ab + lg_ubb + lg_sf + lg_hbp
    lg_woba = woba_num / woba_denom if woba_denom > 0 else 0.320

    pit_er = pit["total_er"] or 0
    pit_bb = pit["total_bb"] or 0
    pit_k = pit["total_k"] or 0
    pit_hr = pit["total_hr"] or 0
    pit_hbp = pit["total_hbp"] or 0

    lg_era = (pit_er * 9) / total_ip if total_ip > 0 else 4.50

    fip_const = compute_fip_constant(
        league_era=lg_era,
        league_hr=pit_hr,
        league_bb=pit_bb,
        league_hbp=pit_hbp,
        league_k=pit_k,
        league_ip=total_ip,
    )

    ip_decimal = innings_to_outs(total_ip) / 3.0 if total_ip else 1
    lg_fip = (
        (13 * pit_hr + 3 * (pit_bb + pit_hbp) - 2 * pit_k) / ip_decimal
    ) + fip_const

    constants = {
        "lg_avg": lg_avg,
        "lg_obp": lg_obp,
        "lg_slg": lg_slg,
        "lg_woba": lg_woba,
        "lg_r_per_pa": lg_r_per_pa,
        "lg_era": lg_era,
        "lg_fip": lg_fip,
        "fip_constant": fip_const,
        "weights": weights,
        "division_level": division_level,
    }
    _LEAGUE_CONSTANTS_CACHE[key] = constants
    return constants


