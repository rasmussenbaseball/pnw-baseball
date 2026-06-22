"""CLI: parse + report on Rapsodo session CSV(s). The parsing logic lives in
app.stats.rapsodo_parse (shared with the upload endpoint); this is just a
human-readable report for local testing.

Usage:
  PYTHONPATH=backend python3 scripts/rapsodo/parse.py <session.csv> [<session2.csv> ...]
  PYTHONPATH=backend python3 scripts/rapsodo/parse.py --json <session.csv>
"""
import argparse
import json
import sys
from collections import defaultdict

from app.stats.rapsodo_parse import parse_session


def _s(v):
    return "-" if v is None else f"{v:g}"


def print_report(s):
    print(f"\n{'='*72}")
    print(f"  {s['player_name']}  (Rapsodo ID {s['rapsodo_player_id']})")
    print(f"  {s['device_generation']} [{s['device_serial']}]   "
          f"session {s['session_date']}   file: {s['source_file'].split('/')[-1]}")
    print(f"{'='*72}")
    hand = {"R": "RHP", "L": "LHP"}.get(s["handedness"], "unknown")
    print(f"  Handedness : {hand}   ({s['handedness_basis']})")
    rng = s["velo_range"]
    print(f"  Velo range : {rng[0]}-{rng[1]} mph   |   fastball baseline ~{s['fastball_velo']} mph")
    if s["intent_tags"]:
        print(f"  Intent tags: {', '.join(s['intent_tags'])}")
    q = s["qc"]
    print(f"  Pitches    : {s['n_pitches']} total  |  ok {q.get('ok',0)}, "
          f"low-confidence {q.get('low_confidence',0)}, partial {q.get('partial',0)}, "
          f"failed {q.get('failed',0)}")
    basis = {p['movement_basis'] for p in s['pitches'] if p['movement_basis'] != 'none'}
    print(f"  Move basis : {', '.join(sorted(basis)) or 'none'} "
          f"({'spin = Magnus-only IVB/HB' if 'spin' in basis else 'trajectory = total observed break'})")

    print("\n  RE-CLASSIFIED ARSENAL  (Rapsodo's own labels ignored)")
    print(f"  {'pitch':<18}{'n':>3}{'velo':>7}{'max':>6}{'spin':>6}{'eff%':>6}"
          f"{'IVB':>6}{'armHB':>7}{'gyro':>6}  tilt")
    print(f"  {'-'*72}")
    for a in s["arsenal"]:
        print(f"  {a['pitch']:<18}{a['count']:>3}{_s(a['velo']):>7}{_s(a['velo_max']):>6}"
              f"{_s(a['total_spin']):>6}{_s(a['spin_eff']):>6}{_s(a['ivb']):>6}"
              f"{_s(a['arm_hb']):>7}{_s(a['gyro']):>6}  {a['tilt'] or '-'}")

    fixes = defaultdict(int)
    for p in s["pitches"]:
        if p["quality"] == "ok" and p["pitch"] and p["raw_label"]:
            raw, new = p["raw_label"].lower(), p["pitch"].lower()
            if raw in new or (raw == "changeup" and "change" in new):
                continue
            fixes[(p["raw_label"], p["pitch"])] += 1
    if fixes:
        print("\n  LABEL CORRECTIONS (Rapsodo said -> shape says):")
        for (raw, new), n in sorted(fixes.items(), key=lambda x: -x[1]):
            print(f"    {raw:<12} -> {new:<18} x{n}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv", nargs="+")
    ap.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    a = ap.parse_args()
    sessions = []
    for path in a.csv:
        try:
            sessions.append(parse_session(path))
        except Exception as e:  # noqa: BLE001
            print(f"ERROR parsing {path}: {e}", file=sys.stderr)
    if a.json:
        print(json.dumps(sessions, indent=2, default=str))
    else:
        for s in sessions:
            print_report(s)
        print()


if __name__ == "__main__":
    main()
