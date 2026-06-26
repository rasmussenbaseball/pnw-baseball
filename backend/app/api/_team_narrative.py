"""
Team Profile V2 — auto-generated fan-facing prose, ported from the intern's
generator (generate_team_profile_tabs.py). Two kinds:

  * per-returner notes — one sentence about each impact returning hitter/pitcher
    (hitter_returner_note / pitcher_returner_note). Variant is chosen by `rank`
    so adjacent players in the same bucket read differently.
  * team_narrative — team-level "what worked last season", "next steps", outlook,
    and "what the returners bring back", driven by the grade scores + returning %s.

All inputs are raw stat rows (same column names as batting_stats/pitching_stats)
and the grade `scores` dict (0-100, keys: offense/contact/power/discipline/speed/
pitching/miss_bats/strike_throwing/pitching_depth) + `ret` dict
(pa_pct/ip_pct/owar_pct/pwar_pct, 0-100).
"""


def _fi(v):
    return "-" if v is None else f"{int(round(v)):,}"


def _fn(v, d=1):
    return "-" if v is None else f"{v:,.{d}f}"


def _fr(v, d=3):
    if v is None:
        return "-"
    s = f"{v:.{d}f}"
    return s[1:] if s.startswith("0") else s


def _fp(v, d=1):
    return "-" if v is None else f"{v:.{d}f}%"


def _ip_to_outs(ip):
    if ip is None:
        return 0
    whole = int(float(ip))
    frac = int(round((float(ip) - whole) * 10))
    return whole * 3 + frac


def _name(r):
    return f"{r.get('first_name','') or ''} {r.get('last_name','') or ''}".strip()


def _variant(rank, *options):
    return options[rank % len(options)]


def hitter_returner_note(row, rank=0):
    name = _name(row)
    pa = row.get("plate_appearances") or 0
    avg = row.get("batting_avg") or 0
    obp = row.get("on_base_pct") or 0
    slg = row.get("slugging_pct") or 0
    ops = row.get("ops") or 0
    wrc = row.get("wrc_plus") or 0
    hr = row.get("home_runs") or 0
    rbi = row.get("rbi") or 0
    sb = row.get("stolen_bases") or 0
    k_pct = row.get("k_pct") or 1
    bb_pct = row.get("bb_pct") or 0
    owar = row.get("offensive_war") or 0
    pos = row.get("position") or "bat"
    if pa >= 180 and obp >= 0.420:
        return _variant(rank,
            f"{name} gives the card a real table-setter: {_fr(obp)} OBP over {_fi(pa)} PA keeps innings from ending early.",
            f"{name} is the lineup's traffic starter, with a {_fp(bb_pct * 100)} BB rate and {_fr(obp)} OBP to set up the next bat.",
            f"{name} brings a top-of-order feel because a {_fr(obp)} OBP forces pitchers to work from the stretch.",
            f"{name} gives the offense leadoff-style value, pairing {_fi(pa)} PA with a {_fr(obp)} OBP.")
    if hr >= 8 or slg >= 0.560:
        return _variant(rank,
            f"{name} is the returning damage source, carrying {_fi(hr)} HR and a {_fr(slg)} SLG back into the order.",
            f"{name} gives the card a loud-contact threat after posting a {_fr(ops)} OPS and {_fi(rbi)} RBI.",
            f"{name} brings back the extra-base swing: {_fr(slg)} SLG gives traffic a way to score quickly.",
            f"{name} is a run-changing bat, with {_fi(hr)} HR that opponents have to account for in scoring spots.",
            f"{name} keeps real slug in the order, bringing a {_fr(ops)} OPS and middle-innings punch.")
    if wrc >= 130 and pa >= 120:
        return _variant(rank,
            f"{name} brings back one of the safer run-producing bats, with a {_fn(wrc, 0)} wRC+ that pitchers have to plan around.",
            f"{name} gives the lineup a proven scoring-spot at-bat after a {_fr(ops)} OPS and {_fi(rbi)} RBI.",
            f"{name} returns with real run value: {_fn(wrc, 0)} wRC+ says the production played beyond the box score.",
            f"{name} gives the order a trusted run producer, carrying {_fn(owar, 1)} oWAR back into the lineup.")
    if sb >= 12:
        return _variant(rank,
            f"{name} brings the run game with him, with {_fi(sb)} SB turning singles and walks into pressure.",
            f"{name} changes innings with his legs; {_fi(sb)} SB give the offense a way to manufacture runs.",
            f"{name} keeps pitchers and catchers busy once he reaches, backed by {_fi(sb)} SB.",
            f"{name} adds a base-stealing threat, and {_fi(sb)} SB can force rushed throws in tight games.")
    if k_pct <= 0.10 and pa >= 80:
        return _variant(rank,
            f"{name} is a contact piece, with a {_fp(k_pct * 100)} K rate that keeps the defense involved.",
            f"{name} gives the order a bat-to-ball look, useful when a {_fr(avg)} AVG needs to become rally fuel.",
            f"{name} keeps at-bats alive; the {_fp(k_pct * 100)} K rate makes opponents earn outs.",
            f"{name} brings low swing-and-miss, helping avoid empty innings with a {_fp(k_pct * 100)} K rate.")
    if obp >= 0.390:
        return _variant(rank,
            f"{name} adds traffic to the order, with a {_fr(obp)} OBP that helps extend innings.",
            f"{name} gives the offense another on-base piece, pairing {_fr(obp)} OBP with {_fi(pa)} PA.",
            f"{name} can lengthen innings by reaching at a {_fr(obp)} OBP and handing chances to the next hitter.",
            f"{name} helps the lineup avoid quick innings; the {_fr(obp)} OBP travels well.")
    if pa >= 150:
        return _variant(rank,
            f"{name} returns everyday experience at {pos}, with {_fi(pa)} PA already banked in that role.",
            f"{name} gives the roster a known {pos} option after handling {_fi(pa)} PA.",
            f"{name} has already lived in a regular role, bringing {_fi(pa)} PA back into next year's lineup picture.",
            f"{name} gives the lineup a known {pos} option instead of another open job, with {_fi(pa)} PA of proof.")
    if hr >= 3 or slg >= 0.430:
        return _variant(rank,
            f"{name} gives the bottom half some punch, with {_fi(hr)} HR and a {_fr(slg)} SLG already on the sheet.",
            f"{name} has enough gap power to make a lower-card role dangerous, led by a {_fr(slg)} SLG.",
            f"{name} brings secondary pop back, with {_fi(hr)} HR that can stretch the lineup.")
    return _variant(rank,
        f"{name} gives the roster another known bat, with {_fi(pa)} PA of context to evaluate.",
        f"{name} keeps a familiar option in the position-player mix after logging {_fi(pa)} PA.",
        f"{name} returns as a depth bat with a chance to turn a {_fi(pa)} PA sample into a bigger lane.",
        f"{name} stays in the mix as a matchup bat while the staff learns what the {_fi(pa)} PA sample means.")


