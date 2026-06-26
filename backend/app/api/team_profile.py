"""
Team Profile V2 — computed "Team Identity" payload.

Powers the Team Identity tab on team pages: letter-grade report card, a radar
vs the division peer group, trait chips, a light outlook, and returning-
production percentages. Grades are PERCENTILE-RANKED within the team's
division level (D1/D2/D3/NAIA/JUCO), so an "A" means top of that peer group.

Returning status is derived from class year (seniors / grad / JUCO non-frosh
depart by default) and can be overridden per player via the
`player_returning_overrides` table (editable later in the Commitment Editor).
Source generator: ~/Downloads/team-profile-v2-handoff/generate_team_profile_tabs.py
"""
import time

from fastapi import APIRouter, Query

from ..config import CURRENT_SEASON
from ..models.database import get_connection
from ._team_narrative import team_narrative, hitter_returner_note, pitcher_returner_note

team_profile_router = APIRouter(prefix="/teams")

# (division_level, season) -> (computed_at, {team_id: raw_metrics})
_DIV_CACHE: dict = {}
_DIV_TTL = 1800


# ── small helpers ──
def _safe_div(n, d):
    return n / d if d else 0.0


def _ip_to_outs(ip):
    if ip is None:
        return 0
    whole = int(float(ip))
    frac = int(round((float(ip) - whole) * 10))
    return whole * 3 + frac


def grade_from_score(score):
    table = [(95, "A+"), (87, "A"), (80, "A-"), (73, "B+"), (66, "B"),
             (60, "B-"), (53, "C+"), (46, "C"), (40, "C-"), (33, "D+"), (25, "D")]
    for cutoff, letter in table:
        if score >= cutoff:
            return letter
    return "F"


def _pct_rank(values, value, high_good=True):
    """Percentile (0-100) of `value` within `values`."""
    vals = sorted(v for v in values if v is not None)
    if not vals:
        return 50.0
    if len(vals) == 1:
        return 50.0
    below = sum(1 for v in vals if v < value)
    equal = sum(1 for v in vals if v == value)
    pct = (below + equal / 2) / len(vals) * 100
    return pct if high_good else 100 - pct


def _returning(year_in_school, division_level, override, in_portal=False):
    if override in ("returning", "departing"):
        return override == "returning"  # manual override always wins
    if in_portal:
        return False  # in the transfer portal → not on next year's roster
    yr = (year_in_school or "").strip().lower()
    gone = {"sr", "senior", "r-sr", "redshirt senior", "5th", "gr", "grad", "graduate"}
    if yr in gone:
        return False
    if division_level == "JUCO" and yr not in {"fr", "freshman", "r-fr", "redshirt freshman"}:
        return False
    return True  # fr/so/jr (+ redshirt) and unknown default to returning


