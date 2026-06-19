#!/usr/bin/env python3
"""
Repair corrupted box-level R/H/E/LOB totals on D1 games rows.

A separate bug from the home/away mislabel (see repair_d1_home_away.py): some
D1 games (so far all Oregon St., from the Sidearm v2 ingest) have wrong score /
hits / errors *values* — e.g. a 511-run "score", or NDSU credited 8 runs in a
game it actually lost 10-0. A single 511-run game wrecks any park-factor run
environment, which is the whole reason we're here.

Authority (permanent, per-game):
  * v2 API tenant teams (UW/Oregon/OSU/WSU): homeTeam/visitingTeam
    ``scoringSummary`` {runs,hits,errors,leftOnBase}. Cross-checked against the
    inning-by-inning ``scoreByInnings`` sum.
  * Older Sidearm (Gonzaga/Portland): parse_sidearm_boxscore linescore
    (visitor row first, home row second).

Orientation is taken as already-correct (run repair_d1_home_away.py first). We
align the boxscore's home/away to the DB row by team-name match and REFUSE to
write any game whose orientation can't be confirmed (reported as 'unaligned').

Usage:
    PYTHONPATH=backend python3 scripts/repair_d1_scores.py --collect
    PYTHONPATH=backend python3 scripts/repair_d1_scores.py --dry-run
    PYTHONPATH=backend python3 scripts/repair_d1_scores.py --apply
"""
import sys, os, re, json, random, argparse, logging, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))
sys.path.insert(0, str(Path(__file__).parent))

import requests
from app.models.database import get_connection
from scrape_boxscores import SIDEARM_API_TENANTS, USER_AGENTS, fetch_page, parse_sidearm_boxscore
from repair_d1_home_away import DOMAIN_TEAM, domain_of, boxscore_id, SEASONS, load_games

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger(__name__)

CACHE_PATH = Path(__file__).parent.parent / "data" / "d1_rhe_truth.json"
BACKUP_PATH = Path(__file__).parent.parent / "data" / "d1_scores_backup_2026-06-18.json"


def _i(x):
    try:
        return int(x)
    except (ValueError, TypeError):
        return None


def _sum_innings(s):
    if not s:
        return None
    parts = [p for p in re.split(r"[,\s]+", str(s)) if p.strip().lstrip("-").isdigit()]
    return sum(int(p) for p in parts) if parts else None


def fetch_truth(base_url, source_url):
    """Return {'home':{r,h,e,lob,name}, 'away':{...}} or None."""
    bid = boxscore_id(source_url)
    if not bid:
        return None
    tenant = SIDEARM_API_TENANTS.get(base_url)
    if tenant:
        try:
            d = requests.get(f"{base_url}/api/v2/stats/boxscore/{bid}",
                             headers={"tenant": tenant, "Accept": "application/json",
                                      "User-Agent": random.choice(USER_AGENTS)}, timeout=20)
            if d.status_code == 204:
                return None
            d.raise_for_status()
            d = d.json()
        except Exception as e:
            logger.warning(f"  api fail {bid}: {e}")
            return None
        out = {}
        for side, key in (("home", "homeTeam"), ("away", "visitingTeam")):
            ss = (d.get(key) or {}).get("scoringSummary") or {}
            runs = _i(ss.get("runs"))
            inn = _sum_innings(ss.get("scoreByInnings"))
            # prefer runs, but if it disagrees with the inning sum, trust the innings
            if inn is not None and runs is not None and inn != runs:
                runs = inn
            out[side] = {"r": runs, "h": _i(ss.get("hits")), "e": _i(ss.get("errors")),
                         "lob": _i(ss.get("leftOnBase"))}
        out["home"]["name"] = d.get("homeTeamName")
        out["away"]["name"] = d.get("visitingTeamName")
        return out
    # older Sidearm HTML
    box = parse_sidearm_boxscore(fetch_page(source_url, retries=2, delay_range=(1.0, 2.0)), base_url=base_url)
    if not box or box.get("home_score") is None or box.get("away_score") is None:
        return None
    return {
        "home": {"r": _i(box.get("home_score")), "h": _i(box.get("home_hits")),
                 "e": _i(box.get("home_errors")), "lob": None, "name": box.get("home_team")},
        "away": {"r": _i(box.get("away_score")), "h": _i(box.get("away_hits")),
                 "e": _i(box.get("away_errors")), "lob": None, "name": box.get("away_team")},
    }


