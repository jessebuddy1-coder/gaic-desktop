// Smoke test for a built GAIC desktop app: launch it with a DevTools port,
// attach to its page over the Chrome DevTools Protocol, and run three checks
// through the real UI (the free allowance is 3 a week): a text check, a photo
// check, and a 48 MP photo check (above the old 8 MB / 24 MP limits). Fails
// unless every check ends with a lean, a confidence level, and an AI
// likelihood, the updated engine files are the ones loaded, and the page logs
// no errors. Needs Node 22+ (built-in WebSocket); no other dependencies.
//
//   node smoke.mjs <app-executable> <out-dir> [extra app args...]
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const runtimeDir = path.join(here, "..", "runtime");
const [, , exe, outDir, ...rest] = process.argv;
// --probe: only check that the app's page loads and answers, then exit.
const probeOnly = rest.includes("--probe");
const extraArgs = rest.filter((arg) => arg !== "--probe");
if (!exe || !outDir) {
  console.error("usage: node smoke.mjs <app-executable> <out-dir> [extra app args...]");
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });
const PORT = 9333;
const appLogPath = path.join(outDir, "app.log");
const failures = [];
const report = { exe, checks: [], errors: [] };
const check = (ok, what) => { if (!ok) failures.push(what); return ok; };
const log = (...args) => console.log("[smoke]", ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// A minimal DevTools-protocol client for one page target.
class Page {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer, method } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
        else resolve(msg.result);
      } else if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params.exceptionDetails;
        report.errors.push(`pageerror: ${((d.exception && d.exception.description) || d.text || "").slice(0, 300)}`);
      } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
        report.errors.push(`console: ${msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300)}`);
      }
    });
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", () => reject(new Error("page websocket failed")), { once: true });
    });
  }
  send(method, params = {}, timeoutMs = 60_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} got no answer in ${timeoutMs / 1000} s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(fn, arg, timeoutMs) {
    const expression = `(${fn})(${JSON.stringify(arg === undefined ? null : arg)})`;
    const res = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(`page threw: ${(d.exception && d.exception.description) || d.text}`);
    }
    return res.result.value;
  }
  async waitFor(fn, timeoutMs, what) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.evaluate(fn)) return;
      await sleep(250);
    }
    throw new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what}`);
  }
  async click(selector) {
    // "instant" overrides the page's smooth scrolling, so the box is final.
    const box = await this.evaluate(async (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      await new Promise((r) => setTimeout(r, 50));
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { x, y, hits: !!hit && (hit === el || el.contains(hit)) };
    }, selector);
    if (!box) throw new Error(`no element ${selector}`);
    if (!box.hits) throw new Error(`${selector} is covered or off screen at (${box.x}, ${box.y})`);
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y, button: "none", buttons: 0 });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", buttons: 1, clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", buttons: 0, clickCount: 1 });
  }
  async screenshot(selector, file) {
    const clip = await this.evaluate((sel) => {
      // At the top of the page the sticky header cannot overlap the card.
      window.scrollTo({ top: 0, behavior: "instant" });
      const el = document.querySelector(sel);
      const r = el.getBoundingClientRect();
      return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height, scale: 1 };
    }, selector);
    const { data } = await this.send("Page.captureScreenshot", { format: "png", clip, captureBeyondViewport: true });
    fs.writeFileSync(file, Buffer.from(data, "base64"));
  }
  close() { try { this.ws.close(); } catch (_) {} }
}

function rendererCrashed() {
  try { return /Renderer process crashed|render process gone|renderer.*crash/i.test(fs.readFileSync(appLogPath, "utf8")); }
  catch (_) { return false; }
}

async function devToolsJson(route) {
  const res = await fetch(`http://127.0.0.1:${PORT}${route}`);
  if (!res.ok) throw new Error(`${route}: HTTP ${res.status}`);
  return res.json();
}

async function waitForAppPage(child) {
  const deadline = Date.now() + 120_000;
  let targets = [];
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`app exited early with code ${child.exitCode}`);
    try {
      targets = await devToolsJson("/json/list");
      const page = targets.find((t) => t.type === "page" && t.url.startsWith("aicheck-app:"));
      if (page) return { page, targets };
    } catch (_) { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`no aicheck-app: page within 120 s; targets: ${JSON.stringify(targets)}`);
}

