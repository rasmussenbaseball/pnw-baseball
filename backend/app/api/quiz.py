"""
Team Quiz API endpoints.

Generates trivia questions for a given team + season(s). Each request
returns one or more randomly generated questions drawn from a pool of
templates. The frontend builds a 10 question quiz by calling the bulk
endpoint once.

Question types (served so far):
  - multiple_choice: pick 1 of 4 player options

Coming later:
  - type_in: user types a player name (with search autocomplete)
  - match:   pair 4 players to 4 stat values

Leader minimums (displayed to the user on the question):
  - Pitching leader questions: >= 20.0 IP
  - Hitter rate stat leaders:  >= 2.0 PA per team game played

Counting stat leaders (HR, RBI, hits, etc.) have no per-player minimum
since a counting leader already has a meaningful workload by definition.
"""

import random
from typing import Optional, List, Callable, Dict, Any
from fastapi import APIRouter, Query, HTTPException

from ..models.database import get_connection

quiz_router = APIRouter(prefix="/quiz", tags=["quiz"])

# ── Constants ────────────────────────────────────────────────

MIN_PITCHER_IP = 20.0
MIN_BATTER_PA_PER_GAME = 2.0

PITCHER_MIN_SUBTITLE = f"(minimum {int(MIN_PITCHER_IP)} IP)"
BATTER_RATE_SUBTITLE = "(minimum 2 PA per team game)"


# ── Shared helpers ───────────────────────────────────────────

def _player_label(row) -> str:
    first = (row.get("first_name") or "").strip()
    last = (row.get("last_name") or "").strip()
    return f"{first} {last}".strip() or "Unknown"


def _team_name(cur, team_id: int) -> str:
    cur.execute("SELECT short_name FROM teams WHERE id = %s", (team_id,))
    row = cur.fetchone()
    return row["short_name"] if row else f"Team {team_id}"


def _team_games_played(cur, team_id: int, season: int) -> int:
    """Return the team's games played for the season.

    NWAC game rows aren't always in the `games` table, so if that count
    is 0 we fall back to the largest per-player `games` value from
    batting_stats. That is always a valid lower bound on team games
    and is accurate within 1-2 for teams with at least one near-everyday
    player (which is effectively every team).
    """
    cur.execute(
        """
        SELECT COUNT(DISTINCT g.id) AS gp
        FROM games g
        WHERE g.season = %s
          AND (g.home_team_id = %s OR g.away_team_id = %s)
        """,
        (season, team_id, team_id),
    )
    row = cur.fetchone()
    gp = int(row["gp"] or 0) if row else 0
    if gp > 0:
        return gp
    cur.execute(
        """
        SELECT COALESCE(MAX(games), 0) AS gp
        FROM batting_stats
        WHERE team_id = %s AND season = %s
        """,
        (team_id, season),
    )
    row = cur.fetchone()
    return int(row["gp"] or 0) if row else 0


def _top_hitters(
    cur,
    team_id: int,
    season: int,
    stat_col: str,
    order: str = "DESC",
    limit: int = 6,
    require_rate_qualified: bool = False,
) -> List[dict]:
    """Pull top N hitters by a stat column. If require_rate_qualified,
    filter to PA >= 2 * team games played."""
    params: List[Any] = [team_id, season]
    qual_clause = ""
    if require_rate_qualified:
        tg = _team_games_played(cur, team_id, season)
        min_pa = int(MIN_BATTER_PA_PER_GAME * tg)
        qual_clause = " AND bs.plate_appearances >= %s"
        params.append(min_pa)
    params.append(limit)
    cur.execute(
        f"""
        SELECT bs.player_id, bs.{stat_col} AS stat_val,
               bs.plate_appearances, bs.games, bs.at_bats, bs.hits,
               bs.home_runs, bs.rbi, bs.batting_avg, bs.on_base_pct,
               bs.slugging_pct, bs.wrc_plus, bs.offensive_war,
               p.first_name, p.last_name
        FROM batting_stats bs
        JOIN players p ON p.id = bs.player_id
        WHERE bs.team_id = %s AND bs.season = %s
          AND bs.{stat_col} IS NOT NULL
          {qual_clause}
        ORDER BY bs.{stat_col} {order} NULLS LAST,
                 bs.plate_appearances DESC NULLS LAST
        LIMIT %s
        """,
        params,
    )
    return [dict(r) for r in cur.fetchall()]


def _top_pitchers(
    cur,
    team_id: int,
    season: int,
    stat_col: str,
    order: str = "DESC",
    limit: int = 6,
    require_ip_qualified: bool = False,
) -> List[dict]:
    """Pull top N pitchers by a stat column. If require_ip_qualified,
    filter to IP >= 20.0 (baseball notation, but 20.0 compares fine
    numerically)."""
    params: List[Any] = [team_id, season]
    qual_clause = ""
    if require_ip_qualified:
        qual_clause = " AND ps.innings_pitched >= %s"
        params.append(MIN_PITCHER_IP)
    params.append(limit)
    cur.execute(
        f"""
        SELECT ps.player_id, ps.{stat_col} AS stat_val,
               ps.innings_pitched, ps.games, ps.games_started,
               ps.wins, ps.losses, ps.saves, ps.strikeouts, ps.walks,
               ps.era, ps.whip, ps.fip, ps.pitching_war,
               p.first_name, p.last_name
        FROM pitching_stats ps
        JOIN players p ON p.id = ps.player_id
        WHERE ps.team_id = %s AND ps.season = %s
          AND ps.{stat_col} IS NOT NULL
          {qual_clause}
        ORDER BY ps.{stat_col} {order} NULLS LAST,
                 ps.innings_pitched DESC NULLS LAST
        LIMIT %s
        """,
        params,
    )
    return [dict(r) for r in cur.fetchall()]


