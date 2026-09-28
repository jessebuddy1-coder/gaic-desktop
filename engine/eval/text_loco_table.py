import json, numpy as np, collections
from sklearn.metrics import roc_auc_score
TH, TL = 2.47, -0.63
oof = [r for r in json.load(open('../data/text/oof_K2500_B8.json')) if r['eligible']]
base = {json.loads(l)['doc']: json.loads(l)['score'] for l in open('../data/text/pool.baseline.jsonl')}
rows = []
def pct(x): return f"{100*x:.1f}%"
print("| Held-out corpus (LOCO) | Humans / AI docs | AUC old → new | Humans flagged old → new | AI flagged old → new | AI in 'Few' old → new |")
print("|---|---|---|---|---|---|")
summary = {}
for c in sorted({r['corpus'] for r in oof}):
    H = [r for r in oof if r['corpus'] == c and r['label'] == 0 and r['variant'] == 'plain']
    A = [r for r in oof if r['corpus'] == c and r['label'] == 1 and r['variant'] == 'plain']
    if not H or not A: continue
    so = lambda R: [base[r['doc']] if base[r['doc']] is not None else 50 for r in R]
    auc_o = roc_auc_score([0]*len(H)+[1]*len(A), so(H)+so(A)); auc_n = roc_auc_score([0]*len(H)+[1]*len(A), [r['score'] for r in H+A])
    hf_o = np.mean(np.array(so(H)) >= 66); hf_n = np.mean([r['score'] >= TH for r in H])
    af_o = np.mean(np.array(so(A)) >= 66); af_n = np.mean([r['score'] >= TH for r in A])
    am_o = np.mean(np.array(so(A)) < 34); am_n = np.mean([r['score'] < TL for r in A])
    summary[c] = dict(n_h=len(H), n_ai=len(A), auc_old=round(auc_o,3), auc_new=round(auc_n,3), human_flag_old=round(hf_o,4), human_flag_new=round(hf_n,4), ai_flag_old=round(af_o,4), ai_flag_new=round(af_n,4), ai_few_old=round(am_o,4), ai_few_new=round(am_n,4))
    print(f"| {c} | {len(H)} / {len(A)} | {auc_o:.2f} → **{auc_n:.2f}** | {pct(hf_o)} → {pct(hf_n)} | {pct(af_o)} → **{pct(af_n)}** | {pct(am_o)} → **{pct(am_n)}** |")
NN = [r for r in oof if r['label'] == 0 and 'nonnative' in r['domain']]
print("\nnon-native human (LOCO):", len(NN), "flagged new", pct(np.mean([r['score'] >= TH for r in NN])), "old", pct(np.mean([ (base[r['doc']] or 0) >= 66 for r in NN])), "in few new", pct(np.mean([r['score'] < TL for r in NN])))
HU = [r for r in oof if r['label'] == 1 and (r['variant'] == 'humanized' or r['variant'].startswith('attack'))]
print("humanized/attacked AI (LOCO):", len(HU), "flagged new", pct(np.mean([r['score'] >= TH for r in HU])), "in few new", pct(np.mean([r['score'] < TL for r in HU])), "old in few", pct(np.mean([ (base[r['doc']] if base[r['doc']] is not None else 50) < 34 for r in HU])))
json.dump(summary, open('../data/text/loco_summary.json', 'w'), indent=1)