// Everything that can explain a page that does not answer: the target list,
// the browser-level view of it, a detach-free attach through the browser
// session (which also releases a page waiting for a debugger), and on Windows
// the visible top-level windows (a dialog would show up here).
async function diagnose(target) {
  try { log("targets now:", JSON.stringify((await devToolsJson("/json/list")).map((t) => [t.type, t.url, t.title]))); }
  catch (e) { log("target list failed:", e.message); }
  let browser;
  try {
    const version = await devToolsJson("/json/version");
    browser = new Page(version.webSocketDebuggerUrl);
    await browser.open();
    const { targetInfos } = await browser.send("Target.getTargets", {}, 15_000);
    log("browser sees:", JSON.stringify(targetInfos.map((t) => [t.type, t.url, t.attached])));
    const { sessionId } = await browser.send("Target.attachToTarget", { targetId: target.id, flatten: true }, 15_000);
    const viaSession = (method, params = {}) => new Promise((resolve, reject) => {
      const id = browser.nextId++;
      const timer = setTimeout(() => { browser.pending.delete(id); reject(new Error(`${method} (session) got no answer`)); }, 20_000);
      browser.pending.set(id, { resolve, reject, timer, method });
      browser.ws.send(JSON.stringify({ id, sessionId, method, params }));
    });
    await viaSession("Runtime.runIfWaitingForDebugger").then(() => log("runIfWaitingForDebugger answered"), (e) => log(e.message));
    await viaSession("Runtime.evaluate", { expression: "document.readyState + ' ' + location.href", returnByValue: true })
      .then((r) => log("page via browser session:", JSON.stringify(r.result && r.result.value)), (e) => log(e.message));
  } catch (e) {
    log("browser-level diagnosis failed:", e.message);
  } finally {
    if (browser) browser.close();
  }
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const ps = spawn("powershell", ["-NoProfile", "-Command",
        "Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object ProcessName, Id, MainWindowTitle | Format-Table -AutoSize | Out-String -Width 220"],
        { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      ps.stdout.on("data", (d) => { out += d; });
      ps.on("close", () => { log("visible windows:\n" + out.trim()); resolve(); });
      ps.on("error", () => resolve());
    });
  }
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
  await page.waitFor(() => document.getElementById("result").classList.contains("show") &&
    !document.getElementById("check-btn").disabled, 300_000, `the ${name} result`);
  const seen = await readResult(page);
  const ms = Date.now() - t0;
  await page.screenshot("#result", path.join(outDir, `${name}.png`));
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
// grain, encoded as JPEG and handed to the app's file picker input.
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
  }, { width, height, name }, 120_000);
  log(`picked ${name}: ${info.width}x${info.height}, ${(info.bytes / 1048576).toFixed(1)} MB`);
  return info;
}

// A fresh profile, so the weekly allowance and any saved state start empty.
const profile = path.resolve(outDir, "profile");
fs.rmSync(profile, { recursive: true, force: true });
const appLog = fs.createWriteStream(appLogPath);
const child = spawn(exe, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--enable-logging=stderr", "--v=0", ...extraArgs], { stdio: ["ignore", "pipe", "pipe"] });
child.stdout.pipe(appLog); child.stderr.pipe(appLog);
let page;
try {
  const { page: target, targets } = await waitForAppPage(child);
  report.targets = targets.map((t) => ({ type: t.type, url: t.url }));
  report.browser = (await devToolsJson("/json/version")).Browser;
  log("DevTools up:", report.browser, "targets:", JSON.stringify(report.targets));
  page = new Page(target.webSocketDebuggerUrl);
  await page.open();
  let answered = false;
  for (let attempt = 1; attempt <= 6 && !answered; attempt += 1) {
    try {
      await page.send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }, 30_000);
      answered = true;
    } catch (e) {
      log(`page not answering yet (${attempt}/6): ${e.message}`);
      await diagnose(target);
      if (rendererCrashed()) throw new Error("the app's page process crashed (see the app log below)");
    }
  }
  if (!answered) throw new Error("the app's page never answered DevTools commands");
  if (probeOnly) {
    // Loaded, then still alive 10 s later: a page process that crashes after
    // its first answer fails here too.
    await page.waitFor(() => document.readyState === "complete", 60_000, "the page to finish loading");
    await sleep(10_000);
    if (rendererCrashed()) throw new Error("the app's page process crashed after loading (see the app log below)");
    log("PROBE OK: the page loaded and still answers 10 s later:", JSON.stringify(await page.evaluate(() => document.readyState + " " + document.title, undefined, 15_000)));
    throw Object.assign(new Error("probe finished"), { probeOk: true });
  }
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  await page.waitFor(() => document.readyState === "complete" && !!(window.AICheck && window.OnnxDetector), 120_000, "the app to load");
  log("page:", target.url);

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
    await page.evaluate((text) => {
      const el = document.getElementById("text-input");
      el.focus();
      el.value = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, TEXT);
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
    report.bigPhoto = await pickSyntheticPhoto(page, 8000, 6000, "smoke-48mp.jpg");
  });
  check(bigRow.kind === "Photo scan", `photo-48mp: result kind "${bigRow.kind}"`);
  check(report.bigPhoto && report.bigPhoto.bytes > 8 * 1048576, "photo-48mp: test file was not above 8 MB");

  check(report.errors.length === 0, `page logged errors: ${report.errors.join(" | ")}`);
} catch (error) {
  if (!(error && error.probeOk)) failures.push(`smoke test aborted: ${error && error.stack ? error.stack : error}`);
} finally {
  if (page) page.close();
  child.kill();
  await sleep(500);
  report.failures = failures;
  fs.writeFileSync(path.join(outDir, "smoke.json"), JSON.stringify(report, null, 2));
}
if (failures.length) {
  console.error("[smoke] FAILED\n" + failures.map((f) => "  - " + f).join("\n"));
  const tail = fs.existsSync(appLogPath) ? fs.readFileSync(appLogPath, "utf8").split("\n").slice(-60).join("\n") : "";
  console.error("[smoke] last lines of the app's own log:\n" + tail);
  process.exit(1);
}
log(probeOnly ? "probe passed" : "all checks passed");
process.exit(0);
