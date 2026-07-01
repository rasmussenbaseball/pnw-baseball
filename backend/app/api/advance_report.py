"""
Advance-Scout Report engine.

Turns the rich (but raw) output of compute_team_scouting() into a COACH-READY
advance report: an auto-generated game plan plus per-key-player "how to attack"
bullets. This is the piece 6-4-3 Charts makes coaches assemble by hand; we
generate it automatically from our scraped + play-by-play data.

We only synthesize a narrative here. All numbers come from team_scouting so the
advance report can never disagree with the Team Scouting page.

HONEST LIMIT: we have no radar (no pitch velocity / pitch type), so every bullet
is grounded in things we DO have: tendencies, plate discipline, handedness
splits, batted-ball profile, and percentile ranks within the conference.
"""

from __future__ import annotations

from typing import Optional

from .team_scouting import compute_team_scouting


# ── formatting helpers ───────────────────────────────────────────

def _name(row: dict) -> str:
    n = f"{row.get('first_name') or ''} {row.get('last_name') or ''}".strip()
    return n or "Unnamed"


def _rate(v) -> str:
    """.380 style (leading zero dropped)."""
    if v is None:
        return "-"
    return f"{v:.3f}".replace("0.", ".", 1)


def _pct(v) -> str:
    """0.124 -> '12%'. Values are stored as fractions in splits/PBP."""
    if v is None:
        return "-"
    return f"{round(v * 100)}%"


def _num(v, d=2) -> str:
    if v is None:
        return "-"
    return f"{v:.{d}f}"


# ── per-player attack plans ──────────────────────────────────────

# Minimum sample in a handedness split before we trust the gap.
_MIN_SPLIT_PA = 20
_MIN_SPLIT_BF = 25
# wOBA / FIP gaps that count as "meaningfully" different.
_WOBA_GAP = 0.045


def _hitter_bullets(h: dict) -> list[str]:
    """Coach-facing 'how to get this guy out' notes for one hitter."""
    bullets: list[str] = []
    splits = h.get("splits") or {}
    vl, vr = splits.get("vs_lhp") or {}, splits.get("vs_rhp") or {}

    # Handedness edge (only if both sides have real sample)
    if (vl.get("pa") or 0) >= _MIN_SPLIT_PA and (vr.get("pa") or 0) >= _MIN_SPLIT_PA:
        wl, wr = vl.get("woba"), vr.get("woba")
        if wl is not None and wr is not None and abs(wl - wr) >= _WOBA_GAP:
            if wl > wr:
                bullets.append(f"Punishes LHP ({_rate(wl)} wOBA vs L, {_rate(wr)} vs R). Prefer right-handed arms.")
            else:
                bullets.append(f"Punishes RHP ({_rate(wr)} wOBA vs R, {_rate(wl)} vs L). Prefer left-handed arms.")

    # Plate discipline
    k = h.get("k_pct")
    bb = h.get("bb_pct")
    if k is not None and k >= 0.24:
        bullets.append(f"Chases and swings-and-misses (K% {_pct(k)}). Expand out of the zone with two strikes.")
    elif k is not None and bb is not None and k <= 0.14 and bb >= 0.11:
        bullets.append(f"Disciplined, tough to strike out (K% {_pct(k)}, BB% {_pct(bb)}). Attack the zone, do not nibble.")

    # Batted-ball / power shape
    air_pull = h.get("air_pull_pct")
    gb = h.get("gb_pct")
    iso = h.get("iso")
    if air_pull is not None and air_pull >= 0.45 and (iso or 0) >= 0.150:
        bullets.append(f"Pull-side power ({_pct(air_pull)} air-pull). Work him away and change eye level, do not let him extend.")
    elif gb is not None and gb >= 0.52:
        bullets.append(f"Ground-ball hitter (GB% {_pct(gb)}). Keep it down and play for the double play.")

    # RISP threat
    risp = splits.get("risp") or {}
    if (risp.get("pa") or 0) >= 12 and (risp.get("woba") or 0) >= 0.400:
        bullets.append(f"Dangerous with runners on ({_rate(risp.get('woba'))} wOBA w/RISP). Do not give in with the game on the line.")

    if not bullets:
        bullets.append("No stand-out platoon or discipline edge. Execute your normal plan and mix locations.")
    return bullets


