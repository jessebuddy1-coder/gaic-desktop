// Rewrite desktop-build-manifest.json for a runtime folder after the engine
// update, in the same format the GAIC source build writes: every file except
// the manifest, directories walked in localeCompare order, with bytes and
// SHA-256. The 2.4.0 source revision is kept and the engine update is recorded
// next to it. Nothing reads this file at run time; it is the build record.
//
//   node write-manifest.mjs <runtime-dir> <version> [<engine-commit>]
//
// With no engine commit, only version and files are rewritten, which
// reproduces the 2.4.0 manifest byte-for-byte from the 2.4.0 runtime.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [, , dir, version, engineCommit] = process.argv;
if (!dir || !version) {
  console.error("usage: node write-manifest.mjs <runtime-dir> <version> [<engine-commit>]");
  process.exit(2);
}
const NAME = "desktop-build-manifest.json";
const manifestPath = path.join(dir, NAME);
const previous = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

function walk(rel) {
  const entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  const out = [];
  for (const entry of entries) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(child));
    else if (entry.isFile() && child !== NAME) out.push(child);
  }
  return out;
}

const files = walk("").map((rel) => {
  const bytes = fs.readFileSync(path.join(dir, rel));
  return { path: rel, bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
});

const next = {};
for (const [key, value] of Object.entries(previous)) {
  if (key === "files" || key === "file_count" || key === "engine_update") continue;
  next[key] = key === "version" ? version : value;
  if (key === "source_revision" && engineCommit) {
    next.engine_update = {
      repository: "jessebuddy1-coder/gaic-desktop",
      gitCommit: engineCommit,
      base_version: previous.engine_update ? previous.engine_update.base_version : previous.version,
      files: "engine/runtime/FILES.txt",
    };
  }
}
next.file_count = files.length;
next.files = files;
fs.writeFileSync(manifestPath, JSON.stringify(next, null, 2) + "\n");
console.log(`${NAME}: version ${version}, ${files.length} files`);
