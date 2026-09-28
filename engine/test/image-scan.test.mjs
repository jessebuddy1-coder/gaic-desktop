import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadWorker, read, functionSource, RUNTIME } from "./helpers.mjs";

const W = loadWorker();

// Deterministic pseudo-random "photo" texture.
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function frame(width, height, bg) {
  const px = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) px.set([bg[0], bg[1], bg[2], 255], i * 4);
  return px;
}
function paintPhoto(px, width, rect, seed) {
  const r = rng(seed);
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      const o = (y * width + x) * 4;
      const base = 60 + 120 * ((x - rect.x) / rect.w);
      px[o] = base + 80 * r(); px[o + 1] = 40 + 150 * r(); px[o + 2] = 200 * ((y - rect.y) / rect.h) + 40 * r();
    }
  }
}
// Text-like marks: thin 1-2 px strokes on the page color, as UI text renders.
function paintText(px, width, x0, y0, lines) {
  for (let l = 0; l < lines; l += 1) {
    for (let x = x0; x < x0 + 180; x += 1) {
      if (x % 4 !== 0) continue; // vertical stems
      for (let y = y0 + l * 12; y < y0 + l * 12 + 6; y += 1) px.set([20, 20, 20, 255], (y * width + x) * 4);
    }
    for (let x = x0; x < x0 + 180; x += 1) px.set([20, 20, 20, 255], ((y0 + l * 12 + 3) * width + x) * 4);
  }
}
function iou(a, b) {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return inter / (a.w * a.h + b.w * b.h - inter);
}

test("locates a picture inside a phone-style screenshot", () => {
  const width = 240, height = 512;
  const px = frame(width, height, [255, 255, 255]);
  const photo = { x: 0, y: 64, w: 240, h: 296 };
  paintPhoto(px, width, photo, 7);
  paintText(px, width, 16, 380, 6);
  paintText(px, width, 16, 12, 2);
  const found = W.localizeContent(px, width, height);
  assert.ok(found, "picture found");
  assert.ok(iou({ x: found.x, y: found.y, w: found.width, h: found.height }, photo) > 0.85);
  // Passes the composite gate: clean interface background, no other marks.
  assert.ok(found.outsideBackground >= 0.9);
  assert.ok(found.outsideMarks < 0.02);
});

test("removes letterbox bars around a video frame", () => {
  const width = 512, height = 288;
  const px = frame(width, height, [0, 0, 0]);
  const photo = { x: 96, y: 0, w: 320, h: 288 };
  paintPhoto(px, width, photo, 11);
  const found = W.localizeContent(px, width, height);
  assert.ok(found);
  assert.ok(iou({ x: found.x, y: found.y, w: found.width, h: found.height }, photo) > 0.85);
});

test("a full-bleed photo is not treated as a composite", () => {
  const width = 384, height = 256;
  const px = frame(width, height, [0, 0, 0]);
  paintPhoto(px, width, { x: 0, y: 0, w: width, h: height }, 3);
  assert.equal(W.localizeContent(px, width, height), null);
});

test("a text-only interface has no picture", () => {
  const width = 400, height = 300;
  const px = frame(width, height, [250, 250, 250]);
  for (let i = 0; i < 8; i += 1) paintText(px, width, 20, 20 + i * 30, 2);
  assert.equal(W.localizeContent(px, width, height), null);
});

// Reference: the reviewed v5 official center geometry from GAIC 2.4.0.
function v5OfficialCenter(width, height, resizeShortest, cropSize) {
  const short = Math.min(width, height), long = Math.max(width, height);
  const resizedLong = Math.floor(resizeShortest * long / short);
  const resizedWidth = width <= height ? resizeShortest : resizedLong;
  const resizedHeight = width <= height ? resizedLong : resizeShortest;
  if (resizedWidth < cropSize || resizedHeight < cropSize || resizedWidth > 8192 || resizedHeight > 8192) return null;
  const half = (v) => { const f = Math.floor(v); return v - f === 0.5 ? (f % 2 === 0 ? f : f + 1) : Math.round(v); };
  return { resizedWidth, resizedHeight, cropX: half((resizedWidth - cropSize) / 2), cropY: half((resizedHeight - cropSize) / 2) };
}

