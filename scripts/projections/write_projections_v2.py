"""Write 2027 player projections using the v2 engine (v2_engine.py).

Reuses the roster logic (commitments, portal, returning-status overrides),
the depth-chart playing-time allocators, the incoming-class pool rows, WAR
and breakout flags from write_projections_db.py; only the talent engine and
the reconstruction change. No quantile mapping, no post-hoc stretching.

  PYTHONPATH=backend python3 scripts/projections/write_projections_v2.py [--season 2027] [--dry-run]
"""
import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO / "backend"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.models.database import get_connection  # noqa: E402
import v2_engine as E  # noqa: E402
import write_projections_db as W  # noqa: E402
import park  # noqa: E402

Z10 = 1.2816
INSUF_N = 20          # career events below this -> "insufficient" (capped playing time)
NO_DATA_BAT, NO_DATA_PIT = 10, 22
LUCK_M = 400          # ballast on a pitcher's ER-minus-FIP luck (per BF)


def _last(h):
    return h.sort_values("season").iloc[-1]


def build_rows(cur, TARGET):
    W.TARGET = TARGET
    bat, pit = E.load_spring(cur, min_n=1)
    sbat, spit = E.load_summer(cur)
    pbp_b, pbp_p = E.load_pbp(cur)
    C = E.fit_constants(bat, pit, sbat, spit, TARGET)
    workload = W.team_workload(cur)
    tname_map = W.team_name_map(cur)

    # ── who is where next season (same rules as v1) ──
    commits, left = {}, set()
    cur.execute("SELECT id, committed_to FROM players WHERE is_committed = 1")
    for r in cur.fetchall():
        left.add(r["id"])
        dest = W.resolve_commit(r["committed_to"], tname_map)
        if dest:
            commits[r["id"]] = dest
    tp_path = REPO / "backend" / "data" / "transfer_portal.json"
    if tp_path.exists():
        for e in json.loads(tp_path.read_text()).get("players", []):
            pid = e.get("player_id")
            if not pid:
                continue
            left.add(int(pid))
            dest = W.resolve_commit(e.get("committed_to"), tname_map)
            if dest:
                commits[int(pid)] = dest
    try:
        cur.execute("SELECT player_id FROM transfer_portal_members")
        for r in cur.fetchall():
            left.add(int(r["player_id"]))
    except Exception:
        pass
    cur.execute("SELECT player_id FROM player_returning_overrides WHERE season = %s AND status = 'departing'", (TARGET - 1,))
    for r in cur.fetchall():
        left.add(int(r["player_id"]))
    cur.execute("SELECT linked_id, canonical_id FROM player_links")
    cmap = {r["linked_id"]: r["canonical_id"] for r in cur.fetchall()}
    commits_canon = {cmap.get(pid, pid): dest for pid, dest in commits.items()}
    left_canon = {cmap.get(pid, pid) for pid in left}

    meta = {}
    for tbl, idc in [("batting_stats", "plate_appearances"), ("pitching_stats", "batters_faced")]:
        cur.execute(f"""
            SELECT COALESCE(c.canonical_id,b.player_id) cid, b.player_id raw,
                   p.first_name||' '||p.last_name name, p.position pos, p.bats,
                   b.team_id, ps.year_in_school cls26
            FROM {tbl} b JOIN players p ON p.id=b.player_id
            LEFT JOIN player_links c ON c.linked_id=b.player_id
            LEFT JOIN player_seasons ps ON ps.player_id=b.player_id AND ps.season=%s
            WHERE b.season=%s AND b.{idc}>=1
        """, (TARGET - 1, TARGET - 1))
        for r in cur.fetchall():
            meta.setdefault(r["cid"], dict(r))

    cur.execute("""
        WITH canon AS (SELECT linked_id pid, canonical_id cid FROM player_links)
        SELECT COALESCE(c.cid, gb.player_id) cid, gb.position pos, COUNT(*) n
        FROM game_batting gb JOIN games g ON g.id=gb.game_id
        LEFT JOIN canon c ON c.pid=gb.player_id
        WHERE g.season=%s AND gb.position IS NOT NULL AND gb.position <> ''
        GROUP BY 1, 2
    """, (TARGET - 1,))
    pos_counts, all_positions, pos_fracs = {}, {}, {}
    for r in cur.fetchall():
        for raw in (r["pos"] or "").upper().split("/"):
            pos = raw.strip()
            if pos in ("", "PH", "PR", "DR"):
                continue
            pos_counts.setdefault(r["cid"], {})
            pos_counts[r["cid"]][pos] = pos_counts[r["cid"]].get(pos, 0) + r["n"]
    for cid, agg in pos_counts.items():
        tot = sum(agg.values())
        keep = [p for p, n in sorted(agg.items(), key=lambda kv: kv[1], reverse=True) if n >= max(2, 0.15 * tot)]
        if keep:
            all_positions[cid] = "/".join(keep[:3])
        if tot:
            pos_fracs[cid] = {p: n / tot for p, n in agg.items()}

    # most-recent-season role (a two-way JUCO bat who became a D1 pitcher only pitches)
    bat_latest = bat.groupby("pid")["season"].max(); pit_latest = pit.groupby("pid")["season"].max()
    role = {}
    for pid in set(bat_latest.index) | set(pit_latest.index):
        bl = int(bat_latest.get(pid, -1)); pl = int(pit_latest.get(pid, -1))
        latest = max(bl, pl)
        role[pid] = {"bat": bl == latest and bl > 0, "pit": pl == latest and pl > 0}

    # per-level HR per fly ball (for the xFIP-style pitcher HR rate) and HBP/SF rates
    cur.execute("""
        SELECT d.level lvl, COUNT(*) FILTER (WHERE ge.bb_type='FB') fb,
               COUNT(*) FILTER (WHERE ge.result_type='home_run') hr
        FROM game_events ge JOIN games g ON g.id=ge.game_id
        JOIN players p ON p.id=ge.pitcher_player_id JOIN teams t ON t.id=p.team_id
        JOIN conferences c ON c.id=t.conference_id JOIN divisions d ON d.id=c.division_id
        WHERE g.season=%s GROUP BY 1
    """, (TARGET - 1,))
    hr_per_fb = {r["lvl"]: (r["hr"] / r["fb"]) for r in cur.fetchall() if r["fb"]}
    cur.execute("""SELECT d.level lvl,
          SUM(b.sacrifice_flies)::float/NULLIF(SUM(b.plate_appearances),0) sf,
          SUM(GREATEST(b.plate_appearances-b.at_bats-b.walks-b.hit_by_pitch-b.sacrifice_flies,0))::float/NULLIF(SUM(b.plate_appearances),0) sh
        FROM batting_stats b JOIN teams t ON t.id=b.team_id JOIN conferences c ON c.id=t.conference_id
        JOIN divisions d ON d.id=c.division_id WHERE b.season=%s GROUP BY 1""", (TARGET - 1,))
    sf_sh = {r["lvl"]: (float(r["sf"] or 0.02), float(r["sh"] or 0.01)) for r in cur.fetchall()}

    rows = []
    for side in ("bat", "pit"):
        S = C[side]
        tc, sc = S["train_c"], S["summer_c"]
        pbp = pbp_b if side == "bat" else pbp_p
        feats = E.PBP_BAT if side == "bat" else E.PBP_PIT
        refine = E.fit_refine(C, side, tc, pbp, TARGET)
        if refine:
            print(f"  [{side}] peripheral betas: " + ", ".join(f"{s}<-{f}={b:+.4f}(n={n})" for (s, f), (b, n) in refine.items()))
        # centered peripherals from the last season, raw values for display
        plast, praw = {}, {}
        if pbp is not None and not pbp.empty:
            pv = pbp[pbp["season"] == TARGET - 1].merge(tc[["pid", "season", "level"]].drop_duplicates(), on=["pid", "season"], how="inner")
            for f in feats:
                if f in pv.columns:
                    pv[f + "_c"] = pv[f] - pv.groupby("level")[f].transform("mean")
            for _, r in pv.iterrows():
                plast[r["pid"]] = {f: r.get(f + "_c") for f in feats}
                praw[r["pid"]] = {f: r.get(f) for f in feats}
            pprev = pbp[pbp["season"] == TARGET - 2]
            praw_prev = {r["pid"]: {f: r.get(f) for f in feats} for _, r in pprev.iterrows()}
        else:
            praw_prev = {}
        run_coef = E.fit_run_model(tc, S["means"]) if side == "pit" else None          # observed-scale (luck, last-season FIP)
        run_coef_t = (E.fit_run_model_talent(tc, S["means"], S.get("drift"), S["ballast"]) if E.DRIFT
                      else run_coef) if side == "pit" else None                            # talent-scale (projections)
        hist_by = {pid: g for pid, g in tc.groupby("pid")}
        sum_by = {pid: g for pid, g in sc.groupby("pid")} if sc is not None and not sc.empty else {}
        recent = tc[tc["season"].isin([TARGET - 1, TARGET - 2])]
        pids = recent.sort_values("season").drop_duplicates("pid", keep="last")["pid"].tolist()
        for pid in pids:
            h = hist_by.get(pid)
            if h is None or h.empty:
                continue
            last = _last(h)
            cur_level = last["level"]
            cls = last["cls"] if isinstance(last["cls"], str) else None
            m = meta.get(pid, {})
            if not role.get(pid, {}).get(side, True):
                continue
            if pid in commits_canon:
                team_id, level = commits_canon[pid]; incoming = True
            elif pid in left_canon:
                continue
            elif not W.departing(cur_level, cls):
                if not m:
                    continue
                team_id, level, incoming = m["team_id"], cur_level, False
            else:
                continue
            sh = sum_by.get(pid)
            pr = E.project(C, side, h, sh, plast.get(pid), level, TARGET, cls, dest_team_id=team_id, refine=refine)
            head = "woba" if side == "bat" else "er_rate"
            if pr.get(head, {}).get("value") is None:
                continue
            career_n = float(h["wt_n"].sum())
            insufficient = career_n < INSUF_N
            no_data = career_n < (NO_DATA_BAT if side == "bat" else NO_DATA_PIT)
            rel = pr[head]["rel"]
            # provisional playing time; the allocators decide the real number
            s = {int(r["season"]): r["wt_n"] for _, r in h.iterrows()}
            pt = 0.65 * s.get(TARGET - 1, 0) + 0.10 * s.get(TARGET - 2, 0) + 30
            if insufficient:
                pt = min(pt, 45 if side == "bat" else 50)
            line = {"reliability": round(rel, 3), "PT": round(pt), "level": level, "from_level": cur_level,
                    "incoming": incoming, "insufficient": insufficient, "no_data": no_data,
                    "class_2027": (E.CLASS_NEXT.get(cls) if cls else None), "_n": career_n, "engine": "v2"}
            comp = {k: v["value"] for k, v in pr.items() if v["value"] is not None}
            if side == "bat":
                bats = (m.get("bats") or "").upper()[:1] or None
                ap = (praw.get(pid) or {}).get("p_airpull")
                sf, shr = sf_sh.get(level, (0.02, 0.01))
                rc = E.reconstruct_bat(comp, sf_rate=sf, sh_rate=shr,
                                       park_hr=park.hr_mult(team_id, bats, ap if pd.notna(ap) else None),
                                       park_run=park.run_mult(team_id))
                sd_t = pr["woba"]["sd"]
                line.update({"AVG": round(rc["AVG"], 3), "OBP": round(rc["OBP"], 3), "SLG": round(rc["SLG"], 3),
                             "wOBA": round(rc["wOBA"], 3), "iso": round(rc["iso"], 4), "hr_pa": round(rc["hr_pa"], 4),
                             "k_pct": round(rc["k_pct"], 4), "bb_pct": round(rc["bb_pct"], 4), "babip": round(rc["babip"], 4),
                             "wobacon": round((rc["wOBA"] - E.WOBA_W["bb"] * rc["bb_pct"]) / max(1 - rc["k_pct"] - rc["bb_pct"], 0.3), 3),
                             "_rc": rc, "_sd": sd_t, "_w26": float(last["woba"]) if pd.notna(last["woba"]) else None,
                             "_bb26": float(last["babip"]) if pd.notna(last["babip"]) else None,
                             "park_hr_mult": round(park.hr_mult(team_id, bats, None), 3)})
                sort_val = rc["wOBA"]
            else:
                wl = workload.get(level) or {}
                ipbf = wl.get("ip_per_bf", 0.217)
                # xFIP-style HR rate when we have the pitcher's fly-ball rate
                p_fb = (praw.get(pid) or {}).get("p_fb")
                if p_fb is not None and pd.notna(p_fb) and level in hr_per_fb:
                    bip_frac = max(0.40, 1 - comp["k_pct"] - comp["bb_pct"] - 0.02)
                    comp["hr_bf"] = 0.6 * hr_per_fb[level] * p_fb * bip_frac + 0.4 * comp["hr_bf"]
                # ER-minus-FIP luck, shrunk hard (ballast LUCK_M per BF)
                hh = h.dropna(subset=["er_rate", "k_pct", "bb_pct", "hr_bf"])
                luck = 0.0
                if len(hh):
                    fip_h = run_coef[0] * hh["k_pct"] + run_coef[1] * hh["bb_pct"] + run_coef[2] * hh["hr_bf"] + run_coef[3]
                    n = float(hh["bf"].sum())
                    luck = float(np.average(hh["er_rate"] - fip_h, weights=hh["bf"])) * n / (n + LUCK_M)
                rc = E.reconstruct_pit(comp, run_coef_t, ipbf, park_run=park.run_mult(team_id),
                                       park_hr=park.pit_hr_mult(team_id), luck=luck)
                sd_t = pr["er_rate"]["sd"]
                line.update({"ERA": round(rc["ERA"], 2), "FIP": round(rc["FIP"], 2),
                             "K_pct": round(rc["K_pct"], 3), "BB_pct": round(rc["BB_pct"], 3), "HR_bf": round(rc["HR_bf"], 4),
                             "k_pct": round(rc["K_pct"], 4), "bb_pct": round(rc["BB_pct"], 4), "hr_bf": round(rc["HR_bf"], 4),
                             "babip_against": round(rc["babip_against"], 3), "er_rate": round(rc["er_rate"], 4),
                             "whip_rate": round(rc["whip_rate"], 4), "opp_avg": round(rc["opp_avg"], 3),
                             "WHIP": round(rc["whip_rate"] / ipbf, 2), "HR9": round(rc["HR_bf"] * 9 / ipbf, 2),
                             "fip_luck": round(luck / ipbf * 9, 2), "_rc": rc, "_sd": sd_t, "_ipbf": ipbf,
                             "_e26": float(last["er_rate"]) / ipbf * 9 if pd.notna(last["er_rate"]) else None,
                             "park_run_mult": round(park.run_mult(team_id), 3)})
                lk, lbb, lhr = last["k_pct"], last["bb_pct"], last["hr_bf"]
                line["_f26"] = ((run_coef[0] * lk + run_coef[1] * lbb + run_coef[2] * lhr + run_coef[3]) / ipbf * 9
                                if all(pd.notna(x) for x in (lk, lbb, lhr)) else None)
                sort_val = -rc["ERA"]
            for f in feats:
                v = (praw.get(pid) or {}).get(f)
                if v is not None and pd.notna(v):
                    line[f] = round(float(v), 3)
                    pv_ = (praw_prev.get(pid) or {}).get(f)
                    if pv_ is not None and pd.notna(pv_):
                        line[f + "_prev"] = round(float(pv_), 3)
            if side == "bat" and pos_fracs.get(pid):
                line["pos_share"] = {p: round(f, 3) for p, f in pos_fracs[pid].items() if f >= 0.05}
                line["pos_games"] = {p: int(n) for p, n in pos_counts.get(pid, {}).items()}
            rows.append({"season": TARGET, "team_id": int(team_id), "player_id": int(m.get("raw", pid)),
                         "canonical_id": int(pid), "side": side, "name": m.get("name", "?"),
                         "pos": all_positions.get(pid) or m.get("pos"), "class_last": cls, "is_incoming": incoming,
                         "from_team_id": int(m.get("team_id")) if m.get("team_id") else None,
                         "sort_val": round(float(sort_val), 5), "proj": line})
        print(f"  {side}: {sum(1 for r in rows if r['side'] == side)} players projected")
    return rows, workload, pos_fracs


