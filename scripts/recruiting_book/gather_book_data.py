"""Collect everything the PNW college baseball book needs, per team, into
scripts/recruiting_book/book_data.json.

For each program:
- profile (from recruiting_programs JSON snapshot)
- season_2026 + seasons history (from team_season_stats)
- top 5 hitters and top 5 pitchers for 2026 (from batting_stats / pitching_stats,
  the canonical per-player rows the site uses)
- team batting line + team pitching line (aggregated from batting_stats /
  pitching_stats so totals match the team page, per CLAUDE.md)
- conference standings for 2026 (full conference, all PNW + non-PNW members)
- composite national ranking + best-source national rank (when present)
- 2026 roster breakdown by position
- resolved local logo path
"""
import json
from pathlib import Path

from app.models.database import get_connection

REPO = Path(__file__).resolve().parent.parent.parent
PROFILES = json.loads((REPO / "backend/app/data/recruiting_programs.json").read_text())
LOGO_DIR = REPO / "frontend/public/logos"
OUT = Path(__file__).resolve().parent / "book_data.json"
SEASON = 2026

# ---------- pro-alumni lookup (from backend/data/pro_alumni.json) ----------
PRO_ALUMNI_PATH = REPO / "backend/data/pro_alumni.json"
_LEVEL_RANK = {"MLB": 0, "AAA": 1, "AA": 2, "A+": 3, "A": 4, "Rk": 5}

def _load_pro_alumni():
    if not PRO_ALUMNI_PATH.exists():
        return {}
    payload = json.loads(PRO_ALUMNI_PATH.read_text())
    by_team = {}
    for p in payload.get("players", []):
        for tid in p.get("college_team_ids") or []:
            by_team.setdefault(tid, []).append(p)
    for tid, lst in by_team.items():
        lst.sort(key=lambda x: (_LEVEL_RANK.get(x.get("level"), 99),
                                 -(x.get("year_drafted") or 0),
                                 x.get("name") or ""))
    return by_team

PRO_ALUMNI = _load_pro_alumni()


def fetch_recruiting_guide(team_id):
    """Call the same recruiting-guide endpoint the website uses, pulling out
    the freshman_production, transfer_production, and roster_composition
    series so the book can show the same multi-season recruiting graphics
    that live on the site."""
    try:
        from app.api.routes import get_recruiting_guide
        result = get_recruiting_guide(team_id)
        if not isinstance(result, dict):
            return None
        return {
            "freshman_production": result.get("freshman_production") or [],
            "transfer_production": result.get("transfer_production") or [],
            "roster_composition": result.get("roster_composition") or [],
        }
    except Exception as e:
        print(f"  (recruiting guide fetch failed for team {team_id}: {e})")
        return None