test("the v6 center view is exactly the reviewed v5 official center view", () => {
  const r = rng(99);
  for (let i = 0; i < 2000; i += 1) {
    const w = 1 + Math.floor(r() * 6000), h = 1 + Math.floor(r() * 6000);
    assert.equal(JSON.stringify(W.viewGeometry(w, h, 256, 224, 0.5, 0.5)), JSON.stringify(v5OfficialCenter(w, h, 256, 224)), `${w}x${h}`);
  }
});

test("corner views stay inside the resized subject", () => {
  for (const [w, h] of [[224, 224], [1000, 300], [300, 1000], [4032, 3024]]) {
    for (const [fx, fy] of [[0, 0], [1, 1]]) {
      const g = W.viewGeometry(w, h, 256, 224, fx, fy);
      assert.ok(g.cropX >= 0 && g.cropY >= 0 && g.cropX + 224 <= g.resizedWidth && g.cropY + 224 <= g.resizedHeight);
    }
  }
});

test("ordinary photos keep the exact GAIC 2.4.0 scan", () => {
  // sha256 (first 16 hex) of each v5 function's whitespace-normalized source.
  const pins = {
    "detector-worker.js": {
      buildRegionPlan: "69ce800c8bb484d7", officialCenterGeometry: "234c4422b2663699",
      tensorForRegion: "a4267ccc26b97213", aggregateRegionScores: "9d396527251f1205",
      boundedCrop: "2ff86f628819d7cb", neutralFill: "0ab1021d778ed6c8", resultScore: "87950c5651174dc7",
    },
    "onnx-detector.js": {
      buildCompatibilityRegionPlan: "32d5c2171b81ddc7", paintCompatibilityRegion: "f74d6f540173701e",
      officialCenterGeometry: "234c4422b2663699", boundedCrop: "6432345766fad8ca",
    },
  };
  for (const [file, names] of Object.entries(pins)) {
    const src = read(file);
    for (const [name, pin] of Object.entries(names)) {
      const digest = crypto.createHash("sha256").update(functionSource(src, name)).digest("hex").slice(0, 16);
      assert.equal(digest, pin, file + " " + name);
    }
  }
});

test("worker and iOS 15 fallback share one composite-frame plan", () => {
  const worker = read("detector-worker.js"), compat = read("onnx-detector.js");
  for (const name of ["viewGeometry", "blockStats", "bestRectangle", "stripBackground", "growRectangle", "localizeContent"]) {
    assert.equal(functionSource(compat, name), functionSource(worker, name), name);
  }
  const block = (src, name) => {
    const start = src.indexOf("const " + name + " = Object.freeze({");
    return src.slice(start, src.indexOf("});", start)).replace(/\s+/g, " ");
  };
  for (const name of ["PICTURE_SCAN", "LOCALIZER"]) assert.equal(block(compat, name), block(worker, name), name);
});

test("composite results use ids and fields the app understands", () => {
  const app = read("app.js");
  assert.match(app, /picture: "detected picture"/);
  assert.match(app, /m\.regionScan === "content-aware-tta-v6"/);
  const worker = read("detector-worker.js");
  assert.match(worker, /const PICTURE_SCAN_VERSION = "content-aware-tta-v6";/);
  assert.match(worker, /picture: "Detected picture"/);
  // Ordinary images keep the configured v5 scan; model-config.js is unchanged.
  if (fs.existsSync(path.join(RUNTIME, "model-config.js"))) {
    assert.match(read("model-config.js"), /regionScan: "whole-official-center-mid-lower-v5"/);
  }
});
