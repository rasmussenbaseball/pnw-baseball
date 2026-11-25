"""MLB-trained, pitcher-first pitch tagger (v5). numpy only.

SOURCE OF TRUTH is the lab repo ~/code/pitch-tagging-lab (pitchtag/prod3.py +
cluster.py + prod5.py, verified against the training pipeline). This file is
those three concatenated, plus get_tagger(). Model file:
backend/data/pitch_tagger.npz (lab export_v5.py).

Per pitcher (rows put in a canonical order first, so the answer never depends
on database row order):
 1. session velocity normalization;
 2. cut his pitches into small pure pieces (~8 pitches; k-means, velo / movement / spin);
 3. glue pieces while the learned "same pitch?" model says so (P > 0.15) (trained on MLB
    pitchers made college-sized, college-noisy and drifting, rare pitches
    included);
 4. name each final pitch with 5 bagged arsenal namers (shape + usage + the
    rest of his arsenal; MLBAM's pitch types). No human input.
"""

import json
import warnings

import numpy as np

CLASSES = ["Fastball", "Sinker", "Cutter", "Slider", "Sweeper", "Curveball", "ChangeUp", "Splitter"]
JND = (2.0, 3.0, 3.0, 300.0)       # velo, ivb, hb, spin  (per-pitch arsenal context units)
BIG = 25.0

# one-vs-two set model
SET_DIMS = ["velo", "ivb", "hb", "axis", "spin"]
SET_SCALE = np.array([1.0, 2.2, 2.2, 7.0, 90.0])
SET_EXTRA = ["rel_z", "rel_x", "ext"]
SET_USAGE = ["same_side", "aim_z", "aim_x", "two_k", "first"]
NEIGH = {frozenset(p) for p in [("Fastball", "Sinker"), ("Fastball", "Cutter"), ("Sinker", "ChangeUp"),
                                ("Cutter", "Slider"), ("Slider", "Sweeper"), ("Slider", "Curveball"),
                                ("Sweeper", "Curveball"), ("ChangeUp", "Splitter"), ("Sinker", "Splitter"),
                                ("Cutter", "Sweeper")]}

# group namer
G_MED = ["ivb", "hb", "mov", "mov_dir", "axis_sin", "axis_cos", "bauer", "arm_angle", "rel_z", "rel_x", "ext",
         "dv", "dv_pct", "divb", "dhb", "dspin", "daxis", "dmov_dir", "dmov", "drel_z", "drel_x", "dext",
         "along", "perp", "ref_ivb", "ref_hb", "ref_axis", "ref_bauer", "fb_ivb_iqr", "fb_hb_iqr"]
G_SPREAD = ["ivb", "hb", "dv", "daxis", "along", "perp", "bauer"]
G_USAGE = ["u_same", "u_2k", "u_first", "u_ahead", "u_behind", "u_locz", "u_locx", "u_n_ctx"]
CTX_NUM = 3


def _nanmedian(a, axis=None):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        return np.nanmedian(a, axis=axis)


def _nanmean(a):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        return np.nanmean(a)


def _nanq(a, q):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        return np.nanquantile(a, q) if np.isfinite(a).any() else np.nan