def _build_mc_from_sorted(
    rows: List[dict],
    stat_key: str,
    answer_position: int = 0,
    template_id: str = "",
    prompt: str = "",
    subtitle: Optional[str] = None,
    explanation_fmt: Callable[[dict, dict], str] = None,
    team_id: int = 0,
    season: int = 0,
) -> Optional[dict]:
    """Given a sorted list of rows, build a multiple choice question
    where the correct answer is the row at `answer_position`, and
    distractors are drawn from other top rows (preferring rows with
    distinct stat values so no two options share the same number)."""
    # Dedupe by stat value so no two options share the same number.
    seen_vals = set()
    unique: List[dict] = []
    for r in rows:
        v = r["stat_val"]
        # Treat None as a dealbreaker for this row.
        if v is None:
            continue
        key = float(v)
        if key in seen_vals:
            continue
        seen_vals.add(key)
        unique.append(r)

    if answer_position >= len(unique):
        return None
    if len(unique) < 4:
        return None

    answer_row = unique[answer_position]
    other_rows = [r for i, r in enumerate(unique) if i != answer_position]
    # Prefer spread-out distractors: if answering position 0, we want
    # distractors at roughly positions 1, 3, 5. If answering position 1,
    # we want 0, 3, 5, etc.
    preferred_offsets = [0, 2, 4]
    distractors: List[dict] = []
    for off in preferred_offsets:
        if off < len(other_rows):
            distractors.append(other_rows[off])
    for r in other_rows:
        if len(distractors) >= 3:
            break
        if r not in distractors:
            distractors.append(r)
    distractors = distractors[:3]
    if len(distractors) < 3:
        return None

    options_raw = [answer_row] + distractors
    random.shuffle(options_raw)
    option_ids = ["a", "b", "c", "d"]
    options = []
    answer_id = None
    for letter, r in zip(option_ids, options_raw):
        options.append({"id": letter, "label": _player_label(r)})
        if r["player_id"] == answer_row["player_id"]:
            answer_id = letter

    explanation = (
        explanation_fmt(answer_row, answer_row) if explanation_fmt
        else f"{_player_label(answer_row)}: {answer_row['stat_val']}"
    )
    return {
        "id": f"{template_id}_{team_id}_{season}_{random.randint(1000, 9999)}",
        "template_id": template_id,
        "type": "multiple_choice",
        "prompt": prompt,
        "subtitle": subtitle,
        "options": options,
        "answer": answer_id,
        "explanation": explanation,
        "_player_ids": [answer_row["player_id"]],
    }


# ── Formatting helpers for explanations ──────────────────────

def _fmt_int(v) -> str:
    try:
        return str(int(v))
    except (TypeError, ValueError):
        return "?"


def _fmt_avg(v) -> str:
    """Slash-line style: .385 not 0.385."""
    try:
        f = float(v)
        s = f"{f:.3f}"
        return s[1:] if s.startswith("0") else s
    except (TypeError, ValueError):
        return "?"


def _fmt_2dec(v) -> str:
    try:
        return f"{float(v):.2f}"
    except (TypeError, ValueError):
        return "?"


def _fmt_ip(v) -> str:
    """IP is stored in baseball notation; display as-is with one decimal."""
    try:
        return f"{float(v):.1f}"
    except (TypeError, ValueError):
        return "?"


# ── Match (Format 3) builder ─────────────────────────────────

def _build_match(
    rows: List[dict],
    *,
    template_id: str,
    prompt: str,
    subtitle: Optional[str],
    value_formatter: Callable[[Any], str],
    value_suffix: str = "",
    team_id: int = 0,
    season: int = 0,
) -> Optional[dict]:
    """Build a match-4 question. Takes a sorted list of candidate rows,
    dedupes by stat value, takes the top 4, and emits a payload the
    frontend can render as two shuffled columns.

    Returns None if there aren't 4 qualified players with distinct
    stat values for this team/season.
    """
    seen = set()
    unique: List[dict] = []
    for r in rows:
        v = r["stat_val"]
        if v is None:
            continue
        key = float(v)
        if key in seen:
            continue
        seen.add(key)
        unique.append(r)
        if len(unique) == 4:
            break
    if len(unique) < 4:
        return None

    # Build player + value lists, assign stable ids, then shuffle both
    # columns independently so the correct pairing isn't visible.
    players_ordered = [
        {"id": f"p{i+1}", "label": _player_label(r), "player_id": r["player_id"]}
        for i, r in enumerate(unique)
    ]
    values_ordered = [
        {"id": f"v{i+1}", "label": f"{value_formatter(r['stat_val'])}{value_suffix}"}
        for i, r in enumerate(unique)
    ]
    answer = {p["id"]: v["id"] for p, v in zip(players_ordered, values_ordered)}

    players_shuffled = list(players_ordered)
    values_shuffled = list(values_ordered)
    random.shuffle(players_shuffled)
    random.shuffle(values_shuffled)
    # Strip internal player_id before returning (don't leak DB ids)
    players_shuffled = [
        {"id": p["id"], "label": p["label"]} for p in players_shuffled
    ]

    return {
        "id": f"{template_id}_{team_id}_{season}_{random.randint(1000, 9999)}",
        "template_id": template_id,
        "type": "match",
        "prompt": prompt,
        "subtitle": subtitle,
        "players": players_shuffled,
        "values": values_shuffled,
        "answer": answer,
        "_player_ids": [r["player_id"] for r in unique],
    }


def _match_q(
    cur, team_id: int, season: int, *, kind: str, column: str, label: str,
    template_id: str, order: str = "DESC",
    subtitle: Optional[str] = None,
    value_formatter: Callable = _fmt_int,
    value_suffix: str = "",
) -> Optional[dict]:
    """Generic match-4 builder. Always pulls from qualified players only
    (20 IP for pitchers, 2 PA per team game for hitters)."""
    team = _team_name(cur, team_id)
    if kind == "bat":
        rows = _top_hitters(cur, team_id, season, column, order=order,
                            limit=8, require_rate_qualified=True)
    else:
        rows = _top_pitchers(cur, team_id, season, column, order=order,
                             limit=8, require_ip_qualified=True)
    prompt = f"Match each {team} player to their {label} in {season}."
    return _build_match(
        rows, template_id=template_id, prompt=prompt, subtitle=subtitle,
        value_formatter=value_formatter, value_suffix=value_suffix,
        team_id=team_id, season=season,
    )


# ── Question template registry ───────────────────────────────
#
# Each template returns a question dict or None if the team/season
# doesn't have enough data to build a valid question.

def _q(
    cur, team_id: int, season: int, *, kind: str, column: str, label: str,
    template_id: str, order: str = "DESC", subtitle: Optional[str] = None,
    qualified: bool = False, answer_position: int = 0,
    value_formatter: Callable = _fmt_int,
) -> Optional[dict]:
    """Build a generic 'who led / who finished Nth in X' question."""
    team = _team_name(cur, team_id)
    if kind == "bat":
        rows = _top_hitters(cur, team_id, season, column, order=order,
                            require_rate_qualified=qualified)
    else:
        rows = _top_pitchers(cur, team_id, season, column, order=order,
                             require_ip_qualified=qualified)

    place_word = {0: "led", 1: "finished second on", 2: "finished third on"}.get(
        answer_position, f"finished {answer_position + 1}th on"
    )
    if answer_position == 0:
        prompt_core = f"Who led {team} in {label} in {season}?"
    else:
        ord_word = {1: "second", 2: "third"}.get(answer_position,
                                                  f"{answer_position + 1}th")
        prompt_core = (
            f"Who finished {ord_word} in {label} on {team} in {season}?"
        )

    def explain(answer_row, _leader):
        v = value_formatter(answer_row["stat_val"])
        return f"{_player_label(answer_row)}: {v} {label}."

    return _build_mc_from_sorted(
        rows, stat_key=column, answer_position=answer_position,
        template_id=template_id, prompt=prompt_core,
        subtitle=subtitle, explanation_fmt=explain,
        team_id=team_id, season=season,
    )


# ── Template functions ───────────────────────────────────────
# Each one takes (cur, team_id, season) and returns a question dict
# or None if it can't build one for that team/season.

