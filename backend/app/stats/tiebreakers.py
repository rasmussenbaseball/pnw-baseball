"""
Tiebreaker Logic for Standings
==============================
Applies head-to-head record and overall record as tiebreakers when teams
are tied on a primary sort key (typically conference win percentage).

Tiebreaker order:
  1. Primary sort key (e.g., conf_win_pct) -- applied BEFORE calling this
  2. Head-to-head wins against tied teams (more wins = higher)
  3. Head-to-head losses against tied teams (fewer losses = higher)
  4. Overall win percentage
  5. Overall wins count

Rationale for using raw wins/losses rather than H2H percentage:
In a 3+ team tie where one team didn't play any of the others, a
percentage-based tiebreaker would give that team a .500 "neutral"
value and unfairly rank them above a team that actually lost a H2H
series. Ranking by raw H2H wins means teams with real H2H wins beat
teams with no H2H data, and teams with H2H losses fall below teams
with no data, with overall record settling the rest.
"""

from collections import defaultdict


def apply_head_to_head(
    teams,
    get_connection,
    season,
    primary_key="conf_win_pct",
    team_id_key="id",
    overall_key="win_pct",
    overall_wins_key="wins",
):
    """
    Re-sort a list of team dicts so that teams tied on ``primary_key`` are
    ordered by head-to-head record first, then overall record.

    The input MUST already be sorted by ``primary_key`` descending. This
    function only reorders WITHIN tied groups; it never changes the
    position of non-tied teams.

    Args:
        teams: list of team dicts.
        get_connection: a callable returning a psycopg2 connection
            (typically ``app.models.database.get_connection``).
        season: season year (int).
        primary_key: field that teams are ranked by
            (default ``"conf_win_pct"``).
        team_id_key: field holding the team's ID (default ``"id"``).
        overall_key: field for overall win pct (default ``"win_pct"``).
        overall_wins_key: field for overall wins count (default ``"wins"``).

    Returns:
        A new list of team dicts, sorted with tiebreakers applied.
    """
    if len(teams) < 2:
        return list(teams)

    # Group teams by primary_key value (preserving the original order)
    groups = []
    current = [teams[0]]
    for t in teams[1:]:
        if t.get(primary_key) == current[-1].get(primary_key):
            current.append(t)
        else:
            groups.append(current)
            current = [t]
    groups.append(current)

    # For each group with 2+ teams, compute the H2H mini-round-robin record
    h2h_records = {}  # team_id -> (wins, losses) vs other tied teams
    tied_groups = [g for g in groups if len(g) >= 2]

    if tied_groups:
        with get_connection() as conn:
            cur = conn.cursor()
            for group in tied_groups:
                tids = [t[team_id_key] for t in group]
                cur.execute(
                    """
                    SELECT home_team_id, away_team_id, home_score, away_score
                    FROM games
                    WHERE season = %s
                      AND status = 'final'
                      AND home_team_id = ANY(%s)
                      AND away_team_id = ANY(%s)
                      AND home_score IS NOT NULL
                      AND away_score IS NOT NULL
                      AND home_score <> away_score
                      AND (is_postseason IS NULL OR is_postseason = FALSE)
                    """,
                    (season, tids, tids),
                )
                group_recs = defaultdict(lambda: [0, 0])  # tid -> [wins, losses]
                for row in cur.fetchall():
                    r = dict(row)
                    h_id, a_id = r["home_team_id"], r["away_team_id"]
                    if r["home_score"] > r["away_score"]:
                        group_recs[h_id][0] += 1
                        group_recs[a_id][1] += 1
                    else:
                        group_recs[a_id][0] += 1
                        group_recs[h_id][1] += 1
                for tid in tids:
                    w, l = group_recs[tid]
                    h2h_records[tid] = (w, l)

    # Secondary sort key for tied teams
    # Sort DESC by (H2H wins, -H2H losses, overall pct, overall wins)
    # Using raw wins/losses lets "no-H2H-games" teams fall through to overall
    # record without falsely outranking teams that lost H2H games.
    def tiebreak_key(team):
        w, l = h2h_records.get(team[team_id_key], (0, 0))
        return (
            w,                                     # more H2H wins = higher
            -l,                                    # fewer H2H losses = higher
            team.get(overall_key, 0),              # overall win pct
            team.get(overall_wins_key, 0),         # overall wins
        )

    # Reassemble: non-tied groups untouched, tied groups sorted by tiebreak_key
    result = []
    for group in groups:
        if len(group) >= 2:
            result.extend(sorted(group, key=tiebreak_key, reverse=True))
        else:
            result.extend(group)

    return result


def annotate_h2h_records(teams, get_connection, season, team_id_key="id"):
    """
    Attach head-to-head records to each tied-group team for display
    purposes. Adds a ``h2h_note`` field showing e.g. "2-1 vs tied teams"
    only for teams whose primary sort key placed them in a multi-team tie.

    Note: call this AFTER ``apply_head_to_head`` to annotate.
    """
    # Placeholder for a future enhancement. Keeps API stable.
    return teams