class ArsenalTagger:
    def __init__(self, npz_path):
        z = np.load(npz_path, allow_pickle=False)
        self.a = {k: z[k] for k in z.files}
        meta = json.loads(str(self.a.pop("meta_json")))
        self.meta = meta
        self.features = meta["features"]
        self.s2_cols = meta["stage2_columns"]
        self.arm = meta["arm_angle"]
        self.order1 = [meta["stage1_classes"].index(c) for c in CLASSES]
        self.order2 = [meta["stage2_classes"].index(c) for c in CLASSES]
        self.set_feats = meta["set_features"]
        self.set_pos = meta["set_classes"].index(1)
        self.F1, self.F2 = meta["namer_F1"], meta["namer_F2"]
        self.on1 = [meta["namer1_classes"].index(c) for c in CLASSES]
        self.on2 = [meta["namer2_classes"].index(c) for c in CLASSES]

    # ── tree evaluation ──────────────────────────────────────────────
    def _raw(self, p, X, chunk=3000):
        a = self.a
        feat, thr, mleft = a[p + "feat"], a[p + "thr"], a[p + "mleft"]
        left, right, leaf, value = a[p + "left"], a[p + "right"], a[p + "leaf"], a[p + "value"]
        roots, base = a[p + "roots"], a[p + "base"]
        K = int(a[p + "nclass"][0])
        T = len(roots)
        tree_cls = (np.arange(T) % K).astype(np.int32)
        out = np.zeros((len(X), K))
        nf = X.shape[1]
        for s in range(0, len(X), chunk):
            Xc = np.ascontiguousarray(X[s:s + chunk], dtype=np.float64)
            n = len(Xc)
            flat = Xc.ravel()
            row = np.repeat(np.arange(n, dtype=np.int32), T)
            node = np.tile(roots.astype(np.int32), n)
            cls = np.tile(tree_cls, n)
            sc = np.zeros(n * K)
            while len(node):
                done = leaf[node]
                if done.any():
                    sc += np.bincount(row[done].astype(np.int64) * K + cls[done], weights=value[node[done]], minlength=n * K)
                    keep = ~done
                    row, node, cls = row[keep], node[keep], cls[keep]
                    if not len(node):
                        break
                x = flat[row.astype(np.int64) * nf + feat[node]]
                go_left = np.where(np.isnan(x), mleft[node], x <= thr[node])
                node = np.where(go_left, left[node], right[node])
            out[s:s + chunk] = sc.reshape(n, K) + base
        return out

    @staticmethod
    def _softmax(z):
        z = z - z.max(1, keepdims=True)
        e = np.exp(z)
        return e / e.sum(1, keepdims=True)

    def _multi(self, prefix, X, order):
        return self._softmax(self._raw(prefix, X))[:, order]

    def _p_one(self, feats):
        X = np.array([[feats.get(k, np.nan) for k in self.set_feats]], dtype=np.float64)
        raw = self._raw("set_", X)[0, 0]
        p1 = 1.0 / (1.0 + np.exp(-raw))
        return p1 if self.set_pos == 1 else 1 - p1

    # ── public entry point ───────────────────────────────────────────
    def tag(self, velo, spin, axis, ivb, hb, rel_z, rel_x, ext, lefty, pitcher, session=None,
            batter_side=None, loc_height=None, loc_side=None, balls=None, strikes=None, per_pitch_only=False):
        """Shape inputs in TrackMan units/signs (RelSpeed, SpinRate, SpinAxis,
        InducedVertBreak, HorzBreak, RelHeight, RelSide, Extension). lefty: bool.
        pitcher: per-pitch pitcher key. session: per-pitch session key.
        Usage (optional, None/NaN where unknown, e.g. bullpens): batter_side
        ('Left'/'Right'), PlateLocHeight, PlateLocSide, Balls, Strikes.
        Returns (labels, info) with info = {"group": pitch-group id per pitch,
        "p_pitch": per-pitch model probabilities}."""
        f = lambda v: np.asarray(v, dtype=np.float64)
        n = len(np.asarray(velo))
        nanv = lambda v: np.full(n, np.nan) if v is None else np.array([np.nan if x is None else float(x) for x in v])
        lefty = np.asarray(lefty, dtype=bool)
        arm = np.where(lefty, -1.0, 1.0)
        c = {"velo": f(velo), "spin": f(spin), "axis": np.where(lefty, 360 - f(axis), f(axis)),
             "ivb": f(ivb), "hb": f(hb) * arm, "rel_z": f(rel_z), "rel_x": f(rel_x) * arm, "ext": f(ext)}
        pkeys = np.asarray(pitcher).astype(str)
        pk = np.unique(pkeys, return_inverse=True)[1]
        if session is not None:
            sess = np.asarray(session).astype(str)
            sk = np.unique(np.char.add(np.char.add(pkeys, "|"), sess), return_inverse=True)[1]
            self._session_normalize(c, pk, sk)
        else:
            sess = np.full(n, "0")
        ref = self._reference(c, pk)
        X = self._features(c, ref)
        X1 = np.column_stack([X[k] for k in self.features])
        P1 = self._multi("s1_", X1, self.order1)
        C = self._context(P1, c, pk)
        X2 = np.column_stack([X[k] if k in X else C[k] for k in self.s2_cols])
        P2 = self._multi("s2_", X2, self.order2)
        P2 = self._smooth(P2, np.column_stack([c["velo"], c["ivb"], c["hb"], c["spin"]]), pk)
        if per_pitch_only:
            return np.array(CLASSES)[P2.argmax(1)], {"group": None, "p_pitch": P2}

        # usage
        if batter_side is None:
            same = np.full(n, np.nan)
        else:
            bs = np.array([(str(b)[:1].upper() if b else "") for b in batter_side])
            same = np.where(np.isin(bs, ["L", "R"]), (bs == np.where(lefty, "L", "R")).astype(float), np.nan)
        nobat = np.isnan(same)
        loc_z = nanv(loc_height)
        loc_x = nanv(loc_side) * np.where(lefty, -1.0, 1.0)     # TrackMan +side = 3B; arm side positive
        b_ = nanv(balls)
        s_ = nanv(strikes)
        b_[nobat] = np.nan
        s_[nobat] = np.nan
        two_k = np.where(np.isnan(s_), np.nan, (s_ == 2).astype(float))

        # raw (non float32-rounded) relative features for the set model, as in training
        Xr = self._features(c, ref, cast=False)
        SF = {k: c[k] for k in ["velo", "ivb", "hb", "axis", "spin", "rel_z", "rel_x", "ext"]}
        for k in ["arm_angle", "dv", "dspin", "daxis", "ref_ivb", "ref_hb"]:
            SF[k] = Xr[k]
        SF.update(same_side=same, loc_z=loc_z, loc_x=loc_x, two_k=two_k, balls=b_, strikes=s_)
        GF = {k: Xr[k].astype(np.float32).astype(np.float64) for k in G_MED_SRC}
        GF.update(same_side=same, balls=b_, strikes=s_, loc_z=loc_z, loc_x=loc_x)

        labels = np.empty(n, dtype=object)
        groups = np.empty(n, dtype=object)
        for g in range(pk.max() + 1):
            ix = np.where(pk == g)[0]
            sf = {k: v[ix] for k, v in SF.items()}
            gf = {k: v[ix] for k, v in GF.items()}
            gid = self._partition(sf, P2[ix], sess[ix])
            labels[ix] = self._name_groups(gf, gid, P2[ix])
            groups[ix] = [f"{pkeys[ix[0]]}#{k}" for k in gid]
        return labels, {"group": groups, "p_pitch": P2}

    # ── per-pitch model pieces ───────────────────────────────────────
    @staticmethod
    def _smooth(P, shape, pk, frac=0.02, k_max=10):
        Z = np.nan_to_num(shape / np.array(JND))
        out = P.copy()
        for gi in range(pk.max() + 1):
            ix = np.where(pk == gi)[0]
            kk = int(np.clip(round(frac * len(ix)), 1, k_max))
            if len(ix) < 4 or kk <= 1:
                continue
            kk = min(kk, len(ix))
            Zi = Z[ix]
            for s in range(0, len(ix), 1500):
                d = ((Zi[s:s + 1500, None, :] - Zi[None, :, :]) ** 2).sum(-1)
                nb = np.argpartition(d, kk - 1, axis=1)[:, :kk]
                out[ix[s:s + 1500]] = P[ix][nb].mean(1)
        return out

    @staticmethod
    def _groups(k):
        order = np.argsort(k, kind="stable")
        bounds = np.searchsorted(k[order], np.arange(k.max() + 2))
        return [order[bounds[i]:bounds[i + 1]] for i in range(k.max() + 1)]

    def _session_normalize(self, c, pk, sk, shrink_n=5.0, cap=8.0):
        fb_like = (c["hb"] >= -2.0) & (c["axis"] >= 120) & (c["axis"] <= 300)

        def fb_velo(k):
            med = np.full(k.max() + 1, np.nan)
            n = np.zeros(k.max() + 1)
            for g, ix in enumerate(self._groups(k)):
                if not len(ix):
                    continue
                v = c["velo"][ix]
                v95 = np.quantile(v, 0.95)
                cand = fb_like[ix] & (v >= v95 - 3.0)
                n[g] = cand.sum()
                if cand.any():
                    med[g] = np.median(v[cand])
            return med[k], n[k]

        p_v, _ = fb_velo(pk)
        s_v, s_n = fb_velo(sk)
        delta = (p_v - s_v) * (s_n / (s_n + shrink_n))
        delta = np.where((s_n >= 3) & ~np.isnan(delta), delta, 0.0)
        delta = np.clip(delta, -cap, cap)
        ratio = (c["velo"] + delta) / c["velo"]
        c["velo"] = c["velo"] + delta
        c["spin"] = c["spin"] * ratio

    def _reference(self, c, pk, min_n=3):
        cols = ["velo", "spin", "axis", "ivb", "hb", "rel_z", "rel_x", "ext"]
        G = pk.max() + 1
        ref = {f"ref_{x}": np.full(G, np.nan) for x in cols}
        for x in ("fb_ivb_iqr", "fb_hb_iqr", "v_max"):
            ref[x] = np.full(G, np.nan)
        for g, ix in enumerate(self._groups(pk)):
            if not len(ix):
                continue
            v = c["velo"][ix]
            v95, v75 = np.quantile(v, 0.95), np.quantile(v, 0.75)
            cand = (v >= v95 - 4.0) & (c["hb"][ix] >= -2.0) & (c["axis"][ix] >= 120) & (c["axis"][ix] <= 300)
            if cand.sum() < min_n:
                cand = v >= v75
            sub = ix[cand]
            for x in cols:
                ref[f"ref_{x}"][g] = np.median(c[x][sub])
            ref["fb_ivb_iqr"][g] = np.quantile(c["ivb"][sub], .75) - np.quantile(c["ivb"][sub], .25)
            ref["fb_hb_iqr"][g] = np.quantile(c["hb"][sub], .75) - np.quantile(c["hb"][sub], .25)
            ref["v_max"][g] = v95
        return {k: v[pk] for k, v in ref.items()}

    def _arm_angle(self, rel_z, rel_x, ext):
        k = self.arm
        x = np.maximum(rel_x, 0.05)
        a40 = np.degrees(np.arctan2(rel_z - 4.0, x))
        a45 = np.degrees(np.arctan2(rel_z - 4.5, x))
        return k["b0"] + k["z"] * rel_z + k["x"] * rel_x + k["e"] * ext + k["ang40"] * a40 + k["ang45"] * a45 + k["zx"] * rel_z * rel_x

    @staticmethod
    def _wrap(a):
        return (a + 180.0) % 360.0 - 180.0

    def _features(self, c, r, cast=True):
        X = {}
        X["velo"], X["spin"], X["v_max"] = c["velo"], c["spin"], r["v_max"]
        X["ivb"], X["hb"] = c["ivb"], c["hb"]
        X["mov"] = np.hypot(c["ivb"], c["hb"])
        X["mov_dir"] = np.degrees(np.arctan2(c["ivb"], c["hb"]))
        a = np.radians(c["axis"])
        X["axis_sin"], X["axis_cos"] = np.sin(a), np.cos(a)
        X["bauer"] = c["spin"] / c["velo"]
        X["arm_angle"] = self._arm_angle(c["rel_z"], c["rel_x"], c["ext"])
        X["rel_z"], X["rel_x"], X["ext"] = c["rel_z"], c["rel_x"], c["ext"]
        X["dv"] = c["velo"] - r["ref_velo"]
        X["dv_pct"] = c["velo"] / r["ref_velo"]
        X["divb"] = c["ivb"] - r["ref_ivb"]
        X["dhb"] = c["hb"] - r["ref_hb"]
        X["dspin"] = c["spin"] / r["ref_spin"]
        X["daxis"] = self._wrap(c["axis"] - r["ref_axis"])
        ref_dir = np.degrees(np.arctan2(r["ref_ivb"], r["ref_hb"]))
        X["dmov_dir"] = self._wrap(X["mov_dir"] - ref_dir)
        X["dmov"] = X["mov"] - np.hypot(r["ref_ivb"], r["ref_hb"])
        X["drel_z"] = c["rel_z"] - r["ref_rel_z"]
        X["drel_x"] = c["rel_x"] - r["ref_rel_x"]
        X["dext"] = c["ext"] - r["ref_ext"]
        X["ref_ivb"], X["ref_hb"], X["ref_axis"] = r["ref_ivb"], r["ref_hb"], r["ref_axis"]
        X["ref_bauer"] = r["ref_spin"] / r["ref_velo"]
        X["fb_ivb_iqr"], X["fb_hb_iqr"] = r["fb_ivb_iqr"], r["fb_hb_iqr"]
        th = np.radians(ref_dir)
        X["along"] = c["hb"] * np.cos(th) + c["ivb"] * np.sin(th)
        X["perp"] = c["hb"] * np.sin(th) - c["ivb"] * np.cos(th)
        if not cast:
            return {k: np.asarray(v, dtype=np.float64) for k, v in X.items()}
        return {k: np.asarray(v, dtype=np.float32).astype(np.float64) for k, v in X.items()}

    @staticmethod
    def _context(P, c, pk):
        G = pk.max() + 1
        S = np.column_stack([np.nan_to_num(c[x] / j, nan=0.0) for x, j in zip(("velo", "ivb", "hb", "spin"), JND)])
        cnt = np.bincount(pk, minlength=G).astype(float)
        out = {}
        for k, name in enumerate(CLASSES):
            w = P[:, k]
            wsum = np.bincount(pk, weights=w, minlength=G)
            share = wsum / np.maximum(cnt, 1)
            cen = np.column_stack([np.bincount(pk, weights=w * S[:, j], minlength=G) for j in range(4)])
            cen = cen / np.maximum(wsum, 1e-9)[:, None]
            present = (wsum >= 1.5)[pk]
            ci = cen[pk]
            d = np.sqrt(((S - ci) ** 2).sum(1))
            out[f"p_{name}"] = w
            out[f"share_{name}"] = share[pk]
            out[f"dist_{name}"] = np.where(present, d, BIG)
            out[f"dvel_{name}"] = np.where(present, (S[:, 0] - ci[:, 0]) * JND[0], 0.0)
            out[f"dhb_{name}"] = np.where(present, (S[:, 2] - ci[:, 2]) * JND[2], 0.0)
        out["n_group"] = cnt[pk]
        return {k: np.asarray(v, dtype=np.float32).astype(np.float64) for k, v in out.items()}

    # ── one pitch or two? ────────────────────────────────────────────
    @staticmethod
    def _em2(Z, iters=60, restarts=4, seed=0):
        n, d = Z.shape
        rng = np.random.default_rng(seed)
        mu1 = Z.mean(0)
        C1 = np.cov(Z.T) + np.eye(d) * 1e-3
        ll1 = _ll_one(Z, mu1, C1)
        best = None
        for r in range(restarts):
            if r == 0:
                w, v = np.linalg.eigh(C1)
                u = v[:, -1]
            else:
                u = rng.normal(size=d)
            proj = (Z - mu1) @ u
            cut = np.quantile(proj, [0.5, 0.3, 0.7, 0.5][r % 4])
            R = np.column_stack([proj <= cut, proj > cut]).astype(float)
            for _ in range(iters):
                nk = R.sum(0) + 1e-9
                pi = nk / n
                mu = (R.T @ Z) / nk[:, None]
                C = np.zeros((d, d))
                for k in range(2):
                    D = Z - mu[k]
                    C += (R[:, k, None] * D).T @ D
                C = C / n + np.eye(d) * 1e-3
                Ci = np.linalg.inv(C)
                _, logdet = np.linalg.slogdet(C)
                L = np.column_stack([np.log(pi[k] + 1e-12) - 0.5 * np.einsum("ij,jk,ik->i", Z - mu[k], Ci, Z - mu[k])
                                     for k in range(2)]) - 0.5 * logdet - 0.5 * d * np.log(2 * np.pi)
                m = L.max(1, keepdims=True)
                ll = float((m[:, 0] + np.log(np.exp(L - m).sum(1))).sum())
                R = np.exp(L - m)
                R /= R.sum(1, keepdims=True)
            if best is None or ll > best[3]:
                best = (R, mu, C, ll)
        return best[0], best[1], best[2], best[3], ll1

    @staticmethod
    def _session_offsets(V_all, sess, grp, in_set):
        off = np.zeros_like(V_all)
        out = ~in_set
        if out.sum() < 5:
            return off
        R = np.full_like(V_all, np.nan)
        for g in np.unique(grp[out]):
            m = out & (grp == g)
            if m.sum() >= 3:
                R[m] = V_all[m] - np.median(V_all[m], axis=0)
        for s in np.unique(sess):
            ms = sess == s
            r = R[ms & out]
            r = r[~np.isnan(r).any(1)]
            if len(r) >= 2:
                off[ms] = np.median(r, axis=0) * (len(r) / (len(r) + 5))
        return off

    def _set_features(self, X, sess, in_set, grp):
        V_all = np.column_stack([X[k] for k in SET_DIMS])
        V = V_all[in_set]
        n = len(V)
        Z = V / SET_SCALE
        f = {"n": n}
        R, mu, C, ll2, ll1 = self._em2(Z)
        hard = R.argmax(1)
        if mu[1, 0] > mu[0, 0]:
            R, mu, hard = R[:, ::-1], mu[::-1], 1 - hard
        w = R.mean(0)
        f["minor"] = w.min()
        d = Z.shape[1]
        f["dbic_n"] = ((ll2 - ll1) - 0.5 * (d + 1) * np.log(n)) / n
        diff = mu[0] - mu[1]
        Ci = np.linalg.inv(C)
        f["mahal"] = float(np.sqrt(diff @ Ci @ diff))
        u = Ci @ diff
        proj = Z @ u
        a, b = proj[hard == 0], proj[hard == 1]
        f["ashman"] = (np.sqrt(2) * abs(a.mean() - b.mean()) / np.sqrt(a.var() + b.var() + 1e-9)) if min(len(a), len(b)) >= 2 else 0.0
        for j, nm in enumerate(SET_DIMS):
            f[f"d_{nm}"] = diff[j] * SET_SCALE[j]
            f[f"sd_{nm}"] = np.sqrt(C[j, j]) * SET_SCALE[j]
        E = np.column_stack([X[k][in_set] for k in SET_EXTRA])
        both2 = min((hard == 0).sum(), (hard == 1).sum()) >= 2
        for j, nm in enumerate(SET_EXTRA):
            f[f"d_{nm}"] = (_nanmedian(E[hard == 0, j]) - _nanmedian(E[hard == 1, j])) if both2 else 0.0
        ss = sess[in_set]
        unit = diff / (np.linalg.norm(diff) + 1e-9)
        co, gaps, wts = 0, [], []
        for s in np.unique(ss):
            m = ss == s
            k0, k1 = (hard[m] == 0).sum(), (hard[m] == 1).sum()
            if k0 >= 2 and k1 >= 2:
                co += m.sum()
                gaps.append(((Z[m][hard[m] == 0].mean(0) - Z[m][hard[m] == 1].mean(0)) @ unit))
                wts.append(min(k0, k1))
        f["co_frac"] = co / n
        full = np.linalg.norm(diff)
        f["within_gap_ratio"] = (np.average(gaps, weights=wts) / (full + 1e-9)) if gaps else 0.0
        sess_ids, inv = np.unique(ss, return_inverse=True)
        frac1 = np.bincount(inv, weights=hard.astype(float)) / np.bincount(inv)
        cnt = np.bincount(inv)
        f["sess_purity"] = float(np.average(np.maximum(frac1, 1 - frac1), weights=cnt))
        f["n_sess"] = len(sess_ids)
        off = self._session_offsets(V_all, sess, grp, in_set)[in_set]
        Za = (V - off) / SET_SCALE
        Ra, mua, Ca, ll2a, ll1a = self._em2(Za)
        f["dbic_n_al"] = ((ll2a - ll1a) - 0.5 * (d + 1) * np.log(n)) / n
        da = mua[0] - mua[1]
        f["mahal_al"] = float(np.sqrt(da @ np.linalg.inv(Ca) @ da))
        f["minor_al"] = Ra.mean(0).min()
        f["off_sd"] = float(np.sqrt((off[:, 1:3] ** 2).sum(1)).mean())
        Zc = Z.copy()
        for s in np.unique(ss):
            m = ss == s
            if m.sum() >= 3:
                Zc[m] = Z[m] - Z[m].mean(0) + Z.mean(0)
        Rc, muc, Cc, ll2c, ll1c = self._em2(Zc)
        f["dbic_n_sc"] = ((ll2c - ll1c) - 0.5 * (d + 1) * np.log(n)) / n
        dc = muc[0] - muc[1]
        f["mahal_sc"] = float(np.sqrt(dc @ np.linalg.inv(Cc) @ dc))
        # within-session spread along vs across the split, vs his own noise
        B = V[:, 1:3]
        dv2 = (mu[0] - mu[1])[1:3] * SET_SCALE[1:3]
        u2 = dv2 / (np.linalg.norm(dv2) + 1e-9)
        p2 = np.array([-u2[1], u2[0]])
        res = []
        for s_ in np.unique(ss):
            m = ss == s_
            if m.sum() >= 4:
                res.append(B[m] - B[m].mean(0))
        if res:
            Rr = np.vstack(res)
            ev, evec = np.linalg.eigh(np.cov(Rr.T) + np.eye(2) * 1e-6)
            f["ws_eig"] = float(np.sqrt(ev[1] / ev[0]))
            f["ws_lmax"] = float(np.sqrt(ev[1]))
            f["ws_lmin"] = float(np.sqrt(ev[0]))
            f["ws_eig_dir"] = float(np.degrees(np.arctan2(evec[1, 1], evec[0, 1])) % 180)
            a_, b_ = Rr @ u2, Rr @ p2
            f["ws_sd_u"], f["ws_sd_p"] = a_.std(), b_.std()
            f["ws_ratio"] = a_.std() / (b_.std() + 1e-6)
            zz = a_ / (a_.std() + 1e-9)
            f["ws_kurt"] = float((zz ** 4).mean() - 3)
        else:
            for k in ("ws_sd_u", "ws_sd_p", "ws_ratio", "ws_kurt", "ws_eig", "ws_lmax", "ws_lmin", "ws_eig_dir"):
                f[k] = np.nan
        ev, _ = np.linalg.eigh(np.cov((B - B.mean(0)).T) + np.eye(2) * 1e-6)
        f["all_eig"] = float(np.sqrt(ev[1] / ev[0]))
        a_, b_ = (B - B.mean(0)) @ u2, (B - B.mean(0)) @ p2
        f["all_ratio"] = a_.std() / (b_.std() + 1e-6)
        zz = a_ / (a_.std() + 1e-9)
        f["all_kurt"] = float((zz ** 4).mean() - 3)
        Vo = V_all[~in_set][:, 1:3]
        so, go = sess[~in_set], grp[~in_set]
        res = []
        for key in set(zip(so, go)):
            m = (so == key[0]) & (go == key[1])
            if m.sum() >= 4:
                res.append(Vo[m] - Vo[m].mean(0))
        if res:
            Rr = np.vstack(res)
            f["base_sd"] = float(Rr.std(0).mean())
            f["ws_u_over_base"] = f["ws_sd_u"] / f["base_sd"] if not np.isnan(f["ws_sd_u"]) else np.nan
            f["ws_p_over_base"] = f["ws_sd_p"] / f["base_sd"] if not np.isnan(f["ws_sd_p"]) else np.nan
            f["ws_lmax_over_base"] = f["ws_lmax"] / f["base_sd"] if not np.isnan(f["ws_lmax"]) else np.nan
        else:
            f["base_sd"] = f["ws_u_over_base"] = f["ws_p_over_base"] = f["ws_lmax_over_base"] = np.nan
        # usage differences between the parts (aim = location minus the pitch's own break)
        Ssel = {k: X[k][in_set] for k in ("same_side", "two_k", "balls", "strikes", "loc_z", "loc_x", "ivb", "hb")}
        Ssel["aim_z"] = Ssel["loc_z"] - Ssel["ivb"] / 12.0
        Ssel["aim_x"] = Ssel["loc_x"] - Ssel["hb"] / 12.0
        Ssel["first"] = np.where(np.isnan(Ssel["balls"]), np.nan,
                                 ((Ssel["balls"] == 0) & (Ssel["strikes"] == 0)).astype(float))
        for nm in SET_USAGE:
            col = Ssel[nm]
            u0, u1 = col[hard == 0], col[hard == 1]
            u0, u1 = u0[~np.isnan(u0)], u1[~np.isnan(u1)]
            f[f"u_{nm}"] = (u0.mean() - u1.mean()) if min(len(u0), len(u1)) >= 3 else np.nan
        bs = f.get("base_sd", np.nan)
        for nm in ["ivb", "hb"]:
            f[f"sdr_{nm}"] = f[f"sd_{nm}"] / bs if bs == bs and bs > 0 else np.nan
        f["ws_lmin_over_base"] = f["ws_lmin"] / bs if bs == bs and bs > 0 and f["ws_lmin"] == f["ws_lmin"] else np.nan
        for nm in ["dv", "ivb", "hb", "dspin", "daxis", "arm_angle", "ref_ivb", "ref_hb"]:
            f[f"m_{nm}"] = float(_nanmedian(X[nm][in_set]))
        return f, hard

    # ── partition ────────────────────────────────────────────────────
    @staticmethod
    def _initial_groups(P, min_frac=0.03, min_n=4):
        lab = P.argmax(1)
        for _ in range(3):
            cnt = np.bincount(lab, minlength=P.shape[1])
            small = (cnt > 0) & (cnt < max(min_n, min_frac * len(lab)))
            if not small.any():
                break
            ok = cnt >= max(min_n, min_frac * len(lab))
            if not ok.any():
                break
            Pm = np.where(ok[None, :], P, -1)
            mv = small[lab]
            lab[mv] = Pm[mv].argmax(1)
        return lab

    def _partition(self, X, P, sess, tau_merge=0.5, tau_split=0.5):
        gid = self._initial_groups(P)
        origin = {g: g for g in np.unique(gid)}
        nxt = P.shape[1]
        while True:
            groups = [g for g in np.unique(gid) if (gid == g).sum() >= 8]
            best = None
            for i in range(len(groups)):
                for j in range(i + 1, len(groups)):
                    a, b = groups[i], groups[j]
                    if frozenset((CLASSES[origin[a]], CLASSES[origin[b]])) not in NEIGH:
                        continue
                    p = self._p_one(self._set_features(X, sess, np.isin(gid, [a, b]), gid)[0])
                    if p > tau_merge and (best is None or p > best[0]):
                        best = (p, a, b)
            if best is None:
                break
            _, a, b = best
            keep, drop = (a, b) if (gid == a).sum() >= (gid == b).sum() else (b, a)
            gid[gid == drop] = keep
        for g in np.unique(gid):
            m = gid == g
            if m.sum() < 30:
                continue
            f, hard = self._set_features(X, sess, m, gid)
            p = self._p_one(f)
            if p < tau_split and min((hard == 0).sum(), (hard == 1).sum()) >= max(8, 0.15 * m.sum()):
                idx = np.where(m)[0]
                gid[idx[hard == 1]] = nxt
                origin[nxt] = origin[g]
                nxt += 1
        return gid

    # ── naming ───────────────────────────────────────────────────────
    def _group_table(self, X, gid):
        keys = list(dict.fromkeys(gid.tolist()))          # first-appearance order
        G = len(keys)
        idx = [np.where(gid == k)[0] for k in keys]
        T = {}
        for c in G_MED:
            T[f"m_{c}"] = np.array([_nanmedian(X[c][ix]) for ix in idx])
        for c in G_SPREAD:
            T[f"s_{c}"] = np.array([_nanq(X[c][ix], .75) - _nanq(X[c][ix], .25) for ix in idx])
        T["n"] = np.array([len(ix) for ix in idx], dtype=float)
        T["share"] = T["n"] / len(gid)
        same = X["same_side"]
        if np.isfinite(same).any():
            b, s = X["balls"], X["strikes"]
            U = {"u_same": same,
                 "u_2k": np.where(np.isnan(s), np.nan, (s == 2).astype(float)),
                 "u_first": np.where(np.isnan(b), np.nan, ((b == 0) & (s == 0)).astype(float)),
                 "u_ahead": np.where(np.isnan(b), np.nan, (s > b).astype(float)),
                 "u_behind": np.where(np.isnan(b), np.nan, (b > s).astype(float)),
                 "u_locz": X["loc_z"], "u_locx": X["loc_x"]}
            for c, v in U.items():
                pm = _nanmean(v)
                T[c] = np.array([_nanmean(v[ix]) for ix in idx]) - pm
            T["u_n_ctx"] = np.array([np.isfinite(same[ix]).sum() for ix in idx], dtype=float)
        else:
            for c in G_USAGE:
                T[c] = np.full(G, np.nan) if c != "u_n_ctx" else np.zeros(G)
        T["n_groups"] = np.full(G, float(G))
        T["velo_rank"] = _rank_desc(T["m_dv"])
        return keys, T

    @staticmethod
    def _arsenal_context(T, P):
        G, K = P.shape
        sh, dv, ivb, hb, spin = T["share"], T["m_dv"], T["m_ivb"], T["m_hb"], T["m_dspin"]
        other_share = np.zeros((G, K))
        gap_v, gap_h, gap_i = np.zeros((G, K)), np.zeros((G, K)), np.zeros((G, K))
        near = np.full((G, CTX_NUM, 5), np.nan)
        ids = np.arange(G)
        for a in ids:
            o = ids[ids != a]
            if len(o) == 0:
                continue
            w = P[o] * sh[o, None]
            other_share[a] = w.sum(0)
            ws = np.maximum(w.sum(0), 1e-9)
            gap_v[a] = np.where(w.sum(0) > 0.01, (w * (dv[a] - dv[o])[:, None]).sum(0) / ws, 0)
            gap_h[a] = np.where(w.sum(0) > 0.01, (w * (hb[a] - hb[o])[:, None]).sum(0) / ws, 0)
            gap_i[a] = np.where(w.sum(0) > 0.01, (w * (ivb[a] - ivb[o])[:, None]).sum(0) / ws, 0)
            d = np.sqrt(((dv[a] - dv[o]) / 2) ** 2 + ((ivb[a] - ivb[o]) / 3) ** 2 + ((hb[a] - hb[o]) / 3) ** 2)
            for j, b in enumerate(o[np.argsort(d, kind="stable")][:CTX_NUM]):
                near[a, j] = [dv[a] - dv[b], ivb[a] - ivb[b], hb[a] - hb[b], spin[a] - spin[b], sh[b]]
        F = {}
        for k, c in enumerate(CLASSES):
            F[f"o_share_{c}"] = other_share[:, k]
            F[f"o_dv_{c}"] = gap_v[:, k]
            F[f"o_dhb_{c}"] = gap_h[:, k]
            F[f"o_divb_{c}"] = gap_i[:, k]
            F[f"self_p_{c}"] = P[:, k]
        for j in range(CTX_NUM):
            for m, nm in enumerate(["dv", "divb", "dhb", "dspin", "share"]):
                F[f"nb{j}_{nm}"] = near[:, j, m]
        return F

    def _name_groups(self, X, gid, P=None):
        keys, T = self._group_table(X, gid)
        X1 = np.column_stack([T[c] for c in self.F1])
        P1 = self._multi("n1_", X1, self.on1)
        C = self._arsenal_context(T, P1)
        X2 = np.column_stack([T[c] if c in T else C[c] for c in self.F2])
        P2 = self._multi("n2_", X2, self.on2)
        name = dict(zip(keys, np.array(CLASSES)[P2.argmax(1)]))
        return np.array([name[g] for g in gid.tolist()])


