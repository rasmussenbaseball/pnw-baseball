#!/usr/bin/env python3
"""
Auto-link summer_players to spring players (summer_player_links).

When a WCL roster lists a player who also plays college spring ball
on a PNW team, we want the spring player profile to surface
"Currently with: <WCL team>" and the summer profile to surface
"View college profile". That link lives in summer_player_links.

Match strategy:
  1. Build candidates by normalized "first last" name.
  2. Score each summer_player → spring_player pair:
       +10  exact normalized full-name match (always required)
       +20  college string contains spring team's short_name (or vice versa)
       +5   college matches by alias (Saddleback CC → Saddleback)
  3. Pick the single highest-scoring spring player. Ties → skip
     (we don't want to silently link "John Smith" to one of two).

Usage:
    PYTHONPATH=backend python3 scripts/link_summer_to_spring.py
    PYTHONPATH=backend python3 scripts/link_summer_to_spring.py --dry-run
    PYTHONPATH=backend python3 scripts/link_summer_to_spring.py --season 2026 --rescore
"""

import argparse
import logging
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from app.models.database import get_connection


logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("link_summer_to_spring")


def _norm(s):
    return re.sub(r"[^a-z]", "", (s or "").lower())


def _norm_school(s):
    """College name → comparison key. Strip suffixes like 'CC',
    'Community College', 'University', state words."""
    if not s:
        return ""
    s = s.lower()
    for junk in ("community college", "comm college", "university", " of ",
                 "college", "state", " cc", " jc"):
        s = s.replace(junk, " ")
    return re.sub(r"[^a-z]", "", s)


def load_spring_candidates(cur):
    """Returns dict: norm_full_name -> list of {id, first, last, team_id, team_short, school_name}.

    Only active 2026 players to keep the candidate pool reasonable.
    """
    cur.execute(
        """
        SELECT DISTINCT p.id, p.first_name, p.last_name,
               p.team_id, t.short_name AS team_short, t.school_name,
               p.year_in_school, p.roster_year
        FROM players p
        JOIN teams t ON t.id = p.team_id
        WHERE COALESCE(t.is_active, 1) = 1
          AND COALESCE(p.is_phantom, FALSE) = FALSE
        """
    )
    by_name = defaultdict(list)
    for row in cur.fetchall():
        key = _norm(f"{row['first_name']} {row['last_name']}")
        by_name[key].append({
            "id": row["id"],
            "first": row["first_name"],
            "last": row["last_name"],
            "team_id": row["team_id"],
            "team_short": row["team_short"] or "",
            "school_name": row["school_name"] or "",
            "year_in_school": row["year_in_school"],
            "roster_year": row["roster_year"],
        })
    return by_name


CLASS_OFFSET = {"fr": 0, "so": 1, "jr": 2, "sr": 3, "gr": 4}


def _class_offset(year_in_school):
    """Years a player is removed from their college-entry year (Fr=0…)."""
    if not year_in_school:
        return None
    s = year_in_school.strip().lower()
    for key, off in CLASS_OFFSET.items():
        if s.startswith(key) or re.search(rf"\b{key}", s):
            return off
    for word, off in (("fresh", 0), ("soph", 1), ("jun", 2), ("sen", 3), ("grad", 4)):
        if word in s:
            return off
    return None


def _timeline_ok(summer_first_season, candidate):
    """A spring player can't have played collegiate summer ball before
    (their college-entry year - 1). Guards against linking e.g. a 2026
    freshman to a same-named 2024 summer player (a different person)."""
    off = _class_offset(candidate.get("year_in_school"))
    latest = candidate.get("roster_year")
    if off is None or latest is None or summer_first_season is None:
        return True  # not enough info → don't block
    return summer_first_season >= (latest - off) - 1


def _first_initial(name):
    n = _norm(name)
    return n[:1] if n else ""


def _is_initial_only(name):
    """True when the first name is a single letter ("T", "T.", "T ")."""
    return len(_norm(name)) == 1


