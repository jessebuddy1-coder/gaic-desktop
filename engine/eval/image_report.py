"""Old (v5) vs new (v6) worker results on one condition.
Usage: python3 image_report.py <manifest.json> <old.jsonl> <new.jsonl> [--by template|source]"""
import sys, json, math, numpy as np, collections
from sklearn.metrics import roc_auc_score

man = {x["file"]: x for x in json.load(open(sys.argv[1]))}
def load(p):
    out = {}
    for l in open(p):
        r = json.loads(l)
        if r.get("ok") and r["file"] in man:
            out[r["file"]] = r["result"]["aiLikelihood"]
    return out
old, new = load(sys.argv[2]), load(sys.argv[3])
by = sys.argv[5] if len(sys.argv) > 5 and sys.argv[4] == "--by" else None
files = sorted(set(old) & set(new))

def wilson(k, n):
    if n == 0: return (float("nan"),) * 2
    z = 1.96; p = k / n; d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d; h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return max(0, c - h), min(1, c + h)

def stats(fs, scores):
    y = np.array([man[f]["label"] for f in fs]); s = np.array([scores[f] for f in fs])
    o = {"n_real": int((y == 0).sum()), "n_ai": int((y == 1).sum())}
    if o["n_real"] and o["n_ai"]: o["auc"] = round(float(roc_auc_score(y, s)), 3)
    for band in (0.95, 0.99):
        for lab, name in ((0, "fpr"), (1, "tpr")):
            k = int((s[y == lab] >= band).sum()); n = int((y == lab).sum())
            if n:
                lo, hi = wilson(k, n)
                o[f"{name}@{int(band*100)}"] = [k, n, round(k / n, 4), round(lo, 4), round(hi, 4)]
    return o

def line(tag, o):
    f = lambda key: (f"{o[key][0]}/{o[key][1]} ({100*o[key][2]:.1f}%)" if key in o else "—")
    return f"{tag:34s} AUC {o.get('auc','—')} | real≥95 {f('fpr@95'):>16s} real≥99 {f('fpr@99'):>16s} | AI≥95 {f('tpr@95'):>18s} AI≥99 {f('tpr@99'):>18s}"

summary = {}
groups = {"ALL": files}
if by:
    g = collections.defaultdict(list)
    for f in files:
        key = man[f].get(by, "?")
        g[key].append(f)
    groups.update(g)
for name, fs in groups.items():
    so, sn = stats(fs, old), stats(fs, new)
    summary[name] = {"old": so, "new": sn}
    print(line(f"[{name}] old v5", so)); print(line(f"[{name}] new v6", sn))
json.dump(summary, open(sys.argv[3].replace(".jsonl", ".summary.json"), "w"), indent=1)
