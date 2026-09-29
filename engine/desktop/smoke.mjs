// Smoke test for a built GAIC desktop app: launch it with a DevTools port,
// attach over the Chrome DevTools Protocol, and run three checks through the
// real UI (the free allowance is 3 a week): a text check, a photo check, and a
// 48 MP photo check (above the old 8 MB / 24 MP limits). Fails unless every
// check ends with a lean, a confidence level, and an AI likelihood, the
// updated engine files are the ones loaded, and the page logs no errors.
//
//   node smoke.mjs <app-executable> <out-dir> [extra app args...]
//
// Needs playwright-core (only its CDP client is used; no browser download).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || "playwright-core");
const here = path.dirname(fileURLToPath(import.meta.url));
const runtimeDir = path.join(here, "..", "runtime");
const [, , exe, outDir, ...extraArgs] = process.argv;
if (!exe || !outDir) {
  console.error("usage: node smoke.mjs <app-executable> <out-dir> [extra app args...]");
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });
const PORT = 9333;
const failures = [];
const report = { exe, checks: [], errors: [] };
const check = (ok, what) => { if (!ok) failures.push(what); return ok; };
const log = (...args) => console.log("[smoke]", ...args);

// Public-domain passage (Jane Austen, Pride and Prejudice, 1813), long enough
// for the text check's 1,000-character minimum.
const TEXT = `It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.
However little known the feelings or views of such a man may be on his first entering a neighbourhood, this truth is so well fixed in the minds of the surrounding families, that he is considered the rightful property of some one or other of their daughters.
"My dear Mr. Bennet," said his lady to him one day, "have you heard that Netherfield Park is let at last?"
Mr. Bennet replied that he had not.
"But it is," returned she; "for Mrs. Long has just been here, and she told me all about it."
Mr. Bennet made no answer.
"Do you not want to know who has taken it?" cried his wife impatiently.
"You want to tell me, and I have no objection to hearing it."
This was invitation enough.
"Why, my dear, you must know, Mrs. Long says that Netherfield is taken by a young man of large fortune from the north of England; that he came down on Monday in a chaise and four to see the place, and was so much delighted with it, that he agreed with Mr. Morris immediately; that he is to take possession before Michaelmas, and some of his servants are to be in the house by the end of next week."
"What is his name?"
"Bingley."
"Is he married or single?"
"Oh! Single, my dear, to be sure! A single man of large fortune; four or five thousand a year. What a fine thing for our girls!"`;

// The same text through this repository's engine, outside the app.
function expectedTextDecision() {
  const ctx = { console };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(runtimeDir, "text-detector.js"), "utf8"), ctx);
  return ctx.AICheckTextEngine.analyze(TEXT).decision;
}

async function waitForDevTools(child) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`app exited early with code ${child.exitCode}`);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return res.json();
    } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("DevTools endpoint did not come up within 90 s");
}

async function appPage(browser) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      const page = context.pages().find((p) => p.url().startsWith("aicheck-app:"));
      if (page) return page;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("no aicheck-app: page appeared");
}

async function readResult(page) {
  return page.evaluate(() => {
    const text = (id) => { const el = document.getElementById(id); return el ? el.textContent.trim() : ""; };
    return {
      verdict: text("verdict"), tech: text("verdict-tech"), score: text("score"),
      summary: text("result-summary"), metric: text("result-metric-detail"), kind: text("result-kind"),
    };
  });
}

async function runCheck(page, name, prepare) {
  const t0 = Date.now();
  await prepare();
  await page.click("#check-btn");
  await page.waitForFunction(() => document.getElementById("result").classList.contains("show") &&
    !document.getElementById("check-btn").disabled, null, { timeout: 300_000 });
  const seen = await readResult(page);
  const ms = Date.now() - t0;
  await page.locator("#result").screenshot({ path: path.join(outDir, `${name}.png`) });
  const row = { name, ms, ...seen };
  report.checks.push(row);
  log(name, JSON.stringify(row));
  check(/^(Likely|Leans) (AI-generated|real|AI-written|human-written) — (high|medium|low) confidence$/.test(seen.verdict),
    `${name}: verdict is not a lean with a confidence level: "${seen.verdict}"`);
  check(/^AI likelihood: \d{1,2}%$/.test(seen.score), `${name}: no AI likelihood: "${seen.score}"`);
  check(!/inconclusive|no rating|couldn't complete|could not complete/i.test(Object.values(seen).join(" ")),
    `${name}: undecided or failed wording in the result`);
  return row;
}

// A deterministic synthetic photo made in the page: gradients, shapes, and
// grain, encoded as JPEG. Returned as a File so it goes through the app's
// normal file picker path.
async function pickSyntheticPhoto(page, width, height, name) {
  const info = await page.evaluate(async ({ width, height, name }) => {
    let seed = 1234567;
    const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    const sky = ctx.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, "#6f9fd8"); sky.addColorStop(0.55, "#d9e6f2"); sky.addColorStop(0.56, "#5b7f3a"); sky.addColorStop(1, "#2f4a1f");
    ctx.fillStyle = sky; ctx.fillRect(0, 0, width, height);
    for (let i = 0; i < 160; i += 1) {
      ctx.fillStyle = `hsla(${Math.floor(rand() * 360)}, ${30 + Math.floor(rand() * 50)}%, ${25 + Math.floor(rand() * 50)}%, ${0.25 + rand() * 0.5})`;
      ctx.beginPath();
      ctx.ellipse(rand() * width, rand() * height, (0.01 + rand() * 0.08) * width, (0.01 + rand() * 0.08) * height, rand() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
    const tile = new OffscreenCanvas(256, 256);
    const tctx = tile.getContext("2d");
    const grain = tctx.createImageData(256, 256);
    for (let i = 0; i < grain.data.length; i += 4) {
      const v = Math.floor(rand() * 255);
      grain.data[i] = v; grain.data[i + 1] = v; grain.data[i + 2] = v; grain.data[i + 3] = 255;
    }
    tctx.putImageData(grain, 0, 0);
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = ctx.createPattern(tile, "repeat");
    ctx.fillRect(0, 0, width, height);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.95 });
    const file = new File([blob], name, { type: "image/jpeg", lastModified: Date.now() });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const input = document.getElementById("file-input");
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return { bytes: blob.size, width, height };
  }, { width, height, name });
  log(`picked ${name}: ${info.width}x${info.height}, ${(info.bytes / 1048576).toFixed(1)} MB`);
  return info;
}

