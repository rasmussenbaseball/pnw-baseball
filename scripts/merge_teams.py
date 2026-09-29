#!/usr/bin/env python3
"""
Merge duplicate team rows, or move one side of specific games to another team.

Why this exists
---------------
team_matching.get_or_create_ooc_team() auto-creates an Out-of-Conference
placeholder row whenever an opponent string does not resolve. Until the
September 2026 resolver fix, every spelling variant got its own row
("Cal State Monterey Bay", "California State University Monterey Bay",
"3-seed Cal St. Monterey Bay", ...), and a bare name could land on the
wrong longer school ("Texas" -> "Texas Tech"). Both leave games, box-score
rows, game_events and phantom players pointing at the wrong teams.id.

Two operations
--------------
merge   Fold one or more duplicate team rows into a canonical row: every
        games / game_batting / game_pitching / game_fielding / game_events
        reference is repointed, phantom players on the duplicate are matched
        by name to players on the canonical team (else moved), every other
        column that references teams.id is repointed, then the duplicate is
        deleted. Unique-constraint collisions (the same stat row already
        exists under the canonical id) are resolved by dropping the
        duplicate's copy.

repoint Move ONE side of specific games from team A to team B (the games
        were filed under the wrong opponent). Phantom players that appear
        only in those games move with them; players that also appear in
        legitimate games for team A get a new/matched player on team B and
        only the affected rows are re-linked.

Both run inside one transaction. The default is a DRY RUN that executes
everything and rolls back, so the log shows exactly what --apply will do.

Usage
-----
    PYTHONPATH=backend python3 scripts/merge_teams.py --into 33170 --from 33192 33220 [--dry-run|--apply]
    PYTHONPATH=backend python3 scripts/merge_teams.py --into 33170 --from 33192 --name "Cal State Monterey Bay" \\
        --school "California State University Monterey Bay" --short CSUMB --apply
    PYTHONPATH=backend python3 scripts/merge_teams.py --repoint --games 8129 9819 --from 33278 --into 33354 --apply

Run scripts/dedup_games.py afterwards: a merge can turn two copies of the
same game (one per spelling) into a Pass 1 / Pass 5 / Pass 6 duplicate.
"""
import argparse
import logging
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

import psycopg2  # noqa: E402
import psycopg2.errors  # noqa: E402
from app.models.database import get_connection  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("merge_teams")

CHILD_TABLES = ("game_batting", "game_pitching", "game_fielding")
EVENT_TEAM_COLS = ("batting_team_id", "defending_team_id")
EVENT_PLAYER_COLS = ("batter_player_id", "pitcher_player_id",
                     "r1_player_id", "r2_player_id", "r3_player_id")

# Columns that reference teams.id / players.id WITHOUT a foreign key, so
# information_schema cannot tell us about them.
EXTRA_TEAM_COLS = [
    ("incoming_transfers", "to_team_id"),
    ("player_projections", "team_id"),
    ("player_projections", "from_team_id"),
    ("trackman_pitches", "team_id"),
    ("summer_players", "assigned_school_team_id"),
    ("pickem_picks", "pick_team_id"),
]
EXTRA_PLAYER_COLS = [
    ("batting_stats_frozen", "player_id"),
    ("pitching_stats_frozen", "player_id"),
    ("player_projections", "player_id"),
    ("recruiting_board_players", "player_id"),
    ("transfer_portal_members", "player_id"),
    ("commitment_audit", "player_id"),
]

_SUFFIX_RE = re.compile(r"\s+(jr|sr|ii|iii|iv)\.?$", re.I)


# ---------------------------------------------------------------- helpers
def _fk_columns(cur, target_table):
    cur.execute(
        """
        SELECT tc.table_name, kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_name = tc.constraint_name
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND ccu.table_name = %s
        ORDER BY 1, 2
        """,
        (target_table,),
    )
    return [(r["table_name"], r["column_name"]) for r in cur.fetchall()]


def _column_exists(cur, table, col):
    cur.execute(
        """
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = %s AND column_name = %s
        """,
        (table, col),
    )
    return cur.fetchone() is not None


