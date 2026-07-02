"""
Series Planner — pre-series opponent game-plan logic.

Ported (nearly verbatim) from intern Trevor Kazahaya's static generator
(series-planner-final-handoff/generate_series_planner.py). The pure rule logic
(percentiles, role scorers, deterministic sentence banks, make_team_record,
build_plan) lives here so BOTH the daily batch generator
(scripts/generate_series_planner.py, which builds per-team aggregate "records")
and the live coach endpoint import one source of truth.

Split of responsibilities:
  - BATCH: fetch league leaderboards, call make_team_record() for every team,
    fetch per-hitter spray, dump backend/data/series_planner.json.
  - LIVE : load that json (cheap), run build_plan(opp, own, peers, spray) for
    the requested pairing, add the count-tendencies grid, return it.

No AI — everything is threshold/percentile driven, so results are stable and
explainable.
"""

import math
import os
import json as _json

from fastapi import APIRouter, Query, Depends
from app.models.database import get_connection
from app.config import CURRENT_SEASON
from app.api.auth import require_tier

router = APIRouter()



# ============================================================
# PORTED PURE LOGIC (Trevor's generator)
# ============================================================

def safe_div(n, d, fallback=0):
    return n / d if d else fallback


def ip_to_outs(value):
    if value is None:
        return 0
    whole = int(float(value))
    frac = int(round((float(value) - whole) * 10))
    return whole * 3 + frac


def outs_to_ip(outs):
    whole, rem = divmod(int(round(outs or 0)), 3)
    return f"{whole}.{rem}"


def pct_value(value):
    if value is None:
        return None
    return value * 100 if abs(value) <= 1.5 else value


def percentile(value, values, reverse=False):
    clean = sorted(v for v in values if v is not None and not math.isnan(v))
    if not clean or value is None:
        return 50
    below = sum(1 for v in clean if v < value)
    equal = sum(1 for v in clean if v == value)
    pct = (below + equal * 0.5) / len(clean) * 100
    return round(100 - pct if reverse else pct, 1)


def clamp(value, lo=0, hi=100):
    return max(lo, min(hi, value))


def player_name(row):
    return f"{row.get('first_name', '')} {row.get('last_name', '')}".strip() or row.get("name") or "Unknown"


def fmt_pct(value, digits=0):
    if value is None:
        return "-"
    return f"{pct_value(value):.{digits}f}%"


def fmt_num(value, digits=1):
    if value is None:
        return "-"
    return f"{value:.{digits}f}"


def fmt_ip_decimal(value):
    if value is None:
        return "-"
    if isinstance(value, str):
        return f"{float(value):.2f}"
    return f"{float(value):.2f}"


def fmt_avg(value):
    if value is None:
        return "-"
    return f"{value:.3f}".replace("0.", ".")


def confidence(score, sample=100):
    if sample < 25:
        return "Low"
    if score >= 75 or sample >= 120:
        return "High"
    return "Medium"


def summarize_team_pitching(rows):
    outs = sum(ip_to_outs(r.get("innings_pitched")) for r in rows)
    bf = sum(r.get("batters_faced") or 0 for r in rows)
    hits = sum(r.get("hits_allowed") or 0 for r in rows)
    er = sum(r.get("earned_runs") or 0 for r in rows)
    walks = sum(r.get("walks") or 0 for r in rows)
    strikeouts = sum(r.get("strikeouts") or 0 for r in rows)
    homers = sum(r.get("home_runs_allowed") or 0 for r in rows)
    starts = sum(r.get("games_started") or 0 for r in rows)
    games = sum(r.get("games") or 0 for r in rows)
    starter_rows = [r for r in rows if (r.get("games_started") or 0) >= 3 or safe_div(r.get("games_started") or 0, r.get("games") or 1) >= 0.35]
    bullpen_rows = [r for r in rows if r not in starter_rows]
    starter_outs = sum(ip_to_outs(r.get("innings_pitched")) for r in starter_rows)
    bullpen_outs = sum(ip_to_outs(r.get("innings_pitched")) for r in bullpen_rows)

    def split_summary(split_rows):
        split_outs = sum(ip_to_outs(r.get("innings_pitched")) for r in split_rows)
        split_bf = sum(r.get("batters_faced") or 0 for r in split_rows)
        split_h = sum(r.get("hits_allowed") or 0 for r in split_rows)
        split_er = sum(r.get("earned_runs") or 0 for r in split_rows)
        split_bb = sum(r.get("walks") or 0 for r in split_rows)
        split_k = sum(r.get("strikeouts") or 0 for r in split_rows)
        return {
            "ip": outs_to_ip(split_outs),
            "outs": split_outs,
            "era": safe_div(split_er * 27, split_outs, None),
            "whip": safe_div(split_h + split_bb, split_outs / 3, None),
            "k_pct": safe_div(split_k, split_bf, None),
            "bb_pct": safe_div(split_bb, split_bf, None),
        }

    return {
        "ip": outs_to_ip(outs),
        "outs": outs,
        "bf": bf,
        "era": safe_div(er * 27, outs, None),
        "whip": safe_div(hits + walks, outs / 3, None),
        "k_pct": safe_div(strikeouts, bf, None),
        "bb_pct": safe_div(walks, bf, None),
        "k_bb_pct": safe_div(strikeouts - walks, bf, None),
        "hr_per_9": safe_div(homers * 27, outs, None),
        "starts": starts,
        "appearances": games,
        "starter_ip_share": safe_div(starter_outs, outs, 0),
        "bullpen_ip_share": safe_div(bullpen_outs, outs, 0),
        "starters": split_summary(starter_rows),
        "bullpen": split_summary(bullpen_rows),
    }


def aggregate_pbp(rows, side):
    total_pa = sum(r.get("total_pa") or 0 for r in rows)
    tracked_pa = sum(r.get("tracked_pa") or 0 for r in rows)
    pitches = sum(r.get("pitches") or 0 for r in rows)
    swings = sum(r.get("swings") or 0 for r in rows)
    bb_total = sum(r.get("bb_total") or 0 for r in rows)

    def weighted(key, weight_key):
        num = sum((r.get(key) or 0) * (r.get(weight_key) or 0) for r in rows)
        den = sum(r.get(weight_key) or 0 for r in rows)
        return safe_div(num, den, None)

    payload = {
        "total_pa": total_pa,
        "tracked_pa": tracked_pa,
        "pitches": pitches,
        "pitches_per_pa": safe_div(pitches, tracked_pa, None),
        "swing_pct": safe_div(swings, pitches, None),
        "contact_pct": weighted("contact_pct", "swings"),
        "whiff_pct": weighted("whiff_pct", "swings"),
        "putaway_pct": weighted("putaway_pct", "tracked_pa"),
        "bb_total": bb_total,
    }
    if side == "batting":
        payload.update({
            "fb_pct": weighted("fb_pct", "bb_total"),
            "air_pull_pct": weighted("air_pull_pct", "bb_total"),
        })
    else:
        payload.update({
            "strike_pct": weighted("strike_pct", "pitches"),
            "first_pitch_strike_pct": weighted("first_pitch_strike_pct", "tracked_pa"),
            "gb_pct": weighted("gb_pct", "bb_total"),
        })
    return payload


def aggregate_fielding(rows):
    all_rows = [r for r in rows if r.get("position") == "ALL"]
    catcher_rows = [r for r in rows if r.get("position") == "C" or r.get("primary_position") == "C"]
    source = all_rows or rows
    errors = sum(r.get("errors") or 0 for r in source)
    chances = sum(r.get("total_chances") or 0 for r in source)
    sb_allowed = sum(r.get("stolen_bases_against") or 0 for r in catcher_rows)
    caught = sum(r.get("caught_stealing_by") or 0 for r in catcher_rows)
    passed = sum(r.get("passed_balls") or 0 for r in catcher_rows)
    pickoffs = sum(r.get("pickoffs") or 0 for r in rows)
    return {
        "errors": errors,
        "chances": chances,
        "fielding_pct": safe_div(chances - errors, chances, None),
        "errors_per_chance": safe_div(errors, chances, None),
        "catcher_sb_allowed": sb_allowed,
        "catcher_caught": caught,
        "catcher_cs_pct": safe_div(caught, caught + sb_allowed, None),
        "passed_balls": passed,
        "pickoffs": pickoffs,
    }


def role_score_hitter(row):
    pa_factor = min(1, (row.get("plate_appearances") or 0) / 150)
    return (
        (row.get("wrc_plus") or 85) * 0.34
        + (row.get("ops") or 0) * 85
        + (row.get("on_base_pct") or 0) * 45
        + (row.get("offensive_war") or 0) * 16
    ) * (0.72 + 0.28 * pa_factor)


def role_score_power(row):
    pa = row.get("plate_appearances") or 0
    return (
        (row.get("iso") or 0) * 240
        + (row.get("slugging_pct") or 0) * 60
        + safe_div(row.get("home_runs") or 0, pa, 0) * 950
        + safe_div((row.get("doubles") or 0) + (row.get("triples") or 0), pa, 0) * 280
    ) * min(1, pa / 120)


def role_score_speed(row):
    pa = row.get("plate_appearances") or 0
    attempts = (row.get("stolen_bases") or 0) + (row.get("caught_stealing") or 0)
    success = safe_div(row.get("stolen_bases") or 0, attempts, 0)
    return attempts * 5 + safe_div(attempts, pa, 0) * 600 + success * 20 + (row.get("on_base_pct") or 0) * 20


def role_score_starter(row):
    starts = row.get("games_started") or 0
    outs = ip_to_outs(row.get("innings_pitched"))
    bf = row.get("batters_faced") or 0
    kbb = (row.get("k_bb_pct") if row.get("k_bb_pct") is not None else safe_div((row.get("strikeouts") or 0) - (row.get("walks") or 0), bf, 0))
    return starts * 7 + outs * 0.14 + kbb * 140 + max(0, 7.5 - (row.get("era") or 7.5)) * 4 + max(0, 1.8 - (row.get("whip") or 1.8)) * 12


def role_score_reliever(row):
    return (
        (row.get("wpa") or 0) * 18
        + (row.get("saves") or 0) * 7
        + (row.get("holds") or 0) * 4
        + (row.get("geg") or 0) * 2.5
        + (row.get("k_pct") or 0) * 60
        - (row.get("bb_pct") or 0) * 25
        + min(30, (row.get("ip") or 0) * 0.7)
    )


def get_top_or_none(rows, scorer, min_sample=lambda r: True, exclude_ids=None):
    exclude_ids = exclude_ids or set()
    pool = [r for r in rows if r.get("player_id") not in exclude_ids and min_sample(r)]
    if not pool:
        return None
    return max(pool, key=scorer)


def variant_seed(row, salt=0):
    key = str((row or {}).get("player_id") or player_name(row or {}) or "planner")
    return sum(ord(ch) for ch in key) + salt * 17


def pick_variant(options, row, salt=0):
    clean = [item for item in options if item]
    if not clean:
        return ""
    return clean[variant_seed(row, salt) % len(clean)]


def join_plan(*parts):
    clean = []
    for part in parts:
        text = " ".join(str(part or "").split())
        if text:
            clean.append(text)
    return " ".join(clean)


def contact_mix_label(profile):
    if not profile:
        return None
    choices = [
        ("ground-ball", profile.get("gb_pct") or 0),
        ("fly-ball", profile.get("fb_pct") or 0),
        ("line-drive", profile.get("ld_pct") or 0),
    ]
    key, value = max(choices, key=lambda item: item[1])
    return {"key": key, "label": key, "value": value}


