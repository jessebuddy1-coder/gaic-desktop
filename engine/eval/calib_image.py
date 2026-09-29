"""Calibration for the image head: lean threshold, displayed-likelihood knots,
and confidence cuts, all from out-of-group scores (balanced class weights)."""
import numpy as np
from sklearn.isotonic import IsotonicRegression

def balanced_w(y):
    y = np.asarray(y); return np.where(y == 1, 0.5 / (y == 1).sum(), 0.5 / (y == 0).sum())

def group_fpr(y, s, fam, t):
    return {f: float((s[(fam == f)] >= t).mean()) for f in sorted(set(fam[y == 0]))}

def choose_threshold(y, s, fam, max_fpr=0.05, max_group_fpr=0.15, grid=None):
    """largest balanced accuracy with the group-balanced real false-lean rate
    (each real source counts equally) <= max_fpr and every real source <= max_group_fpr"""
    y = np.asarray(y); s = np.asarray(s, float); fam = np.asarray(fam)
    grid = np.quantile(s, np.linspace(0.01, 0.99, 981)) if grid is None else grid
    best = None
    for t in grid:
        g = group_fpr(y, s, fam, t)
        fpr = float(np.mean(list(g.values()))); worst = max(g.values())
        fams_ai = sorted(set(fam[y == 1]))
        tpr = float(np.mean([(s[(fam == f) & (y == 1)] >= t).mean() for f in fams_ai]))
        if fpr <= max_fpr and worst <= max_group_fpr and (best is None or tpr - fpr > best[1]):
            best = (float(t), float(tpr - fpr), float(tpr), float(fpr), float(worst))
    return best

def isotonic(y, s):
    return IsotonicRegression(y_min=0.003, y_max=0.997, out_of_bounds="clip").fit(s, y, sample_weight=balanced_w(y))

def knots(y, s, t, lo=None, hi=None, step=0.25, temperature=1.0):
    """log-odds knots on the head logit, shifted so the displayed probability is 0.5 at t"""
    lo = np.floor(np.quantile(s, 0.002)) if lo is None else lo
    hi = np.ceil(np.quantile(s, 0.998)) if hi is None else hi
    grid = np.arange(lo, hi + 1e-9, step)
    iso = isotonic(y, s); p = np.clip(iso.predict(grid), 0.003, 0.997)
    p = np.maximum.accumulate(p + np.arange(len(p)) * 1e-6)
    shift = np.log(np.interp(t, grid, p) / (1 - np.interp(t, grid, p)))
    lo_ = (np.log(p / (1 - p)) - shift) * temperature
    return [[round(float(g), 3), round(float(v), 4)] for g, v in zip(grid, lo_)]

def apply_knots(k, s):
    g = np.array([a for a, _ in k]); v = np.array([b for _, b in k])
    return 1 / (1 + np.exp(-np.interp(s, g, v)))

def cuts(y, s, t, k, ai=(0.95, 0.85), real=(0.90, 0.75)):
    """confidence cuts in displayed-probability space from isotonic local precision"""
    iso = isotonic(y, s)
    grid = np.linspace(np.quantile(s, 0.001), np.quantile(s, 0.999), 4000); p = iso.predict(grid)
    def z_first_at_least(v):
        idx = np.where((p >= v) & (grid >= t))[0]; return float(grid[idx[0]]) if len(idx) else float("inf")
    def z_last_at_most(v):
        idx = np.where((p <= v) & (grid < t))[0]; return float(grid[idx[-1]]) if len(idx) else float("-inf")
    zc = dict(aiHigh=z_first_at_least(ai[0]), aiMedium=z_first_at_least(ai[1]),
              realHigh=z_last_at_most(1 - real[0]), realMedium=z_last_at_most(1 - real[1]))
    out = {}
    for name, zz in zc.items():
        if np.isfinite(zz): out[name] = round(float(apply_knots(k, np.array([zz]))[0]), 4)
        else: out[name] = 1.0 if name.startswith("ai") else 0.0
    out["aiMedium"] = max(0.5, min(out["aiMedium"], out["aiHigh"]))
    out["realMedium"] = min(0.4999, max(out["realMedium"], out["realHigh"]))
    return out, zc

def tier(p, c):
    if p >= 0.5: return "ai", "high" if p >= c["aiHigh"] else "medium" if p >= c["aiMedium"] else "low"
    return "real", "high" if p <= c["realHigh"] else "medium" if p <= c["realMedium"] else "low"

def tier_table(y, p, c, fam=None):
    import collections
    y = np.asarray(y); wa, wr = 0.5 / max(1, (y == 1).sum()), 0.5 / max(1, (y == 0).sum())
    cnt = collections.Counter()
    for yy, pp in zip(y, p): cnt[tier(pp, c) + (int(yy),)] += 1
    rows = []
    for lean in ("ai", "real"):
        for conf in ("high", "medium", "low"):
            a, r = cnt[(lean, conf, 1)], cnt[(lean, conf, 0)]
            if a + r == 0: continue
            good = a * wa if lean == "ai" else r * wr
            rows.append((lean, conf, a * wa + r * wr, good / (a * wa + r * wr), a, r))
    return rows