# Format 1: Who led (batting, counting stats — no minimum)

def t_leader_hr(cur, team_id, season):
    return _q(cur, team_id, season, kind="bat", column="home_runs",
              label="home runs", template_id="leader_hr",
              value_formatter=_fmt_int)

def t_leader_rbi(cur, team_id, season):
    return _q(cur, team_id, season, kind="bat", column="rbi",
              label="RBI", template_id="leader_rbi",
              value_formatter=_fmt_int)

def t_leader_hits(cur, team_id, season):
    return _q(cur, team_id, season, kind="bat", column="hits",
              label="hits", template_id="leader_hits",
              value_formatter=_fmt_int)

def t_leader_doubles(cur, team_id, season):
    return _q(cur, team_id, season, kind="bat", column="doubles",
              label="doubles", template_id="leader_doubles",
              value_formatter=_fmt_int)

def t_leader_triples(cur, team_id, season):
    return _q(cur, team_id, season, kind="bat", column="triples",
              label="triples", template_id="leader_triples",
              value_formatter=_fmt_int)

def t_leader_sb(cur, team_id, season):
    return _q(cur, team_id, season, kind="bat", column="stolen_bases",
              label="stolen bases", template_id="leader_sb",
              value_formatter=_fmt_int)

def t_leader_walks(cur, team_id, season):
    return _q(cur, team_id, season, kind="bat", column="walks",
              label="walks drawn", template_id="leader_walks",
              value_formatter=_fmt_int)

def t_leader_runs(cur, team_id, season):
    return _q(cur, team_id, season, kind="bat", column="runs",
              label="runs scored", template_id="leader_runs",
              value_formatter=_fmt_int)

def t_leader_pa(cur, team_id, season):
    return _q(cur, team_id, season, kind="bat", column="plate_appearances",
              label="plate appearances", template_id="leader_pa",
              value_formatter=_fmt_int)

def t_leader_owar(cur, team_id, season):
    # offensive WAR is a counting stat; no min needed
    return _q(cur, team_id, season, kind="bat", column="offensive_war",
              label="offensive WAR", template_id="leader_owar",
              value_formatter=_fmt_2dec)

# Format 1: Who led (batting, rate stats — min 2 PA / team game)

def t_leader_avg(cur, team_id, season):
    return _q(cur, team_id, season, kind="bat", column="batting_avg",
              label="batting average", template_id="leader_avg",
              subtitle=BATTER_RATE_SUBTITLE, qualified=True,
              value_formatter=_fmt_avg)

def t_leader_obp(cur, team_id, season):
    return _q(cur, team_id, season, kind="bat", column="on_base_pct",
              label="on-base percentage", template_id="leader_obp",
              subtitle=BATTER_RATE_SUBTITLE, qualified=True,
              value_formatter=_fmt_avg)

def t_leader_slg(cur, team_id, season):
    return _q(cur, team_id, season, kind="bat", column="slugging_pct",
              label="slugging percentage", template_id="leader_slg",
              subtitle=BATTER_RATE_SUBTITLE, qualified=True,
              value_formatter=_fmt_avg)

def t_leader_wrcplus(cur, team_id, season):
    return _q(cur, team_id, season, kind="bat", column="wrc_plus",
              label="wRC+", template_id="leader_wrcplus",
              subtitle=BATTER_RATE_SUBTITLE, qualified=True,
              value_formatter=_fmt_int)

# Format 1: Who led (pitching)

def t_leader_ip(cur, team_id, season):
    # IP is itself a counting stat, no "20 IP" threshold applied here
    # since the leader will always clear it.
    return _q(cur, team_id, season, kind="pit", column="innings_pitched",
              label="innings pitched", template_id="leader_ip",
              value_formatter=_fmt_ip)

def t_leader_k(cur, team_id, season):
    return _q(cur, team_id, season, kind="pit", column="strikeouts",
              label="strikeouts", template_id="leader_k",
              value_formatter=_fmt_int)

def t_leader_wins(cur, team_id, season):
    return _q(cur, team_id, season, kind="pit", column="wins",
              label="wins", template_id="leader_wins",
              value_formatter=_fmt_int)

def t_leader_saves(cur, team_id, season):
    return _q(cur, team_id, season, kind="pit", column="saves",
              label="saves", template_id="leader_saves",
              value_formatter=_fmt_int)

def t_leader_gs(cur, team_id, season):
    return _q(cur, team_id, season, kind="pit", column="games_started",
              label="games started", template_id="leader_gs",
              value_formatter=_fmt_int)

def t_leader_pwar(cur, team_id, season):
    return _q(cur, team_id, season, kind="pit", column="pitching_war",
              label="pitching WAR", template_id="leader_pwar",
              value_formatter=_fmt_2dec)

def t_leader_era(cur, team_id, season):
    return _q(cur, team_id, season, kind="pit", column="era",
              label="ERA", template_id="leader_era",
              subtitle=PITCHER_MIN_SUBTITLE, qualified=True, order="ASC",
              value_formatter=_fmt_2dec)

# Format 2: Who finished second (a subset, to keep variety)

def t_second_hr(cur, team_id, season):
    return _q(cur, team_id, season, kind="bat", column="home_runs",
              label="home runs", template_id="second_hr",
              answer_position=1, value_formatter=_fmt_int)

def t_second_era(cur, team_id, season):
    return _q(cur, team_id, season, kind="pit", column="era",
              label="ERA", template_id="second_era",
              subtitle=PITCHER_MIN_SUBTITLE, qualified=True, order="ASC",
              answer_position=1, value_formatter=_fmt_2dec)

def t_second_pwar(cur, team_id, season):
    return _q(cur, team_id, season, kind="pit", column="pitching_war",
              label="pitching WAR", template_id="second_pwar",
              answer_position=1, value_formatter=_fmt_2dec)

def t_second_k(cur, team_id, season):
    return _q(cur, team_id, season, kind="pit", column="strikeouts",
              label="strikeouts", template_id="second_k",
              answer_position=1, value_formatter=_fmt_int)


# Format 3: Match 4 players to 4 stat values. Qualified pool only —
# hitters need 2 PA per team game, pitchers need 20 IP.

def t_match_hr(cur, team_id, season):
    return _match_q(cur, team_id, season, kind="bat", column="home_runs",
                    label="home run total", template_id="match_hr",
                    subtitle=BATTER_RATE_SUBTITLE, value_formatter=_fmt_int,
                    value_suffix=" HR")

def t_match_rbi(cur, team_id, season):
    return _match_q(cur, team_id, season, kind="bat", column="rbi",
                    label="RBI total", template_id="match_rbi",
                    subtitle=BATTER_RATE_SUBTITLE, value_formatter=_fmt_int,
                    value_suffix=" RBI")

def t_match_ba(cur, team_id, season):
    return _match_q(cur, team_id, season, kind="bat", column="batting_avg",
                    label="batting average", template_id="match_ba",
                    subtitle=BATTER_RATE_SUBTITLE, value_formatter=_fmt_avg)

