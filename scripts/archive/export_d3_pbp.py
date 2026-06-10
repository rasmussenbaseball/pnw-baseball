#!/usr/bin/env python3
"""Export all D3 play-by-play events to a CSV file.

By default: every event from every game involving a D3 team in the
given season (so D3-vs-D1 OOC and D3-vs-D2/NAIA games are included
too — the intern gets the full game record).

Usage:
    PYTHONPATH=backend python3 scripts/export_d3_pbp.py --season 2026
    PYTHONPATH=backend python3 scripts/export_d3_pbp.py --season 2026 --strict
    PYTHONPATH=backend python3 scripts/export_d3_pbp.py --all-seasons

  --strict       : only events where BOTH teams are D3 (conference-pure)
  --all-seasons  : include every season we have D3 PBP for (rarely useful)
  --out PATH     : output file path (default: ./d3_pbp_<season>.csv)
"""

from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.models.database import get_connection  # noqa: E402


# Order matters here — this is the column order in the output CSV.
EXPORT_COLUMNS = [
    "season", "game_id", "game_date",
    "home_team", "away_team",
    "inning", "half", "sequence_idx",
    "batting_team", "defending_team",
    "batter_name", "batter_player_id",
    "pitcher_name", "pitcher_player_id",
    "balls_before", "strikes_before",
    "outs_before", "outs_after",
    "bases_before", "bases_after",
    "bat_score_before", "fld_score_before",
    "pitches_thrown", "pitch_sequence", "was_in_play",
    "result_type", "result_text",
    "rbi", "runs_on_play",
    "bb_type", "field_zone", "field_zone_fine",
    "r1_name", "r2_name", "r3_name",
    "wp_before", "wp_after", "wpa_batter", "wpa_pitcher",
]


QUERY = """
SELECT
    g.season,
    ge.game_id,
    g.game_date,
    th.short_name AS home_team,
    ta.short_name AS away_team,
    ge.inning,
    ge.half,
    ge.sequence_idx,
    tb.short_name AS batting_team,
    td.short_name AS defending_team,
    ge.batter_name,
    ge.batter_player_id,
    ge.pitcher_name,
    ge.pitcher_player_id,
    ge.balls_before,
    ge.strikes_before,
    ge.outs_before,
    ge.outs_after,
    ge.bases_before,
    ge.bases_after,
    ge.bat_score_before,
    ge.fld_score_before,
    ge.pitches_thrown,
    ge.pitch_sequence,
    ge.was_in_play,
    ge.result_type,
    ge.result_text,
    ge.rbi,
    ge.runs_on_play,
    ge.bb_type,
    ge.field_zone,
    ge.field_zone_fine,
    ge.r1_name,
    ge.r2_name,
    ge.r3_name,
    ge.wp_before,
    ge.wp_after,
    ge.wpa_batter,
    ge.wpa_pitcher
FROM game_events ge
JOIN games g ON g.id = ge.game_id
JOIN teams th ON th.id = g.home_team_id
JOIN teams ta ON ta.id = g.away_team_id
LEFT JOIN teams tb ON tb.id = ge.batting_team_id
LEFT JOIN teams td ON td.id = ge.defending_team_id
WHERE
    {season_clause}
    AND (
        EXISTS (
            SELECT 1 FROM teams t
            JOIN conferences c ON c.id = t.conference_id
            JOIN divisions d ON d.id = c.division_id
            WHERE t.id = g.home_team_id AND d.level = 'D3'
        )
        {or_away_clause}
    )
ORDER BY g.game_date, ge.game_id, ge.inning, ge.half DESC, ge.sequence_idx
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=2026,
                    help="Season year (default 2026)")
    ap.add_argument("--all-seasons", action="store_true",
                    help="Include every season")
    ap.add_argument("--strict", action="store_true",
                    help="Only events where BOTH teams are D3 (no OOC opponents)")
    ap.add_argument("--out", type=str, default=None,
                    help="Output CSV path")
    args = ap.parse_args()

    season_clause = (
        "TRUE" if args.all_seasons else f"g.season = {int(args.season)}"
    )
    # In strict mode we require the away team also be D3. Otherwise we
    # OR-in any game where either side is D3.
    if args.strict:
        or_away_clause = """
        AND EXISTS (
            SELECT 1 FROM teams t
            JOIN conferences c ON c.id = t.conference_id
            JOIN divisions d ON d.id = c.division_id
            WHERE t.id = g.away_team_id AND d.level = 'D3'
        )
        """
    else:
        or_away_clause = """
        OR EXISTS (
            SELECT 1 FROM teams t
            JOIN conferences c ON c.id = t.conference_id
            JOIN divisions d ON d.id = c.division_id
            WHERE t.id = g.away_team_id AND d.level = 'D3'
        )
        """

    query = QUERY.format(
        season_clause=season_clause,
        or_away_clause=or_away_clause,
    )

    season_label = "all-seasons" if args.all_seasons else str(args.season)
    suffix = "_strict" if args.strict else ""
    out_path = Path(
        args.out or f"d3_pbp_{season_label}{suffix}.csv"
    ).resolve()

    print(f"Exporting D3 PBP for {season_label} (strict={args.strict})")
    print(f"  → {out_path}")

    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(query)
        rows_written = 0
        with open(out_path, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f, quoting=csv.QUOTE_MINIMAL)
            w.writerow(EXPORT_COLUMNS)
            while True:
                batch = cur.fetchmany(2000)
                if not batch:
                    break
                for row in batch:
                    w.writerow([
                        row.get(col) if row.get(col) is not None else ""
                        for col in EXPORT_COLUMNS
                    ])
                    rows_written += 1
                print(f"  ...wrote {rows_written:,} rows")

    size_mb = out_path.stat().st_size / 1024 / 1024
    print(f"\nDone. {rows_written:,} rows, {size_mb:.1f} MB")
    print(f"File: {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
