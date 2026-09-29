"""Rich-feature decision head: variant search under leave-one-group-out,
calibration (lean threshold + confidence cuts) on out-of-group scores, and
export of the final head to runtime/image-head.js."""
import sys, json, collections, numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.isotonic import IsotonicRegression
from headlib import auc, tpr_at_fpr
from headdata import load_items, load_screens

SLICES = {"cls": slice(0, 384), "final": slice(0, 768), "rich": slice(0, 2304)}

def sample_weights(its, counts):
    """per-view weights: each image sums to 1, each group sums equally inside its class, classes 50/50"""
    fam = [it["family"] for it in its]; lab = [it["label"] for it in its]
    w_img = np.ones(len(its))
    for c in (0, 1):
        gs = collections.Counter(f for f, l in zip(fam, lab) if l == c)
        for i, (f, l) in enumerate(zip(fam, lab)):
            if l == c: w_img[i] = 0.5 / len(gs) / gs[f]
    return np.concatenate([[w_img[i] / n] * n for i, n in enumerate(counts)])

def design(its, sl):
    X = np.vstack([it["ft"]["v5"][:, sl] for it in its]); counts = [len(it["ft"]["v5"]) for it in its]
    y = np.concatenate([[it["label"]] * n for it, n in zip(its, counts)])
    return X, y, counts

def fit(its, sl, C):
    X, y, counts = design(its, sl)
    w = sample_weights(its, counts)
    mu, sd = X.mean(0), X.std(0) + 1e-6
    m = LogisticRegression(C=C, max_iter=8000, tol=1e-5).fit((X - mu) / sd, y, sample_weight=w * len(its))
    return dict(mu=mu, sd=sd, w=m.coef_[0], b=float(m.intercept_[0]), sl=sl)

def z(h, V):
    return ((V[:, h["sl"]] - h["mu"]) / h["sd"]) @ h["w"] + h["b"]

def score(h, it):
    return float(z(h, it["ft"]["v5"]).mean())

def logo(its, sl, C):
    oof = np.zeros(len(its))
    for g in sorted({it["family"] for it in its}):
        tr = [it for it in its if it["family"] != g]
        h = fit(tr, sl, C)
        for i, it in enumerate(its):
            if it["family"] == g: oof[i] = score(h, it)
    return oof

def report(name, its, s, detail=True):
    y = np.array([it["label"] for it in its]); s = np.asarray(s, float)
    fam = np.array([it["family"] for it in its])
    t1 = tpr_at_fpr(y, s, 0.01); t5 = tpr_at_fpr(y, s, 0.05)
    worst = max((s[fam == f] > t5[1]).mean() for f in set(fam[y == 0]))
    print(f"{name:30s} AUC {auc(y, s):.3f}  TPR@1% {t1[0]:.3f}  TPR@5% {t5[0]:.3f}  worst-real-group FPR@5% {worst:.3f}", flush=True)
    if detail:
        print("    AI caught @5%/@1%:", " ".join(f"{f}:{(s[fam == f] > t5[1]).mean():.2f}/{(s[fam == f] > t1[1]).mean():.2f}" for f in sorted(set(fam[y == 1]))))
        print("    real flagged @5%/@1%:", " ".join(f"{f[5:]}:{(s[fam == f] > t5[1]).mean():.3f}/{(s[fam == f] > t1[1]).mean():.3f}" for f in sorted(set(fam[y == 0]))))
    return dict(auc=auc(y, s), tpr1=t1[0], tpr5=t5[0], worst=worst)

if __name__ == "__main__":
    its = load_items()
    print("items", len(its), sorted(collections.Counter((it["family"], it["label"]) for it in its).items()), flush=True)
    report("OLD v5 max view", its, [it["ft"]["v5logit"].max() for it in its])
    grid = [(v, float(c)) for v in (sys.argv[1].split(",") if len(sys.argv) > 1 else ["cls", "rich"])
            for c in (sys.argv[2].split(",") if len(sys.argv) > 2 else ["0.01", "0.1"])]
    res = {}
    for v, C in grid:
        s = logo(its, SLICES[v], C)
        res[(v, C)] = report(f"HEAD {v} C={C}", its, s)
        json.dump({it["file"]: float(x) for it, x in zip(its, s)}, open(f"../data/rfeat/oof_{v}_C{C}.json", "w"))
