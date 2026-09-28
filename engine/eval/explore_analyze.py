"""Compare scan plans on stored per-view logits.
Usage: python3 explore_analyze.py <manifest.json> <explore.jsonl> [old_worker.jsonl]
Splits images into calibration/test halves by file hash. For each plan, the
thresholds that give the target false-positive rates on the calibration half
of the REAL images are applied unchanged to the test half."""
import sys, json, hashlib, numpy as np, collections
from sklearn.metrics import roc_auc_score

man = {x["file"]: x for x in json.load(open(sys.argv[1]))}
rows = [json.loads(l) for l in open(sys.argv[2]) if l.strip()]
rows = [r for r in rows if "views" in r and r["file"] in man]
old = {}
if len(sys.argv) > 3:
    for l in open(sys.argv[3]):
        r = json.loads(l)
        if r.get("ok"):
            p = min(1 - 1e-7, max(1e-7, r["result"]["aiLikelihood"]))
            old[r["file"]] = float(np.log(p / (1 - p)))

def mean(v): return float(np.mean(v))
def subj(r, name):
    return r["views"].get(name)

def plan_center(r): return subj(r, "frame")["c256"]
def plan_flip(r): v = subj(r, "frame"); return mean([v["c256"], v["c256f"]])
def plan_five(r): v = subj(r, "frame"); return mean([v[k] for k in ("c256", "c256f", "tl256", "tr256", "bl256", "br256")])
def plan_multi(r): v = subj(r, "frame"); return mean([v[k] for k in ("c256", "c256f", "c288", "c288f", "c232")])
def pic_or_frame(r, keys, gate=None):
    loc = r.get("loc")
    p = subj(r, "picture")
    if p and loc and (gate is None or loc["outsideBackground"] >= gate):
        return mean([p[k] for k in keys])
    return mean([subj(r, "frame")[k] for k in keys])
K2 = ("c256", "c256f"); K6 = ("c256", "c256f", "tl256", "tr256", "bl256", "br256")
PLANS = {
    "old v5 (max of 8)": lambda r: old.get(r["file"]),
    "frame center": plan_center,
    "frame center+flip": plan_flip,
    "frame 5crop+flip": plan_five,
    "frame multiscale": plan_multi,
    "picture|frame c+f": lambda r: pic_or_frame(r, K2),
    "picture|frame 5crop": lambda r: pic_or_frame(r, K6),
    "gated0.5 c+f": lambda r: pic_or_frame(r, K2, 0.5),
    "gated0.7 c+f": lambda r: pic_or_frame(r, K2, 0.7),
    "gated0.7 5crop": lambda r: pic_or_frame(r, K6, 0.7),
    "gated0.85 5crop": lambda r: pic_or_frame(r, K6, 0.85),
    "max(frame,pic) c+f": lambda r: max(pic_or_frame(r, K2), plan_flip(r)),
}

def half(f): return int(hashlib.sha1(f.encode()).hexdigest(), 16) % 2
def raw_band(z, pct): return z >= np.log(pct / (100 - pct))

print(f"images: {len(rows)}  real={sum(man[r['file']]['label']==0 for r in rows)}  ai={sum(man[r['file']]['label']==1 for r in rows)}")
hdr = f"{'plan':24s} {'AUC':>6s} | raw95 FPR/TPR   raw99 FPR/TPR | test@cal-FPR1%  test@cal-FPR0.2%"
print(hdr); print("-" * len(hdr))
for name, fn in PLANS.items():
    data = [(fn(r), man[r["file"]]["label"], half(r["file"])) for r in rows]
    data = [d for d in data if d[0] is not None]
    if not data: continue
    z = np.array([d[0] for d in data]); y = np.array([d[1] for d in data]); h = np.array([d[2] for d in data])
    auc = roc_auc_score(y, z)
    f95 = np.mean(raw_band(z[y == 0], 95)); t95 = np.mean(raw_band(z[y == 1], 95))
    f99 = np.mean(raw_band(z[y == 0], 99)); t99 = np.mean(raw_band(z[y == 1], 99))
    out = []
    for fpr in (0.01, 0.002):
        cal_real = np.sort(z[(y == 0) & (h == 0)])[::-1]
        k = int(np.floor(fpr * len(cal_real)))
        thr = cal_real[k] if k < len(cal_real) else cal_real[-1]
        te = h == 1
        out.append(f"{np.mean(z[te & (y == 0)] > thr):.3f}/{np.mean(z[te & (y == 1)] > thr):.3f}")
    print(f"{name:24s} {auc:6.3f} | {f95:.3f}/{t95:.3f}    {f99:.3f}/{t99:.3f}   | {out[0]:>14s}  {out[1]:>14s}")
