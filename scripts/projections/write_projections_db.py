"""Compute 2027 player projections for the whole region and write them to the
`player_projections` table, assigned to each player's 2027 team.

Roster logic (so the projection page shows the RIGHT players on the RIGHT team):
  - Returning players -> their current team, projected at their current level.
  - Departing players DROPPED: 4-year Sr/Gr/5th, and JUCO sophomores (NWAC is a
    2-year level, so a So is leaving). Exception: if they're committed elsewhere
    they appear on the NEW team instead (grad transfers, JUCO-to-4yr).
  - Incoming transfers -> their destination team, projected at the DESTINATION
    level (so the level-translation factors apply). Sources: players.is_committed
    + committed_to (free-text school), and backend/data/transfer_portal.json.

Run from repo root:
  PYTHONPATH=backend python3 scripts/projections/write_projections_db.py [--season 2027]
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO / "backend"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.models.database import get_connection  # noqa: E402
from derive_constants import load_batting, load_pitching  # noqa: E402
from backtest import (  # noqa: E402
    BAT_COMPONENTS, PIT_COMPONENTS, PERIPH_FEATS, CLASS_NEXT, RECENCY,
    fit_training_constants, project_player, center_peripherals,
    load_pbp_peripherals, load_summer_batting,
)
from compute_player_projections import SIGMA, Z10, build_summer_lookup  # noqa: E402
from team_projection import (  # noqa: E402
    PA_A, PA_B, PA_C, BF_A, BF_B, BF_C, FIP_BLEND, HIT_PBP, PIT_PBP, YOUTH_NUDGE,
    WHIFF_FROM_K, fit_run_estimator, pbp_projection, career_xbh_mix, load_fip_luck,
)

FOURYR = {"D1", "D2", "D3", "NAIA"}

# ISO -> HR-rate (fit from data): lets weak-power hitters project toward ~0 HR
# instead of the league-average ~2 HR. ISO .05 -> ~0.2 HR/150; ISO .25 -> ~6.
ISO_HR_B0, ISO_HR_B1 = -0.00844, 0.2037

# Pitcher projections are too compressed toward the mean (backtest calibration
# slope 1.17); expanding the deviation from the level mean improves accuracy AND
# lets elite arms reach sub-3 / weak ones 7+. Hitters are well-calibrated (0.92).
PIT_EXPAND = 1.15


def band_half(rel, side):
    """Credible reliability-scaled half-width for the low/median/high range.
    Replaces the raw next-season outcome sigma, which made ERA bands ~4 runs
    wide (useless). Tighter for high-confidence players; capped so no band is
    absurd. Units: ERA runs for pitchers, wOBA points for hitters."""
    rel = max(0.0, min(1.0, rel or 0.0))
    # Reliability-scaled, NOT capped: confident players get tight ranges, and
    # nothing is artificially limited (a real outlier can range to extremes).
    if side == "pit":
        return round(0.40 + 1.60 * (1 - rel), 3)    # ERA half-width
    return round(0.028 + 0.075 * (1 - rel), 4)      # wOBA half-width


def departing(level, cls):
    """True if this player is leaving their current program after 2026."""
    if level == "JUCO":
        return cls in {"So", "Sr", "Sr+", "Gr", "5th"}   # JUCO is 2 years
    return cls in {"Sr", "Sr+", "Gr", "5th"}             # 4-year seniors graduate


def team_name_map(cur):
    """lower(name|short_name|school_name) -> (team_id, level)."""
    cur.execute("""
        SELECT t.id, t.name, t.short_name, t.school_name, d.level
        FROM teams t JOIN conferences c ON c.id=t.conference_id
        JOIN divisions d ON d.id=c.division_id WHERE COALESCE(t.is_active,1)=1
    """)
    m = {}
    for r in cur.fetchall():
        for nm in (r["short_name"], r["name"], r["school_name"]):
            if nm:
                m.setdefault(nm.strip().lower(), (r["id"], r["level"]))
    return m


def resolve_commit(name, tname_map):
    """Free-text committed_to -> (team_id, level) if it's a tracked PNW team."""
    if not name:
        return None
    key = name.strip().lower()
    if key in tname_map:
        return tname_map[key]
    # loose contains-match (e.g. "Oregon State" vs "Oregon St")
    for nm, val in tname_map.items():
        if key in nm or nm in key:
            return val
    return None


def proj_pt(hist, a, b, c):
    s = {int(r["season"]): r["wt_n"] for _, r in hist.iterrows()}
    return a * s.get(TARGET - 1, 0) + b * s.get(TARGET - 2, 0) + c