def spray_lane_text(profile, lane_type):
    if not profile:
        return None
    bats = profile.get("bats") or "R"
    labels = hitter_side_labels(bats)
    standout = profile.get(f"{lane_type}_standout") or {}
    value = standout.get("value") or 0
    key = standout.get("key")
    if value < 0.38:
        return None
    if lane_type == "air":
        lane = labels["pull_of"] if key == "pull" else labels["oppo_of"] if key == "opposite" else "center-field gap"
        return {"key": key, "lane": lane, "value": value}
    lane = labels["pull_if"] if key == "pull" else labels["oppo_if"] if key == "opposite" else "middle infield lane"
    return {"key": key, "lane": lane, "value": value}


def hitter_power_plan(row, defensive_profile=None):
    if not row:
        return ""
    name = player_name(row).split()[-1] if player_name(row) != "Unknown" else "this hitter"
    pa = row.get("plate_appearances") or 0
    iso = row.get("iso") or 0
    slg = row.get("slugging_pct") or 0
    hr_rate = safe_div(row.get("home_runs") or 0, pa, 0)
    xbh_rate = safe_div((row.get("doubles") or 0) + (row.get("triples") or 0) + (row.get("home_runs") or 0), pa, 0)
    obp = row.get("on_base_pct") or 0
    k_pct = row.get("k_pct") or 0
    bb_pct = row.get("bb_pct") or 0
    contact = contact_mix_label(defensive_profile)
    air_lane = spray_lane_text(defensive_profile, "air")
    infield_lane = spray_lane_text(defensive_profile, "infield")
    contact_text = ""
    if contact and contact["value"]:
        contact_text = f"{fmt_pct(contact['value'])} {contact['label']} contact"
    air_text = ""
    if air_lane:
        air_text = f"Air contact leans {air_lane['lane']} ({fmt_pct(air_lane['value'])})."
    infield_text = ""
    if infield_lane:
        infield_text = f"Grounders lean {infield_lane['lane']} ({fmt_pct(infield_lane['value'])})."

    damage_lane = air_text or infield_text or "Keep him out of his preferred contact lane."
    lane_defense_text = f"Defend the main lane. {infield_text or air_text}" if (infield_text or air_text) else None
    if air_lane and air_lane["key"] == "pull":
        damage_options = [
            f"Keep {name} from turning on pull-side lift. {air_text}",
            f"Protect the pull-side air lane first because that is where his carry shows up ({fmt_pct(air_lane['value'])}).",
            f"Make him hit the ball to the big part of the field instead of letting him lift to {air_lane['lane']}.",
            f"Do not miss middle-in; his air contact is tilted toward {air_lane['lane']}.",
        ]
    elif air_lane and air_lane["key"] == "opposite":
        damage_options = [
            f"Do not let {name} drive outer-half mistakes. {air_text}",
            f"Outer-half misses can still turn into damage because his air contact runs to {air_lane['lane']}.",
            f"If working away, finish off the plate instead of feeding his opposite-field lift lane.",
            f"Keep the outfield aware of opposite-field carry; {fmt_pct(air_lane['value'])} of tracked air contact goes that way.",
        ]
    elif air_lane and air_lane["key"] == "middle":
        damage_options = [
            f"Take away middle-lane carry. {air_text}",
            f"Avoid belt-high misses over the plate because his air contact stays through the center lane.",
            f"Force him to choose a side of the field instead of giving him center-cut lift.",
            f"Keep mistakes off the middle third; that is the cleanest damage lane in the spray data.",
        ]
    elif infield_lane:
        damage_options = [
            f"Defend the ground-ball lane first. {infield_text}",
            f"Pitch for weak contact, but align around the main infield lane: {infield_lane['lane']}.",
            f"When behind, avoid the pitch that lets him roll hard contact through {infield_lane['lane']}.",
            f"The spray read is more ground-ball than air-damage driven, so take away {infield_lane['lane']}.",
        ]
    else:
        damage_options = [
            damage_lane,
            "No extreme lane dominates the spray read, so win with location instead of a heavy shift plan.",
            "Use the defensive chart as a guardrail, but make the pitch plan about avoiding the heart.",
            f"Contact mix is the bigger clue here: {contact_text or 'no single tracked lane dominates'}.",
        ]

    count_options = []
    if k_pct <= 0.120 and bb_pct >= 0.110:
        count_options = [
            f"He rarely gives away at-bats ({fmt_pct(k_pct)} K%, {fmt_pct(bb_pct)} BB%), so win strike one without leaking into the middle.",
            f"Because he combines contact and patience ({fmt_pct(k_pct)} K%, {fmt_pct(bb_pct)} BB%), non-competitive misses are dangerous.",
            f"Plan for a long at-bat; he controls the zone and does not chase outs for you.",
            f"Get ahead with a quality strike, then expand only after he has to protect.",
        ]
    elif k_pct <= 0.120:
        count_options = [
            f"Chase strikeouts only after count leverage; his {fmt_pct(k_pct)} K% says routine contact is the more realistic out.",
            f"Do not build the plan around swing-and-miss. Pitch for weak contact and let the defense work.",
            f"He puts the ball in play, so the goal is soft contact in the right lane, not perfect chase.",
            f"Expand late, but expect contact and position the defense around the spray read.",
        ]
    elif k_pct >= 0.240:
        count_options = [
            f"Once ahead, expand. His {fmt_pct(k_pct)} K% gives room to finish off the plate.",
            f"Get him into protect mode; the swing-and-miss is available after strike one.",
            f"Do not give in during advantage counts. Make him chase below the zone or just off the edge.",
            f"Two-strike execution matters because the strikeout is a real out path here.",
        ]
    elif bb_pct >= 0.120:
        count_options = [
            f"Do not let patience become traffic; his {fmt_pct(bb_pct)} BB% makes competitive strike one important.",
            f"He will take the free base. Show the zone early, then move once the count is yours.",
            f"Avoid 2-0 and 3-1 damage counts by making the first miss competitive.",
            f"Make him swing to get on base; do not let the walk tool start the inning.",
        ]
    else:
        count_options = [
            "Stay unpredictable after strike one and make him beat a pitcher pitch.",
            "Win the first pitch, then change speed or eye level before returning to the lane.",
            "Avoid repeating the same look in even counts.",
            "Make the at-bat move; do not let him sit on one speed in the middle third.",
        ]

    if iso >= 0.240 or slg >= 0.600 or hr_rate >= 0.038:
        profile = pick_variant([
            f"Plus-power bat ({fmt_avg(iso)} ISO).",
            f"Game-changing power ({fmt_avg(iso)} ISO).",
            f"Extra-base threat with real carry ({fmt_avg(iso)} ISO).",
            f"Middle-order damage risk ({fmt_avg(iso)} ISO).",
        ], row, 1)
        situation = pick_variant([
            "Use first base open in leverage.",
            "With traffic on, the walk is better than the mistake.",
            "Do not let him be the swing that decides a crooked inning.",
            "In RBI spots, expand before giving him a middle-zone fastball.",
        ], row, 2)
        return join_plan(profile, pick_variant(damage_options, row, 3), pick_variant(count_options, row, 4), situation)
    if iso >= 0.160 or xbh_rate >= 0.095:
        profile = pick_variant([
            f"Above-average damage bat ({fmt_avg(iso)} ISO).",
            f"Extra-base contact shows up here ({fmt_avg(iso)} ISO).",
            f"Gap-to-power threat ({fmt_avg(iso)} ISO).",
            f"Respect the damage, even if it is not an automatic pitch-around call ({fmt_avg(iso)} ISO).",
        ], row, 5)
        attack = pick_variant([
            f"Change eye level and keep the ball away from his lift lane. {damage_lane}",
            f"Make him hit to the deepest part of the park and avoid the lane shown in the spray data.",
            f"Do not get predictable in even counts; his extra-base value comes when he can time one speed.",
            f"Use soft or elevated looks to keep him from matching the main damage lane.",
        ], row, 6)
        return join_plan(profile, attack, pick_variant(count_options, row, 7))
    if obp >= 0.410 and iso < 0.100:
        return join_plan(
            pick_variant([
                f"On-base and contact skill ({fmt_avg(obp)} OBP).",
                f"Table-setter skill set ({fmt_avg(obp)} OBP).",
                f"Traffic creator without major power ({fmt_avg(obp)} OBP).",
                f"Contact-and-walk bat ({fmt_avg(obp)} OBP).",
            ], row, 8),
            pick_variant([
                f"Strike one matters; do not give {name} free traffic.",
                "Make him swing to reach base instead of handing him the inning.",
                "Challenge early and keep the ball on the edges once ahead.",
                "Do not let a low-damage bat create a high-leverage baserunner for free.",
            ], row, 9),
            pick_variant([infield_text, contact_text, "Make him earn one base at a time."], row, 10),
        )
    if k_pct >= 0.240:
        return join_plan(
            pick_variant([
                f"Swing-and-miss opening ({fmt_pct(k_pct)} K%).",
                f"Chase is available in this matchup ({fmt_pct(k_pct)} K%).",
                f"Strikeout path is part of the plan ({fmt_pct(k_pct)} K%).",
                f"Two-strike upside is real ({fmt_pct(k_pct)} K%).",
            ], row, 11),
            pick_variant(count_options, row, 12),
            pick_variant([air_text, contact_text, "Do not give him a damage pitch before the chase count."], row, 13),
        )
    if k_pct <= 0.120:
        return join_plan(
            pick_variant([
                f"Tough contact hitter ({fmt_pct(k_pct)} K%).",
                f"Ball-in-play bat ({fmt_pct(k_pct)} K%).",
                f"Low swing-and-miss rate ({fmt_pct(k_pct)} K%).",
                f"Contact is the expected result here ({fmt_pct(k_pct)} K%).",
            ], row, 14),
            pick_variant(count_options, row, 15),
            pick_variant([lane_defense_text, "Do not over-chase strikeouts.", "Let location and positioning create the out."], row, 16),
        )
    if bb_pct >= 0.110:
        return join_plan(
            pick_variant([
                f"Patient hitter ({fmt_pct(bb_pct)} BB%).",
                f"Walk skill is part of the threat ({fmt_pct(bb_pct)} BB%).",
                f"Zone-control bat ({fmt_pct(bb_pct)} BB%).",
                f"Do not let the count become his weapon ({fmt_pct(bb_pct)} BB%).",
            ], row, 17),
            pick_variant(count_options, row, 18),
            pick_variant([air_text, infield_text, "Force contact before he controls the count."], row, 19),
        )
    return join_plan(
        pick_variant([
            "Balanced hitter.",
            "No single bat path dominates the stat line.",
            "Good enough to punish mistakes if counts get predictable.",
            "Treat him like a location test, not a free out.",
        ], row, 20),
        pick_variant(count_options, row, 21),
        f"Use the spray read: {air_text or infield_text or contact_text or 'no extreme contact lane.'}",
    )


