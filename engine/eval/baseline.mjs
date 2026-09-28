// Score documents with the ORIGINAL v2.4.0 analyzeText, sliced verbatim from app.js.
import fs from "fs";
import readline from "readline";
import vm from "vm";
const app = fs.readFileSync(new URL("./runtime-orig/app.js", import.meta.url), "utf8");
const start = app.indexOf("  const MIN_TEXT_CHARACTERS = 1000;");
const lim1 = app.indexOf("  const MAX_TEXT_CHARACTERS = 100000;");
const lim2 = app.indexOf("  function analyticsTrack");
const fstart = app.indexOf("  const FORMULAIC_PHRASES");
const fend = app.indexOf("  // ---------- friendly one-liner");
const code = app.slice(start, lim1) + app.slice(lim1, lim2) + app.slice(fstart, fend) +
  "\nglobalThis.analyzeText = analyzeText;";
const ctx = { TextEncoder, Math, Set, Number, String, Object }; ctx.globalThis = ctx;
vm.createContext(ctx); vm.runInContext(code, ctx);
const [,, inPath, outPath] = process.argv;
const out = fs.createWriteStream(outPath);
const rl = readline.createInterface({ input: fs.createReadStream(inPath) });
for await (const line of rl) {
  const r = JSON.parse(line);
  const res = ctx.analyzeText(r.text);
  out.write(JSON.stringify({ doc: r.id, score: res.score, verdict: res.verdict }) + "\n");
}
out.end();
