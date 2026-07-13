"""TrackMan V3 game-CSV parser for the coach-portal TrackMan Suite.

Parses the standard 167-column TrackMan game export (the format every
TrackMan-equipped college program downloads per session — verified against
Bushnell's Hamlin SC files, Sept 2025 through Feb 2026). One CSV = one
session recording; some sessions are split across multiple files or
re-downloaded, so pitches carry TrackMan's globally-unique PitchUID and
ingest dedupes on it.

Session types (classified per file):
  - 'game'      real opponent in the team columns (fall games, spring games)
  - 'scrimmage' intrasquad ("SIM_UNI" simulated-opponent rows, or same team
                on both sides) — full game context, tagged pitch types
  - 'bp'        batting practice: no PitchCall/PlayResult/pitch tags, machine
                or coach arms (blank Pitcher), hitting metrics only

Numbers: TrackMan writes floats with full precision, blanks for unmeasured,
and the literal string 'Undefined' for untagged enums. Both normalize to
None here. Confidence columns ('High'/'Medium'/'Low') pass through as text
so the UI can offer TrackMan-style confidence filtering.

Derived flags (computed once at parse so every endpoint agrees):
  is_in_zone   |PlateLocSide| <= 0.83 ft and 1.5 <= PlateLocHeight <= 3.5 ft
               (the conventional TrackMan strike-zone box)
  is_swing     PitchCall in swings (whiff, fouls, in play)
  is_whiff     PitchCall == StrikeSwinging
  is_contact   swing that wasn't a whiff
  is_chase     swing outside the zone
"""
from __future__ import annotations

import csv
import io
from collections import Counter

# ── CSV → column mapping ─────────────────────────────────────────
# db_column -> csv header. Only the analytically useful subset of the 167
# columns; trajectory polynomial coefficients and raw physics vectors are
# deliberately left in the file, not the database.
TEXT_COLS = {
    "pitch_uid": "PitchUID",
    "game_id": "GameID",
    "pitcher": "Pitcher",
    "pitcher_tm_id": "PitcherId",
    "pitcher_throws": "PitcherThrows",
    "pitcher_team": "PitcherTeam",
    "batter": "Batter",
    "batter_tm_id": "BatterId",
    "batter_side": "BatterSide",
    "batter_team": "BatterTeam",
    "catcher": "Catcher",
    "catcher_team": "CatcherTeam",
    "top_bottom": "Top/Bottom",
    "tagged_pitch_type": "TaggedPitchType",
    "auto_pitch_type": "AutoPitchType",
    "pitch_call": "PitchCall",
    "k_or_bb": "KorBB",
    "tagged_hit_type": "TaggedHitType",
    "auto_hit_type": "AutoHitType",
    "play_result": "PlayResult",
    "tilt": "Tilt",
    "stadium": "Stadium",
    "level": "Level",
    "home_team": "HomeTeam",
    "away_team": "AwayTeam",
    "date": "Date",
    "time": "Time",
    "notes": "Notes",
    "rel_conf": "PitchReleaseConfidence",
    "loc_conf": "PitchLocationConfidence",
    "mov_conf": "PitchMovementConfidence",
    "hit_launch_conf": "HitLaunchConfidence",
    "hit_landing_conf": "HitLandingConfidence",
}
INT_COLS = {
    "pitch_no": "PitchNo",
    "pa_of_inning": "PAofInning",
    "pitch_of_pa": "PitchofPA",
    "inning": "Inning",
    "outs": "Outs",
    "balls": "Balls",
    "strikes": "Strikes",
    "outs_on_play": "OutsOnPlay",
    "runs_scored": "RunsScored",
}
FLOAT_COLS = {
    "rel_speed": "RelSpeed",
    "spin_rate": "SpinRate",
    "spin_axis": "SpinAxis",
    "rel_height": "RelHeight",
    "rel_side": "RelSide",
    "extension": "Extension",
    "vert_break": "VertBreak",
    "ivb": "InducedVertBreak",
    "horz_break": "HorzBreak",
    "plate_loc_height": "PlateLocHeight",
    "plate_loc_side": "PlateLocSide",
    "zone_speed": "ZoneSpeed",
    "vaa": "VertApprAngle",
    "haa": "HorzApprAngle",
    "effective_velo": "EffectiveVelo",
    "speed_drop": "SpeedDrop",
    "exit_speed": "ExitSpeed",
    "launch_angle": "Angle",
    "direction": "Direction",
    "hit_spin_rate": "HitSpinRate",
    "distance": "Distance",
    "bearing": "Bearing",
    "hang_time": "HangTime",
    "throw_speed": "ThrowSpeed",
    "pop_time": "PopTime",
    "exchange_time": "ExchangeTime",
    "time_to_base": "TimeToBase",
}

