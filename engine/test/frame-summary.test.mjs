import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { appSection } from "./helpers.mjs";

const ctx = {};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext("(function(){ const IMAGE_AI_BAND = 99; const IMAGE_AI_ELEVATED_BAND = 95;\n" +
  appSection("  function frameSignalSummary(scores) {", "  // Score every captured frame") +
  "\nglobalThis.frameSignalSummary = frameSignalSummary; })();", ctx);
const summary = ctx.frameSignalSummary;

test("one spiky frame cannot raise a video to a warning", () => {
  const r = summary([2, 3, 1, 4, 2, 99.9, 3, 2]);
  assert.equal(r.score, null);
  assert.equal(r.verdict, "Sampled frames are inconclusive");
  assert.equal(r.maxScore, 99);
});

test("a consistent high signal survives one dropped-out frame", () => {
  const r = summary([99.8, 99.6, 99.9, 99.7, 5, 99.8, 99.9, 99.5]);
  assert.equal(r.verdict, "High model signal in sampled frames — verify");
  assert.ok(r.score >= 99);
});

test("empty input is null", () => {
  assert.equal(summary([]), null);
});