def t_match_owar(cur, team_id, season):
    return _match_q(cur, team_id, season, kind="bat", column="offensive_war",
                    label="offensive WAR", template_id="match_owar",
                    subtitle=BATTER_RATE_SUBTITLE, value_formatter=_fmt_2dec)

def t_match_era(cur, team_id, season):
    return _match_q(cur, team_id, season, kind="pit", column="era",
                    label="ERA", template_id="match_era", order="ASC",
                    subtitle=PITCHER_MIN_SUBTITLE, value_formatter=_fmt_2dec)

def t_match_ip(cur, team_id, season):
    return _match_q(cur, team_id, season, kind="pit", column="innings_pitched",
                    label="innings pitched total", template_id="match_ip",
                    subtitle=PITCHER_MIN_SUBTITLE, value_formatter=_fmt_ip,
                    value_suffix=" IP")

def t_match_k(cur, team_id, season):
    return _match_q(cur, team_id, season, kind="pit", column="strikeouts",
                    label="strikeout total", template_id="match_k",
                    subtitle=PITCHER_MIN_SUBTITLE, value_formatter=_fmt_int,
                    value_suffix=" K")

def t_match_wins(cur, team_id, season):
    return _match_q(cur, team_id, season, kind="pit", column="wins",
                    label="win total", template_id="match_wins",
                    subtitle=PITCHER_MIN_SUBTITLE, value_formatter=_fmt_int,
                    value_suffix=" W")


# ── Format 3b: Match players to full statlines ───────────────
# Same match-4 shape as Format 3, but the "values" are complete
# statlines (slash + HR/RBI for hitters, W-L + ERA/IP/K for
# pitchers) instead of a single stat.

def _build_statline_match(
    players: List[dict],
    *,
    statline_fn: Callable[[dict], str],
    template_id: str,
    prompt: str,
    subtitle: Optional[str],
    team_id: int,
    season: int,
) -> Optional[dict]:
    """Build a match-4 question where each 'value' is a full statline."""
    seen_lines = set()
    unique: List[dict] = []
    for r in players:
        line = statline_fn(r)
        if line in seen_lines:
            continue
        seen_lines.add(line)
        unique.append(r)
        if len(unique) == 4:
            break
    if len(unique) < 4:
        return None

    players_ordered = [
        {"id": f"p{i+1}", "label": _player_label(r), "player_id": r["player_id"]}
        for i, r in enumerate(unique)
    ]
    values_ordered = [
        {"id": f"v{i+1}", "label": statline_fn(r)}
        for i, r in enumerate(unique)
    ]
    answer = {p["id"]: v["id"] for p, v in zip(players_ordered, values_ordered)}

    players_shuffled = list(players_ordered)
    values_shuffled = list(values_ordered)
    random.shuffle(players_shuffled)
    random.shuffle(values_shuffled)
    players_shuffled = [
        {"id": p["id"], "label": p["label"]} for p in players_shuffled
    ]

    return {
        "id": f"{template_id}_{team_id}_{season}_{random.randint(1000, 9999)}",
        "template_id": template_id,
        "type": "match",
        "prompt": prompt,
        "subtitle": subtitle,
        "players": players_shuffled,
        "values": values_shuffled,
        "answer": answer,
        "_player_ids": [r["player_id"] for r in unique],
    }


def _hitter_match_line(r: dict) -> str:
    return (f"{_fmt_avg(r['batting_avg'])}/{_fmt_avg(r['on_base_pct'])}"
            f"/{_fmt_avg(r['slugging_pct'])}, "
            f"{_fmt_int(r['home_runs'])} HR, {_fmt_int(r['rbi'])} RBI")


def _pitcher_match_line(r: dict) -> str:
    return (f"{_fmt_int(r['wins'])}-{_fmt_int(r['losses'])}, "
            f"{_fmt_2dec(r['era'])} ERA, {_fmt_ip(r['innings_pitched'])} IP, "
            f"{_fmt_int(r['strikeouts'])} K")


def t_match_statline_hitters(cur, team_id, season):
    pool = _qualified_hitter_pool(cur, team_id, season, min_pool=4)
    if not pool or len(pool) < 4:
        return None
    sample = random.sample(pool, 4)
    team = _team_name(cur, team_id)
    return _build_statline_match(
        sample, statline_fn=_hitter_match_line,
        template_id="match_statline_hitters",
        prompt=f"Match each {team} hitter to their {season} statline.",
        subtitle=BATTER_RATE_SUBTITLE,
        team_id=team_id, season=season,
    )


def t_match_statline_pitchers(cur, team_id, season):
    pool = _qualified_pitcher_pool(cur, team_id, season, min_pool=4)
    if not pool or len(pool) < 4:
        return None
    sample = random.sample(pool, 4)
    team = _team_name(cur, team_id)
    return _build_statline_match(
        sample, statline_fn=_pitcher_match_line,
        template_id="match_statline_pitchers",
        prompt=f"Match each {team} pitcher to their {season} statline.",
        subtitle=PITCHER_MIN_SUBTITLE,
        team_id=team_id, season=season,
    )


# ── Format 4: Guess the player from a statline ───────────────
# Present a player's statline; the user picks the name from 4
# qualified options. Answer is randomly selected so it isn't
# always the team's #1 performer.

def _qualified_hitter_pool(cur, team_id, season, min_pool: int = 8):
    """Pull up to 12 qualified hitters ordered by PA so the statline
    questions have a meaningful candidate pool. Returns None if fewer
    than `min_pool` qualify."""
    tg = _team_games_played(cur, team_id, season)
    min_pa = int(MIN_BATTER_PA_PER_GAME * tg)
    cur.execute(
        """
        SELECT bs.player_id, bs.plate_appearances, bs.at_bats, bs.hits,
               bs.home_runs, bs.rbi, bs.walks, bs.stolen_bases,
               bs.batting_avg, bs.on_base_pct, bs.slugging_pct,
               p.first_name, p.last_name
        FROM batting_stats bs
        JOIN players p ON p.id = bs.player_id
        WHERE bs.team_id = %s AND bs.season = %s
          AND bs.plate_appearances >= %s
        ORDER BY bs.plate_appearances DESC NULLS LAST
        LIMIT 12
        """,
        (team_id, season, min_pa),
    )
    rows = [dict(r) for r in cur.fetchall()]
    return rows if len(rows) >= min_pool else None


def _qualified_pitcher_pool(cur, team_id, season, min_pool: int = 6):
    """Pull up to 12 qualified pitchers ordered by IP. Returns None if
    fewer than `min_pool` qualify."""
    cur.execute(
        """
        SELECT ps.player_id, ps.innings_pitched, ps.games,
               ps.games_started, ps.wins, ps.losses, ps.saves,
               ps.strikeouts, ps.walks, ps.era, ps.whip,
               p.first_name, p.last_name
        FROM pitching_stats ps
        JOIN players p ON p.id = ps.player_id
        WHERE ps.team_id = %s AND ps.season = %s
          AND ps.innings_pitched >= %s
        ORDER BY ps.innings_pitched DESC NULLS LAST
        LIMIT 12
        """,
        (team_id, season, MIN_PITCHER_IP),
    )
    rows = [dict(r) for r in cur.fetchall()]
    return rows if len(rows) >= min_pool else None


