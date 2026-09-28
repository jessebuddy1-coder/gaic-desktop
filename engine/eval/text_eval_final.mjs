// Score every pool document with the SHIPPED runtime/text-detector.js (embedded model).
import fs from "fs"; import vm from "vm"; import readline from "readline";
const ctx = {}; ctx.globalThis = ctx; vm.createContext(ctx);
vm.runInContext(fs.readFileSync("runtime/text-detector.js", "utf8"), ctx);
const E = ctx.AICheckTextEngine;
const base = new Map();
for (const l of fs.readFileSync("../data/text/pool.baseline.jsonl", "utf8").trim().split("\n")) { const r = JSON.parse(l); base.set(r.doc, r.score); }
const elig = new Map();
for await (const l of readline.createInterface({ input: fs.createReadStream("../data/text/pool.features.jsonl") })) { const r = JSON.parse(l); if (!elig.has(r.doc)) elig.set(r.doc, r.eligible); }
const out = [];
for await (const l of readline.createInterface({ input: fs.createReadStream("../data/text/pool.jsonl") })) {
  const r = JSON.parse(l);
  const a = E.analyze(r.text);
  if (!a) continue;
  out.push({ doc: r.id, corpus: r.corpus, domain: r.domain, label: r.label, variant: r.variant, generator: r.generator,
    train_ok: r.train_ok, eligible: elig.get(r.id), logit: a.logit, score: a.score, band: a.band, old: base.get(r.id) });
}
fs.writeFileSync("../data/text/js_scores.json", JSON.stringify(out));
console.log("scored", out.length, "bands", JSON.stringify(E.model.bands));
