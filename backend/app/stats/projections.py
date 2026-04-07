"""
Playoff Projection Engine
===========================
Projects end-of-season records and playoff fields for all PNW conferences.

Uses:
- Current team records (from team_season_stats)
- Power ratings (cross-division comparable)
- Future scheduled games (from future_schedules.json)
- Conference playoff format rules

Playoff Formats (2026):
  GNAC (D2): Top 3, round-robin day 1, elimination/championship day 2
  NWC  (D3): Top 4 by conference win%, double elimination
  CCC  (NAIA): Top 5, double elimination. #1 bye/host, #2v3 and #4v5
  NWAC (JUCO): 4 regions x 4 teams. #1s to final 8, #3v4 single elim, winner vs #2 best-of-3
"""

import json
import math
import random
import logging
from pathlib import Path
from datetime import date
from collections import defaultdict

logger = logging.getLogger("projections")


# ============================================================
# Playoff Format Definitions
# ============================================================

PLAYOFF_FORMATS = {
    "GNAC": {
        "name": "GNAC Tournament",
        "division_level": "D2",
        "num_teams": 3,
        "format": "round_robin",
        "description": "Top 3 by conference win%. Day 1: round-robin (all 3 play each other). Day 2: 0-2 team eliminated, remaining 2 play championship",
        "seeding_basis": "conference_win_pct",
    },
    "NWC": {
        "name": "NWC Tournament",
        "division_level": "D3",
        "num_teams": 4,
        "format": "double_elimination",
        "description": "Top 4 by conference win%, double elimination",
        "seeding_basis": "conference_win_pct",
    },
    "CCC": {
        "name": "CCC Tournament",
        "division_level": "NAIA",
        "num_teams": 5,
        "format": "double_elimination",
        "description": "Top 5, #1 gets bye and hosts, #2v3 and #4v5, double elimination",
        "seeding_basis": "conference_win_pct",
    },
    # NWAC has 4 sub-regions, each conference sends top 4
    "NWAC_NORTH": {
        "name": "NWAC North Region",
        "division_level": "JUCO",
        "num_teams": 4,
        "format": "nwac_regional",
        "description": "#1 to final 8; #3v4 single elim at #2 field, winner vs #2 best-of-3",
        "seeding_basis": "conference_win_pct",
    },
    "NWAC_EAST": {
        "name": "NWAC East Region",
        "division_level": "JUCO",
        "num_teams": 4,
        "format": "nwac_regional",
        "description": "#1 to final 8; #3v4 single elim at #2 field, winner vs #2 best-of-3",
        "seeding_basis": "conference_win_pct",
    },
    "NWAC_SOUTH": {
        "name": "NWAC South Region",
        "division_level": "JUCO",
        "num_teams": 4,
        "format": "nwac_regional",
        "description": "#1 to final 8; #3v4 single elim at #2 field, winner vs #2 best-of-3",
        "seeding_basis": "conference_win_pct",
    },
    "NWAC_WEST": {
        "name": "NWAC West Region",
        "division_level": "JUCO",
        "num_teams": 4,
        "format": "nwac_regional",
        "description": "#1 to final 8; #3v4 single elim at #2 field, winner vs #2 best-of-3",
        "seeding_basis": "conference_win_pct",
    },
}

# Map conference names (as stored in DB) to playoff format keys
CONFERENCE_TO_FORMAT = {
    "Great Northwest Athletic Conference": "GNAC",
    "GNAC": "GNAC",
    "Northwest Conference": "NWC",
    "NWC": "NWC",
    "Cascade Collegiate Conference": "CCC",
    "CCC": "CCC",
    # NWAC regions (DB stores as "NWAC North Division", abbrev "NWAC-N")
    "NWAC North Division": "NWAC_NORTH",
    "NWAC North": "NWAC_NORTH",
    "NWAC-N": "NWAC_NORTH",
    "NWAC East Division": "NWAC_EAST",
    "NWAC East": "NWAC_EAST",
    "NWAC-E": "NWAC_EAST",
    "NWAC South Division": "NWAC_SOUTH",
    "NWAC South": "NWAC_SOUTH",
    "NWAC-S": "NWAC_SOUTH",
    "NWAC West Division": "NWAC_WEST",
    "NWAC West": "NWAC_WEST",
    "NWAC-W": "NWAC_WEST",
}


