"""Fast head experiments on per-image mean features (a linear head's mean over
views equals the head applied to the mean feature)."""
import sys, collections, numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.neural_network import MLPClassifier
from headdata import load_items
from train_rich import SLICES, report

def img_weights(its):
    fam = [it["family"] for it in its]; lab = [it["label"] for it in its]
    w = np.ones(len(its))
    for c in (0, 1):
        gs = collections.Counter(f for f, l in zip(fam, lab) if l == c)
        for i, (f, l) in enumerate(zip(fam, lab)):
            if l == c: w[i] = 0.5 / len(gs) / gs[f]
    return w * len(its)

def fit_lin(X, y, w, C):
    mu, sd = X.mean(0), X.std(0) + 1e-6
    m = LogisticRegression(C=C, max_iter=5000, tol=1e-5).fit((X - mu) / sd, y, sample_weight=w)
    return lambda Z: ((Z - mu) / sd) @ m.coef_[0] + m.intercept_[0]

def fit_mlp(X, y, w, alpha, hidden=64):
    mu, sd = X.mean(0), X.std(0) + 1e-6
    m = MLPClassifier(hidden_layer_sizes=(hidden,), alpha=alpha, max_iter=300, learning_rate_init=1e-3,
                      batch_size=256, random_state=0, early_stopping=False)
    m.fit((X - mu) / sd, y, sample_weight=w)
    def f(Z):
        p = m.predict_proba((Z - mu) / sd)[:, 1].clip(1e-6, 1 - 1e-6); return np.log(p / (1 - p))
    return f

def logo(its, X, fitter):
    y = np.array([it["label"] for it in its]); fam = np.array([it["family"] for it in its])
    oof = np.zeros(len(its))
    for g in sorted(set(fam)):
        tr = fam != g
        f = fitter(X[tr], y[tr], img_weights([its[i] for i in np.where(tr)[0]]))
        oof[~tr] = f(X[~tr])
    return oof

if __name__ == "__main__":
    its = load_items()
    print("items", len(its), flush=True)
    X = np.stack([it["ft"]["v5"].mean(0) for it in its])
    report("OLD v5 max view", its, [it["ft"]["v5logit"].max() for it in its], detail=False)
    for spec in sys.argv[1:]:
        kind, var, par = spec.split(":")
        Xs = X[:, SLICES[var]]
        fitter = (lambda a, b, c, C=float(par): fit_lin(a, b, c, C)) if kind == "lin" else (lambda a, b, c, al=float(par): fit_mlp(a, b, c, al))
        s = logo(its, Xs, fitter)
        report(f"{kind} {var} {par}", its, s, detail=(kind == "lin" and par == "0.02"))
        np.save(f"../data/rfeat/oof_{kind}_{var}_{par}.npy", s)
