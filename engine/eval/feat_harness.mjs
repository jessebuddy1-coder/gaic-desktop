// Run the engine worker unmodified in Node, but load an ONNX copy that also
// outputs the 384-d CLS feature, and record every model call's feature.
// Usage: node feat_harness.mjs <runtimeDir> <feat.onnx> <list.txt> <out.jsonl> [composite=1]
import fs from "fs";
import path from "path";
import vm from "vm";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const ort = require("onnxruntime-node");
const { createCanvas, loadImage } = require("@napi-rs/canvas");

export async function loadFeatWorker(runtimeDir, featModel) {
  const handlers = [];
  let pending = null;
  let calls = [];
  const ctx = {
    console, URL, Blob, Map, Set, Math, Number, String, Array, Object, Promise, Float32Array,
    Uint8Array, Uint8ClampedArray, Float64Array, ArrayBuffer, JSON, Date, Error,
    setTimeout, clearTimeout,
    location: { href: "file://" + path.resolve(runtimeDir) + "/detector-worker.js" },
    importScripts: () => {},
    addEventListener: (type, fn) => { if (type === "message") handlers.push(fn); },
    // Progress messages ({ id, progress }) precede the one final result.
    postMessage: (msg) => { if (msg && msg.progress) return; if (pending) { const p = pending; pending = null; p(msg); } },
    OffscreenCanvas: function (w, h) { return createCanvas(Math.max(1, w | 0), Math.max(1, h | 0)); },
    createImageBitmap: async (blob) => {
      const img = await loadImage(Buffer.from(await blob.arrayBuffer()));
      img.close = () => {};
      return img;
    },
  };
  ctx.self = ctx;
  ctx.globalThis = ctx;
  ctx.ort = {
    env: {},
    Tensor: ort.Tensor,
    InferenceSession: {
      create: async () => {
        const s = await ort.InferenceSession.create(path.resolve(featModel), {
          executionProviders: ["cpu"], intraOpNumThreads: +(process.env.FEAT_THREADS || 4), interOpNumThreads: 1,
        });
        return {
          inputNames: s.inputNames,
          outputNames: s.outputNames,
          run: async (feeds) => {
            const out = await s.run(feeds);
            calls.push({ logit: out.logit.data[0], f: Float32Array.from(out.features.data) });
            return out;
          },
        };
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(runtimeDir, "model-config.js"), "utf8"), ctx);
  vm.runInContext(fs.readFileSync(path.join(runtimeDir, "detector-worker.js"), "utf8"), ctx);
  let seq = 0;
  return async function detect(bytes, type, composite = true) {
    const id = ++seq;
    calls = [];
    const done = new Promise((resolve) => { pending = resolve; });
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    for (const h of handlers) h({ data: { id, kind: "detect", bytes: ab, type, composite } });
    const msg = await done;
    const r = msg.result || {};
    let v5ids = [];
    try { v5ids = Array.from(ctx.buildRegionPlan(r.sourceWidth, r.sourceHeight), (x) => x.id); } catch (_) {}
    return { msg, calls, v5ids };
  };
}

const TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

if (process.argv[1] && process.argv[1].endsWith("feat_harness.mjs")) {
  const [, , runtimeDir, featModel, listPath, outPath, compositeArg] = process.argv;
  const composite = compositeArg !== "0";
  const files = fs.readFileSync(listPath, "utf8").trim().split("\n").filter(Boolean);
  const done = new Set();
  if (fs.existsSync(outPath)) {
    for (const line of fs.readFileSync(outPath, "utf8").trim().split("\n").filter(Boolean)) {
      try { done.add(JSON.parse(line).file); } catch (_) {}
    }
  }
  const binPath = outPath.replace(/\.jsonl$/, ".f32");
  let dim = 0;
  let nextVec = 0;
  const detect = await loadFeatWorker(runtimeDir, featModel);
  const t0 = Date.now();
  let n = 0;
  for (const file of files) {
    if (done.has(file)) continue;
    let rec;
    try {
      const bytes = fs.readFileSync(file);
      const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
      const { msg, calls, v5ids } = await detect(bytes, type, composite);
      const r = msg.result || {};
      if (!dim && calls.length) {
        dim = calls[0].f.length;
        nextVec = fs.existsSync(binPath) ? Math.floor(fs.statSync(binPath).size / (4 * dim)) : 0;
      }
      const offs = [];
      if (calls.length) {
        const buf = Buffer.alloc(calls.length * dim * 4);
        calls.forEach((c, i) => Buffer.from(c.f.buffer, c.f.byteOffset, c.f.byteLength).copy(buf, i * dim * 4));
        fs.appendFileSync(binPath, buf);
        for (let i = 0; i < calls.length; i++) offs.push(nextVec + i);
        nextVec += calls.length;
      }
      rec = { file, ok: msg.ok, code: msg.code, score: r.aiLikelihood, regionScan: r.regionScan,
        regions: (r.regionScores || []).map((x) => x.id), v5ids, w: r.sourceWidth, h: r.sourceHeight, dim,
        calls: calls.map((c, i) => ({ logit: c.logit, off: offs[i] })) };
    } catch (e) { rec = { file, ok: false, code: String(e).slice(0, 120), calls: [] }; }
    fs.appendFileSync(outPath, JSON.stringify(rec) + "\n");
    n += 1;
    if (n % 100 === 0) console.error(n, "files", ((Date.now() - t0) / n).toFixed(0), "ms/file");
  }
  console.error("done", n, "files in", ((Date.now() - t0) / 1000).toFixed(0), "s");
}
