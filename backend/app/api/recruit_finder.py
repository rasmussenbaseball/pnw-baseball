"""
Recruit Finder — search uncommitted players by position + predictive stats/archetypes.

Pools UNCOMMITTED players from three groups (deduped on the spring player_id):
  1. NWAC (JUCO) players
  2. PNW four-year players in the transfer portal (transfer_portal_members)
  3. WCL summer-portal players that link to a spring player (wcl_portal_members)

Two sides: HITTERS and PITCHERS. Archetypes are wide-net blends of PREDICTIVE stats
(K%/BB%/whiff%/strike%/GB%/FIP/xFIP for arms; ISO/wOBACON/air-pull%/contact% for bats).
AVG and ERA are de-emphasized. Custom filters work by raw value (FIP <= 3.50) or by
"goodness" percentile ("top 75th percentile K%"), where goodness always means
better-player regardless of whether high or low is good.
"""
import re
import bisect
from typing import Optional, List

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from ..models.database import get_connection
from ..config import CURRENT_SEASON
from .auth import require_tier

router = APIRouter(prefix="/recruit-finder", tags=["recruit-finder"])
_gate = require_tier("recruiting")

# stat key -> (source column | 'pbp' | '__kbb', label, higher_is_better)
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
PITCHER_STATS = {
    "k_pct":      ("k_pct", "K%", True),
    "bb_pct":     ("bb_pct", "BB%", False),
    "k_bb":       ("__kbb", "K-BB%", True),
    "fip":        ("fip", "FIP", False),
    "xfip":       ("xfip", "xFIP", False),
    "siera":      ("siera", "SIERA", False),
    "whip":       ("whip", "WHIP", False),
    "era":        ("era", "ERA", False),
    "hr9":        ("hr_per_9", "HR/9", False),
    "k9":         ("k_per_9", "K/9", True),
    "babip_against": ("babip_against", "BABIP", False),
    "strike_pct": ("pbp", "Strike%", True),
    "whiff_pct":  ("pbp", "Whiff%", True),
    "gb_pct":     ("pbp", "GB%", True),
}

HITTER_ARCHETYPES = {
    "power":      {"label": "Power", "weights": {"iso": 1.0, "wobacon": 1.0, "hr": 0.7, "air_pull_pct": 0.8}},
    "contact":    {"label": "Pure Hitter / Contact", "weights": {"contact_pct": 1.0, "k_pct": 1.0, "wobacon": 0.6}},
    "onbase":     {"label": "On-Base / Discipline", "weights": {"bb_pct": 1.0, "obp": 0.8, "k_pct": 0.6, "contact_pct": 0.6}},
    "athlete":    {"label": "Athlete / Speed", "weights": {"sb": 1.0, "doubles": 0.6, "triples": 0.5}},
    "allaround":  {"label": "Best Available (all-around)", "weights": {"wrc_plus": 1.0, "woba": 0.8, "iso": 0.6, "bb_pct": 0.4}},
}
PITCHER_ARCHETYPES = {
    "power":      {"label": "Power Arm / Strikeout", "weights": {"k_pct": 1.0, "whiff_pct": 0.9, "k_bb": 0.7}},
    "command":    {"label": "Command / Control", "weights": {"bb_pct": 1.0, "strike_pct": 0.8, "k_bb": 0.6}},
    "groundball": {"label": "Groundball", "weights": {"gb_pct": 1.0, "hr9": 0.6}},
    "prevention": {"label": "Run Prevention (best arm)", "weights": {"fip": 1.0, "xfip": 0.8, "k_bb": 0.6}},
    "swingmiss":  {"label": "Swing & Miss", "weights": {"whiff_pct": 1.0, "k_pct": 0.9}},
}

HITTER_POSITIONS = {
    "any": None,
    "c":          r"(^|/)C(/|$)",
    "if":         r"(^|/)(1B|2B|3B|SS|IF)(/|$)",
    "1b":         r"(^|/)1B(/|$)", "2b": r"(^|/)2B(/|$)", "ss": r"(^|/)SS(/|$)", "3b": r"(^|/)3B(/|$)",
    "mid_if":     r"(^|/)(2B|SS)(/|$)",
    "corner_if":  r"(^|/)(1B|3B)(/|$)",
    "of":         r"(^|/)(OF|LF|CF|RF)(/|$)",
    "corner_of":  r"(^|/)(OF|LF|RF)(/|$)",
    "cf":         r"(^|/)CF(/|$)",
}
# pitcher position -> throws letter, or None for "any pitcher"
PITCHER_POSITIONS = {"any_p": None, "rhp": "R", "lhp": "L"}

MIN_PA, QUAL_PA = 25, 50
MIN_BF, QUAL_BF = 25, 40
MIN_BBT = 20          # qualified batted-ball sample for the percentile reference
CAND_MIN_BBT = 12     # a candidate needs this many batted balls for their OWN rate stats

