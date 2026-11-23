"""Team count-state tendencies (ahead / even / behind / two strikes) from
game_events. Used by the Series Planner. Split out of the retired Advance
Report (Nov 2026)."""
from __future__ import annotations

# ── count-state tendencies (team-level, from game_events) ────────
#
# The single most-requested advance-scouting element: what an opponent does
# ahead / even / behind / with two strikes. Buckets match the per-player
# pitch-level definitions (ahead = hitter's counts, behind = pitcher's counts).
# Two-strike overlaps the others on purpose (it's a separate approach axis).

_COUNT_AGG_COLS = """
    COUNT(*) AS pa,
    SUM(CASE WHEN result_type IN ('walk','intentional_walk','hbp','sac_bunt') THEN 0 ELSE 1 END) AS ab,
    SUM(CASE WHEN result_type IN ('single','double','triple','home_run') THEN 1 ELSE 0 END) AS h,
    SUM(CASE WHEN result_type='double' THEN 1 ELSE 0 END) AS d,
    SUM(CASE WHEN result_type='triple' THEN 1 ELSE 0 END) AS t,
    SUM(CASE WHEN result_type='home_run' THEN 1 ELSE 0 END) AS hr,
    SUM(CASE WHEN result_type IN ('walk','intentional_walk') THEN 1 ELSE 0 END) AS bb,
    SUM(CASE WHEN result_type='hbp' THEN 1 ELSE 0 END) AS hbp,
    SUM(CASE WHEN result_type IN ('strikeout_swinging','strikeout_looking') THEN 1 ELSE 0 END) AS k,
    SUM(CASE WHEN result_type='sac_fly' THEN 1 ELSE 0 END) AS sf
"""

_BUCKET_CASE = """
    CASE
      WHEN (balls_before, strikes_before) IN ((1,0),(2,0),(3,0),(3,1)) THEN 'ahead'
      WHEN (balls_before, strikes_before) IN ((0,1),(0,2),(1,2)) THEN 'behind'
      ELSE 'even'
    END
"""


def _slash_from_row(r: dict) -> dict:
    ab = r.get("ab") or 0
    h = r.get("h") or 0
    d = r.get("d") or 0
    t = r.get("t") or 0
    hr = r.get("hr") or 0
    bb = r.get("bb") or 0
    hbp = r.get("hbp") or 0
    sf = r.get("sf") or 0
    k = r.get("k") or 0
    pa = r.get("pa") or 0
    singles = h - d - t - hr
    obp_denom = ab + bb + hbp + sf
    avg = h / ab if ab else None
    obp = (h + bb + hbp) / obp_denom if obp_denom else None
    slg = (singles + 2 * d + 3 * t + 4 * hr) / ab if ab else None
    ops = (obp + slg) if (obp is not None and slg is not None) else None
    return {
        "pa": pa, "avg": avg, "obp": obp, "slg": slg, "ops": ops,
        "k_pct": (k / pa) if pa else None,
        "bb_pct": (bb / pa) if pa else None,
    }


def _count_tendencies_side(cur, team_id: int, season: int, team_col: str,
                           perspective: str = "hitter") -> list[dict]:
    base_where = (f"g.season = %s AND ge.{team_col} = %s AND ge.result_type IS NOT NULL "
                  f"AND ge.balls_before IS NOT NULL AND ge.strikes_before IS NOT NULL")
    # Exclusive buckets (ahead / even / behind)
    cur.execute(f"""
        SELECT {_BUCKET_CASE} AS bucket, {_COUNT_AGG_COLS}
        FROM game_events ge JOIN games g ON g.id = ge.game_id
        WHERE {base_where}
        GROUP BY bucket
    """, (season, team_id))
    by_bucket = {row["bucket"]: dict(row) for row in cur.fetchall()}
    # Two-strike (overlapping)
    cur.execute(f"""
        SELECT {_COUNT_AGG_COLS}
        FROM game_events ge JOIN games g ON g.id = ge.game_id
        WHERE {base_where} AND ge.strikes_before = 2
    """, (season, team_id))
    two_strike = dict(cur.fetchone() or {})

    # Buckets are labeled from the hitter's POV. For the pitching table, flip
    # Ahead/Behind so "Ahead" means the PITCHER is ahead (a pitcher's count).
    if perspective == "pitcher":
        order = [("Ahead", "behind"), ("Even", "even"), ("Behind", "ahead")]
    else:
        order = [("Ahead", "ahead"), ("Even", "even"), ("Behind", "behind")]
    out = []
    for label, key in order:
        row = by_bucket.get(key)
        if row and (row.get("pa") or 0) >= 15:
            out.append({"label": label, **_slash_from_row(row)})
    if (two_strike.get("pa") or 0) >= 15:
        out.append({"label": "2 Strikes", **_slash_from_row(two_strike)})
    return out


# ── main entry point ─────────────────────────────────────────────
