import json, math, numpy as np, hashlib, collections
from sklearn.metrics import roc_auc_score
def lg(p): p=min(1-1e-9,max(1e-9,p)); return math.log(p/(1-p))
man={x['file']:x for x in json.load(open('../data/img/screens/manifest.json'))}
old={}
for l in open('../data/img/results/old_screens.jsonl'):
    r=json.loads(l)
    if r['ok']: old[r['file']]=lg(r['result']['aiLikelihood'])
ex={}
for l in open('../data/img/results/explore_screens.jsonl'):
    r=json.loads(l)
    if 'views' in r: ex[r['file']]=r
feat={json.loads(l)['file']:json.loads(l) for l in open('../data/img/results/locfeat_screens.jsonl')}
K4=('c256','c256f','tl256','br256')
def gated(f):
    x=feat[f]; return bool(x['loc']) and x['loc']['outsideBackground']>=0.9 and x['marks']<0.02
def v6(f):
    r=ex[f]
    if gated(f) and 'picture' in r['views']: return np.mean([r['views']['picture'][k] for k in K4]), True
    return None, False
files=sorted(set(old)&set(ex)); y=np.array([man[f]['label'] for f in files])
half=np.array([int(hashlib.sha1(f.encode()).hexdigest(),16)%2 for f in files])
zo=np.array([old[f] for f in files])
zn=[]; g=[]
for f in files:
    z,isg=v6(f); g.append(isg); zn.append(z if isg else old[f])  # hybrid: v5 when not gated
zn=np.array(zn); g=np.array(g)
t95=math.log(19); t99=math.log(99)
print('files', len(files), 'real', (y==0).sum(), 'gated share', g.mean().round(3))
print('AUC old', round(roc_auc_score(y,zo),3), 'hybrid v6 (b=0)', round(roc_auc_score(y,zn),3))
cal=half==0
for b in (0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0):
    zz=np.where(g, zn+b, zn)
    print(f"b={b}: cal real≥95 {int((zz[cal&(y==0)]>=t95).sum())} real≥99 {int((zz[cal&(y==0)]>=t99).sum())} | all real≥95 {int((zz[y==0]>=t95).sum())}/{(y==0).sum()} real≥99 {int((zz[y==0]>=t99).sum())} AI≥95 {np.mean(zz[y==1]>=t95):.3f} AI≥99 {np.mean(zz[y==1]>=t99):.3f}")
print(f"old: all real≥95 {int((zo[y==0]>=t95).sum())} real≥99 {int((zo[y==0]>=t99).sum())} AI≥95 {np.mean(zo[y==1]>=t95):.3f} AI≥99 {np.mean(zo[y==1]>=t99):.3f}; cal real≥95 {int((zo[cal&(y==0)]>=t95).sum())}")