def fetch_level_norms(cur, season=SEASON):
    """Compute real division-level averages for 2026 from the actual data.

    We use plate-appearance-weighted batting averages and inning-pitched-weighted
    ERA so that a team that played 200 PA doesn't get equal weight to one that
    played 2000. R/G is the simple mean of team season R/G figures, which is
    what most reporting compares against. This replaces the previous hardcoded
    norm table — NWAC AVG in particular was about .035 too high there.
    """
    # PA-weighted batting & rate stats per division.
    cur.execute("""
        SELECT d.level,
               SUM(b.hits)::float / NULLIF(SUM(b.at_bats), 0)              AS avg,
               (SUM(b.hits + b.walks + b.hit_by_pitch)::float
                / NULLIF(SUM(b.at_bats + b.walks + b.hit_by_pitch + b.sacrifice_flies), 0))
                  + (SUM((b.hits - b.doubles - b.triples - b.home_runs)
                          + 2 * b.doubles + 3 * b.triples + 4 * b.home_runs)::float
                     / NULLIF(SUM(b.at_bats), 0))                          AS ops,
               SUM(b.hits) AS h, SUM(b.at_bats) AS ab
        FROM batting_stats b
        JOIN teams t ON t.id = b.team_id
        JOIN conferences c ON c.id = t.conference_id
        JOIN divisions d ON d.id = c.division_id
        WHERE b.season = %s
        GROUP BY d.level
    """, (season,))
    bat = {r["level"]: dict(r) for r in cur.fetchall()}

    # ERA weighted by innings, using baseball-notation outs.
    cur.execute("""
        SELECT d.level, ps.innings_pitched, ps.earned_runs
        FROM pitching_stats ps
        JOIN teams t ON t.id = ps.team_id
        JOIN conferences c ON c.id = t.conference_id
        JOIN divisions d ON d.id = c.division_id
        WHERE ps.season = %s
    """, (season,))
    outs = {}
    er = {}
    for r in cur.fetchall():
        ip = r["innings_pitched"] or 0
        whole = int(ip)
        tenths = round((float(ip) - whole) * 10)
        outs[r["level"]] = outs.get(r["level"], 0) + whole * 3 + min(tenths, 2)
        er[r["level"]] = er.get(r["level"], 0) + (r["earned_runs"] or 0)

    # R/G computed from per-player batting_stats so the level norm uses the
    # same data source as the per-team R/G the book renders (team_batting.r
    # divided by games played). Using team_season_stats.runs_scored gives a
    # much lower number because that column is incomplete in our data set.
    cur.execute("""
        SELECT d.level, b.team_id, SUM(b.runs) AS team_runs,
               (tss.wins + tss.losses) AS games
        FROM batting_stats b
        JOIN team_season_stats tss ON tss.team_id = b.team_id AND tss.season = b.season
        JOIN teams t ON t.id = b.team_id
        JOIN conferences c ON c.id = t.conference_id
        JOIN divisions d ON d.id = c.division_id
        WHERE b.season = %s
        GROUP BY d.level, b.team_id, tss.wins, tss.losses
        HAVING (tss.wins + tss.losses) > 0
    """, (season,))
    by_level_rpg = {}
    for r in cur.fetchall():
        lv = r["level"]
        if (r["games"] or 0) <= 0 or not r["team_runs"]:
            continue
        by_level_rpg.setdefault(lv, []).append(float(r["team_runs"]) / float(r["games"]))
    rpg = {lv: (sum(vs) / len(vs)) for lv, vs in by_level_rpg.items() if vs}

    # Map d.level (e.g. "JUCO") to the division key the book uses ("NWAC").
    KEY_FIX = {"JUCO": "NWAC"}
    norms = {}
    for level, b in bat.items():
        key = KEY_FIX.get(level, level)
        ip_decimal = (outs.get(level, 0) / 3.0) if outs.get(level) else 0
        era_val = (9 * er.get(level, 0) / ip_decimal) if ip_decimal else 0
        norms[key] = {
            "avg": round(float(b["avg"] or 0), 3),
            "ops": round(float(b["ops"] or 0), 3),
            "era": round(era_val, 2),
            "rpg": round(rpg.get(level, 0), 2),
        }
    return norms


def logo_path(logo_url):
    if not logo_url:
        return None
    rel = logo_url.lstrip("/")
    if rel.startswith("logos/"):
        rel = rel[len("logos/"):]
    p = LOGO_DIR / rel
    return str(p) if p.exists() else None


# ---------- per-team queries ------------------------------------------------

def fetch_seasons(cur, tid):
    cur.execute("""
        SELECT season, wins, losses, ties, conference_wins, conference_losses,
               runs_scored, runs_allowed, run_differential,
               team_batting_avg, team_era, team_ops, team_whip, team_fielding_pct,
               pythagorean_win_pct
        FROM team_season_stats
        WHERE team_id=%s
        ORDER BY season DESC
    """, (tid,))
    return [dict(r) for r in cur.fetchall()]


def fetch_top_hitters(cur, tid, season, limit=5, min_pa=40):
    """Top hitters by Offensive WAR (DESC). WAR rewards both rate and volume
    so it does a better job picking the team's most-valuable bat than OPS."""
    cur.execute("""
        SELECT (p.first_name || ' ' || p.last_name) AS name,
               p.position, p.year_in_school, p.hometown,
               b.games, b.plate_appearances, b.at_bats,
               b.hits, b.doubles, b.triples, b.home_runs, b.rbi,
               b.walks, b.strikeouts, b.stolen_bases,
               b.batting_avg, b.on_base_pct, b.slugging_pct, b.ops,
               b.wrc_plus, b.iso, b.bb_pct, b.k_pct,
               b.offensive_war
        FROM batting_stats b
        JOIN players p ON p.id = b.player_id
        WHERE b.team_id=%s AND b.season=%s AND COALESCE(b.plate_appearances,0) >= %s
        ORDER BY b.offensive_war DESC NULLS LAST, b.ops DESC NULLS LAST
        LIMIT %s
    """, (tid, season, min_pa, limit))
    return [dict(r) for r in cur.fetchall()]