# ── per-team raw metrics (the inputs that get percentile-graded) ──
def _team_raw(cur, team_id, season, division_level, overrides, portal):
    cur.execute(
        """SELECT bs.plate_appearances pa, bs.at_bats ab, bs.hits h, bs.doubles d2,
                  bs.triples d3, bs.home_runs hr, bs.walks bb, bs.hit_by_pitch hbp,
                  bs.sacrifice_flies sf, bs.strikeouts so, bs.stolen_bases sb,
                  bs.offensive_war owar, bs.player_id, p.year_in_school
           FROM batting_stats bs JOIN players p ON p.id = bs.player_id
           WHERE bs.team_id = %s AND bs.season = %s""", (team_id, season))
    bat = cur.fetchall()
    cur.execute(
        """SELECT ps.innings_pitched ip, ps.batters_faced bf, ps.earned_runs er,
                  ps.walks bb, ps.strikeouts k, ps.pitching_war pwar,
                  ps.player_id, p.year_in_school
           FROM pitching_stats ps JOIN players p ON p.id = ps.player_id
           WHERE ps.team_id = %s AND ps.season = %s""", (team_id, season))
    pit = cur.fetchall()

    g = lambda r, k: r.get(k) or 0
    pa = sum(g(r, "pa") for r in bat)
    ab = sum(g(r, "ab") for r in bat)
    h = sum(g(r, "h") for r in bat)
    bb = sum(g(r, "bb") for r in bat)
    hbp = sum(g(r, "hbp") for r in bat)
    sf = sum(g(r, "sf") for r in bat)
    tb = h + sum(g(r, "d2") for r in bat) + 2 * sum(g(r, "d3") for r in bat) + 3 * sum(g(r, "hr") for r in bat)
    so = sum(g(r, "so") for r in bat)
    sb = sum(g(r, "sb") for r in bat)
    avg = _safe_div(h, ab)
    obp = _safe_div(h + bb + hbp, ab + bb + hbp + sf)
    slg = _safe_div(tb, ab)

    outs = sum(_ip_to_outs(r.get("ip")) for r in pit)
    bf = sum(g(r, "bf") for r in pit)
    er = sum(g(r, "er") for r in pit)
    pbb = sum(g(r, "bb") for r in pit)
    pk = sum(g(r, "k") for r in pit)
    depth = sum(1 for r in pit if _ip_to_outs(r.get("ip")) >= 60)  # arms with 20+ IP

    # Returning aggregates
    def ret_row(r):
        return _returning(r.get("year_in_school"), division_level,
                          overrides.get(r["player_id"]), r["player_id"] in portal)
    ret_pa = sum(g(r, "pa") for r in bat if ret_row(r))
    ret_outs = sum(_ip_to_outs(r.get("ip")) for r in pit if ret_row(r))
    pos_owar = sum(max(0, g(r, "owar")) for r in bat)
    ret_pos_owar = sum(max(0, g(r, "owar")) for r in bat if ret_row(r))
    pos_pwar = sum(max(0, g(r, "pwar")) for r in pit)
    ret_pos_pwar = sum(max(0, g(r, "pwar")) for r in pit if ret_row(r))

    return {
        "ops": obp + slg, "iso": slg - avg, "bat_bb_pct": _safe_div(bb, pa),
        "bat_k_pct": _safe_div(so, pa), "sb": sb,
        "era": _safe_div(er * 9, outs / 3) if outs else None,
        "pit_k_pct": _safe_div(pk, bf), "pit_bb_pct": _safe_div(pbb, bf), "depth": depth,
        "avg": avg, "obp": obp, "slg": slg,
        "pa": pa, "outs": outs,
        "ret_pa_pct": _safe_div(ret_pa, pa) * 100,
        "ret_ip_pct": _safe_div(ret_outs, outs) * 100,
        "ret_owar_pct": _safe_div(ret_pos_owar, pos_owar) * 100,
        "ret_pwar_pct": _safe_div(ret_pos_pwar, pos_pwar) * 100,
        "ret_war_pct": _safe_div(ret_pos_owar + ret_pos_pwar, pos_owar + pos_pwar) * 100,
    }


def _portal_ids(cur):
    """player_ids currently in the transfer portal (auto-departing)."""
    try:
        cur.execute("SELECT player_id FROM transfer_portal_members")
        return {r["player_id"] for r in cur.fetchall()}
    except Exception:
        return set()


def _division_raw(cur, division_level, season, overrides, portal):
    key = (division_level, season)
    hit = _DIV_CACHE.get(key)
    if hit and (time.time() - hit[0]) < _DIV_TTL:
        return hit[1]
    # Peer group = tracked teams that actually have stats this season. Without
    # the EXISTS guard the ~30 out-of-conference D1 opponents (active but no
    # season stats) flood the distribution and inflate everyone's grades.
    cur.execute(
        """SELECT t.id FROM teams t JOIN conferences c ON t.conference_id = c.id
           JOIN divisions d ON c.division_id = d.id
           WHERE d.level = %s AND t.is_active = 1
             AND EXISTS (SELECT 1 FROM batting_stats bs WHERE bs.team_id = t.id AND bs.season = %s)""",
        (division_level, season))
    ids = [r["id"] for r in cur.fetchall()]
    out = {tid: _team_raw(cur, tid, season, division_level, overrides, portal) for tid in ids}
    _DIV_CACHE[key] = (time.time(), out)
    return out


