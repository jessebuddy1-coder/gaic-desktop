"""Assemble every labelled image with its extracted features and its hold-out group."""
import json, os, glob, hashlib, collections
import numpy as np
from headlib import load_feats, load_rich
D = "../data"
OLD_FAMILY = {"gpt-4o/gpt-image": "openai", "gpt-4o": "openai", "gemini-2.5-flash-image": "google",
              "Kolors": "open-diffusion", "HunyuanDiT": "open-diffusion", "stable-diffusion": "open-diffusion",
              "PixArt-alpha": "open-diffusion", "generative-models": "open-diffusion"}

def manifest():
    man = {}
    for m in json.load(open(f"{D}/img/manifest.json")):
        m = dict(m); m["family"] = OLD_FAMILY.get(m.get("generator")) if m["label"] == 1 else "real:openimages"
        m["orig"] = m["file"]; man[m["file"]] = m
    for f in open(f"{D}/img/list_real_oi2.txt").read().split():
        man[f] = {"file": f, "label": 0, "source": "openimages2", "family": "real:openimages", "orig": f}
    for m in json.load(open(f"{D}/img/nonphoto/manifest.json")):
        m = dict(m); m["family"] = "real:graphics-synth"; m["orig"] = m["file"]; man[m["file"]] = m
    for m in json.load(open(f"{D}/img/pool_manifest.json")):
        man[m["file"]] = dict(m)
    for extra in ("photoreal_manifest.json", "docci_manifest.json"):
        if os.path.exists(f"{D}/img/{extra}"):
            for m in json.load(open(f"{D}/img/{extra}")):
                man[m["file"]] = dict(m)
    for p in ("aug_ai", "aug_real"):
        f = f"{D}/img/{p}/pairs.tsv"
        for line in open(f):
            a, b = line.rstrip("\n").split("\t")
            if a in man: m = dict(man[a]); m["file"] = b; m["orig"] = man[a]["orig"]; m["variant"] = "aug"; man[b] = m
    return man

RICH = ("pool", "direct", "nonphoto", "real_oi2", "aug_ai", "aug_real", "photoreal", "docci")
def rich_feats(names=RICH):
    feats = {}
    for n in names:
        for w in range(3): feats.update(load_rich(f"{D}/rfeat/{n}_{w}.jsonl"))
    return feats

def load_items(names=None, rich=True):
    man = manifest()
    if rich: feats = rich_feats(names or RICH)
    else:
        feats = {}
        for n in (names or ("direct", "real_oi2", "nonphoto", "poolA", "poolB", "aug_ai", "aug_real")): feats.update(load_feats(f"{D}/feat/{n}.jsonl"))
    out = []
    for f, ft in feats.items():
        m = man.get(f)
        if m is None or len(ft["v5"]) == 0 or m.get("family") in (None, "other"): continue
        out.append(dict(file=f, orig=m["orig"], label=int(m["label"]), family=m["family"], source=m.get("source"),
                        variant=m.get("variant", "original"), ft=ft))
    return out

def load_screens(rich=True):
    sm = json.load(open(f"{D}/img/screens/manifest.json")); man = manifest()
    feats = rich_feats(("screens",)) if rich else load_feats(f"{D}/feat/screens.jsonl"); out = []
    for m in sm:
        ft = feats.get(m["file"]); o = man.get(m["original"])
        if ft is None or o is None or len(ft["v5"]) == 0: continue
        out.append(dict(file=m["file"], orig=m["original"], label=int(m["label"]), family=o["family"],
                        template=m["template"], ft=ft))
    return out
