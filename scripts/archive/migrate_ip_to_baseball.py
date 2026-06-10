"""Migrate game_pitching.innings_pitched from decimal notation to baseball notation.

Baseball notation: 6.2 = 6 and 2/3 innings (.1 = 1 out, .2 = 2 outs)
Decimal notation: 6.666... = 6 and 2/3 innings (math-correct but non-standard)

All scrapers now write baseball notation going forward. This script cleans up
the 1,939 legacy decimal rows created by scrape_boxscores.py and
backfill_sidearm_boxscores.py before the bug was fixed.

Conversion: outs = round(ip_decimal * 3); baseball_ip = outs//3 + (outs%3)/10

USAGE:
  python3 scripts/migrate_ip_to_baseball.py --dry-run     # preview
  python3 scripts/migrate_ip_to_baseball.py --commit      # apply

Safety:
  - Dry-run by default (shows counts + samples, no DB writes)
  - Only touches rows with fractional parts NOT in {.0, .1, .2}
  - Single transaction with explicit commit
  - Skips rows where conversion would yield the same value (no-op)
"""
import argparse
import os
import sys

import psycopg2
import psycopg2.extras


def load_env(env_path):
    env = {}
    if not os.path.exists(env_path):
        print(f"ERROR: .env not found at {env_path}", file=sys.stderr)
        sys.exit(1)
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k] = v
    return env


def to_baseball_ip(decimal_ip):
    """Convert decimal innings (e.g. 1.333) to baseball notation (e.g. 1.1)."""
    if decimal_ip is None:
        return None
    outs = round(float(decimal_ip) * 3)
    whole = outs // 3
    frac = outs % 3
    return float(f"{whole}.{frac}")


def is_baseball_legal(ip):
    """True if the fractional part is already .0, .1, or .2."""
    if ip is None:
        return True
    whole = int(ip)
    frac = round((float(ip) - whole) * 10)
    return frac in (0, 1, 2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", default=True)
    ap.add_argument("--commit", action="store_true",
                    help="Actually write to the DB (overrides --dry-run)")
    ap.add_argument("--env",
                    default=os.path.join(os.path.dirname(__file__), "..", ".env"),
                    help="Path to .env file")
    args = ap.parse_args()

    dry_run = not args.commit

    env = load_env(os.path.abspath(args.env))
    conn = psycopg2.connect(env["DATABASE_URL"])
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # Pull all non-null innings_pitched rows. We filter in Python for clarity —
    # the table is small enough (~9k rows) that an index-y SQL predicate isn't
    # worth the readability cost.
    cur.execute("""
        SELECT id, game_id, player_id, player_name, innings_pitched
        FROM game_pitching
        WHERE innings_pitched IS NOT NULL
    """)
    rows = cur.fetchall()
    print(f"Scanned {len(rows):,} game_pitching rows with innings_pitched.")

    to_update = []
    already_legal = 0
    for r in rows:
        ip = float(r["innings_pitched"])
        if is_baseball_legal(ip):
            already_legal += 1
            continue
        new_ip = to_baseball_ip(ip)
        if new_ip == ip:
            continue  # identical after round-trip — unlikely but safe
        to_update.append((r["id"], ip, new_ip, r["player_name"], r["game_id"]))

    print(f"  Already baseball-legal: {already_legal:,}")
    print(f"  Need conversion:        {len(to_update):,}")
    print()

    if not to_update:
        print("No rows to migrate.")
        conn.close()
        return

    # Show a few samples grouped by fractional part
    print("Sample conversions:")
    seen = set()
    samples = 0
    for gp_id, old_ip, new_ip, pname, gid in to_update:
        frac_key = round((old_ip - int(old_ip)) * 1000) / 1000
        if frac_key in seen:
            continue
        seen.add(frac_key)
        print(f"  gp_id={gp_id:6d} game={gid:6d} {str(pname)[:25]:25s}  "
              f"{old_ip} → {new_ip}")
        samples += 1
        if samples >= 10:
            break

    if dry_run:
        print()
        print(f"DRY RUN — no changes written. {len(to_update):,} rows would be updated.")
        print("Re-run with --commit to apply.")
        conn.close()
        return

    # Apply updates in one transaction
    print()
    print(f"Applying {len(to_update):,} updates...")
    update_cur = conn.cursor()
    try:
        psycopg2.extras.execute_batch(
            update_cur,
            "UPDATE game_pitching SET innings_pitched = %s WHERE id = %s",
            [(new_ip, gp_id) for gp_id, _, new_ip, _, _ in to_update],
            page_size=200,
        )
        conn.commit()
        print(f"OK — committed {len(to_update):,} row updates.")
    except Exception as exc:
        conn.rollback()
        print(f"ERROR — rolled back: {exc}", file=sys.stderr)
        sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