# Grade dimensions: (key, label, raw_metric_key, high_good)
_DIMS = [
    ("offense", "Offense", "ops", True),
    ("contact", "Contact", "bat_k_pct", False),
    ("power", "Power", "iso", True),
    ("discipline", "Discipline", "bat_bb_pct", True),
    ("speed", "Speed", "sb", True),
    ("pitching", "Run Prevention", "era", False),
    ("miss_bats", "Miss Bats", "pit_k_pct", True),
    ("strike_throwing", "Command", "pit_bb_pct", False),
    ("pitching_depth", "Pitching Depth", "depth", True),
]


def _r3(v):
    s = f"{v:.3f}"
    return s[1:] if s.startswith("0") else s


def _fmt_metric(key, val):
    """Human-readable stat behind a grade, so the letter has a visible reason."""
    if val is None:
        return None
    if key == "offense":
        return f"{_r3(val)} OPS"
    if key == "power":
        return f"{_r3(val)} ISO"
    if key == "contact":
        return f"{val * 100:.1f}% K"
    if key == "discipline":
        return f"{val * 100:.1f}% BB"
    if key == "speed":
        return f"{int(round(val))} SB"
    if key == "pitching":
        return f"{val:.2f} ERA"
    if key == "miss_bats":
        return f"{val * 100:.1f}% K"
    if key == "strike_throwing":
        return f"{val * 100:.1f}% BB"
    if key == "pitching_depth":
        return f"{int(round(val))} arms 20+ IP"
    return str(val)


def _identity_label(s):
    o, p, pw, c, sp = s["offense"], s["pitching"], s["power"], s["contact"], s["speed"]
    if o >= 65 and p < 40:
        return "Offense-Led, Pitching Reload"
    if p >= 65 and o < 45:
        return "Pitching-Led, Bats Need Lift"
    if c >= 70 and pw < 40:
        return "Contact / Traffic Offense"
    if pw >= 70:
        return "Damage-First Lineup"
    if sp >= 70:
        return "Run Game Pressure"
    if o >= 60 and p >= 60:
        return "Balanced Contender"
    if o < 40 and p < 40:
        return "Roster Build Mode"
    return "Balanced Ballclub"


def _tags(s, ret):
    pos, con = [], []
    for label, key, thr in [("Bat-to-Ball", "contact", 70), ("Damage in Lineup", "power", 70),
                            ("Creates Traffic", "offense", 70), ("Run Game", "speed", 65),
                            ("Run Prevention Travels", "pitching", 70), ("Miss-Bat Stuff", "miss_bats", 70)]:
        if s.get(key, 0) >= thr:
            pos.append(label)
    if ret["ret_pa_pct"] >= 70:
        pos.append("Lineup Core Back")
    if ret["ret_ip_pct"] >= 70:
        pos.append("Innings Base Back")
    if s["power"] < 40:
        con.append("Extra-Base Thump Needed")
    if s["pitching"] < 45:
        con.append("Run Prevention Must Climb")
    if s["strike_throwing"] < 40:
        con.append("Walks Must Come Down")
    if s["pitching_depth"] < 40:
        con.append("Weekend Innings Open")
    if ret["ret_pa_pct"] < 50:
        con.append("Everyday Bats Open")
    if ret["ret_ip_pct"] < 50:
        con.append("Mound Roles Open")
    return pos[:5], con[:5]


def _suggestions(s, ret):
    out = []
    if s["power"] < 45:
        out.append("Add gap-to-gap thump so pitchers pay for living in the zone.")
    if s["pitching"] < 45 or ret["ret_ip_pct"] < 50:
        out.append("Settle the mound first: weekend innings, strike throwing, and late-game outs.")
    if s["contact"] >= 70:
        out.append("Keep the table-setting feel while adding slug to turn traffic into crooked innings.")
    if ret["ret_pa_pct"] < 50:
        out.append("Find everyday bats early; there are real lineup jobs available.")
    if s["speed"] >= 65:
        out.append("Let the run game steal 90 feet while the middle-order damage develops.")
    if not out:
        out.append("Keep the roster balanced and chase one clear skill that changes innings.")
    return out[:3]


