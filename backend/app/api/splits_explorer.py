"""
Splits Explorer — a deeply filterable per-player stat table over play-by-play.

Coaches pick a team + side (hitters/pitchers) and stack filters (game state,
handedness, home/away, timing, count) to dig into how players perform in any
situation. Because "count" is a filter dimension and the table shows plate-
discipline rates, selecting count='0-2' yields the 0-2 swing/contact (or
strike/whiff) rates directly.

All numbers come from game_events (our parsed PBP). Discipline rates use the
site-standard pitch_sequence encoding: B=ball, K=called strike, S=swinging
strike, F=foul, H=HBP; a put-in-play pitch has no letter (the PA ends), so it
is counted as +1 pitch when was_in_play is true.
"""

from __future__ import annotations

from typing import Optional


# ── filter fragments (SQL over game_events ge / games g / batter pb / pitcher pp)
# Every value is looked up from these fixed dicts — never interpolated from raw
# user input — so the composed WHERE is injection-safe.

BASE_STATE = {
    "all": "",
    "bases_empty": "ge.bases_before = '000'",
    "runner_on": "ge.bases_before IS NOT NULL AND ge.bases_before <> '000'",
    "risp": ("ge.bases_before IS NOT NULL AND "
             "(SUBSTRING(ge.bases_before,2,1)='1' OR SUBSTRING(ge.bases_before,3,1)='1')"),
    "risp_2out": ("ge.bases_before IS NOT NULL AND "
                  "(SUBSTRING(ge.bases_before,2,1)='1' OR SUBSTRING(ge.bases_before,3,1)='1') "
                  "AND ge.outs_before = 2"),
    "loaded": "ge.bases_before = '111'",
    "leadoff": "ge.outs_before = 0 AND ge.bases_before = '000'",
}

TIMING = {
    "all": "",
    "innings_1_3": "ge.inning BETWEEN 1 AND 3",
    "innings_4_6": "ge.inning BETWEEN 4 AND 6",
    "innings_7_plus": "ge.inning >= 7",
    "late_close": ("ge.inning >= 7 AND ge.bat_score_before IS NOT NULL "
                   "AND ABS(ge.bat_score_before - ge.fld_score_before) <= 1"),
}

COUNT = {
    "all": "",
    "first_pitch": "ge.balls_before = 0 AND ge.strikes_before = 0",
    "ahead": "(ge.balls_before, ge.strikes_before) IN ((1,0),(2,0),(3,0),(3,1))",
    "behind": "(ge.balls_before, ge.strikes_before) IN ((0,1),(0,2),(1,2))",
    "even": "(ge.balls_before, ge.strikes_before) IN ((0,0),(1,1),(2,1),(2,2),(3,2))",
    "two_strike": "ge.strikes_before = 2",
    "three_ball": "ge.balls_before = 3",
}
# every explicit count 0-0 .. 3-2
for _b in range(4):
    for _s in range(3):
        COUNT[f"{_b}-{_s}"] = f"ge.balls_before = {_b} AND ge.strikes_before = {_s}"

# Handedness keys differ by side (hitters filter on the pitcher's hand; pitchers
# filter on the batter's hand).
HAND_HITTER = {
    "all": "",
    "vs_rhp": "UPPER(pp.throws) = 'R'",
    "vs_lhp": "UPPER(pp.throws) = 'L'",
}
HAND_PITCHER = {
    "all": "",
    "vs_rhb": "UPPER(pb.bats) = 'R'",
    "vs_lhb": "UPPER(pb.bats) = 'L'",
}

# Entry / usage (hitters only). Heuristic: a starter almost always bats by the
# end of the 3rd inning (the order turns over ~9 hitters by then), so a first
# plate appearance in the 4th or later means the player came off the bench.
ENTRY = {
    "all": "",
    "bench": "ge.first_pa_inning >= 4",   # pinch-hit / late sub
    "starter": "ge.first_pa_inning <= 3",
}
VENUE = {"all": "", "home": None, "away": None}  # filled with team_id at build time