def _build_statline_mc(
    pool: List[dict],
    *,
    statline_fn: Callable[[dict], str],
    prompt: str,
    subtitle: Optional[str],
    template_id: str,
    team_id: int,
    season: int,
) -> Optional[dict]:
    """Build a multiple-choice 'guess the player' question from a pool
    of qualified players. Picks 4 at random — one is the answer, three
    are distractors — and uses the statline as the clue."""
    if len(pool) < 4:
        return None
    chosen = random.sample(pool, 4)
    answer_row = random.choice(chosen)

    statline = statline_fn(answer_row)
    option_ids = ["a", "b", "c", "d"]
    random.shuffle(chosen)
    options = []
    answer_id = None
    for letter, r in zip(option_ids, chosen):
        options.append({"id": letter, "label": _player_label(r)})
        if r["player_id"] == answer_row["player_id"]:
            answer_id = letter

    return {
        "id": f"{template_id}_{team_id}_{season}_{random.randint(1000, 9999)}",
        "template_id": template_id,
        "type": "multiple_choice",
        "prompt": prompt,
        "subtitle": subtitle,
        "statline": statline,
        "options": options,
        "answer": answer_id,
        "explanation": f"{_player_label(answer_row)}: {statline}",
        "_player_ids": [answer_row["player_id"]],
    }


# Statline formatters

def _hitter_full_line(r: dict) -> str:
    return (f"{_fmt_avg(r['batting_avg'])}/{_fmt_avg(r['on_base_pct'])}"
            f"/{_fmt_avg(r['slugging_pct'])}, "
            f"{_fmt_int(r['home_runs'])} HR, {_fmt_int(r['rbi'])} RBI, "
            f"{_fmt_int(r['walks'])} BB, {_fmt_int(r['stolen_bases'])} SB")

def _hitter_slash_line(r: dict) -> str:
    return (f"{_fmt_avg(r['batting_avg'])}/{_fmt_avg(r['on_base_pct'])}"
            f"/{_fmt_avg(r['slugging_pct'])}")

def _pitcher_full_line(r: dict) -> str:
    return (f"{_fmt_int(r['wins'])}-{_fmt_int(r['losses'])}, "
            f"{_fmt_2dec(r['era'])} ERA, {_fmt_ip(r['innings_pitched'])} IP, "
            f"{_fmt_int(r['strikeouts'])} K, {_fmt_int(r['walks'])} BB")

def _pitcher_rate_line(r: dict) -> str:
    return f"{_fmt_2dec(r['era'])} ERA, {_fmt_2dec(r['whip'])} WHIP"


def t_statline_hitter_full(cur, team_id, season):
    pool = _qualified_hitter_pool(cur, team_id, season)
    if not pool:
        return None
    team = _team_name(cur, team_id)
    return _build_statline_mc(
        pool, statline_fn=_hitter_full_line,
        prompt=f"Which {team} hitter had this {season} line?",
        subtitle=BATTER_RATE_SUBTITLE,
        template_id="statline_hitter_full",
        team_id=team_id, season=season,
    )

def t_statline_hitter_slash(cur, team_id, season):
    pool = _qualified_hitter_pool(cur, team_id, season)
    if not pool:
        return None
    team = _team_name(cur, team_id)
    return _build_statline_mc(
        pool, statline_fn=_hitter_slash_line,
        prompt=f"Which {team} hitter had this {season} slash line?",
        subtitle=BATTER_RATE_SUBTITLE,
        template_id="statline_hitter_slash",
        team_id=team_id, season=season,
    )

def t_statline_pitcher_full(cur, team_id, season):
    pool = _qualified_pitcher_pool(cur, team_id, season)
    if not pool:
        return None
    team = _team_name(cur, team_id)
    return _build_statline_mc(
        pool, statline_fn=_pitcher_full_line,
        prompt=f"Which {team} pitcher had this {season} line?",
        subtitle=PITCHER_MIN_SUBTITLE,
        template_id="statline_pitcher_full",
        team_id=team_id, season=season,
    )

def t_statline_pitcher_rate(cur, team_id, season):
    pool = _qualified_pitcher_pool(cur, team_id, season)
    if not pool:
        return None
    team = _team_name(cur, team_id)
    return _build_statline_mc(
        pool, statline_fn=_pitcher_rate_line,
        prompt=f"Which {team} pitcher posted this {season} line?",
        subtitle=PITCHER_MIN_SUBTITLE,
        template_id="statline_pitcher_rate",
        team_id=team_id, season=season,
    )


# ── Format 6: Team / roster counting ─────────────────────────
# Numeric "how many" questions. Render as multiple choice with 4
# integer options (answer + 3 plausible distractors).

def _build_number_mc(
    answer: int,
    *,
    prompt: str,
    subtitle: Optional[str],
    template_id: str,
    explanation: str,
    team_id: int,
    season: int,
    value_suffix: str = "",
) -> Optional[dict]:
    """Build a multiple choice question where the correct answer is an
    integer. Distractors are answer +/- 2, 4, 6 (clamped at 0 and
    deduplicated)."""
    if answer is None:
        return None
    candidate_offsets = [-6, -4, -2, 2, 4, 6]
    random.shuffle(candidate_offsets)
    distractors: List[int] = []
    for off in candidate_offsets:
        v = answer + off
        if v < 0:
            continue
        if v == answer or v in distractors:
            continue
        distractors.append(v)
        if len(distractors) == 3:
            break
    if len(distractors) < 3:
        return None

    raw = [answer] + distractors
    random.shuffle(raw)
    option_ids = ["a", "b", "c", "d"]
    options = []
    answer_id = None
    for letter, v in zip(option_ids, raw):
        options.append({"id": letter, "label": f"{v}{value_suffix}"})
        if v == answer:
            answer_id = letter
    return {
        "id": f"{template_id}_{team_id}_{season}_{random.randint(1000, 9999)}",
        "template_id": template_id,
        "type": "multiple_choice",
        "prompt": prompt,
        "subtitle": subtitle,
        "options": options,
        "answer": answer_id,
        "explanation": explanation,
        "_player_ids": [],  # team-level question — no player revealed
    }


# Roster-count templates (work for every team/season in the stats tables)