# ============================================================
# Elo Win Probability (same as routes.py)
# ============================================================

def elo_win_prob(rating_a, rating_b, scale=30.0):
    """P(A wins) using Elo formula. Scale=30 calibrated for PNW baseball."""
    if rating_a is None or rating_b is None:
        return 0.5
    return 1.0 / (1.0 + math.pow(10, (rating_b - rating_a) / scale))


# ============================================================
# Load Future Schedules
# ============================================================

def load_future_schedules():
    """Load the scraped future schedules JSON file."""
    path = Path(__file__).parent.parent.parent / "data" / "future_schedules.json"
    if not path.exists():
        logger.warning(f"Future schedules file not found: {path}")
        return {"games": [], "last_updated": None}

    with open(path) as f:
        return json.load(f)


# ============================================================
# Projection Engine
# ============================================================

def project_remaining_games(future_games, team_ratings):
    """
    Project outcomes for all future games using power ratings.

    Args:
        future_games: list of game dicts from future_schedules.json
        team_ratings: dict of team_id -> {power_rating, short_name, ...}

    Returns:
        dict of team_id -> {
            projected_wins: float,
            projected_losses: float,
            projected_conf_wins: float,
            projected_conf_losses: float,
            games: [list of projected games with win probabilities]
        }
    """
    # Also build a short_name -> team_id lookup for matching
    name_to_id = {}
    for tid, info in team_ratings.items():
        name_to_id[info["short_name"]] = tid

    projections = {}  # team_id -> accumulated projected wins/losses

    def ensure_team(tid):
        if tid not in projections:
            projections[tid] = {
                "projected_wins": 0.0,
                "projected_losses": 0.0,
                "projected_conf_wins": 0.0,
                "projected_conf_losses": 0.0,
                "games": [],
            }

    for game in future_games:
        home_id = game.get("home_team_id")
        away_id = game.get("away_team_id")

        # Try to resolve by name if IDs are missing
        if not home_id:
            home_id = name_to_id.get(game.get("home_team"))
        if not away_id:
            away_id = name_to_id.get(game.get("away_team"))

        if not home_id and not away_id:
            continue

        # Get ratings
        home_rating = team_ratings.get(home_id, {}).get("power_rating") if home_id else None
        away_rating = team_ratings.get(away_id, {}).get("power_rating") if away_id else None

        # Compute win probability (with 2-point home field advantage)
        if home_rating is not None and away_rating is not None:
            home_win_prob = elo_win_prob(home_rating + 2.0, away_rating)
        elif home_rating is not None:
            home_win_prob = 0.6  # Default advantage for known vs unknown
        elif away_rating is not None:
            home_win_prob = 0.4
        else:
            home_win_prob = 0.5

        away_win_prob = 1.0 - home_win_prob
        is_conf = game.get("is_conference", False)

        game_proj = {
            "game_date": game["game_date"],
            "home_team": game.get("home_team", ""),
            "away_team": game.get("away_team", ""),
            "home_team_id": home_id,
            "away_team_id": away_id,
            "home_win_prob": round(home_win_prob, 3),
            "is_conference": is_conf,
        }

        # Accumulate for home team
        if home_id:
            ensure_team(home_id)
            projections[home_id]["projected_wins"] += home_win_prob
            projections[home_id]["projected_losses"] += away_win_prob
            if is_conf:
                projections[home_id]["projected_conf_wins"] += home_win_prob
                projections[home_id]["projected_conf_losses"] += away_win_prob
            projections[home_id]["games"].append(game_proj)

        # Accumulate for away team
        if away_id:
            ensure_team(away_id)
            projections[away_id]["projected_wins"] += away_win_prob
            projections[away_id]["projected_losses"] += home_win_prob
            if is_conf:
                projections[away_id]["projected_conf_wins"] += away_win_prob
                projections[away_id]["projected_conf_losses"] += home_win_prob
            projections[away_id]["games"].append(game_proj)

    return projections


# ============================================================
# Monte Carlo Simulation
# ============================================================