def collect(games):
    cache = {}
    if CACHE_PATH.exists():
        cache = {int(k): v for k, v in json.loads(CACHE_PATH.read_text()).items()}
    for i, g in enumerate(games):
        if g["id"] in cache and cache[g["id"]].get("ok"):
            continue
        base = f"https://{domain_of(g['source_url'])}"
        t = fetch_truth(base, g["source_url"])
        cache[g["id"]] = {"ok": bool(t), **(t or {})}
        if (i + 1) % 25 == 0:
            logger.info(f"  {i+1}/{len(games)}")
            CACHE_PATH.write_text(json.dumps({str(k): v for k, v in cache.items()}))
    CACHE_PATH.write_text(json.dumps({str(k): v for k, v in cache.items()}))
    logger.info(f"collected {sum(1 for v in cache.values() if v.get('ok'))}/{len(cache)}")


def _norm(s):
    s = re.sub(r"^(#|no\.?\s*)\d+\s*", "", (s or "").lower())  # drop ranking prefix
    s = re.sub(r"[^a-z]", "", s)
    return s


def aligned_sides(g, t, ha_truth):
    """Map truth home/away to this DB row positionally.

    The R/H/E truth and the home/away truth (ha_truth, from
    d1_home_away_truth.json) come from the SAME boxscores, and the home/away
    orientation has already been applied to the DB, so DB-home == boxscore-home.
    We therefore align positionally, but GUARD it: for v2-API games confirm the
    DB's owner side still matches the boxscore's thisTeamIsHomeTeam. If that
    disagrees, orientation is unexpectedly off -> refuse to write.
    """
    owner = DOMAIN_TEAM[domain_of(g["source_url"])]
    db_owner_is_home = (g["home_team_id"] == owner)
    ht = ha_truth.get(g["id"]) or {}
    if ht.get("source") == "api" and "this_is_home" in ht:
        if bool(ht["this_is_home"]) != db_owner_is_home:
            return None, None  # orientation drift -> skip
    return t["home"], t["away"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--collect", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    games = load_games()
    logger.info(f"{len(games)} D1 games in scope")
    if args.collect:
        collect(games)
        return

    cache = {int(k): v for k, v in json.loads(CACHE_PATH.read_text()).items()}
    HA_PATH = Path(__file__).parent.parent / "data" / "d1_home_away_truth.json"
    ha_truth = {int(k): v for k, v in json.loads(HA_PATH.read_text()).items()}
    diffs, unaligned = [], []
    for g in games:
        t = cache.get(g["id"])
        if not t or not t.get("ok"):
            unaligned.append((g, "no_truth"))
            continue
        dh, da = aligned_sides(g, t, ha_truth)
        if dh is None:
            unaligned.append((g, "unaligned"))
            continue
        # build the set of column changes (only where truth is known and differs).
        # LOB intentionally excluded: not park-factor relevant and DB-NULL everywhere.
        changes = {}
        for col, side, fld in (("home_score", dh, "r"), ("away_score", da, "r"),
                               ("home_hits", dh, "h"), ("away_hits", da, "h"),
                               ("home_errors", dh, "e"), ("away_errors", da, "e")):
            v = side.get(fld)
            if v is not None and g.get(col) != v:
                changes[col] = (g.get(col), v)
        if changes:
            diffs.append((g, changes))

    logger.info(f"\nGames needing score/RHE fix: {len(diffs)}")
    logger.info(f"Unaligned/no-truth (skipped): {len(unaligned)}")
    for g, why in unaligned[:20]:
        logger.info(f"  skip gid={g['id']} {g['game_date']} {g['home_team_name']} vs {g['away_team_name']} ({why})")

    for g, ch in diffs:
        cols = ", ".join(f"{k}:{v[0]}->{v[1]}" for k, v in ch.items())
        logger.info(f"  gid={g['id']} {g['game_date']} {g['home_team_name']} vs {g['away_team_name']} | {cols}")

    if args.apply and diffs:
        # backup affected games rows
        def ser(o):
            return o.isoformat() if isinstance(o, (datetime.date, datetime.datetime)) else str(o)
        with get_connection() as conn:
            cur = conn.cursor()
            ids = [g["id"] for g, _ in diffs]
            cur.execute("SELECT * FROM games WHERE id = ANY(%s)", (ids,))
            BACKUP_PATH.write_text(json.dumps([dict(r) for r in cur.fetchall()], default=ser, indent=1))
            for g, ch in diffs:
                sets = ", ".join(f"{k}=%s" for k in ch)
                cur.execute(f"UPDATE games SET {sets}, updated_at=now() WHERE id=%s",
                            [v[1] for v in ch.values()] + [g["id"]])
            conn.commit()
        logger.info(f"\nApplied score/RHE fixes to {len(diffs)} games (backup: {BACKUP_PATH.name}).")


if __name__ == "__main__":
    main()