def _outlook(name, ret):
    pa, ip = ret["ret_pa_pct"], ret["ret_ip_pct"]
    if pa >= 65 and ip >= 60:
        return "Stable core", f"{name} brings back a real core, more of a targeted-upgrade offseason than a rebuild."
    if pa >= 65 and ip < 45:
        return "Lineup returns, pitching reset", f"{name} carries a familiar lineup forward while the mound becomes the defining reload area."
    if pa < 45 and ip >= 60:
        return "Pitching returns, lineup reset", f"{name} has more stability on the mound than in the order; the fastest jump is filling open at-bats."
    if pa < 45 and ip < 45:
        return "Major roster turnover", f"{name} enters a roster refresh with real playing-time windows across the diamond."
    return "Mixed continuity", f"{name} has a split roster picture, with one side of the game carrying more stability than the other."


# ── Blended impact scores (ported from the V2 generator; NOT WAR-only) ──
def _hitter_impact(r):
    pa = r.get("plate_appearances") or 0
    owar = r.get("offensive_war") or 0
    ops = r.get("ops") or 0
    wrc = r.get("wrc_plus") or 0
    obp = r.get("on_base_pct") or 0
    slg = r.get("slugging_pct") or 0
    bb = r.get("bb_pct") or 0
    k = r.get("k_pct") or 0
    hr = r.get("home_runs") or 0
    sb = r.get("stolen_bases") or 0
    sw = min(1, max(0.3, pa / 80))
    vol = min(1.35, pa / 185)
    prod = max(0, min(1.45, (wrc - 70) / 85))
    slash = max(0, min(1.35, (ops - 0.620) / 0.360))
    onb = max(0, min(1.15, (obp - 0.310) / 0.160))
    dmg = max(0, min(1.15, (slg - 0.340) / 0.260)) + min(0.35, hr / 20)
    disc = max(0, min(1.0, ((bb - k) * 100 + 14) / 24))
    spd = min(0.35, sb / 25)
    return ((owar * 1.65) + (prod * 1.0) + (slash * 0.85) + (vol * 0.7)
            + (onb * 0.35) + (dmg * 0.3) + (disc * 0.2) + spd) * sw


def _pitcher_impact(r):
    outs = _ip_to_outs(r.get("innings_pitched"))
    ip = outs / 3 if outs else 0
    pwar = r.get("pitching_war") or 0
    quals = [v for v in (r.get("fip"), r.get("siera"), r.get("era")) if v and v > 0]
    quality = (sum(max(0, min(1.35, (6.75 - v) / 3.5)) for v in quals) / len(quals)) if quals else 0
    vol = min(1.4, ip / 45)
    k = r.get("k_pct") or 0
    bb = r.get("bb_pct") or 0
    command = max(0, min(1.25, ((k - bb) * 100 + 6) / 24))
    sw = min(1, max(0.25, ip / 18))
    return ((pwar * 1.75) + (quality * 1.25) + (vol * 0.85) + (command * 0.45)) * sw


_IF_POS = {"1B", "2B", "3B", "SS", "IF", "INF"}
_OF_POS = {"LF", "CF", "RF", "OF"}


def _pos_group(pos):
    """Hitter position group for the roster-balance chart (pitchers -> None)."""
    p = (pos or "").upper().split("/")[0].strip()
    if p == "C":
        return "C"
    if p in _IF_POS:
        return "IF"
    if p in _OF_POS:
        return "OF"
    if p in ("DH", "UT", "UTIL", "2WAY"):
        return "UT"
    return None  # pitcher or unknown


def _depart_status(year_in_school, division_level, override, note, in_portal=False):
    if override == "departing":
        return note or "Portal / not returning"
    if in_portal:
        return "Transfer portal"
    yr = (year_in_school or "").strip().lower()
    if yr in {"sr", "senior", "r-sr", "redshirt senior"}:
        return "Senior departure"
    if yr in {"5th", "gr", "grad", "graduate"}:
        return "Eligibility exhausted"
    if division_level == "JUCO":
        return "JUCO class departure"
    return "Departing"