def fetch_top_pitchers(cur, tid, season, limit=5, min_ip=15):
    """Top pitchers by Pitching WAR (DESC). WAR rewards a pitcher who
    threw a lot of solid innings over one who had a tiny-sample low ERA."""
    cur.execute("""
        SELECT (p.first_name || ' ' || p.last_name) AS name,
               p.position, p.year_in_school, p.hometown,
               ps.games, ps.games_started, ps.wins, ps.losses, ps.saves,
               ps.innings_pitched, ps.hits_allowed, ps.runs_allowed, ps.earned_runs,
               ps.walks, ps.strikeouts, ps.home_runs_allowed,
               ps.era, ps.whip, ps.k_per_9, ps.bb_per_9,
               ps.k_pct, ps.bb_pct, ps.fip, ps.era_minus, ps.pitching_war
        FROM pitching_stats ps
        JOIN players p ON p.id = ps.player_id
        WHERE ps.team_id=%s AND ps.season=%s AND COALESCE(ps.innings_pitched,0) >= %s
        ORDER BY ps.pitching_war DESC NULLS LAST, ps.era ASC NULLS LAST
        LIMIT %s
    """, (tid, season, min_ip, limit))
    return [dict(r) for r in cur.fetchall()]


def fetch_team_batting_line(cur, tid, season):
    """Aggregate the canonical team batting line from per-player rows
    (CLAUDE.md rule: team aggregates always source from batting_stats)."""
    cur.execute("""
        SELECT
            COALESCE(SUM(plate_appearances), 0) AS pa,
            COALESCE(SUM(at_bats), 0) AS ab,
            COALESCE(SUM(hits), 0) AS h,
            COALESCE(SUM(doubles), 0) AS doubles,
            COALESCE(SUM(triples), 0) AS triples,
            COALESCE(SUM(home_runs), 0) AS hr,
            COALESCE(SUM(rbi), 0) AS rbi,
            COALESCE(SUM(runs), 0) AS r,
            COALESCE(SUM(walks), 0) AS bb,
            COALESCE(SUM(hit_by_pitch), 0) AS hbp,
            COALESCE(SUM(sacrifice_flies), 0) AS sf,
            COALESCE(SUM(strikeouts), 0) AS so,
            COALESCE(SUM(stolen_bases), 0) AS sb,
            COALESCE(SUM(caught_stealing), 0) AS cs
        FROM batting_stats WHERE team_id=%s AND season=%s
    """, (tid, season))
    row = cur.fetchone()
    if not row or not row["ab"]:
        return None
    d = dict(row)
    ab, h, doubles, triples, hr = d["ab"], d["h"], d["doubles"], d["triples"], d["hr"]
    bb, hbp, sf, pa = d["bb"], d["hbp"], d["sf"], d["pa"]
    singles = h - doubles - triples - hr
    tb = singles + 2 * doubles + 3 * triples + 4 * hr
    avg = h / ab if ab else 0
    obp_den = ab + bb + hbp + sf
    obp = (h + bb + hbp) / obp_den if obp_den else 0
    slg = tb / ab if ab else 0
    ops = obp + slg
    d.update({"avg": avg, "obp": obp, "slg": slg, "ops": ops, "tb": tb, "singles": singles})
    return d


