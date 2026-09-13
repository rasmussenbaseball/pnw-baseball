"""Box-score lines from TrackMan pitch rows.

Every live TrackMan row carries the scorer's result fields (KorBB,
PlayResult, PitchCall, OutsOnPlay, RunsScored), so the traditional line
falls out of the same CSVs that feed the shape stats. What TrackMan does
NOT carry: outs on strikeouts (OutsOnPlay is filled only for balls in
play, so outs are rebuilt from results, see outs_on), earned vs unearned
runs (we show R, never ER), sac fly vs sac bunt (a "Sacrifice" is treated like a sac fly: out of the AB, in the OBP
denominator), and errors reached on (counted as an AB, no hit).

League context (wOBA, runs per PA, the FIP constant) comes from the same
corpus the view is drawn from, so wRC+ = 100 means "an average hitter in
this data" and FIP sits on the corpus's runs-allowed scale (RA/9, since
earned runs are unknown).
"""
from collections import defaultdict

WOBA_W = {"BB": 0.69, "HBP": 0.72, "Single": 0.89, "Double": 1.27, "Triple": 1.62, "HomeRun": 2.10}
WOBA_SCALE = 1.15
MIN_RATE_IP = 1.0     # WHIP / FIP / per-9 rates need at least a full inning
MIN_BAA_AB = 5
TB = {"Single": 1, "Double": 2, "Triple": 3, "HomeRun": 4}
HITS = set(TB)


def outcome(r):
    """'K' | 'BB' | 'HBP' | 'Sac' | a PlayResult ('Single'..., 'Out', 'Error',
    'FieldersChoice') | 'InPlay' (blank result) | None if the pitch did not
    end the plate appearance."""
    if r.get("k_or_bb") == "Strikeout":
        return "K"
    if r.get("k_or_bb") == "Walk":
        return "BB"
    if r.get("pitch_call") == "HitByPitch":
        return "HBP"
    pr = r.get("play_result")
    if pr == "Sacrifice":
        return "Sac"
    if pr:
        return pr
    if r.get("pitch_call") == "InPlay":
        return "InPlay"
    return None


OUT_RESULTS = {"K", "Out", "FieldersChoice", "Sac"}


def outs_on(r):
    """Outs a pitch produced, from the RESULT rather than the scorer's outs
    field: TrackMan records OutsOnPlay only for balls in play (405 of 407
    strikeouts in the corpus carry 0, a few fielder's choices and sacs too).
    A strikeout is an out, an Out/FC/Sac is at least one; the recorded
    number is trusted only when it says more (double play) or on a pitch
    that did not end the PA (pickoff, caught stealing)."""
    rec = int(r.get("outs_on_play") or 0)
    o = outcome(r)
    if o in OUT_RESULTS:
        return max(rec, 1)
    return rec


def terminal_pas(rows):
    """One terminal row per plate appearance (keyed by session/inning/half/PA)."""
    pas = {}
    for r in rows:
        o = outcome(r)
        if o is None or r.get("pa_of_inning") is None:
            continue
        key = (r.get("session_id"), r.get("inning"), r.get("top_bottom"), r.get("pa_of_inning"))
        pas.setdefault(key, r)
    return list(pas.values())


def _counts(pas):
    c = defaultdict(int)
    for r in pas:
        c[outcome(r)] += 1
    c["PA"] = len(pas)
    c["H"] = sum(c[h] for h in HITS)
    c["AB"] = c["PA"] - c["BB"] - c["HBP"] - c["Sac"]
    c["TB"] = sum(c[h] * tb for h, tb in TB.items())
    return c


def _woba(c):
    den = c["AB"] + c["BB"] + c["HBP"] + c["Sac"]
    if not den:
        return None
    return sum(c[k] * w for k, w in WOBA_W.items()) / den


