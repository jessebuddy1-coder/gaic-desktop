import json, numpy as np, sys
from sklearn.isotonic import IsotonicRegression
from headlib import confidence_table
def load(oof_path, held_path, oof_key="score", held_key="logit"):
    o=[r for r in json.load(open(oof_path)) if r['eligible']]
    js=[r for r in json.load(open(held_path)) if r['eligible'] and not r.get('train_ok', False)]
    return (np.array([r['label'] for r in o]), np.array([r[oof_key] for r in o]),
            np.array([r['label'] for r in js]), np.array([r[held_key] for r in js]))
def fit_knots(y, s, t, grid=np.arange(-4, 5.01, 0.25)):
    w=np.where(y==1,0.5/(y==1).sum(),0.5/(y==0).sum())
    iso=IsotonicRegression(y_min=0.005,y_max=0.995,increasing=True,out_of_bounds='clip').fit(s,y,sample_weight=w)
    p=iso.predict(grid); p=np.clip(p,0.005,0.995)
    # strictly increasing for invertibility: tiny ramp
    p=np.maximum.accumulate(p+np.arange(len(p))*1e-6)
    shift=np.log(np.interp(t,grid,p)/(1-np.interp(t,grid,p)))
    lo=np.log(p/(1-p))-shift
    return [[round(float(g),2), round(float(v),3)] for g,v in zip(grid, lo)]
def apply(knots, s):
    g=np.array([k[0] for k in knots]); v=np.array([k[1] for k in knots])
    return 1/(1+np.exp(-np.interp(s,g,v)))
if __name__=="__main__":
    y,s,yh,sh=load('../data/text/oof_K2500_B8.json','../data/text/js_scores.json')
    t=float(sys.argv[1]) if len(sys.argv)>1 else 0.8
    k=fit_knots(y,s,t); print(json.dumps(k))
    for name,yy,ss in (('LOCO',y,s),('heldout',yh,sh)):
        p=apply(k,ss); print(name, 'lean-AI rate AI %.3f human %.3f'%((p[yy==1]>=.5).mean(),(p[yy==0]>=.5).mean()))
        for row in confidence_table(p,yy): print('  %-5s %-6s share %.3f precision %.3f  (ai %d, human %d)'%row)

def tier_cuts(y, s, t, ai=(0.95, 0.85), human=(0.90, 0.75)):
    """raw-score cut points so each confidence bucket meets its balanced precision target (isotonic, LOCO)"""
    w=np.where(y==1,0.5/(y==1).sum(),0.5/(y==0).sum())
    iso=IsotonicRegression(y_min=0.0,y_max=1.0,out_of_bounds='clip').fit(s,y,sample_weight=w)
    grid=np.arange(-6,8,0.01); p=iso.predict(grid)
    def first_at_least(v): i=np.argmax(p>=v); return float(grid[i]) if p.max()>=v else float('inf')
    def last_at_most(v): i=np.where(p<=v)[0]; return float(grid[i[-1]]) if len(i) else float('-inf')
    return dict(t=t, ai_high=max(t, first_at_least(ai[0])), ai_medium=max(t, first_at_least(ai[1])),
                human_high=min(t, last_at_most(1-human[0])), human_medium=min(t, last_at_most(1-human[1])))

def tier_of(c, s):
    if s >= c['t']:
        return 'ai', 'high' if s >= c['ai_high'] else 'medium' if s >= c['ai_medium'] else 'low'
    return 'human', 'high' if s <= c['human_high'] else 'medium' if s <= c['human_medium'] else 'low'

def tier_report(c, y, s, name):
    import collections
    cnt=collections.Counter(); 
    for yy, ss in zip(y, s): cnt[tier_of(c, ss) + (int(yy),)] += 1
    wa, wh = 0.5/(y==1).sum(), 0.5/(y==0).sum()
    print(name)
    for lean in ('ai','human'):
        for conf in ('high','medium','low'):
            a=cnt[(lean,conf,1)]; h=cnt[(lean,conf,0)]
            if a+h==0: continue
            good = a*wa if lean=='ai' else h*wh
            print('  %-5s %-6s share %.3f precision %.3f (ai %d, human %d)'%(lean,conf,(a*wa+h*wh),good/(a*wa+h*wh),a,h))
