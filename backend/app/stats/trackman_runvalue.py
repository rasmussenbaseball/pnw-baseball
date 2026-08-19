"""Count-based pitch run values + attack-zone regions for the TrackMan Suite.

RUN VALUES (the Savant/FanGraphs "pitch type linear weights" method):
every count has a run expectancy for the rest of the plate appearance,
relative to an average PA. A pitch's run value is the change it causes —
a ball moves the count toward the hitter, a strike toward the pitcher,
and a terminal pitch (walk, strikeout, ball in play) replaces the count
state with the outcome's linear-weight value. Summing over pitches gives
total RV; per 100 pitches gives RV/100, the rate version.

We use the classic count-value ladder (Tango et al., also the basis of
FanGraphs' wFB/C family). College run environments are hotter than MLB,
but the LADDER — how much a 1-1 ball vs a 1-1 strike matters — is stable
across environments, and the suite only compares players inside one
corpus, so the MLB-derived ladder is the right transparent choice.

Sign convention: helpers return the BATTER-perspective run change
(positive = good for the hitter). Pitcher displays negate it so that,
like every other suite stat, positive = good for the player shown.

ATTACK ZONES (Savant's swing/take regions), computed from plate location
against the suite's conventional zone (|side| <= 0.83 ft, height 1.5-3.5):
  heart   inner 67% of the zone — pitches to hit / pitches that get hurt
  shadow  the band from the heart edge to one ball-width outside the zone
  chase   beyond shadow, up to a full zone-width off — swing = free strike
  waste   everything farther — noncompetitive
"""

# Run expectancy of the rest of the PA by count, runs relative to an
# average PA (0-0 = 0 by construction).
COUNT_RV = {
    (0, 0): 0.000, (1, 0): 0.032, (2, 0): 0.088, (3, 0): 0.186,
    (0, 1): -0.043, (1, 1): -0.015, (2, 1): 0.036, (3, 1): 0.145,
    (0, 2): -0.098, (1, 2): -0.083, (2, 2): -0.055, (3, 2): 0.043,
}

# Terminal outcomes, runs relative to an average PA (linear weights).
TERMINAL_RV = {
    "Walk": 0.32, "Strikeout": -0.28, "HitByPitch": 0.34,
    "Out": -0.26, "FieldersChoice": -0.26, "Sacrifice": -0.15,
    "Error": 0.35, "Single": 0.47, "Double": 0.78, "Triple": 1.05,
    "HomeRun": 1.40, "CaughtStealing": -0.26,
}

_BALL_CALLS = {"BallCalled", "BallinDirt", "BallIntentional", "AutomaticBall"}
_STRIKE_CALLS = {"StrikeCalled", "StrikeSwinging", "AutomaticStrike"}
_FOUL_CALLS = {"FoulBall", "FoulBallFieldable", "FoulBallNotFieldable"}


def pitch_run_value(balls, strikes, pitch_call, play_result=None):
    """Batter-perspective run change from ONE pitch, or None when the
    pitch can't be priced (missing count, catcher's interference, an
    in-play row with no tagged result, etc.)."""
    if balls is None or strikes is None:
        return None
    start = COUNT_RV.get((balls, strikes))
    if start is None:
        return None
    call = pitch_call or ""
    if call in _BALL_CALLS:
        if balls >= 3:
            return TERMINAL_RV["Walk"] - start
        return COUNT_RV[(balls + 1, strikes)] - start
    if call == "HitByPitch":
        return TERMINAL_RV["HitByPitch"] - start
    if call in _STRIKE_CALLS:
        if strikes >= 2:
            return TERMINAL_RV["Strikeout"] - start
        return COUNT_RV[(balls, strikes + 1)] - start
    if call in _FOUL_CALLS:
        if strikes >= 2:
            return 0.0
        return COUNT_RV[(balls, strikes + 1)] - start
    if call == "InPlay":
        out = TERMINAL_RV.get(play_result or "")
        if out is None:
            return None
        return out - start
    return None


# Attack zones: normalized "rings" around the zone center. r is the
# max of the horizontal/vertical distances in zone-half-width units,
# so the regions are concentric rectangles like Savant's.
_HALF_W, _Z_MID, _HALF_H = 0.83, 2.5, 1.0


def attack_zone(plate_loc_side, plate_loc_height):
    """'heart' | 'shadow' | 'chase' | 'waste', or None without location."""
    if plate_loc_side is None or plate_loc_height is None:
        return None
    r = max(abs(plate_loc_side) / _HALF_W, abs(plate_loc_height - _Z_MID) / _HALF_H)
    if r <= 0.67:
        return "heart"
    if r <= 1.33:
        return "shadow"
    if r <= 2.0:
        return "chase"
    return "waste"