def _unique_li_candidate(summer_player, by_lastinitial):
    """The single timeline-plausible spring player sharing this summer
    player's LAST NAME + FIRST INITIAL, or None if zero/ambiguous.

    Uniqueness is the core guard (no college to corroborate): rare surnames
    resolve to one candidate; common ones (J Smith) stay ambiguous. Requires
    a known roster_year and bounds the summer season inside the player's
    plausible college window:
      college-entry-1  <=  summer season  <=  last-college-year + 1
    """
    ln = _norm(summer_player["last_name"])
    fi = _first_initial(summer_player["first_name"])
    if not ln or not fi:
        return None
    fs = summer_player.get("first_season")
    ok = []
    for c in by_lastinitial.get((ln, fi), []):
        ry = c.get("roster_year")
        if ry is None:
            continue  # need it for the upper bound; too risky without
        if not _timeline_ok(fs, c):
            continue  # summer before the player could have entered college
        if fs is not None and fs > ry + 1:
            continue  # summer years after the player's last college season
        ok.append(c)
    return ok[0] if len(ok) == 1 else None


# Common first-name nickname pairs that share no obvious prefix/spelling.
# Stored as frozensets of normalized variants; two names are nickname-
# compatible if they fall in the same set.
_NICKNAME_GROUPS = [
    {"daniel", "dan", "danny"}, {"nicholas", "nick", "nik"},
    {"stephen", "steven", "steve", "stevie"}, {"michael", "mike", "mikey"},
    {"william", "will", "bill", "billy", "liam"}, {"robert", "rob", "bob", "bobby"},
    {"anthony", "tony"}, {"thomas", "tom", "tommy"}, {"charles", "charlie", "chuck"},
    {"richard", "rick", "ricky", "dick"}, {"james", "jim", "jimmy", "jamie"},
    {"joseph", "joe", "joey"}, {"jacob", "jake"}, {"andrew", "drew", "andy"},
    {"edward", "ed", "eddie", "ted"}, {"nathaniel", "nathan", "nate"},
    {"jonathan", "jon", "johnny", "john"}, {"matthew", "matt"},
    {"zachary", "zach", "zack"}, {"benjamin", "ben", "benji"},
    {"samuel", "sam", "sammy"}, {"alexander", "alex", "alec", "xander"},
    {"christopher", "chris"}, {"gabriel", "gabe"}, {"raymond", "ray"},
    {"patrick", "pat"}, {"timothy", "tim"}, {"gregory", "greg"},
    {"kenneth", "ken", "kenny"}, {"vincent", "vinny", "vince"},
    {"maxwell", "max"}, {"dominic", "dom", "nick"}, {"isaiah", "zay"},
    {"cameron", "cam"}, {"theodore", "theo", "ted"}, {"oliver", "ollie"},
]


def _edit_distance(a, b, cap=3):
    """Levenshtein, short-circuited once it exceeds `cap`."""
    if abs(len(a) - len(b)) > cap:
        return cap + 1
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i] + [0] * len(b)
        best = cur[0]
        for j, cb in enumerate(b, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb))
            best = min(best, cur[j])
        if best > cap:
            return cap + 1
        prev = cur
    return prev[-1]


def _is_initialism(orig):
    """True for genuine initials like 'DJ', 'D.J.', 'JJ', 'A.J.' — an
    all-uppercase 2-3 letter token. NOT a real short name like 'Ty'/'Jo'
    (mixed case) or an all-caps full name like 'CAMERON'."""
    s = re.sub(r"[.\s]", "", orig or "")
    return s.isalpha() and s.isupper() and 2 <= len(s) <= 3


