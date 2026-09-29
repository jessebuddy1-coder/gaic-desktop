// The text check's language test, measured with the shipped engine
// (text-detector.js languageCheck) on human writing in 21 languages and on the
// English evaluation corpora; and, for comparison, what the English model did
// with the same non-English text before the test existed.
//
// Non-English text: Universal Dependencies treebanks (github.com/UniversalDependencies,
// UD_<Language>-<Treebank>), whose "# text =" lines are the original
// sentences, joined into paragraphs of 1,200+ characters within a document.
// English text: corpus.jsonl from build_corpus.py, up to 150 texts of 1,000+
// characters per corpus, label, domain, and attack variant.
//
//   node language_check.mjs --ud <folder of UD_* clones>... --english data/text/corpus.jsonl
//   -> prints per-set rates, writes results/language_check.json
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const E = { console };
E.window = E; E.globalThis = E;
vm.createContext(E);
vm.runInContext(fs.readFileSync(path.join(here, "..", "runtime", "text-detector.js"), "utf8"), E);
const engine = E.AICheckTextEngine;

const args = process.argv.slice(2);
const udRoots = [], englishFiles = [];
for (let i = 0, list = null; i < args.length; i += 1) {
  if (args[i] === "--ud") list = udRoots;
  else if (args[i] === "--english") list = englishFiles;
  else if (list) list.push(args[i]);
}
if (!udRoots.length && !englishFiles.length) {
  console.error("usage: node language_check.mjs --ud <folder>... --english <corpus.jsonl>");
  process.exit(2);
}

// The app's letter test that ran before languageCheck (analyzeText in app.js).
function passedLetterTest(text) {
  const words = text.normalize("NFKC").trim().split(/\s+/).filter(Boolean);
  const lower = words.map((w) => w.toLowerCase().replace(/[^a-z']/g, "")).filter(Boolean);
  return lower.length > 0 && lower.length / words.length >= 0.7;
}

function udParagraphs(dir, maxN = 300, minChars = 1200) {
  const out = [];
  let current = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".conllu")).sort()) {
    for (const line of fs.readFileSync(path.join(dir, file), "utf8").split("\n")) {
      if (line.startsWith("# newdoc")) { current = []; continue; }
      if (!line.startsWith("# text = ")) continue;
      current.push(line.slice(9).trim());
      const text = current.join(" ");
      if (text.length >= minChars) { out.push(text); current = []; if (out.length >= maxN) return out; }
    }
  }
  return out;
}

const sets = {};
function add(name, text, compareOldModel) {
  const set = sets[name] ||= { n: 0, notScored: 0, otherLanguage: 0, noEnglish: 0, oldPassed: 0, oldLeanAi: 0, oldLeanHuman: 0 };
  set.n += 1;
  const check = engine.languageCheck(text);
  if (!check.english) set.notScored += 1;
  if (check.reason === "other-language") set.otherLanguage += 1;
  if (check.reason === "no-english") set.noEnglish += 1;
  if (compareOldModel && passedLetterTest(text)) {
    set.oldPassed += 1;
    const decision = (engine.analyze(text) || {}).decision;
    if (decision && decision.lean === "ai") set.oldLeanAi += 1;
    if (decision && decision.lean === "human") set.oldLeanHuman += 1;
  }
}

for (const root of udRoots) {
  for (const repo of fs.readdirSync(root).filter((d) => /^ud_/i.test(d)).sort()) {
    const name = "ud:" + repo.replace(/^ud_/i, "").toLowerCase();
    for (const text of udParagraphs(path.join(root, repo))) add(name, text, true);
  }
}
for (const file of englishFiles) {
  const cells = {};
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    const row = JSON.parse(line);
    if (!row.text || row.text.length < 1000) continue;
    // Some Ghostbuster Reuters rows hold token-probability dumps, not text.
    if (row.corpus === "ghostbuster" && row.domain === "reuter" && /Ġ/.test(row.text)) continue;
    const variant = /^attack:/.test(row.variant || "") ? row.variant : "plain";
    const key = [row.corpus, row.label, row.domain, variant].join("|");
    if ((cells[key] = (cells[key] || 0) + 1) > 150) continue;
    add("en:" + row.corpus + "|" + variant, row.text.slice(0, 50000), false);
  }
}

const rows = Object.entries(sets).sort(([a], [b]) => a.localeCompare(b));
const report = { engine: engine.VERSION, sets: Object.fromEntries(rows) };
fs.mkdirSync(path.join(here, "results"), { recursive: true });
fs.writeFileSync(path.join(here, "results", "language_check.json"), JSON.stringify(report, null, 1) + "\n");
const P = (a, b) => (b ? (100 * a / b).toFixed(1) + "%" : "-").padStart(7);
console.log("set".padEnd(40), "n".padStart(5), "not scored".padStart(11), "   before: scored, of those leaned AI / human");
for (const [name, s] of rows) {
  console.log(name.padEnd(40), String(s.n).padStart(5), P(s.notScored, s.n).padStart(11),
    name.startsWith("ud:") ? "   " + P(s.oldPassed, s.n) + P(s.oldLeanAi, s.oldPassed) + P(s.oldLeanHuman, s.oldPassed) : "");
}
