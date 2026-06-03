"""
Tight test: simulate the runner_sub state-machine logic in isolation
to confirm regex + name match + dict mutation all work as expected.
"""
import sys, re
sys.path.insert(0, "scripts")

from derive_event_state import RUNNER_SUB_RE, _norm_last, empty_bases


narrative = "Braydon Olson pinch ran for Sam Mieszkowski-Lapping."
print(f"narrative: {narrative!r}")

m = RUNNER_SUB_RE.match(narrative)
print(f"regex match: {m}")
if m:
    print(f"  group(1) (new): {m.group(1)!r}")
    print(f"  group(2) (old): {m.group(2)!r}")

bases = empty_bases()
bases[1] = "Sam Mieszkowski-Lapping"
bases[2] = "Jonah Chang"
print(f"\nbases before swap: {bases}")

old_name = "Sam Mieszkowski-Lapping"
new_name = "Braydon Olson"
old_last = _norm_last(old_name)
print(f"old_last: {old_last!r}")

for base_idx in (1, 2, 3):
    occupant = bases.get(base_idx)
    print(f"  base {base_idx}: occupant={occupant!r}  norm_last={_norm_last(occupant) if occupant else None!r}")
    if occupant and _norm_last(occupant) == old_last:
        print(f"  ** MATCH on base {base_idx}, swapping")
        bases[base_idx] = new_name
        break

print(f"\nbases after swap: {bases}")