def pitcher_attack_plan(row, role="Pitcher"):
    if not row:
        return ""
    name = player_name(row).split()[-1] if player_name(row) != "Unknown" else "him"
    bb = row.get("bb_pct")
    k = row.get("k_pct")
    whip = row.get("whip")
    era = row.get("era") or row.get("ra9")
    starts = row.get("games_started") or 0
    role_word = "starter" if starts >= 3 else "reliever"
    era_text = fmt_num(era, 2)
    k_text = fmt_pct(k)
    bb_text = fmt_pct(bb)
    whip_text = fmt_num(whip, 2)
    ip_text = fmt_ip_decimal(row.get("innings_pitched") or row.get("ip"))
    role_lower = role.lower()
    starter_note = f"He has starter length ({ip_text} IP), so early pitch-count stress matters." if starts >= 5 else ""
    relief_note = "Make him enter with traffic if possible; do not give him clean, quick outs." if "reliever" in role_lower or "bullpen" in role_lower else ""
    traffic_note = f"Traffic is available ({whip_text} WHIP); make him pitch from the stretch." if whip is not None and whip >= 1.45 else ""
    run_note = f"Run prevention has been solid ({era_text} ERA), so do not waste hittable strikes." if era is not None and era <= 4.25 else ""
    role_close = pick_variant([
        starter_note,
        relief_note,
        traffic_note,
        run_note,
        "Compete for the first good strike and avoid passive takes in hitter counts.",
        "Find which pitch he can land before widening the zone.",
        "Do not take just to take; hunt the right strike.",
        "Turn mistakes into barrels before he reaches his finish count.",
    ], row, 30)
    if bb is not None and bb >= 0.12 and k is not None and k >= 0.24:
        return join_plan(
            pick_variant([
                f"Power stuff with command risk: {k_text} K%, {bb_text} BB%.",
                f"High-variance arm: misses bats ({k_text} K%) but gives free bases ({bb_text} BB%).",
                f"Stuff can play, but command is the opening ({k_text} K%, {bb_text} BB%).",
                f"Do not chase the reputation; the walk rate says make him prove strikes ({bb_text} BB%).",
            ], row, 31),
            pick_variant([
                f"Make {name} land early strikes before protecting the edges.",
                "Pick one hitting lane and stay there until he shows command.",
                "Take the close miss early, then be ready when he has to come back.",
                "Do not expand for him; force the fastball or mistake into the zone.",
            ], row, 32),
            role_close,
        )
    if bb is not None and bb >= 0.12:
        return join_plan(
            pick_variant([
                f"Command-risk {role_word}: {bb_text} BB%.",
                f"Free-base risk is the plan hook ({bb_text} BB%).",
                f"Control issues show up in the walk rate ({bb_text} BB%).",
                f"Make command the test, not stuff ({bb_text} BB%).",
            ], row, 33),
            pick_variant([
                "Shrink the chase zone, especially with nobody on.",
                "Make him throw two competitive strikes before helping him.",
                "Use takes with purpose; when he comes middle, be ready to hit.",
                "Avoid emotional swings after wild misses. The walk has value.",
            ], row, 34),
            role_close,
        )
    if k is not None and k >= 0.28:
        return join_plan(
            pick_variant([
                f"Strikeout arm: {k_text} K%.",
                f"Swing-and-miss changes the at-bat ({k_text} K%).",
                f"Two-strike danger is real against this arm ({k_text} K%).",
                f"Hunt damage before the chase count arrives ({k_text} K%).",
            ], row, 35),
            pick_variant([
                "Pick a lane early instead of covering everything.",
                "Be aggressive on the first hittable strike because the count can turn fast.",
                "Shorten with two strikes and refuse the pitch that starts below the zone.",
                "Hunt one speed early; full coverage plays into his finish stuff.",
            ], row, 36),
            role_close,
        )
    if whip is not None and whip >= 1.55:
        return join_plan(
            pick_variant([
                f"Traffic shows up here: {whip_text} WHIP.",
                f"Baserunners are available against this arm ({whip_text} WHIP).",
                f"Stack the inning; his WHIP is {whip_text}.",
                f"Do not settle for quick contact against a traffic arm ({whip_text} WHIP).",
            ], row, 37),
            pick_variant([
                f"Avoid first-pitch rollovers and make {name} defend baserunners.",
                "Singles, walks, and HBP all matter because crooked innings are in play.",
                "Make him pitch from the stretch before selling out for damage.",
                "Keep pressure on until he shows he can finish a clean inning.",
            ], row, 38),
            pick_variant([starter_note, relief_note, "Keep pressure on until he shows clean innings."], row, 39),
        )
    if era is not None and era <= 3.50 and bb is not None and bb < 0.09:
        return join_plan(
            pick_variant([
                f"Strike-throwing run preventer: {era_text} ERA, {bb_text} BB%.",
                f"Efficient arm with run prevention behind him ({era_text} ERA).",
                f"Low-walk run preventer; he wants quick count leverage ({bb_text} BB%).",
                f"Do not wait for free bases against this arm ({bb_text} BB%).",
            ], row, 40),
            pick_variant([
                "Be ready for the first good strike; do not let him get free 0-1 counts.",
                "Attack the mistake before he expands with count leverage.",
                "Make quality contact early instead of taking hittable strikes.",
                "Force him into the zone, but do not pass up the strike you came to hit.",
            ], row, 41),
            pick_variant([traffic_note, "Make quality contact early before he expands the zone.", starter_note], row, 42),
        )
    if k is not None and k <= 0.15 and bb is not None and bb < 0.10:
        extra = starter_note or run_note or traffic_note or "Be aggressive before two strikes."
        if starts >= 5:
            return join_plan(
                pick_variant([
                    f"Low-walk starter who pitches to contact: {k_text} K%, {bb_text} BB%.",
                    f"Strike-throwing starter with limited miss-bat ({k_text} K%).",
                    f"Contact starter; the free pass is not the main opening ({bb_text} BB%).",
                    f"Starter-length strike thrower; plan for early-count contact ({ip_text} IP).",
                ], row, 43),
                pick_variant([
                    "Be ready for strike one, drive early mistakes, and make hard contact before he settles in.",
                    "Do not let him steal the first pitch. The best swing may come before two strikes.",
                    "Lift the hittable strike instead of waiting for a walk that may not come.",
                    "Make him defend hard contact early, then stretch at-bats once the lineup turns over.",
                ], row, 44),
                extra,
            )
        if "reliever" in role_lower or "bullpen" in role_lower:
            return join_plan(
                pick_variant([
                    f"Contact reliever: {k_text} K%, {bb_text} BB%.",
                    f"Low-K bullpen arm ({k_text} K%).",
                    f"This relief look leans contact over swing-and-miss ({k_text} K%).",
                    f"Do not treat this as a chase-stuff reliever ({k_text} K%).",
                ], row, 45),
                pick_variant([
                    "Do not give him quick rollover outs.",
                    "Look for a pitch up or over the plate before two strikes.",
                    "Make his first few pitches get hit hard; do not let him settle with soft contact.",
                    "Use the whole field and force the defense to make plays under pressure.",
                ], row, 46),
                extra,
            )
        return join_plan(
            pick_variant([
                f"Low-K strike thrower: {k_text} K%, {bb_text} BB%.",
                f"Pitch-to-contact arm with control ({k_text} K%, {bb_text} BB%).",
                f"The ball should be in play against this arm ({k_text} K%).",
                f"Strike throwing is the strength, not overpowering stuff ({bb_text} BB%).",
            ], row, 47),
            pick_variant([
                "Do not get overly passive.",
                "Attack hittable strikes and avoid soft contact in pitcher-friendly counts.",
                "Look to drive the first mistake in the zone.",
                "Make contact with intent before he gets easy count leverage.",
            ], row, 48),
            extra,
        )
    if bb is not None and bb >= 0.10:
        return join_plan(
            pick_variant([
                f"Middle-command arm: {bb_text} BB% with {whip_text} WHIP.",
                f"There is some command give here ({bb_text} BB%).",
                f"Not wild, but not a pure strike thrower either ({bb_text} BB%).",
                f"Make him prove the zone without becoming passive ({bb_text} BB%).",
            ], row, 49),
            pick_variant([
                f"Make {name} finish at-bats, but be ready when he comes back into the zone.",
                "Spoil borderline pitches and wait for the correction mistake.",
                "The walk is possible, but the better swing may come when he has to recover the count.",
                "Stay disciplined early and aggressive once the pitch leaks back over the plate.",
            ], row, 50),
            role_close,
        )
    if k is not None and k <= 0.18:
        return join_plan(
            pick_variant([
                f"Pitch-to-contact arm: {k_text} K%.",
                f"Contact should be available ({k_text} K%).",
                f"Low-to-average miss-bat arm ({k_text} K%).",
                f"Put the defense in motion against this strikeout rate ({k_text} K%).",
            ], row, 51),
            pick_variant([
                "Put the first good strike in play with intent, especially before two strikes.",
                "Do not let called strikes create a pitcher-friendly count.",
                "The goal is hard contact, not deep-count survival.",
                "Make him pay for early-zone strikes before he can change eye level.",
            ], row, 52),
            traffic_note or role_close,
        )
    return join_plan(
        pick_variant([
            f"Balanced arm: {era_text} ERA, {whip_text} WHIP, {k_text} K%.",
            f"Mixed look without one automatic attack point ({era_text} ERA, {whip_text} WHIP).",
            f"Treat him as a read-and-adjust arm ({k_text} K%, {bb_text} BB%).",
            f"No single attack lane dominates, so win the mistake window ({whip_text} WHIP).",
        ], row, 53),
        pick_variant([
            f"Find which pitch {name} can land that day, then hunt the mistake window.",
            "Use the first trip through to identify the pitch he is stealing for strikes.",
            "Do not chase early; do not pass up the ball you can drive.",
            "Let count leverage decide aggression instead of using a one-size plan.",
        ], row, 54),
        role_close,
    )


def pitcher_plan_payload(row, role):
    if not row:
        return None
    ip = row.get("innings_pitched") or row.get("ip")
    era = row.get("era") or row.get("ra9")
    ip_label = fmt_ip_decimal(ip)
    return {
        "player_id": row.get("player_id"),
        "name": player_name(row),
        "role": role,
        "reason": f"{ip_label} IP · {fmt_num(era, 2)} ERA · K% {fmt_pct(row.get('k_pct'))} · BB% {fmt_pct(row.get('bb_pct'))}",
        "plan": pitcher_attack_plan(row, role),
        "stats": {
            "ip": ip,
            "era": era,
            "whip": row.get("whip"),
            "k_pct": row.get("k_pct"),
            "bb_pct": row.get("bb_pct"),
            "starts": row.get("games_started"),
            "saves": row.get("saves"),
            "holds": row.get("holds"),
        },
    }


def threat_payload(row, role, reason, plan=None):
    if not row:
        return None
    return {
        "player_id": row.get("player_id"),
        "name": player_name(row),
        "role": role,
        "position": row.get("position") or row.get("primary_position") or "P",
        "hand": row.get("bats") or row.get("throws") or "",
        "reason": reason,
        "plan": plan or "",
        "stats": {
            "pa": row.get("plate_appearances"),
            "ops": row.get("ops"),
            "wrc_plus": row.get("wrc_plus"),
            "obp": row.get("on_base_pct"),
            "slg": row.get("slugging_pct"),
            "iso": row.get("iso"),
            "hr": row.get("home_runs"),
            "sb": row.get("stolen_bases"),
            "ip": row.get("innings_pitched") or row.get("ip"),
            "era": row.get("era") or row.get("ra9"),
            "whip": row.get("whip"),
            "k_pct": row.get("k_pct"),
            "bb_pct": row.get("bb_pct"),
            "saves": row.get("saves"),
            "holds": row.get("holds"),
        },
    }


def hitter_threat_reason(row):
    pa = row.get("plate_appearances") or 0
    hr = row.get("home_runs") or 0
    sb = row.get("stolen_bases") or 0
    extras = []
    if hr:
        extras.append(f"{hr} HR")
    if sb:
        extras.append(f"{sb} SB")
    suffix = f" · {' · '.join(extras)}" if extras else ""
    return f"{pa} PA{suffix}"


