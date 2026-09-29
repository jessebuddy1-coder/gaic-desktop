"""Final image decision head: LOGO scores for calibration (direct + screenshots),
final fit on everything, calibration tables, and export to runtime/image-head.js.
Usage: python3 train_final_head.py <variant> <C> <composite-rule: max|picture|mean>"""
import sys, json, collections, numpy as np
from headdata import load_items, load_screens
from train_rich import SLICES, report
from fasthead import img_weights
from sklearn.linear_model import LogisticRegression
import calib_image as CI

def fit(its, sl, C):
    X = np.stack([it["ft"]["v5"].mean(0)[sl] for it in its]); yy = np.array([it["label"] for it in its])
    mu, sd = X.mean(0), X.std(0) + 1e-6
    m = LogisticRegression(C=C, max_iter=5000, tol=1e-5).fit((X - mu) / sd, yy, sample_weight=img_weights(its))
    return dict(mu=mu, sd=sd, w=m.coef_[0], b=float(m.intercept_[0]), sl=sl)

def z(h, V):
    """mean over views of the head logit == head(mean feature)"""
    return ((V[:, h["sl"]] - h["mu"]) / h["sd"]) @ h["w"] + h["b"]

variant, C, rule = sys.argv[1], float(sys.argv[2]), sys.argv[3]
sl = SLICES[variant]
its = load_items(); scr = load_screens()
print("items", len(its), "screens", len(scr), flush=True)
fams = sorted({it["family"] for it in its})
heads = {g: fit([it for it in its if it["family"] != g], sl, C) for g in fams}
oof = np.array([float(z(heads[it["family"]], it["ft"]["v5"]).mean()) for it in its])
y = np.array([it["label"] for it in its]); fam = np.array([it["family"] for it in its])
report(f"LOGO {variant} C={C}", its, oof)

def composite_score(h, it, rule):
    fr = float(z(h, it["ft"]["v5"]).mean())
    if len(it["ft"]["pic"]) == 0: return fr, False
    pc = float(z(h, it["ft"]["pic"]).mean())
    return (pc if rule == "picture" else (fr + pc) / 2 if rule == "mean" else max(fr, pc)), True
for alt in (("max", "picture", "mean") if scr else ()):
    sa = np.array([composite_score(heads[it["family"]], it, alt)[0] for it in scr])
    ya = np.array([it["label"] for it in scr])
    from headlib import auc as _auc, tpr_at_fpr as _t
    print(f"screens rule {alt:8s} AUC {_auc(ya, sa):.3f} TPR@5% {_t(ya, sa, 0.05)[0]:.3f} TPR@1% {_t(ya, sa, 0.01)[0]:.3f}", flush=True)
sc = [composite_score(heads[it["family"]], it, rule) for it in scr]
s_scr = np.array([a for a, _ in sc], dtype=float); has_pic = np.array([b for _, b in sc], dtype=bool)
y_scr = np.array([it["label"] for it in scr]); fam_scr = np.array([it["family"] for it in scr])
old_scr = np.array([it["ft"]["v5logit"].max() for it in scr])
from headlib import auc, tpr_at_fpr
if scr: print("screens: picture located", has_pic.mean().round(3), "| AUC old", round(auc(y_scr, old_scr), 3), "new", round(auc(y_scr, s_scr), 3),
      "| TPR@5% old", round(tpr_at_fpr(y_scr, old_scr, 0.05)[0], 3), "new", round(tpr_at_fpr(y_scr, s_scr, 0.05)[0], 3))
for tpl in sorted({it["template"] for it in scr}):  # noqa
    m = np.array([it["template"] == tpl for it in scr])
    print(f"   {tpl:16s} AUC old {auc(y_scr[m], old_scr[m]):.3f} new {auc(y_scr[m], s_scr[m]):.3f}")

# ---- calibration: direct ----
thr = CI.choose_threshold(y, oof, fam, max_fpr=0.05, max_group_fpr=0.10)
print("direct threshold", thr)
t = thr[0]
kd = CI.knots(y, oof, t)
cd, zc = CI.cuts(y, oof, t, kd)
pd = CI.apply_knots(kd, oof)
print("direct cuts", cd, "z", zc)
for row in CI.tier_table(y, pd, cd): print("   %-5s %-6s share %.3f correct %.3f (ai %d, real %d)" % row)
print("   real leaning AI per group:", {f[5:]: round(float((pd[fam == f] >= 0.5).mean()), 3) for f in sorted(set(fam[y == 0]))})
print("   AI leaning AI per family:", {f: round(float((pd[fam == f] >= 0.5).mean()), 3) for f in sorted(set(fam[y == 1]))})
# ---- calibration: composite (screenshots where a picture was located) ----
m = has_pic.astype(bool)
if m.sum() >= 100 and len(set(y_scr[m])) == 2:
    thr_c = CI.choose_threshold(y_scr[m], s_scr[m], fam_scr[m], max_fpr=0.05, max_group_fpr=0.15)
    print("composite threshold", thr_c)
    kc = CI.knots(y_scr[m], s_scr[m], thr_c[0]); cc, _ = CI.cuts(y_scr[m], s_scr[m], thr_c[0], kc)
    pc = CI.apply_knots(kc, s_scr[m])
    for row in CI.tier_table(y_scr[m], pc, cc): print("   %-5s %-6s share %.3f correct %.3f (ai %d, real %d)" % row)
else:
    kc, cc = kd, cd; print("composite: too few located pictures; using direct calibration")
# screenshots without a located picture use the direct table: report it
if (~m).sum():
    pn = CI.apply_knots(kd, s_scr[~m])
    print("   screenshots without located picture (direct table): real leaning AI", round(float((pn[y_scr[~m] == 0] >= .5).mean()), 3),
          "AI leaning AI", round(float((pn[y_scr[~m] == 1] >= .5).mean()), 3))
# ---- frame: direct table, flattened (video frames are out of the training domain) ----
kf = CI.knots(y, oof, t, temperature=0.75)
cf = {k: v for k, v in cd.items()}
cf = dict(aiHigh=min(0.99, max(cd["aiHigh"], 0.93)), aiMedium=max(cd["aiMedium"], 0.8),
          realHigh=min(cd["realHigh"], 0.07), realMedium=min(cd["realMedium"], 0.2))

# ---- final fit and export ----
H = fit(its, sl, C)
w = H["w"] / H["sd"]; b = H["b"] - float((H["w"] * H["mu"] / H["sd"]).sum())
full = np.zeros(2304); full[sl] = w
json.dump(dict(variant=variant, C=C, rule=rule, t=t, weights=full.tolist(), bias=b,
               calibration=dict(direct=dict(knots=kd, cuts=cd), composite=dict(knots=kc, cuts=cc), frame=dict(knots=kf, cuts=cf))),
          open("../data/rfeat/final_head.json", "w"))
# parity reference: python head logit (folded) for a few items
ref = [(it["file"], float(((it["ft"]["v5"] @ full) + b).mean())) for it in its[:20]]
json.dump(ref, open("../data/rfeat/final_head_ref.json", "w"))
print("exported; bias", round(b, 4), "nonzero weights", int((full != 0).sum()))