def _names_compatible(summer_orig, spring_orig, strict):
    """Are two first names plausibly the same person? `strict` (common
    surname) demands a strong signal; non-strict (rare surname, where
    last+initial uniqueness is already decisive) allows looser variants.

       both modes:  exact · prefix (len>=3) · known nickname · edit<=1
       lenient too: edit==2 (spelling variant) · initialism (DJ/Dexter)

    Rejects different names sharing an initial (Jack/Jonah; Conner/Cooper
    on a common surname; Ty/Tristan)."""
    a, b = _norm(summer_orig), _norm(spring_orig)
    if not a or not b:
        return False
    if a == b:
        return True
    if a[0] != b[0]:
        return False
    if a.startswith(b) or b.startswith(a):
        if min(len(a), len(b)) >= 3:
            return True
    for g in _NICKNAME_GROUPS:
        if a in g and b in g:
            return True
    if _edit_distance(a, b) <= 1:
        return True
    if not strict:
        if _is_initialism(summer_orig) or _is_initialism(spring_orig):
            return True
        if _edit_distance(a, b) <= 2:
            return True
    return False


def _nickname_unique_match(summer_player, by_lastinitial, last_total):
    """For a full-first-name summer player whose exact name didn't match a
    spring player: accept the UNIQUE last+initial candidate only if the
    first names are nickname/variant-compatible. Common surnames (>=3 spring
    players) require a strong match so different people who merely share a
    rare-ish surname (Conner vs Cooper Smith) are not linked."""
    c = _unique_li_candidate(summer_player, by_lastinitial)
    if c is None:
        return None
    strict = last_total.get(_norm(c["last"]), 0) >= 3
    if _names_compatible(summer_player["first_name"], c["first"], strict):
        return c
    return None


def load_summer_unlinked(cur, season):
    """Return unlinked summer_players with SEASON STATS for `season`.

    Gated on season-stat presence (not per-game rows): pre-2026 summer
    seasons were imported as Pointstreak season rollups with no per-game
    box scores, so a game-data gate would make those players invisible to
    the linker. Season-stat presence still excludes inactive prior-year
    roster ghosts."""
    cur.execute(
        """
        SELECT DISTINCT sp.id, sp.first_name, sp.last_name, sp.college,
               t.short_name AS team_short, t.name AS team_name,
               (SELECT MIN(season) FROM (
                   SELECT season FROM summer_batting_stats WHERE player_id = sp.id
                   UNION SELECT season FROM summer_pitching_stats WHERE player_id = sp.id
                ) z) AS first_season
        FROM summer_players sp
        JOIN summer_teams t ON t.id = sp.team_id
        WHERE NOT EXISTS (
            SELECT 1 FROM summer_player_links spl WHERE spl.summer_player_id = sp.id
        )
        AND (
          EXISTS (
            SELECT 1 FROM summer_batting_stats b
            WHERE b.player_id = sp.id AND b.season = %s
          )
          OR EXISTS (
            SELECT 1 FROM summer_pitching_stats p
            WHERE p.player_id = sp.id AND p.season = %s
          )
        )
        """,
        (season, season),
    )
    return cur.fetchall()


def score_match(summer_player, spring_candidate):
    """Higher = better. <10 = no link."""
    score = 10  # base for name match
    summer_college = _norm_school(summer_player.get("college") or "")
    spring_school = _norm_school(spring_candidate["school_name"])
    spring_short = _norm_school(spring_candidate["team_short"])
    if summer_college and spring_school:
        if summer_college == spring_school:
            score += 20
        elif summer_college in spring_school or spring_school in summer_college:
            score += 15
        elif spring_short and (summer_college in spring_short or spring_short in summer_college):
            score += 5
    return score