def _threat_label(wrc_plus) -> str:
    if wrc_plus is None:
        return "unrated"
    if wrc_plus >= 140:
        return "Elite bat"
    if wrc_plus >= 115:
        return "Above-average bat"
    if wrc_plus >= 90:
        return "Average bat"
    return "Below-average bat"


def _pitcher_bullets(p: dict) -> list[str]:
    """Coach-facing 'how to hit this guy' notes for one pitcher."""
    bullets: list[str] = []
    splits = p.get("splits") or {}
    vl, vr = splits.get("vs_lhh") or {}, splits.get("vs_rhh") or {}

    # Handedness vulnerability (higher opponent wOBA/FIP = worse for the pitcher)
    if (vl.get("bf") or 0) >= _MIN_SPLIT_BF and (vr.get("bf") or 0) >= _MIN_SPLIT_BF:
        fl, fr = vl.get("fip"), vr.get("fip")
        if fl is not None and fr is not None and abs(fl - fr) >= 0.60:
            if fl > fr:
                bullets.append(f"Vulnerable to left-handed bats ({_num(fl)} FIP vs L, {_num(fr)} vs R). Stack lefties.")
            else:
                bullets.append(f"Vulnerable to right-handed bats ({_num(fr)} FIP vs R, {_num(fl)} vs L). Stack righties.")

    # Stuff / swing-and-miss
    whiff = p.get("whiff_pct")
    putaway = p.get("putaway_pct")
    if whiff is not None and whiff >= 0.28:
        bullets.append(f"Real swing-and-miss stuff (Whiff% {_pct(whiff)}). Do not get to two strikes, hunt a pitch to drive early.")
    elif whiff is not None and whiff <= 0.18:
        bullets.append(f"Pitch-to-contact (Whiff% {_pct(whiff)}). Be aggressive in the zone and put balls in play.")

    # Control
    bb = p.get("bb_pct")
    fps = p.get("fps_pct")
    if bb is not None and bb >= 0.11:
        bullets.append(f"Command issues (BB% {_pct(bb)}). Make him throw strikes, do not chase, take your walks.")
    elif bb is not None and bb <= 0.06:
        bullets.append(f"Pounds the zone (BB% {_pct(bb)}). He will not beat himself, be ready to swing early in the count.")
    if fps is not None and fps >= 0.62:
        bullets.append(f"First-pitch strike guy (FPS% {_pct(fps)}). Do not take a cookie 0-0, ambush a fastball.")

    # Batted-ball tendency for the defense / approach
    opp_gb = p.get("opp_gb_pct")
    opp_fb = p.get("opp_fb_pct")
    if opp_gb is not None and opp_gb >= 0.50:
        bullets.append(f"Ground-ball pitcher (GB% {_pct(opp_gb)}). Keeps the ball down, look to elevate.")
    elif opp_fb is not None and opp_fb >= 0.42:
        bullets.append(f"Fly-ball prone (FB% {_pct(opp_fb)}). Drive the ball in the air, especially in a hitter's park.")

    if not bullets:
        bullets.append("No glaring platoon or command weakness. Grind at-bats and work the count.")
    return bullets


# ── team-level game plan (from the conference-percentile panels) ──

# Only actionable rate stats belong in a team game plan. Raw counts (SB, HR),
# neutral-shape stats (GB%, FB%, first-pitch swing%), and in-the-weeds PBP rates
# make for awkward "attack this" advice, so they're excluded here (the per-player
# cards cover batted-ball shape where it actually matters).
_GAME_PLAN_KEYS = {
    "offense": {"on_base_pct", "slugging_pct", "ops", "woba", "wrc_plus", "iso",
                "bb_pct", "k_pct", "runs_per_game"},
    "plate_discipline": {"contact_pct", "swing_pct"},
    "pitching": {"era", "fip", "whip", "k_pct", "bb_pct", "hr_per_9", "opp_avg", "k_bb_ratio"},
}