def _hit_payload(r, returning):
    return {
        "player_id": r["player_id"], "name": f"{r.get('first_name','')} {r.get('last_name','')}".strip(),
        "yr": r.get("year_in_school") or "-", "pos": r.get("position") or "-",
        "pa": r.get("plate_appearances") or 0, "avg": r.get("batting_avg") or 0,
        "obp": r.get("on_base_pct") or 0, "slg": r.get("slugging_pct") or 0,
        "ops": r.get("ops") or 0, "wrc_plus": r.get("wrc_plus"), "hr": r.get("home_runs") or 0,
        "rbi": r.get("rbi") or 0, "sb": r.get("stolen_bases") or 0, "owar": r.get("offensive_war") or 0,
        "impact": round(_hitter_impact(r), 2), "returning": returning,
    }


def _pit_payload(r, returning):
    return {
        "player_id": r["player_id"], "name": f"{r.get('first_name','')} {r.get('last_name','')}".strip(),
        "yr": r.get("year_in_school") or "-", "pos": r.get("position") or "P",
        "ip": r.get("innings_pitched") or 0, "era": r.get("era"), "fip": r.get("fip"),
        "k_pct": round((r.get("k_pct") or 0) * 100, 1), "bb_pct": round((r.get("bb_pct") or 0) * 100, 1),
        "k": r.get("strikeouts") or 0, "pwar": r.get("pitching_war") or 0,
        "impact": round(_pitcher_impact(r), 2), "returning": returning,
    }


