"""Held-out frame and picture logits for every photo and screenshot.

Each group (AI family or real source) is scored by a head fitted without it,
exactly as for the published photo scores. For items where the worker's scan
v6 located a picture, the picture views' mean logit is recorded too, so the
app's composite decision can be reproduced."""
import json, numpy as np
from headdata import load_items, load_screens
from fasthead import fit_lin, img_weights
from train_rich import SLICES
sl = SLICES["rich"]
its = load_items(); scr = load_screens()
fams = sorted({i["family"] for i in its})
X = np.stack([i["ft"]["v5"].mean(0) for i in its])[:, sl]; y = np.array([i["label"] for i in its]); fam = np.array([i["family"] for i in its])
heads = {g: fit_lin(X[fam != g], y[fam != g], img_weights([its[k] for k in np.where(fam != g)[0]]), 0.005) for g in fams}
def score(h, feats): return float(h(feats.mean(0)[sl][None])[0])
out = {"photos": [], "screens": []}
for k, it in enumerate(its):
    h = heads[it["family"]]
    pic = score(h, it["ft"]["pic"]) if len(it["ft"]["pic"]) else None
    out["photos"].append([round(float(h(X[k][None])[0]), 4), None if pic is None else round(pic, 4)])
for it in scr:
    h = heads[it["family"]]
    pic = score(h, it["ft"]["pic"]) if len(it["ft"]["pic"]) else None
    out["screens"].append([it["file"].split("/")[-1].rsplit(".", 1)[0], int(it["label"]), it["template"], it["family"],
                           round(score(h, it["ft"]["v5"]), 4), None if pic is None else round(pic, 4)])
json.dump(out, open("../data/rfeat/composite_scores.json", "w"))
print("photos", len(out["photos"]), "with picture", sum(1 for f, p in out["photos"] if p is not None),
      "| screens", len(out["screens"]), "with picture", sum(1 for r in out["screens"] if r[5] is not None))