// A fresh profile, so the weekly allowance and any saved state start empty.
const profile = path.resolve(outDir, "profile");
fs.rmSync(profile, { recursive: true, force: true });
const child = spawn(exe, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, ...extraArgs],
  { stdio: ["ignore", "pipe", "pipe"] });
const appLog = fs.createWriteStream(path.join(outDir, "app.log"));
child.stdout.pipe(appLog); child.stderr.pipe(appLog);
let browser;
try {
  const version = await waitForDevTools(child);
  report.browser = version.Browser;
  log("DevTools up:", version.Browser);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const page = await appPage(browser);
  page.on("pageerror", (e) => report.errors.push(`pageerror: ${String(e).slice(0, 300)}`));
  page.on("console", (m) => { if (m.type() === "error") report.errors.push(`console: ${m.text().slice(0, 300)}`); });
  await page.waitForFunction(() => window.AICheck && window.OnnxDetector && document.readyState === "complete", null, { timeout: 60_000 });
  await page.setViewportSize({ width: 1280, height: 900 }).catch(() => {});
  log("page:", page.url());

  const loaded = await page.evaluate(() => ({
    model: window.AICHECK_ONNX && window.AICHECK_ONNX.model,
    modelId: window.AICHECK_ONNX && window.AICHECK_ONNX.id,
    textEngine: window.AICheckTextEngine && window.AICheckTextEngine.VERSION,
    textModel: window.AICheckTextEngine && window.AICheckTextEngine.model && window.AICheckTextEngine.model.version,
    lean: !!(window.ProvenanceVerdict && typeof window.ProvenanceVerdict.decideImageLean === "function"),
  }));
  report.loaded = loaded;
  log("loaded:", JSON.stringify(loaded));
  check(loaded.model === "models/aicheck-ai-image-v3-fp16.onnx" && loaded.modelId === "GAIC Image Model v3", "image model v3 is not configured");
  check(loaded.textEngine === "gaic-text-v2.1" && /Text Model v2/.test(loaded.textModel || ""), "text engine v2.1 is not loaded");
  check(loaded.lean, "decideImageLean is not loaded");
  const head = await page.evaluate(async () => {
    const res = await fetch("image-head.js", { cache: "no-store" });
    return { ok: res.ok, bytes: (await res.text()).length };
  });
  check(head.ok && head.bytes > 20000, "image-head.js is not served by the app");

  // 1. Text: the app's lean must match this repository's engine.
  const expected = expectedTextDecision();
  const textRow = await runCheck(page, "text", async () => {
    await page.click("#tab-text");
    await page.fill("#text-input", TEXT);
  });
  const leanWord = expected.lean === "ai" ? "AI-written" : "human-written";
  check(textRow.verdict.includes(leanWord) && textRow.verdict.includes(`${expected.confidence} confidence`),
    `text: app verdict "${textRow.verdict}" differs from the engine (${expected.lean}, ${expected.confidence})`);
  check(textRow.score === `AI likelihood: ${expected.aiLikelihood}%`,
    `text: app shows "${textRow.score}", the engine gives ${expected.aiLikelihood}%`);
  check(textRow.kind === "Text scan", `text: result kind "${textRow.kind}"`);

  // 2. A photo.
  await page.click("#tab-image");
  const photoRow = await runCheck(page, "photo", () => pickSyntheticPhoto(page, 1600, 1200, "smoke-photo.jpg"));
  check(photoRow.kind === "Photo scan", `photo: result kind "${photoRow.kind}"`);

  // 3. A 48 MP photo, above the old 8 MB / 24 MP limits.
  const bigRow = await runCheck(page, "photo-48mp", async () => {
    const info = await pickSyntheticPhoto(page, 8000, 6000, "smoke-48mp.jpg");
    report.bigPhoto = info;
  });
  check(bigRow.kind === "Photo scan", `photo-48mp: result kind "${bigRow.kind}"`);
  check(report.bigPhoto && report.bigPhoto.bytes > 8 * 1048576, "photo-48mp: test file was not above 8 MB");

  check(report.errors.length === 0, `page logged errors: ${report.errors.join(" | ")}`);
} catch (error) {
  failures.push(`smoke test aborted: ${error && error.stack ? error.stack : error}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  child.kill();
  report.failures = failures;
  fs.writeFileSync(path.join(outDir, "smoke.json"), JSON.stringify(report, null, 2));
}
if (failures.length) {
  console.error("[smoke] FAILED\n" + failures.map((f) => "  - " + f).join("\n"));
  process.exit(1);
}
log("all checks passed");
process.exit(0);