def t_count_pitchers_20ip(cur, team_id, season):
    cur.execute(
        """
        SELECT COUNT(*) AS n FROM pitching_stats
        WHERE team_id = %s AND season = %s AND innings_pitched >= %s
        """,
        (team_id, season, MIN_PITCHER_IP),
    )
    n = int(cur.fetchone()["n"] or 0)
    if n < 3:  # not enough pitchers to be an interesting question
        return None
    team = _team_name(cur, team_id)
    return _build_number_mc(
        answer=n,
        prompt=f"How many pitchers on {team} threw at least 20 innings in {season}?",
        subtitle=None, template_id="count_pitchers_20ip",
        explanation=f"{team} had {n} pitchers reach 20 IP in {season}.",
        team_id=team_id, season=season,
    )

def t_count_hitters_100pa(cur, team_id, season):
    cur.execute(
        """
        SELECT COUNT(*) AS n FROM batting_stats
        WHERE team_id = %s AND season = %s AND plate_appearances >= 100
        """,
        (team_id, season),
    )
    n = int(cur.fetchone()["n"] or 0)
    if n < 3:
        return None
    team = _team_name(cur, team_id)
    return _build_number_mc(
        answer=n,
        prompt=f"How many {team} hitters had at least 100 plate appearances in {season}?",
        subtitle=None, template_id="count_hitters_100pa",
        explanation=f"{team} had {n} hitters reach 100 PA in {season}.",
        team_id=team_id, season=season,
    )

def t_count_hr_hitters(cur, team_id, season):
    cur.execute(
        """
        SELECT COUNT(*) AS n FROM batting_stats
        WHERE team_id = %s AND season = %s AND home_runs >= 1
        """,
        (team_id, season),
    )
    n = int(cur.fetchone()["n"] or 0)
    if n < 3:
        return None
    team = _team_name(cur, team_id)
    return _build_number_mc(
        answer=n,
        prompt=f"How many different {team} hitters hit at least one home run in {season}?",
        subtitle=None, template_id="count_hr_hitters",
        explanation=f"{n} different {team} hitters homered in {season}.",
        team_id=team_id, season=season,
    )

def t_count_starters(cur, team_id, season):
    cur.execute(
        """
        SELECT COUNT(*) AS n FROM pitching_stats
        WHERE team_id = %s AND season = %s AND games_started >= 1
        """,
        (team_id, season),
    )
    n = int(cur.fetchone()["n"] or 0)
    if n < 3:
        return None
    team = _team_name(cur, team_id)
    return _build_number_mc(
        answer=n,
        prompt=f"How many different pitchers started a game for {team} in {season}?",
        subtitle=None, template_id="count_starters",
        explanation=f"{n} different {team} pitchers made at least one start in {season}.",
        team_id=team_id, season=season,
    )

def t_count_pitchers_used(cur, team_id, season):
    cur.execute(
        """
        SELECT COUNT(*) AS n FROM pitching_stats
        WHERE team_id = %s AND season = %s AND games >= 1
        """,
        (team_id, season),
    )
    n = int(cur.fetchone()["n"] or 0)
    if n < 4:
        return None
    team = _team_name(cur, team_id)
    return _build_number_mc(
        answer=n,
        prompt=f"How many different pitchers appeared in a game for {team} in {season}?",
        subtitle=None, template_id="count_pitchers_used",
        explanation=f"{n} pitchers took the mound for {team} at some point in {season}.",
        team_id=team_id, season=season,
    )

# Game-based templates (fire only when games data exists for the season)

def t_team_record(cur, team_id, season):
    cur.execute(
        """
        SELECT
          SUM(CASE WHEN (g.home_team_id = %s AND g.home_score > g.away_score)
                    OR (g.away_team_id = %s AND g.away_score > g.home_score)
                   THEN 1 ELSE 0 END) AS w,
          SUM(CASE WHEN (g.home_team_id = %s AND g.home_score < g.away_score)
                    OR (g.away_team_id = %s AND g.away_score < g.home_score)
                   THEN 1 ELSE 0 END) AS l
        FROM games g
        WHERE g.season = %s
          AND (g.home_team_id = %s OR g.away_team_id = %s)
          AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
        """,
        (team_id, team_id, team_id, team_id, season, team_id, team_id),
    )
    row = cur.fetchone()
    if not row:
        return None
    w = int(row["w"] or 0)
    l = int(row["l"] or 0)
    total = w + l
    if total < 10:  # not enough games to make a meaningful record question
        return None
    team = _team_name(cur, team_id)

    # Distractor records: shift wins by +/- 2, 3, 4 while keeping total fixed
    answer_str = f"{w}-{l}"
    distractors = set()
    for off in [-4, -3, -2, 2, 3, 4]:
        nw = w + off
        nl = total - nw
        if nw < 0 or nl < 0:
            continue
        s = f"{nw}-{nl}"
        if s == answer_str:
            continue
        distractors.add(s)
    distractors = list(distractors)
    random.shuffle(distractors)
    distractors = distractors[:3]
    if len(distractors) < 3:
        return None

    raw = [answer_str] + distractors
    random.shuffle(raw)
    option_ids = ["a", "b", "c", "d"]
    options = [{"id": lid, "label": v} for lid, v in zip(option_ids, raw)]
    answer_id = next(o["id"] for o in options if o["label"] == answer_str)
    return {
        "id": f"team_record_{team_id}_{season}_{random.randint(1000, 9999)}",
        "template_id": "team_record",
        "type": "multiple_choice",
        "prompt": f"What was {team}'s overall record in {season}?",
        "subtitle": None,
        "options": options,
        "answer": answer_id,
        "explanation": f"{team} went {answer_str} in {season}.",
        "_player_ids": [],
    }

def t_team_shutouts(cur, team_id, season):
    cur.execute(
        """
        SELECT COUNT(*) AS n FROM games g
        WHERE g.season = %s
          AND ((g.home_team_id = %s AND g.away_score = 0)
            OR (g.away_team_id = %s AND g.home_score = 0))
        """,
        (season, team_id, team_id),
    )
    n = int(cur.fetchone()["n"] or 0)
    # Need the team to have PLAYED games for this to make sense.
    cur.execute(
        """
        SELECT COUNT(*) AS gp FROM games g
        WHERE g.season = %s AND (g.home_team_id = %s OR g.away_team_id = %s)
        """,
        (season, team_id, team_id),
    )
    gp = int(cur.fetchone()["gp"] or 0)
    if gp < 15 or n < 1:
        return None
    team = _team_name(cur, team_id)
    return _build_number_mc(
        answer=n,
        prompt=f"How many shutouts did {team}'s pitching staff throw in {season}?",
        subtitle=None, template_id="team_shutouts",
        explanation=f"{team} tossed {n} shutouts in {season}.",
        team_id=team_id, season=season,
    )

