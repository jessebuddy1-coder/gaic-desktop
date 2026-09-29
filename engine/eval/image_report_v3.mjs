// Every published photo and screenshot figure, computed by the app's own
// decision code on committed per-item held-out scores (each item scored by a
// head that never saw its group):
//   - detector-worker.js headResult(): direct or composite path (a located
//     picture), the image-head.js calibration table and composite rule, and
//     the worker's 4-decimal rounding;
//   - app.js headBandScore() for the evidence read's warning bands;
//   - provenance-verdict.mjs decideImageLean() for the lean and confidence,
//     with no metadata (the evaluation images carry none).
// Engine files come from engine/runtime. provenance-verdict.mjs imports the
// unchanged container-provenance.mjs, so GAIC_RUNTIME must point at a full
// runtime that has this engine applied (its provenance-verdict.mjs is checked
// against engine/runtime's).
//
//   GAIC_RUNTIME=<full runtime> node image_report_v3.mjs
//   -> prints the tables, writes results/image_v3_report.json
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const engineRuntime = path.join(here, "..", "runtime");
const full = process.env.GAIC_RUNTIME;
if (!full || !fs.existsSync(path.join(full, "container-provenance.mjs"))) {
  console.error("set GAIC_RUNTIME to a full runtime folder with this engine applied");
  process.exit(2);
}
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
if (sha(path.join(full, "provenance-verdict.mjs")) !== sha(path.join(engineRuntime, "provenance-verdict.mjs"))) {
  console.error("GAIC_RUNTIME's provenance-verdict.mjs is not engine/runtime's");
  process.exit(2);
}
const read = (name) => fs.readFileSync(path.join(engineRuntime, name), "utf8");

// The worker, with the shipped head.
const W = { console, importScripts() {}, addEventListener() {}, postMessage() {}, location: { href: "file:///w.js" } };
W.self = W; W.globalThis = W;
vm.createContext(W);
for (const name of ["model-config.js", "image-head.js", "detector-worker.js"]) {
  if (fs.existsSync(path.join(engineRuntime, name))) vm.runInContext(read(name), W, { filename: name });
}
// headBandScore, sliced from app.js exactly as the tests do.
const app = read("app.js");
const slice = (from, to) => app.slice(app.indexOf(from), app.indexOf(to));
const A = { console, window: {} };
A.globalThis = A;
vm.createContext(A);
vm.runInContext("(function(){ const IMAGE_AI_BAND = 99; const IMAGE_AI_ELEVATED_BAND = 95;\n" +
  slice("  // ---------- decisive result layer ----------", "  function setCheckButtonLabel") +
  "\nObject.assign(globalThis, { headBandScore }); })();", A);
const PV = await import(pathToFileURL(path.join(full, "provenance-verdict.mjs")).href);

function decide(frame, picture) {
  const head = W.headResult([frame], picture === null ? [] : [picture], false);
  const decision = PV.decideImageLean({
    provenance: { status: "absent", sourceClass: "unknown" },
    container: { hasC2PA: false, hasExif: false, hasXMP: false, derivedFromHEIF: false },
    metadata: { generatorTagged: false, generatorTagAmbiguous: false, generatorParameters: false, exif: {} },
    declarations: {},
    pixel: {
      available: true,
      rawScore: A.headBandScore(head.probability, head.cuts),
      probability: head.probability,
      cuts: head.cuts,
      scan: picture === null ? "direct-v5" : "composite-v6",
      elevatedBand: 95,
      warningBand: 99,
      compositeFrame: false,
    },
  });
  return { kind: head.kind, lean: decision.lean, confidence: decision.confidence };
}

