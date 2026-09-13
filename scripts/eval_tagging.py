"""Score the pitch-type classifier against the coach's own corrections.

Every pitch a coach hand-fixes in the Pitcher Lab is a labelled example:
override_pitch_type is ground truth, tagged_pitch_type is what the TrackMan
operator called it live, and class_pitch_type is what we decided. This
prints the three numbers that matter before shipping a classifier change.

    PYTHONPATH=backend python3 scripts/eval_tagging.py [owner_uuid]

Read it as: agreement with the coach, how much of the ACHIEVABLE ceiling
that is (the ceiling is capped by how often the operator was right, since
the classifier's job is to follow him unless the shape clearly disagrees),
and how much of the operator's work we overwrite corpus-wide.
"""
import sys
from collections import Counter

from app.models.database import get_connection

DEFAULT_OWNER = "4d25e3ab-65c4-4a54-87f6-d6eebefde199"


def main(owner):
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("""SELECT override_pitch_type ovr, tagged_pitch_type tag,
                              class_pitch_type cls, pitcher
                       FROM tm_pitches
                       WHERE owner_user_id = %s AND override_pitch_type IS NOT NULL""", (owner,))
        rows = [dict(r) for r in cur.fetchall()]
        cur.execute("""SELECT COUNT(*) n,
                              COUNT(*) FILTER (WHERE class_pitch_type = tagged_pitch_type) kept
                       FROM tm_pitches p JOIN tm_sessions s ON s.id = p.session_id
                       WHERE p.owner_user_id = %s AND s.session_type <> 'bp'
                         AND tagged_pitch_type IS NOT NULL""", (owner,))
        corpus = dict(cur.fetchone())

    if not rows:
        print("No coach corrections on file yet — nothing to score against.")
        return
    n = len(rows)
    agree = sum(1 for r in rows if r["ovr"] == r["cls"])
    ceiling = sum(1 for r in rows if r["ovr"] == r["tag"])
    followed = sum(1 for r in rows if r["ovr"] != r["cls"] and r["cls"] == r["tag"])

    print(f"corrections scored            : {n}")
    print(f"we match the coach            : {agree} ({100 * agree / n:.0f}%)")
    print(f"ceiling (operator was right)  : {ceiling} ({100 * ceiling / n:.0f}%)")
    print(f"share of achievable ceiling   : {100 * agree / ceiling:.0f}%" if ceiling else "")
    print(f"misses that followed operator : {followed}  (coach overruled the operator, not our bug)")
    print(f"genuine classifier errors     : {n - agree - followed}")
    print()
    print(f"corpus: operator tags kept    : {corpus['kept']}/{corpus['n']} "
          f"({100 * corpus['kept'] / max(corpus['n'], 1):.1f}%)")
    print()
    print("top remaining disagreements:")
    for (o, c), k in Counter((r["ovr"], r["cls"]) for r in rows if r["ovr"] != r["cls"]).most_common(8):
        print(f"   coach {o:<10} vs ours {str(c):<10} {k}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_OWNER)
