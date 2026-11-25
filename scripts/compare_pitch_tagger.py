#!/usr/bin/env python3
"""Dry run: what would the MLB-trained pitch tagger change in a TrackMan corpus?

Writes NOTHING. Prints what coaches see now (effective type) vs what they
would see with the new tagger (coach overrides still win), overall and per
pitcher, plus agreement with the coach's own corrections.

    PYTHONPATH=backend python3 scripts/compare_pitch_tagger.py [owner_uuid] [--apply]

--apply writes the new class_pitch_type (then re-runs mistag detection).
"""
import sys
from collections import Counter, defaultdict

from app.models.database import get_connection
from app.stats.trackman_classify import flag_mistags, model_tag_owner

DEFAULT_OWNER = "4d25e3ab-65c4-4a54-87f6-d6eebefde199"


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    owner = args[0] if args else DEFAULT_OWNER
    apply = "--apply" in sys.argv
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("""SELECT p.id, p.pitcher, p.override_pitch_type ovr, p.class_pitch_type cls,
                              p.tagged_pitch_type tag, p.auto_pitch_type auto, s.session_type
                       FROM tm_pitches p JOIN tm_sessions s ON s.id = p.session_id
                       WHERE p.owner_user_id = %s AND p.pitcher IS NOT NULL""", (owner,))
        rows = {r["id"]: dict(r) for r in cur.fetchall()}
        classified, n_changed, changes = model_tag_owner(cur, owner, dry_run=not apply)
        new_cls = {i: n for i, _, n in changes}
        if apply:
            flag_mistags(cur, owner)
            conn.commit()

    def eff(r, cls):
        return r["ovr"] or cls or r["tag"] or r["auto"]

    moved = Counter()
    per = defaultdict(lambda: [Counter(), Counter()])
    for i, r in rows.items():
        if r["session_type"] == "bp":
            continue
        before = eff(r, r["cls"])
        after = eff(r, new_cls.get(i, r["cls"]))
        per[r["pitcher"]][0][before] += 1
        per[r["pitcher"]][1][after] += 1
        if before != after:
            moved[(before, after)] += 1
    tot = sum(sum(v[0].values()) for v in per.values())
    print(f"model-labeled pitches: {classified:,}; class_pitch_type rows that change: {n_changed:,}"
          f"{' (WRITTEN)' if apply else ' (dry run)'}")
    print(f"non-BP pitches whose displayed type changes: {sum(moved.values()):,} of {tot:,}")
    for (b, a), k in moved.most_common(15):
        print(f"   {str(b):<10} -> {str(a):<10} {k}")
    corr = [r for r in rows.values() if r["ovr"]]
    if corr:
        ok = sum(1 for r in corr if new_cls.get(r["id"], r["cls"]) == r["ovr"])
        print(f"\ncoach corrections the new tagger reproduces on its own: {ok}/{len(corr)} ({100 * ok / len(corr):.0f}%)")
    print("\nper pitcher (50+ pitches), before -> after:")
    for p, (b, a) in sorted(per.items(), key=lambda kv: -sum(kv[1][0].values())):
        if sum(b.values()) < 50 or b == a:
            continue
        fmt = lambda c: ", ".join(f"{k} {v}" for k, v in c.most_common() if v >= 3)
        print(f"   {p:<24} {fmt(b)}\n   {'':<24} -> {fmt(a)}")


if __name__ == "__main__":
    main()
