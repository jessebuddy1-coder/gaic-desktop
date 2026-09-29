// Which evaluation-pool documents the live GAIC app (niro-code-vault
// code/apps/aicheck/app.js, 2.6) accepts for scoring: its own analyzeText gates,
// including the language check. Only languageCheck from text-detector.js is
// exposed to app.js here, so its cheap heuristic fallback stands in for the
// model and a document passes when analyzeText returns a lean at all; the
// fallback's score is kept as the 2.5.9 heuristic's score for comparison.
//
//   node live_app_text_gates.mjs <live app folder> data/text/pool.jsonl data/text/live_gates.jsonl
//   python3 live_app_text_tables.py   -> results/live_app_text_gates.json
import fs from "node:fs"; import path from "node:path"; import vm from "node:vm"; import readline from "node:readline";
const [appDir, poolPath, outPath] = process.argv.slice(2);
if (!appDir || !poolPath || !outPath) {
  console.error("usage: node live_app_text_gates.mjs <live app folder> <pool.jsonl> <out.jsonl>");
  process.exit(2);
}
const engineCtx = {}; engineCtx.globalThis = engineCtx; vm.createContext(engineCtx);
vm.runInContext(fs.readFileSync(path.join(appDir, "text-detector.js"), "utf8"), engineCtx);
const window = { localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  AICheckTextEngine: { languageCheck: engineCtx.AICheckTextEngine.languageCheck } };
const document = { readyState: "loading", getElementById: () => null, addEventListener() {}, createElement() { throw new Error("no DOM"); } };
const ctx = vm.createContext({ window, document, localStorage: window.localStorage, console, setTimeout, clearTimeout, AbortController, Date, TextEncoder, URL });
vm.runInContext(fs.readFileSync(path.join(appDir, "app.js"), "utf8"), ctx);
const analyzeText = window.AICheck._test.analyzeText;
const out = fs.createWriteStream(outPath);
const reasons = {};
let n = 0;
for await (const line of readline.createInterface({ input: fs.createReadStream(poolPath) })) {
  const r = JSON.parse(line);
  const res = analyzeText(r.text);
  const pass = !!res.lean;
  const why = pass ? "pass" : res.verdict;
  reasons[why] = (reasons[why] || 0) + 1;
  out.write(JSON.stringify({ doc: r.id, pass, why, heuristic: pass ? res.score : null }) + "\n");
  n += 1;
}
out.end();
console.log(n, JSON.stringify(reasons));