def hitter_line(pas, lg=None):
    """Counting + rate line for one hitter's terminal PAs."""
    c = _counts(pas)
    if not c["PA"]:
        return None
    ab, h = c["AB"], c["H"]
    obp_den = ab + c["BB"] + c["HBP"] + c["Sac"]
    bip = ab - c["K"] - c["HomeRun"] + c["Sac"]
    woba = _woba(c)
    line = {
        "pa": c["PA"], "ab": ab, "h": h, "d2": c["Double"], "d3": c["Triple"], "hr": c["HomeRun"],
        "bb": c["BB"], "k": c["K"], "hbp": c["HBP"], "sac": c["Sac"],
        "avg": round(h / ab, 3) if ab else None,
        "obp": round((h + c["BB"] + c["HBP"]) / obp_den, 3) if obp_den else None,
        "slg": round(c["TB"] / ab, 3) if ab else None,
        "iso": round((c["TB"] - h) / ab, 3) if ab else None,
        "babip": round((h - c["HomeRun"]) / bip, 3) if bip > 0 else None,
        "woba": round(woba, 3) if woba is not None else None,
    }
    line["ops"] = round(line["obp"] + line["slg"], 3) if line["obp"] is not None and line["slg"] is not None else None
    if lg and woba is not None and lg.get("r_pa"):
        line["wrc_plus"] = round(100 * (((woba - lg["woba"]) / WOBA_SCALE) + lg["r_pa"]) / lg["r_pa"])
    return line


def pitcher_line(rows, lg=None):
    """Line for one pitcher from ALL his rows (outs and runs live on every
    pitch: pickoffs, caught stealings and foul outs count)."""
    pas = terminal_pas(rows)
    c = _counts(pas)
    outs = sum(outs_on(r) for r in rows)
    runs = sum(int(r.get("runs_scored") or 0) for r in rows)
    if not outs and not c["PA"]:
        return None
    ip = outs / 3.0
    # per-inning rates need a real inning behind them: 2 walks in a 0.1 IP
    # cameo is a 54 BB/9 nobody wants to read
    rate_ok = ip >= MIN_RATE_IP
    line = {
        "ip": round(ip, 1), "ip_str": f"{outs // 3}.{outs % 3}", "outs": outs, "bf": c["PA"],
        "h": c["H"], "r": runs, "hr": c["HomeRun"], "bb": c["BB"], "k": c["K"], "hbp": c["HBP"],
        "whip": round((c["H"] + c["BB"]) / ip, 2) if rate_ok else None,
        "baa": round(c["H"] / c["AB"], 3) if c["AB"] >= MIN_BAA_AB else None,
        "k9": round(9 * c["K"] / ip, 1) if rate_ok else None,
        "bb9": round(9 * c["BB"] / ip, 1) if rate_ok else None,
        "ra9": round(9 * runs / ip, 2) if rate_ok else None,
        "k_pct": round(100 * c["K"] / c["PA"], 1) if c["PA"] else None,
        "bb_pct": round(100 * c["BB"] / c["PA"], 1) if c["PA"] else None,
    }
    if lg and rate_ok and lg.get("fip_c") is not None:
        line["fip"] = round((13 * c["HomeRun"] + 3 * (c["BB"] + c["HBP"]) - 2 * c["K"]) / ip + lg["fip_c"], 2)
    return line


def league_context(rows):
    """Corpus-wide wOBA, runs per PA and the FIP constant from raw rows."""
    pas = terminal_pas(rows)
    c = _counts(pas)
    outs = sum(outs_on(r) for r in rows)
    runs = sum(int(r.get("runs_scored") or 0) for r in rows)
    woba = _woba(c)
    lg = {"pa": c["PA"], "woba": round(woba, 3) if woba is not None else None,
          "r_pa": (runs / c["PA"]) if c["PA"] else None}
    ip = outs / 3.0
    if ip and c["PA"]:
        core = (13 * c["HomeRun"] + 3 * (c["BB"] + c["HBP"]) - 2 * c["K"]) / ip
        lg["fip_c"] = round(9 * runs / ip - core, 2)
    else:
        lg["fip_c"] = None
    return lg


LEAGUE_SQL_COLS = """p.k_or_bb, p.play_result, p.pitch_call, p.outs_on_play, p.runs_scored,
                     p.inning, p.top_bottom, p.pa_of_inning, s.id AS session_id"""


def league_context_from_db(cur, owner, where_sql="", params=()):
    """League context for the owner's live corpus (optionally narrowed)."""
    cur.execute(
        f"""SELECT {LEAGUE_SQL_COLS}
            FROM tm_pitches p JOIN tm_sessions s ON s.id = p.session_id
            WHERE p.owner_user_id = %s AND s.session_type IN ('game', 'scrimmage', 'intrasquad')
              AND p.pitcher IS NOT NULL{where_sql}""",
        [owner, *params],
    )
    return league_context([dict(r) for r in cur.fetchall()])
