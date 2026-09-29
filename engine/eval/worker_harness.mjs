// Run a GAIC detector-worker.js file unmodified in Node: Skia canvas stands in
// for OffscreenCanvas/createImageBitmap and onnxruntime-node for ORT Web.
// Usage: node worker_harness.mjs <runtimeDir> <list.txt> <out.jsonl>
import fs from "fs";
import path from "path";
import vm from "vm";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const ort = require("onnxruntime-node");
const { createCanvas, loadImage } = require("@napi-rs/canvas");

export async function loadWorker(runtimeDir) {
  const handlers = [];
  let pending = null;
  const ctx = {
    console, URL, Blob, Map, Set, Math, Number, String, Array, Object, Promise, Float32Array,
    Uint8Array, Uint8ClampedArray, Float64Array, ArrayBuffer, JSON, Date, Error,
    setTimeout, clearTimeout,
    location: { href: "file://" + path.resolve(runtimeDir) + "/detector-worker.js" },
    // Only the decision head is loaded for real; ORT and the config are provided above.
    importScripts: (...names) => {
      for (const name of names) {
        if (name === "image-head.js" && fs.existsSync(path.join(runtimeDir, name))) {
          vm.runInContext(fs.readFileSync(path.join(runtimeDir, name), "utf8"), ctx);
        }
      }
    },
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
      create: (p) => ort.InferenceSession.create(path.resolve(runtimeDir, p), {
        executionProviders: ["cpu"], intraOpNumThreads: 4, interOpNumThreads: 1,
      }),
    },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(runtimeDir, "model-config.js"), "utf8"), ctx);
  vm.runInContext(fs.readFileSync(path.join(runtimeDir, "detector-worker.js"), "utf8"), ctx);
  let seq = 0;
  return async function detect(bytes, type) {
    const id = ++seq;
    const done = new Promise((resolve) => { pending = resolve; });
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    for (const h of handlers) h({ data: { id, kind: "detect", bytes: ab, type } });
    return done;
  };
}

const TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

if (process.argv[1] && process.argv[1].endsWith("worker_harness.mjs")) {
  const [, , runtimeDir, listPath, outPath] = process.argv;
  const files = fs.readFileSync(listPath, "utf8").trim().split("\n").filter(Boolean);
  const done = new Set();
  if (fs.existsSync(outPath)) {
    for (const line of fs.readFileSync(outPath, "utf8").trim().split("\n").filter(Boolean)) done.add(JSON.parse(line).file);
  }
  const out = fs.createWriteStream(outPath, { flags: "a" });
  const detect = await loadWorker(runtimeDir);
  const t0 = Date.now();
  let n = 0;
  for (const file of files) {
    if (done.has(file)) continue;
    const bytes = fs.readFileSync(file);
    const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
    let msg;
    try { msg = await detect(bytes, type); } catch (e) { msg = { ok: false, code: String(e).slice(0, 120) }; }
    out.write(JSON.stringify({ file, ok: msg.ok, code: msg.code, result: msg.result }) + "\n");
    n += 1;
    if (n % 50 === 0) console.error(n, "files", ((Date.now() - t0) / n).toFixed(0), "ms/file");
  }
  out.end();
  console.error("done", n, "files in", ((Date.now() - t0) / 1000).toFixed(0), "s");
}
