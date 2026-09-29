import test from "node:test";
import assert from "node:assert/strict";
import { read } from "./helpers.mjs";

const app = read("app.js");

test("video keeps the published sampling contract", () => {
  // privacy.html, terms.html, and support.html promise up to eight frames and
  // a median/maximum summary; the engine must keep those promises.
  assert.match(app, /const VIDEO_FRAME_SAMPLES = 8;/);
  assert.match(app, /const SCREEN_FRAME_SAMPLES = 8;/);
  assert.match(app, /metricLabel: "Median frame-model score"/);
});

test("blank frames are skipped and unchanged screen frames reuse a score", () => {
  assert.match(app, /if \(frameLooksBlank\(cv\)\) \{ note = "blank frame skipped"; continue; \}/);
  assert.match(app, /if \(frameLooksBlank\(cv, BLANK_SCREEN_MAX_STD\)\) return done\(null\);/);
  assert.match(app, /const BLANK_SCREEN_MAX_STD = 1;/);
  assert.match(app, /sameFrame\(previous\.fingerprint, fingerprint\)/);
});

test("the on-device-only block still has no network primitives", () => {
  const start = app.indexOf("/* ================ BEGIN ON-DEVICE-ONLY");
  const end = app.indexOf("/* ================= END ON-DEVICE-ONLY");
  assert.ok(start > 0 && end > start);
  assert.doesNotMatch(app.slice(start, end), /\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource/);
});

test("video frames keep the 2.4.0 scan; screenshots and screen frames may add the picture reading", () => {
  assert.match(app, /Object\.defineProperty\(frame, "aicheckScanHint", \{ value: "video-frame" \}\)/);
  const compat = read("onnx-detector.js"), worker = read("detector-worker.js");
  assert.match(compat, /composite: !\(file && file\.aicheckScanHint === "video-frame"\)/);
  assert.match(compat, /if \(!\(file && file\.aicheckScanHint === "video-frame"\)\) \{/);
  assert.match(worker, /decodedRegions\(request\.bytes, request\.type, request\.composite !== false(, request\.resize)?\)/);
  assert.match(worker, /if \(allowPicture\) \{\s*try \{ picture = locatePicture\(bitmap\); \}/);
});