def run_monte_carlo(future_games, team_ratings, current_standings, n_simulations=1000):
    """
    Simulate the remaining season N times to compute:
    - Each team's probability of making the playoffs
    - Each team's probability of finishing in each seed position

    Returns:
        dict of team_id -> {
            playoff_pct: float (0-1),
            seed_probabilities: {1: float, 2: float, ...},
            avg_conf_wins: float,
            avg_conf_losses: float,
        }
    """
    # Build name -> id lookup
    name_to_id = {}
    for tid, info in team_ratings.items():
        name_to_id[info["short_name"]] = tid

    # Pre-process games into (home_id, away_id, home_win_prob, is_conference) tuples
    processed_games = []
    for game in future_games:
        home_id = game.get("home_team_id") or name_to_id.get(game.get("home_team"))
        away_id = game.get("away_team_id") or name_to_id.get(game.get("away_team"))
        if not home_id and not away_id:
            continue

        home_rating = team_ratings.get(home_id, {}).get("power_rating") if home_id else None
        away_rating = team_ratings.get(away_id, {}).get("power_rating") if away_id else None

        if home_rating is not None and away_rating is not None:
            home_win_prob = elo_win_prob(home_rating + 2.0, away_rating)
        elif home_rating is not None:
            home_win_prob = 0.6
        elif away_rating is not None:
            home_win_prob = 0.4
        else:
            home_win_prob = 0.5

        is_conf = game.get("is_conference", False)
        processed_games.append((home_id, away_id, home_win_prob, is_conf))

    # Build current records lookup: team_id -> {conf_wins, conf_losses, conference_name}
    team_base = {}
    for team in current_standings:
        tid = team["id"]
        team_base[tid] = {
            "conf_wins": team.get("conf_wins", 0) or 0,
            "conf_losses": team.get("conf_losses", 0) or 0,
            "conference_name": team.get("conference_name", ""),
            "division_level": team.get("division_level", ""),
        }

    # Find which conferences have playoff formats
    conf_format_map = {}
    for team in current_standings:
        conf_name = team.get("conference_name", "")
        if conf_name not in conf_format_map:
            format_key = (CONFERENCE_TO_FORMAT.get(conf_name) or
                          CONFERENCE_TO_FORMAT.get(team.get("conference_abbrev", "")))
            if format_key and format_key in PLAYOFF_FORMATS:
                conf_format_map[conf_name] = PLAYOFF_FORMATS[format_key]

    # Track results across simulations
    # team_id -> {playoff_count, seed_counts: {seed: count}}
    results = defaultdict(lambda: {"playoff_count": 0, "seed_counts": defaultdict(int),
                                    "total_conf_wins": 0.0, "total_conf_losses": 0.0})

    for _ in range(n_simulations):
        # Start with current conference records
        sim_conf_wins = {}
        sim_conf_losses = {}
        for tid, base in team_base.items():
            sim_conf_wins[tid] = base["conf_wins"]
            sim_conf_losses[tid] = base["conf_losses"]

        # Simulate each game
        for home_id, away_id, home_win_prob, is_conf in processed_games:
            home_wins = random.random() < home_win_prob

            if is_conf:
                if home_wins:
                    if home_id:
                        sim_conf_wins[home_id] = sim_conf_wins.get(home_id, 0) + 1
                    if away_id:
                        sim_conf_losses[away_id] = sim_conf_losses.get(away_id, 0) + 1
                else:
                    if away_id:
                        sim_conf_wins[away_id] = sim_conf_wins.get(away_id, 0) + 1
                    if home_id:
                        sim_conf_losses[home_id] = sim_conf_losses.get(home_id, 0) + 1

        # Group by conference and determine standings
        conf_teams = defaultdict(list)
        for tid, base in team_base.items():
            cw = sim_conf_wins.get(tid, 0)
            cl = sim_conf_losses.get(tid, 0)
            total = cw + cl
            pct = cw / total if total > 0 else 0
            conf_teams[base["conference_name"]].append((tid, cw, cl, pct))
            results[tid]["total_conf_wins"] += cw
            results[tid]["total_conf_losses"] += cl

        # Sort each conference and assign seeds
        for conf_name, teams_list in conf_teams.items():
            fmt = conf_format_map.get(conf_name)
            if not fmt:
                continue

            # Sort by conf win pct descending, then wins descending as tiebreaker
            teams_list.sort(key=lambda t: (t[3], t[1]), reverse=True)
            num_playoff = min(fmt["num_teams"], len(teams_list))

            for rank, (tid, cw, cl, pct) in enumerate(teams_list):
                seed = rank + 1
                if seed <= num_playoff:
                    results[tid]["playoff_count"] += 1
                    results[tid]["seed_counts"][seed] += 1

    # Convert counts to probabilities
    output = {}
    for tid, data in results.items():
        seed_probs = {}
        for seed, count in sorted(data["seed_counts"].items()):
            seed_probs[seed] = round(count / n_simulations, 3)

        output[tid] = {
            "playoff_pct": round(data["playoff_count"] / n_simulations, 3),
            "seed_probabilities": seed_probs,
            "avg_conf_wins": round(data["total_conf_wins"] / n_simulations, 1),
            "avg_conf_losses": round(data["total_conf_losses"] / n_simulations, 1),
        }

    return output