def fetch_team_pitching_line(cur, tid, season):
    """Aggregate the team pitching line from per-player rows.
    Innings_pitched is baseball notation (6.2 = 6 2/3 innings = 20 outs)."""
    cur.execute("""
        SELECT innings_pitched, earned_runs, hits_allowed, walks, strikeouts,
               home_runs_allowed, hit_batters, runs_allowed, batters_faced
        FROM pitching_stats WHERE team_id=%s AND season=%s
    """, (tid, season))
    rows = cur.fetchall()
    if not rows:
        return None
    total_outs = 0
    er = h = bb = so = hra = hbp = ra = bf = 0
    for r in rows:
        ip = r["innings_pitched"]
        if ip is not None:
            whole = int(ip)
            tenths = round((float(ip) - whole) * 10)
            total_outs += whole * 3 + min(tenths, 2)
        er += r["earned_runs"] or 0
        h += r["hits_allowed"] or 0
        bb += r["walks"] or 0
        so += r["strikeouts"] or 0
        hra += r["home_runs_allowed"] or 0
        hbp += r["hit_batters"] or 0
        ra += r["runs_allowed"] or 0
        bf += r["batters_faced"] or 0
    ip_decimal = total_outs / 3.0 if total_outs else 0
    era = (9 * er / ip_decimal) if ip_decimal else 0
    whip = ((bb + h) / ip_decimal) if ip_decimal else 0
    k9 = (9 * so / ip_decimal) if ip_decimal else 0
    bb9 = (9 * bb / ip_decimal) if ip_decimal else 0
    hr9 = (9 * hra / ip_decimal) if ip_decimal else 0
    return {
        "outs": total_outs, "ip": ip_decimal, "er": er, "h_allowed": h,
        "bb": bb, "so": so, "hr_allowed": hra, "hbp": hbp,
        "runs_allowed": ra, "bf": bf,
        "era": era, "whip": whip, "k9": k9, "bb9": bb9, "hr9": hr9,
    }


def fetch_conference_standings(cur, tid, season):
    """Full conference standings for the conference this team is in."""
    cur.execute("""
        SELECT c.name AS conference, c.id AS conf_id
        FROM teams t JOIN conferences c ON c.id = t.conference_id
        WHERE t.id=%s
    """, (tid,))
    row = cur.fetchone()
    if not row:
        return None
    cur.execute("""
        SELECT t.id, t.short_name, tss.wins, tss.losses, tss.ties,
               tss.conference_wins, tss.conference_losses,
               tss.runs_scored, tss.runs_allowed, tss.run_differential
        FROM team_season_stats tss
        JOIN teams t ON t.id = tss.team_id
        WHERE t.conference_id=%s AND tss.season=%s
        ORDER BY
            COALESCE(tss.conference_wins,0) DESC,
            COALESCE(tss.conference_losses,0) ASC,
            COALESCE(tss.wins,0) DESC
    """, (row["conf_id"], season))
    rows = [dict(r) for r in cur.fetchall()]
    # Compute a "place" for this team based on the sorted order (1-based).
    for i, r in enumerate(rows):
        r["place"] = i + 1
    return {"conference": row["conference"], "standings": rows}


def fetch_rankings(cur, tid, season):
    """Composite + best per-source national ranking."""
    out = {}
    cur.execute("""
        SELECT composite_rank, composite_percentile, num_sources, cross_division_score,
               composite_sos, composite_sos_rank, pear_rank, cbr_rank, massey_rank, rpi_rank
        FROM composite_rankings WHERE team_id=%s AND season=%s
    """, (tid, season))
    r = cur.fetchone()
    if r:
        out["composite"] = dict(r)
    cur.execute("""
        SELECT source, national_rank, total_teams, sos, sos_rank
        FROM national_ratings WHERE team_id=%s AND season=%s
        ORDER BY national_rank ASC NULLS LAST LIMIT 5
    """, (tid, season))
    out["sources"] = [dict(r) for r in cur.fetchall()]
    return out if out else None


def fetch_roster_breakdown(cur, tid, season):
    cur.execute("""
        SELECT COALESCE(position, '') AS position, COUNT(*) AS n
        FROM players
        WHERE team_id=%s AND roster_year=%s AND NOT COALESCE(is_phantom,false)
        GROUP BY position
        ORDER BY n DESC
    """, (tid, season))
    by_pos = [(r["position"], r["n"]) for r in cur.fetchall()]
    pitchers = sum(n for p, n in by_pos if p == "P")
    total = sum(n for _, n in by_pos)
    return {
        "total": total,
        "pitchers": pitchers,
        "position_players": total - pitchers,
        "by_position": by_pos,
    }