def run(season, dry_run=False, rescore=False):
    with get_connection() as conn:
        cur = conn.cursor()
        spring_by_name = load_spring_candidates(cur)
        logger.info(f"Loaded {sum(len(v) for v in spring_by_name.values())} spring candidates "
                    f"under {len(spring_by_name)} unique full names")

        if rescore:
            logger.info("Rescore mode: clearing existing links before re-linking")
            if not dry_run:
                cur.execute("DELETE FROM summer_player_links WHERE confidence IN ('auto', 'auto_first_initial', 'auto_nickname')")

        # Secondary index for first-initial-only matching: (last, initial) -> candidates.
        # Plus a per-surname count so the nickname path can be stricter on
        # common surnames (where a fuzzy first-name match is riskier).
        by_lastinitial = defaultdict(list)
        last_total = defaultdict(int)
        for cand_list in spring_by_name.values():
            for c in cand_list:
                ln = _norm(c["last"])
                fi = _first_initial(c["first"])
                if ln and fi:
                    by_lastinitial[(ln, fi)].append(c)
                if ln:
                    last_total[ln] += 1

        unlinked = load_summer_unlinked(cur, season)
        logger.info(f"Unlinked summer_players with {season} game data: {len(unlinked)}")

        linked = 0
        initial_linked = 0
        nickname_linked = 0
        ambiguous = 0
        no_candidate = 0
        for sp in unlinked:
            chosen = None
            confidence = "auto"
            key = _norm(f"{sp['first_name']} {sp['last_name']}")
            cands = spring_by_name.get(key, [])
            # Timeline guard: drop candidates who couldn't have played this
            # summer season (e.g. a 2026 freshman vs a 2024 summer player).
            cands = [c for c in cands if _timeline_ok(sp.get("first_season"), c)]
            if cands:
                # Full-name path: score every candidate, pick best (tie → skip).
                scored = [(score_match(dict(sp), c), c) for c in cands]
                scored.sort(key=lambda x: -x[0])
                top_score = scored[0][0]
                top_candidates = [c for s, c in scored if s == top_score]
                if len(top_candidates) > 1:
                    ambiguous += 1
                    continue
                chosen = top_candidates[0]
            elif _is_initial_only(sp["first_name"]):
                # First-initial-only path: link only on a unique last+initial
                # match within the player's plausible college window.
                chosen = _unique_li_candidate(sp, by_lastinitial)
                if chosen is None:
                    no_candidate += 1
                    continue
                # Distinct label (NOT the legacy 'auto_initial' the archived
                # SQL linker used for full-name matches) so these loosest,
                # college-less first-initial matches stay easy to audit/undo.
                confidence = "auto_first_initial"
            else:
                # Nickname / spelling-variant path: full first name that did
                # NOT exactly match, but a unique last+initial spring player
                # whose first name is variant-compatible (DJ/Dexter,
                # Matt/Matthew, Griffin/Griffen). Rejects different people who
                # merely share a rare surname (Jack vs Jonah Schroeder).
                chosen = _nickname_unique_match(sp, by_lastinitial, last_total)
                if chosen is None:
                    no_candidate += 1
                    continue
                confidence = "auto_nickname"

            if confidence == "auto_first_initial":
                initial_linked += 1
            elif confidence == "auto_nickname":
                nickname_linked += 1
            else:
                linked += 1
            logger.debug(
                f"  link [{confidence}] {sp['first_name']} {sp['last_name']} "
                f"→ {chosen['first']} {chosen['last']} ({chosen['team_short']})"
            )
            if not dry_run:
                cur.execute(
                    """
                    INSERT INTO summer_player_links (summer_player_id, spring_player_id, confidence)
                    VALUES (%s, %s, %s)
                    ON CONFLICT (summer_player_id) DO NOTHING
                    """,
                    (sp["id"], chosen["id"], confidence),
                )

        if not dry_run:
            conn.commit()

        logger.info(
            f"Linked (full name): {linked} · Linked (initial): {initial_linked} · "
            f"Linked (nickname): {nickname_linked} · "
            f"Ambiguous: {ambiguous} · No spring candidate: {no_candidate}"
        )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--season", type=int, default=2026)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--rescore", action="store_true",
                        help="Delete existing auto links and recompute")
    parser.add_argument("--all-seasons", action="store_true",
                        help="Run the linker for every summer season (2022-2026)")
    args = parser.parse_args()
    if args.all_seasons:
        for yr in range(2022, 2027):
            logger.info(f"===== Season {yr} =====")
            run(yr, dry_run=args.dry_run, rescore=args.rescore)
    else:
        run(args.season, dry_run=args.dry_run, rescore=args.rescore)


if __name__ == "__main__":
    main()
