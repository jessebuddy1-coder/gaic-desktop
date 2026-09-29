"""Balanced, de-duplicated training/eval pool from the scout sets.
Each picked image gets one presentation variant (seeded by its path):
original bytes (50%), or a re-encoded copy (35% JPEG q60-95, 15% WEBP q60-95)
resized to a random long side and flattened on white, so no class can be told
apart by container, codec, or size."""
import json, os, random, hashlib, collections, sys
from PIL import Image
S = "../data/scout"; OUT = "../data/img/pool"; os.makedirs(OUT, exist_ok=True)
CAP_AI, CAP_REAL = 350, 400
m = json.load(open(f"{S}/scout_manifest.json"))

def family(x):
    g = (x.get("generator") or "").lower(); src = x["source"]
    if x["label"] == 0: return "real:" + src.replace("real_", "")
    if "mixed" in g or "comparison" in g or " or " in g or "cases" in g: return "mixed"
    if "gpt-image" in g or "gpt-4o" in g: return "openai"
    if "nano-banana" in g or "gemini" in g: return "google"
    if "midjourney" in g or "mj-v7" in g: return "midjourney"
    if "seedream" in g: return "seedream"
    if "ideogram" in g: return "ideogram"
    if "mai-image" in g: return "microsoft"
    if "flux" in g: return "flux"
    return "other"

def dhash(path):
    try:
        im = Image.open(path); im.draft("L", (64, 64)); im = im.convert("L").resize((9, 8), Image.BILINEAR)
    except Exception: return None
    px = list(im.getdata()); v = 0
    for r in range(8):
        for c in range(8): v = (v << 1) | (px[r * 9 + c] > px[r * 9 + c + 1])
    return v

rows = [x for x in m if x["label"] in (0, 1) and x.get("bytes", 0) > 30000 and x.get("reliability") not in ("low", "low-medium", "exclude")]
cells = collections.defaultdict(list)
for x in rows: cells[(x["label"], x["source"], x.get("generator"))].append(x)
picked = []
for key, xs in sorted(cells.items(), key=lambda kv: str(kv[0])):
    xs = sorted(xs, key=lambda x: hashlib.md5(x["file"].encode()).hexdigest())
    picked += xs[:CAP_AI if key[0] == 1 else CAP_REAL]
# near-duplicate removal (dHash Hamming <= 4) across everything picked
seen, out = [], []
for x in picked:
    h = dhash(x["file"])
    if h is None: continue
    if any(bin(h ^ s).count("1") <= 4 for s in seen): continue
    seen.append(h); out.append(x)
print("picked", len(picked), "after dedupe", len(out), file=sys.stderr)
res = []
for x in out:
    rnd = random.Random(hashlib.md5(("v" + x["file"]).encode()).hexdigest())
    u = rnd.random(); fam = family(x)
    rec = dict(file=x["file"], label=x["label"], source=x["source"], generator=x.get("generator"), family=fam, orig=x["file"], variant="original")
    if u >= 0.5:
        fmt = "JPEG" if u < 0.85 else "WEBP"
        dst = os.path.join(OUT, hashlib.md5(x["file"].encode()).hexdigest()[:16] + (".jpg" if fmt == "JPEG" else ".webp"))
        if not os.path.exists(dst):
            try:
                im = Image.open(x["file"]); im.load()
                if im.mode in ("RGBA", "LA", "P"):
                    im = im.convert("RGBA"); bg = Image.new("RGB", im.size, (255, 255, 255)); bg.paste(im, mask=im.split()[3]); im = bg
                else: im = im.convert("RGB")
                side = rnd.choice([640, 800, 1080, 1280, 1600, 2048]); s = side / max(im.size)
                if s < 1: im = im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))), Image.LANCZOS)
                im.save(dst, fmt, quality=rnd.randint(60, 95))
            except Exception as e:
                print("skip", x["file"], e, file=sys.stderr); continue
        rec.update(file=dst, variant=fmt.lower())
    res.append(rec)
json.dump(res, open("../data/img/pool_manifest.json", "w"))
c = collections.Counter((r["family"], r["label"]) for r in res)
for k, v in sorted(c.items()): print(v, k)
print("total", len(res))