# ---------- US state normalization for hometown strings ---------------------
_STATE_MAP = {
    "alabama": "AL", "ala.": "AL", "al": "AL",
    "alaska": "AK", "ak": "AK",
    "arizona": "AZ", "ariz.": "AZ", "az": "AZ",
    "arkansas": "AR", "ark.": "AR", "ar": "AR",
    "california": "CA", "calif.": "CA", "cal.": "CA", "ca": "CA",
    "colorado": "CO", "colo.": "CO", "co": "CO",
    "connecticut": "CT", "conn.": "CT", "ct": "CT",
    "delaware": "DE", "del.": "DE", "de": "DE",
    "florida": "FL", "fla.": "FL", "fl": "FL",
    "georgia": "GA", "ga.": "GA", "ga": "GA",
    "hawaii": "HI", "hi": "HI",
    "idaho": "ID", "id": "ID",
    "illinois": "IL", "ill.": "IL", "il": "IL",
    "indiana": "IN", "ind.": "IN", "in": "IN",
    "iowa": "IA", "ia": "IA",
    "kansas": "KS", "kan.": "KS", "kans.": "KS", "ks": "KS",
    "kentucky": "KY", "ky.": "KY", "ky": "KY",
    "louisiana": "LA", "la.": "LA", "la": "LA",
    "maine": "ME", "me": "ME",
    "maryland": "MD", "md.": "MD", "md": "MD",
    "massachusetts": "MA", "mass.": "MA", "ma": "MA",
    "michigan": "MI", "mich.": "MI", "mi": "MI",
    "minnesota": "MN", "minn.": "MN", "mn": "MN",
    "mississippi": "MS", "miss.": "MS", "ms": "MS",
    "missouri": "MO", "mo.": "MO", "mo": "MO",
    "montana": "MT", "mont.": "MT", "mt": "MT",
    "nebraska": "NE", "neb.": "NE", "nebr.": "NE", "ne": "NE",
    "nevada": "NV", "nev.": "NV", "nv": "NV",
    "new hampshire": "NH", "n.h.": "NH", "nh": "NH",
    "new jersey": "NJ", "n.j.": "NJ", "nj": "NJ",
    "new mexico": "NM", "n.m.": "NM", "nm": "NM",
    "new york": "NY", "n.y.": "NY", "ny": "NY",
    "north carolina": "NC", "n.c.": "NC", "nc": "NC",
    "north dakota": "ND", "n.d.": "ND", "nd": "ND",
    "ohio": "OH", "oh": "OH",
    "oklahoma": "OK", "okla.": "OK", "ok": "OK",
    "oregon": "OR", "ore.": "OR", "or": "OR",
    "pennsylvania": "PA", "pa.": "PA", "penn.": "PA", "pa": "PA",
    "rhode island": "RI", "r.i.": "RI", "ri": "RI",
    "south carolina": "SC", "s.c.": "SC", "sc": "SC",
    "south dakota": "SD", "s.d.": "SD", "sd": "SD",
    "tennessee": "TN", "tenn.": "TN", "tn": "TN",
    "texas": "TX", "tex.": "TX", "tx": "TX",
    "utah": "UT", "ut": "UT",
    "vermont": "VT", "vt.": "VT", "vt": "VT",
    "virginia": "VA", "va.": "VA", "va": "VA",
    "washington": "WA", "wash.": "WA", "wa": "WA",
    "west virginia": "WV", "w.va.": "WV", "wv": "WV",
    "wisconsin": "WI", "wis.": "WI", "wisc.": "WI", "wi": "WI",
    "wyoming": "WY", "wyo.": "WY", "wy": "WY",
    # Common non-US regions in PNW rosters
    "british columbia": "BC", "b.c.": "BC", "bc": "BC",
    "alberta": "AB", "alta.": "AB", "ab": "AB",
    "ontario": "ON", "ont.": "ON", "on": "ON",
    "saskatchewan": "SK", "sask.": "SK", "sk": "SK",
    "manitoba": "MB", "man.": "MB", "mb": "MB",
    "quebec": "QC", "qc": "QC",
}

def _state_of(hometown):
    """Try to recover a 2-letter state/province code from a hometown string."""
    if not hometown:
        return None
    # Strip parenthetical HS notes like "(Santa Rosa CC)".
    s = hometown.split("(")[0].strip()
    # "City, STATE" → take everything after the last comma.
    parts = s.split(",")
    if len(parts) < 2:
        return None
    tail = parts[-1].strip().lower().rstrip(".").strip()
    if not tail:
        return None
    # Try a direct lookup, then strip trailing period and try again.
    return _STATE_MAP.get(tail) or _STATE_MAP.get(tail + ".")


