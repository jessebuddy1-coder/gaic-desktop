import json, numpy as np, scipy.sparse as sp, collections
from sklearn.metrics import roc_auc_score

def load(prefix):
    vocab = json.load(open(prefix + ".vocab.json"))
    meta, dense, rows, cols, vals = [], [], [], [], []
    for i, line in enumerate(open(prefix + ".features.jsonl")):
        r = json.loads(line)
        n = max(1, r["words"])
        for j, c in r["lex"]:
            rows.append(i); cols.append(j); vals.append(100.0 * c / n)
        dense.append(r["dense"])
        del r["lex"], r["dense"]
        meta.append(r)
    D = np.array(dense, dtype=np.float64)
    L = sp.csr_matrix((vals, (rows, cols)), shape=(len(meta), len(vocab)), dtype=np.float64)
    return vocab, meta, D, L

def is_train_variant(v):
    return v in ("plain", "humanized") or v.startswith("attack")

def balance_weights(meta, idx):
    groups = collections.Counter((meta[i]["corpus"], meta[i]["label"]) for i in idx)
    corpora = collections.Counter(meta[i]["corpus"] for i in idx)
    w = np.array([1.0 / groups[(meta[i]["corpus"], meta[i]["label"])] for i in idx])
    # every corpus/label cell gets equal mass
    return w * len(idx) / w.sum()

def doc_scores(meta, idx, chunk_logits):
    acc = collections.defaultdict(lambda: [0.0, 0.0])
    for i, z in zip(idx, chunk_logits):
        a = acc[meta[i]["doc"]]; a[0] += z * meta[i]["words"]; a[1] += meta[i]["words"]
    return {d: a[0] / max(1, a[1]) for d, a in acc.items()}

def tpr_at_fpr(y, s, fpr):
    y = np.asarray(y); s = np.asarray(s)
    neg = np.sort(s[y == 0])[::-1]
    if not len(neg): return float("nan"), float("nan")
    k = int(np.floor(fpr * len(neg)))
    thr = neg[k] if k < len(neg) else neg[-1]
    return float(np.mean(s[y == 1] > thr)), float(thr)

def summarize(y, s):
    y = np.asarray(y); s = np.asarray(s)
    out = {"n_h": int((y == 0).sum()), "n_ai": int((y == 1).sum())}
    if out["n_h"] and out["n_ai"]:
        out["auc"] = round(float(roc_auc_score(y, s)), 4)
        out["tpr@1%"] = round(tpr_at_fpr(y, s, 0.01)[0], 4)
        out["tpr@5%"] = round(tpr_at_fpr(y, s, 0.05)[0], 4)
    return out