const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
function rates(items, flag) {
  const groups = (label) => [...new Set(items.filter((it) => it.label === label).map((it) => it.group))].sort();
  const rate = (label, group) => {
    const members = items.filter((it) => it.label === label && it.group === group);
    return members.filter(flag).length / members.length;
  };
  const ai = Object.fromEntries(groups(1).map((g) => [g, rate(1, g)]));
  const real = Object.fromEntries(groups(0).map((g) => [g, rate(0, g)]));
  return { aiCalledAi: mean(Object.values(ai)), realCalledAi: mean(Object.values(real)), perAiGroup: ai, perRealGroup: real,
    worstRealGroup: Math.max(...Object.values(real)) };
}
function auc(labels, scores) {
  const order = scores.map((s, i) => [s, labels[i]]).sort((a, b) => a[0] - b[0]);
  let rankSum = 0, nPos = 0, i = 0;
  while (i < order.length) {
    let j = i;
    while (j < order.length && order[j][0] === order[i][0]) j += 1;
    const rank = (i + j + 1) / 2;
    for (let k = i; k < j; k += 1) if (order[k][1] === 1) { rankSum += rank; nPos += 1; }
    i = j;
  }
  const nNeg = order.length - nPos;
  return (rankSum - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}
function tiers(items) {
  const wa = 0.5 / items.filter((it) => it.label === 1).length, wr = 0.5 / items.filter((it) => it.label === 0).length;
  const cells = {};
  for (const it of items) {
    const key = `${it.lean} ${it.confidence}`;
    cells[key] ||= { ai: 0, real: 0 };
    cells[key][it.label === 1 ? "ai" : "real"] += 1;
  }
  const total = Object.values(cells).reduce((s, c) => s + c.ai * wa + c.real * wr, 0);
  return Object.fromEntries(Object.entries(cells).sort().map(([key, c]) => {
    const weight = c.ai * wa + c.real * wr;
    return [key, { share: weight / total, correct: (key.startsWith("ai") ? c.ai * wa : c.real * wr) / weight, ai: c.ai, real: c.real }];
  }));
}
const jsonl = (name) => fs.readFileSync(path.join(here, "results", name), "utf8").trim().split("\n").map((l) => JSON.parse(l));

// Photos.
const photos = jsonl("image_v3_held_out.jsonl").map((r) => {
  const picture = r.picture_logit_held_out ?? null;
  const d = decide(r.head_logit_held_out, picture);
  return { label: r.label, group: r.group.replace("real:", ""), frame: r.head_logit_held_out, picture, v2: r.v2_max_logit, ...d };
});
const photoRates = rates(photos, (it) => it.lean === "ai");
const located = photos.filter((it) => it.picture !== null);
// GAIC 2.4.0: a warning at a v2 score of 95 or more, and the v2 model at the same real false-lean rate.
const warning = rates(photos, (it) => it.v2 >= Math.log(95 / 5));
let sameRate = null;
for (const t of [...new Set(photos.map((it) => it.v2))].sort((a, b) => a - b)) {
  const r = rates(photos, (it) => it.v2 >= t);
  if (r.realCalledAi <= photoRates.realCalledAi && (!sameRate || r.aiCalledAi > sameRate.aiCalledAi)) sameRate = r;
}
const report = {
  photos: {
    n: photos.length,
    pictureLocated: located.length,
    ...photoRates,
    auc: auc(photos.map((it) => it.label), photos.map((it) => (it.picture === null ? it.frame : Math.max(it.frame, it.picture)))),
    confidence: tiers(photos),
  },
  gaic_2_4_0: { warningAiCalledAi: warning.aiCalledAi, warningRealCalledAi: warning.realCalledAi,
    auc: auc(photos.map((it) => it.label), photos.map((it) => it.v2)),
    sameRateAiCalledAi: sameRate.aiCalledAi, sameRateRealCalledAi: sameRate.realCalledAi, sameRatePerAiGroup: sameRate.perAiGroup },
};

// Screenshots.
const screens = jsonl("image_v3_screens_held_out.jsonl").map((r) => {
  const d = decide(r.frame_logit_held_out, r.picture_logit_held_out ?? null);
  return { label: r.label, group: r.template, template: r.template, frame: r.frame_logit_held_out,
    picture: r.picture_logit_held_out ?? null, ...d };
});
const flagged = (it) => it.lean === "ai";
const share = (list) => list.filter(flagged).length / list.length;
report.screenshots = {
  nAi: screens.filter((it) => it.label === 1).length,
  nReal: screens.filter((it) => it.label === 0).length,
  pictureLocated: screens.filter((it) => it.picture !== null).length / screens.length,
  aiCalledAi: share(screens.filter((it) => it.label === 1)),
  realCalledAi: share(screens.filter((it) => it.label === 0)),
  auc: auc(screens.map((it) => it.label), screens.map((it) => (it.picture === null ? it.frame : Math.max(it.frame, it.picture)))),
  perLayout: Object.fromEntries([...new Set(screens.map((it) => it.template))].sort().map((t) => [t, {
    aiCalledAi: share(screens.filter((it) => it.template === t && it.label === 1)),
    realCalledAi: share(screens.filter((it) => it.template === t && it.label === 0)),
  }])),
};
fs.writeFileSync(path.join(here, "results", "image_v3_report.json"), JSON.stringify(report, null, 1) + "\n");

const P = (v) => `${(100 * v).toFixed(1)}%`;
const o = report.photos, g = report.gaic_2_4_0, s = report.screenshots;
console.log(`photos n=${o.n} (picture located in ${o.pictureLocated}): AI called AI ${P(o.aiCalledAi)}, real called AI ${P(o.realCalledAi)}, worst real source ${P(o.worstRealGroup)}, AUC ${o.auc.toFixed(3)}`);
console.log(`  2.4.0 warning ${P(g.warningAiCalledAi)} / ${P(g.warningRealCalledAi)}; v2 at the same rate ${P(g.sameRateAiCalledAi)} / ${P(g.sameRateRealCalledAi)}; v2 AUC ${g.auc.toFixed(3)}`);
for (const [k, v] of Object.entries(o.perAiGroup).sort((a, b) => b[1] - a[1])) console.log(`  AI ${k.padEnd(18)} ${P(v).padStart(6)}  v2 same rate ${P(g.sameRatePerAiGroup[k]).padStart(6)}`);
for (const [k, v] of Object.entries(o.perRealGroup).sort((a, b) => a[1] - b[1])) console.log(`  real ${k.padEnd(22)} ${P(v)}`);
for (const [k, v] of Object.entries(o.confidence)) console.log(`  ${k.padEnd(12)} share ${P(v.share)} correct ${P(v.correct)} (ai ${v.ai}, real ${v.real})`);
console.log(`screenshots: AI called AI ${P(s.aiCalledAi)}, real called AI ${P(s.realCalledAi)}, AUC ${s.auc.toFixed(3)}, picture located ${P(s.pictureLocated)}`);
for (const [k, v] of Object.entries(s.perLayout)) console.log(`  ${k.padEnd(16)} ${P(v.aiCalledAi).padStart(6)} ${P(v.realCalledAi).padStart(6)}`);
