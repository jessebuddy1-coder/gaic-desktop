# Re-tabulate the shipped text model's out-of-corpus (LOCO) and held-out results for
# only the documents the live app accepts (live_app_text_gates.mjs), with the
# model's own decision cut points, and compare AUC with the app's 2.5.9 heuristic.
import json, collections, subprocess, numpy as np
from sklearn.metrics import roc_auc_score
import os
D=os.environ.get('GAIC_TEXT_DATA', 'data/text/')
dec=json.loads(subprocess.check_output(['node','-e','const fs=require("fs"),vm=require("vm");const c={};c.globalThis=c;vm.createContext(c);vm.runInContext(fs.readFileSync("runtime/text-detector.js","utf8"),c);console.log(JSON.stringify(c.AICheckTextEngine.model.decision))']))
gate={}
for l in open(D+'live_gates.jsonl'):
    r=json.loads(l); gate[r['doc']]=r
def tier(s):
    if s>=dec['threshold']: return 'ai', 'high' if s>=dec['aiHigh'] else 'medium' if s>=dec['aiMedium'] else 'low'
    return 'human', 'high' if s<=dec['humanHigh'] else 'medium' if s<=dec['humanMedium'] else 'low'
def table(rows, key):
    y=np.array([r['label'] for r in rows]); s=np.array([r[key] for r in rows]); old=np.array([gate[r['doc']]['heuristic'] for r in rows], float)
    wa, wh = 0.5/(y==1).sum(), 0.5/(y==0).sum()
    cnt=collections.Counter(tier(v)+(int(l),) for v,l in zip(s,y))
    tiers={}
    for lean in ('ai','human'):
        for conf in ('high','medium','low'):
            a=cnt[(lean,conf,1)]; h=cnt[(lean,conf,0)]
            if a+h==0: continue
            good=a*wa if lean=='ai' else h*wh
            tiers[lean+'-'+conf]=dict(share=round(a*wa+h*wh,4), correct=round(good/(a*wa+h*wh),4), ai=a, human=h)
    by=collections.defaultdict(list)
    for r in rows: by[r['corpus']].append(r)
    corpora={}
    for c, rr in sorted(by.items()):
        yy=np.array([r['label'] for r in rr]); ss=np.array([r[key] for r in rr]); oo=np.array([gate[r['doc']]['heuristic'] for r in rr], float)
        corpora[c]=dict(human=int((yy==0).sum()), ai=int((yy==1).sum()),
            human_lean_ai=round(float((ss[yy==0]>=dec['threshold']).mean()),4) if (yy==0).any() else None,
            ai_lean_ai=round(float((ss[yy==1]>=dec['threshold']).mean()),4) if (yy==1).any() else None,
            auc_heuristic_259=round(roc_auc_score(yy,oo),4) if len(set(yy))>1 else None,
            auc_model=round(roc_auc_score(yy,ss),4) if len(set(yy))>1 else None)
    return dict(documents=len(rows), human=int((y==0).sum()), ai=int((y==1).sum()),
        human_lean_ai=round(float((s[y==0]>=dec['threshold']).mean()),4), ai_lean_ai=round(float((s[y==1]>=dec['threshold']).mean()),4),
        auc_heuristic_259=round(roc_auc_score(y,old),4), auc_model=round(roc_auc_score(y,s),4), tiers=tiers, corpora=corpora)
oof=[r for r in json.load(open(D+'oof_K2500_B8.json')) if r['eligible'] and gate.get(r['doc'],{}).get('pass')]
held=[r for r in json.load(open(D+'js_scores.json')) if r['eligible'] and not r.get('train_ok', False) and gate.get(r['doc'],{}).get('pass')]
report=dict(decision=dec, gate_outcomes=dict(collections.Counter(g['why'] for g in gate.values())),
    out_of_corpus=table(oof,'score'), held_out=table(held,'logit'))
json.dump(report, open('results/live_app_text_gates.json','w'), indent=1)
print(json.dumps({k:{kk:vv for kk,vv in v.items() if kk not in ('tiers','corpora')} if isinstance(v,dict) and 'documents' in v else v for k,v in report.items()}, indent=1))
