"""Held-out results for the shipped image head, computed the way the app
decides: the head logit goes through runtime/image-head.js's calibration
table, the worker rounds the likelihood to 4 decimals, decideImageLean clamps
it to [0.005, 0.995], an image leans AI at >= 50%, and the confidence level
comes from the table's cuts. Inputs are the committed per-image held-out
scores (each scored by a head that never saw its group).

  python3 image_report_v3.py   -> prints the tables, writes results/image_v3_report.json"""
import json, math, re
import numpy as np
from headlib import auc

head = json.loads(re.search(r"Object\.freeze\((\{.*\})\);\n", open("../runtime/image-head.js").read()).group(1))
cal = head["calibration"]

def shown(kind, z):
    k = cal[kind]["knots"]; xs = np.array([a for a, _ in k]); vs = np.array([b for _, b in k])
    p = 1 / (1 + np.exp(-np.interp(z, xs, vs)))
    return np.clip(np.round(p * 1e4) / 1e4, 0.005, 0.995)

def tier(p, c):
    if p >= 0.5: return "ai", "high" if p >= c["aiHigh"] else "medium" if p >= c["aiMedium"] else "low"
    return "real", "high" if p <= c["realHigh"] else "medium" if p <= c["realMedium"] else "low"

def rates(flag, y, grp):
    ai = {g: float(flag[(grp == g) & (y == 1)].mean()) for g in sorted(set(grp[y == 1]))}
    real = {g: float(flag[(grp == g) & (y == 0)].mean()) for g in sorted(set(grp[y == 0]))}
    return float(np.mean(list(ai.values()))), float(np.mean(list(real.values()))), ai, real

rows = [json.loads(l) for l in open("results/image_v3_held_out.jsonl")]
y = np.array([r["label"] for r in rows]); grp = np.array([r["group"].replace("real:", "") for r in rows])
z = np.array([r["head_logit_held_out"] for r in rows]); v2 = np.array([r["v2_max_logit"] for r in rows])
p = shown("direct", z); lean_ai = p >= 0.5
tpr, fpr, ai_fam, real_src = rates(lean_ai, y, grp)
out = {"photos": {"n": len(rows), "ai_called_ai": tpr, "real_called_ai": fpr, "worst_real_source": max(real_src.values()),
                  "auc": auc(y, z), "per_ai_family": ai_fam, "per_real_source": real_src}}
# GAIC 2.4.0: warning at a v2 score >= 95, and the v2 model at the same real false-lean rate
w = v2 >= math.log(95 / 5)
t0, f0, ai0, _ = rates(w, y, grp)
best = None
for t in np.unique(v2):
    tt, ff, aa, _ = rates(v2 >= t, y, grp)
    if ff <= fpr and (best is None or tt > best[0]): best = (tt, ff, aa, float(t))
out["gaic_2_4_0"] = {"warning_ai_called_ai": t0, "warning_real_called_ai": f0, "auc": auc(y, v2),
                     "same_rate_ai_called_ai": best[0], "same_rate_real_called_ai": best[1], "same_rate_per_ai_family": best[2]}
# confidence levels, balanced classes
wa, wr = 0.5 / (y == 1).sum(), 0.5 / (y == 0).sum()
tiers = {}
for pp, yy in zip(p, y):
    key = "%s %s" % tier(pp, cal["direct"]["cuts"]); t_ = tiers.setdefault(key, [0, 0]); t_[int(yy)] += 1
total = sum(a * wa + r * wr for r, a in tiers.values())
out["photo_confidence"] = {k: {"share": (a * wa + r * wr) / total,
                               "correct": (a * wa if k.startswith("ai") else r * wr) / (a * wa + r * wr), "ai": a, "real": r}
                           for k, (r, a) in sorted(tiers.items())}
# screenshots
srows = [json.loads(l) for l in open("results/image_v3_screens_held_out.jsonl")]
sy = np.array([r["label"] for r in srows]); tpl = np.array([r["template"] for r in srows])
sz = np.array([r["head_logit_held_out"] for r in srows]); scan = np.array([r["scan"] for r in srows])
sp = np.where(scan == "composite", shown("composite", sz), shown("direct", sz)); s_ai = sp >= 0.5
out["screenshots"] = {"n_ai": int((sy == 1).sum()), "n_real": int((sy == 0).sum()), "picture_located": float((scan == "composite").mean()),
                      "ai_called_ai": float(s_ai[sy == 1].mean()), "real_called_ai": float(s_ai[sy == 0].mean()), "auc": auc(sy, sp),
                      "per_layout": {t: {"ai_called_ai": float(s_ai[(tpl == t) & (sy == 1)].mean()),
                                         "real_called_ai": float(s_ai[(tpl == t) & (sy == 0)].mean())} for t in sorted(set(tpl))}}
json.dump(out, open("results/image_v3_report.json", "w"), indent=1)
P = lambda v: f"{100 * v:.1f}%"
o = out["photos"]; g = out["gaic_2_4_0"]
print(f"photos n={o['n']}: AI called AI {P(o['ai_called_ai'])}, real called AI {P(o['real_called_ai'])}, worst real source {P(o['worst_real_source'])}, AUC {o['auc']:.3f}")
print(f"  2.4.0 warning: {P(g['warning_ai_called_ai'])} / {P(g['warning_real_called_ai'])}; v2 at the same rate: {P(g['same_rate_ai_called_ai'])} / {P(g['same_rate_real_called_ai'])}; v2 AUC {g['auc']:.3f}")
for f_, v in sorted(o["per_ai_family"].items(), key=lambda a: -a[1]): print(f"  AI {f_:18s} v3 {P(v):>6s}  v2 same rate {P(g['same_rate_per_ai_family'][f_]):>6s}")
for s_, v in sorted(o["per_real_source"].items(), key=lambda a: a[1]): print(f"  real {s_:22s} {P(v)}")
for k, v in out["photo_confidence"].items(): print(f"  {k:12s} share {P(v['share'])} correct {P(v['correct'])} (ai {v['ai']}, real {v['real']})")
s = out["screenshots"]
print(f"screenshots: AI called AI {P(s['ai_called_ai'])}, real called AI {P(s['real_called_ai'])}, AUC {s['auc']:.3f}, picture located {P(s['picture_located'])}")
for t, v in s["per_layout"].items(): print(f"  {t:16s} {P(v['ai_called_ai']):>6s} {P(v['real_called_ai']):>6s}")
