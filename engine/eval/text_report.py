import json, numpy as np, collections, sys
from sklearn.metrics import roc_auc_score
T_HIGH, T_LOW = float(sys.argv[1]), float(sys.argv[2])
js = [r for r in json.load(open('../data/text/js_scores.json')) if r['eligible']]
def band_new(z): return 'several' if z >= T_HIGH else ('few' if z < T_LOW else 'mixed')
def band_old(s): return 'several' if s >= 66 else ('few' if s < 34 else 'mixed')
def report(name, H, A):
    if not H and not A: return
    out = {'set': name, 'n_human': len(H), 'n_ai': len(A)}
    if H and A:
        out['auc_old'] = round(roc_auc_score([0]*len(H)+[1]*len(A), [r['old'] for r in H]+[r['old'] for r in A]), 3)
        out['auc_new'] = round(roc_auc_score([0]*len(H)+[1]*len(A), [r['logit'] for r in H]+[r['logit'] for r in A]), 3)
    for tag, S, f in (('old', 'old', band_old), ('new', 'logit', band_new)):
        if H: out[f'human_flagged_{tag}'] = round(np.mean([f(r[S]) == 'several' for r in H]), 3); out[f'human_few_{tag}'] = round(np.mean([f(r[S]) == 'few' for r in H]), 3)
        if A: out[f'ai_flagged_{tag}'] = round(np.mean([f(r[S]) == 'several' for r in A]), 3); out[f'ai_missed_few_{tag}'] = round(np.mean([f(r[S]) == 'few' for r in A]), 3)
    print(json.dumps(out))
held = [r for r in js if not r['train_ok']]
for corpus in ('detectrl', 'detector-bias', 'argugpt'):
    H = [r for r in held if r['corpus'] == corpus and r['label'] == 0]
    A = [r for r in held if r['corpus'] == corpus and r['label'] == 1 and r['variant'] == 'plain']
    AH = [r for r in held if r['corpus'] == corpus and r['label'] == 1 and r['variant'] == 'humanized']
    report(corpus + ' (plain AI)', H, A)
    if AH: report(corpus + ' (paraphrased/attacked AI)', H, AH)
# per-generator on detectrl
for g in sorted({r['generator'] for r in held if r['corpus']=='detectrl' and r['label']==1}):
    H = [r for r in held if r['corpus'] == 'detectrl' and r['label'] == 0]
    A = [r for r in held if r['corpus'] == 'detectrl' and r['label'] == 1 and r['generator']==g and r['variant']=='plain']
    report('detectrl/'+g, H, A)
for dom in sorted({r['domain'] for r in held if r['corpus']=='detector-bias' and r['label']==0}):
    report('detector-bias human/'+dom, [r for r in held if r['corpus']=='detector-bias' and r['label']==0 and r['domain']==dom], [])