# Sanity: a real TrackMan game CSV must have at least these headers.
REQUIRED_HEADERS = {"PitchUID", "GameID", "Pitcher", "Batter", "PitchCall", "RelSpeed", "Date"}

SWING_CALLS = {"StrikeSwinging", "FoulBall", "FoulBallFieldable", "FoulBallNotFieldable", "InPlay"}

# Conventional TrackMan strike-zone box (feet)
ZONE_SIDE = 0.83
ZONE_BOTTOM = 1.5
ZONE_TOP = 3.5


def _clean(v):
    v = (v or "").strip()
    return None if v in ("", "Undefined") else v


def _f(v):
    v = _clean(v)
    if v is None:
        return None
    try:
        return float(v)
    except ValueError:
        return None


def _i(v):
    f = _f(v)
    return int(f) if f is not None else None


def parse_text(text: str, filename: str = "upload.csv") -> dict:
    """Parse one TrackMan game CSV into {sessions: {game_id: meta}, pitches: [...]}.

    A single file normally holds one GameID, but nothing prevents TrackMan
    from concatenating, so pitches are grouped per GameID. Raises ValueError
    on files that aren't TrackMan game exports.
    """
    reader = csv.DictReader(io.StringIO(text))
    headers = set(reader.fieldnames or [])
    missing = REQUIRED_HEADERS - headers
    if missing:
        raise ValueError(
            f"{filename}: not a TrackMan game CSV (missing columns: {', '.join(sorted(missing))})"
        )

    pitches = []
    for raw in reader:
        p = {}
        for col, src in TEXT_COLS.items():
            p[col] = _clean(raw.get(src))
        for col, src in INT_COLS.items():
            p[col] = _i(raw.get(src))
        for col, src in FLOAT_COLS.items():
            p[col] = _f(raw.get(src))
        if not p["pitch_uid"] or not p["game_id"]:
            continue  # partial/corrupt row

        # Derived flags
        h, s = p["plate_loc_height"], p["plate_loc_side"]
        in_zone = (h is not None and s is not None
                   and abs(s) <= ZONE_SIDE and ZONE_BOTTOM <= h <= ZONE_TOP)
        call = p["pitch_call"] or ""
        swing = call in SWING_CALLS
        p["is_in_zone"] = in_zone if (h is not None and s is not None) else None
        p["is_swing"] = swing if call else None
        p["is_whiff"] = (call == "StrikeSwinging") if call else None
        p["is_contact"] = (swing and call != "StrikeSwinging") if call else None
        p["is_chase"] = (swing and p["is_in_zone"] is False) if (call and p["is_in_zone"] is not None) else None
        pitches.append(p)

    if not pitches:
        raise ValueError(f"{filename}: no usable pitch rows found")

    # Per-GameID session metadata
    sessions = {}
    for gid in {p["game_id"] for p in pitches}:
        rows = [p for p in pitches if p["game_id"] == gid]
        teams = Counter()
        for p in rows:
            for t in (p["pitcher_team"], p["batter_team"]):
                if t:
                    teams[t] += 1
        tagged = sum(1 for p in rows if p["pitch_call"])
        team_codes = set(teams)
        if "-BP-" in gid or tagged / len(rows) < 0.1:
            stype = "bp"
        elif "SIM_UNI" in team_codes or len(team_codes) <= 1:
            stype = "scrimmage"
        else:
            stype = "game"
        bbe = sum(1 for p in rows if p["exit_speed"] is not None)
        sessions[gid] = {
            "game_id": gid,
            "session_date": rows[0]["date"],
            "session_type": stype,
            "stadium": rows[0]["stadium"],
            "home_team": rows[0]["home_team"],
            "away_team": rows[0]["away_team"],
            "teams": sorted(team_codes),
            "pitch_count": len(rows),
            "bbe_count": bbe,
            "filename": filename,
        }
    return {"sessions": sessions, "pitches": pitches}