@team_profile_router.get("/{team_id}/returning")
def team_returning(team_id: int, season: int = Query(CURRENT_SEASON)):
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """SELECT t.short_name, t.name, d.level division_level
               FROM teams t JOIN conferences c ON t.conference_id = c.id
               JOIN divisions d ON c.division_id = d.id WHERE t.id = %s""", (team_id,))
        team = cur.fetchone()
        if not team:
            return {"error": "Team not found"}
        level = team["division_level"]
        name = team["short_name"] or team["name"]

        cur.execute("SELECT player_id, status, note FROM player_returning_overrides WHERE season = %s", (season,))
        ovr = {r["player_id"]: r for r in cur.fetchall()}
        portal = _portal_ids(cur)

        cur.execute(
            """SELECT bs.*, p.first_name, p.last_name, p.position, p.year_in_school
               FROM batting_stats bs JOIN players p ON p.id = bs.player_id
               WHERE bs.team_id = %s AND bs.season = %s AND COALESCE(p.is_phantom,false)=false""",
            (team_id, season))
        bat = [dict(r) for r in cur.fetchall()]
        cur.execute(
            """SELECT ps.*, p.first_name, p.last_name, p.position, p.year_in_school
               FROM pitching_stats ps JOIN players p ON p.id = ps.player_id
               WHERE ps.team_id = %s AND ps.season = %s AND COALESCE(p.is_phantom,false)=false""",
            (team_id, season))
        pit = [dict(r) for r in cur.fetchall()]

        def is_ret(r):
            o = ovr.get(r["player_id"])
            return _returning(r.get("year_in_school"), level, o["status"] if o else None, r["player_id"] in portal)

        # Returning impact players (with sample floors + fallbacks)
        ret_bat = [r for r in bat if is_ret(r)]
        ret_pit = [r for r in pit if is_ret(r)]
        hq = [r for r in ret_bat if (r.get("plate_appearances") or 0) >= 40] or \
             [r for r in ret_bat if (r.get("plate_appearances") or 0) >= 20] or ret_bat
        pq = [r for r in ret_pit if _ip_to_outs(r.get("innings_pitched")) >= 30] or \
             [r for r in ret_pit if _ip_to_outs(r.get("innings_pitched")) >= 15] or ret_pit
        ret_hitters = []
        for i, r in enumerate(sorted(hq, key=_hitter_impact, reverse=True)[:8]):
            p = _hit_payload(r, True); p["note"] = hitter_returner_note(r, i)
            ret_hitters.append(p)
        ret_pitchers = []
        for i, r in enumerate(sorted(pq, key=_pitcher_impact, reverse=True)[:8]):
            p = _pit_payload(r, True); p["note"] = pitcher_returner_note(r, i)
            ret_pitchers.append(p)

        # Departures (production to replace), deduped by player_id
        dep = {}
        for r in bat:
            if is_ret(r):
                continue
            o = ovr.get(r["player_id"])
            dep[r["player_id"]] = {
                **_hit_payload(r, False),
                "status": _depart_status(r.get("year_in_school"), level, o["status"] if o else None, o["note"] if o else None, r["player_id"] in portal),
                "kind": "bat",
            }
        for r in pit:
            if is_ret(r):
                continue
            o = ovr.get(r["player_id"])
            p = _pit_payload(r, False)
            ex = dep.get(r["player_id"])
            if ex and ex["impact"] >= p["impact"]:
                continue
            dep[r["player_id"]] = {
                **p,
                "status": _depart_status(r.get("year_in_school"), level, o["status"] if o else None, o["note"] if o else None, r["player_id"] in portal),
                "kind": "pit",
            }
        departures = sorted(dep.values(), key=lambda x: x["impact"], reverse=True)[:10]

        # Returning percentages (mirror identity)
        g = lambda r, k: r.get(k) or 0
        tot_pa = sum(g(r, "plate_appearances") for r in bat)
        ret_pa = sum(g(r, "plate_appearances") for r in bat if is_ret(r))
        tot_outs = sum(_ip_to_outs(r.get("innings_pitched")) for r in pit)
        ret_outs = sum(_ip_to_outs(r.get("innings_pitched")) for r in pit if is_ret(r))
        tot_ow = sum(max(0, g(r, "offensive_war")) for r in bat)
        ret_ow = sum(max(0, g(r, "offensive_war")) for r in bat if is_ret(r))
        tot_pw = sum(max(0, g(r, "pitching_war")) for r in pit)
        ret_pw = sum(max(0, g(r, "pitching_war")) for r in pit if is_ret(r))
        ret = {
            "ret_pa_pct": round(_safe_div(ret_pa, tot_pa) * 100, 1),
            "ret_ip_pct": round(_safe_div(ret_outs, tot_outs) * 100, 1),
            "ret_owar_pct": round(_safe_div(ret_ow, tot_ow) * 100, 1),
            "ret_pwar_pct": round(_safe_div(ret_pw, tot_pw) * 100, 1),
        }

        # Roster balance: returning vs departing PA by position group, + pitching IP
        groups = {}
        for r in bat:
            grp = _pos_group(r.get("position"))
            if not grp:
                continue
            d = groups.setdefault(grp, {"group": grp, "ret_pa": 0, "dep_pa": 0})
            d["ret_pa" if is_ret(r) else "dep_pa"] += g(r, "plate_appearances")
        GLABEL = {"C": "Catcher", "IF": "Infield", "OF": "Outfield", "UT": "DH / Util"}
        balance_hitters = [{**groups[k], "label": GLABEL[k]} for k in ("C", "IF", "OF", "UT") if k in groups]
        bal = {
            "hitters": balance_hitters,
            "pitching": {"ret_ip": round(ret_outs / 3, 1), "dep_ip": round((tot_outs - ret_outs) / 3, 1)},
        }

        # Roster read + priorities
        roster_read = (f"{name} returns {ret['ret_pa_pct']:.0f}% of plate appearances and "
                       f"{ret['ret_ip_pct']:.0f}% of innings, with {len(ret_hitters)} impact bats "
                       f"and {len(ret_pitchers)} arms back.")
        priorities = []
        for d in balance_hitters:
            tot = d["ret_pa"] + d["dep_pa"]
            if tot >= 60 and _safe_div(d["ret_pa"], tot) < 0.45:
                priorities.append(f"{d['label']} is a rebuild spot — only {round(_safe_div(d['ret_pa'], tot) * 100)}% of its plate appearances return.")
        if ret["ret_ip_pct"] < 50:
            priorities.append(f"The mound is the clearest reload area, with {ret['ret_ip_pct']:.0f}% of innings back.")
        if ret["ret_owar_pct"] < 45:
            priorities.append("Replace lost middle-of-the-order damage, not just at-bats.")
        if not priorities:
            priorities.append("No glaring holes — this is a continuity roster looking for targeted upgrades.")

        return {
            "team_id": team_id, "team": name, "season": season, "division": level,
            "returning": ret,
            "best_bat": ret_hitters[0] if ret_hitters else None,
            "top_arm": ret_pitchers[0] if ret_pitchers else None,
            "biggest_loss": departures[0] if departures else None,
            "returning_hitters": ret_hitters,
            "returning_pitchers": ret_pitchers,
            "departures": departures,
            "balance": bal,
            "roster_read": roster_read,
            "priorities": priorities[:4],
        }