def combine_spray_zones(zones, bats):
    zones = zones or {}
    if bats == "L":
        air_pull = (zones.get("RF") or 0) + (zones.get("RC") or 0)
        air_mid = zones.get("CF") or 0
        air_oppo = (zones.get("LF") or 0) + (zones.get("LC") or 0)
        inf_pull = zones.get("IF_1B") or 0
        inf_mid = (zones.get("IF_MID") or 0) + (zones.get("IF_2B") or 0) + (zones.get("IF_C") or 0)
        inf_oppo = (zones.get("IF_3B") or 0) + (zones.get("IF_SS") or 0)
    else:
        air_pull = (zones.get("LF") or 0) + (zones.get("LC") or 0)
        air_mid = zones.get("CF") or 0
        air_oppo = (zones.get("RF") or 0) + (zones.get("RC") or 0)
        inf_pull = (zones.get("IF_3B") or 0) + (zones.get("IF_SS") or 0)
        inf_mid = (zones.get("IF_MID") or 0) + (zones.get("IF_2B") or 0) + (zones.get("IF_C") or 0)
        inf_oppo = zones.get("IF_1B") or 0
    air_total = air_pull + air_mid + air_oppo
    inf_total = inf_pull + inf_mid + inf_oppo
    return {
        "air": {
            "pull": safe_div(air_pull, air_total, 0),
            "middle": safe_div(air_mid, air_total, 0),
            "opposite": safe_div(air_oppo, air_total, 0),
            "total": air_total,
        },
        "infield": {
            "pull": safe_div(inf_pull, inf_total, 0),
            "middle": safe_div(inf_mid, inf_total, 0),
            "opposite": safe_div(inf_oppo, inf_total, 0),
            "total": inf_total,
        },
    }


def spray_standout(split):
    choices = [("pull", split.get("pull") or 0), ("middle", split.get("middle") or 0), ("opposite", split.get("opposite") or 0)]
    key, value = max(choices, key=lambda item: item[1])
    label = {"pull": "Pull", "middle": "Middle", "opposite": "Oppo"}[key]
    return {"key": key, "label": label, "value": value}


def hitter_side_labels(bats):
    if bats == "L":
        return {
            "pull_if": "right side (1B/2B)",
            "oppo_if": "left side (SS/3B)",
            "pull_of": "RF/right-center",
            "oppo_of": "LF/left-center",
        }
    return {
        "pull_if": "left side (3B/SS)",
        "oppo_if": "right side (1B/2B)",
        "pull_of": "LF/left-center",
        "oppo_of": "RF/right-center",
    }


def positioning_recommendation(hitter, pitch_level):
    profile = (pitch_level or {}).get("contact_profile") or {}
    spray = (pitch_level or {}).get("spray_chart") or {}
    zones = spray.get("all") or {}
    bats = profile.get("bats") or hitter.get("bats") or "R"
    split = combine_spray_zones(zones, bats)
    sample = profile.get("spray_total") or spray.get("all_total") or 0
    gb = profile.get("gb_pct") or 0
    fb = profile.get("fb_pct") or 0
    iso = hitter.get("iso") or 0
    xbh_split = combine_spray_zones(spray.get("xbh") or {}, bats)["air"]
    labels = hitter_side_labels(bats)
    inf_star = spray_standout(split["infield"])
    air_star = spray_standout(split["air"])
    if iso >= 0.240:
        power_level = "Plus Power"
    elif iso >= 0.160:
        power_level = "Above Average Power"
    elif iso >= 0.090:
        power_level = "Average Power"
    elif iso >= 0.050:
        power_level = "Low Power"
    else:
        power_level = "Extra Low Power"

    recs = []
    if sample < 20:
        recs.append("Use standard alignment; tracked spray sample is limited.")
    elif gb >= 0.42 and split["infield"]["pull"] >= 0.48:
        recs.append(f"Shade the {labels['pull_if']} toward the pull lane; keep the middle infielder ready to close the hole.")
    elif gb >= 0.42 and split["infield"]["middle"] >= 0.48:
        recs.append("Pinch SS/2B toward the middle lane; take away ground balls through the bag area.")
    elif split["infield"]["opposite"] >= 0.35:
        recs.append(f"Respect opposite-field ground balls to the {labels['oppo_if']}; avoid an aggressive pull-side over-shift.")
    elif inf_star["value"] >= 0.44:
        recs.append(f"Lean slightly toward the {inf_star['label'].lower()} infield lane, but keep the alignment close to standard.")
    else:
        recs.append("No major infield shift recommended.")

    if sample >= 20:
        if iso >= 0.24:
            damage_side = labels["pull_of"] if air_star["key"] == "pull" else labels["oppo_of"] if air_star["key"] == "opposite" else "both gaps"
            recs.append(f"Power level: plus. Outfield should use no-doubles depth in leverage; protect {damage_side} first and make singles acceptable.")
        elif iso >= 0.16 and (fb >= 0.34 or xbh_split["pull"] >= 0.45):
            recs.append(f"Power level: above average. Outfield should respect pull-side damage to {labels['pull_of']} and play normal-to-deep.")
        elif iso <= 0.08 and fb <= 0.30:
            depth = "a step shallow" if iso >= 0.05 else "shallow unless game state says no doubles"
            recs.append(f"Power level: {power_level.replace(' Power', '').lower()}. Outfield can play {depth}; most air contact is not carrying with extra-base force.")
        elif split["air"]["opposite"] >= 0.35:
            recs.append(f"Power level: {power_level.lower()}. Do not abandon the opposite-field gap toward {labels['oppo_of']}.")
        elif air_star["value"] >= 0.45:
            recs.append(f"Power level: {power_level.lower()}. Lean the outfield conversation toward {air_star['label'].lower()} air contact; keep CF connected to that lane.")
        else:
            recs.append(f"Power level: {power_level.lower()}. Standard outfield depth.")

    return {
        "player_id": hitter.get("player_id"),
        "name": player_name(hitter),
        "bats": bats,
        "position": hitter.get("position"),
        "pa": hitter.get("plate_appearances"),
        "gb_pct": gb,
        "fb_pct": fb,
        "ld_pct": profile.get("ld_pct"),
        "iso": iso,
        "power_level": power_level,
        "infield": split["infield"],
        "air": split["air"],
        "infield_standout": inf_star,
        "air_standout": air_star,
        "recommendation": " ".join(recs),
        "confidence": confidence(70, sample),
        "sample": sample,
    }


def identity_tags(team, peers):
    stats = team["offense"]
    pit = team["pitching"]
    pbp_bat = team["batting_pbp"]
    tags = []

    def add(label, detail, score):
        tags.append({"label": label, "detail": detail, "score": round(score, 1)})

    if percentile(stats.get("k_pct"), [p["offense"].get("k_pct") for p in peers], reverse=True) >= 70:
        add("Contact-Oriented Offense", f"{fmt_pct(stats.get('k_pct'))} team K rate", 76)
    if percentile(stats.get("iso"), [p["offense"].get("iso") for p in peers]) >= 72 or percentile(stats.get("hr_pa"), [p["offense"].get("hr_pa") for p in peers]) >= 72:
        add("Damage-Capable Lineup", f"{fmt_avg(stats.get('iso'))} ISO with {stats.get('hr', 0)} HR", 78)
    if percentile(stats.get("bb_pct"), [p["offense"].get("bb_pct") for p in peers]) >= 72:
        add("High-Walk Offense", f"{fmt_pct(stats.get('bb_pct'))} walk rate", 74)
    if percentile(stats.get("sb_attempt_rate"), [p["offense"].get("sb_attempt_rate") for p in peers]) >= 72:
        add("Active Baserunning", f"{fmt_pct(stats.get('sb_attempt_rate'))} SB attempts per PA", 76)
    if percentile(pit.get("starter_ip_share"), [p["pitching"].get("starter_ip_share") for p in peers]) >= 70:
        add("Starter-Heavy Staff", f"{fmt_pct(pit.get('starter_ip_share'))} of staff innings from likely starters", 72)
    if percentile(pit.get("bb_pct"), [p["pitching"].get("bb_pct") for p in peers], reverse=True) >= 72:
        add("Strike-Throwing Staff", f"{fmt_pct(pit.get('bb_pct'))} staff BB rate", 72)
    if percentile(pit.get("k_pct"), [p["pitching"].get("k_pct") for p in peers]) >= 72:
        add("Miss-Bat Staff", f"{fmt_pct(pit.get('k_pct'))} staff K rate", 76)
    if percentile(pit.get("era"), [p["pitching"].get("era") for p in peers], reverse=True) >= 72:
        add("Run-Prevention Staff", f"{fmt_num(pit.get('era'), 2)} team ERA", 75)
    if percentile(pit.get("whip"), [p["pitching"].get("whip") for p in peers]) >= 70:
        add("Traffic-Prone Staff", f"{fmt_num(pit.get('whip'), 2)} staff WHIP", 73)
    if percentile((pit.get("bullpen") or {}).get("bb_pct"), [(p["pitching"].get("bullpen") or {}).get("bb_pct") for p in peers]) >= 72:
        add("Bullpen Command Risk", f"{fmt_pct((pit.get('bullpen') or {}).get('bb_pct'))} bullpen BB rate", 75)
    if (pit.get("bullpen") or {}).get("era") and percentile((pit.get("bullpen") or {}).get("era"), [(p["pitching"].get("bullpen") or {}).get("era") for p in peers]) >= 72:
        add("Bullpen Run Risk", f"{fmt_num((pit.get('bullpen') or {}).get('era'), 2)} bullpen ERA", 74)
    if pbp_bat.get("contact_pct") and percentile(pbp_bat.get("contact_pct"), [p["batting_pbp"].get("contact_pct") for p in peers]) >= 72:
        add("Puts the Ball in Play", f"{fmt_pct(pbp_bat.get('contact_pct'))} tracked contact rate", 73)

    return sorted(tags, key=lambda x: x["score"], reverse=True)[:4] or [{"label": "Balanced Profile", "detail": "No extreme team identity tags triggered.", "score": 55}]


