// Exploration harness: for each image compute model logits for a superset of
// candidate views on two subjects (whole frame, localized picture), so that
// scan plans and aggregation rules can be compared offline.
// Usage: node explore_views.cjs <list.txt> <out.jsonl>
const fs = require("fs");
const path = require("path");
const ort = require("onnxruntime-node");
const { createCanvas, loadImage } = require("@napi-rs/canvas");
const { localizeContent } = require("./localizer.js");

const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
const SIZE = 224;

function roundHalfToEven(v) { const f = Math.floor(v); const d = v - f; if (d === 0.5) return f % 2 === 0 ? f : f + 1; return Math.round(v); }

// Resize the subject so its shortest side is `short`, then take a 224 crop at
// (fx, fy) in [0,1] of the free range; optional horizontal flip.
const resizeCache = new Map();
function renderView(img, rect, short, fx, fy, flip) {
  const w = rect.width, h = rect.height;
  const s = Math.min(w, h), l = Math.max(w, h);
  const rl = Math.floor(short * l / s);
  const rw = w <= h ? short : rl, rh = w <= h ? rl : short;
  const key = [rect.x, rect.y, w, h, short].join(",");
  let resized = resizeCache.get(key);
  if (!resized) {
    resized = createCanvas(rw, rh);
    const rc = resized.getContext("2d");
    rc.imageSmoothingEnabled = true; rc.imageSmoothingQuality = "high";
    rc.drawImage(img, rect.x, rect.y, w, h, 0, 0, rw, rh);
    resizeCache.set(key, resized);
  }
  const cx = fx === 0.5 ? roundHalfToEven((rw - SIZE) / 2) : Math.round((rw - SIZE) * fx);
  const cy = fy === 0.5 ? roundHalfToEven((rh - SIZE) / 2) : Math.round((rh - SIZE) * fy);
  const out = createCanvas(SIZE, SIZE);
  const oc = out.getContext("2d");
  oc.imageSmoothingEnabled = false;
  if (flip) { oc.translate(SIZE, 0); oc.scale(-1, 1); }
  oc.drawImage(resized, cx, cy, SIZE, SIZE, 0, 0, SIZE, SIZE);
  return oc.getImageData(0, 0, SIZE, SIZE).data;
}

function toTensor(px) {
  const v = new Float32Array(3 * SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) for (let c = 0; c < 3; c++) v[c * SIZE * SIZE + i] = (px[i * 4 + c] / 255 - MEAN[c]) / STD[c];
  return v;
}

const VIEWS = [
  ["c256", 256, 0.5, 0.5, false], ["c256f", 256, 0.5, 0.5, true],
  ["tl256", 256, 0, 0, false], ["tr256", 256, 1, 0, false], ["bl256", 256, 0, 1, false], ["br256", 256, 1, 1, false],
  ["c232", 232, 0.5, 0.5, false], ["c288", 288, 0.5, 0.5, false], ["c288f", 288, 0.5, 0.5, true],
];

(async () => {
  const [, , listPath, outPath] = process.argv;
  const files = fs.readFileSync(listPath, "utf8").trim().split("\n");
  const done = new Set();
  if (fs.existsSync(outPath)) for (const l of fs.readFileSync(outPath, "utf8").trim().split("\n").filter(Boolean)) done.add(JSON.parse(l).file);
  const session = await ort.InferenceSession.create(path.join(__dirname, "runtime/models/aicheck-ai-image-v2-fp16.onnx"), { executionProviders: ["cpu"], intraOpNumThreads: 4 });
  const inName = session.inputNames[0], outName = session.outputNames[0];
  const out = fs.createWriteStream(outPath, { flags: "a" });
  const t0 = Date.now(); let n = 0;
  for (const file of files) {
    if (done.has(file)) continue;
    let img;
    try { img = await loadImage(fs.readFileSync(file)); } catch (e) { out.write(JSON.stringify({ file, error: "decode" }) + "\n"); continue; }
    const W = img.width, H = img.height;
    const sc = Math.min(1, 512 / Math.max(W, H));
    const lw = Math.max(1, Math.round(W * sc)), lh = Math.max(1, Math.round(H * sc));
    const lc = createCanvas(lw, lh); const lx = lc.getContext("2d");
    lx.imageSmoothingEnabled = true; lx.imageSmoothingQuality = "high";
    lx.drawImage(img, 0, 0, lw, lh);
    const loc = localizeContent(lx.getImageData(0, 0, lw, lh).data, lw, lh);
    const subjects = { frame: { x: 0, y: 0, width: W, height: H } };
    if (loc) {
      const inset = 0.02;
      const rx = loc.x / sc, ry = loc.y / sc, rw = loc.width / sc, rh = loc.height / sc;
      subjects.picture = {
        x: Math.max(0, rx + rw * inset), y: Math.max(0, ry + rh * inset),
        width: Math.min(W, rw * (1 - 2 * inset)), height: Math.min(H, rh * (1 - 2 * inset)),
      };
    }
    resizeCache.clear();
    const rec = { file, W, H, loc: loc ? { ...loc, scale: sc } : null, views: {} };
    for (const [sname, rect] of Object.entries(subjects)) {
      rect.width = Math.floor(rect.width); rect.height = Math.floor(rect.height);
      if (Math.min(rect.width, rect.height) < 16) continue;
      const tensors = [], names = [];
      for (const [vname, short, fx, fy, flip] of VIEWS) {
        tensors.push(toTensor(renderView(img, rect, short, fx, fy, flip))); names.push(vname);
      }
      const batch = new Float32Array(tensors.length * 3 * SIZE * SIZE);
      tensors.forEach((t, i) => batch.set(t, i * t.length));
      let logits;
      try {
        const res = await session.run({ [inName]: new ort.Tensor("float32", batch, [tensors.length, 3, SIZE, SIZE]) });
        logits = Array.from(res[outName].data);
      } catch (e) {
        logits = [];
        for (const t of tensors) {
          const r = await session.run({ [inName]: new ort.Tensor("float32", t, [1, 3, SIZE, SIZE]) });
          logits.push(r[outName].data[0]);
        }
      }
      rec.views[sname] = Object.fromEntries(names.map((nm, i) => [nm, Math.round(logits[i] * 1e4) / 1e4]));
    }
    out.write(JSON.stringify(rec) + "\n");
    if (++n % 100 === 0) console.error(n, ((Date.now() - t0) / n).toFixed(0), "ms/img");
  }
  out.end();
  console.error("done", n);
})();
