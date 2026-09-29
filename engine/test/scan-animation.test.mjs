// The scanning viewfinder: worker progress messages, the stage queue, preview
// URL lifetime, privacy of the result, and the reduced-motion design.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { read, appSection, functionSource, RUNTIME } from "./helpers.mjs";

const app = read("app.js");
const html = read("ai-detector.html");
const css = read("styles.css");
const tick = () => new Promise((resolve) => setImmediate(resolve));

// ---------- detector-worker.js: progress is a side channel ----------

function fakeWorkerRealm() {
  const posted = [];
  let onMessage = null;
  class OffscreenCanvas {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() {
      return {
        fillRect() {}, drawImage() {}, translate() {}, scale() {}, setTransform() {}, clearRect() {},
        getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      };
    }
  }
  const ctx = {
    console, URL, Blob, TextEncoder,
    importScripts() {},
    addEventListener(type, fn) { if (type === "message") onMessage = fn; },
    postMessage(message) { posted.push(JSON.parse(JSON.stringify(message))); },
    location: { href: "http://localhost/detector-worker.js" },
    OffscreenCanvas,
    createImageBitmap: async () => ({ width: 1200, height: 800, close() {} }),
    AICHECK_ONNX: { resizeShortest: 256 },
  };
  ctx.self = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  if (fs.existsSync(path.join(RUNTIME, "model-config.js"))) {
    vm.runInContext(read("model-config.js"), ctx, { filename: "model-config.js" });
  }
  ctx.ort = {
    env: { wasm: {} },
    Tensor: class { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } },
    InferenceSession: {
      create: async () => ({ inputNames: ["x"], outputNames: ["y"], run: async () => ({ y: { data: [0.3, 0.7] } }) }),
    },
  };
  vm.runInContext(read("detector-worker.js"), ctx, { filename: "detector-worker.js" });
  const buffer = (n) => vm.runInContext("new ArrayBuffer(" + n + ")", ctx);
  return { ctx, posted, send: (data) => onMessage({ data }), buffer };
}

function assertUnitRect(rect) {
  assert.ok(rect && typeof rect === "object");
  for (const key of ["x", "y", "width", "height"]) assert.ok(Number.isFinite(rect[key]), key);
  assert.ok(rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0);
  assert.ok(rect.x + rect.width <= 1.0001 && rect.y + rect.height <= 1.0001);
}

test("the worker names each view before reading it, then answers once", async () => {
  const worker = fakeWorkerRealm();
  await worker.send({ id: 7, kind: "detect", composite: true, bytes: worker.buffer(64), type: "image/png" });
  const progress = worker.posted.filter((m) => m.progress);
  const answers = worker.posted.filter((m) => !m.progress);
  assert.equal(answers.length, 1);
  assert.equal(answers[0].ok, true);
  assert.equal(worker.posted[worker.posted.length - 1], answers[0], "the answer comes last");
  assert.deepEqual(progress.slice(0, 2).map((m) => m.progress.phase), ["model-ready", "decoded"]);
  const regions = progress.filter((m) => m.progress.phase === "region");
  assert.equal(regions.length, answers[0].result.regionScores.length);
  regions.forEach((m, i) => {
    assert.equal(m.id, 7);
    assert.equal(m.progress.index, i);
    assert.equal(m.progress.total, regions.length);
    assertUnitRect(m.progress.rect);
  });
  assert.deepEqual(regions[0].progress.rect, { x: 0, y: 0, width: 1, height: 1 }, "whole frame first");
  for (const m of progress) {
    assert.deepEqual(Object.keys(m).sort(), ["id", "progress"]);
    assert.deepEqual(Object.keys(m.progress).sort(), ["index", "phase", "rect", "total"]);
  }
});

test("worker results carry no progress or geometry", async () => {
  const worker = fakeWorkerRealm();
  await worker.send({ id: 3, kind: "detect", composite: true, bytes: worker.buffer(64), type: "image/jpeg" });
  const answer = worker.posted.find((m) => !m.progress);
  assert.ok(answer && answer.ok);
  assert.doesNotMatch(JSON.stringify(answer), /"rect"|"progress"|"x":|"sourceX"/);
});