def team_columns(cur):
    """Every (table, column) that points at teams.id, minus the ones the
    game/player logic handles explicitly."""
    skip = {("games", "home_team_id"), ("games", "away_team_id"),
            ("players", "team_id")}
    skip |= {(t, "team_id") for t in CHILD_TABLES}
    skip |= {("game_events", c) for c in EVENT_TEAM_COLS}
    cols = _fk_columns(cur, "teams") + [
        c for c in EXTRA_TEAM_COLS if _column_exists(cur, *c)
    ]
    out = []
    for c in cols:
        if c not in skip and c not in out:
            out.append(c)
    return out


def player_columns(cur):
    cols = _fk_columns(cur, "players") + [
        c for c in EXTRA_PLAYER_COLS if _column_exists(cur, *c)
    ]
    out = []
    for c in cols:
        if c not in out:
            out.append(c)
    return out


def team_row(cur, tid):
    cur.execute(
        "SELECT id, name, school_name, short_name, is_active FROM teams WHERE id = %s",
        (tid,),
    )
    return cur.fetchone()


def _label(cur, tid):
    r = team_row(cur, tid)
    return f"{tid} '{r['name']}'" if r else f"{tid} <missing>"


def update_col(cur, table, col, old, new, where_extra="", params=()):
    """UPDATE table SET col = new WHERE col = old [AND where_extra].

    On a unique-constraint collision the same row already exists under
    `new`, so the update is retried row by row and colliding rows are
    DELETED (they are duplicate copies of the same fact).
    Returns (updated, deleted)."""
    sql_where = f'"{col}" = %s' + (f" AND {where_extra}" if where_extra else "")
    cur.execute("SAVEPOINT uc")
    try:
        cur.execute(f'UPDATE "{table}" SET "{col}" = %s WHERE {sql_where}',
                    (new, old, *params))
        n = cur.rowcount
        cur.execute("RELEASE SAVEPOINT uc")
        return n, 0
    except psycopg2.errors.UniqueViolation:
        cur.execute("ROLLBACK TO SAVEPOINT uc")
    updated = deleted = 0
    cur.execute(f'SELECT ctid FROM "{table}" WHERE {sql_where}', (old, *params))
    for r in cur.fetchall():
        ctid = r["ctid"]
        cur.execute("SAVEPOINT ucr")
        try:
            cur.execute(f'UPDATE "{table}" SET "{col}" = %s WHERE ctid = %s',
                        (new, ctid))
            cur.execute("RELEASE SAVEPOINT ucr")
            updated += 1
        except psycopg2.errors.UniqueViolation:
            cur.execute("ROLLBACK TO SAVEPOINT ucr")
            cur.execute(f'DELETE FROM "{table}" WHERE ctid = %s', (ctid,))
            deleted += 1
    if deleted:
        log.info(f"      {table}.{col}: {updated} repointed, {deleted} duplicate rows dropped")
    return updated, deleted


def split_box_name(player_name):
    """'Adrian Rodriguez' -> ('Adrian', 'Rodriguez'); 'Rodriguez, Adrian' ->
    same; 'Anthony Pack Jr.' -> ('Anthony', 'Pack Jr.'); 'Smith' -> ('', 'Smith')."""
    s = (player_name or "").strip()
    s = re.sub(r"^[a-z0-9/]+(?=[A-Z])", "", s).strip()  # 'cfSmith, Bob'
    if "," in s:
        last, first = [x.strip() for x in s.split(",", 1)]
        return first, last
    parts = s.split()
    if len(parts) >= 2:
        return parts[0], " ".join(parts[1:])
    return "", s


def find_player_on_team(cur, team_id, first, last):
    """Match (first, last) to a player on team_id. Exact first+last first,
    then first-initial + last, then last name when unique on the team.
    Non-phantom rows win ties. Returns player id or None."""
    first = (first or "").strip()
    last = (last or "").strip()
    if not last:
        return None
    last_key = _SUFFIX_RE.sub("", last).lower()
    LAST_MATCH = ("(LOWER(last_name) = %s OR LOWER(REGEXP_REPLACE(last_name, "
                  "'\\s+(jr|sr|ii|iii|iv)\\.?$', '', 'i')) = %s)")
    if first:
        cur.execute(
            f"""SELECT id FROM players WHERE team_id = %s
                AND LOWER(first_name) = %s AND {LAST_MATCH}
                ORDER BY is_phantom ASC, id ASC LIMIT 1""",
            (team_id, first.lower(), last_key, last_key),
        )
        r = cur.fetchone()
        if r:
            return r["id"]
        initial = first.rstrip(".").lower()
        if len(initial) == 1:
            cur.execute(
                f"""SELECT id FROM players WHERE team_id = %s
                    AND LOWER(SUBSTRING(first_name FROM 1 FOR 1)) = %s AND {LAST_MATCH}
                    ORDER BY is_phantom ASC, id ASC LIMIT 2""",
                (team_id, initial, last_key, last_key),
            )
            rows = cur.fetchall()
            if len(rows) == 1:
                return rows[0]["id"]
    cur.execute(
        f"""SELECT id, first_name FROM players WHERE team_id = %s AND {LAST_MATCH}
            ORDER BY is_phantom ASC, id ASC LIMIT 2""",
        (team_id, last_key, last_key),
    )
    rows = cur.fetchall()
    if len(rows) == 1:
        # A bare last name may match a player with a DIFFERENT first name;
        # only accept when we have no first name to contradict it.
        if not first or not (rows[0]["first_name"] or "").strip():
            return rows[0]["id"]
        if rows[0]["first_name"].strip().lower() == first.lower():
            return rows[0]["id"]
    return None


