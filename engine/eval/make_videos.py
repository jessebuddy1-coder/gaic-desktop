"""Build slideshow test videos from held-out images (pipeline test, not real AI video).
Each 8 s, 1280x720, 24 fps VP9 clip letterboxes/pillarboxes one image and adds
one nuisance: v0 fade in/out, v1 a 1.5 s black title card, v2 fades at a low
bitrate. Usage: python3 make_videos.py <image manifest.json> <out dir> [n per class]"""
import json, os, random, subprocess, sys, hashlib
import imageio_ffmpeg

FF = imageio_ffmpeg.get_ffmpeg_exe()
manifest, out_dir = sys.argv[1], sys.argv[2]
n = int(sys.argv[3]) if len(sys.argv) > 3 else 30
os.makedirs(out_dir, exist_ok=True)
random.seed(21)
items = json.load(open(manifest))
ai = [x for x in items if x["label"] == 1]; real = [x for x in items if x["label"] == 0]
random.shuffle(ai); random.shuffle(real)
fit = "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p"
out = []
for i, it in enumerate(ai[:n] + real[:n]):
    variant = i % 3
    dst = os.path.join(out_dir, hashlib.sha1(it["file"].encode()).hexdigest()[:12] + f"_v{variant}.webm")
    enc = ["-r", "24", "-c:v", "libvpx-vp9", "-b:v", "600k" if variant == 2 else "2M", "-deadline", "realtime", "-cpu-used", "8", dst]
    if variant == 1:
        cmd = [FF, "-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=1280x720:d=1.5:r=24",
               "-loop", "1", "-t", "6.5", "-i", it["file"], "-filter_complex",
               f"[1:v]{fit},fps=24[v1];[0:v]format=yuv420p,setsar=1[v0];[v0][v1]concat=n=2:v=1:a=0[v]", "-map", "[v]"] + enc
    else:
        cmd = [FF, "-y", "-loglevel", "error", "-loop", "1", "-i", it["file"], "-vf",
               f"{fit},fade=t=in:st=0:d=0.8,fade=t=out:st=7.2:d=0.8", "-t", "8"] + enc
    if subprocess.run(cmd, capture_output=True).returncode == 0:
        out.append(dict(file=os.path.abspath(dst), label=it["label"], source=it["source"], variant=variant, image=it["file"]))
json.dump(out, open(os.path.join(out_dir, "manifest.json"), "w"), indent=0)
print(len(out), "videos")
