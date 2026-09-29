import numpy as np, collections
from headdata import load_items
from fasthead import fit_lin, img_weights, logo
from train_rich import SLICES
import calib_image as CI
from sklearn.model_selection import StratifiedKFold
its = load_items(); y = np.array([it["label"] for it in its]); fam = np.array([it["family"] for it in its])
X = np.stack([it["ft"]["v5"].mean(0) for it in its])[:, SLICES["rich"]]
oof = logo(its, X, lambda a, b, c: fit_lin(a, b, c, 0.005))
print("threshold tradeoff (LOGO): worst-group cap -> AI caught (family-balanced), group-balanced real FPR, DOCCI FPR")
for cap in (0.15, 0.12, 0.10, 0.08, 0.06):
    t = CI.choose_threshold(y, oof, fam, max_fpr=0.05, max_group_fpr=cap)
    if t: print(f"  cap {cap:.2f}: t={t[0]:.2f} AI {t[2]:.3f} realFPR {t[3]:.3f} worst {t[4]:.3f} docci {(oof[fam=='real:docci']>=t[0]).mean():.3f}")
# in-distribution: 5-fold by original image (all groups seen in training)
orig = np.array([hash(it["orig"]) % 5 for it in its]); ind = np.zeros(len(its))
for k in range(5):
    tr = orig != k
    f = fit_lin(X[tr], y[tr], img_weights([its[i] for i in np.where(tr)[0]]), 0.005); ind[~tr] = f(X[~tr])
t = CI.choose_threshold(y, oof, fam, 0.05, 0.15)[0]
print("in-distribution 5-fold at the LOGO threshold:", "AI", round(float((ind[y==1]>=t).mean()),3),
      {f[5:]: round(float((ind[fam==f]>=t).mean()),3) for f in sorted(set(fam[y==0]))})
