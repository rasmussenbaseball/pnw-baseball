"""Team summary over a SAMPLE of TrackMan sessions (Session Review).

One session or many: pick the days, get how the pitching staff and the
lineup performed as units, plus every player's line over that sample.
Staff = pitches thrown by the coach's team; lineup = pitches seen by the
coach's team. Everything is computed from the raw pitch rows with the same
helpers as the rest of the suite (box lines, run values, expected stats,
fair-ball predicate), so a number here matches the same number elsewhere.
"""
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, Query

from ..models.database import get_connection
from ..stats import trackman_box as box
from ..stats.trackman_runvalue import pitch_run_value
from ..stats.trackman_xstats import xwobacon
from .trackman_suite import _gate, _is_fair, _rv_baseline

router = APIRouter()

_STRIKES = {"StrikeCalled", "StrikeSwinging", "FoulBall", "FoulBallFieldable", "FoulBallNotFieldable",
            "InPlay", "AutomaticStrike"}


def _pct(n, d, dec=1):
    return round(100 * n / d, dec) if d else None


def _process(rows, live_ctx=True):
    """Pitch-level process stats shared by staff and lineup."""
    called = [r for r in rows if r["pitch_call"]]
    sw = [r for r in rows if r["is_swing"]]
    wh = [r for r in sw if r["is_whiff"]]
    oz = [r for r in rows if r["is_in_zone"] is False]
    ch = [r for r in oz if r["is_chase"]]
    zoned = [r for r in rows if r["is_in_zone"] is not None]
    iz = [r for r in zoned if r["is_in_zone"]]
    csw = [r for r in rows if r["pitch_call"] in ("StrikeCalled", "StrikeSwinging")]
    strikes = [r for r in called if r["pitch_call"] in _STRIKES]
    bbe = [r for r in rows if r["exit_speed"] is not None and _is_fair(r["pitch_call"], r["direction"])]
    evs = [float(r["exit_speed"]) for r in bbe]
    las = [(float(r["exit_speed"]), float(r["launch_angle"])) for r in bbe if r["launch_angle"] is not None]
    out = {
        "pitches": len(rows),
        "strike_pct": _pct(len(strikes), len(called)),
        "zone_pct": _pct(len(iz), len(zoned)),
        "swing_pct": _pct(len(sw), len(called)),
        "contact_pct": _pct(len(sw) - len(wh), len(sw)),
        "whiff_pct": _pct(len(wh), len(sw)),
        "chase_pct": _pct(len(ch), len(oz)),
        "csw_pct": _pct(len(csw), len(rows)),
        "bbe": len(bbe),
        "avg_ev": round(sum(evs) / len(evs), 1) if evs else None,
        "max_ev": round(max(evs), 1) if evs else None,
        "hh_pct": _pct(sum(1 for v in evs if v >= 90), len(evs)),
        "barrel_pct": _pct(sum(1 for ev, la in las if ev >= 95 and 8 <= la <= 32), len(las)),
        "gb_pct": _pct(sum(1 for _, la in las if la < 10), len(las)),
        "ld_pct": _pct(sum(1 for _, la in las if 10 <= la < 25), len(las)),
        "fb_pct": _pct(sum(1 for _, la in las if la >= 25), len(las)),
        "avg_la": round(sum(la for _, la in las) / len(las), 1) if las else None,
    }
    xw = [xwobacon(float(r["exit_speed"]), float(r["launch_angle"]), r["direction"], (r["batter_side"] or "")[:1] or None)
          for r in bbe if r["launch_angle"] is not None]
    out["xwobacon"] = round(sum(xw) / len(xw), 3) if xw else None
    return out


def _rv(rows, base):
    tot, n = 0.0, 0
    for r in rows:
        v = pitch_run_value(r["balls"], r["strikes"], r["pitch_call"], r["play_result"])
        if v is not None:
            tot += v
            n += 1
    return tot, n


def _staff_block(rows, lg, base):
    d = _process(rows)
    line = box.pitcher_line(rows, lg)
    rv, n = _rv(rows, base)
    d.update({"line": line, "rv": round(-(rv - n * base), 1) if n else None,
              "rv100": round(-100 * (rv - n * base) / n, 2) if n else None})
    return d


def _lineup_block(rows, lg, base):
    d = _process(rows)
    pas = box.terminal_pas(rows)
    line = box.hitter_line(pas, lg)
    rv, n = _rv(rows, base)
    # xwOBA: model contact value + real walks / HBP over PA
    if line and line["pa"]:
        bbe = [r for r in pas if r["exit_speed"] is not None and r["launch_angle"] is not None
               and box.outcome(r) not in ("K", "BB", "HBP")]
        xcon = sum(xwobacon(float(r["exit_speed"]), float(r["launch_angle"]), r["direction"], (r["batter_side"] or "")[:1] or None) for r in bbe)
        untracked = [r for r in pas if box.outcome(r) not in ("K", "BB", "HBP") and r not in bbe]
        actual = sum(box.WOBA_W.get(box.outcome(r), 0.0) for r in untracked)
        den = line["ab"] + line["bb"] + line["hbp"] + line["sac"]
        line["xwoba"] = round((0.69 * line["bb"] + 0.72 * line["hbp"] + xcon + actual) / den, 3) if den else None
    d.update({"line": line, "rv": round(rv - n * base, 1) if n else None,
              "rv100": round(100 * (rv - n * base) / n, 2) if n else None})
    return d


