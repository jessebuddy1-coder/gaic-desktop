import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { read, RUNTIME } from "./helpers.mjs";

// A worker with browser pieces faked: canvases return grey pixels, the model
// session returns a fixed logit and a feature vector, and the decision head is
// a small known one. Drives the real message handler end to end.
function fakeWorker({ head, features = true, picture = false }) {
  const messages = [];
  let handler = null;
  class FakeContext {
    constructor(w, h) { this.w = w; this.h = h; }
    drawImage() {}
    fillRect() {}
    translate() {}
    scale() {}
    setTransform() {}
    getImageData(x, y, w, h) { return { data: new Uint8ClampedArray(w * h * 4).fill(128) }; }
  }
  class OffscreenCanvas {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() { return new FakeContext(this.width, this.height); }
  }
  class Tensor { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } }
  const dim = head ? head.dim : 4;
  const session = {
    inputNames: ["pixel_values"], outputNames: ["logit", "features"],
    async run() {
      const out = { logit: { data: new Float32Array([-1]) } };
      if (features) out.features = { data: new Float32Array(dim).fill(1) };
      return out;
    },
  };
  const ctx = {
    console, Math, Number, Array, Object, Promise, Float32Array, Uint8Array, Uint8ClampedArray, ArrayBuffer, JSON, Error, Map, Set,
    location: { href: "file:///detector-worker.js" },
    importScripts() {},
    addEventListener(type, fn) { if (type === "message") handler = fn; },
    postMessage(msg) { messages.push(msg); },
    OffscreenCanvas,
    Blob: class { constructor(parts, opts) { this.parts = parts; this.type = opts && opts.type; } },
    createImageBitmap: async () => ({ width: 1200, height: 900, close() {} }),
    ort: { env: {}, Tensor, InferenceSession: { create: async () => session } },
    AICHECK_IMAGE_HEAD: head,
  };
  ctx.self = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  // The reviewed preprocessing constants live in model-config.js.
  if (fs.existsSync(path.join(RUNTIME, "model-config.js"))) {
    vm.runInContext(read("model-config.js"), ctx, { filename: "model-config.js" });
  } else {
    ctx.AICHECK_ONNX = { size: 224, resizeShortest: 256, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225],
      output: "sigmoid", softmax: false, aiIndex: 0, regionScan: "whole-official-center-mid-lower-v5", maxRegions: 8 };
  }
  vm.runInContext(read("detector-worker.js"), ctx, { filename: "detector-worker.js" });
  if (picture) {
    // Force the composite path: pretend the localizer found a picture.
    vm.runInContext("locatePicture = function () { return { rect: { x: 200, y: 150, width: 800, height: 600 }, areaFrac: 0.44 }; };", ctx);
  }
  return {
    async detect(extra = {}) {
      messages.length = 0;
      await handler({ data: { id: 1, kind: "detect", bytes: new ArrayBuffer(16), type: "image/png", ...extra } });
      return messages;
    },
  };
}

const HEAD = {
  version: "test head", dim: 4, bias: -1, composite: "max",
  weights: [0.5, 0.5, 0.5, 0.5],
  calibration: {
    direct: { knots: [[-5, -5], [5, 5]], cuts: { aiHigh: 0.9, aiMedium: 0.75, realHigh: 0.1, realMedium: 0.25 } },
    composite: { knots: [[-5, -4], [5, 4]], cuts: { aiHigh: 0.9, aiMedium: 0.75, realHigh: 0.1, realMedium: 0.25 } },
    frame: { knots: [[-5, -3], [5, 3]], cuts: { aiHigh: 0.93, aiMedium: 0.8, realHigh: 0.07, realMedium: 0.2 } },
  },
};

function finalResult(messages) {
  const done = messages.filter((m) => !m.progress);
  assert.equal(done.length, 1, "exactly one final message");
  assert.ok(messages.indexOf(done[0]) === messages.length - 1, "progress messages come first");
  return done[0];
}

test("a photo returns the engine v2 scan plus a calibrated decision-head reading", async () => {
  const r = finalResult(await fakeWorker({ head: HEAD }).detect());
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(Number.isFinite(r.result.aiLikelihood));
  assert.equal(r.result.head.kind, "direct");
  assert.equal(r.result.head.logit, 1);               // -1 + 4 * 0.5
  assert.ok(Math.abs(r.result.head.probability - 1 / (1 + Math.exp(-1))) < 1e-3);
  assert.equal(r.result.head.views, r.result.regionScores.length);
});

test("a screenshot with a located picture reads its picture views too", async () => {
  const r = finalResult(await fakeWorker({ head: HEAD, picture: true }).detect());
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.regionScan, "content-aware-tta-v6");
  assert.equal(r.result.head.kind, "composite");
  assert.ok(r.result.head.views > 8);
});

test("video frames are calibrated as frames and skip the picture reading", async () => {
  const r = finalResult(await fakeWorker({ head: HEAD, picture: true }).detect({ composite: false }));
  assert.equal(r.ok, true);
  assert.equal(r.result.head.kind, "frame");
  assert.notEqual(r.result.regionScan, "content-aware-tta-v6");
});

test("without the head file or the feature output the v2 scan still answers", async () => {
  for (const worker of [fakeWorker({ head: undefined }), fakeWorker({ head: HEAD, features: false })]) {
    const r = finalResult(await worker.detect());
    assert.equal(r.ok, true);
    assert.equal(r.result.head, undefined);
    assert.ok(Number.isFinite(r.result.aiLikelihood));
  }
});

test("the shipped decision head is complete and its calibration is monotone", () => {
  const file = path.join(RUNTIME, "image-head.js");
  if (!fs.existsSync(file)) return;
  const ctx = { console };
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(read("image-head.js"), ctx, { filename: "image-head.js" });
  const H = ctx.AICHECK_IMAGE_HEAD;
  assert.equal(H.dim, 2304);
  assert.equal(H.weights.length, 2304);
  assert.ok(H.weights.every(Number.isFinite) && Number.isFinite(H.bias));
  assert.ok(["max", "picture", "mean"].includes(H.composite));
  for (const kind of ["direct", "composite", "frame"]) {
    const { knots, cuts } = H.calibration[kind];
    for (let i = 1; i < knots.length; i += 1) {
      assert.ok(knots[i][0] > knots[i - 1][0] && knots[i][1] >= knots[i - 1][1], kind + " knots monotone");
    }
    assert.ok(cuts.realHigh <= cuts.realMedium && cuts.realMedium < 0.5 && cuts.aiMedium >= 0.5 && cuts.aiMedium <= cuts.aiHigh);
  }
  const worker = read("detector-worker.js");
  assert.match(worker, /try \{ importScripts\("image-head\.js"\); \} catch \(_\) \{\}/);
});

test("the v3 model file is configured and exposes the head's feature size", () => {
  const cfg = read("model-config.js");
  if (!/aicheck-ai-image-v3-fp16\.onnx/.test(cfg)) return;
  const model = path.join(RUNTIME, "models", "aicheck-ai-image-v3-fp16.onnx");
  if (!fs.existsSync(model)) return;
  const bytes = fs.readFileSync(model);
  assert.ok(bytes.includes(Buffer.from("features")), "feature output present");
  assert.ok(bytes.includes(Buffer.from("logit")), "logit output present");
});