def finalize(rows, workload):
    """After playing time is allocated: counting stats and outcome bands from
    the final PT, then drop the private scratch fields."""
    for r in rows:
        p = r["proj"]; rc = p.pop("_rc", None); sd = p.pop("_sd", 0.0) or 0.0
        if rc is None:
            continue
        pt = float(p.get("PT") or 0)
        if r["side"] == "bat":
            ab = pt * rc["ab_share"]
            hr = rc["hr_pa"] * pt
            ev = E.samp_var({"woba": rc["wOBA"]}, "woba")
            band = Z10 * E.SD_CAL["bat"] * math.sqrt(sd ** 2 + ev / max(pt, 20))
            p.update({"AB": round(ab), "H": round(rc["h_pa"] * pt), "HR": round(hr, 1),
                      "2B": round(rc["d2_pa"] * pt, 1), "3B": round(rc["d3_pa"] * pt, 1),
                      "R": round(pt * 0.16 * (rc["OBP"] / 0.360)), "RBI": round(pt * 0.15 * ((rc["AVG"] + rc["iso"]) / 0.420)),
                      "BB": round(rc["bb_pct"] * pt), "SO": round(rc["k_pct"] * pt),
                      "wOBA_lo": round(rc["wOBA"] - band, 3), "wOBA_hi": round(rc["wOBA"] + band, 3)})
        else:
            ipbf = p.pop("_ipbf", 0.217)
            ip = pt * ipbf
            ev = E.samp_var({"er_rate": rc["er_rate"]}, "er_rate")
            band = Z10 * E.SD_CAL["pit"] * math.sqrt(sd ** 2 + ev / max(pt, 30)) / ipbf * 9
            p.update({"BF": round(pt), "IP": round(ip, 1), "HR_allowed": round(rc["HR_bf"] * pt, 1),
                      "ERA_lo": round(max(rc["ERA"] - band, 0.0), 2), "ERA_hi": round(rc["ERA"] + band, 2)})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=2027)
    ap.add_argument("--dry-run", action="store_true", help="write CSVs, skip the DB")
    args = ap.parse_args()
    TARGET = args.season
    with get_connection() as conn:
        cur = conn.cursor()
        print("Fitting constants and projecting…")
        rows, workload, pos_fracs = build_rows(cur, TARGET)
        prior_ip = W.load_prior_workload(cur, TARGET - 1)
        prior_starts = W.load_prior_starts(cur, TARGET - 1)
        prior_pa = W.load_prior_pa(cur, TARGET - 1)
    qlev = W._level_quality(rows)
    pools_pa = W.allocate_hitter_pa(rows, workload, qlev, prior_pa)
    pools_ip = W.allocate_pitcher_ip(rows, workload, prior_ip, prior_starts, qlev)
    finalize(rows, workload)
    W.add_breakout(rows)
    W.add_war(rows, pos_fracs)
    W.add_incoming_no_data(rows, TARGET)
    W.add_pool_rows(rows, pools_pa, pools_ip)
    if W.UNRESOLVED_COMMITS:
        print(f"  unresolved commitment names (left region): {len(W.UNRESOLVED_COMMITS)}")

    out_dir = Path(__file__).resolve().parent
    flat = []
    for r in rows:
        flat.append({k: v for k, v in r.items() if k != "proj"} | {k: v for k, v in r["proj"].items() if not isinstance(v, dict)})
    pd.DataFrame(flat).to_csv(out_dir / f"player_projections_v2_{TARGET}.csv", index=False)
    if args.dry_run:
        print(f"Dry run: {len(rows)} rows -> player_projections_v2_{TARGET}.csv")
        return
    with get_connection() as conn:
        cur = conn.cursor()
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
    print(f"Wrote {len(rows)} projection rows for {TARGET} ({n_in} incoming) across {len(set(r['team_id'] for r in rows))} teams.")


if __name__ == "__main__":
    main()
