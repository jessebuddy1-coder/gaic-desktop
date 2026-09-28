import json, sys, numpy as np, collections
from sklearn.metrics import roc_auc_score
rows = [r for r in json.load(open(sys.argv[1])) if r["eligible"]]
H = collections.defaultdict(list); A = collections.defaultdict(list); AH = collections.defaultdict(list)
for r in rows:
    if r["label"] == 0 and r["variant"] == "plain": H[r["corpus"]].append(r["score"])
    elif r["label"] == 1 and r["variant"] == "plain": A[r["corpus"]].append(r["score"])
    elif r["label"] == 1 and (r["variant"] == "humanized" or r["variant"].startswith("attack")): AH[r["corpus"]].append(r["score"])
def fpr(t, c): return float(np.mean(np.array(H[c]) >= t))
def bal(D, t, above=True):
    v = [np.mean(np.array(x) >= t) if above else np.mean(np.array(x) < t) for x in D.values() if len(x) >= 20]
    return float(np.mean(v))
big = [c for c in H if len(H[c]) >= 100]
cands = np.linspace(-6, 8, 1401)
t_high = next(t for t in cands if all(fpr(t, c) <= 0.02 for c in big) and bal(H, t) <= 0.01)
print("t_high", round(t_high, 3), {c: round(fpr(t_high, c), 4) for c in H}, "AI recall", {c: round(float(np.mean(np.array(v) >= t_high)), 3) for c, v in A.items()})
for q in (0.5, 0.6, 0.7, 0.8, 0.9):
    t = next(t for t in cands if bal(H, t, above=False) >= q)
    print(f"human-balanced {q:.1f} below at t={t:.2f}; AI balanced below that: {bal(A, t, above=False):.3f}")
print("per-corpus AUC:", {c: round(roc_auc_score([0]*len(H[c]) + [1]*len(A[c]), H[c] + A[c]), 4) for c in H if A.get(c)})