test("the compatibility batch reports each region by position", async () => {
  const worker = fakeWorkerRealm();
  const size = 224 * 224 * 4;
  await worker.send({
    id: 11, kind: "detect-rgba", sourceWidth: 640, sourceHeight: 480,
    regions: [
      { id: "whole", pixels: worker.buffer(size), width: 224, height: 224 },
      { id: "center", pixels: worker.buffer(size), width: 224, height: 224 },
    ],
  });
  const phases = worker.posted.map((m) => (m.progress ? m.progress.phase + ":" + m.progress.index : "answer"));
  assert.deepEqual(phases, ["model-ready:0", "region:0", "region:1", "answer"]);
  assert.equal(worker.posted[1].progress.rect, null, "rectangles are added on the page that measured them");
});

test("progress rectangles are fractions of the source image", () => {
  const { ctx } = fakeWorkerRealm();
  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(ctx.progressRect(300, 0, 600, 400, 1200, 800)), { x: 0.25, y: 0, width: 0.5, height: 0.5 });
  assert.equal(ctx.progressRect(0, 0, 10, 10, 0, 0), null);
  // A picture view is a 224 px crop of the picture resized to 256 on its short side.
  const rect = ctx.viewProgressRect({ x: 100, y: 100, width: 512, height: 512 }, { resize: 256, fx: 0.5, fy: 0.5 }, 1000, 1000);
  assert.deepEqual(plain(rect), { x: 0.132, y: 0.132, width: 0.448, height: 0.448 });
});

// ---------- onnx-detector.js: progress never settles a request ----------

