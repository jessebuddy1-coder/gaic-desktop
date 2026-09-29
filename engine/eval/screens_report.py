import json, numpy as np
import calib_image as CI
from headdata import load_items, load_screens
from fasthead import fit_lin, img_weights
from train_rich import SLICES
from headlib import auc
h=json.load(open("../data/rfeat/final_head.json")); sl=SLICES["rich"]
its=load_items(); scr=load_screens()
fams=sorted({i["family"] for i in its})
X=np.stack([i["ft"]["v5"].mean(0) for i in its])[:, sl]; y=np.array([i["label"] for i in its]); fam=np.array([i["family"] for i in its])
heads={g: fit_lin(X[fam!=g], y[fam!=g], img_weights([its[k] for k in np.where(fam!=g)[0]]), 0.005) for g in fams}
rows=[]
for it in scr:
    f=heads[it["family"]]
    fr=float(f(it["ft"]["v5"].mean(0)[sl][None])[0])
    if len(it["ft"]["pic"]):
        pc=float(f(it["ft"]["pic"].mean(0)[sl][None])[0]); z=max(fr,pc); p=CI.apply_knots(h["calibration"]["composite"]["knots"], np.array([z]))[0]
    else:
        z=fr; p=CI.apply_knots(h["calibration"]["direct"]["knots"], np.array([z]))[0]
    rows.append((it["label"], it["template"], p, it["ft"]["v5logit"].max(), it.get("family")))
lab=np.array([r[0] for r in rows]); p=np.array([r[2] for r in rows]); old=np.array([r[3] for r in rows]); tpl=np.array([r[1] for r in rows])
o95=np.log(0.95/0.05)
out={"n_ai": int((lab==1).sum()), "n_real": int((lab==0).sum()),
     "new_ai": float((p[lab==1]>=.5).mean()), "new_real": float((p[lab==0]>=.5).mean()),
     "auc_new": float(auc(lab,p)), "auc_old": float(auc(lab,old)),
     "per_template": {t: [float((p[(tpl==t)&(lab==1)]>=.5).mean()), float((p[(tpl==t)&(lab==0)]>=.5).mean())] for t in sorted(set(tpl))}}
print(json.dumps(out, indent=1))
json.dump(out, open("../data/rfeat/screens_summary.json","w"))