def pitcher_returner_note(row, rank=0):
    name = _name(row)
    outs = _ip_to_outs(row.get("innings_pitched"))
    ip = outs / 3 if outs else 0
    ipd = row.get("innings_pitched") or 0
    era = row.get("era") or 99
    siera = row.get("siera") or 99
    k_pct = row.get("k_pct") or 0
    bb_pct = row.get("bb_pct") or 1
    pwar = row.get("pitching_war") or 0
    if ip >= 65 and era <= 4.25:
        return _variant(rank,
            f"{name} gives the staff a real innings anchor, bringing back {ipd} IP with a {_fn(era, 2)} ERA.",
            f"{name} returns as a bankable innings piece: {ipd} IP makes the staff easier to organize.",
            f"{name} brings starter-level volume and run prevention, pairing {ipd} IP with a {_fn(era, 2)} ERA.",
            f"{name} gives the staff a known bulk option before roles are assigned, with {ipd} IP already logged.")
    if ip >= 45 and k_pct >= 0.25:
        return _variant(rank,
            f"{name} brings back swing-and-miss over real volume, with {ipd} IP and a {_fp(k_pct * 100)} K rate.",
            f"{name} can miss bats while covering innings, a staff-building combo at {_fp(k_pct * 100)} K over {ipd} IP.",
            f"{name} gives the mound group strikeout stuff, with a {_fp(k_pct * 100)} K rate that can swing a series.",
            f"{name} offers starter-length outs with bat-missing ability: {ipd} IP, {_fp(k_pct * 100)} K.")
    if bb_pct <= 0.06 and ip >= 15:
        return _variant(rank,
            f"{name} is a strike-thrower, with a {_fp(bb_pct * 100)} BB rate that helps avoid free innings.",
            f"{name} brings command value back, using a {_fp(bb_pct * 100)} BB rate to limit self-made jams.",
            f"{name} gives the pitching group a zone-filler, useful when a {_fp(bb_pct * 100)} BB rate is needed.",
            f"{name} can steady an inning by living in the zone and keeping walks near a {_fp(bb_pct * 100)} BB rate.")
    if k_pct >= 0.30:
        return _variant(rank,
            f"{name} gives the bullpen or rotation a bat-missing look, with a {_fp(k_pct * 100)} K rate that plays in leverage.",
            f"{name} brings a strikeout weapon back, using a {_fp(k_pct * 100)} K rate to stop big innings.",
            f"{name} has the swing-and-miss to earn matchup outs or a bigger role after a {_fp(k_pct * 100)} K rate.",
            f"{name} gives the staff a punchout look that can change late innings: {_fp(k_pct * 100)} K.")
    if pwar > 0.5:
        return _variant(rank,
            f"{name} already logged useful outs, bringing {_fn(pwar, 1)} pWAR back to the staff.",
            f"{name} returns with proof that his outs played, giving the staff {_fn(pwar, 1)} pWAR of carryover.",
            f"{name} gives the pitching plan a known contributor, not just a projection, after {_fn(pwar, 1)} pWAR.",
            f"{name} has already shown his outs hold up, making {_fn(pwar, 1)} pWAR a real building block.")
    if era <= 4.50 and ip >= 15:
        return _variant(rank,
            f"{name} brings back run prevention, with a {_fn(era, 2)} ERA giving the staff a stabilizing piece.",
            f"{name} kept runs off the board enough to enter next year with a {_fn(era, 2)} ERA role case.",
            f"{name} gives the staff a calmer run-prevention piece to lean on after a {_fn(era, 2)} ERA.",
            f"{name} returns with a run-prevention case, and a {_fn(era, 2)} ERA should keep him in the mix.")
    if siera <= 4.00:
        return _variant(rank,
            f"{name}'s skill line points to more playable innings, with a {_fn(siera, 2)} SIERA worth a longer look.",
            f"{name} has indicators that suggest more is there, led by a {_fn(siera, 2)} SIERA.",
            f"{name} brings a better skill read than the basic line, with a {_fn(siera, 2)} SIERA as the clue.")
    if ip >= 30:
        return _variant(rank,
            f"{name} has enough innings on record to compete for a larger role, with {ipd} IP back.",
            f"{name} returns with enough mound time to be more than a mystery arm: {ipd} IP.",
            f"{name} gives the staff experienced depth and a chance to claim more than last year's {ipd} IP.")
    if k_pct >= 0.20:
        return _variant(rank,
            f"{name} offers a miss-bat ingredient, with a {_fp(k_pct * 100)} K rate useful for matchup outs.",
            f"{name} has enough swing-and-miss to stay in the conversation after a {_fp(k_pct * 100)} K rate.",
            f"{name} gives the staff a strikeout look, even if the role still has to be earned: {_fp(k_pct * 100)} K.")
    return _variant(rank,
        f"{name} keeps another arm in the room, giving the staff {ipd} IP of context to sort through.",
        f"{name} is part of the returning depth pool, with last year's {ipd} IP as the starting point.",
        f"{name} stays in the staff picture as a depth arm with {ipd} IP to build from.",
        f"{name} returns as pitching depth, with opportunity tied to turning the {ipd} IP sample into a role.")