def opportunity_cards(opp, own, peers):
    cards = []
    off = opp["offense"]
    pit = opp["pitching"]
    field = opp["fielding"]
    own_off = own["offense"]

    def add(title, body, metric, confidence_score=70):
        if not any(card["title"] == title for card in cards):
            cards.append({"title": title, "body": body, "metric": metric, "confidence": confidence(confidence_score, 120)})

    bottom = opp["lineup_tiers"]["bottom"]
    if bottom["ops"] and bottom["ops"] < off.get("ops", 0) * 0.86:
        add("Make the Bottom Third Beat You", f"Projected 7-9 hitters sit at {fmt_avg(bottom['ops'])} OPS, below the team mark of {fmt_avg(off.get('ops'))}.", "Projected lineup depth")
    if percentile(off.get("bb_pct"), [p["offense"].get("bb_pct") for p in peers], reverse=True) >= 68:
        add("Stay in the Zone Early", f"Their walk rate is only {fmt_pct(off.get('bb_pct'))}. Get ahead and make them prove they can create traffic without help.", "Opponent BB%")
    if percentile(off.get("iso"), [p["offense"].get("iso") for p in peers]) >= 72:
        add("Limit Extra-Base Mistakes", f"The lineup carries a {fmt_avg(off.get('iso'))} ISO. Avoid middle-zone misses with traffic on and make damage bats hit pitcher pitches.", "Opponent ISO")
    elif percentile(off.get("iso"), [p["offense"].get("iso") for p in peers]) <= 35:
        add("Challenge Low-Damage Contact", f"Their team ISO is {fmt_avg(off.get('iso'))}. Do not create offense for them with walks when contact is unlikely to beat you for multiple bases.", "Opponent ISO")
    if percentile((pit.get("bullpen") or {}).get("bb_pct"), [(p["pitching"].get("bullpen") or {}).get("bb_pct") for p in peers]) >= 70:
        add("Force Bullpen Command Decisions", f"Their bullpen walks {fmt_pct((pit.get('bullpen') or {}).get('bb_pct'))} of batters faced. Our offense walks {fmt_pct(own_off.get('bb_pct'))}.", "Bullpen BB% + team BB%")
    if (pit.get("bullpen") or {}).get("era") and (pit.get("bullpen") or {}).get("era") >= 6.5:
        add("Make the Starter Work", f"The bullpen ERA is {fmt_num((pit.get('bullpen') or {}).get('era'), 2)}. Long innings early can turn into a series edge later.", "Bullpen run prevention")
    if percentile(pit.get("starter_ip_share"), [p["pitching"].get("starter_ip_share") for p in peers]) >= 72:
        add("Disrupt Starter Dependence", f"The starter group covers {fmt_pct(pit.get('starter_ip_share'))} of staff innings. Raising pitch count can force them away from their preferred game script.", "Starter IP share")
    if percentile(pit.get("bb_pct"), [p["pitching"].get("bb_pct") for p in peers]) >= 68:
        add("Take the Free Bases", f"The staff walks {fmt_pct(pit.get('bb_pct'))} of batters faced. Shrink chase zones and make them finish plate appearances.", "Staff BB%")
    if percentile(pit.get("k_pct"), [p["pitching"].get("k_pct") for p in peers]) <= 40 and own_off.get("k_pct") is not None:
        add("Use Contact to Create Pressure", f"Their staff K rate is {fmt_pct(pit.get('k_pct'))}, and your team's K rate is {fmt_pct(own_off.get('k_pct'))}. Put the ball in play and force routine execution.", "Staff K% + team K%")
    if percentile(off.get("k_pct"), [p["offense"].get("k_pct") for p in peers]) >= 70:
        add("Expand Strikeout Opportunities", f"The opponent K rate is {fmt_pct(off.get('k_pct'))}, creating room to chase swing-and-miss in advantage counts.", "Opponent K%")
    if percentile(off.get("bb_pct"), [p["offense"].get("bb_pct") for p in peers]) >= 70:
        add("Avoid Leadoff Free Bases", f"Their offense walks at a {fmt_pct(off.get('bb_pct'))} rate. Make the first two hitters of each inning earn their way on.", "Opponent BB%")
    primary = (opp.get("big_three") or [None])[0]
    primary_stats = (primary or {}).get("stats") or {}
    if primary and ((primary_stats.get("iso") or 0) >= 0.170 or (primary_stats.get("ops") or 0) >= 0.950):
        add("Script the Damage Bat", f"{primary['name']} is the swing player in leverage spots. Decide before the inning when to challenge, expand, or use first base open.", "Primary threat plan")
    if off.get("gdp") and off.get("gdp") >= 20:
        add("Hunt Double-Play Contact", f"They have grounded into {off.get('gdp')} double plays. With a runner on first, prioritize ground-ball lanes over strikeout-only thinking.", "GDP")
    if field.get("errors_per_chance") and percentile(field.get("errors_per_chance"), [p["fielding"].get("errors_per_chance") for p in peers]) >= 70:
        add("Apply Defensive Pressure", f"Their fielding error rate is elevated at {fmt_pct(field.get('errors_per_chance'))} of chances.", "Fielding error rate")
    if field.get("passed_balls") and field.get("passed_balls") >= 10:
        add("Pressure Balls in the Dirt", f"Their catchers have {field.get('passed_balls')} passed balls in the fielding data. Secondary leads and dirt-ball reads matter.", "Passed balls")
    cs = field.get("catcher_cs_pct")
    if cs is not None and cs < 0.22 and own_off.get("sb_success") >= 0.70:
        add("Run Selectively", f"Opponent catchers are at {fmt_pct(cs)} caught stealing while our offense converted {fmt_pct(own_off.get('sb_success'))} of steals.", "Catcher CS% + team SB%")

    return cards[:5] or [{"title": "Win the Standard Edges", "body": "No glaring statistical weakness triggered. Prioritize clean innings, free-base prevention, and matchup execution.", "metric": "Balanced opponent", "confidence": "Medium"}]


def decision_cards(opp, own, peers):
    cards = []
    off = opp["offense"]
    pit = opp["pitching"]
    field = opp["fielding"]
    own_off = own["offense"]
    own_field = own["fielding"]

    def add(question, answer, level, why):
        cards.append({"question": question, "answer": answer, "confidence": level, "why": why})

    cs = field.get("catcher_cs_pct")
    if cs is not None and cs < 0.22 and own_off.get("sb_success") >= 0.70:
        add("Green light the run game?", "Yes, selectively", "High", f"Opponent catcher CS% is {fmt_pct(cs)} and our 2026 SB success is {fmt_pct(own_off.get('sb_success'))}. Pick counts, jumps, and the right runners.")
    elif cs is not None and cs > 0.34:
        add("Green light the run game?", "Be careful", "Medium", f"Opponent catcher CS% is {fmt_pct(cs)}. Run only with clear jumps, plus runners, or a pitcher-time edge.")
    else:
        add("Green light the run game?", "Game-state dependent", "Medium", "No automatic green light. Let runner, pitcher time, count, and score drive the call.")

    error_pct = field.get("errors_per_chance") or 0
    own_sh_rate = own_off.get("sh_rate") or 0
    if error_pct >= 0.035 or own_sh_rate >= 0.012:
        add("Use the short game?", "Selective pressure", "Medium", f"Opponent defense shows {fmt_pct(error_pct)} errors per chance and our sac-bunt rate is {fmt_pct(own_sh_rate)} per PA. Use it when the defense has to make a clean play.")
    elif own_off.get("ops", 0) >= 0.780:
        add("Use the short game?", "Usually no", "Medium", f"Our offense produced a {fmt_avg(own_off.get('ops'))} OPS. Avoid giving away outs unless late leverage says one run is the inning.")
    else:
        add("Use the short game?", "Situation only", "Medium", "No strong bunt edge triggered. Use it for runner advancement, pitcher fielding weakness, or late one-run baseball.")

    bp_bb = (pit.get("bullpen") or {}).get("bb_pct")
    bp_whip = (pit.get("bullpen") or {}).get("whip")
    if percentile(bp_bb, [(p["pitching"].get("bullpen") or {}).get("bb_pct") for p in peers]) >= 70 or (bp_whip and bp_whip >= 1.65):
        add("Get to the bullpen?", "Yes", "High", f"The bullpen shows {fmt_pct(bp_bb)} BB rate and {fmt_num(bp_whip, 2)} WHIP. Make starters work, then make relief arms pitch with traffic.")
    elif percentile(pit.get("starter_ip_share"), [p["pitching"].get("starter_ip_share") for p in peers]) >= 72:
        add("Get to the bullpen?", "Get there first", "Medium", f"They lean on the starter group ({fmt_pct(pit.get('starter_ip_share'))} of innings). Long at-bats can get them off their pitching script.")
    else:
        add("Get to the bullpen?", "Neutral", "Medium", "The staff split does not show a clear bullpen target. Build the first plan around the probable starter.")

    top = opp["big_three"][0] if opp.get("big_three") else None
    if top:
        top_stats = top.get("stats") or {}
        iso = top_stats.get("iso") or 0
        ops = top_stats.get("ops") or 0
        if iso >= 0.170 or ops >= 0.950:
            add("Use the open base?", "Yes, in leverage", "High", f"{top['name']} is a damage bat ({fmt_avg(iso)} ISO, {fmt_avg(ops)} OPS). Do not give in with traffic on or first base open.")
        elif iso >= 0.120:
            add("Use the open base?", "Careful, not automatic", "Medium", f"{top['name']} has enough power to manage carefully, but the free base should depend on the next hitter and base/out state.")
        else:
            add("Use the open base?", "Usually attack", "Medium", f"{top['name']} is the best overall threat, but the power signal is not extreme. Attack edges instead of handing out free bases.")

    opp_attempt = off.get("sb_attempt_rate") or 0
    opp_success = off.get("sb_success") or 0
    own_cs = own_field.get("catcher_cs_pct")
    if opp_attempt >= 0.045 and opp_success >= 0.70:
        add("Control the free 90?", "Yes", "High", f"Opponent attempts steals at {fmt_pct(opp_attempt)} per PA and succeeds {fmt_pct(opp_success)}. Use slide steps, varied looks, and early pitchouts if patterns show.")
    elif own_cs is not None and own_cs >= 0.32:
        add("Control the free 90?", "Normal attention", "Medium", f"Our catcher CS% is {fmt_pct(own_cs)}, so avoid over-disrupting pitcher rhythm unless their top runners reach.")
    else:
        add("Control the free 90?", "Runner-specific", "Medium", "The team rate is not an automatic red flag. Focus attention on the individual speed threats.")

    return cards


def grade_strengths(team, peers):
    off = team["offense"]
    pit = team["pitching"]
    items = [
        ("offense", "Run Creation", percentile(off.get("wrc_plus"), [p["offense"].get("wrc_plus") for p in peers]), f"{fmt_num(off.get('wrc_plus'), 0)} wRC+"),
        ("offense", "Contact", percentile(off.get("k_pct"), [p["offense"].get("k_pct") for p in peers], reverse=True), f"{fmt_pct(off.get('k_pct'))} K%"),
        ("offense", "Plate Discipline", percentile(off.get("bb_pct"), [p["offense"].get("bb_pct") for p in peers]), f"{fmt_pct(off.get('bb_pct'))} BB%"),
        ("offense", "Power", percentile(off.get("iso"), [p["offense"].get("iso") for p in peers]), f"{fmt_avg(off.get('iso'))} ISO"),
        ("offense", "Run Game", percentile(off.get("sb_attempt_rate"), [p["offense"].get("sb_attempt_rate") for p in peers]) * 0.55 + percentile(off.get("sb_success"), [p["offense"].get("sb_success") for p in peers]) * 0.45, f"{fmt_pct(off.get('sb_success'))} SB%"),
        ("pitching", "Run Prevention", percentile(pit.get("era"), [p["pitching"].get("era") for p in peers], reverse=True), f"{fmt_num(pit.get('era'), 2)} ERA"),
        ("pitching", "Miss Bats", percentile(pit.get("k_pct"), [p["pitching"].get("k_pct") for p in peers]), f"{fmt_pct(pit.get('k_pct'))} K%"),
        ("pitching", "Strike Throwing", percentile(pit.get("bb_pct"), [p["pitching"].get("bb_pct") for p in peers], reverse=True), f"{fmt_pct(pit.get('bb_pct'))} BB%"),
    ]
    return sorted([{"side": side, "label": label, "score": round(score, 1), "detail": detail} for side, label, score, detail in items], key=lambda x: x["score"], reverse=True)


def matchup_edges(own, opp, peers):
    own_scores = {item["label"]: item for item in grade_strengths(own, peers)}
    opp_scores = {item["label"]: item for item in grade_strengths(opp, peers)}
    edges = []
    for label, own_item in own_scores.items():
        opp_item = opp_scores.get(label)
        if not opp_item:
            continue
        diff = own_item["score"] - opp_item["score"]
        if own_item["score"] >= 52 and diff >= 5:
            edges.append({
                "side": own_item["side"],
                "label": label,
                "score": round(diff, 1),
                "detail": f"{own['team']['short_name']}: {own_item['detail']} vs {opp['team']['short_name']}: {opp_item['detail']}",
            })
    edges.sort(key=lambda item: item["score"], reverse=True)
    if edges:
        return edges[:6]
    return [{
        "side": "neutral",
        "label": "No Clear Statistical Edge",
        "score": 0,
        "detail": f"{own['team']['short_name']} does not beat this opponent by the current edge threshold in the main team-stat categories.",
    }]


