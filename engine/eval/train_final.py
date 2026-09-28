"""Final text model: dense stylometry + pruned lexicon, LR (C=0.003).
1) LOCO with pruning inside each fold -> out-of-fold (OOF) doc scores.
2) Bands from OOF human/AI score distributions (unseen-domain behaviour).
3) Fit on all training corpora, prune, refit, export JSON for text-detector.js."""
import sys, json, numpy as np, scipy.sparse as sp, collections, time
from multiprocessing import Pool
from sklearn.linear_model import LogisticRegression
from textlib import *
C = 0.003; K = int(sys.argv[1]) if len(sys.argv) > 1 else 2500; LEXCAP = 5.0; CLIP = 6.0
BREADTH = int(sys.argv[2]) if len(sys.argv) > 2 else 8
TAG = f"K{K}_B{BREADTH}"
prefix = "../data/text/pool"
vocab, meta, D, L = load(prefix)
L.data = np.minimum(L.data, LEXCAP)
N = len(meta)
# Keep only general-purpose vocabulary: a term must occur in >=1% of documents
# in at least BREADTH distinct training domains. Format tokens are excluded.
STOP = {"br", "answer", "question", "nbsp", "amp", "quot", "http", "https", "www", "com"}
dom_rows = collections.defaultdict(list)
for i, m in enumerate(meta):
    if m["train_ok"]: dom_rows[(m["corpus"], m["domain"])].append(i)
breadth = np.zeros(L.shape[1])
for key, idx in dom_rows.items():
    if len(idx) < 50: continue
    present = (L[idx] > 0).astype(np.float64)
    frac = np.asarray(present.mean(0)).ravel()
    breadth += (frac >= 0.01)
ALLOWED = np.array([j for j, t in enumerate(vocab)
    if breadth[j] >= BREADTH and not any(w in STOP or (len(w) == 1 and w not in ("a", "i")) for w in t.split(" "))])
print("allowed lexicon terms", len(ALLOWED), "of", len(vocab))

def design(idx_fit, cols):
    mu = D[idx_fit].mean(0); sd = D[idx_fit].std(0) + 1e-6
    Z = np.clip((D - mu) / sd, -CLIP, CLIP)
    X = sp.hstack([sp.csr_matrix(Z), L[:, cols]]).tocsr()
    return X, mu, sd

def fit_pruned(idx):
    y = np.array([meta[i]["label"] for i in idx]); w = balance_weights(meta, idx)
    allcols = ALLOWED
    X, mu, sd = design(idx, allcols)
    m = LogisticRegression(C=C, max_iter=3000, solver="liblinear").fit(X[idx], y, sample_weight=w)
    wl = m.coef_[0][D.shape[1]:]
    Li = L[idx][:, allcols]
    mean_x = np.asarray(Li.mean(0)).ravel(); mean_x2 = np.asarray(Li.multiply(Li).mean(0)).ravel()
    std_x = np.sqrt(np.maximum(0, mean_x2 - mean_x ** 2))
    cols = np.sort(allcols[np.argsort(-np.abs(wl) * std_x)[:K]])
    X2, mu, sd = design(idx, cols)
    m2 = LogisticRegression(C=C, max_iter=3000, solver="liblinear").fit(X2[idx], y, sample_weight=w)
    return m2, X2, mu, sd, cols

def train_idx(exclude=None):
    return [i for i in range(N) if meta[i]["train_ok"] and meta[i]["corpus"] != exclude and is_train_variant(meta[i]["variant"])]

def fold(held):
    tr = train_idx(held); te = [i for i in range(N) if meta[i]["corpus"] == held]
    m, X, mu, sd, cols = fit_pruned(tr)
    return held, doc_scores(meta, te, m.decision_function(X[te]))

if __name__ == "__main__":
    corpora = sorted({m["corpus"] for m in meta if m["train_ok"]})
    t0 = time.time()
    with Pool(4) as p:
        oof = dict(p.map(fold, corpora))
    print("loco done", round(time.time() - t0), "s")
    docmeta = {m["doc"]: m for m in meta}
    rows = []
    for held, ds in oof.items():
        for d, s in ds.items():
            mm = docmeta[d]
            rows.append(dict(doc=d, score=s, label=mm["label"], corpus=mm["corpus"], domain=mm["domain"],
                             variant=mm["variant"], generator=mm["generator"], eligible=mm["eligible"]))
    json.dump(rows, open(f"../data/text/oof_{TAG}.json", "w"))
    # final fit
    tr = train_idx(None)
    m, X, mu, sd, cols = fit_pruned(tr)
    coef = m.coef_[0]; nd = D.shape[1]
    model = {
        "version": f"gaic-text-v2-lr-c{C}-k{K}",
        "bias": float(m.intercept_[0]),
        "dense": [[round(float(mu[j]), 6), round(float(sd[j]), 6), round(float(coef[j]), 6), CLIP] for j in range(nd)],
        "lexicon": {vocab[c]: round(float(coef[nd + k]), 6) for k, c in enumerate(cols) if abs(coef[nd + k]) > 1e-6},
        "lexCap": LEXCAP,
    }
    json.dump(model, open(f"../data/text/model_{TAG}.json", "w"))
    # in-sample doc scores for parity checks with the JS engine
    allidx = list(range(N))
    ds = doc_scores(meta, allidx, m.decision_function(X[allidx]))
    json.dump(ds, open(f"../data/text/final_docscores_{TAG}.json", "w"))
    print("final lexicon", len(model["lexicon"]), "done", round(time.time() - t0), "s")