def t_team_one_run_games(cur, team_id, season):
    cur.execute(
        """
        SELECT COUNT(*) AS n FROM games g
        WHERE g.season = %s
          AND (g.home_team_id = %s OR g.away_team_id = %s)
          AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
          AND ABS(g.home_score - g.away_score) = 1
        """,
        (season, team_id, team_id),
    )
    n = int(cur.fetchone()["n"] or 0)
    cur.execute(
        """
        SELECT COUNT(*) AS gp FROM games g
        WHERE g.season = %s AND (g.home_team_id = %s OR g.away_team_id = %s)
        """,
        (season, team_id, team_id),
    )
    gp = int(cur.fetchone()["gp"] or 0)
    if gp < 15 or n < 3:
        return None
    team = _team_name(cur, team_id)
    return _build_number_mc(
        answer=n,
        prompt=f"How many one-run games did {team} play in {season}?",
        subtitle=None, template_id="team_one_run_games",
        explanation=f"{team} played {n} one-run games in {season}.",
        team_id=team_id, season=season,
    )

# ── Format 7: Head-to-head teammate comparison ───────────────

def _h2h(
    cur, team_id: int, season: int, *, kind: str, column: str, label: str,
    template_id: str, comparison: str = "higher",
    qualified: bool = True,
    value_formatter: Callable = _fmt_int,
) -> Optional[dict]:
    """Pick two qualified teammates with distinct values, ask which
    one had the higher/lower/more value for `column`. `comparison`
    controls the prompt wording: 'higher', 'lower', or 'more'."""
    order = "ASC" if comparison == "lower" else "DESC"
    if kind == "bat":
        rows = _top_hitters(cur, team_id, season, column, order=order,
                            limit=10, require_rate_qualified=qualified)
    else:
        rows = _top_pitchers(cur, team_id, season, column, order=order,
                             limit=10, require_ip_qualified=qualified)
    rows = [r for r in rows if r["stat_val"] is not None]
    if len(rows) < 2:
        return None

    # Pick 2 random players with distinct stat values.
    attempts = 0
    pair = None
    while attempts < 25:
        attempts += 1
        a, b = random.sample(rows, 2)
        if float(a["stat_val"]) != float(b["stat_val"]):
            pair = (a, b)
            break
    if pair is None:
        return None
    a, b = pair
    va, vb = float(a["stat_val"]), float(b["stat_val"])
    if comparison == "lower":
        winner = a if va < vb else b
    else:
        winner = a if va > vb else b

    team = _team_name(cur, team_id)
    names = [_player_label(a), _player_label(b)]
    random.shuffle(names)
    prompt_lead = f"In {season}, who had the {comparison} {label}"
    prompt = f"{prompt_lead} for {team}: {names[0]} or {names[1]}?"

    # Options
    option_ids = ["a", "b"]
    options_raw = [a, b]
    random.shuffle(options_raw)
    options = []
    answer_id = None
    for letter, r in zip(option_ids, options_raw):
        options.append({"id": letter, "label": _player_label(r)})
        if r["player_id"] == winner["player_id"]:
            answer_id = letter

    va_s = value_formatter(va)
    vb_s = value_formatter(vb)
    explanation = (
        f"{_player_label(a)}: {va_s} {label}. "
        f"{_player_label(b)}: {vb_s} {label}."
    )
    return {
        "id": f"{template_id}_{team_id}_{season}_{random.randint(1000, 9999)}",
        "template_id": template_id,
        "type": "multiple_choice",
        "prompt": prompt,
        "subtitle": (PITCHER_MIN_SUBTITLE if kind == "pit" and qualified
                     else BATTER_RATE_SUBTITLE if kind == "bat" and qualified
                     else None),
        "options": options,
        "answer": answer_id,
        "explanation": explanation,
        "_player_ids": [a["player_id"], b["player_id"]],
    }


def t_h2h_hr(cur, team_id, season):
    return _h2h(cur, team_id, season, kind="bat", column="home_runs",
                label="home run total", template_id="h2h_hr",
                comparison="higher", qualified=True, value_formatter=_fmt_int)

def t_h2h_rbi(cur, team_id, season):
    return _h2h(cur, team_id, season, kind="bat", column="rbi",
                label="RBI total", template_id="h2h_rbi",
                comparison="higher", qualified=True, value_formatter=_fmt_int)

def t_h2h_avg(cur, team_id, season):
    return _h2h(cur, team_id, season, kind="bat", column="batting_avg",
                label="batting average", template_id="h2h_avg",
                comparison="higher", qualified=True, value_formatter=_fmt_avg)

def t_h2h_owar(cur, team_id, season):
    return _h2h(cur, team_id, season, kind="bat", column="offensive_war",
                label="offensive WAR", template_id="h2h_owar",
                comparison="higher", qualified=True, value_formatter=_fmt_2dec)

def t_h2h_era(cur, team_id, season):
    return _h2h(cur, team_id, season, kind="pit", column="era",
                label="ERA", template_id="h2h_era",
                comparison="lower", qualified=True, value_formatter=_fmt_2dec)

def t_h2h_pwar(cur, team_id, season):
    return _h2h(cur, team_id, season, kind="pit", column="pitching_war",
                label="pitching WAR", template_id="h2h_pwar",
                comparison="higher", qualified=True, value_formatter=_fmt_2dec)

def t_h2h_k(cur, team_id, season):
    return _h2h(cur, team_id, season, kind="pit", column="strikeouts",
                label="strikeout total", template_id="h2h_k",
                comparison="higher", qualified=True, value_formatter=_fmt_int)


def t_team_blowouts(cur, team_id, season):
    cur.execute(
        """
        SELECT COUNT(*) AS n FROM games g
        WHERE g.season = %s
          AND (g.home_team_id = %s OR g.away_team_id = %s)
          AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
          AND ABS(g.home_score - g.away_score) >= 10
        """,
        (season, team_id, team_id),
    )
    n = int(cur.fetchone()["n"] or 0)
    cur.execute(
        """
        SELECT COUNT(*) AS gp FROM games g
        WHERE g.season = %s AND (g.home_team_id = %s OR g.away_team_id = %s)
        """,
        (season, team_id, team_id),
    )
    gp = int(cur.fetchone()["gp"] or 0)
    if gp < 15 or n < 3:
        return None
    team = _team_name(cur, team_id)
    return _build_number_mc(
        answer=n,
        prompt=f"How many games did {team} play that were decided by 10 or more runs in {season}?",
        subtitle=None, template_id="team_blowouts",
        explanation=f"{team} played in {n} blowouts (10+ run margin) in {season}.",
        team_id=team_id, season=season,
    )