def create_player(cur, team_id, first, last):
    cur.execute(
        """INSERT INTO players (first_name, last_name, team_id, is_phantom)
           VALUES (%s, %s, %s, TRUE) RETURNING id""",
        (first or "", last, team_id),
    )
    return cur.fetchone()["id"]


def find_or_create_player(cur, team_id, first, last):
    pid = find_player_on_team(cur, team_id, first, last)
    if pid:
        return pid, False
    return create_player(cur, team_id, first, last), True


def repoint_player_refs(cur, old_pid, new_pid, cols=None):
    """Every column referencing players.id: old_pid -> new_pid."""
    cols = cols or player_columns(cur)
    for tbl, col in cols:
        update_col(cur, tbl, col, old_pid, new_pid)


def create_ooc_team(cur, name, school_name=None, short_name=None):
    cur.execute("SELECT id FROM conferences WHERE abbreviation = 'OOC' LIMIT 1")
    conf = cur.fetchone()["id"]
    cur.execute(
        """INSERT INTO teams (name, school_name, short_name, state, conference_id, is_active)
           VALUES (%s, %s, %s, 'N/A', %s, 0) RETURNING id""",
        (name, school_name or name, short_name or name, conf),
    )
    tid = cur.fetchone()["id"]
    log.info(f"  created OOC team {tid} '{name}' (school='{school_name or name}', short='{short_name or name}')")
    return tid


def rename_team(cur, tid, name=None, school_name=None, short_name=None):
    sets, params = [], []
    for col, val in (("name", name), ("school_name", school_name), ("short_name", short_name)):
        if val:
            sets.append(f"{col} = %s")
            params.append(val)
    if not sets:
        return
    params.append(tid)
    cur.execute(f"UPDATE teams SET {', '.join(sets)} WHERE id = %s", params)
    log.info(f"  renamed team {tid}: " + ", ".join(
        f"{c}='{v}'" for c, v in (("name", name), ("school_name", school_name),
                                  ("short_name", short_name)) if v))


