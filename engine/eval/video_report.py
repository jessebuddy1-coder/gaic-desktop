import json, re, sys, numpy as np
from sklearn.metrics import roc_auc_score
man={x['file']:x for x in json.load(open('../data/video/manifest.json'))}
def parse(p):
    out={}
    for l in open(p):
        r=json.loads(l); ex=r.get('explain') or ''
        frames=[int(m) for m in re.findall(r'Frame \d+ of \d+ — (\d+)/100 model signal', ex)]
        blanks=len(re.findall(r'blank frame skipped', ex))
        med=re.search(r'median (\d+)/100', ex); mx=re.search(r'highest sampled frame (\d+)/100', ex)
        out[r['file']]=dict(frames=frames, blanks=blanks, median=int(med.group(1)) if med else None, max=int(mx.group(1)) if mx else None, score=r.get('score'), verdict=r.get('verdict'), picture=ex.count('letterbox or frame border excluded'))
    return out
for name in sys.argv[1:]:
    d=parse(name); fs=[f for f in d if d[f]['median'] is not None]
    y=np.array([man[f]['label'] for f in fs]); med=np.array([d[f]['median'] for f in fs]); mx=np.array([d[f]['max'] for f in fs])
    lowframes=sum(sum(1 for v in d[f]['frames'] if v<=1) for f in fs)
    print(f"{name}: videos {len(fs)} AUC(median) {roc_auc_score(y,med):.3f} AUC(max) {roc_auc_score(y,mx):.3f} | real median≥95 {int((med[y==0]>=95).sum())}/{(y==0).sum()} AI median≥95 {int((med[y==1]>=95).sum())}/{(y==1).sum()} | real max≥95 {int((mx[y==0]>=95).sum())} | frames scored {sum(len(d[f]['frames']) for f in fs)} blank-skipped {sum(d[f]['blanks'] for f in fs)} picture-mode frames {sum(d[f]['picture'] for f in fs)}")
