"""Recalibrate the composite path (an upload where the scan located a picture)
on every held-out item that takes it: screenshots and ordinary photos alike.

The composite table was set on screenshots only, but the worker takes the
same path for any photo where scan v6 locates a picture (440 of the 13,926
held-out photos: mostly rendered graphics and paintings with borders). On
that path its threshold let real Open Images non-photo images lean AI 10.25%
of the time, above the 10% per-source limit. This picks the composite rule
and threshold that catch the most AI photos and screenshots while photos keep
the published limits (source-balanced real false leans <= 5%, every real
source <= 10%) and screenshots keep theirs (<= 5% on average, every real
source <= 15%), refits the composite knots and confidence cuts on all located
items, re-pins every table (calib_image.pin_knots), and rewrites
runtime/image-head.js and results/image_v3_calibration.json.

  python3 recalibrate_composite.py"""
import json, re
import numpy as np
import calib_image as CI

ph = [json.loads(l) for l in open("results/image_v3_held_out.jsonl")]
sc = [json.loads(l) for l in open("results/image_v3_screens_held_out.jsonl")]
cal = json.load(open("results/image_v3_calibration.json"))
TD = cal["thresholds"]["direct"]
nan = lambda v: np.nan if v is None else v
py = np.array([r["label"] for r in ph]); pg = np.array([r["group"].replace("real:", "") for r in ph])
pf = np.array([r["head_logit_held_out"] for r in ph]); pp = np.array([nan(r["picture_logit_held_out"]) for r in ph])
sy = np.array([r["label"] for r in sc]); sfam = np.array([r["family"] for r in sc])
sf = np.array([r["frame_logit_held_out"] for r in sc]); sp = np.array([nan(r["picture_logit_held_out"]) for r in sc])

def composite(f, p, rule):
    both = {"max": np.fmax(f, p), "mean": (f + p) / 2, "picture": p}[rule]
    return np.where(np.isnan(p), f, both)

def photo_rates(flag):
    ai = [flag[(pg == g) & (py == 1)].mean() for g in sorted(set(pg[py == 1]))]
    real = [flag[(pg == g) & (py == 0)].mean() for g in sorted(set(pg[py == 0]))]
    return float(np.mean(ai)), float(np.mean(real)), float(max(real))

def screen_rates(flag):
    real = [flag[(sfam == g) & (sy == 0)].mean() for g in sorted(set(sfam[sy == 0]))]
    return float(flag[sy == 1].mean()), float(flag[sy == 0].mean()), float(max(real))

best = None
for rule in ("max", "mean", "picture"):
    cp, cs = composite(pf, pp, rule), composite(sf, sp, rule)
    for t in np.round(np.arange(0.5, 6.001, 0.01), 2):
        ptpr, pfpr, pworst = photo_rates(np.where(np.isnan(pp), pf >= TD, cp >= t))
        stpr, sfpr, sworst = screen_rates(np.where(np.isnan(sp), sf >= TD, cs >= t))
        if pfpr <= 0.05 and pworst <= 0.10 and sfpr <= 0.05 and sworst <= 0.15:
            if best is None or ptpr + stpr > best["score"]:
                best = dict(rule=rule, t=float(t), score=ptpr + stpr, photos=(ptpr, pfpr, pworst), screens=(stpr, sfpr, sworst))
print("chosen:", best)

# Refit the composite table on every located item, scored with the chosen rule.
m_ph, m_sc = ~np.isnan(pp), ~np.isnan(sp)
y = np.concatenate([py[m_ph], sy[m_sc]])
s = np.concatenate([composite(pf, pp, best["rule"])[m_ph], composite(sf, sp, best["rule"])[m_sc]])
kc = CI.knots(y, s, best["t"])
cc, _ = CI.cuts(y, s, best["t"], kc)

path = "../runtime/image-head.js"
src = open(path).read()
m = re.search(r"Object\.freeze\((\{.*\})\);\n", src)
head = json.loads(m.group(1))
head["composite"] = best["rule"]
head["calibration"]["composite"] = {"knots": kc, "cuts": cc}
for kind in ("direct", "frame"):
    head["calibration"][kind]["knots"] = CI.pin_knots(head["calibration"][kind]["knots"], TD)
for kind, table in head["calibration"].items():
    xs = [x for x, _ in table["knots"]]; vs = [v for _, v in table["knots"]]
    assert xs == sorted(xs) and len(set(xs)) == len(xs) and all(b >= a for a, b in zip(vs, vs[1:])), kind
open(path, "w").write(src[:m.start(1)] + json.dumps(head, separators=(",", ":")) + src[m.end(1):])

cal["composite_rule"] = best["rule"]
cal["thresholds"]["composite"] = best["t"]
cal["cuts"]["composite"] = cc
cal["composite_set"] = "screenshots and photos with a located picture (held out)"
json.dump(cal, open("results/image_v3_calibration.json", "w"), indent=1)
open("results/image_v3_calibration.json", "a").write("\n")
print("composite cuts", cc)
