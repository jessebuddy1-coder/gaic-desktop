import json, math, numpy as np, hashlib
from sklearn.metrics import roc_auc_score
def lg(p): p=min(1-1e-9,max(1e-9,p)); return math.log(p/(1-p))
man={x['file']:x for x in json.load(open('../data/img/manifest.json'))}
old={}; new={}
for l in open('../data/img/results/old_asis.jsonl'):
    r=json.loads(l)
    if r['ok']: old[r['file']]={x['id']:lg(x['aiLikelihood']) for x in r['result']['regionScores']}
for l in open('../data/img/results/new_asis.jsonl'):
    r=json.loads(l)
    if r['ok']: new[r['file']]=lg(r['result']['aiLikelihood'])
files=sorted(set(old)&set(new)); y=np.array([man[f]['label'] for f in files])
half=np.array([int(hashlib.sha1(f.encode()).hexdigest(),16)%2 for f in files])
C=['top-left','top-right','bottom-left','bottom-right']
def m(f, keys): v=[old[f][k] for k in keys if k in old[f]]; return np.mean(v)
cands={
 'v5 max of 8 (old)': lambda f: max(old[f].values()),
 'corners4 mean': lambda f: m(f,C),
 'corners4+center mean': lambda f: m(f,C+['center']),
 'corners4+middle mean': lambda f: m(f,C+['middle-center']),
 'corners4+mid+lower mean': lambda f: m(f,C+['middle-center','lower-center']),
 'corners4+center+v6': lambda f: (sum(old[f][k] for k in C+['center'] if k in old[f]) + 4*new[f])/(5+4) ,
 'all8 except whole mean': lambda f: m(f,[k for k in old[f] if k!='whole']),
}
t95=math.log(95/5); t99=math.log(99)
zo=np.array([max(old[f].values()) for f in files])
print(f"{'plan':28s} AUC   | shift | TEST: real≥95 real≥99 AI≥95 AI≥99   | ALL: real≥95 real≥99 AI≥95 AI≥99")
for name,fn in cands.items():
    z=np.array([fn(f) for f in files]); auc=roc_auc_score(y,z)
    cal=(half==0)
    # largest shift keeping cal-half real counts at both bands <= old's
    best=0.0
    for b in np.arange(0,4.001,0.05):
        if ((z[cal&(y==0)]+b)>=t95).sum() <= (zo[cal&(y==0)]>=t95).sum() and ((z[cal&(y==0)]+b)>=t99).sum() <= (zo[cal&(y==0)]>=t99).sum(): best=b
    zz=z+best; te=half==1
    fmt=lambda Z,mask: f"{int((Z[mask&(y==0)]>=t95).sum())}/{int((mask&(y==0)).sum())} {int((Z[mask&(y==0)]>=t99).sum())} {np.mean(Z[mask&(y==1)]>=t95):.3f} {np.mean(Z[mask&(y==1)]>=t99):.3f}"
    print(f"{name:28s} {auc:.3f} | {best:4.2f} | {fmt(zz,te):32s} | {fmt(zz,np.ones_like(te,bool))}")