def lineup_tiers(hitters):
    ordered = sorted([h for h in hitters if (h.get("plate_appearances") or 0) > 20], key=lambda r: r.get("plate_appearances") or 0, reverse=True)[:9]
    tiers = {"top": ordered[:3], "middle": ordered[3:6], "bottom": ordered[6:9]}

    def agg(rows):
        pa = sum(r.get("plate_appearances") or 0 for r in rows)
        return {
            "names": [player_name(r) for r in rows],
            "pa": pa,
            "ops": safe_div(sum((r.get("ops") or 0) * (r.get("plate_appearances") or 0) for r in rows), pa, None),
            "wrc_plus": safe_div(sum((r.get("wrc_plus") or 0) * (r.get("plate_appearances") or 0) for r in rows), pa, None),
        }
    return {k: agg(v) for k, v in tiers.items()}


def build_brief(opp, own=None):
    tags = ", ".join(t["label"].lower() for t in opp["identity"][:3])
    tag_labels = " · ".join(t["label"] for t in opp["identity"][:3])
    strengths = sorted(opp["strengths"], key=lambda x: x["score"], reverse=True)[:2]
    weaknesses = sorted(opp["strengths"], key=lambda x: x["score"])[:2]
    off = opp["offense"]
    pit = opp["pitching"]
    bullpen = pit.get("bullpen") or {}
    opponent_name = opp["team"]["short_name"]
    keys = []
    if any(s["label"] == "Strike Throwing" and s["score"] < 45 for s in opp["strengths"]):
        keys.append("Own the zone; make their staff throw two real strikes.")
    if (opp["pitching"].get("bullpen") or {}).get("bb_pct") and (opp["pitching"].get("bullpen") or {}).get("bb_pct") > 0.10:
        keys.append("Run up starter pitch counts and get into the command-risk bullpen.")
    if opp["offense"].get("sb_attempt_rate", 0) >= 0.045:
        keys.append("Control the free 90: holds, looks, slide step, and dirt-ball reads.")
    if opp["lineup_tiers"]["bottom"]["ops"] and opp["lineup_tiers"]["bottom"]["ops"] < opp["offense"].get("ops", 0) * 0.86:
        keys.append("Make the bottom third beat us with bats, not walks or mistakes.")
    if len(keys) < 3:
        fallback_keys = [
            f"Win strike one against {opponent_name}'s top third before the inning gets loud.",
            "Make starters pitch with traffic before the lineup turns over.",
            "Turn routine contact into clean outs; do not extend innings with free bases.",
            "Know the open-base rule before their best bat reaches the box.",
            "Win the first hitter after every pitching change.",
        ]
        for key in fallback_keys:
            if key not in keys:
                keys.append(key)
            if len(keys) >= 3:
                break
    if not keys:
        keys = ["No free 90s.", "Win the first trip through the order.", "Do not let their best bat own the leverage inning."]

    if off.get("iso", 0) >= 0.130:
        opponent_tile = {
            "label": "Run Prevention",
            "number": fmt_avg(off.get("iso")),
            "title": "Limit barrels",
            "detail": f"The miss cost is extra bases. Keep traffic off before the middle and avoid get-me-over pitches behind in the count.",
        }
    elif off.get("bb_pct", 0) >= 0.115:
        opponent_tile = {
            "label": "Run Prevention",
            "number": fmt_pct(off.get("bb_pct")),
            "title": "No free 90s",
            "detail": f"{opponent_name} can build innings with walks. Strike one to leadoff hitters is the first job every inning.",
        }
    elif off.get("k_pct", 0) >= 0.220:
        opponent_tile = {
            "label": "Run Prevention",
            "number": fmt_pct(off.get("k_pct")),
            "title": "Put hitters away",
            "detail": f"{opponent_name} gives you punchout chances. Expand only after we own the count.",
        }
    else:
        opponent_tile = {
            "label": "Run Prevention",
            "number": fmt_avg(off.get("ops")),
            "title": "Keep contact in front",
            "detail": f"{opponent_name} does not show one automatic hole. Win clean innings and keep singles from becoming crooked numbers.",
        }

    if pit.get("bb_pct", 0) >= 0.110:
        scoring_tile = {
            "label": "How We Score",
            "number": fmt_pct(pit.get("bb_pct")),
            "title": "Win the zone",
            "detail": "Shrink the chase zone, take the free base, and make them earn the third strike.",
        }
    elif pit.get("k_pct", 0) <= 0.170:
        scoring_tile = {
            "label": "How We Score",
            "number": fmt_pct(pit.get("k_pct")),
            "title": "Make them field it",
            "detail": "They do not miss many bats. Put the ball in play with intent and make routine defense show up.",
        }
    elif pit.get("whip", 0) >= 1.55:
        scoring_tile = {
            "label": "How We Score",
            "number": fmt_num(pit.get("whip"), 2),
            "title": "Stack baserunners",
            "detail": "Singles, walks, and HBP can stack. Avoid first-pitch rollover outs when a crooked inning is available.",
        }
    else:
        scoring_tile = {
            "label": "How We Score",
            "number": fmt_num(pit.get("era"), 2),
            "title": "Hunt the mistake",
            "detail": "The staff is playable. Be ready for the first hittable strike instead of waiting for the perfect pitch.",
        }

    if bullpen.get("bb_pct", 0) >= 0.110:
        series_tile = {
            "label": "Series Lever",
            "number": fmt_pct(bullpen.get("bb_pct")),
            "title": "Test bullpen command",
            "detail": "Long early at-bats can turn into late walks, traffic, and pitching-change stress.",
        }
    elif pit.get("starter_ip_share", 0) >= 0.680:
        series_tile = {
            "label": "Series Lever",
            "number": fmt_pct(pit.get("starter_ip_share")),
            "title": "Get starters off script",
            "detail": "Make likely starters work from the stretch. The series changes when they have to change roles.",
        }
    elif off.get("sb_attempt_rate", 0) >= 0.045:
        series_tile = {
            "label": "Series Lever",
            "number": fmt_pct(off.get("sb_attempt_rate")),
            "title": "Control the free 90",
            "detail": "Vary looks, holds, and tempo before their speed creates the extra 90 feet.",
        }
    else:
        series_tile = {
            "label": "Series Lever",
            "number": fmt_num(pit.get("era"), 2),
            "title": "Win changeover innings",
            "detail": "Track pitch count, the first hitter after each move, and leverage spots around their best bat.",
        }
    plan_points = [opponent_tile, scoring_tile, series_tile]
    return {
        "identity_sentence": f"{opp['team']['short_name']} plays as {tags}.",
        "primary_concern": f"Top concern: {strengths[0]['label']} ({strengths[0]['detail']}) can shape the series." if strengths else "Top concern: balanced opponent.",
        "best_path": f"Best path: attack {weaknesses[0]['label'].lower()} and keep pressure on their weakest phase." if weaknesses else "Best path: execute the standard run-prevention plan.",
        "identity_label": tag_labels or "Balanced Profile",
        "concern_label": strengths[0]["label"] if strengths else "Balanced Opponent",
        "concern_detail": strengths[0]["detail"] if strengths else "No single team phase dominates the matchup.",
        "path_label": weaknesses[0]["label"] if weaknesses else "Standard Execution",
        "path_detail": weaknesses[0]["detail"] if weaknesses else "Win free bases, clean defense, and leverage at-bats.",
        "plan_points": plan_points,
        "keys": keys[:3],
    }


def make_team_record(team, team_stats, batting_rows, pitching_rows, batting_pbp, pitching_pbp, fielding_rows, relievers):
    offense = dict(team_stats or {})
    pa = offense.get("pa") or sum(r.get("plate_appearances") or 0 for r in batting_rows)
    offense["hr_pa"] = safe_div(offense.get("hr") or 0, pa, 0)
    offense["xbh_pa"] = safe_div((offense.get("2b") or 0) + (offense.get("3b") or 0) + (offense.get("hr") or 0), pa, 0)
    attempts = (offense.get("sb") or 0) + (offense.get("cs") or 0)
    offense["sb_attempt_rate"] = safe_div(attempts, pa, 0)
    offense["sb_success"] = safe_div(offense.get("sb") or 0, attempts, 0)
    offense["sh_rate"] = safe_div(offense.get("sh") or 0, pa, 0)

    return {
        "team": {
            "id": team["id"],
            "name": team["name"],
            "short_name": team["short_name"],
            "school_name": team.get("school_name"),
            "logo_url": team.get("logo_url"),
            "conference": team.get("conference_abbrev") or team.get("conference_name"),
            "division": team.get("division_level"),
        },
        "offense": offense,
        "pitching": summarize_team_pitching(pitching_rows),
        "batting_pbp": aggregate_pbp(batting_pbp, "batting"),
        "pitching_pbp": aggregate_pbp(pitching_pbp, "pitching"),
        "fielding": aggregate_fielding(fielding_rows),
        "hitters": batting_rows,
        "pitchers": pitching_rows,
        "relievers": relievers,
        "lineup_tiers": lineup_tiers(batting_rows),
    }


def build_plan(team_id, own_team_id, records, peer_records, spray_by_player):
    opp = records[team_id]
    own = records[own_team_id]
    opp["strengths"] = grade_strengths(opp, peer_records)
    own["strengths"] = grade_strengths(own, peer_records)
    opp["identity"] = identity_tags(opp, peer_records)

    hitters = [h for h in opp["hitters"] if (h.get("plate_appearances") or 0) >= 40]
    pitchers = [p for p in opp["pitchers"] if ip_to_outs(p.get("innings_pitched")) >= 30]
    top_hitters = sorted(hitters, key=role_score_hitter, reverse=True)[:3]
    top_starters = sorted([p for p in pitchers if (p.get("games_started") or 0) >= 3], key=role_score_starter, reverse=True)[:4]
    top_relievers = sorted(opp["relievers"], key=role_score_reliever, reverse=True)[:3]
    pitcher_attack = []
    used_pitcher_ids = set()
    for row in top_starters:
        used_pitcher_ids.add(row.get("player_id"))
        role = "Starter" if (row.get("games_started") or 0) >= 5 else "Starter/Long Relief"
        pitcher_attack.append(pitcher_plan_payload(row, role))
    for idx, row in enumerate(top_relievers):
        if row.get("player_id") not in used_pitcher_ids:
            used_pitcher_ids.add(row.get("player_id"))
            pitcher_attack.append(pitcher_plan_payload(row, "Leverage Reliever" if idx == 0 else "Bullpen Arm"))
    pitcher_attack = [p for p in pitcher_attack if p]

    projected = sorted([h for h in opp["hitters"] if (h.get("plate_appearances") or 0) >= 20], key=lambda r: r.get("plate_appearances") or 0, reverse=True)[:9]
    defensive = [positioning_recommendation(h, spray_by_player.get(h.get("player_id"))) for h in projected]
    defensive_by_player = {row["player_id"]: row for row in defensive}

    hitter_threats = [
        threat_payload(row, f"Big 3 Hitter #{idx}", hitter_threat_reason(row), hitter_power_plan(row, defensive_by_player.get(row.get("player_id"))))
        for idx, row in enumerate(top_hitters, start=1)
    ]
    hitter_threats = [x for x in hitter_threats if x]

    opp["big_three"] = hitter_threats
    brief = build_brief(opp, own)
    return {
        "team": opp["team"],
        "record": {"wins": opp["offense"].get("wins"), "losses": opp["offense"].get("losses")},
        "brief": brief,
        "identity": opp["identity"],
        "strengths": sorted(opp["strengths"], key=lambda x: x["score"], reverse=True)[:5],
        "weaknesses": sorted(opp["strengths"], key=lambda x: x["score"])[:5],
        "matchup_edges": matchup_edges(own, opp, peer_records),
        "hitter_threats": hitter_threats,
        "big_three": hitter_threats,
        "pitcher_attack": pitcher_attack[:7],
        "opportunities": opportunity_cards(opp, own, peer_records),
        "decisions": decision_cards(opp, own, peer_records),
        "defensive_positioning": defensive,
        "evidence": {
            "opponent_offense": opp["offense"],
            "opponent_pitching": opp["pitching"],
            "opponent_fielding": opp["fielding"],
            "selected_team_offense": own["offense"],
            "selected_team_pitching": own["pitching"],
            "selected_team_fielding": own["fielding"],
        },
    }