G_MED_SRC = sorted(set(G_MED + G_SPREAD) - {"bauer"} | {"bauer"})


def _rank_desc(v):
    """pandas rank(ascending=False, method='average'); NaN stays NaN."""
    out = np.full(len(v), np.nan)
    ok = np.isfinite(v)
    vals = v[ok]
    r = np.empty(len(vals))
    order = np.argsort(-vals, kind="stable")
    sv = -vals[order]
    i = 0
    while i < len(sv):
        j = i
        while j + 1 < len(sv) and sv[j + 1] == sv[i]:
            j += 1
        r[order[i:j + 1]] = (i + j) / 2 + 1
        i = j + 1
    out[ok] = r
    return out


def _ll_one(Z, mu, C):
    d = Z.shape[1]
    Ci = np.linalg.inv(C)
    _, logdet = np.linalg.slogdet(C)
    D = Z - mu
    return float((-0.5 * np.einsum("ij,jk,ik->i", D, Ci, D) - 0.5 * logdet - 0.5 * d * np.log(2 * np.pi)).sum())


# ── clustering helpers (cluster.py) ──

ID_DIMS = ["velo", "ivb", "hb", "spin"]
ID_SCALE = np.array([1.2, 2.6, 2.6, 120.0])


def identity_space(F):
    return np.column_stack([F[k] for k in ID_DIMS]) / ID_SCALE


