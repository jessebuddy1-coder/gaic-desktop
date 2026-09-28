// Featurize the text pool with the production engine (runtime/text-detector.js).
import fs from "fs";
import readline from "readline";
import vm from "vm";
const src = fs.readFileSync(new URL("./runtime/text-detector.js", import.meta.url), "utf8");
const ctx = { globalThis: {} }; ctx.globalThis = ctx; vm.createContext(ctx); vm.runInContext(src, ctx);
const E = ctx.AICheckTextEngine;
const [,, inPath, outPrefix, minDf = "40"] = process.argv;
const rows = [];
const rl = readline.createInterface({ input: fs.createReadStream(inPath) });
for await (const line of rl) rows.push(JSON.parse(line));
// Product gates mirrored from app.js analyzeText (applied to the legacy-normalized text).
function eligible(raw) {
  const text = raw.normalize("NFKC").replace(/[‘’ʼ]/g, "'").trim();
  if (text.length < 1000) return false;
  const sentences = text.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 0);
  if (sentences.length < 3) return false;
  const words = text.split(/\s+/).filter(Boolean);
  const lower = words.map(w => w.toLowerCase().replace(/[^a-z']/g, "")).filter(Boolean);
  return lower.length / words.length >= 0.7;
}
const df = new Map();
const chunked = rows.map((r) => {
  const text = E.normalize(r.text);
  const chunks = E.chunkText(text).map((c) => {
    const m = E.measure(c);
    return { dense: Array.from(m.dense, v => Math.round(v * 1e5) / 1e5), words: m.words.length, counts: E.lexicalCounts(m.words) };
  });
  if (r.train_ok) {
    const seen = new Set();
    for (const c of chunks) for (const k of c.counts.keys()) seen.add(k);
    for (const k of seen) df.set(k, (df.get(k) || 0) + 1);
  }
  return chunks;
});
const vocab = [...df.entries()].filter(([, c]) => c >= Number(minDf)).map(([k]) => k).sort();
const index = new Map(vocab.map((k, i) => [k, i]));
fs.writeFileSync(outPrefix + ".vocab.json", JSON.stringify(vocab));
const out = fs.createWriteStream(outPrefix + ".features.jsonl");
rows.forEach((r, i) => {
  const elig = eligible(r.text);
  for (const [ci, c] of chunked[i].entries()) {
    const lex = [];
    for (const [k, v] of c.counts) { const j = index.get(k); if (j !== undefined) lex.push([j, v]); }
    out.write(JSON.stringify({ doc: r.id, chunk: ci, label: r.label, corpus: r.corpus, domain: r.domain,
      generator: r.generator, variant: r.variant, train_ok: r.train_ok, eligible: elig, words: c.words,
      dense: c.dense, lex }) + "\n");
  }
});
out.end();
console.log("docs", rows.length, "vocab", vocab.length, "dense", E.DENSE_NAMES.length);