def team_summary_record(record, peers):
    return {
        "team": record["team"],
        "strengths": grade_strengths(record, peers),
        "offense": record["offense"],
        "pitching": record["pitching"],
        "fielding": record["fielding"],
    }


# ============================================================
# LIVE ENDPOINT
# ============================================================

_CACHE = {"mtime": None, "data": None}
_DATA_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "data", "series_planner.json")


def _load_records():
    """Load the batch-generated records file, re-reading only when it changes."""
    path = os.path.abspath(_DATA_PATH)
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return None
    if _CACHE["mtime"] != mtime:
        with open(path, "r", encoding="utf-8") as fh:
            raw = _json.load(fh)
        records = {int(k): v for k, v in (raw.get("records") or {}).items()}
        spray = {int(k): v for k, v in (raw.get("spray") or {}).items()}
        _CACHE.update({"mtime": mtime, "data": {
            "season": raw.get("season"),
            "generated_at": raw.get("generated_at"),
            "records": records,
            "spray": spray,
            "peers": list(records.values()),
        }})
    return _CACHE["data"]


@router.get("/portal/series-planner")
def series_planner(
    own_team_id: int = Query(..., description="The coach's team (our side)"),
    opp_team_id: int = Query(..., description="The opponent to plan for"),
    season: int = Query(CURRENT_SEASON),
    _user: str = Depends(require_tier("coach")),
):
    """
    Pre-series opponent game plan for (own team vs opponent). Runs the ported
    rule logic on the daily batch records; own team is any team so every coach
    sees their own side. Adds the opponent's count-tendencies grid live.
    """
    data = _load_records()
    if not data:
        return {"error": "not_generated", "message": "Series Planner data has not been generated yet."}
    records, peers, spray = data["records"], data["peers"], data["spray"]

    if own_team_id not in records:
        return {"error": "own_team_missing", "message": "No data for your team this season."}
    if opp_team_id not in records:
        return {"error": "opponent_missing", "message": "No data for that opponent this season."}

    plan = build_plan(opp_team_id, own_team_id, records, peers, spray)
    own_summary = team_summary_record(records[own_team_id], peers)

    # Carry over the count-tendencies grid from the old Advance Report (live DB).
    count_tendencies = {"offense": [], "pitching": []}
    try:
        from app.api.advance_report import _count_tendencies_side
        with get_connection() as conn:
            cur = conn.cursor()
            count_tendencies = {
                "offense": _count_tendencies_side(cur, opp_team_id, season, "batting_team_id", "hitter"),
                "pitching": _count_tendencies_side(cur, opp_team_id, season, "defending_team_id", "pitcher"),
            }
    except Exception:  # noqa: BLE001 — count grid is a nice-to-have, never fail the report on it
        pass

    return {
        "meta": {
            "season": data["season"],
            "generated_at": data["generated_at"],
            "own_team_id": own_team_id,
            "opp_team_id": opp_team_id,
        },
        "own_team": own_summary,
        "plan": plan,
        "count_tendencies": count_tendencies,
    }


@router.get("/portal/series-planner/teams")
def series_planner_teams(_user: str = Depends(require_tier("coach"))):
    """List teams that have Series Planner data (for the own/opponent pickers)."""
    data = _load_records()
    if not data:
        return {"teams": [], "generated_at": None}
    teams = [rec["team"] for rec in data["peers"]]
    teams.sort(key=lambda t: (t.get("short_name") or "").lower())
    return {"teams": teams, "generated_at": data["generated_at"], "season": data["season"]}


# ============================================================
# DEFENSIVE ALIGNMENTS — per-fielder positioning from the 5+5 fine zones
# ============================================================

_ALIGN_IF = ["IF_3B", "IF_SS", "IF_MID", "IF_2B", "IF_1B"]
_ALIGN_OF = ["LF", "LC", "CF", "RC", "RF"]
_IF_LONG = {"IF_3B": "third base", "IF_SS": "shortstop", "IF_MID": "up the middle",
            "IF_2B": "second base", "IF_1B": "first base"}
_OF_LONG = {"LF": "left field", "LC": "the left-center gap", "CF": "center field",
            "RC": "the right-center gap", "RF": "right field"}


def _pct_map(counts, total):
    return {k: (safe_div(v, total, 0)) for k, v in counts.items()}


def _dominant(counts):
    if not counts or sum(counts.values()) == 0:
        return None
    return max(counts.items(), key=lambda kv: kv[1])[0]


# ── Fielder positioning model ──
# Positions are (angle_deg, depth_frac): angle -45 = LF/3B line, 0 = up the
# middle, +45 = RF/1B line; depth 0 = home, ~0.5 = infield-dirt edge, 1 = OF
# fence (the frontend scales depth to its field radius). Baseline = a
# straight-up alignment; each fielder is interpolated toward a handedness-
# specific full-shift target scaled by the hitter's pull tendency.
# NCAA has NO shift restriction, so full overload shifts are legal.
# Depth scale: 0.25 ≈ the bags (90 ft), ~0.50 ≈ the cut where dirt meets grass
# (~115 ft), >0.50 = on the outfield grass. Infielders live between the bags and
# the cut — deeper = more range but a longer throw, so SS/3B/1B are CAPPED at
# the cut in _compute_fielders. SS plays a touch deeper than 2B at baseline.
_FIELD_BASE = {
    "3B": (-37, 0.40), "SS": (-20, 0.47), "2B": (20, 0.44), "1B": (37, 0.40),
    "LF": (-29, 0.70), "CF": (0, 0.75), "RF": (29, 0.70),
    "P": (0, 0.27), "C": (0, -0.05),
}
# Overload LEFT — batter pulls to the left (RHB): 3 IF left of 2B. The SS slides
# laterally into the 5-6 hole but STAYS at normal infield depth (a SS on the cut
# can't make the throw); no infielder goes onto the grass here.
_FULL_SHIFT_LEFT = {
    "3B": (-41, 0.42), "SS": (-27, 0.49), "2B": (-8, 0.46), "1B": (26, 0.46),
    "LF": (-34, 0.72), "CF": (-11, 0.76), "RF": (18, 0.70),
}
# Overload RIGHT — batter pulls to the right (LHB): 3 IF right of 2B. The classic
# look — the 2B pushes DEEP into short right field (the throw from there is
# short, so it works), while SS (right of the bag) and 1B hold.
_FULL_SHIFT_RIGHT = {
    "1B": (41, 0.42), "2B": (27, 0.60), "SS": (8, 0.46), "3B": (-26, 0.46),
    "RF": (34, 0.72), "CF": (11, 0.76), "LF": (-18, 0.70),
}
_MOVABLE = ("3B", "SS", "2B", "1B", "LF", "CF", "RF")


def _shift_strength(if_pull_pct, is_lhb, is_switch, if_total):
    """0 (straight up) → 1 (full shift), from pull-side grounder rate. RHH need
    a higher pull rate than LHH to justify a shift (bigger hole right of 2B);
    switch hitters get a mild cap since 'all' mixes both stances. Damped by
    SAMPLE SIZE so a bench guy with a handful of PAs is never shifted hard —
    confidence ramps 8→30 grounders."""
    if if_total < 8:
        return 0.0
    if is_switch:
        base = clamp((if_pull_pct - 0.46) / 0.30, 0, 1) * 0.5
    elif is_lhb:
        base = clamp((if_pull_pct - 0.42) / 0.30, 0, 1)
    else:
        base = clamp((if_pull_pct - 0.50) / 0.27, 0, 1)
    confidence = clamp((if_total - 8) / 22, 0, 1)
    return base * confidence


def _fielder_abbr(pos, ba, bd, ang, dep, pull_angle_sign):
    """Short pocket-grid code for how far a fielder deviates from straight-up:
    SL/HV (slight/heavy) + PL/OP (pull/oppo) for lateral, DP/IN/BK for depth.
    '—' means play him straight up."""
    dA = ang - ba
    dD = dep - bd
    parts = []
    if abs(dA) >= 4:
        lvl = "HV" if abs(dA) >= 13 else "SL"
        direction = "PL" if (dA * pull_angle_sign) > 0 else "OP"
        parts.append(lvl + direction)
    if pos in ("LF", "CF", "RF"):
        if dD >= 0.04:
            parts.append("DP")
        elif dD <= -0.04:
            parts.append("IN")
    else:  # infielders can also read deep/in
        if dD >= 0.045:
            parts.append("DP")
        elif dD <= -0.045:
            parts.append("IN")
    return " ".join(parts) if parts else "—"


def _compute_fielders(if_pull_pct, is_lhb, is_switch, iso, wobacon, sb, if_total):
    """Return (fielders, shift_strength). fielders = list of {pos, angle, depth,
    movable, abbr} for a 9-man alignment. Depth blends the shift with contact
    quality (wOBAcon → deeper) and runner speed (steals → infield in a step).
    SS/3B/1B are capped at the cut (they must make the throw); only the 2B in a
    lefty shift may push onto the outfield grass in short RF."""
    s = _shift_strength(if_pull_pct, is_lhb, is_switch, if_total)
    target = _FULL_SHIFT_RIGHT if is_lhb else _FULL_SHIFT_LEFT
    # Pull is +angle for LHB, -angle for RHB.
    pull_angle_sign = 1 if is_lhb else -1
    # Contact quality (wOBAcon = wOBA on contact — how hard he hits it) drives
    # depth; fall back to ISO if wOBAcon is missing. Higher = play deeper.
    hard = wobacon if wobacon else None
    if hard is not None:
        of_depth_adj = clamp((hard - 0.42) / 0.24, -0.06, 0.08)
        if_back = clamp((hard - 0.42) / 0.30, 0, 0.05)
    else:
        of_depth_adj = clamp((iso - 0.11) / 0.28, -0.06, 0.07) if iso else 0.0
        if_back = clamp((iso - 0.11) / 0.30, 0, 0.04) if iso else 0.0
    # Speed (steals as a proxy) — a fast batter makes the infield creep in a
    # step to shorten the throw to first.
    speed_in = clamp((int(sb or 0) - 6) / 20.0, 0, 1) * 0.05
    if_depth_adj = if_back - speed_in
    out = []
    for pos, (ba, bd) in _FIELD_BASE.items():
        if pos in _MOVABLE and pos in target and s > 0:
            ta, td = target[pos]
            ang = ba + (ta - ba) * s
            dep = bd + (td - bd) * s
        else:
            ang, dep = ba, bd
        if pos in ("LF", "CF", "RF"):
            dep = clamp(dep + of_depth_adj, 0.55, 0.84)
        elif pos == "2B":
            # The one infielder allowed onto the grass (short RF on a lefty shift).
            dep = clamp(dep + if_depth_adj, 0.33, 0.64)
        elif pos in ("3B", "SS", "1B"):
            # Capped at the cut (~0.50): deeper and they can't make the throw.
            dep = clamp(dep + if_depth_adj, 0.33, 0.50)
        movable = pos in _MOVABLE
        abbr = _fielder_abbr(pos, ba, bd, ang, dep, pull_angle_sign) if movable else ""
        out.append({"pos": pos, "angle": round(ang, 1), "depth": round(dep, 3),
                    "movable": movable, "abbr": abbr})
    return out, s