def _kpp(Z, k, rng):
    c = [Z[rng.integers(len(Z))]]
    for _ in range(1, k):
        d = np.min(((Z[:, None, :] - np.array(c)[None]) ** 2).sum(-1), 1)
        p = d / d.sum() if d.sum() > 0 else np.full(len(Z), 1 / len(Z))
        c.append(Z[rng.choice(len(Z), p=p)])
    return np.array(c)


def gmm(Z, k, seed=0, iters=80, ridge=0.08, restarts=3):
    """Full-covariance GMM (ridge in identity units). Returns (labels, loglik, resp)."""
    n, d = Z.shape
    best = None
    for r in range(restarts):
        rng = np.random.default_rng(seed * 101 + r)
        mu = _kpp(Z, k, rng)
        lab = np.argmin(((Z[:, None, :] - mu[None]) ** 2).sum(-1), 1)
        R = np.eye(k)[lab]
        ll = -np.inf
        for _ in range(iters):
            nk = R.sum(0) + 1e-9
            mu = (R.T @ Z) / nk[:, None]
            L = np.empty((n, k))
            for j in range(k):
                D = Z - mu[j]
                C = (R[:, j, None] * D).T @ D / nk[j] + np.eye(d) * ridge
                Ci = np.linalg.inv(C)
                _, ld = np.linalg.slogdet(C)
                L[:, j] = np.log(nk[j] / n) - 0.5 * ld - 0.5 * np.einsum("ij,jk,ik->i", D, Ci, D)
            m = L.max(1, keepdims=True)
            new_ll = float((m[:, 0] + np.log(np.exp(L - m).sum(1))).sum()) - 0.5 * d * np.log(2 * np.pi) * n
            R = np.exp(L - m)
            R /= R.sum(1, keepdims=True)
            if abs(new_ll - ll) < 1e-4 * n:
                ll = new_ll
                break
            ll = new_ll
        if best is None or ll > best[1]:
            best = (R.argmax(1), ll, R)
    return best