function detectorRealm() {
  const timers = new Map();
  let timerId = 0;
  const workers = [];
  class Worker {
    constructor(url) { this.url = url; this.posted = []; this.listeners = {}; workers.push(this); }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    postMessage(message) { this.posted.push(message); }
    terminate() {}
    emit(data) { for (const fn of this.listeners.message || []) fn({ data }); }
  }
  const ctx = {
    console, TextEncoder, Worker,
    setTimeout: (fn, ms) => { timerId += 1; timers.set(timerId, { fn, ms }); return timerId; },
    clearTimeout: (id) => { timers.delete(id); },
    requestAnimationFrame: (fn) => setImmediate(fn),
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(read("onnx-detector.js"), ctx, { filename: "onnx-detector.js" });
  const file = { size: 32, type: "image/png", arrayBuffer: async () => new ArrayBuffer(32) };
  return { detector: ctx.OnnxDetector, workers, timers, file };
}

test("progress messages reach onProgress and never resolve the request", async () => {
  const { detector, workers, timers, file } = detectorRealm();
  const seen = [];
  let settled = false;
  const pending = detector.detect(file, { onProgress: (p) => seen.push(p) });
  pending.then(() => { settled = true; });
  await tick();
  const worker = workers[0];
  const id = worker.posted[0].id;
  const armed = [...timers.values()].filter((t) => t.ms === 90000).length;
  worker.emit({ id, progress: { phase: "model-ready", index: 0, total: 0, rect: null } });
  worker.emit({ id, progress: { phase: "region", index: 0, total: 8, rect: { x: 0, y: 0, width: 1, height: 1 } } });
  worker.emit({ id, progress: { phase: "region", index: 1, total: 8, rect: { x: 0.5, y: 0, width: 0.9, height: 1 } } });
  worker.emit({ id, progress: { phase: "not-a-phase", index: 2, total: 8 } });
  worker.emit({ id, progress: { phase: "region", index: -4, total: 1e9, rect: "x" } });
  await tick();
  assert.equal(settled, false, "a progress message must not settle the request");
  assert.equal(detector.lastError, "", "a progress message is not a failure");
  assert.deepEqual(JSON.parse(JSON.stringify(seen)), [
    { phase: "model-ready", index: 0, total: 0, rect: null },
    { phase: "region", index: 0, total: 8, rect: { x: 0, y: 0, width: 1, height: 1 } },
    { phase: "region", index: 1, total: 8, rect: null },
    { phase: "region", index: 0, total: 0, rect: null },
  ]);
  assert.equal([...timers.values()].filter((t) => t.ms === 90000).length, armed, "the timeout restarts, never stacks");
  const result = { aiLikelihood: 0.25, regionScores: [{ id: "whole", aiLikelihood: 0.25 }] };
  worker.emit({ id, ok: true, result });
  assert.deepEqual(JSON.parse(JSON.stringify(await pending)), result, "the result is the worker's, untouched");
  assert.equal(timers.size, 0, "no timeout left behind");
});

test("a failing progress callback cannot fail a check", async () => {
  const { detector, workers, file } = detectorRealm();
  const pending = detector.detect(file, { onProgress: () => { throw new Error("ui"); } });
  await tick();
  const worker = workers[0];
  const id = worker.posted[0].id;
  worker.emit({ id, progress: { phase: "region", index: 0, total: 1, rect: null } });
  worker.emit({ id, ok: true, result: { aiLikelihood: 0.5 } });
  assert.equal((await pending).aiLikelihood, 0.5);
});

// ---------- app.js: stage queue ----------

function clock() {
  const state = { now: 0, id: 0, timers: [] };
  return {
    state,
    now: () => state.now,
    setTimer(fn, ms) { state.id += 1; state.timers.push({ id: state.id, at: state.now + ms, fn }); return state.id; },
    clearTimer(id) { state.timers = state.timers.filter((t) => t.id !== id); },
    advance(ms) {
      const end = state.now + ms;
      for (;;) {
        state.timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const next = state.timers[0];
        if (!next || next.at > end) break;
        state.timers.shift();
        state.now = next.at;
        next.fn();
      }
      state.now = end;
    },
  };
}
function loadQueue() {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext("const SCAN_DWELL_MS = 420;\n" +
    appSection("  function createStageQueue(render, options) {", "  // What each stage says.") +
    "\nglobalThis.createStageQueue = createStageQueue;", ctx);
  return ctx.createStageQueue;
}

test("stages keep their true order and each stays up for the dwell", () => {
  const createStageQueue = loadQueue();
  const c = clock();
  const shown = [];
  const q = createStageQueue((stage, inPlace) => shown.push([c.now(), stage.text, inPlace]), { dwell: 420, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  q.push({ id: "read", text: "A" });
  q.push({ id: "metadata", text: "B" });
  q.push({ id: "credentials", text: "C" });
  c.advance(2000);
  assert.deepEqual(shown, [[0, "A", false], [420, "B", false], [840, "C", false]]);
});

test("rapid updates of one stage coalesce instead of queueing", () => {
  const createStageQueue = loadQueue();
  const c = clock();
  const shown = [];
  const q = createStageQueue((stage, inPlace) => shown.push([c.now(), stage.text, stage.say, inPlace]), { dwell: 400, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  q.push({ id: "structure", text: "S" });
  for (let i = 1; i <= 5; i += 1) q.push({ id: "region", text: "R" + i, say: i === 1 ? "Scanning" : "" });
  q.push({ id: "weigh", text: "W" });
  assert.equal(q.size, 2, "five region ticks became one queued stage");
  c.advance(100);
  q.push({ id: "weigh", text: "W2" });
  c.advance(2000);
  assert.deepEqual(shown, [[0, "S", undefined, false], [400, "R5", "Scanning", false], [800, "W2", undefined, false]]);
});

test("an in-place update restarts the dwell so the latest detail is readable", async () => {
  const createStageQueue = loadQueue();
  const c = clock();
  const shown = [];
  const q = createStageQueue((stage, inPlace) => shown.push([c.now(), stage.text, inPlace]), { dwell: 400, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  q.push({ id: "region", text: "R1" });
  c.advance(1000);
  q.push({ id: "region", text: "R2" });
  let idle = false;
  q.idle().then(() => { idle = true; });
  q.push({ id: "weigh", text: "W" });
  c.advance(399);
  await tick();
  assert.equal(idle, false);
  c.advance(401);
  await tick();
  assert.deepEqual(shown, [[0, "R1", false], [1000, "R2", true], [1400, "W", false]]);
  assert.equal(idle, true, "idle resolves once the last stage has had its dwell");
  // An update that lands mid-dwell also restarts it.
  shown.length = 0;
  q.push({ id: "region", text: "R3" });
  c.advance(300);
  q.push({ id: "region", text: "R4" });
  q.push({ id: "weigh", text: "W2" });
  c.advance(1000);
  assert.deepEqual(shown.map(([t, text]) => [t - 1800, text]), [[0, "R3"], [300, "R4"], [700, "W2"]]);
  q.clear();
  assert.equal(q.size, 0);
});

// ---------- app.js: viewfinder lifetime (fake DOM) ----------

class FakeElement {
  constructor(tag, id) {
    this.tagName = String(tag).toUpperCase(); this.id = id || ""; this.children = []; this.parentNode = null;
    this.style = {}; this.dataset = {}; this.attributes = {}; this.hidden = false; this._text = ""; this.className = "";
    this.clientWidth = 260; this.clientHeight = 150;
    const self = this;
    this.classList = {
      add: (...names) => { for (const n of names) if (!self.classList.contains(n)) self.className = (self.className + " " + n).trim(); },
      remove: (...names) => { self.className = self.className.split(/\s+/).filter((c) => c && !names.includes(c)).join(" "); },
      contains: (n) => self.className.split(/\s+/).includes(n),
    };
  }
  get firstChild() { return this.children[0] || null; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(value) { this.children = []; this._text = String(value); }
  appendChild(node) { if (node.parentNode) node.parentNode.removeChild(node); node.parentNode = this; this.children.push(node); return node; }
  removeChild(node) { this.children = this.children.filter((c) => c !== node); node.parentNode = null; return node; }
  get nextElementSibling() { const s = this.parentNode ? this.parentNode.children : []; return s[s.indexOf(this) + 1] || null; }
  get previousElementSibling() { const s = this.parentNode ? this.parentNode.children : []; return s[s.indexOf(this) - 1] || null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }
  removeAttribute(name) { delete this.attributes[name]; }
  scrollIntoView() {}
  querySelectorAll(selector) {
    const cls = (selector.match(/^\.([\w-]+)/) || [])[1];
    const needsW = selector.includes("[data-w]");
    const out = [];
    const walk = (node) => { for (const c of node.children) { if (c.classList.contains(cls) && (!needsW || c.dataset.w)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
}

function loadScanSection({ reduced = false } = {}) {
  const c = clock();
  const ids = ["analyzing", "analyzing-view", "analyzing-stage", "analyzing-stage-text", "analyzing-stage-sr",
    "analyzing-progress", "analyzing-progress-bar", "scan-progress", "scan-progress-track", "result"];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement("div", id)]));
  elements["scan-progress-track"].setAttribute("role", "progressbar");
  elements["analyzing-progress"].setAttribute("aria-hidden", "true");
  elements.analyzing.hidden = true;
  const urls = { made: [], revoked: [] };
  const ctx = {
    console,
    Date: { now: c.now },
    setTimeout: (fn, ms) => c.setTimer(fn, ms || 0),
    clearTimeout: (id) => c.clearTimer(id),
    requestAnimationFrame: (fn) => c.setTimer(fn, 16),
    URL: {
      createObjectURL: () => { const u = "blob:preview-" + (urls.made.length + 1); urls.made.push(u); return u; },
      revokeObjectURL: (u) => { urls.revoked.push(u); },
    },
    document: { createElement: (tag) => new FakeElement(tag) },
    window: { matchMedia: () => ({ matches: reduced }), addEventListener() {}, removeEventListener() {} },
    announce() {},
    normalizeTextForAnalysis: (v) => String(v || ""),
    imageDimensions: () => ({ width: 400, height: 300 }),
    $: (id) => elements[id] || null,
  };
  ctx.global = ctx.window;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  const section = appSection("  // ---------- analyzing state: the on-device scan viewfinder ----------", "  async function run() {");
  vm.runInContext("let pickedFile = null;\n" + section +
    "\nglobalThis.api = { setAnalyzing, finishAnalyzing, scanStage, scanShowPicture, scanReleasePreviews, scanFrame," +
    " scanModelProgress, scanDetectOptions, scanPanelProgress, scanPreviewText, scan, pick: (f) => { pickedFile = f; } };", ctx);
  return { api: ctx.api, elements, urls, clock: c };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
const mediaOf = (elements) => elements["analyzing-view"].children.filter((c) => c.classList.contains("analyzing-media"));
const load = (media, w = 400, h = 300) => { const shot = media.children[0]; shot.naturalWidth = w; shot.naturalHeight = h; shot.onload(); };

test("preview URLs are revoked on teardown, idempotently", async () => {
  const { api, elements, urls, clock: c } = loadScanSection();
  api.pick({ name: "photo.jpg", type: "image/jpeg", size: 1000, slice: () => ({ arrayBuffer: async () => new ArrayBuffer(16) }) });
  api.setAnalyzing(true, "image");
  await settle();   // the preview waits for the header size check
  assert.equal(urls.made.length, 1);
  const [media] = mediaOf(elements);
  load(media);
  assert.ok(media.classList.contains("is-ready"));
  assert.match(media.style.width, /%$/);
  api.setAnalyzing(false);
  assert.deepEqual(urls.revoked, ["blob:preview-1"]);
  assert.equal(elements["analyzing-view"].children.length, 0);
  api.setAnalyzing(false);
  api.scanReleasePreviews();
  c.advance(5000);
  assert.deepEqual(urls.revoked, ["blob:preview-1"], "never revoked twice");
});

test("a newer frame retires older ones and their URLs, never the reverse", () => {
  const { api, elements, urls, clock: c } = loadScanSection();
  api.setAnalyzing(true, "screen");
  api.scanFrame({ name: "f1.png" }, 0, 3);
  api.scanFrame({ name: "f2.png" }, 1, 3);
  api.scanFrame({ name: "f3.png" }, 2, 3);
  const [m1, m2, m3] = mediaOf(elements);
  load(m3);           // the newest arrives first
  load(m1);           // a stale frame loading late must not replace it
  c.advance(1000);
  assert.deepEqual(mediaOf(elements), [m3]);
  assert.ok(!m2.parentNode && !m1.parentNode);
  assert.deepEqual(urls.revoked.slice().sort(), ["blob:preview-1", "blob:preview-2"]);
  api.setAnalyzing(false);
  assert.deepEqual(urls.revoked.slice().sort(), ["blob:preview-1", "blob:preview-2", "blob:preview-3"]);
});

test("a new pick releases preview URLs", () => {
  assert.match(functionSource(app, "acceptImage"), /scanReleasePreviews\(\);\s*pickedFile = file;/);
});

test("exactly one progressbar is exposed, before, during, and after a scan", () => {
  const { api, elements } = loadScanSection();
  const roles = () => Object.values(elements).filter((e) => e.getAttribute("role") === "progressbar").map((e) => e.id);
  assert.deepEqual(roles(), ["scan-progress-track"]);
  api.setAnalyzing(true, "video");
  assert.deepEqual(roles(), ["analyzing-progress"]);
  assert.equal(elements["analyzing-progress"].getAttribute("aria-hidden"), null);
  assert.equal(elements["scan-progress"].hidden, true);
  assert.equal(api.scanPanelProgress(0.5), true, "the frame bar feeds the panel bar while it is open");
  assert.equal(elements["scan-progress"].hidden, true);
  assert.equal(elements["analyzing-progress"].getAttribute("aria-valuenow"), "48");
  api.setAnalyzing(false);
  assert.deepEqual(roles(), ["scan-progress-track"]);
  assert.equal(elements["analyzing-progress"].getAttribute("aria-hidden"), "true");
  assert.equal(api.scanPanelProgress(0.5), false);
});

test("region ticks move the box but only major steps are announced", async () => {
  const { api, elements, clock: c } = loadScanSection();
  api.pick({ name: "photo.jpg", type: "image/jpeg", size: 1000, slice: () => ({ arrayBuffer: async () => new ArrayBuffer(16) }) });
  api.setAnalyzing(true, "image");
  await settle();
  load(mediaOf(elements)[0]);
  const said = [];
  const sr = elements["analyzing-stage-sr"];
  const opts = api.scanDetectOptions();
  opts.onProgress({ phase: "model-ready", index: 0, total: 0, rect: null });
  opts.onProgress({ phase: "decoded", index: 0, total: 3, rect: null });
  for (let i = 0; i < 3; i += 1) {
    opts.onProgress({ phase: "region", index: i, total: 3, rect: { x: 0.1 * i, y: 0, width: 0.5, height: 0.5 } });
    c.advance(450);
    said.push(sr.textContent);
  }
  api.scanStage("weigh");
  c.advance(450);
  said.push(sr.textContent);
  assert.deepEqual([...new Set(said)], ["Scanning the image in 3 regions", "Weighing the evidence"]);
  const marks = mediaOf(elements)[0].children.find((n) => n.classList.contains("analyzing-marks"));
  const locks = marks.children.filter((n) => n.classList.contains("analyzing-lock"));
  assert.ok(locks.length >= 1);
  const last = locks[locks.length - 1];
  assert.deepEqual([last.style.left, last.style.top, last.style.width, last.style.height], ["20%", "0%", "50%", "50%"]);
  api.setAnalyzing(false);
});

test("UI hooks are inert when no scan is showing and never throw", () => {
  const { api, urls } = loadScanSection();
  api.scanStage("metadata");
  api.scanFrame({}, 0, 8);
  api.scanPreviewText("words ".repeat(300));
  api.scanDetectOptions().onProgress({ phase: "region", index: 0, total: 8, rect: { x: 0, y: 0, width: 1, height: 1 } });
  api.scanDetectOptions().onProgress(null);
  assert.equal(urls.made.length, 0);
});

// ---------- privacy and truthful narration ----------

test("no preview, rectangle, or stage reaches a result object", () => {
  const section = appSection("  // ---------- analyzing state: the on-device scan viewfinder ----------", "  async function run() {")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(section, /lastResult|shareResult|readResult|speak\(|showResult|countsTowardLimit/);
  for (const name of ["analyzeImage", "analyzeVideo", "analyzeScreenFrames", "showResult", "readResult", "shareResult"]) {
    const src = functionSource(app, name);
    assert.doesNotMatch(src, /\bscan\.|\.rect\b|createObjectURL\(file\)[^;]*;\s*\w+\.preview|analyzing-view/, name);
  }
  // The only scan calls inside the pipeline are the one-line hooks.
  const hooks = functionSource(app, "analyzeImage").match(/\bscan\w+\(/g) || [];
  assert.deepEqual([...new Set(hooks)].sort(), ["scanDetectOptions(", "scanStage("]);
});

test("narration names only checks that actually run", () => {
  const image = functionSource(app, "analyzeImage");
  assert.match(image, /if \(!derivedFromHEIF && window\.C2PAVerifier[^{]*\{[^}]*scanStage\("credentials"\);\s*const checked = await window\.C2PAVerifier\.verify\(file\);/);
  assert.match(image, /if \(!locallyDerived && window\.ContainerProvenance[\s\S]{0,300}\) \{\s*scanStage\("structure"\);/);
  const screen = functionSource(app, "analyzeScreenFrames") + functionSource(app, "runScreenCheck");
  assert.doesNotMatch(screen, /scanStage\("(credentials|metadata|structure)"\)/);
  assert.match(functionSource(app, "runScreenCheck"), /setAnalyzing\(true, "screen"\)/);
  assert.match(functionSource(app, "run"), /setAnalyzing\(true, isVideoFile\(pickedFile\) \? "video" : "image"\)/);
});

test("analyzeDurationFor keeps its contract", () => {
  const src = functionSource(app, "analyzeDurationFor");
  assert.match(src, /function analyzeDurationFor\(kind\) \{ if \(prefersReducedMotion\(\)\) return 350;/);
  assert.match(app, /reconcileUsageForWeek, analyzeDurationFor,/);
});

test("the panel markup keeps one live region and decorative layers hidden", () => {
  assert.match(html, /<div class="analyzing-frame" aria-hidden="true">\s*<div class="analyzing-view" id="analyzing-view"><\/div>/);
  assert.match(html, /<p class="analyzing-stage" id="analyzing-stage" aria-live="polite"><span class="analyzing-stage-text" id="analyzing-stage-text" aria-hidden="true"><\/span><span class="analyzing-stage-sr" id="analyzing-stage-sr"><\/span><\/p>/);
  assert.match(html, /<div class="analyzing-progress" id="analyzing-progress" aria-hidden="true">/);
  assert.equal((html.match(/role="progressbar"/g) || []).length, 1);
  assert.doesNotMatch(html, /<script>[^<]*scan/i, "no inline script for the panel");
});

// ---------- styles.css: compositor-only motion and a static reduced state ----------

function cssBlocks(text) {
  // Minimal CSS reader: [{ at, selector, body }] with nested @media blocks.
  const src = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  const walk = (s, at) => {
    let i = 0;
    while (i < s.length) {
      const open = s.indexOf("{", i);
      if (open < 0) break;
      const head = s.slice(i, open).trim();
      let depth = 1, j = open + 1;
      while (j < s.length && depth) { if (s[j] === "{") depth += 1; else if (s[j] === "}") depth -= 1; j += 1; }
      const body = s.slice(open + 1, j - 1);
      if (head.startsWith("@media")) walk(body, head);
      else out.push({ at, selector: head, body });
      i = j;
    }
  };
  walk(src, "");
  return out;
}
const scanCss = css.slice(css.indexOf("/* analyzing beat"), css.indexOf("/* result upsell"));

test("every animated panel rule has a static reduced-motion rule", () => {
  const blocks = cssBlocks(scanCss);
  const reduced = blocks.filter((b) => /prefers-reduced-motion/.test(b.at));
  const still = new Set();
  for (const b of reduced) {
    if (/(^|;)\s*(animation\s*:\s*none|display\s*:\s*none)/.test(b.body)) {
      for (const sel of b.selector.split(",")) still.add(sel.replace(/\s+/g, " ").trim());
    }
  }
  const animated = blocks.filter((b) => !b.at && !b.selector.startsWith("@keyframes") && /(^|;)\s*animation\s*:\s*(?!none)/.test(b.body));
  assert.ok(animated.length >= 20, "found the panel animations");
  for (const b of animated) {
    for (const sel of b.selector.split(",")) {
      const key = sel.replace(/\s+/g, " ").trim();
      assert.ok(still.has(key), "no reduced-motion rule for " + key);
    }
  }
  // The reduced state is designed, not merely frozen: the picture shows in
  // full colour and only the current region box is drawn.
  const body = reduced.map((b) => b.selector + "{" + b.body + "}").join("\n");
  assert.match(body, /\.analyzing-media\.is-ready\{opacity:1\}/);
  assert.match(body, /\.analyzing-veil,\.analyzing-beam,\.analyzing-flash[^{]*\{display:none\}/);
  assert.match(body, /\.analyzing-lock\.is-done\{display:none\}/);
});

test("panel keyframes animate only transform and opacity", () => {
  const frames = scanCss.match(/@keyframes aicheck-[\w-]+\{(?:[^{}]*\{[^{}]*\})*\}/g) || [];
  assert.ok(frames.length >= 15);
  for (const kf of frames) {
    const props = [...kf.matchAll(/\{([^{}]*)\}/g)].flatMap((m) => m[1].split(";").map((d) => d.split(":")[0].trim()).filter(Boolean));
    for (const p of props) assert.ok(p === "transform" || p === "opacity", kf.slice(0, 40) + " animates " + p);
  }
  assert.doesNotMatch(scanCss, /@property|@container|:has\(|transition\s*:\s*(width|height|left|top|filter)/);
});