# ------------------------------------------------------------ operations
def repoint_games(cur, game_ids, old_tid, new_tid):
    """Move the `old_tid` side of each game to `new_tid` (games row, box-score
    child rows, game_events). If the game already holds child rows for
    new_tid (an earlier scrape stored the same lineup under the right id),
    the old_tid rows are deleted instead of moved.
    Returns dict of counters; the caller handles players."""
    st = dict(games=0, rows_moved=0, rows_deleted=0, events=0, skipped=0)
    for gid in game_ids:
        cur.execute("SELECT home_team_id, away_team_id FROM games WHERE id = %s", (gid,))
        g = cur.fetchone()
        if not g:
            log.warning(f"    g{gid}: missing, skipped")
            st["skipped"] += 1
            continue
        sides = (g["home_team_id"], g["away_team_id"])
        if old_tid not in sides:
            log.warning(f"    g{gid}: team {old_tid} is not a side {sides}, skipped")
            st["skipped"] += 1
            continue
        if new_tid in sides:
            log.warning(f"    g{gid}: team {new_tid} is already a side {sides}, skipped")
            st["skipped"] += 1
            continue
        cur.execute(
            """UPDATE games
               SET home_team_id = CASE WHEN home_team_id = %s THEN %s ELSE home_team_id END,
                   away_team_id = CASE WHEN away_team_id = %s THEN %s ELSE away_team_id END,
                   updated_at = CURRENT_TIMESTAMP
               WHERE id = %s""",
            (old_tid, new_tid, old_tid, new_tid, gid),
        )
        st["games"] += 1
        for tbl in CHILD_TABLES:
            cur.execute(f"SELECT COUNT(*) AS c FROM {tbl} WHERE game_id = %s AND team_id = %s",
                        (gid, new_tid))
            if cur.fetchone()["c"]:
                cur.execute(f"DELETE FROM {tbl} WHERE game_id = %s AND team_id = %s",
                            (gid, old_tid))
                if cur.rowcount:
                    log.info(f"    g{gid} {tbl}: {cur.rowcount} rows under {old_tid} deleted "
                             f"(rows under {new_tid} already present)")
                st["rows_deleted"] += cur.rowcount
            else:
                cur.execute(f"UPDATE {tbl} SET team_id = %s WHERE game_id = %s AND team_id = %s",
                            (new_tid, gid, old_tid))
                st["rows_moved"] += cur.rowcount
        for col in EVENT_TEAM_COLS:
            cur.execute(f"UPDATE game_events SET {col} = %s WHERE game_id = %s AND {col} = %s",
                        (new_tid, gid, old_tid))
            st["events"] += cur.rowcount
    return st


def _rows_for_player(cur, pid, exclude_game_ids):
    n = 0
    for tbl in CHILD_TABLES:
        cur.execute(
            f"SELECT COUNT(*) AS c FROM {tbl} WHERE player_id = %s AND NOT (game_id = ANY(%s))",
            (pid, list(exclude_game_ids)),
        )
        n += cur.fetchone()["c"]
    return n


def fix_players_after_repoint(cur, game_ids, old_tid, new_tid):
    """After repoint_games: players referenced by the moved rows that still
    belong to old_tid. Exclusive to these games -> move the player row.
    Otherwise -> link the moved rows to a matched/new player on new_tid."""
    game_ids = list(game_ids)
    st = dict(moved=0, relinked=0, created=0)
    if not game_ids:
        return st
    cur.execute(
        """
        SELECT x.player_id, MIN(x.player_name) AS sample
        FROM (
            SELECT player_id, player_name, game_id FROM game_batting
            UNION ALL SELECT player_id, player_name, game_id FROM game_pitching
            UNION ALL SELECT player_id, NULL, game_id FROM game_fielding
        ) x
        JOIN players p ON p.id = x.player_id
        WHERE x.game_id = ANY(%s) AND p.team_id = %s
        GROUP BY x.player_id
        """,
        (game_ids, old_tid),
    )
    affected = cur.fetchall()   # materialise BEFORE reusing the cursor
    for r in affected:
        pid, sample = r["player_id"], r["sample"]
        cur.execute("SELECT first_name, last_name FROM players WHERE id = %s", (pid,))
        p = cur.fetchone()
        d_first, d_last = split_box_name(sample or "")
        first = (p["first_name"] or "").strip() or d_first
        last = (p["last_name"] or "").strip() or d_last
        other = _rows_for_player(cur, pid, game_ids)
        if other == 0:
            cur.execute(
                "UPDATE players SET team_id = %s, first_name = %s, last_name = %s, "
                "updated_at = CURRENT_TIMESTAMP WHERE id = %s",
                (new_tid, first, last, pid),
            )
            for tbl in ("fielding_stats", "player_seasons"):
                update_col(cur, tbl, "team_id", old_tid, new_tid,
                           "player_id = %s", (pid,))
            log.info(f"    player {pid} '{first} {last}': moved to team {new_tid}")
            st["moved"] += 1
        else:
            target, created = find_or_create_player(cur, new_tid, first, last)
            for tbl in CHILD_TABLES:
                update_col(cur, tbl, "player_id", pid, target,
                           "game_id = ANY(%s)", (game_ids,))
            for col in EVENT_PLAYER_COLS:
                cur.execute(
                    f"UPDATE game_events SET {col} = %s WHERE game_id = ANY(%s) AND {col} = %s",
                    (target, game_ids, pid),
                )
            log.info(f"    player {pid} '{first} {last}' also plays for team {old_tid} "
                     f"({other} other rows): these games relinked to "
                     f"{'NEW' if created else 'existing'} player {target} on team {new_tid}")
            st["relinked"] += 1
            st["created"] += int(created)
    return st