def main():
    global TARGET
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=2027)
    TARGET = ap.parse_args().season

    with get_connection() as conn:
        cur = conn.cursor()
        bat = load_batting(cur)
        pit = load_pitching(cur)
        summer = load_summer_batting(cur)
        bat_p = load_pbp_peripherals(cur, "bat")
        pit_p = load_pbp_peripherals(cur, "pit")
        run_coef = fit_run_estimator(pit)
        fip_luck = load_fip_luck(cur)
        tname_map = team_name_map(cur)

        # commitments: player_id -> destination (team_id, level).
        # `left` = anyone who has LEFT their 2026 team: committed elsewhere OR
        # entered the portal (even if not yet committed). They get removed from
        # the old roster; committed ones reappear on the new team.
        commits, left = {}, set()
        cur.execute("""SELECT id, committed_to FROM players WHERE is_committed = 1""")
        for r in cur.fetchall():
            left.add(r["id"])
            dest = resolve_commit(r["committed_to"], tname_map)
            if dest:
                commits[r["id"]] = dest
        tp_path = REPO / "backend" / "data" / "transfer_portal.json"
        if tp_path.exists():
            for e in json.loads(tp_path.read_text()).get("players", []):
                pid = e.get("player_id")
                if not pid:
                    continue
                left.add(int(pid))   # in the portal = gone from old team
                dest = resolve_commit(e.get("committed_to"), tname_map)
                if dest:
                    commits[int(pid)] = dest
        # canonical-id remap (history is keyed on canonical id)
        cur.execute("SELECT linked_id, canonical_id FROM player_links")
        cmap = {r["linked_id"]: r["canonical_id"] for r in cur.fetchall()}
        commits_canon = {cmap.get(pid, pid): dest for pid, dest in commits.items()}
        left_canon = {cmap.get(pid, pid) for pid in left}

        # roster meta: most-recent (2026) team + class + name per player
        meta = {}
        for tbl, idc in [("batting_stats", "plate_appearances"), ("pitching_stats", "batters_faced")]:
            cur.execute(f"""
                SELECT COALESCE(c.canonical_id,b.player_id) cid, b.player_id raw,
                       p.first_name||' '||p.last_name name, p.position pos,
                       b.team_id, ps.year_in_school cls26
                FROM {tbl} b JOIN players p ON p.id=b.player_id
                LEFT JOIN player_links c ON c.linked_id=b.player_id
                LEFT JOIN player_seasons ps ON ps.player_id=b.player_id AND ps.season=2026
                WHERE b.season=2026 AND b.{idc}>=20
            """)
            for r in cur.fetchall():
                meta.setdefault(r["cid"], r)   # first side wins for name/pos; fine

        # --- usage-based role detection (smart role logic) ---
        # A player's role is decided by their MOST RECENT season's actual usage,
        # not a static position label. If a two-way player's latest season is all
        # pitching (e.g. a JUCO 1B/OF who became a D1 pitcher), we drop the stale
        # hitting projection -- and vice versa. True current two-ways get both.
        # per-level league mean ER/BF (most recent season) = expansion center
        lvl_mean_er = {}
        for lv, g in pit[pit["season"] == TARGET - 1].groupby("level"):
            v = g["era_rate"].dropna()
            if len(v):
                lvl_mean_er[lv] = float(np.average(v, weights=g.loc[v.index, "wt_n"]))
        bat_latest = bat.groupby("pid")["season"].max()
        pit_latest = pit.groupby("pid")["season"].max()
        role = {}
        for pid in set(bat_latest.index) | set(pit_latest.index):
            bl = int(bat_latest.get(pid, -1)); pl = int(pit_latest.get(pid, -1))
            latest = max(bl, pl)
            role[pid] = {"bat": bl == latest and bl > 0, "pit": pl == latest and pl > 0}

        rows = []
        for side in ("bat", "pit"):
            df = bat if side == "bat" else pit
            periph = bat_p if side == "bat" else pit_p
            comps = BAT_COMPONENTS if side == "bat" else PIT_COMPONENTS
            pa_args = (PA_A, PA_B, PA_C) if side == "bat" else (BF_A, BF_B, BF_C)
            pbp_feats = HIT_PBP if side == "bat" else PIT_PBP
            headline = "woba" if side == "bat" else "era_rate"
            df_feat = df.merge(periph, on=["pid", "season"], how="left")
            df_feat["p_n"] = df_feat["p_n"].fillna(0)
            df_feat = center_peripherals(df_feat, PERIPH_FEATS[side])
            C = fit_training_constants(df_feat, comps, TARGET)
            hist_all = C["train"].sort_values("wt_n", ascending=False).drop_duplicates(["pid", "season"])
            summer_lookup = build_summer_lookup(summer, TARGET) if side == "bat" else {}
            a_sig, b_sig = SIGMA[side]

            # who do we project on this side? everyone with a recent qualified season
            recent = hist_all[hist_all["season"].isin([TARGET - 1, TARGET - 2])]
            pids = recent.sort_values("season").drop_duplicates("pid", keep="last")["pid"].tolist()

            # class map + whiff anchors for pitchers
            clsmap = {}
            for pid in pids:
                h = hist_all[(hist_all["pid"] == pid) & (hist_all["season"] < TARGET)]
                if not h.empty:
                    clsmap[pid] = h.sort_values("season").iloc[-1]["cls"] or "Sr"
            anchors = {}
            if side == "pit":
                a0, a1 = WHIFF_FROM_K
                for pid in pids:
                    hk = hist_all[(hist_all["pid"] == pid) & (hist_all["season"] < TARGET)].dropna(subset=["k_pct"])
                    if not hk.empty:
                        anchors[pid] = {"p_whiff": a0 + a1 * np.average(hk["k_pct"], weights=hk["wt_n"])}
            pbp_proj = pbp_projection(periph, pbp_feats, clsmap, anchors)

            for pid in pids:
                h = hist_all[(hist_all["pid"] == pid) & (hist_all["season"] < TARGET)]
                if h.empty:
                    continue
                last = h.sort_values("season").iloc[-1]
                cur_level, cls = last["level"], last["cls"]
                cls = cls if isinstance(cls, str) else None   # NaN -> None (JSON-safe)
                m = meta.get(pid, {})
                # smart role gate: only project the side the player still plays,
                # judged by their most recent season's usage (drops stale roles
                # for players who consolidated to one role at the next level).
                if not role.get(pid, {}).get(side, True):
                    continue
                # decide 2027 team + level
                if pid in commits_canon:
                    team_id, level = commits_canon[pid]
                    incoming = True
                elif pid in left_canon:
                    continue   # left the program (portal/committed) - no known destination
                elif not departing(cur_level, cls):
                    if not m:
                        continue
                    team_id, level, incoming = m["team_id"], cur_level, False
                else:
                    continue   # graduating, no destination
                proj = project_player(h, summer_lookup.get(pid, []), C, comps, level, TARGET, cls)
                if headline not in proj:
                    continue
                head, rel = proj[headline]
                pt = proj_pt(h, *pa_args)
                line = {"reliability": round(rel, 3), "PT": round(pt), "level": level,
                        "from_level": cur_level, "incoming": incoming,
                        "class_2027": (CLASS_NEXT.get(cls) if cls else None)}
                for s in comps:
                    if s in proj:
                        line[s] = round(proj[s][0], 4)
                if side == "bat":
                    bb, k, hr_pa, avg, iso = (proj.get(s, (0, 0))[0] for s in ["bb_pct", "k_pct", "hr_pa", "avg", "iso"])
                    ab = pt * (1 - bb - 0.02)
                    # HR anchored to ISO-implied rate (blended) so weak-power
                    # hitters project toward ~0 HR instead of league average.
                    iso_hr = max(0.0, ISO_HR_B0 + ISO_HR_B1 * iso)
                    # HR from demonstrated HR-rate (the best, most stable HR
                    # predictor: r=.61) PLUS an ISO power-floor. Favoring hr_pa
                    # lets true mashers project big totals while weak-power
                    # hitters (low hr_pa AND low ISO) still project near zero.
                    hr_pa_eff = 0.6 * hr_pa + 0.4 * iso_hr
                    hr = hr_pa_eff * pt
                    s2, s3, _ = career_xbh_mix(bat, pid)
                    rem = max(iso * ab - 3 * hr, 0)
                    tot = s2 + s3 if (s2 + s3) > 0 else 1
                    d3 = rem * (s3 / tot) / (1 + s3 / tot)
                    hw = band_half(rel, "bat")
                    line.update({"AB": round(ab), "H": round(avg * ab), "HR": round(hr, 1),
                                 "2B": round(max(rem - 2 * d3, 0), 1), "3B": round(max(d3, 0), 1),
                                 "R": round(pt * 0.16 * (proj.get("obp", (0.33, 0))[0] / 0.360)),
                                 "RBI": round(pt * 0.15 * ((avg + iso) / 0.420)),
                                 "BB": round(bb * pt), "SO": round(k * pt),
                                 "AVG": round(avg, 3), "OBP": round(proj.get("obp", (0, 0))[0], 3),
                                 "SLG": round(avg + iso, 3), "wOBA": round(head, 3),
                                 "wOBA_lo": round(head - hw, 3), "wOBA_hi": round(head + hw, 3)})
                    sort_val = head
                else:
                    k, bb, hrb = (proj.get(s, (0, 0))[0] for s in ["k_pct", "bb_pct", "hr_bf"])
                    fip_rate = run_coef[0]*k + run_coef[1]*bb + run_coef[2]*hrb + run_coef[3]
                    er_bf = FIP_BLEND * fip_rate + (1 - FIP_BLEND) * head
                    # de-compress: pitcher projections are statistically too
                    # squashed toward the mean (calibration slope 1.17 in
                    # backtest -- expanding improves RMSE). Expand the deviation
                    # from the level mean so elite arms reach sub-3 and weak ones
                    # 7+, instead of everyone bunched at ~5.
                    lg_er = lvl_mean_er.get(level, er_bf)
                    er = (lg_er + PIT_EXPAND * (er_bf - lg_er)) * 39.6   # ERA scale
                    fip_rate = lg_er + PIT_EXPAND * (fip_rate - lg_er)
                    hw = band_half(rel, "pit")
                    ip = pt * 0.245                      # ~74% of BF are outs
                    whip_rate = proj.get("whip_rate", (None, 0))[0]   # baserunners/BF
                    whip = round(whip_rate / 0.245, 2) if whip_rate else None
                    line.update({"BF": round(pt), "IP": round(ip, 1),
                                 "ERA": round(er, 2), "FIP": round(fip_rate * 39.6, 2),
                                 "WHIP": whip, "HR_allowed": round(hrb * pt, 1),
                                 "K_pct": round(k, 3), "BB_pct": round(bb, 3), "HR_bf": round(hrb, 4),
                                 "ERA_lo": round(er - hw, 2), "ERA_hi": round(er + hw, 2),
                                 "fip_luck": (round(fip_luck.get(pid), 2) if fip_luck.get(pid) is not None else None)})
                    sort_val = -er   # lower ERA = better, so negate for desc sort
                for f in pbp_feats:
                    pv = pbp_proj.get(pid, {}).get(f)
                    if pv:
                        line[f] = round(pv[0], 3)
                        if pv[1] is not None:
                            line[f + "_prev"] = round(pv[1], 3)
                rows.append({"season": TARGET, "team_id": team_id, "player_id": int(m.get("raw", pid)),
                             "canonical_id": int(pid), "side": side, "name": m.get("name", "?"),
                             "pos": m.get("pos"), "class_last": cls, "is_incoming": incoming,
                             "from_team_id": int(m.get("team_id")) if m.get("team_id") else None,
                             "sort_val": round(float(sort_val), 5), "proj": line})

    # write to DB
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("""
            CREATE TABLE IF NOT EXISTS player_projections (
                season int NOT NULL, team_id int NOT NULL, player_id int NOT NULL,
                canonical_id int, side text NOT NULL, name text, pos text,
                class_last text, is_incoming boolean, from_team_id int,
                sort_val double precision, proj jsonb,
                PRIMARY KEY (season, team_id, player_id, side)
            )
        """)
        cur.execute("DELETE FROM player_projections WHERE season = %s", (TARGET,))
        for r in rows:
            cur.execute("""
                INSERT INTO player_projections
                  (season, team_id, player_id, canonical_id, side, name, pos,
                   class_last, is_incoming, from_team_id, sort_val, proj)
                VALUES (%(season)s,%(team_id)s,%(player_id)s,%(canonical_id)s,%(side)s,
                        %(name)s,%(pos)s,%(class_last)s,%(is_incoming)s,%(from_team_id)s,
                        %(sort_val)s,%(proj)s)
                ON CONFLICT (season, team_id, player_id, side) DO UPDATE SET
                  proj=EXCLUDED.proj, sort_val=EXCLUDED.sort_val, is_incoming=EXCLUDED.is_incoming,
                  name=EXCLUDED.name, pos=EXCLUDED.pos, class_last=EXCLUDED.class_last
            """, {**r, "proj": json.dumps(r["proj"])})
        conn.commit()
    n_in = sum(1 for r in rows if r["is_incoming"])
    print(f"Wrote {len(rows)} projection rows for {TARGET} ({n_in} incoming transfers) "
          f"across {len(set(r['team_id'] for r in rows))} teams.")


if __name__ == "__main__":
    main()