HIT_COLS = ("batting_avg, on_base_pct, slugging_pct, ops, woba, wrc_plus, iso, wobacon, "
            "babip, k_pct, bb_pct, home_runs, stolen_bases, doubles, triples")
PIT_COLS = ("era, fip, xfip, siera, whip, k_pct, bb_pct, hr_per_9, k_per_9, bb_per_9, babip_against")


class Filter(BaseModel):
    stat: str
    mode: str = "value"
    op: str = "min"
    value: float


class FinderQuery(BaseModel):
    side: str = "bat"        # 'bat' | 'pit'
    position: str = "any"
    bats: str = "any"        # hitters: bats L/R/S; ignored for pitchers (position carries RHP/LHP)
    source: str = "any"      # 'any' | 'nwac' | 'portal' | 'wcl'
    year: str = "any"
    archetype: Optional[str] = None
    filters: List[Filter] = []
    sort: Optional[str] = None
    season: int = CURRENT_SEASON
    limit: int = 80


def _pct(sorted_vals, v):
    if v is None or not sorted_vals:
        return None
    return round(100.0 * bisect.bisect_left(sorted_vals, v) / len(sorted_vals), 1)


@router.post("/search")
def search(body: FinderQuery, _uid: str = Depends(_gate)):
    side = "pit" if body.side == "pit" else "bat"
    STATS = PITCHER_STATS if side == "pit" else HITTER_STATS
    ARCHE = PITCHER_ARCHETYPES if side == "pit" else HITTER_ARCHETYPES
    season = body.season or CURRENT_SEASON
    pbp_keys = {k for k, v in STATS.items() if v[0] == "pbp"}

    with get_connection() as conn:
        cur = conn.cursor()

        # ── pool ──
        cur.execute("""
            SELECT p.id, p.first_name, p.last_name, p.position, p.bats, p.throws, p.year_in_school,
                   t.short_name AS team, d.level,
                   (d.level = 'JUCO') AS is_nwac,
                   (p.id IN (SELECT player_id FROM transfer_portal_members)) AS is_portal,
                   (p.id IN (SELECT spl.spring_player_id FROM wcl_portal_members w
                             JOIN summer_player_links spl ON spl.summer_player_id = w.summer_player_id)) AS is_wcl
            FROM players p
            JOIN teams t ON t.id = p.team_id
            JOIN conferences c ON c.id = t.conference_id
            JOIN divisions d ON d.id = c.division_id
            WHERE COALESCE(p.is_committed, 0) = 0
              AND ( d.level = 'JUCO'
                 OR p.id IN (SELECT player_id FROM transfer_portal_members)
                 OR p.id IN (SELECT spl.spring_player_id FROM wcl_portal_members w
                             JOIN summer_player_links spl ON spl.summer_player_id = w.summer_player_id) )
        """)
        pool = {r["id"]: dict(r) for r in cur.fetchall()}
        if not pool:
            return {"results": [], "count": 0, "note": "No uncommitted players found."}
        pids = list(pool.keys())

        # ── box / advanced stats ──
        if side == "pit":
            cur.execute(f"""SELECT DISTINCT ON (player_id) player_id, season, batters_faced sample, {PIT_COLS}
                            FROM pitching_stats WHERE player_id = ANY(%s) AND season=%s AND batters_faced >= %s
                            ORDER BY player_id, season DESC""", (pids, season, MIN_BF))
        else:
            cur.execute(f"""SELECT DISTINCT ON (player_id) player_id, season, plate_appearances sample, {HIT_COLS}
                            FROM batting_stats WHERE player_id = ANY(%s) AND season=%s AND plate_appearances >= %s
                            ORDER BY player_id, season DESC""", (pids, season, MIN_PA))
        box = {r["player_id"]: dict(r) for r in cur.fetchall()}

        # ── PBP advanced stats from game_events ──
        if side == "pit":
            cur.execute("""
                WITH pbp AS (
                  SELECT ge.pitcher_player_id pid, SUM(pitches_thrown) pit,
                    SUM(LENGTH(pitch_sequence)-LENGTH(REPLACE(pitch_sequence,'S',''))) sp,
                    SUM(LENGTH(pitch_sequence)-LENGTH(REPLACE(pitch_sequence,'F',''))) fp,
                    SUM(LENGTH(pitch_sequence)-LENGTH(REPLACE(pitch_sequence,'K',''))) cs,
                    SUM(CASE WHEN was_in_play THEN 1 ELSE 0 END) inp,
                    COUNT(*) FILTER (WHERE bb_type IS NOT NULL) bbt,
                    COUNT(*) FILTER (WHERE bb_type='GB') gb
                  FROM game_events ge JOIN games g ON g.id=ge.game_id
                  WHERE g.season=%s AND ge.pitcher_player_id = ANY(%s)
                  GROUP BY ge.pitcher_player_id
                )
                SELECT pid, bbt, (cs+sp+fp+inp)::float/NULLIF(pit,0) strike_pct,
                       sp::float/NULLIF(sp+fp+inp,0) whiff_pct, gb::float/NULLIF(bbt,0) gb_pct
                FROM pbp
            """, (season, pids))
        else:
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
                  WHERE g.season=%s AND ge.batter_player_id = ANY(%s)
                  GROUP BY ge.batter_player_id
                )
                SELECT pid, bbt, (fp+inp)::float/NULLIF(sp+fp+inp,0) contact_pct,
                       sp::float/NULLIF(sp+fp+inp,0) whiff_pct,
                       apc::float/NULLIF(bbt,0) air_pull_pct, gb::float/NULLIF(bbt,0) gb_pct
                FROM pbp
            """, (season, pids))
        pbp = {r["pid"]: dict(r) for r in cur.fetchall()}
        # batted-ball rates (GB%, Air-Pull%) need a real sample; null them otherwise
        # so a 3-grounder cameo doesn't post a 100th-percentile GB%.
        for pr in pbp.values():
            if (pr.get("bbt") or 0) < CAND_MIN_BBT:
                for k in ("gb_pct", "air_pull_pct"):
                    if k in pr:
                        pr[k] = None

        # ── percentile reference distributions (qualified college players) ──
        ref = {}
        tbl = "pitching_stats" if side == "pit" else "batting_stats"
        qcol, qmin = ("batters_faced", QUAL_BF) if side == "pit" else ("plate_appearances", QUAL_PA)
        for key, (col, _lbl, _hb) in STATS.items():
            if col == "pbp":
                continue
            expr = "(k_pct - bb_pct)" if col == "__kbb" else col
            cur.execute(f"SELECT {expr} v FROM {tbl} WHERE season=%s AND {qcol} >= %s AND {expr} IS NOT NULL",
                        (season, qmin))
            ref[key] = sorted(float(r["v"]) for r in cur.fetchall())
        # PBP reference
        if pbp_keys:
            if side == "pit":
                cur.execute("""WITH pbp AS (
                      SELECT ge.pitcher_player_id pid, SUM(pitches_thrown) pit,
                        SUM(LENGTH(pitch_sequence)-LENGTH(REPLACE(pitch_sequence,'S',''))) sp,
                        SUM(LENGTH(pitch_sequence)-LENGTH(REPLACE(pitch_sequence,'F',''))) fp,
                        SUM(LENGTH(pitch_sequence)-LENGTH(REPLACE(pitch_sequence,'K',''))) cs,
                        SUM(CASE WHEN was_in_play THEN 1 ELSE 0 END) inp,
                        COUNT(*) FILTER (WHERE bb_type IS NOT NULL) bbt, COUNT(*) FILTER (WHERE bb_type='GB') gb
                      FROM game_events ge JOIN games g ON g.id=ge.game_id WHERE g.season=%s GROUP BY ge.pitcher_player_id)
                    SELECT (cs+sp+fp+inp)::float/NULLIF(pit,0) strike_pct, sp::float/NULLIF(sp+fp+inp,0) whiff_pct,
                           gb::float/NULLIF(bbt,0) gb_pct FROM pbp WHERE bbt >= %s""", (season, MIN_BBT))
            else:
                cur.execute("""WITH pbp AS (
                      SELECT ge.batter_player_id pid,
                        SUM(LENGTH(pitch_sequence)-LENGTH(REPLACE(pitch_sequence,'S',''))) sp,
                        SUM(LENGTH(pitch_sequence)-LENGTH(REPLACE(pitch_sequence,'F',''))) fp,
                        SUM(CASE WHEN was_in_play THEN 1 ELSE 0 END) inp,
                        COUNT(*) FILTER (WHERE bb_type IS NOT NULL) bbt,
                        COUNT(*) FILTER (WHERE bb_type IN ('LD','FB') AND ((pl.bats='R' AND field_zone='LEFT') OR (pl.bats='L' AND field_zone='RIGHT'))) apc,
                        COUNT(*) FILTER (WHERE bb_type='GB') gb
                      FROM game_events ge JOIN games g ON g.id=ge.game_id JOIN players pl ON pl.id=ge.batter_player_id
                      WHERE g.season=%s GROUP BY ge.batter_player_id)
                    SELECT (fp+inp)::float/NULLIF(sp+fp+inp,0) contact_pct, sp::float/NULLIF(sp+fp+inp,0) whiff_pct,
                           apc::float/NULLIF(bbt,0) air_pull_pct, gb::float/NULLIF(bbt,0) gb_pct FROM pbp WHERE bbt >= %s""", (season, MIN_BBT))
            prows = cur.fetchall()
            for key in pbp_keys:
                ref[key] = sorted(float(r[key]) for r in prows if r[key] is not None)

    # ── build candidate rows ──
    def stat_value(pid, key):
        col = STATS[key][0]
        if col == "pbp":
            p = pbp.get(pid)
            return p.get(key) if p else None
        b = box.get(pid)
        if b is None:
            return None
        if col == "__kbb":
            k, bb = b.get("k_pct"), b.get("bb_pct")
            return None if k is None or bb is None else k - bb
        return b.get(col)

    def goodness_pct(key, val):
        p = _pct(ref.get(key, []), val)
        if p is None:
            return None
        return round(100.0 - p, 1) if not STATS[key][2] else p

    pos_re = HITTER_POSITIONS.get(body.position) if side == "bat" else None
    pos_pat = re.compile(pos_re, re.I) if pos_re else None
    pit_throws = PITCHER_POSITIONS.get(body.position) if side == "pit" else None

    rows = []
    for pid, info in pool.items():
        if pid not in box:
            continue
        if side == "bat":
            if body.bats in ("L", "R", "S") and (info.get("bats") or "") != body.bats:
                continue
            if pos_pat and not pos_pat.search(info.get("position") or ""):
                continue
        else:
            if pit_throws and (info.get("throws") or "") != pit_throws:
                continue
        if body.source == "nwac" and not info.get("is_nwac"):
            continue
        if body.source == "portal" and not info.get("is_portal"):
            continue
        if body.source == "wcl" and not info.get("is_wcl"):
            continue
        if body.year != "any" and body.year.lower() not in (info.get("year_in_school") or "").lower():
            continue
        src = "NWAC" if info.get("is_nwac") else ("Portal" if info.get("is_portal") else "WCL")
        stats = {k: stat_value(pid, k) for k in STATS}
        pcts = {k: goodness_pct(k, stats[k]) for k in STATS}
        rows.append({
            "player_id": pid, "name": f"{info['first_name']} {info['last_name']}",
            "position": info["position"], "bats": info["bats"], "throws": info["throws"],
            "team": info["team"], "level": info["level"], "source": src, "year": info["year_in_school"],
            "sample": box[pid]["sample"], "season": box[pid]["season"], "stats": stats, "pcts": pcts,
        })

    # ── filters ──
    def passes(row, f: Filter):
        if f.stat not in STATS:
            return True
        v = (row["pcts"] if f.mode == "percentile" else row["stats"]).get(f.stat)
        if v is None:
            return False
        return v >= f.value if f.op == "min" else v <= f.value
    for f in body.filters:
        rows = [r for r in rows if passes(r, f)]

    # ── score / sort ──
    arch = ARCHE.get(body.archetype) if body.archetype else None
    if arch:
        total_w = sum(arch["weights"].values())
        for r in rows:
            num = den = 0.0
            for key, w in arch["weights"].items():
                gp = r["pcts"].get(key)
                if gp is not None:
                    num += w * gp; den += w
            # need >=half the archetype's weight backed by real data, else don't
            # rank them on a leftover secondary stat (e.g. a 0-HR cameo as "groundball")
            r["score"] = round(num / den, 1) if den >= 0.5 * total_w else None
        rows.sort(key=lambda r: (r["score"] is not None, r["score"] or 0), reverse=True)
    elif body.sort and body.sort in STATS:
        rows.sort(key=lambda r: (r["pcts"].get(body.sort) is not None, r["pcts"].get(body.sort) or 0), reverse=True)
    else:
        default = "k_bb" if side == "pit" else "wrc_plus"
        rows.sort(key=lambda r: (r["pcts"].get(default) is not None, r["pcts"].get(default) or 0), reverse=True)

    return {
        "results": rows[: max(1, min(body.limit, 200))],
        "count": len(rows), "pool_size": len(pool),
        "side": side, "archetype": arch["label"] if arch else None,
    }


def _meta_for(stats, arches, positions):
    return {
        "stats": [{"key": k, "label": v[1], "higher_better": v[2], "pbp": v[0] == "pbp"} for k, v in stats.items()],
        "archetypes": [{"key": k, "label": v["label"], "stats": list(v["weights"].keys())} for k, v in arches.items()],
        "positions": list(positions.keys()),
    }


@router.get("/meta")
def meta(_uid: str = Depends(_gate)):
    return {
        "bat": _meta_for(HITTER_STATS, HITTER_ARCHETYPES, HITTER_POSITIONS),
        "pit": _meta_for(PITCHER_STATS, PITCHER_ARCHETYPES, PITCHER_POSITIONS),
    }
