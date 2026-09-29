// Mixed documents and disguise tricks, measured with the shipped
// runtime/text-detector.js on corpora it never trained on (pool rows with
// train_ok false: DetectRL, the detector-bias essays, ArguGPT).
//
// 1. False alarms: held-out human documents on their own, and 3, 6, or 10 of
//    them joined as one long text; how often the document leans AI and how
//    often a machine-like section is reported while it leans human.
// 2. Catches: three held-out human documents with one AI excerpt of about
//    150, 250, or 400 words (cut at a sentence end) pasted between them.
// 3. Disguise notice: RAID's zero-width-space and homoglyph attack variants
//    against the plain versions of the same corpus.
//
//   node mixed_text_eval.mjs ../data/text/pool.jsonl
import fs from "fs"; import vm from "vm"; import readline from "readline";
const ctx = {}; ctx.globalThis = ctx; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(new URL("../runtime/text-detector.js", import.meta.url), "utf8"), ctx);
const E = ctx.AICheckTextEngine;
let seed = 42; const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
const pick = (a) => a[Math.floor(rand() * a.length)];
const human = {}, singles = [], ai = [], raid = {};
for await (const line of readline.createInterface({ input: fs.createReadStream(process.argv[2]) })) {
  const r = JSON.parse(line);
  if (r.corpus === "raid" && ["plain", "attack:zero_width_space", "attack:homoglyph"].includes(r.variant)) (raid[r.variant] ||= []).push(r.text);
  if (r.train_ok) continue;
  if (r.label === 0 && r.variant === "plain" && r.text.length >= 1000) singles.push(r.text);
  if (r.label === 0 && r.variant === "plain" && r.text.length > 600) (human[r.corpus] ||= []).push(r.text);
  if (r.label === 1 && r.variant === "plain" && r.text.split(/\s+/).length > 420) ai.push(r.text);
}
const corpora = Object.keys(human).filter((k) => human[k].length > 50);
const excerpt = (text, words) => {
  const sentences = text.replace(/\s+/g, " ").match(/[^.!?]+[.!?]+["')\]]*\s*/g) || [text];
  let out = "", n = 0;
  for (const s of sentences) { out += s; n += s.split(/\s+/).filter(Boolean).length; if (n >= words) break; }
  return out.trim();
};
const read = (text) => { const a = E.analyze(text); return { ai: a.decision.lean === "ai", section: !!a.machineLikeSection, disguise: a.disguise }; };
const pct = (a, b) => `${(100 * a / b).toFixed(1)}%`;
const report = { falseAlarms: {}, catches: {}, disguise: {} };

for (const joined of [1, 3, 6, 10]) {
  let n = 0, lean = 0, section = 0;
  const count = joined === 1 ? singles.length : 1000;
  for (let i = 0; i < count; i += 1) {
    const text = joined === 1 ? singles[i] : Array.from({ length: joined }, () => pick(human[pick(corpora)])).join("\n\n");
    const r = read(text); n += 1; if (r.ai) lean += 1; else if (r.section) section += 1;
  }
  report.falseAlarms[`human x${joined}`] = { n, leanAi: lean / n, sectionReported: section / n };
  console.log(`human documents joined x${joined}: n=${n}, lean AI ${pct(lean, n)}, section reported ${pct(section, n)}`);
}
const TOKEN_RE = /[A-Za-z]+(?:['-][A-Za-z]+)*|\d+(?:[.,]\d+)*/g;
const tokens = (text) => (text.match(TOKEN_RE) || []).length;
const where = { reported: 0, precision: 0, recall: 0, openingInside: 0 };
for (const words of [150, 250, 400]) {
  let lean = 0, any = 0; const n = 1500;
  for (let i = 0; i < n; i += 1) {
    const docs = human[pick(corpora)];
    const parts = [pick(docs), pick(docs), pick(docs)];
    const at = 1 + Math.floor(rand() * 2), pasted = excerpt(pick(ai), words);
    parts.splice(at, 0, pasted);
    const a = E.analyze(parts.join("\n\n"));
    const r = { ai: a.decision.lean === "ai", section: a.machineLikeSection };
    if (r.ai) lean += 1; if (r.ai || r.section) any += 1;
    if (r.section) {
      // How well the reported words line up with the pasted text.
      const aiFirst = tokens(parts.slice(0, at).join("\n\n")) + 1, aiLast = aiFirst + tokens(pasted) - 1;
      const overlap = Math.max(0, Math.min(r.section.lastWord, aiLast) - Math.max(r.section.firstWord, aiFirst) + 1);
      where.reported += 1;
      where.precision += overlap / (r.section.lastWord - r.section.firstWord + 1);
      where.recall += overlap / (aiLast - aiFirst + 1);
      if (r.section.firstWord >= aiFirst && r.section.firstWord <= aiLast) where.openingInside += 1;
    }
  }
  report.catches[`${words} words`] = { n, documentLean: lean / n, leanOrSection: any / n };
  console.log(`AI excerpt of ~${words} words pasted in: document lean ${pct(lean, n)}, lean or section ${pct(any, n)}`);
}
report.location = { reported: where.reported, precision: where.precision / where.reported,
  recall: where.recall / where.reported, openingInside: where.openingInside / where.reported };
console.log(`reported sections: ${pct(where.precision, where.reported)} of their words were the pasted text, ` +
  `the quoted opening was inside it ${pct(where.openingInside, where.reported)} of the time, and they covered ${pct(where.recall, where.reported)} of it`);
for (const [variant, texts] of Object.entries(raid)) {
  const flagged = texts.filter((t) => E.disguiseCounts(t)).length;
  report.disguise[variant] = { n: texts.length, noticed: flagged / texts.length };
  console.log(`RAID ${variant}: disguise notice on ${pct(flagged, texts.length)} of ${texts.length}`);
}
const heldHuman = singles.filter((t) => E.disguiseCounts(t)).length;
report.disguise["held-out human documents"] = { n: singles.length, noticed: heldHuman / singles.length };
console.log(`held-out human documents: disguise notice on ${pct(heldHuman, singles.length)} of ${singles.length}`);
fs.writeFileSync(new URL("results/text_mixed_disguise.json", import.meta.url), JSON.stringify(report, null, 1) + "\n");
