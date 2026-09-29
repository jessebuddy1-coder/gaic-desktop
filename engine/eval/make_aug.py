# Social-media style copies: downscale + JPEG re-encode, so a head cannot learn
# "PNG/uncompressed = AI" or "JPEG = real". Usage: make_aug.py <list> <outdir> <seed>
import sys, os, random, hashlib
from PIL import Image
lst, outdir, seed = sys.argv[1], sys.argv[2], int(sys.argv[3])
os.makedirs(outdir, exist_ok=True)
out = []
for f in open(lst).read().split():
    h = hashlib.md5((f + str(seed)).encode()).hexdigest()
    rnd = random.Random(h)
    dst = os.path.join(outdir, h[:16] + ".jpg")
    if not os.path.exists(dst):
        try:
            im = Image.open(f); im.load()
            if im.mode != "RGB":
                bg = Image.new("RGB", im.size, (255, 255, 255))
                im = im.convert("RGBA"); bg.paste(im, mask=im.split()[3]); im = bg
            side = rnd.choice([640, 800, 1080, 1280, 1600, 2048])
            s = side / max(im.size)
            if s < 1: im = im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))), Image.LANCZOS)
            im.save(dst, "JPEG", quality=rnd.randint(62, 94), subsampling=rnd.choice([0, 2, 2]))
        except Exception as e:
            print("skip", f, e, file=sys.stderr); continue
    out.append(f + "\t" + dst)
open(os.path.join(outdir, "pairs.tsv"), "w").write("\n".join(out) + "\n")
print(len(out))