@router.get("/trackman/sessions/team-summary")
def team_summary(ids: str = Query(..., description="comma-separated session ids"),
                 team: str | None = Query(None),
                 owner: str = Depends(_gate)):
    try:
        sids = [int(x) for x in ids.split(",") if x.strip()]
    except ValueError:
        raise HTTPException(status_code=400, detail="ids must be integers")
    if not sids:
        raise HTTPException(status_code=400, detail="pick at least one session")
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("""SELECT id, session_date, session_type, home_team, away_team, stadium, pitch_count, bbe_count
                       FROM tm_sessions WHERE owner_user_id = %s AND id = ANY(%s) ORDER BY session_date""",
                    (owner, sids))
        sessions = [dict(r) for r in cur.fetchall()]
        if not sessions:
            raise HTTPException(status_code=404, detail="No sessions found.")
        for s in sessions:
            s["session_date"] = s["session_date"].isoformat() if s["session_date"] else None
        cur.execute(f"""SELECT p.pitcher, p.pitcher_team, p.pitcher_throws, p.batter, p.batter_team, p.batter_side,
                               p.pitch_call, p.is_swing, p.is_whiff, p.is_in_zone, p.is_chase,
                               p.balls, p.strikes, p.play_result, p.exit_speed, p.launch_angle, p.direction,
                               p.rel_speed, COALESCE(p.override_pitch_type, p.class_pitch_type, p.tagged_pitch_type, p.auto_pitch_type) AS ptype,
                               s.session_type, {box.LEAGUE_SQL_COLS}
                        FROM tm_pitches p JOIN tm_sessions s ON s.id = p.session_id
                        WHERE p.owner_user_id = %s AND p.session_id = ANY(%s)
                          AND COALESCE(p.class_pitch_type, '') <> 'Mistag'""",
                    (owner, sids))
        rows = [dict(r) for r in cur.fetchall()]
        lg = box.league_context_from_db(cur, owner)
        base = _rv_baseline(cur, owner, "live")
    live = [r for r in rows if r["session_type"] in ("game", "scrimmage", "intrasquad")]
    # The coach's team: passed in, else the most common team in the sample.
    if not team:
        cnt = defaultdict(int)
        for r in rows:
            for t in (r["pitcher_team"], r["batter_team"]):
                if t:
                    cnt[t] += 1
        team = max(cnt, key=cnt.get) if cnt else None
    staff_rows = [r for r in live if r["pitcher_team"] == team]
    lineup_rows = [r for r in live if r["batter_team"] == team]

    by_p = defaultdict(list)
    for r in staff_rows:
        if r["pitcher"]:
            by_p[r["pitcher"]].append(r)
    pitchers = []
    for name, rs in by_p.items():
        d = _staff_block(rs, lg, base)
        fb = [float(r["rel_speed"]) for r in rs if r["rel_speed"] is not None and r["ptype"] in ("Fastball", "Sinker", "Cutter")]
        d.update({"pitcher": name, "throws": rs[0]["pitcher_throws"],
                  "fb_velo": round(sum(fb) / len(fb), 1) if fb else None,
                  "fb_max": round(max(fb), 1) if fb else None})
        pitchers.append(d)
    pitchers.sort(key=lambda d: -d["pitches"])

    by_b = defaultdict(list)
    for r in lineup_rows:
        if r["batter"]:
            by_b[r["batter"]].append(r)
    batters = []
    for name, rs in by_b.items():
        d = _lineup_block(rs, lg, base)
        d.update({"batter": name, "side": rs[0]["batter_side"]})
        batters.append(d)
    batters.sort(key=lambda d: -d["pitches"])

    fb_all = [float(r["rel_speed"]) for r in staff_rows if r["rel_speed"] is not None and r["ptype"] in ("Fastball", "Sinker", "Cutter")]
    staff = _staff_block(staff_rows, lg, base) if staff_rows else None
    if staff:
        staff["fb_velo"] = round(sum(fb_all) / len(fb_all), 1) if fb_all else None
        staff["fb_max"] = round(max(fb_all), 1) if fb_all else None
        staff["arms"] = len(by_p)
    lineup = _lineup_block(lineup_rows, lg, base) if lineup_rows else None
    if lineup:
        lineup["hitters"] = len(by_b)
    return {"team": team, "sessions": sessions, "staff": staff, "lineup": lineup,
            "pitchers": pitchers, "batters": batters,
            "live_pitches": len(live), "total_pitches": len(rows)}
