// Photo metadata clues, measured with the app's own code: the metadata parser
// (parseImageMetadata and its helpers, sliced from app.js), the PNG settings
// keys and XMP declarations (the unchanged container-provenance.mjs), and the
// tool-name (outside captions), generation-settings, and AI-content-label
// readers in app.js.
// "Earlier" is what 2.4.0 read: its tool-name pattern, PNG settings keys, a
// declared AI source type, or a generative edit step.
//
// A folder whose name starts with "real_" holds real images and every other
// folder AI images; every root listed after --real holds real images.
//
//   GAIC_RUNTIME=<full runtime> node metadata_clues.mjs data/img data/scout --real <camera-photo folder>
//   -> prints per-folder counts, writes results/metadata_clues.json
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const full = process.env.GAIC_RUNTIME;
if (!full || !fs.existsSync(path.join(full, "container-provenance.mjs"))) {
  console.error("set GAIC_RUNTIME to a full runtime folder (for container-provenance.mjs)");
  process.exit(2);
}
const CP = await import(pathToFileURL(path.join(full, "container-provenance.mjs")).href);
const app = fs.readFileSync(path.join(here, "..", "runtime", "app.js"), "utf8");
const slice = (from, to) => {
  const a = app.indexOf(from), b = app.indexOf(to, a + 1);
  if (a < 0 || b < 0) throw new Error("app.js section not found: " + from);
  return app.slice(a, b);
};
const A = { console };
A.globalThis = A;
vm.createContext(A);
vm.runInContext("(function(){" +
  slice("  function readU16LE(bytes, offset) {", "  function readU32BE(bytes, offset) {") +
  slice("  function readU32BE(bytes, offset) {", "\n  }\n") + "\n  }\n" +
  slice("  function rangeToAscii(b, start, end){", "  // ---------- weekly rate limit") +
  slice("  // Generator clues in the file's own decoded metadata", "  async function analyzeImage(") +
  "\nObject.assign(globalThis, { parseImageMetadata, GENERATOR_NAMES, AMBIGUOUS_GENERATOR_NAMES, hasGenerationSettings, readAiContentLabel, withoutCaptions }); })();", A);
const EARLIER_NAMES = /\b(midjourney|stable[ -]?diffusion|dall[ -]?e|adobe firefly|generative[ -]?fill|openai|gemini|imagen)\b/i;

const args = process.argv.slice(2);
const split = args.indexOf("--real");
const roots = (split < 0 ? args : args.slice(0, split)).map((r) => ({ root: r, allReal: false }))
  .concat(split < 0 ? [] : args.slice(split + 1).map((r) => ({ root: r, allReal: true })));
if (!roots.length) { console.error("usage: node metadata_clues.mjs <root>... [--real <root>...]"); process.exit(2); }

const folders = {};
let files = 0, withMetadata = 0;
for (const { root, allReal } of roots) {
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== ".git") walk(file); continue; }
      if (!/\.(jpe?g|png|webp|tiff?)$/i.test(entry.name)) continue;
      const rel = path.relative(path.dirname(path.resolve(root)), path.resolve(file)).split(path.sep);
      const folder = rel.slice(0, allReal ? 1 : 2).join("/");
      const real = allReal || /^real_/.test(rel[1] || "");
      let bytes, meta;
      try { bytes = new Uint8Array(fs.readFileSync(file)); meta = A.parseImageMetadata(bytes); } catch (_) { continue; }
      files += 1;
      const text = meta.metaText || "";
      let keys = [], declarations = {};
      try {
        const structure = CP.readContainerStructure(bytes, { xmpText: text,
          captureStructure: !!(meta.exif && (meta.exif.hasMakerNote || meta.exif.hasGps)) });
        keys = structure.png ? structure.png.generatorTextKeys : [];
        declarations = structure.xmp || {};
      } catch (_) {}
      if (!text.trim() && !meta.hasC2PA && !keys.length) continue;
      withMetadata += 1;
      const row = folders[folder] ||= { real, withMetadata: 0, contentCredentials: 0, earlier: 0, after: 0, newlyCaught: 0,
        settings: 0, aiContentLabel: 0, names: 0, ambiguousNames: 0 };
      row.withMetadata += 1;
      if (meta.hasC2PA) row.contentCredentials += 1;
      const structural = keys.length > 0 || declarations.declaresAiSource === true || !!declarations.generativeHistoryStep;
      const settings = A.hasGenerationSettings(text), label = A.readAiContentLabel(text);
      // As in the app: tool names count outside captions, titles, and keywords.
      const toolText = A.withoutCaptions(text, meta.exif && meta.exif.captionText);
      const names = A.GENERATOR_NAMES.test(toolText), ambiguous = A.AMBIGUOUS_GENERATOR_NAMES.test(toolText);
      const earlier = structural || EARLIER_NAMES.test(text);
      const after = structural || settings || !!label || names || ambiguous;
      if (earlier) row.earlier += 1;
      if (after) row.after += 1;
      if (after && !earlier) row.newlyCaught += 1;
      if (settings) row.settings += 1;
      if (label) row.aiContentLabel += 1;
      if (names) row.names += 1;
      if (ambiguous) row.ambiguousNames += 1;
    }
  };
  walk(root);
}

const rows = Object.entries(folders).sort(([a], [b]) => a.localeCompare(b));
const sum = (real, key) => rows.filter(([, r]) => r.real === real).reduce((s, [, r]) => s + r[key], 0);
const report = {
  files, withMetadata,
  ai: { withMetadata: sum(false, "withMetadata"), earlier: sum(false, "earlier"), after: sum(false, "after"), newlyCaught: sum(false, "newlyCaught") },
  real: { withMetadata: sum(true, "withMetadata"), earlier: sum(true, "earlier"), after: sum(true, "after"),
    anyNewClue: rows.filter(([, r]) => r.real).reduce((s, [, r]) => s + r.settings + r.aiContentLabel + r.names + r.ambiguousNames, 0) },
  folders: Object.fromEntries(rows),
};
fs.mkdirSync(path.join(here, "results"), { recursive: true });
fs.writeFileSync(path.join(here, "results", "metadata_clues.json"), JSON.stringify(report, null, 1) + "\n");
for (const [folder, r] of rows) console.log((r.real ? "real " : "AI   ") + folder.padEnd(46), JSON.stringify(r));
console.log(`files ${files}, with metadata text or credentials ${withMetadata}`);
console.log(`AI:   ${report.ai.withMetadata} with metadata; clue before ${report.ai.earlier}, after ${report.ai.after} (${report.ai.newlyCaught} newly caught)`);
console.log(`real: ${report.real.withMetadata} with metadata; clue before ${report.real.earlier}, after ${report.real.after}; new clues fired ${report.real.anyNewClue} times`);
