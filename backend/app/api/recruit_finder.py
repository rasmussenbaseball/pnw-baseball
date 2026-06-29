"""
Recruit Finder — search uncommitted players by position + predictive stats/archetypes.

Pools UNCOMMITTED players from three groups (deduped on the spring player_id):
  1. NWAC (JUCO) players
  2. PNW four-year players in the transfer portal (transfer_portal_members)
  3. WCL summer-portal players that link to a spring player (wcl_portal_members)

Coaches pick a position, an archetype (a wide-net blend of PREDICTIVE stats — ISO,
wOBACON, air-pull%, contact%, K%, BB%, etc.; AVG/ERA are de-emphasized), and/or custom
filters by raw value (AVG >= .300) or by percentile ("top 75th percentile air-pull%").
Percentiles are "goodness" percentiles vs the qualified college-hitter population, so
"top 75" always means top-quartile-best regardless of whether high or low is good.

v1 = HITTERS. Pitchers are the next iteration (same scaffold).
"""
import bisect
from typing import Optional, List

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from ..models.database import get_connection
from ..config import CURRENT_SEASON
from .auth import require_tier

router = APIRouter(prefix="/recruit-finder", tags=["recruit-finder"])
_gate = require_tier("recruiting")


# stat key -> (batting_stats column or 'pbp', label, higher_is_better)
HITTER_STATS = {
    "wrc_plus":     ("wrc_plus", "wRC+", True),
    "woba":         ("woba", "wOBA", True),
    "obp":          ("on_base_pct", "OBP", True),
    "slg":          ("slugging_pct", "SLG", True),
    "ops":          ("ops", "OPS", True),
    "iso":          ("iso", "ISO", True),
    "wobacon":      ("wobacon", "wOBACON", True),
    "avg":          ("batting_avg", "AVG", True),
    "babip":        ("babip", "BABIP", True),
    "k_pct":        ("k_pct", "K%", False),
    "bb_pct":       ("bb_pct", "BB%", True),
    "hr":           ("home_runs", "HR", True),
    "sb":           ("stolen_bases", "SB", True),
    "doubles":      ("doubles", "2B", True),
    "triples":      ("triples", "3B", True),
    "air_pull_pct": ("pbp", "Air-Pull%", True),
    "contact_pct":  ("pbp", "Contact%", True),
    "whiff_pct":    ("pbp", "Whiff%", False),
    "gb_pct":       ("pbp", "GB%", False),
}
PBP_STATS = {k for k, v in HITTER_STATS.items() if v[0] == "pbp"}

# Archetypes — wide-net blends of PREDICTIVE stats (weights). Each listed stat
# contributes its GOODNESS percentile (direction handled by HIGHER_BETTER), so all
# weights are positive. Deliberately avoid leaning on AVG.
ARCHETYPES = {
    "power":      {"label": "Power", "weights": {"iso": 1.0, "wobacon": 1.0, "hr": 0.7, "air_pull_pct": 0.8}},
    "contact":    {"label": "Pure Hitter / Contact", "weights": {"contact_pct": 1.0, "k_pct": 1.0, "wobacon": 0.6}},
    "onbase":     {"label": "On-Base / Discipline", "weights": {"bb_pct": 1.0, "obp": 0.8, "k_pct": 0.6, "contact_pct": 0.6}},
    "athlete":    {"label": "Athlete / Speed", "weights": {"sb": 1.0, "doubles": 0.6, "triples": 0.5}},
    "allaround":  {"label": "Best Available (all-around)", "weights": {"wrc_plus": 1.0, "woba": 0.8, "iso": 0.6, "bb_pct": 0.4}},
}

# position group -> Postgres case-insensitive regex over players.position (token-aware)
POSITION_GROUPS = {
    "any":        None,
    "c":          r"(^|/)C(/|$)",
    "if":         r"(^|/)(1B|2B|3B|SS|IF)(/|$)",
    "1b":         r"(^|/)1B(/|$)",
    "2b":         r"(^|/)2B(/|$)",
    "ss":         r"(^|/)SS(/|$)",
    "3b":         r"(^|/)3B(/|$)",
    "mid_if":     r"(^|/)(2B|SS)(/|$)",
    "corner_if":  r"(^|/)(1B|3B)(/|$)",
    "of":         r"(^|/)(OF|LF|CF|RF)(/|$)",
    "corner_of":  r"(^|/)(OF|LF|RF)(/|$)",
    "cf":         r"(^|/)CF(/|$)",
}

MIN_PA = 25          # to appear in results
QUAL_PA = 50         # qualified population for percentile reference
MIN_BBT = 20         # batted-ball sample for PBP stats


class Filter(BaseModel):
    stat: str
    mode: str = "value"      # 'value' | 'percentile'
    op: str = "min"          # 'min' | 'max'
    value: float