def _woba(bb, hbp, s, d, t, hr, ab, sf):
    num = 0.69 * bb + 0.72 * hbp + 0.88 * s + 1.24 * d + 1.56 * t + 2.0 * hr
    den = ab + bb + sf + hbp
    return (num / den) if den else None


def _discipline(row):
    """swing/contact/whiff/strike% from the pitch_sequence letter counts."""
    seq_len = float(row.get("seq_len") or 0)
    s = float(row.get("s_ct") or 0)   # swinging strikes
    k = float(row.get("k_ct") or 0)   # called strikes
    f = float(row.get("f_ct") or 0)   # fouls
    b = float(row.get("b_ct") or 0)   # balls
    inplay = float(row.get("inplay") or 0)
    total = seq_len + inplay
    swings = s + f + inplay
    contact = f + inplay
    strikes = k + s + f + inplay
    return {
        "swing_pct": (swings / total) if total else None,
        "contact_pct": (contact / swings) if swings else None,
        "whiff_pct": (s / swings) if swings else None,
        "strike_pct": (strikes / total) if total else None,
        "pitches": int(total),
    }


_SEQ_COLS = """
    SUM(LENGTH(pitch_sequence)) AS seq_len,
    SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence,'S',''))) AS s_ct,
    SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence,'K',''))) AS k_ct,
    SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence,'F',''))) AS f_ct,
    SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence,'B',''))) AS b_ct,
    SUM(CASE WHEN was_in_play THEN 1 ELSE 0 END) AS inplay
"""

_OUTCOME_COLS = """
    COUNT(*) AS pa,
    SUM(CASE WHEN result_type IN ('walk','intentional_walk','hbp','sac_bunt') THEN 0 ELSE 1 END) AS ab,
    SUM(CASE WHEN result_type='single' THEN 1 ELSE 0 END) AS s1,
    SUM(CASE WHEN result_type='double' THEN 1 ELSE 0 END) AS d2,
    SUM(CASE WHEN result_type='triple' THEN 1 ELSE 0 END) AS t3,
    SUM(CASE WHEN result_type='home_run' THEN 1 ELSE 0 END) AS hr,
    SUM(CASE WHEN result_type IN ('walk','intentional_walk') THEN 1 ELSE 0 END) AS bb,
    SUM(CASE WHEN result_type='hbp' THEN 1 ELSE 0 END) AS hbp,
    SUM(CASE WHEN result_type='sac_fly' THEN 1 ELSE 0 END) AS sf,
    SUM(CASE WHEN result_type IN ('strikeout_swinging','strikeout_looking') THEN 1 ELSE 0 END) AS k,
    COUNT(*) FILTER (WHERE bb_type='GB') AS gb,
    COUNT(*) FILTER (WHERE bb_type='FB') AS fb,
    COUNT(*) FILTER (WHERE bb_type='LD') AS ld,
    COUNT(*) FILTER (WHERE bb_type IS NOT NULL) AS bip
"""


def _row_stats(r: dict, side: str) -> dict:
    pa = r.get("pa") or 0
    ab = r.get("ab") or 0
    s1 = r.get("s1") or 0
    d2 = r.get("d2") or 0
    t3 = r.get("t3") or 0
    hr = r.get("hr") or 0
    bb = r.get("bb") or 0
    hbp = r.get("hbp") or 0
    sf = r.get("sf") or 0
    k = r.get("k") or 0
    h = s1 + d2 + t3 + hr
    tb = s1 + 2 * d2 + 3 * t3 + 4 * hr
    obp_den = ab + bb + hbp + sf
    avg = h / ab if ab else None
    obp = (h + bb + hbp) / obp_den if obp_den else None
    slg = tb / ab if ab else None
    gb = r.get("gb") or 0
    fb = r.get("fb") or 0
    ld = r.get("ld") or 0
    bip = r.get("bip") or 0
    disc = _discipline(r)
    stats = {
        "pa": pa,  # BF for pitchers, but same column
        "avg": avg, "obp": obp, "slg": slg,
        "ops": (obp + slg) if (obp is not None and slg is not None) else None,
        "woba": _woba(bb, hbp, s1, d2, t3, hr, ab, sf),
        "k_pct": (k / pa) if pa else None,
        "bb_pct": (bb / pa) if pa else None,
        "hr": hr,
        "gb_pct": (gb / bip) if bip else None,
        "ld_pct": (ld / bip) if bip else None,
        "fb_pct": (fb / bip) if bip else None,
        **disc,
    }
    return stats