def _panel_flags(panels: dict, panel_key: str):
    allowed = _GAME_PLAN_KEYS.get(panel_key)
    strengths, weaknesses = [], []
    for row in panels.get(panel_key, []) or []:
        if allowed is not None and row.get("key") not in allowed:
            continue
        pct = row.get("percentile")
        if pct is None:
            continue
        if pct >= 80:
            strengths.append(row)
        elif pct <= 20:
            weaknesses.append(row)
    strengths.sort(key=lambda r: r["percentile"], reverse=True)
    weaknesses.sort(key=lambda r: r["percentile"])
    return strengths, weaknesses


def _fmt_stat(row: dict) -> str:
    fmt = row.get("format")
    v = row.get("value")
    if v is None:
        return row.get("label", "")
    if fmt == "pct":
        disp = _pct(v)
    elif fmt in ("rate",):
        disp = _rate(v)
    elif fmt in ("era", "war"):
        disp = _num(v)
    else:
        disp = f"{round(v)}" if isinstance(v, (int, float)) else str(v)
    return f"{row.get('label')} {disp}"


def _game_plan(panels: dict) -> dict:
    off_s, off_w = _panel_flags(panels, "offense")
    disc_s, disc_w = _panel_flags(panels, "plate_discipline")
    pit_s, pit_w = _panel_flags(panels, "pitching")

    # When we PITCH to them: respect their offensive strengths, exploit weaknesses
    when_pitching = []
    for r in (off_s + disc_s)[:3]:
        when_pitching.append(f"Respect: {_fmt_stat(r)} (top of the conference). Do not let this beat you.")
    for r in (off_w + disc_w)[:3]:
        when_pitching.append(f"Exploit: {_fmt_stat(r)} (bottom of the conference). Attack it.")

    # When we HIT off them: exploit their pitching weaknesses, respect strengths
    when_hitting = []
    for r in pit_w[:3]:
        when_hitting.append(f"Exploit: {_fmt_stat(r)} (a staff weakness). Make them prove it.")
    for r in pit_s[:2]:
        when_hitting.append(f"Respect: {_fmt_stat(r)} (a staff strength). Pick your spots.")

    return {"when_pitching": when_pitching, "when_hitting": when_hitting}


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

def build_advance_report(cur, team_id: int, season: int, max_hitters: int = 9,
                         max_starters: int = 4, max_relievers: int = 4) -> dict:
    """
    Full opponent advance report = the Team Scouting payload + an auto-generated,
    coach-ready narrative (team game plan + per-key-player attack bullets).
    """
    scouting = compute_team_scouting(cur, team_id, season)
    if scouting.get("error"):
        return scouting

    hitters = sorted(scouting.get("hitters", []),
                     key=lambda h: h.get("plate_appearances") or 0, reverse=True)[:max_hitters]
    starters = (scouting.get("starters") or [])[:max_starters]
    relievers = (scouting.get("relievers") or [])[:max_relievers]

    key_hitters = [{
        "player_id": h.get("player_id"),
        "name": _name(h),
        "position": h.get("position"),
        "bats": h.get("bats"),
        "pa": h.get("plate_appearances"),
        "line": f"{_rate(h.get('batting_avg'))}/{_rate(h.get('on_base_pct'))}/{_rate(h.get('slugging_pct'))}",
        "wrc_plus": round(h["wrc_plus"]) if h.get("wrc_plus") is not None else None,
        "threat": _threat_label(h.get("wrc_plus")),
        "attack": _hitter_bullets(h),
    } for h in hitters]

    def _pitcher_card(p):
        return {
            "player_id": p.get("player_id"),
            "name": _name(p),
            "throws": p.get("throws"),
            "ip": p.get("innings_pitched"),
            "era": p.get("era"),
            "fip": p.get("fip"),
            "line": f"{_num(p.get('era'))} ERA / {_num(p.get('fip'))} FIP / {_pct(p.get('k_pct'))} K",
            "approach": _pitcher_bullets(p),
        }

    return {
        **scouting,
        "advance_narrative": {
            "game_plan": _game_plan(scouting.get("panels", {})),
            "key_hitters": key_hitters,
            "starters": [_pitcher_card(p) for p in starters],
            "relievers": [_pitcher_card(p) for p in relievers],
            "count_tendencies": {
                "offense": _count_tendencies_side(cur, team_id, season, "batting_team_id", "hitter"),
                "pitching": _count_tendencies_side(cur, team_id, season, "defending_team_id", "pitcher"),
            },
        },
    }