def build_projected_standings(current_standings, projections, team_ratings):
    """
    Combine current records with projected remaining games to produce
    projected end-of-season standings by conference.

    Args:
        current_standings: list of team dicts from standings query
        projections: output of project_remaining_games()
        team_ratings: dict of team_id -> rating info

    Returns:
        list of conference dicts with projected standings
    """
    conferences = {}

    for team in current_standings:
        tid = team["id"]
        proj = projections.get(tid, {})

        # Current record
        curr_wins = team.get("wins", 0) or 0
        curr_losses = team.get("losses", 0) or 0
        curr_conf_wins = team.get("conf_wins", 0) or 0
        curr_conf_losses = team.get("conf_losses", 0) or 0

        # Projected additions
        proj_wins = proj.get("projected_wins", 0)
        proj_losses = proj.get("projected_losses", 0)
        proj_conf_wins = proj.get("projected_conf_wins", 0)
        proj_conf_losses = proj.get("projected_conf_losses", 0)

        # Projected final record
        final_wins = curr_wins + proj_wins
        final_losses = curr_losses + proj_losses
        final_conf_wins = curr_conf_wins + proj_conf_wins
        final_conf_losses = curr_conf_losses + proj_conf_losses

        total = final_wins + final_losses
        conf_total = final_conf_wins + final_conf_losses

        rating_info = team_ratings.get(tid, {})

        projected_team = {
            "team_id": tid,
            "short_name": team.get("short_name", ""),
            "logo_url": team.get("logo_url", ""),
            "division_level": team.get("division_level", ""),
            "conference_name": team.get("conference_name", ""),
            "conference_abbrev": team.get("conference_abbrev", ""),
            # Current record
            "current_wins": curr_wins,
            "current_losses": curr_losses,
            "current_conf_wins": curr_conf_wins,
            "current_conf_losses": curr_conf_losses,
            # Projected additions
            "projected_additional_wins": round(proj_wins, 1),
            "projected_additional_losses": round(proj_losses, 1),
            # Projected final record
            "projected_wins": round(final_wins, 1),
            "projected_losses": round(final_losses, 1),
            "projected_win_pct": round(final_wins / total, 3) if total > 0 else 0,
            "projected_conf_wins": round(final_conf_wins, 1),
            "projected_conf_losses": round(final_conf_losses, 1),
            "projected_conf_win_pct": round(final_conf_wins / conf_total, 3) if conf_total > 0 else 0,
            # Games remaining
            "games_remaining": len(proj.get("games", [])),
            "conf_games_remaining": sum(1 for g in proj.get("games", []) if g.get("is_conference")),
            # Power rating
            "power_rating": rating_info.get("power_rating"),
        }

        # Group by conference
        conf_key = team.get("conference_name", "Unknown")
        if conf_key not in conferences:
            conferences[conf_key] = {
                "conference_name": conf_key,
                "conference_abbrev": team.get("conference_abbrev", ""),
                "division_level": team.get("division_level", ""),
                "teams": [],
            }
        conferences[conf_key]["teams"].append(projected_team)

    # Normalize conference totals: every team in a conference should have
    # the same total conference games (played + remaining).  Source schedule
    # pages sometimes don't list all future games yet, leaving some teams
    # short.  Pad any shortfall with .500-projected "unscheduled" games so
    # the displayed totals balance across the conference.
    for conf in conferences.values():
        if conf.get("division_level") == "D1":
            continue  # skip D1 — we don't project them

        # Find the max total (played + remaining) in this conference
        max_conf_total = 0
        for team in conf["teams"]:
            total = (team["current_conf_wins"] + team["current_conf_losses"]
                     + team["conf_games_remaining"])
            if total > max_conf_total:
                max_conf_total = total

        # Pad any team below the max
        for team in conf["teams"]:
            total = (team["current_conf_wins"] + team["current_conf_losses"]
                     + team["conf_games_remaining"])
            deficit = max_conf_total - total
            if deficit > 0:
                half = deficit * 0.5
                team["conf_games_remaining"] += deficit
                team["games_remaining"] += deficit
                # Project unscheduled games at .500
                team["projected_additional_wins"] = round(team["projected_additional_wins"] + half, 1)
                team["projected_additional_losses"] = round(team["projected_additional_losses"] + half, 1)
                team["projected_wins"] = round(team["projected_wins"] + half, 1)
                team["projected_losses"] = round(team["projected_losses"] + half, 1)
                team["projected_conf_wins"] = round(team["projected_conf_wins"] + half, 1)
                team["projected_conf_losses"] = round(team["projected_conf_losses"] + half, 1)
                # Recalculate win percentages
                w_total = team["projected_wins"] + team["projected_losses"]
                team["projected_win_pct"] = round(team["projected_wins"] / w_total, 3) if w_total > 0 else 0
                c_total = team["projected_conf_wins"] + team["projected_conf_losses"]
                team["projected_conf_win_pct"] = round(team["projected_conf_wins"] / c_total, 3) if c_total > 0 else 0

    # Sort teams within each conference by projected conference win%
    for conf in conferences.values():
        conf["teams"].sort(
            key=lambda t: (t["projected_conf_win_pct"], t["projected_win_pct"]),
            reverse=True,
        )

    return list(conferences.values())