def build_splits(cur, team_id: int, season: int, side: str,
                 base_state="all", handedness="all", venue="all",
                 timing="all", count="all", entry="all", min_pa=1) -> dict:
    """Per-player filtered stat table for one team's hitters or pitchers."""
    side = "pitchers" if side == "pitchers" else "hitters"
    team_id = int(team_id)

    if side == "hitters":
        pid_col = "ge.batter_player_id"
        team_col = "ge.batting_team_id"
        hand = HAND_HITTER.get(handedness, "")
        name_join = "ge.batter_player_id"
    else:
        pid_col = "ge.pitcher_player_id"
        team_col = "ge.defending_team_id"
        hand = HAND_PITCHER.get(handedness, "")
        name_join = "ge.pitcher_player_id"

    # Per-PA filters applied AFTER the first-PA-inning window is computed.
    clauses = []
    for frag in (BASE_STATE.get(base_state, ""), TIMING.get(timing, ""),
                 COUNT.get(count, ""), hand):
        if frag:
            clauses.append(frag)
    if venue == "home":
        clauses.append(f"g.home_team_id = {team_id}")
    elif venue == "away":
        clauses.append(f"g.away_team_id = {team_id}")
    if side == "hitters":  # entry/pinch-hit heuristic is a hitter concept
        ef = ENTRY.get(entry, "")
        if ef:
            clauses.append(ef)
    where = (" AND " + " AND ".join(clauses)) if clauses else ""

    # CTE tags every PA with the player's earliest batting inning that game, over
    # ALL their PAs for this team (before the per-PA filters), so the entry filter
    # reflects true game entry.
    cur.execute(f"""
        WITH pa AS (
            SELECT ge.*,
                   MIN(ge.inning) OVER (PARTITION BY ge.game_id, {pid_col}) AS first_pa_inning
            FROM game_events ge
            JOIN games g0 ON g0.id = ge.game_id
            WHERE g0.season = %s AND {pid_col} IS NOT NULL
              AND ge.result_type IS NOT NULL AND {team_col} = {team_id}
        )
        SELECT {pid_col} AS pid,
               MAX(pl.first_name) AS first_name, MAX(pl.last_name) AS last_name,
               MAX(pl.position) AS position, MAX(pl.bats) AS bats, MAX(pl.throws) AS throws,
               {_OUTCOME_COLS},
               {_SEQ_COLS}
        FROM pa ge
        JOIN games g ON g.id = ge.game_id
        JOIN players pl ON pl.id = {name_join}
        LEFT JOIN players pb ON pb.id = ge.batter_player_id
        LEFT JOIN players pp ON pp.id = ge.pitcher_player_id
        WHERE TRUE{where}
        GROUP BY {pid_col}
        HAVING COUNT(*) >= %s
        ORDER BY COUNT(*) DESC
    """, (season, min_pa))

    players = []
    for r in cur.fetchall():
        d = dict(r)
        players.append({
            "player_id": d["pid"],
            "name": f"{d.get('first_name') or ''} {d.get('last_name') or ''}".strip() or "Unnamed",
            "position": d.get("position"),
            "bats": d.get("bats"),
            "throws": d.get("throws"),
            **_row_stats(d, side),
        })

    return {
        "team_id": team_id,
        "season": season,
        "side": side,
        "filters": {"base_state": base_state, "handedness": handedness,
                    "venue": venue, "timing": timing, "count": count, "entry": entry},
        "players": players,
        "count": len(players),
    }