def fetch_war_by_season(cur, tid, last_n=6):
    """Sum offensive and pitching WAR per season for this team. Returns the
    most recent last_n seasons (those that actually have data)."""
    cur.execute("""
        SELECT season, COALESCE(SUM(offensive_war), 0) AS bat_war
        FROM batting_stats WHERE team_id=%s GROUP BY season
    """, (tid,))
    bat = {r["season"]: float(r["bat_war"] or 0) for r in cur.fetchall()}
    cur.execute("""
        SELECT season, COALESCE(SUM(pitching_war), 0) AS pit_war
        FROM pitching_stats WHERE team_id=%s GROUP BY season
    """, (tid,))
    pit = {r["season"]: float(r["pit_war"] or 0) for r in cur.fetchall()}
    seasons = sorted(set(bat) | set(pit))
    rows = []
    for s in seasons:
        b = bat.get(s, 0.0)
        p = pit.get(s, 0.0)
        rows.append({"season": s, "bat_war": b, "pit_war": p, "total_war": b + p})
    return rows[-last_n:]


def fetch_roster_classes(cur, tid, season):
    """Class-year breakdown for the 2026 roster: count of players by class plus
    share of plate appearances and innings pitched delivered by each class.
    Lets the book show whether a program is freshman-heavy, JUCO-heavy, etc."""
    # Roster counts by year.
    cur.execute("""
        SELECT year_in_school, COUNT(*) AS n,
               COUNT(*) FILTER (WHERE previous_school IS NOT NULL AND previous_school != '') AS with_prev
        FROM players
        WHERE team_id=%s AND roster_year=%s AND NOT COALESCE(is_phantom,false)
        GROUP BY year_in_school
    """, (tid, season))
    counts = {}
    juco_or_transfer = 0
    for r in cur.fetchall():
        yr = (r["year_in_school"] or "—").strip() or "—"
        counts[yr] = r["n"]
        juco_or_transfer += r["with_prev"] or 0

    # Plate appearances by class.
    cur.execute("""
        SELECT p.year_in_school, COALESCE(SUM(b.plate_appearances), 0) AS pa
        FROM batting_stats b JOIN players p ON p.id = b.player_id
        WHERE b.team_id=%s AND b.season=%s
        GROUP BY p.year_in_school
    """, (tid, season))
    pa_by_class = {(r["year_in_school"] or "—"): int(r["pa"]) for r in cur.fetchall()}
    total_pa = sum(pa_by_class.values())

    # Outs pitched by class (innings_pitched is baseball notation 6.2 = 20 outs).
    cur.execute("""
        SELECT p.year_in_school, ps.innings_pitched
        FROM pitching_stats ps JOIN players p ON p.id = ps.player_id
        WHERE ps.team_id=%s AND ps.season=%s
    """, (tid, season))
    outs_by_class = {}
    for r in cur.fetchall():
        yr = r["year_in_school"] or "—"
        ip = r["innings_pitched"] or 0
        whole = int(ip)
        tenths = round((float(ip) - whole) * 10)
        outs_by_class[yr] = outs_by_class.get(yr, 0) + whole * 3 + min(tenths, 2)
    total_outs = sum(outs_by_class.values())

    freshman_keys = {"Fr", "R-Fr"}
    senior_keys = {"Sr", "R-Sr"}
    fr_pa = sum(pa_by_class.get(k, 0) for k in freshman_keys)
    fr_outs = sum(outs_by_class.get(k, 0) for k in freshman_keys)

    return {
        "by_class_count": counts,
        "by_class_pa": pa_by_class,
        "by_class_outs": outs_by_class,
        "total_pa": total_pa,
        "total_outs": total_outs,
        "freshman_pa_share": (fr_pa / total_pa) if total_pa else 0,
        "freshman_ip_share": (fr_outs / total_outs) if total_outs else 0,
        "freshman_pa": fr_pa,
        "freshman_outs": fr_outs,
        "transfer_or_juco_count": juco_or_transfer,
    }


