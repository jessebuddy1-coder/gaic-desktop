# Shared loaders for the image decision-head experiments.
import json, numpy as np, os

def load_feats(path, nviews=8):
    """-> dict file -> dict(v5=np[k,384], v5logit=np[k], pic=np[m,384], piclogit, score, ok)"""
    out = {}
    if not os.path.exists(path): return out
    for line in open(path):
        try: r = json.loads(line)
        except Exception: continue
        if not r.get("ok") or not r.get("calls"): continue
        k = len(r.get("v5ids") or []) or min(nviews, len(r["calls"]))
        calls = r["calls"]
        F = np.array([c["f"] for c in calls], dtype=np.float32)
        L = np.array([c["logit"] for c in calls], dtype=np.float64)
        out[r["file"]] = dict(v5=F[:k], v5logit=L[:k], pic=F[k:], piclogit=L[k:], score=r.get("score"),
                              ids=r.get("v5ids"), scan=r.get("regionScan"))
    return out

def auc(y, s):
    y = np.asarray(y); s = np.asarray(s, dtype=float)
    pos, neg = s[y == 1], s[y == 0]
    if len(pos) == 0 or len(neg) == 0: return float("nan")
    order = np.argsort(np.concatenate([pos, neg]), kind="mergesort")
    ranks = np.empty(len(order)); ranks[order] = np.arange(1, len(order) + 1)
    allv = np.concatenate([pos, neg])
    # average ties
    _, inv, cnt = np.unique(allv, return_inverse=True, return_counts=True)
    sums = np.bincount(inv, weights=ranks); ranks = (sums / cnt)[inv]
    return (ranks[:len(pos)].sum() - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg))

def tpr_at_fpr(y, s, fpr):
    y = np.asarray(y); s = np.asarray(s, dtype=float)
    neg = np.sort(s[y == 0])[::-1]
    if len(neg) == 0: return float("nan"), float("nan")
    k = int(np.floor(fpr * len(neg)))
    t = neg[k] if k < len(neg) else neg[-1] - 1e-9
    return float((s[y == 1] > t).mean()), float(t)

def platt(z, y, w=None):
    """fit p = sigmoid(a*z + c) with balanced class weights; returns (a, c)"""
    from sklearn.linear_model import LogisticRegression
    z = np.asarray(z, float).reshape(-1, 1); y = np.asarray(y)
    cw = {0: 0.5 / (y == 0).sum(), 1: 0.5 / (y == 1).sum()}
    sw = np.array([cw[v] for v in y]) * len(y)
    m = LogisticRegression(C=1e6, max_iter=1000).fit(z, y, sample_weight=sw)
    return float(m.coef_[0][0]), float(m.intercept_[0])

def confidence_table(p, y, cuts=(0.75, 0.90)):
    """balanced-prior precision per (lean, confidence) bucket"""
    p = np.asarray(p, float); y = np.asarray(y)
    wr, wa = 0.5 / (y == 0).sum(), 0.5 / (y == 1).sum()
    rows = []
    for lean in ("ai", "real"):
        q = p if lean == "ai" else 1 - p
        sel_lean = (p >= 0.5) if lean == "ai" else (p < 0.5)
        for name, lo, hi in (("high", cuts[1], 1.01), ("medium", cuts[0], cuts[1]), ("low", 0.0, cuts[0])):
            s = sel_lean & (q >= lo) & (q < hi)
            if not s.any(): rows.append((lean, name, 0.0, float("nan"), 0, 0)); continue
            good = ((y == 1) if lean == "ai" else (y == 0)) & s
            wgood = good.sum() * (wa if lean == "ai" else wr)
            wall = ((y == 1) & s).sum() * wa + ((y == 0) & s).sum() * wr
            rows.append((lean, name, float(wall), float(wgood / wall), int(((y == 1) & s).sum()), int(((y == 0) & s).sum())))
    return rows

def load_rich(path):
    """rich-feature records: jsonl index + .f32 matrix (dim from records). Same dict shape as load_feats."""
    out = {}
    if not os.path.exists(path): return out
    binp = path[:-6] + ".f32"
    recs = []
    for line in open(path):
        try: r = json.loads(line)
        except Exception: continue
        if r.get("ok") and r.get("calls") and r.get("dim"): recs.append(r)
    if not recs: return out
    dim = recs[0]["dim"]
    M = np.memmap(binp, dtype=np.float32, mode="r").reshape(-1, dim)
    for r in recs:
        k = len(r.get("v5ids") or []) or min(8, len(r["calls"]))
        offs = [c["off"] for c in r["calls"]]
        if max(offs) >= len(M): continue
        F = np.asarray(M[offs])
        L = np.array([c["logit"] for c in r["calls"]], dtype=np.float64)
        out[r["file"]] = dict(v5=F[:k], v5logit=L[:k], pic=F[k:], piclogit=L[k:], score=r.get("score"),
                              ids=r.get("v5ids"), scan=r.get("regionScan"))
    return out