def over_cluster(Z, k_max=9, min_per=6, seed=0):
    """BIC-chosen GMM over-clustering. Clusters are relabeled 0..K-1 by size."""
    n, d = Z.shape
    k_max = int(max(1, min(k_max, n // min_per)))
    npar = lambda k: k * (d + d * (d + 1) / 2) + (k - 1)
    best = None
    for k in range(1, k_max + 1):
        lab, ll, _ = gmm(Z, k, seed=seed)
        bic = -2 * ll + npar(k) * np.log(n)
        if best is None or bic < best[0]:
            best = (bic, lab)
    lab = best[1]
    u, inv, cnt = np.unique(lab, return_inverse=True, return_counts=True)
    order = np.argsort(-cnt, kind="stable")
    remap = np.empty(len(u), int)
    remap[order] = np.arange(len(u))
    return remap[inv]


def canonical_order(Z):
    """A fixed order for a pitcher's pitches that does not depend on how the
    rows arrived (database order is arbitrary): sort by the identity coords."""
    return np.lexsort(Z.T[::-1])


def segment(Z, target=8, k_min=6, k_max=40, min_per=3, restarts=4, iters=60):
    """Deterministic over-segmentation into small, pure pieces (~`target`
    pitches each) with k-means++ / Lloyd in the identity space. Call on rows
    in canonical_order. Pieces are relabeled 0..K-1 by size."""
    n = len(Z)
    k = int(np.clip(round(n / target), k_min, max(k_min, min(k_max, n // min_per))))
    if n < 2 * min_per:
        return np.zeros(n, int)
    k = min(k, n // min_per)
    best = None
    for r in range(restarts):
        rng = np.random.default_rng(1000 + r)
        mu = _kpp(Z, k, rng)
        for _ in range(iters):
            d = ((Z[:, None, :] - mu[None]) ** 2).sum(-1)
            lab = d.argmin(1)
            new = np.array([Z[lab == j].mean(0) if (lab == j).any() else mu[j] for j in range(k)])
            if np.allclose(new, mu):
                break
            mu = new
        inertia = ((Z - mu[lab]) ** 2).sum()
        if best is None or inertia < best[0] - 1e-9:
            best = (inertia, lab)
    lab = best[1]
    u, inv, cnt = np.unique(lab, return_inverse=True, return_counts=True)
    order = np.argsort(-cnt, kind="stable")
    remap = np.empty(len(u), int)
    remap[order] = np.arange(len(u))
    return remap[inv]


# ── v5 partition + bagged naming (prod5.py) ──

TAU_MERGE = 0.15
NEIGHBORS = 4             # each piece is only compared with its nearest pieces
MERGE_MAX_DIST = 7.0      # identity units
TINY = 5                  # pieces smaller than this join the nearest piece if close
TINY_JOIN_DIST = 3.0
MIN_GROUP = 3             # final groups smaller than this use the per-pitch model


class ArsenalTagger5(ArsenalTagger):
    tau_merge = TAU_MERGE

    @classmethod
    def bare(cls):
        return cls.__new__(cls)

    def _name_groups(self, X, gid, P=None):
        names = self._name_bag(X, gid)
        if P is not None:
            # a group of 1-2 pitches is not evidence of a pitch type of its own:
            # those pitches keep the per-pitch MLB model's call
            u, inv, cnt = np.unique(gid, return_inverse=True, return_counts=True)
            few = cnt[inv] < MIN_GROUP
            names[few] = np.array(CLASSES)[P[few].argmax(1)]
        return names

    def _name_bag(self, X, gid):
        """Average of the bagged namers (5 namers trained on different 80%
        slices of the MLB training pitchers): removes single-model flips on
        borderline groups. Falls back to the single namer."""
        bag = self.meta.get("namer_bag") if hasattr(self, "meta") else None
        if not bag:
            return super()._name_groups(X, gid)
        keys, T = self._group_table(X, gid)
        Ps = []
        for b, nb in enumerate(bag):
            o1 = [nb["c1"].index(c) for c in CLASSES]
            o2 = [nb["c2"].index(c) for c in CLASSES]
            P1 = self._multi(f"nb{b}a_", np.column_stack([T[c] for c in nb["F1"]]), o1)
            C = self._arsenal_context(T, P1)
            Ps.append(self._multi(f"nb{b}b_", np.column_stack([T[c] if c in T else C[c] for c in nb["F2"]]), o2))
        P2 = np.mean(Ps, 0)
        name = dict(zip(keys, np.array(CLASSES)[P2.argmax(1)]))
        return np.array([name[g] for g in gid.tolist()])

    def _partition(self, X, P=None, sess=None, p_one=None):
        p_one = p_one or self._p_one
        Z0 = identity_space(X)
        order = canonical_order(Z0)
        Xo = {k: np.asarray(v)[order] for k, v in X.items()}
        so = np.asarray(sess)[order]
        gid = self._agglomerate(Xo, so, p_one)
        out = np.empty_like(gid)
        out[order] = gid
        return out

    def _agglomerate(self, X, sess, p_one, pieces=None):
        Z = identity_space(X)
        gid = segment(Z) if pieces is None else pieces.copy()
        gid = _absorb_tiny(gid, Z)
        cache = {}
        while True:
            groups = list(np.unique(gid))
            if len(groups) < 2:
                break
            cen = np.array([Z[gid == g].mean(0) for g in groups])
            D = np.sqrt(((cen[:, None] - cen[None]) ** 2).sum(-1))
            cand = set()
            for i in range(len(groups)):
                for j in np.argsort(D[i])[1:NEIGHBORS + 1]:
                    if D[i, j] <= MERGE_MAX_DIST:
                        cand.add((min(i, j), max(i, j)))
            best = None
            for i, j in sorted(cand):
                a, b = groups[i], groups[j]
                m = (gid == a) | (gid == b)
                key = m.tobytes()
                if key not in cache:
                    f = self._set_features(X, sess, m, gid)[0]
                    f.update(pair_features(X, sess, gid == a, gid == b))
                    cache[key] = p_one(f)
                p = cache[key]
                if p > self.tau_merge and (best is None or p > best[0]):
                    best = (p, a, b)
            if best is None:
                break
            _, a, b = best
            keep, drop = (a, b) if (gid == a).sum() >= (gid == b).sum() else (b, a)
            gid[gid == drop] = keep
        return gid


def pair_features(X, sess, ma, mb):
    """The candidate split itself (the two pieces as they are), not just the
    union: gaps per dimension, gap in identity units vs the pieces' own
    spread, balance, and whether both pieces show up in the same sessions."""
    f = {}
    for k in ("velo", "ivb", "hb", "spin", "axis", "rel_z", "rel_x"):
        a, b = X[k][ma], X[k][mb]
        if k == "axis":
            dd = (np.median(a) - np.median(b) + 180) % 360 - 180
        else:
            dd = np.median(a) - np.median(b)
        f[f"pc_d_{k}"] = abs(dd)
    Za, Zb = identity_space({k: X[k][ma] for k in ("velo", "ivb", "hb", "spin")}), identity_space({k: X[k][mb] for k in ("velo", "ivb", "hb", "spin")})
    gap = Za.mean(0) - Zb.mean(0)
    f["pc_gap"] = float(np.linalg.norm(gap))
    u = gap / (np.linalg.norm(gap) + 1e-9)
    sa, sb = (Za @ u).std(), (Zb @ u).std()
    f["pc_gap_sd"] = f["pc_gap"] / (np.sqrt(0.5 * (sa ** 2 + sb ** 2)) + 1e-6)
    f["pc_minor"] = min(ma.sum(), mb.sum()) / (ma.sum() + mb.sum())
    f["pc_nmin"] = float(min(ma.sum(), mb.sum()))
    sa_, sb_ = set(np.asarray(sess)[ma]), set(np.asarray(sess)[mb])
    f["pc_sess_overlap"] = len(sa_ & sb_) / max(1, len(sa_ | sb_))
    return f


def _absorb_tiny(gid, Z):
    gid = gid.copy()
    for _ in range(3):
        u, cnt = np.unique(gid, return_counts=True)
        small, big = u[cnt < TINY], u[cnt >= TINY]
        if not len(small) or not len(big):
            break
        changed = False
        cen = np.array([Z[gid == g].mean(0) for g in big])
        for g in small:
            ix = np.where(gid == g)[0]
            d = np.sqrt(((Z[ix].mean(0) - cen) ** 2).sum(-1))
            if d.min() <= TINY_JOIN_DIST:
                gid[ix] = big[d.argmin()]
                changed = True
        if not changed:
            break
    return gid


_TAGGER = None


def get_tagger():
    """Lazy singleton (the npz is ~41 MB; load once per process)."""
    global _TAGGER
    if _TAGGER is None:
        import os
        _TAGGER = ArsenalTagger5(os.path.join(os.path.dirname(__file__), "..", "..", "data", "pitch_tagger.npz"))
    return _TAGGER