def fetch_top_freshman(cur, tid, season):
    """The freshman who carried the most load on each side of the ball."""
    cur.execute("""
        SELECT (p.first_name||' '||p.last_name) AS name, p.year_in_school,
               b.plate_appearances, b.batting_avg, b.ops, b.offensive_war
        FROM batting_stats b JOIN players p ON p.id = b.player_id
        WHERE b.team_id=%s AND b.season=%s
              AND p.year_in_school IN ('Fr','R-Fr')
              AND COALESCE(b.plate_appearances,0) >= 30
        ORDER BY b.offensive_war DESC NULLS LAST, b.plate_appearances DESC NULLS LAST
        LIMIT 1
    """, (tid, season))
    top_h = cur.fetchone()
    cur.execute("""
        SELECT (p.first_name||' '||p.last_name) AS name, p.year_in_school,
               ps.innings_pitched, ps.era, ps.strikeouts, ps.pitching_war
        FROM pitching_stats ps JOIN players p ON p.id = ps.player_id
        WHERE ps.team_id=%s AND ps.season=%s
              AND p.year_in_school IN ('Fr','R-Fr')
              AND COALESCE(ps.innings_pitched,0) >= 10
        ORDER BY ps.pitching_war DESC NULLS LAST, ps.innings_pitched DESC NULLS LAST
        LIMIT 1
    """, (tid, season))
    top_p = cur.fetchone()
    return {
        "top_freshman_hitter": dict(top_h) if top_h else None,
        "top_freshman_pitcher": dict(top_p) if top_p else None,
    }


def fetch_state_breakdown(cur, tid, season):
    """Hometown state counts for the 2026 roster (top 5 states + total + unknown)."""
    cur.execute("""
        SELECT hometown FROM players
        WHERE team_id=%s AND roster_year=%s AND NOT COALESCE(is_phantom,false)
              AND hometown IS NOT NULL AND hometown <> ''
    """, (tid, season))
    counts = {}
    total = 0
    unknown = 0
    for r in cur.fetchall():
        total += 1
        st = _state_of(r["hometown"])
        if st:
            counts[st] = counts.get(st, 0) + 1
        else:
            unknown += 1
    ranked = sorted(counts.items(), key=lambda x: -x[1])
    return {
        "total_with_hometown": total,
        "unknown": unknown,
        "by_state": ranked,
    }


# ---------- driver ----------------------------------------------------------

import sys as _sys
START = 0
END = len(PROFILES)
for i, a in enumerate(_sys.argv[1:]):
    if a == "--start" and i + 2 < len(_sys.argv):
        START = int(_sys.argv[i + 2])
    if a == "--end" and i + 2 < len(_sys.argv):
        END = int(_sys.argv[i + 2])

# Resume support: if a partial book_data.json already exists, keep the teams
# we previously gathered and only re-fetch the slice in [START, END).
_partial_path = OUT.with_suffix(".partial.json")
if _partial_path.exists():
    try:
        _prior = json.loads(_partial_path.read_text())
        teams = list(_prior.get("teams") or [])
        level_norms = _prior.get("level_norms") or {}
        _have_ids = {t["team_id"] for t in teams}
    except Exception:
        teams = []
        level_norms = {}
        _have_ids = set()
else:
    teams = []
    level_norms = {}
    _have_ids = set()