@team_profile_router.get("/{team_id}/impact-performers")
def team_impact_performers(team_id: int, season: int = Query(CURRENT_SEASON)):
    """Top hitters + pitchers by blended impact score (all players, current
    season) for the Season tab. Flags whether each one returns next year."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """SELECT d.level FROM teams t JOIN conferences c ON t.conference_id = c.id
               JOIN divisions d ON c.division_id = d.id WHERE t.id = %s""", (team_id,))
        tr = cur.fetchone()
        level = tr["level"] if tr else None
        cur.execute("SELECT player_id, status FROM player_returning_overrides WHERE season = %s", (season,))
        ovr = {r["player_id"]: r["status"] for r in cur.fetchall()}
        portal = _portal_ids(cur)
        cur.execute(
            """SELECT bs.*, p.first_name, p.last_name, p.position, p.year_in_school
               FROM batting_stats bs JOIN players p ON p.id = bs.player_id
               WHERE bs.team_id = %s AND bs.season = %s AND COALESCE(p.is_phantom,false)=false""",
            (team_id, season))
        bat = [dict(r) for r in cur.fetchall()]
        cur.execute(
            """SELECT ps.*, p.first_name, p.last_name, p.position, p.year_in_school
               FROM pitching_stats ps JOIN players p ON p.id = ps.player_id
               WHERE ps.team_id = %s AND ps.season = %s AND COALESCE(p.is_phantom,false)=false""",
            (team_id, season))
        pit = [dict(r) for r in cur.fetchall()]

    def ret(r):
        return _returning(r.get("year_in_school"), level, ovr.get(r["player_id"]), r["player_id"] in portal)
    hq = [r for r in bat if (r.get("plate_appearances") or 0) >= 40] or \
         [r for r in bat if (r.get("plate_appearances") or 0) >= 20] or bat
    pq = [r for r in pit if _ip_to_outs(r.get("innings_pitched")) >= 30] or \
         [r for r in pit if _ip_to_outs(r.get("innings_pitched")) >= 15] or pit
    hitters = sorted((_hit_payload(r, ret(r)) for r in hq), key=lambda x: x["impact"], reverse=True)[:5]
    pitchers = sorted((_pit_payload(r, ret(r)) for r in pq), key=lambda x: x["impact"], reverse=True)[:5]
    return {"team_id": team_id, "season": season, "hitters": hitters, "pitchers": pitchers}


@team_profile_router.get("/{team_id}/identity")
def team_identity(team_id: int, season: int = Query(CURRENT_SEASON)):
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """SELECT t.id, t.short_name, t.name, t.logo_url, c.name conference,
                      d.level division_level, d.name division_name
               FROM teams t JOIN conferences c ON t.conference_id = c.id
               JOIN divisions d ON c.division_id = d.id WHERE t.id = %s""", (team_id,))
        team = cur.fetchone()
        if not team:
            return {"error": "Team not found"}
        level = team["division_level"]

        cur.execute("SELECT player_id, status FROM player_returning_overrides WHERE season = %s", (season,))
        overrides = {r["player_id"]: r["status"] for r in cur.fetchall()}
        portal = _portal_ids(cur)

        div = _division_raw(cur, level, season, overrides, portal)
        raw = div.get(team_id) or _team_raw(cur, team_id, season, level, overrides, portal)

        grades, scores = {}, {}
        radar = []
        for key, label, metric, high in _DIMS:
            peer_vals = [m[metric] for m in div.values() if m.get(metric) is not None]
            val = raw.get(metric)
            score = _pct_rank(peer_vals, val, high) if val is not None else 50.0
            scores[key] = score
            rank = None
            if val is not None and peer_vals:
                rank = sum(1 for v in peer_vals if (v > val if high else v < val)) + 1
            grades[key] = {"grade": grade_from_score(score), "score": round(score, 1),
                           "label": label, "value": _fmt_metric(key, val),
                           "rank": rank, "peers": len(peer_vals)}
            radar.append({"dim": key, "label": label, "score": round(score, 1)})
        overall = (scores["offense"] + scores["pitching"]) / 2
        grades["overall"] = {"grade": grade_from_score(overall), "score": round(overall, 1)}

        ret = {k: round(raw[k], 1) for k in ("ret_pa_pct", "ret_ip_pct", "ret_owar_pct", "ret_pwar_pct", "ret_war_pct")}
        ret_for_logic = {"ret_pa_pct": raw["ret_pa_pct"], "ret_ip_pct": raw["ret_ip_pct"]}
        name = team["short_name"] or team["name"]
        pos_tags, con_tags = _tags(scores, ret_for_logic)
        outlook_label, outlook_text = _outlook(name, ret_for_logic)

        # Fan-facing narrative (what worked, focus, outlook, what returns)
        cur.execute(
            """SELECT bs.plate_appearances, bs.on_base_pct, bs.slugging_pct, bs.ops,
                      bs.wrc_plus, bs.offensive_war, bs.batting_avg, bs.bb_pct, bs.k_pct,
                      bs.home_runs, bs.rbi, bs.stolen_bases, bs.player_id,
                      p.first_name, p.last_name, p.position, p.year_in_school
               FROM batting_stats bs JOIN players p ON p.id = bs.player_id
               WHERE bs.team_id = %s AND bs.season = %s AND COALESCE(p.is_phantom,false)=false""",
            (team_id, season))
        nbat = [dict(r) for r in cur.fetchall()]
        cur.execute(
            """SELECT ps.innings_pitched, ps.era, ps.fip, ps.siera, ps.k_pct, ps.bb_pct,
                      ps.pitching_war, ps.player_id, p.first_name, p.last_name, p.year_in_school
               FROM pitching_stats ps JOIN players p ON p.id = ps.player_id
               WHERE ps.team_id = %s AND ps.season = %s AND COALESCE(p.is_phantom,false)=false""",
            (team_id, season))
        npit = [dict(r) for r in cur.fetchall()]
        def _nret(r):
            return _returning(r.get("year_in_school"), level, overrides.get(r["player_id"]), r["player_id"] in portal)
        rb = [r for r in nbat if _nret(r)]
        rp = [r for r in npit if _nret(r)]
        _nm = lambda r: f"{r.get('first_name','') or ''} {r.get('last_name','') or ''}".strip()
        top_h = [_nm(r) for r in sorted(rb, key=_hitter_impact, reverse=True)[:3]]
        top_p = [_nm(r) for r in sorted(rp, key=_pitcher_impact, reverse=True)[:3]]
        ret_narr = {"pa_pct": raw["ret_pa_pct"], "ip_pct": raw["ret_ip_pct"],
                    "owar_pct": raw["ret_owar_pct"], "pwar_pct": raw["ret_pwar_pct"]}
        narrative = team_narrative(name, scores, ret_narr, rb, rp, top_h, top_p)

        return {
            "team_id": team_id,
            "team": name,
            "narrative": narrative,
            "division": level,
            "conference": team["conference"],
            "season": season,
            "peer_group": level,
            "peer_count": len(div),
            "identity_label": _identity_label(scores),
            "grades": grades,
            "radar": radar,
            "positive_tags": pos_tags,
            "concern_tags": con_tags,
            "suggestions": _suggestions(scores, ret_for_logic),
            "returning": ret,
            "outlook": {"label": outlook_label, "text": outlook_text},
            "snapshot": {
                "ops": round(raw["ops"], 3), "avg": round(raw["avg"], 3),
                "obp": round(raw["obp"], 3), "slg": round(raw["slg"], 3),
                "iso": round(raw["iso"], 3), "sb": raw["sb"],
                "era": round(raw["era"], 2) if raw["era"] is not None else None,
                "pit_k_pct": round(raw["pit_k_pct"] * 100, 1),
                "pit_bb_pct": round(raw["pit_bb_pct"] * 100, 1),
                "bat_k_pct": round(raw["bat_k_pct"] * 100, 1),
                "bat_bb_pct": round(raw["bat_bb_pct"] * 100, 1),
            },
        }