# Registry: list of all template functions. The generator picks one
# at random for each question slot.
TEMPLATES: List[Callable] = [
    # Format 1: Who led
    t_leader_hr, t_leader_rbi, t_leader_hits, t_leader_doubles,
    t_leader_triples, t_leader_sb, t_leader_walks, t_leader_runs,
    t_leader_pa, t_leader_owar,
    t_leader_avg, t_leader_obp, t_leader_slg, t_leader_wrcplus,
    t_leader_ip, t_leader_k, t_leader_wins, t_leader_saves,
    t_leader_gs, t_leader_pwar, t_leader_era,
    # Format 2: Who finished Nth
    t_second_hr, t_second_era, t_second_pwar, t_second_k,
    # Format 3: Match 4 players to 4 values (qualified only)
    t_match_hr, t_match_rbi, t_match_ba, t_match_owar,
    t_match_era, t_match_ip, t_match_k, t_match_wins,
    # Format 3b: Match 4 players to 4 full statlines
    t_match_statline_hitters, t_match_statline_pitchers,
    # Format 4: Guess the player from a statline (qualified only)
    t_statline_hitter_full, t_statline_hitter_slash,
    t_statline_pitcher_full, t_statline_pitcher_rate,
    # Format 6: Team / roster counting
    t_count_pitchers_20ip, t_count_hitters_100pa, t_count_hr_hitters,
    t_count_starters, t_count_pitchers_used,
    t_team_record, t_team_shutouts, t_team_one_run_games, t_team_blowouts,
    # Format 7: Head-to-head teammate comparison
    t_h2h_hr, t_h2h_rbi, t_h2h_avg, t_h2h_owar,
    t_h2h_era, t_h2h_pwar, t_h2h_k,
]


# ── Question generation ──────────────────────────────────────

# Map templates to "families" so the bulk endpoint can enforce
# variety. Leader and Second share a family because they're the
# same shape to the quiz-taker. Count and team-fact share the
# "team" family for the same reason.
def _family_for_fn(fn: Callable) -> str:
    n = fn.__name__
    if n.startswith("t_leader_") or n.startswith("t_second_"):
        return "leader"
    if n.startswith("t_match_"):
        return "match"
    if n.startswith("t_statline_"):
        return "statline"
    if n.startswith("t_count_") or n.startswith("t_team_"):
        return "team"
    if n.startswith("t_h2h_"):
        return "h2h"
    return "other"


def _family_for_template_id(tid: str) -> str:
    if tid.startswith("leader_") or tid.startswith("second_"):
        return "leader"
    if tid.startswith("match_"):
        return "match"
    if tid.startswith("statline_"):
        return "statline"
    if tid.startswith("count_") or tid.startswith("team_"):
        return "team"
    if tid.startswith("h2h_"):
        return "h2h"
    return "other"


# Per-family caps for a standard 10-question quiz. Sum exceeds 10
# so any single family can't take over, but match is generous since
# users love the format. If a team can't produce enough in-cap
# variety we relax these toward the end of the generation loop.
FAMILY_CAPS = {
    "leader": 3,
    "match": 3,
    "statline": 2,
    "team": 2,
    "h2h": 2,
}


def _generate_one(cur, team_id: int, season: int,
                  exclude_template_ids: set,
                  exclude_player_ids: Optional[set] = None,
                  exclude_families: Optional[set] = None) -> Optional[dict]:
    """Try templates in random order until one succeeds. Skip any
    template already served in this quiz session, any family whose
    cap is exhausted, and any candidate that would reveal a player
    already shown. Falls back to player-reuse if the pool is empty."""
    if exclude_player_ids is None:
        exclude_player_ids = set()
    if exclude_families is None:
        exclude_families = set()
    pool = list(TEMPLATES)
    if exclude_families:
        pool = [t for t in pool if _family_for_fn(t) not in exclude_families]
    random.shuffle(pool)
    fallback: Optional[dict] = None
    for t in pool:
        try:
            q = t(cur, team_id, season)
        except Exception:
            q = None
        if q is None:
            continue
        if q.get("template_id") in exclude_template_ids:
            continue
        q_player_ids = set(q.get("_player_ids") or [])
        if q_player_ids & exclude_player_ids:
            if fallback is None:
                fallback = q  # keep as safety net
            continue
        return q
    return fallback


def _strip_internal(q: dict) -> dict:
    """Remove private keys before returning the question to clients."""
    out = dict(q)
    out.pop("_player_ids", None)
    return out


# ── Endpoints ────────────────────────────────────────────────

@quiz_router.get("/question")
def get_question(
    team_id: int = Query(..., description="The team being quizzed on"),
    seasons: str = Query(..., description="Comma separated seasons, e.g. 2024,2025"),
):
    """Return one random quiz question for the given team + season(s).
    Useful for debugging individual templates."""
    try:
        season_list = [int(s.strip()) for s in seasons.split(",") if s.strip()]
    except ValueError:
        raise HTTPException(status_code=400, detail="seasons must be comma-separated integers")
    if not season_list:
        raise HTTPException(status_code=400, detail="at least one season is required")
    season = random.choice(season_list)
    with get_connection() as conn:
        cur = conn.cursor()
        q = _generate_one(cur, team_id, season, exclude_template_ids=set())
    if q is None:
        raise HTTPException(
            status_code=422,
            detail=f"Not enough data to build a question for team {team_id} in {season}",
        )
    return _strip_internal(q)


@quiz_router.get("/questions")
def get_quiz(
    team_id: int = Query(..., description="The team being quizzed on"),
    seasons: str = Query(..., description="Comma separated seasons, e.g. 2024,2025"),
    count: int = Query(10, ge=1, le=20, description="Number of questions in the quiz"),
):
    """Build a full quiz: `count` questions, each from a different
    template where possible. Seasons are distributed across the quiz."""
    try:
        season_list = [int(s.strip()) for s in seasons.split(",") if s.strip()]
    except ValueError:
        raise HTTPException(status_code=400, detail="seasons must be comma-separated integers")
    if not season_list:
        raise HTTPException(status_code=400, detail="at least one season is required")

    questions: List[dict] = []
    used_template_ids: set = set()
    used_player_ids: set = set()
    family_counts: dict = {}
    initial_attempts = count * 4  # cushion for templates that fail
    attempts_remaining = initial_attempts

    with get_connection() as conn:
        cur = conn.cursor()
        while len(questions) < count and attempts_remaining > 0:
            attempts_remaining -= 1
            season = random.choice(season_list)
            # Relax family caps if we've burned through a chunk of
            # our attempt budget (e.g., the team has no qualified
            # pitchers so we literally can't produce the "match"
            # family's cap). Lets us still fill the quiz.
            relax_caps = attempts_remaining < (initial_attempts // 2)
            exclude_families = set() if relax_caps else {
                f for f, cap in FAMILY_CAPS.items()
                if family_counts.get(f, 0) >= cap
            }
            q = _generate_one(cur, team_id, season,
                              exclude_template_ids=used_template_ids,
                              exclude_player_ids=used_player_ids,
                              exclude_families=exclude_families)
            if q is None:
                # Allow template reuse if we've exhausted the pool
                if len(used_template_ids) >= len(TEMPLATES):
                    used_template_ids.clear()
                continue
            used_template_ids.add(q["template_id"])
            for pid in (q.get("_player_ids") or []):
                used_player_ids.add(pid)
            fam = _family_for_template_id(q["template_id"])
            family_counts[fam] = family_counts.get(fam, 0) + 1
            questions.append(_strip_internal(q))

    if not questions:
        raise HTTPException(
            status_code=422,
            detail=f"Not enough data to build any questions for team {team_id}",
        )
    return {"team_id": team_id, "seasons": season_list, "questions": questions}