def _lowest_phase_line(name, s):
    phases = [("contact", s["contact"]), ("extra-base damage", s["power"]),
              ("speed pressure", s["speed"]), ("run prevention", s["pitching"]),
              ("pitching depth", s["pitching_depth"])]
    phase = min(phases, key=lambda x: x[1])[0]
    if phase == "contact":
        return f"{name}'s cleanest offensive jump is more balls in play, more two-out at-bats, and longer innings."
    if phase == "extra-base damage":
        return f"{name}'s next offensive jump is turning baserunners into doubles, homers, and loud contact."
    if phase == "speed pressure":
        return f"{name} can score more by forcing throws, taking extra bases, and making defenses rush."
    if phase == "run prevention":
        return f"{name}'s biggest lift is keeping free runners off base and turning more innings over cleanly."
    return f"{name}'s clearest roster lift is more trustworthy arms behind the front-line options."


def team_narrative(name, s, ret, ret_bat, ret_pit, top_hitter_names, top_pitcher_names):
    """Team-level prose. s = scores dict (0-100), ret = {pa_pct,ip_pct,owar_pct,pwar_pct}."""
    ret_hr = sum(r.get("home_runs") or 0 for r in ret_bat)
    ret_sb = sum(r.get("stolen_bases") or 0 for r in ret_bat)

    strengths = []
    if s["contact"] >= 70:
        strengths.append(f"Last season, {name} showed real bat-to-ball skill, which kept innings alive and forced opponents to defend.")
    if s["offense"] >= 65:
        strengths.append("The offense created traffic and gave itself chances for crooked innings.")
    if s["speed"] >= 65:
        strengths.append(f"The run game was a real weapon, and {ret_sb} stolen bases are still attached to returning players.")
    if s["power"] >= 65:
        strengths.append("The lineup showed thump, with enough extra-base threat to change innings quickly.")
    if s["pitching"] >= 65:
        strengths.append("The staff gave the team a chance to win nights when the bats were quiet.")
    if ret["pa_pct"] >= 65:
        strengths.append(f"The batting order leaned on familiar pieces, and {_fp(ret['pa_pct'])} of those plate appearances remain in the program.")
    if not strengths:
        strengths.append(f"Last season gave {name} playable pieces to build from, even if one clear calling card still has to separate.")

    improvements = []
    if s["power"] < 45:
        improvements.append(f"Next season's lineup needs more doubles-and-homers threat; the returning group currently carries {ret_hr} home runs.")
    if s["pitching"] < 45:
        improvements.append("The staff has to win more counts, miss more barrels, and create more swing-and-miss.")
    if s["strike_throwing"] < 45:
        improvements.append("More strike-one counts would change the feel of next season's staff and cut down free innings.")
    if ret["ip_pct"] < 50:
        improvements.append(f"The mound is a reload spot, with {_fp(ret['ip_pct'])} of last season's innings currently returning.")
    if ret["pa_pct"] < 50:
        improvements.append(f"The lineup has everyday jobs to win, with {_fp(ret['pa_pct'])} of plate appearances projected back.")
    if ret["pwar_pct"] < 35:
        improvements.append(f"The staff needs more arms who can get outs in winning spots; {_fp(ret['pwar_pct'])} of last season's trusted mound production returns.")
    if not improvements:
        improvements.append(_lowest_phase_line(name, s))

    pa, ip = ret["pa_pct"], ret["ip_pct"]
    war_pct = (ret["owar_pct"] + ret["pwar_pct"]) / 2
    if pa >= 65 and ip >= 60 and war_pct >= 60:
        outlook = f"{name} brings back a real core. This looks more like a targeted upgrade offseason than a total roster rebuild."
    elif pa >= 65 and ip < 45:
        outlook = f"{name} carries a familiar lineup forward, while the mound becomes the defining reload area."
    elif pa < 45 and ip >= 60:
        outlook = f"{name} has more stability on the mound than in the order. The fastest jump comes from filling open at-bats around that staff."
    elif pa < 45 and ip < 45:
        outlook = f"{name} enters a roster refresh with real playing-time windows across the diamond."
    else:
        outlook = f"{name} has a split roster picture, with one side of the game carrying more stability than the other."

    hitter_names = ", ".join(top_hitter_names) or "the returning hitters"
    pitcher_names = ", ".join(top_pitcher_names) or "the returning pitchers"
    returners = []
    if ret["pa_pct"] >= 70:
        returners.append(f"{name} keeps its batting-order backbone intact with {_fp(ret['pa_pct'])} of plate appearances returning.")
    elif ret["pa_pct"] >= 45:
        returners.append(f"{name} returns a usable middle of the lineup, leaving specific spots to replace rather than the whole card.")
    else:
        returners.append(f"{name}'s lineup has major playing time available, with {_fp(ret['pa_pct'])} of plate appearances projected back.")
    if ret_hr >= 20:
        returners.append(f"{hitter_names} give the lineup proven damage, and the returning group brings {ret_hr} home runs back into the order.")
    elif ret_sb >= 40:
        returners.append(f"{hitter_names} keep pressure on defenses, with {ret_sb} stolen bases returning as a run-game weapon.")
    else:
        returners.append(f"{hitter_names} are the clearest returning bats to build around as new roles open.")
    if ret["ip_pct"] >= 65:
        returners.append(f"{name} returns a large innings base at {_fp(ret['ip_pct'])}, giving the staff defined roles to build from.")
    elif ret["ip_pct"] >= 40:
        returners.append(f"{name}'s pitching staff has a partial foundation back, with important innings still open.")
    else:
        returners.append(f"{name}'s mound picture is the clearest reload area, with {_fp(ret['ip_pct'])} of innings currently returning.")
    if ret["pwar_pct"] >= 60:
        returners.append(f"{pitcher_names} bring back the staff's biggest outs and give the pitching plan a clear starting point.")
    elif ret["pwar_pct"] >= 35:
        returners.append(f"{pitcher_names} give the staff a workable base, with more trusted innings still needing to emerge.")
    else:
        returners.append(f"{pitcher_names} are the first names in a staff build that still needs more arms who can get leverage outs.")

    return {
        "strengths": strengths[:4],
        "improvements": improvements[:4],
        "outlook": outlook,
        "returners": returners[:4],
    }