def _shift_summary(s, pull_side, is_lhb, of_pull_pct, iso):
    """One-line label + the notable fielder moves for the pocket card."""
    if s < 0.18:
        label = "Straight up"
    elif s < 0.55:
        label = f"Shade {pull_side}"
    else:
        label = f"Full shift {pull_side}"
    if iso and iso >= 0.20:
        label += " · OF deep"
    elif iso and iso <= 0.07:
        label += " · OF in"
    moves = []
    if s >= 0.55:
        if is_lhb:
            moves = [{"pos": "SS", "note": "right of 2B bag"},
                     {"pos": "2B", "note": "3-4 hole / short RF"},
                     {"pos": "1B", "note": "guard the line"},
                     {"pos": "3B", "note": "shade to the SS spot"}]
        else:
            moves = [{"pos": "SS", "note": "deep in the 5-6 hole"},
                     {"pos": "2B", "note": "left of 2B bag"},
                     {"pos": "3B", "note": "guard the line"},
                     {"pos": "1B", "note": "shade the hole, deep"}]
    elif s >= 0.18:
        moves = [{"pos": "IF", "note": f"shade the infield toward {pull_side}"}]
    if of_pull_pct >= 0.52 or s >= 0.55:
        moves.append({"pos": "OF", "note": f"rotate toward {pull_side}"})
    if iso and iso >= 0.20:
        moves.append({"pos": "OF", "note": "play deep (power)"})
    return {"label": label, "strength": round(s, 2), "moves": moves}


def build_alignment_for_hitter(hitter, spray):
    """Per-hitter defensive alignment from the fine spray zones. `spray` is the
    stored {spray_chart, contact_profile, bats}. Returns None if too few BIP."""
    sc = (spray or {}).get("spray_chart") or {}
    z = sc.get("all") or {}
    bats = (spray or {}).get("bats") or hitter.get("bats") or "R"
    if_counts = {k: (z.get(k) or 0) for k in _ALIGN_IF}
    if_counts["IF_MID"] += (z.get("IF_C") or 0)  # fold catcher/bunt into middle
    of_counts = {k: (z.get(k) or 0) for k in _ALIGN_OF}
    if_total = sum(if_counts.values())
    of_total = sum(of_counts.values())
    bip = if_total + of_total
    if bip < 4:  # need a few batted balls to say anything; thin guys play straight up
        return None

    infield = _pct_map(if_counts, if_total)
    outfield = _pct_map(of_counts, of_total)

    is_lhb = str(bats).upper().startswith("L")
    # Pull/oppo depends on handedness. RHB pulls to the left (3B/SS, LF/LC).
    if is_lhb:
        if_pull = (if_counts["IF_1B"] + if_counts["IF_2B"])
        if_oppo = (if_counts["IF_3B"] + if_counts["IF_SS"])
        of_pull = (of_counts["RF"] + of_counts["RC"])
        of_oppo = (of_counts["LF"] + of_counts["LC"])
        pull_side, oppo_side = "right", "left"
    else:
        if_pull = (if_counts["IF_3B"] + if_counts["IF_SS"])
        if_oppo = (if_counts["IF_1B"] + if_counts["IF_2B"])
        of_pull = (of_counts["LF"] + of_counts["LC"])
        of_oppo = (of_counts["RF"] + of_counts["RC"])
        pull_side, oppo_side = "left", "right"
    if_pull_pct = safe_div(if_pull, if_total, 0)
    if_oppo_pct = safe_div(if_oppo, if_total, 0)
    if_mid_pct = safe_div(if_counts["IF_MID"], if_total, 0)
    of_pull_pct = safe_div(of_pull, of_total, 0)
    of_gap_pct = safe_div(of_counts["LC"] + of_counts["RC"], of_total, 0)
    bunt_pct = safe_div(z.get("IF_C") or 0, if_total, 0)

    dom_if = _dominant(if_counts)
    dom_of = _dominant(of_counts)

    recs = []
    # ── Infield shift call ──
    if if_total >= 8:
        if if_pull_pct >= 0.60:
            if is_lhb:
                recs.append({"tone": "shift", "text": f"Heavy pull ({round(if_pull_pct*100)}% of grounders to the right side). Full shift: 2B into short RF, SS up the middle, 1B on the line."})
            else:
                recs.append({"tone": "shift", "text": f"Heavy pull ({round(if_pull_pct*100)}% of grounders to the left side). Full shift: SS into the 5-6 hole, 3B on the line, 2B up the middle."})
        elif if_pull_pct >= 0.48:
            recs.append({"tone": "shade", "text": f"Pull-leaning grounders ({round(if_pull_pct*100)}% {pull_side} side). Shade the infield toward {pull_side}."})
        elif if_oppo_pct >= 0.40:
            recs.append({"tone": "note", "text": f"Uses the whole field ({round(if_oppo_pct*100)}% oppo grounders). Play him straight up, no shift."})
        else:
            recs.append({"tone": "note", "text": "Fairly balanced on the ground. Straight-up alignment."})
        if if_mid_pct >= 0.32:
            recs.append({"tone": "note", "text": f"Lots up the middle ({round(if_mid_pct*100)}%). Keep the middle infielders honest to the bag."})
        if dom_if:
            recs.append({"tone": "data", "text": f"Most grounders to {_IF_LONG[dom_if]} ({round(infield[dom_if]*100)}%)."})
    # ── Outfield ──
    if of_total >= 6:
        if of_pull_pct >= 0.52:
            recs.append({"tone": "shift", "text": f"Pull-side air ({round(of_pull_pct*100)}%). Rotate the outfield toward {pull_side}."})
        elif of_gap_pct >= 0.22:
            recs.append({"tone": "note", "text": f"Gap threat ({round(of_gap_pct*100)}% to the alleys). Outfielders honor the gaps and play deep."})
        if dom_of:
            recs.append({"tone": "data", "text": f"Most air balls to {_OF_LONG[dom_of]} ({round(outfield[dom_of]*100)}%)."})
    # ── Bunt ──
    if bunt_pct >= 0.06 and (z.get("IF_C") or 0) >= 2:
        recs.append({"tone": "note", "text": "Will drop a bunt — corners stay alert."})

    # ── Ideal fielder positions + shift summary ──
    iso = hitter.get("iso")
    if iso is None:
        slg, avg = hitter.get("slugging_pct"), hitter.get("batting_avg")
        iso = (slg - avg) if (slg is not None and avg is not None) else 0
    is_switch = str(bats).upper().startswith("S")
    wobacon = hitter.get("wobacon")
    sb = hitter.get("stolen_bases") or 0
    fielders, s = _compute_fielders(if_pull_pct, is_lhb, is_switch, iso or 0, wobacon, sb, if_total)
    shift = _shift_summary(s, pull_side, is_lhb, of_pull_pct, iso or 0)

    return {
        "player_id": hitter.get("player_id"),
        "name": player_name(hitter),
        "last_name": hitter.get("last_name") or (player_name(hitter).split() or [""])[-1],
        "position": hitter.get("position"),
        "bats": bats,
        "pa": hitter.get("plate_appearances"),
        "bip": bip,
        "if_total": if_total,
        "of_total": of_total,
        "infield": infield,           # {IF_3B: pct, ...} of grounders
        "outfield": outfield,         # {LF: pct, ...} of air balls
        "lanes": {
            "if_pull": if_pull_pct, "if_mid": if_mid_pct, "if_oppo": if_oppo_pct,
            "of_pull": of_pull_pct, "of_gap": of_gap_pct,
            "pull_side": pull_side, "oppo_side": oppo_side,
        },
        "spray_chart": sc,            # full 11-zone object for the fan visual
        "fielders": fielders,         # ideal (angle, depth, abbr) per fielder
        "shift": shift,               # {label, strength, moves[]}
        "run_game": {                 # season steals + sac bunts (bunt hits added live)
            "sb": hitter.get("stolen_bases") or 0,
            "cs": hitter.get("caught_stealing") or 0,
            "sac_bunts": hitter.get("sacrifice_bunts") or 0,
        },
        "recommendations": recs,
    }


@router.get("/portal/alignments")
def alignments(
    team_id: int = Query(..., description="Opponent team to build alignments for"),
    season: int = Query(CURRENT_SEASON),
    _user: str = Depends(require_tier("coach")),
):
    """Per-hitter defensive alignments for an opponent, from the fine (5 infield
    + 5 outfield) spray zones. Sourced from the daily Series Planner records."""
    data = _load_records()
    if not data:
        return {"error": "not_generated", "message": "Series Planner data has not been generated yet."}
    rec = data["records"].get(team_id)
    if not rec:
        return {"error": "team_missing", "message": "No data for that team this season."}
    spray = data["spray"]
    # Include anyone who might hit in a series (~8+ PA), not just regulars —
    # they still need a positioning row (thin-data guys just play straight up).
    hitters = sorted(
        [h for h in rec["hitters"] if (h.get("plate_appearances") or 0) >= 8],
        key=lambda r: r.get("plate_appearances") or 0, reverse=True,
    )
    out = []
    for h in hitters:
        a = build_alignment_for_hitter(h, spray.get(h.get("player_id")))
        if a:
            out.append(a)

    # Live: bunt counts (total + bunt-for-hit) per batter from PBP text, and
    # jersey numbers — neither is on the stored leaderboard rows.
    ids = [a["player_id"] for a in out if a.get("player_id")]
    if ids:
        try:
            with get_connection() as conn:
                cur = conn.cursor()
                cur.execute("""
                    SELECT ge.batter_player_id AS pid,
                           COUNT(*) AS bunts,
                           COUNT(*) FILTER (WHERE ge.result_type = 'single') AS bunt_hits
                    FROM game_events ge JOIN games g ON g.id = ge.game_id
                    WHERE g.season = %s AND ge.batting_team_id = %s
                      AND ge.batter_player_id = ANY(%s)
                      AND LOWER(ge.result_text) LIKE '%%bunt%%'
                    GROUP BY ge.batter_player_id
                """, (season, team_id, ids))
                bunts = {r["pid"]: r for r in cur.fetchall()}
                cur.execute("SELECT id, jersey_number FROM players WHERE id = ANY(%s)", (ids,))
                jerseys = {r["id"]: r["jersey_number"] for r in cur.fetchall()}
            for a in out:
                b = bunts.get(a["player_id"])
                a["run_game"]["bunts"] = (b["bunts"] if b else 0)
                a["run_game"]["bunt_hits"] = (b["bunt_hits"] if b else 0)
                a["jersey"] = jerseys.get(a["player_id"])
        except Exception:  # noqa: BLE001 — bunt/jersey extras never fail the report
            pass

    return {
        "meta": {"season": data["season"], "generated_at": data["generated_at"], "team_id": team_id},
        "team": rec["team"],
        "hitters": out,
    }