def determine_playoff_fields(projected_conferences):
    """
    Based on projected standings and playoff format rules, determine
    which teams make the playoffs and their seeding.

    Returns a list of playoff bracket objects.
    """
    brackets = []

    for conf in projected_conferences:
        conf_name = conf["conference_name"]
        conf_abbrev = conf.get("conference_abbrev", "")

        # Find matching playoff format
        format_key = CONFERENCE_TO_FORMAT.get(conf_name) or CONFERENCE_TO_FORMAT.get(conf_abbrev)
        if not format_key:
            continue

        fmt = PLAYOFF_FORMATS.get(format_key)
        if not fmt:
            continue

        teams = conf["teams"]
        num_teams = min(fmt["num_teams"], len(teams))

        if num_teams < 2:
            continue

        playoff_teams = teams[:num_teams]

        # Build bracket based on format
        bracket = {
            "conference": conf_name,
            "conference_abbrev": conf_abbrev,
            "division_level": fmt["division_level"],
            "format_name": fmt["name"],
            "format_type": fmt["format"],
            "description": fmt["description"],
            "teams": [],
        }

        for i, team in enumerate(playoff_teams):
            bracket["teams"].append({
                "seed": i + 1,
                "team_id": team["team_id"],
                "short_name": team["short_name"],
                "logo_url": team["logo_url"],
                "projected_conf_record": f"{team['projected_conf_wins']:.0f}-{team['projected_conf_losses']:.0f}",
                "projected_overall_record": f"{team['projected_wins']:.0f}-{team['projected_losses']:.0f}",
                "projected_conf_win_pct": team["projected_conf_win_pct"],
                "power_rating": team.get("power_rating"),
            })

        # Add matchup info based on format
        if fmt["format"] == "nwac_regional":
            # NWAC: #1 auto-advance, #3v4, winner vs #2
            if len(bracket["teams"]) >= 4:
                bracket["auto_advance"] = [1]
                bracket["first_round"] = {"matchup": [3, 4], "type": "single_elimination"}
                bracket["second_round"] = {"matchup": "winner vs #2", "type": "best_of_3"}

        brackets.append(bracket)

    return brackets
