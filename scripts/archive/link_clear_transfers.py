#!/usr/bin/env python3
"""Link the VERY CLEAR same-player-across-teams duplicates into one canonical.

Background: spring `players` stores one row per (player, team), so a transfer
creates a new row. A `player_links` table (canonical_id, linked_id) collapses
them so search shows one entry and the profile aggregates all stints. The
existing link_transfers.py misses two big buckets — name variants (Zach vs
Zachary, Conner vs Connor) and season gaps > 2 years (redshirts / gap years /
missing seasons). This script links only the UNAMBIGUOUS cases.

A cluster = players sharing a normalized last name whose first names are
equivalent (exact, nickname, prefix>=3, or 1-char spelling). We link a cluster
ONLY when it clearly describes one person:
  * the equivalent-first-name set forms a clique (no "Ben" bridging Benjamin and
    Bennett),
  * NO two records share a season that both have stats in (a person can't play
    two schools the same spring — overlap => different people => skip),
  * the seasons span <= MAX_SPAN years,
  * AND it's distinctive: either an EXACT-name match, or the surname yields just
    one such cluster, or there's corroboration (hometown / previous_school).

Canonical (the surviving search/profile record) = most recent / highest level:
current-season stats > division (D1>D2>NAIA>D3>JUCO) > latest season > most
seasons.

Usage:
    PYTHONPATH=backend python3 scripts/link_clear_transfers.py            # dry run
    PYTHONPATH=backend python3 scripts/link_clear_transfers.py --apply    # write
    PYTHONPATH=backend python3 scripts/link_clear_transfers.py --season 2026
"""
import argparse
import sys
from collections import defaultdict

from app.models.database import get_connection

CURRENT_SEASON = 2026
MAX_SPAN = 6
DIV_PRIORITY = {"D1": 5, "D2": 4, "NAIA": 3, "D3": 2, "JUCO": 1}

# Nickname -> canonical base. Both directions collapse to the base form.
NICK = {
    "zach": "zachary", "zac": "zachary", "zack": "zachary", "zachary": "zachary",
    "matt": "matthew", "matthew": "matthew", "matty": "matthew",
    "mike": "michael", "michael": "michael", "mikey": "michael",
    "alex": "alexander", "alexander": "alexander",
    "nick": "nicholas", "nicholas": "nicholas",
    "tony": "anthony", "anthony": "anthony",
    "tom": "thomas", "tommy": "thomas", "thomas": "thomas",
    "joe": "joseph", "joey": "joseph", "joseph": "joseph",
    "jake": "jacob", "jacob": "jacob",
    "charlie": "charles", "chuck": "charles", "charles": "charles",
    "drew": "andrew", "andy": "andrew", "andrew": "andrew",
    "will": "william", "bill": "william", "billy": "william", "william": "william",
    "rob": "robert", "bob": "robert", "bobby": "robert", "robbie": "robert", "robert": "robert",
    "dan": "daniel", "danny": "daniel", "daniel": "daniel",
    "dave": "david", "david": "david",
    "jim": "james", "jimmy": "james", "james": "james",
    "sam": "samuel", "sammy": "samuel", "samuel": "samuel",
    "ben": "benjamin", "benny": "benjamin", "benjamin": "benjamin",
    "vinny": "vincent", "vince": "vincent", "vincent": "vincent",
    "gabe": "gabriel", "gabriel": "gabriel",
    "nate": "nathan", "nathan": "nathan", "nathaniel": "nathaniel",
    "greg": "gregory", "gregory": "gregory",
    "jeff": "jeffrey", "jeffrey": "jeffrey",
    "steve": "steven", "steven": "steven", "stephen": "steven",
    "manny": "manuel", "manuel": "manuel",
}


