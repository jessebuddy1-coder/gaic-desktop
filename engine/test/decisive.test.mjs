import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { pathToFileURL } from "node:url";
import { read, RUNTIME, appSection } from "./helpers.mjs";

// provenance-verdict.mjs imports container-provenance.mjs, which the engine
// update does not change; run these checks against a full runtime.
const full = fs.existsSync(path.join(RUNTIME, "container-provenance.mjs"));
const PV = full ? await import(pathToFileURL(path.join(RUNTIME, "provenance-verdict.mjs")).href) : null;
const CUTS = { aiHigh: 0.7668, aiMedium: 0.5, realHigh: 0.0162, realMedium: 0.0425 };
const pixel = (p, extra = {}) => ({ available: true, rawScore: p * 100, probability: p, cuts: CUTS,
  elevatedBand: 95, warningBand: 99, ...extra });

test("the lean and the displayed likelihood never disagree at 50%", { skip: !full }, () => {
  for (const p of [0.4951, 0.49999, 0.5, 0.50001, 0.5049]) {
    const r = PV.decideImageLean({ pixel: pixel(p) });
    assert.equal(r.lean, p >= 0.5 ? "ai" : "real");
    assert.ok(r.lean === "ai" ? r.probabilityAi >= 0.5 : r.probabilityAi <= 0.49);
  }
});

test("signed records decide; weak metadata alone never does", { skip: !full }, () => {
  assert.deepEqual([PV.decideImageLean({ provenance: { status: "valid", sourceClass: "ai" } }).lean,
    PV.decideImageLean({ provenance: { status: "valid", sourceClass: "ai" } }).confidence], ["ai", "high"]);
  const trusted = PV.decideImageLean({ provenance: { status: "trusted", sourceClass: "capture" }, pixel: pixel(0.2) });
  assert.equal(trusted.lean, "real");
  const exifOnly = { container: { hasExif: true }, metadata: { exif: { make: "Canon" } } };
  assert.equal(PV.decideImageLean(exifOnly), null, "one EXIF field with no pixel read is a failed check");
  assert.equal(PV.decideImageLean({}), null);
});

test("measured confidence cuts survive metadata, and metadata cannot flip a warning-band reading", { skip: !full }, () => {
  const exif = { container: { hasExif: true }, metadata: { exif: { make: "Canon", model: "EOS", exposureTime: 0.01,
    fNumber: 4, isoSpeed: 200, focalLength: 50, dateTimeOriginal: "2024:01:01 10:00:00", dateTime: "2024:01:01 10:00:00" } } };
  const plain = PV.decideImageLean({ pixel: pixel(0.2) });
  const withMinimal = PV.decideImageLean({ pixel: pixel(0.2), container: { hasExif: true }, metadata: { exif: { make: "X" } } });
  assert.equal(plain.confidence, "low");
  assert.equal(withMinimal.confidence, "low", "a stray EXIF field does not upgrade confidence");
  const warned = PV.decideImageLean({ ...exif, pixel: pixel(0.8, { rawScore: 99.2 }) });
  assert.equal(warned.lean, "ai");
});

test("ambiguous tool names in metadata count for less than named generators", { skip: !full }, () => {
  const named = PV.decideImageLean({ pixel: pixel(0.1), metadata: { generatorTagged: true } });
  const ambiguous = PV.decideImageLean({ pixel: pixel(0.1), metadata: { generatorTagged: true, generatorTagAmbiguous: true } });
  assert.ok(ambiguous.probabilityAi < named.probabilityAi);
  assert.equal(ambiguous.lean, "real");
});

// The decisive layer and the result copy, sliced from app.js.
function appContext() {
  const ctx = { console, window: {} };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext("(function(){ const IMAGE_AI_BAND = 99; const IMAGE_AI_ELEVATED_BAND = 95;\n" +
    appSection("  // ---------- decisive result layer ----------", "  function setCheckButtonLabel") +
    appSection("  function plainResultCopy(out) {", "  function resultSummary(out) {") +
    "\nObject.assign(globalThis, { applyDecision, headBandScore, plainResultCopy, fallbackLean }); })();", ctx);
  return ctx;
}

test("warning bands of the evidence read follow the head's confidence levels", () => {
  const { headBandScore } = appContext();
  assert.ok(headBandScore(0.8, CUTS) >= 99);
  assert.ok(headBandScore(0.6, CUTS) >= 95 && headBandScore(0.6, CUTS) < 99);
  assert.ok(headBandScore(0.3, CUTS) < 95);
});

test("a signed AI record never claims a pixel warning the scan did not find", () => {
  const ctx = appContext();
  for (const band of ["below", "none"]) {
    const out = { kind: "image", verdict: "Validated AI-origin claim — verify context", pixelBand: band };
    ctx.applyDecision(out, { lean: "ai", confidence: "high", aiLikelihood: 99 });
    const copy = ctx.plainResultCopy(out);
    assert.doesNotMatch(copy, /also found/);
    assert.match(copy, band === "none" ? /not scanned/ : /checked the pixels separately/);
  }
  const fb = ctx.fallbackLean(0.4999);
  assert.equal(fb.lean, "real");
  assert.ok(fb.probabilityAi <= 0.49);
});

test("no shipped result wording is undecided", () => {
  const banned = /inconclusive|no conclusion|could not make a clear call|could not decide|not a probability|no numeric score|no clear (ai )?warning|no clear result/i;
  for (const name of ["app.js", "is-this-ai.js", "is-this-ai.html", "ai-detector.html", "native.js", "provenance-verdict.mjs", "text-detector.js"]) {
    const file = path.join(RUNTIME, name);
    if (!fs.existsSync(file)) continue;
    // The stored tier id "portal-scan-inconclusive" is data, never shown.
    const text = fs.readFileSync(file, "utf8").replace(/"portal-scan-inconclusive"/g, "");
    const hit = text.split("\n").find((line) => banned.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line));
    assert.equal(hit, undefined, name + ": " + (hit || "").trim().slice(0, 120));
  }
});