class FinderQuery(BaseModel):
    position: str = "any"
    bats: str = "any"        # 'L' | 'R' | 'S' | 'any'
    archetype: Optional[str] = None
    filters: List[Filter] = []
    sort: Optional[str] = None   # stat key to prioritize; default archetype/wRC+
    season: int = CURRENT_SEASON
    limit: int = 80


def _pct(sorted_vals, v):
    """Percentile (0-100) of v within a sorted list (fraction strictly below)."""
    if v is None or not sorted_vals:
        return None
    i = bisect.bisect_left(sorted_vals, v)
    return round(100.0 * i / len(sorted_vals), 1)


@router.post("/search")
def search(body: FinderQuery, _uid: str = Depends(_gate)):
    season = body.season or CURRENT_SEASON
    with get_connection() as conn:
        cur = conn.cursor()

        # ── 1. Pool: uncommitted spring player_ids from the three groups ──
        cur.execute("""
            SELECT p.id, p.first_name, p.last_name, p.position, p.bats, p.year_in_school,
                   t.short_name AS team, d.level,
                   CASE WHEN d.level = 'JUCO' THEN 'NWAC' ELSE 'Portal' END AS src
            FROM players p
            JOIN teams t ON t.id = p.team_id
            JOIN conferences c ON c.id = t.conference_id
            JOIN divisions d ON d.id = c.division_id
            WHERE COALESCE(p.is_committed, 0) = 0
              AND (
                    d.level = 'JUCO'
                 OR p.id IN (SELECT player_id FROM transfer_portal_members)
                 OR p.id IN (SELECT spl.spring_player_id FROM wcl_portal_members w
                             JOIN summer_player_links spl ON spl.summer_player_id = w.summer_player_id)
              )
        """)
        pool = {r["id"]: dict(r) for r in cur.fetchall()}
        if not pool:
            return {"results": [], "count": 0, "note": "No uncommitted players found."}
        pids = list(pool.keys())

        # ── 2. Box / advanced stats (latest season for each pooled player) ──
        cur.execute("""
            SELECT DISTINCT ON (player_id) player_id, season, plate_appearances,
                   batting_avg, on_base_pct, slugging_pct, ops, woba, wrc_plus, iso, wobacon,
                   babip, k_pct, bb_pct, home_runs, stolen_bases, doubles, triples
            FROM batting_stats
            WHERE player_id = ANY(%s) AND season = %s AND plate_appearances >= %s
            ORDER BY player_id, season DESC
        """, (pids, season, MIN_PA))
        box = {r["player_id"]: dict(r) for r in cur.fetchall()}

        # ── 3. PBP advanced stats (air-pull/contact/whiff/GB) from game_events ──
        cur.execute("""
            WITH pbp AS (
              SELECT ge.batter_player_id pid,
                SUM(LENGTH(pitch_sequence)-LENGTH(REPLACE(pitch_sequence,'S',''))) sp,
                SUM(LENGTH(pitch_sequence)-LENGTH(REPLACE(pitch_sequence,'F',''))) fp,
                SUM(CASE WHEN was_in_play THEN 1 ELSE 0 END) inp,
                COUNT(*) FILTER (WHERE bb_type IS NOT NULL) bbt,
                COUNT(*) FILTER (WHERE bb_type IN ('LD','FB')
                   AND ((pl.bats='R' AND field_zone='LEFT') OR (pl.bats='L' AND field_zone='RIGHT'))) apc,
                COUNT(*) FILTER (WHERE bb_type='GB') gb
              FROM game_events ge
              JOIN games g ON g.id = ge.game_id
              JOIN players pl ON pl.id = ge.batter_player_id
              WHERE g.season = %s AND ge.batter_player_id = ANY(%s)
              GROUP BY ge.batter_player_id
            )
            SELECT pid, bbt,
              (fp+inp)::float/NULLIF(sp+fp+inp,0) contact_pct,
              sp::float/NULLIF(sp+fp+inp,0) whiff_pct,
              apc::float/NULLIF(bbt,0) air_pull_pct,
              gb::float/NULLIF(bbt,0) gb_pct
            FROM pbp
        """, (season, pids))
        pbp = {r["pid"]: dict(r) for r in cur.fetchall()}

        # ── 4. Percentile reference distributions (qualified college hitters) ──
        ref = {}
        for key, (col, _lbl, _hb) in HITTER_STATS.items():
            if col == "pbp":
                continue
            cur.execute(f"""SELECT {col} v FROM batting_stats
                           WHERE season = %s AND plate_appearances >= %s AND {col} IS NOT NULL""",
                        (season, QUAL_PA))
            ref[key] = sorted(float(r["v"]) for r in cur.fetchall())
        # PBP reference (qualified by batted-ball sample)
        cur.execute("""
            WITH pbp AS (
              SELECT ge.batter_player_id pid,
                SUM(LENGTH(pitch_sequence)-LENGTH(REPLACE(pitch_sequence,'S',''))) sp,
                SUM(LENGTH(pitch_sequence)-LENGTH(REPLACE(pitch_sequence,'F',''))) fp,
                SUM(CASE WHEN was_in_play THEN 1 ELSE 0 END) inp,
                COUNT(*) FILTER (WHERE bb_type IS NOT NULL) bbt,
                COUNT(*) FILTER (WHERE bb_type IN ('LD','FB')
                   AND ((pl.bats='R' AND field_zone='LEFT') OR (pl.bats='L' AND field_zone='RIGHT'))) apc,
                COUNT(*) FILTER (WHERE bb_type='GB') gb
              FROM game_events ge JOIN games g ON g.id=ge.game_id
              JOIN players pl ON pl.id=ge.batter_player_id
              WHERE g.season=%s GROUP BY ge.batter_player_id
            )
            SELECT (fp+inp)::float/NULLIF(sp+fp+inp,0) contact_pct,
                   sp::float/NULLIF(sp+fp+inp,0) whiff_pct,
                   apc::float/NULLIF(bbt,0) air_pull_pct,
                   gb::float/NULLIF(bbt,0) gb_pct
            FROM pbp WHERE bbt >= %s
        """, (season, MIN_BBT))
        pbp_ref_rows = cur.fetchall()
        for key in PBP_STATS:
            ref[key] = sorted(float(r[key]) for r in pbp_ref_rows if r[key] is not None)

    # ── 5. Build candidate rows (must have box stats; attach pbp + percentiles) ──
    def stat_value(pid, key):
        col = HITTER_STATS[key][0]
        if col == "pbp":
            p = pbp.get(pid)
            return p.get(key) if p else None
        b = box.get(pid)
        return None if b is None else b.get(col)

    def goodness_pct(key, val):
        p = _pct(ref.get(key, []), val)
        if p is None:
            return None
        return round(100.0 - p, 1) if not HITTER_STATS[key][2] else p

    pos_re = POSITION_GROUPS.get(body.position, None)
    import re
    pos_pat = re.compile(pos_re, re.I) if pos_re else None

    rows = []
    for pid, info in pool.items():
        if pid not in box:                      # need real batting stats
            continue
        if body.bats in ("L", "R", "S") and (info.get("bats") or "") != body.bats:
            continue
        if pos_pat and not pos_pat.search(info.get("position") or ""):
            continue
        stats, pcts = {}, {}
        for key in HITTER_STATS:
            v = stat_value(pid, key)
            stats[key] = v
            pcts[key] = goodness_pct(key, v)
        rows.append({
            "player_id": pid, "name": f"{info['first_name']} {info['last_name']}",
            "position": info["position"], "bats": info["bats"], "team": info["team"],
            "level": info["level"], "source": info["src"], "year": info["year_in_school"],
            "pa": box[pid]["plate_appearances"], "season": box[pid]["season"],
            "stats": stats, "pcts": pcts,
        })

    # ── 6. Apply filters ──
    def passes(row, f: Filter):
        if f.stat not in HITTER_STATS:
            return True
        series = row["pcts"] if f.mode == "percentile" else row["stats"]
        v = series.get(f.stat)
        if v is None:
            return False
        return v >= f.value if f.op == "min" else v <= f.value
    for f in body.filters:
        rows = [r for r in rows if passes(r, f)]

    # ── 7. Score / sort ──
    arch = ARCHETYPES.get(body.archetype) if body.archetype else None
    if arch:
        for r in rows:
            num = den = 0.0
            for key, w in arch["weights"].items():
                gp = r["pcts"].get(key)
                if gp is not None:
                    num += w * gp; den += w
            r["score"] = round(num / den, 1) if den else None
        rows.sort(key=lambda r: (r["score"] is not None, r["score"] or 0), reverse=True)
    elif body.sort and body.sort in HITTER_STATS:
        rows.sort(key=lambda r: (r["pcts"].get(body.sort) is not None, r["pcts"].get(body.sort) or 0), reverse=True)
    else:
        rows.sort(key=lambda r: (r["stats"].get("wrc_plus") is not None, r["stats"].get("wrc_plus") or 0), reverse=True)

    total = len(rows)
    return {
        "results": rows[: max(1, min(body.limit, 200))],
        "count": total,
        "pool_size": len(pool),
        "archetype": arch["label"] if arch else None,
        "stat_meta": {k: {"label": v[1], "higher_better": v[2], "pbp": v[0] == "pbp"} for k, v in HITTER_STATS.items()},
    }


@router.get("/meta")
def meta(_uid: str = Depends(_gate)):
    """Static config for the UI: stats, archetypes, positions."""
    return {
        "stats": [{"key": k, "label": v[1], "higher_better": v[2], "pbp": v[0] == "pbp"} for k, v in HITTER_STATS.items()],
        "archetypes": [{"key": k, "label": v["label"], "stats": list(v["weights"].keys())} for k, v in ARCHETYPES.items()],
        "positions": list(POSITION_GROUPS.keys()),
    }