def merge_team(cur, canon, dup):
    """Fold team `dup` into team `canon` and delete `dup`."""
    if canon == dup:
        raise ValueError("canon == dup")
    if not team_row(cur, dup):
        log.warning(f"  team {dup} does not exist -- already merged?")
        return None
    log.info(f"  merge {_label(cur, dup)} -> {_label(cur, canon)}")
    cur.execute(
        "SELECT id, home_team_id, away_team_id FROM games WHERE %s IN (home_team_id, away_team_id)",
        (dup,),
    )
    games = cur.fetchall()
    ids = [g["id"] for g in games if canon not in (g["home_team_id"], g["away_team_id"])]
    for g in games:
        if canon in (g["home_team_id"], g["away_team_id"]):
            log.warning(f"    g{g['id']} has BOTH {dup} and {canon} as sides -- left untouched, "
                        f"needs manual review")
    st = repoint_games(cur, ids, dup, canon)

    # Players: match to the canonical roster by name, else move.
    cur.execute("SELECT id, first_name, last_name FROM players WHERE team_id = %s ORDER BY id", (dup,))
    players = cur.fetchall()
    pcols = player_columns(cur)
    matched = moved = 0
    for p in players:
        target = find_player_on_team(cur, canon, p["first_name"], p["last_name"])
        if target:
            repoint_player_refs(cur, p["id"], target, pcols)
            cur.execute("DELETE FROM players WHERE id = %s", (p["id"],))
            matched += 1
        else:
            cur.execute("UPDATE players SET team_id = %s, updated_at = CURRENT_TIMESTAMP WHERE id = %s",
                        (canon, p["id"]))
            moved += 1

    # Stragglers: box-score / event rows that reference `dup` in games where
    # it is NOT a side (ghost rows from old scraper bugs, or games skipped
    # above). A merge must leave zero references, so sweep globally.
    for tbl in CHILD_TABLES:
        n, d = update_col(cur, tbl, "team_id", dup, canon)
        if n or d:
            log.info(f"    {tbl}: {n} straggler rows repointed, {d} dropped")
    for col in EVENT_TEAM_COLS:
        n, _ = update_col(cur, "game_events", col, dup, canon)
        if n:
            log.info(f"    game_events.{col}: {n} straggler rows repointed")

    # Everything else that references teams.id
    for tbl, col in team_columns(cur):
        update_col(cur, tbl, col, dup, canon)

    cur.execute("DELETE FROM teams WHERE id = %s", (dup,))
    log.info(f"    games={st['games']} box rows moved={st['rows_moved']} "
             f"deleted={st['rows_deleted']} events={st['events']} | players "
             f"matched={matched} moved={moved} | team {dup} deleted")
    return dict(st, players_matched=matched, players_moved=moved)


# ------------------------------------------------------------------- CLI
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--into", type=int, required=True, help="canonical / destination team id")
    ap.add_argument("--from", dest="from_ids", type=int, nargs="+", required=True,
                    help="duplicate team id(s) to merge, or the wrong team id for --repoint")
    ap.add_argument("--repoint", action="store_true", help="move one side of --games instead of merging teams")
    ap.add_argument("--games", type=int, nargs="*", default=[], help="game ids for --repoint")
    ap.add_argument("--name"); ap.add_argument("--school"); ap.add_argument("--short")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--dry-run", action="store_true", default=True)
    g.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    dry = not args.apply

    with get_connection() as conn:
        cur = conn.cursor()
        try:
            if args.repoint:
                if len(args.from_ids) != 1 or not args.games:
                    ap.error("--repoint needs exactly one --from id and --games")
                old, new = args.from_ids[0], args.into
                log.info(f"repoint games {args.games}: {_label(cur, old)} -> {_label(cur, new)}")
                st = repoint_games(cur, args.games, old, new)
                st.update(fix_players_after_repoint(cur, args.games, old, new))
                log.info(f"  {st}")
            else:
                for dup in args.from_ids:
                    merge_team(cur, args.into, dup)
            rename_team(cur, args.into, args.name, args.school, args.short)
            if dry:
                conn.rollback()
                log.info("DRY RUN -- rolled back. Re-run with --apply to commit.")
            else:
                conn.commit()
                log.info("committed.")
        except Exception:
            conn.rollback()
            raise


if __name__ == "__main__":
    main()