with get_connection() as conn:
    cur = conn.cursor()
    if not level_norms:
        level_norms = fetch_level_norms(cur, SEASON)
        print(f"Computed level norms for {len(level_norms)} divisions:")
        for k, v in level_norms.items():
            print(f"  {k}: AVG={v['avg']} OPS={v['ops']} ERA={v['era']} R/G={v['rpg']}")
    slice_to_do = PROFILES[START:END]
    print(f"Processing teams {START}..{END} ({len(slice_to_do)} of {len(PROFILES)} total).")
    _i = 0
    for prof in slice_to_do:
        _i += 1
        if prof["team_id"] in _have_ids:
            continue
        print(f"  [{_i}/{len(slice_to_do)}] team_id={prof['team_id']} {prof['school_name']}")
        tid = prof["team_id"]
        cur.execute(
            "SELECT id, short_name, mascot, city, state, logo_url, conference_id "
            "FROM teams WHERE id=%s", (tid,))
        t = cur.fetchone()
        if not t:
            continue

        seasons = fetch_seasons(cur, tid)
        cur2026 = next((s for s in seasons if s["season"] == SEASON), None)
        top_h = fetch_top_hitters(cur, tid, SEASON)
        top_p = fetch_top_pitchers(cur, tid, SEASON)
        bat_line = fetch_team_batting_line(cur, tid, SEASON)
        pit_line = fetch_team_pitching_line(cur, tid, SEASON)
        standings = fetch_conference_standings(cur, tid, SEASON)
        rankings = fetch_rankings(cur, tid, SEASON)
        roster = fetch_roster_breakdown(cur, tid, SEASON)
        roster_classes = fetch_roster_classes(cur, tid, SEASON)
        top_fr = fetch_top_freshman(cur, tid, SEASON)
        states = fetch_state_breakdown(cur, tid, SEASON)
        war_seasons = fetch_war_by_season(cur, tid)
        recruit_guide = fetch_recruiting_guide(tid)
        pro_alumni = PRO_ALUMNI.get(tid, [])

        teams.append({
            "team_id": tid,
            "school_name": prof["school_name"],
            "division": prof["division"],
            "conference": prof["conference"],
            "short_name": t["short_name"],
            "mascot": t["mascot"],
            "city": t["city"], "state": t["state"],
            "logo_url": t["logo_url"],
            "logo_file": logo_path(t["logo_url"]),
            "profile": prof["profile"],
            "season_2026": cur2026,
            "seasons": seasons,
            "top_hitter": top_h[0] if top_h else None,   # back-compat
            "top_pitcher": top_p[0] if top_p else None,  # back-compat
            "top_hitters": top_h,
            "top_pitchers": top_p,
            "team_batting": bat_line,
            "team_pitching": pit_line,
            "conf_standings": standings,
            "rankings": rankings,
            "roster": roster,
            "roster_classes": roster_classes,
            "top_freshman_hitter": top_fr["top_freshman_hitter"],
            "top_freshman_pitcher": top_fr["top_freshman_pitcher"],
            "state_breakdown": states,
            "war_by_season": war_seasons,
            "freshman_production": (recruit_guide or {}).get("freshman_production") or [],
            "transfer_production": (recruit_guide or {}).get("transfer_production") or [],
            "roster_composition_series": (recruit_guide or {}).get("roster_composition") or [],
            "pro_alumni": pro_alumni,
        })
        # Persist partial progress so a future invocation can resume.
        _partial_path.write_text(json.dumps({"level_norms": level_norms, "teams": teams}, default=str))

# When we've finished the whole list (END covers all profiles), write the
# final book_data.json and clean up the partial file.
output = {"level_norms": level_norms, "teams": teams}
OUT.write_text(json.dumps(output, indent=2, default=str))
if _partial_path.exists() and len(teams) >= len(PROFILES):
    try:
        _partial_path.unlink()
    except Exception:
        pass
print(f"Wrote {len(teams)} teams -> {OUT}")
no_logo = [t["school_name"] for t in teams if not t["logo_file"]]
no_2026 = [t["school_name"] for t in teams if not t["season_2026"]]
print(f"logos resolved: {sum(1 for t in teams if t['logo_file'])}/{len(teams)}")
if no_logo:
    print("  NO LOCAL LOGO:", no_logo)
print(f"2026 record present: {sum(1 for t in teams if t['season_2026'])}/{len(teams)}")
if no_2026:
    print("  NO 2026 RECORD:", no_2026)
print(f"teams w/ >=3 top hitters: {sum(1 for t in teams if len(t['top_hitters'])>=3)}/{len(teams)}")
print(f"teams w/ >=3 top pitchers: {sum(1 for t in teams if len(t['top_pitchers'])>=3)}/{len(teams)}")
print(f"teams w/ team batting line: {sum(1 for t in teams if t['team_batting'])}/{len(teams)}")
print(f"teams w/ conf standings: {sum(1 for t in teams if t['conf_standings'])}/{len(teams)}")
print(f"teams w/ rankings: {sum(1 for t in teams if t['rankings'])}/{len(teams)}")
print(f"teams w/ pro alumni: {sum(1 for t in teams if t['pro_alumni'])}/{len(teams)}")
from collections import Counter
print("by division:", dict(Counter(t["division"] for t in teams)))