def _lev1(a, b):
    """True if Levenshtein distance between a and b is <= 1 (and len >= 5)."""
    if abs(len(a) - len(b)) > 1:
        return False
    if min(len(a), len(b)) < 5:
        return False
    if a == b:
        return True
    if len(a) == len(b):  # one substitution
        return sum(x != y for x, y in zip(a, b)) == 1
    # one insertion/deletion: shorter must embed in longer with one skip
    s, l = (a, b) if len(a) < len(b) else (b, a)
    i = j = 0
    skipped = False
    while i < len(s) and j < len(l):
        if s[i] == l[j]:
            i += 1; j += 1
        elif skipped:
            return False
        else:
            skipped = True; j += 1
    return True


def first_equiv(a, b):
    a = (a or "").strip().lower(); b = (b or "").strip().lower()
    if not a or not b:
        return False
    if a == b:
        return True
    if NICK.get(a, a) == NICK.get(b, b):
        return True
    if min(len(a), len(b)) >= 3 and (a.startswith(b) or b.startswith(a)):
        return True
    return _lev1(a, b)


def norm_last(s):
    return (s or "").strip().lower().replace(".", "").replace("'", "")


class UF:
    def __init__(self): self.p = {}
    def find(self, x):
        self.p.setdefault(x, x)
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]; x = self.p[x]
        return x
    def union(self, a, b):
        self.p[self.find(a)] = self.find(b)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--season", type=int, default=CURRENT_SEASON)
    args = ap.parse_args()
    season = args.season

    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT p.id, p.first_name, p.last_name, p.team_id, p.hometown, p.previous_school,
                   t.short_name AS team, d.level AS div
            FROM players p
            JOIN teams t ON p.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE COALESCE(p.is_phantom, false) = false
              AND p.first_name <> '' AND p.last_name <> ''
        """)
        players = {r["id"]: dict(r) for r in cur.fetchall()}

        # seasons-with-stats per player (batched)
        seasons = defaultdict(set)
        for tbl in ("batting_stats", "pitching_stats"):
            cur.execute(f"SELECT player_id, season FROM {tbl} WHERE player_id = ANY(%s)",
                        (list(players),))
            for r in cur.fetchall():
                seasons[r["player_id"]].add(r["season"])

        cur.execute("SELECT canonical_id, linked_id FROM player_links")
        existing = cur.fetchall()
        link_member = set()
        for r in existing:
            link_member.add(r["canonical_id"]); link_member.add(r["linked_id"])

    # group by surname, union equivalent first names
    by_last = defaultdict(list)
    for pid, p in players.items():
        by_last[norm_last(p["last_name"])].append(pid)

    components = []  # list of (last, [ids])
    for last, ids in by_last.items():
        if len(ids) < 2:
            continue
        uf = UF()
        for i in range(len(ids)):
            uf.find(ids[i])
            for j in range(i + 1, len(ids)):
                if first_equiv(players[ids[i]]["first_name"], players[ids[j]]["first_name"]):
                    uf.union(ids[i], ids[j])
        comp = defaultdict(list)
        for pid in ids:
            comp[uf.find(pid)].append(pid)
        for root, members in comp.items():
            if len(members) >= 2:
                components.append((last, members))

    # surname -> number of multi-member components (distinctiveness)
    comps_per_last = defaultdict(int)
    for last, _ in components:
        comps_per_last[last] += 1

    linkable, skipped = [], []
    for last, members in components:
        firsts = [players[m]["first_name"].strip().lower() for m in members]
        # clique check: every pair equivalent
        clique = all(first_equiv(firsts[i], firsts[j])
                     for i in range(len(firsts)) for j in range(i + 1, len(firsts)))
        if not clique:
            skipped.append((members, "not-a-clique (ambiguous name bridge)")); continue
        teams = {players[m]["team_id"] for m in members}
        if len(teams) < 2:
            continue
        # season overlap among any pair with stats -> different people
        overlap = False
        for i in range(len(members)):
            for j in range(i + 1, len(members)):
                if seasons[members[i]] & seasons[members[j]]:
                    overlap = True
        if overlap:
            skipped.append((members, "season overlap (likely 2 different people)")); continue
        all_seasons = set().union(*(seasons[m] for m in members)) if members else set()
        if not all_seasons:
            # No stats anywhere -> can't confirm a real player; also catches the
            # team-name junk rows ("Mt Hood", "Skagit Valley") that aren't people.
            skipped.append((members, "no stats (roster/team-name junk)")); continue
        if max(all_seasons) - min(all_seasons) > MAX_SPAN:
            skipped.append((members, f"span > {MAX_SPAN}yr")); continue
        # cross-cluster existing links -> needs manual merge, skip
        if any((players_linked_outside(m, members, existing)) for m in members):
            skipped.append((members, "linked to a record outside this cluster")); continue

        exact = len({f for f in firsts}) == 1
        corroborated = _corroborated(members, players)
        distinctive = comps_per_last[last] == 1
        if not (exact or distinctive or corroborated):
            skipped.append((members, "variant name + common surname, no corroboration")); continue

        # canonical pick
        def score(m):
            s = seasons[m]
            return (1 if season in s else 0, DIV_PRIORITY.get(players[m]["div"], 0),
                    max(s) if s else 0, len(s))
        canonical = max(members, key=score)
        reason = "exact" if exact else ("distinctive" if distinctive else "corroborated")
        linkable.append({"last": last, "canonical": canonical,
                         "members": members, "reason": reason})

    # ── report ──
    print(f"\n=== VERY-CLEAR clusters to link: {len(linkable)} "
          f"(skipped {len(skipped)} ambiguous) ===\n")
    for c in sorted(linkable, key=lambda x: x["last"]):
        cn = players[c["canonical"]]
        others = [m for m in c["members"] if m != c["canonical"]]
        def lbl(m):
            p = players[m]; s = seasons[m]
            yr = max(s) if s else "?"
            return f"{p['first_name']} {p['last_name']} ({p['team']} '{str(yr)[2:]})"
        print(f"  [{c['reason']:<11}] CANON {lbl(c['canonical'])}  <=  " +
              ", ".join(lbl(m) for m in others))

    from collections import Counter
    reasons = Counter(r for _, r in skipped)
    print("\n  skip reasons:")
    for r, n in reasons.most_common():
        print(f"    {n:>4}  {r}")

    if not args.apply:
        print(f"\n(dry run — re-run with --apply to write {sum(len(c['members'])-1 for c in linkable)} links)")
        return

    # ── apply ──
    written = 0
    with get_connection() as conn:
        cur = conn.cursor()
        for c in linkable:
            ids = c["members"]
            # rebuild this cluster's links: drop intra-cluster, insert canonical->others
            cur.execute(
                "DELETE FROM player_links WHERE canonical_id = ANY(%s) AND linked_id = ANY(%s)",
                (ids, ids),
            )
            for m in ids:
                if m == c["canonical"]:
                    continue
                cur.execute(
                    """INSERT INTO player_links (canonical_id, linked_id, match_type, confidence)
                       VALUES (%s, %s, 'clear', 0.95)
                       ON CONFLICT DO NOTHING""",
                    (c["canonical"], m),
                )
                written += 1
        conn.commit()
    print(f"\nApplied: wrote {written} links across {len(linkable)} clusters.")


def players_linked_outside(pid, cluster_ids, existing):
    s = set(cluster_ids)
    for r in existing:
        if r["canonical_id"] == pid and r["linked_id"] not in s:
            return True
        if r["linked_id"] == pid and r["canonical_id"] not in s:
            return True
    return False


def _corroborated(members, players):
    hts = [(_n(players[m].get("hometown"))) for m in members if players[m].get("hometown")]
    if len(hts) >= 2 and len(set(hts)) < len(hts):
        return True
    for m in members:
        ps = (players[m].get("previous_school") or "").lower()
        if not ps:
            continue
        for o in members:
            if o != m and players[o]["team"] and players[o]["team"].lower() in ps:
                return True
    return False


def _n(s):
    return (s or "").strip().lower()


if __name__ == "__main__":
    sys.exit(main())
