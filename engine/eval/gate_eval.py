import json, math, numpy as np
from sklearn.metrics import roc_auc_score
def lg(p): p=min(1-1e-9,max(1e-9,p)); return math.log(p/(1-p))
def rd(p): return [json.loads(l) for l in open(p)]
def feats(p): return {r['file']: r for r in rd(p)}
RULES = {
 'ob>=0.7 (current)': lambda f: f['loc'] and f['loc']['outsideBackground']>=0.7,
 'ob>=0.7 & marks<0.02': lambda f: f['loc'] and f['loc']['outsideBackground']>=0.7 and f['marks']<0.02,
 'ob>=0.7 & marks<0.01': lambda f: f['loc'] and f['loc']['outsideBackground']>=0.7 and f['marks']<0.01,
 'ob>=0.85 & marks<0.02': lambda f: f['loc'] and f['loc']['outsideBackground']>=0.85 and f['marks']<0.02,
 'never (frame only)': lambda f: False,
}
# screenshots: explore logits
man_s={x['file']:x for x in json.load(open('../data/img/screens/manifest.json'))}
ex={r['file']:r for r in rd('../data/img/results/explore_screens.jsonl')}
fs_s=feats('../data/img/results/locfeat_screens.jsonl')
K4=('c256','c256f','tl256','br256')
# direct: new_asis regionScores
man_d={x['file']:x for x in json.load(open('../data/img/manifest.json'))}
nd={r['file']:r['result'] for r in rd('../data/img/results/new_asis.jsonl') if r['ok']}
fs_d=feats('../data/img/results/locfeat_asis.jsonl')
def band(z, y, t): return np.mean(z[y==1]>=t), np.mean(z[y==0]>=t)
for name, rule in RULES.items():
    out=[]
    for cond in ('direct','screens'):
        ys=[]; zs=[]
        if cond=='screens':
            for f,r in ex.items():
                if 'views' not in r: continue
                use_pic = rule(fs_s[f]) and 'picture' in r['views']
                v = r['views']['picture'] if use_pic else r['views']['frame']
                zs.append(np.mean([v[k] for k in K4])); ys.append(man_s[f]['label'])
        else:
            for f,res in nd.items():
                sc={x['id']:x['aiLikelihood'] for x in res['regionScores']}
                use_pic = rule(fs_d[f]) and 'picture' in sc
                if use_pic: z=lg(sc['picture'])
                elif 'picture' in sc: z=lg(sc['whole'])  # proxy: whole-frame center view only
                else: z=lg(res['aiLikelihood'])
                zs.append(z); ys.append(man_d[f]['label'])
        y=np.array(ys); z=np.array(zs)
        if len(set(ys))<2: out.append(f"{cond}: n/a"); continue
        t95=math.log(95/5); t99=math.log(99)
        tp95,fp95=band(z,y,t95); tp99,fp99=band(z,y,t99)
        out.append(f"{cond}: AUC {roc_auc_score(y,z):.3f} AI≥95 {tp95:.3f} real≥95 {fp95:.4f} AI≥99 {tp99:.3f} real≥99 {fp99:.4f}")
    print(f"{name:26s} | " + " | ".join(out))
