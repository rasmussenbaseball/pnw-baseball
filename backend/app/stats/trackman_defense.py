"""Defensive metrics from TrackMan player-positioning exports.

The positioning CSV gives every fielder's (x, z) at pitch release —
x = feet from home plate toward CF, z = feet toward 1B(+)/3B(-) — plus
names. Joined to the game CSV's ball flight (Bearing, Distance,
HangTime, ExitSpeed) by PitchUID, that's the same ingredient list
Statcast uses for catch probability and Outs Above Average.

Our models are PHYSICS-INFORMED, not trained on MLB outcomes (we don't
have their labels), so we brand the headline number Outs Above
Expected (OAE) and keep the assumptions visible below:

OUTFIELD (air balls): the fielder must cover the distance from their
start position to the landing point within the hang time, minus a
reaction/first-step allowance. Required speed maps to catch probability
through a logistic centered near college sprint limits (~23 ft/s
sustainable burst; elite MLB sprint speed is 27-30 ft/s). Balls hit
OVER the fielder's head are ~15% harder per foot of ground (turning and
tracking); balls in front are slightly easier.

INFIELD (ground balls): the ball travels along the launch Direction
line at roughly 55% of exit velo (average infield deceleration). The
fielder's chance is the lateral distance to the ball's line against the
time until the ball crosses their depth. Required lateral speed maps to
an out probability that also prices the throw (deep + backhand plays
convert less).

Both models are transparent estimates: use them for player-to-player
comparison inside a camp/team corpus, not as MLB-comparable absolutes.
"""
import math

OF_POSITIONS = ("LF", "CF", "RF")
IF_POSITIONS = ("1B", "2B", "3B", "SS")

SPRINT_REACTION_S = 0.9      # jump + first step before full speed
SPRINT_LOGIT_MID = 23.0      # ft/s where catch prob = 50%
SPRINT_LOGIT_SCALE = 2.6
GB_BALL_SPEED_FACTOR = 0.55  # avg GB speed as a fraction of EV (friction)
GB_REACTION_S = 0.30
GB_LOGIT_MID = 14.0          # lateral ft/s where out prob = 50%
GB_LOGIT_SCALE = 2.6
GB_MAX_RANGE_FT = 45.0

OUT_RESULTS = {"Out", "Sacrifice", "FieldersChoice"}


def landing_xz(bearing_deg, dist_ft):
    """Ball landing point in field coordinates (x toward CF, z toward 1B)."""
    b = math.radians(bearing_deg)
    return dist_ft * math.cos(b), dist_ft * math.sin(b)


def catch_probability(fielder_x, fielder_z, land_x, land_z, hang_s):
    """OF catch probability for one fielder on one air ball."""
    if hang_s is None or hang_s <= 0.3:
        return None
    dist = math.hypot(land_x - fielder_x, land_z - fielder_z)
    run_time = max(hang_s - SPRINT_REACTION_S, 0.15)
    v_req = dist / run_time
    # over-the-head penalty: landing meaningfully deeper than the start
    depth_delta = math.hypot(land_x, land_z) - math.hypot(fielder_x, fielder_z)
    if depth_delta > 8:
        v_req *= 1.15
    elif depth_delta < -8:
        v_req *= 0.95
    p = 1.0 / (1.0 + math.exp((v_req - SPRINT_LOGIT_MID) / SPRINT_LOGIT_SCALE))
    return max(0.0, min(1.0, p)), dist, v_req, depth_delta


def gb_out_probability(fielder_x, fielder_z, direction_deg, exit_velo_mph):
    """IF out probability for one fielder on one ground ball."""
    if exit_velo_mph is None or exit_velo_mph <= 0:
        return None
    th = math.radians(direction_deg)
    ux, uz = math.cos(th), math.sin(th)          # unit vector along ball line
    s = fielder_x * ux + fielder_z * uz          # ball travel to fielder's depth
    if s <= 0:
        return None
    d_perp = abs(fielder_z * ux - fielder_x * uz)
    if d_perp > GB_MAX_RANGE_FT:
        return (0.02, d_perp, 99.0, (fielder_x, fielder_z))
    ball_fps = exit_velo_mph * 1.467 * GB_BALL_SPEED_FACTOR
    t_ball = s / ball_fps
    v_req = d_perp / max(t_ball - GB_REACTION_S, 0.12)
    p = 1.0 / (1.0 + math.exp((v_req - GB_LOGIT_MID) / GB_LOGIT_SCALE))
    # deep plays price the throw: beyond ~130 ft of ball travel the out
    # gets harder even when the ball is reached
    if s > 130:
        p *= max(0.4, 1.0 - (s - 130) / 120.0)
    # intercept point = the foot of the perpendicular on the ball line
    return (max(0.0, min(1.0, p)), d_perp, v_req, (s * ux, s * uz))


def move_direction(fx, fz, tx, tz):
    """Dominant movement direction in the FIELDER's frame, facing home:
    'left' = glove-side for a righty = the 1B side (+z), 'right' = the
    3B side (-z), 'in' = toward the plate, 'back' = away from it.
    Classified by the larger of the radial vs lateral component."""
    d_rad = math.hypot(tx, tz) - math.hypot(fx, fz)
    d_lat = tz - fz
    if abs(d_rad) >= abs(d_lat):
        return "back" if d_rad > 0 else "in"
    return "left" if d_lat > 0 else "right"


def difficulty_bucket(p):
    """Savant-style star buckets by catch/out probability."""
    if p is None:
        return None
    if p < 0.25:
        return "5star"       # near-impossible
    if p < 0.50:
        return "4star"
    if p < 0.75:
        return "3star"
    if p < 0.90:
        return "2star"
    return "routine"
