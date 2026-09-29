// Drive the real page through its UI in headless Chromium: pick a file or paste
// text, click Check, wait for the result card, and record what a person sees.
// Usage: node ui_check.mjs <runtimeDir> <outDir> <item>...   item = image:<path> | video:<path> | text:<path-to-txt>
import fs from "fs";
import http from "http";
import path from "path";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { chromium } = require("/opt/node22/lib/node_modules/playwright");
const [, , runtimeDir, outDir, ...items] = process.argv;
fs.mkdirSync(outDir, { recursive: true });
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".wasm": "application/wasm", ".onnx": "application/octet-stream", ".png": "image/png",
  ".jpg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml" };
const root = path.resolve(runtimeDir);
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const file = path.join(root, decodeURIComponent(url.pathname === "/" ? "/ai-detector.html" : url.pathname));
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const rows = [];
for (const [i, item] of items.entries()) {
  const [kind, p] = [item.slice(0, item.indexOf(":")), item.slice(item.indexOf(":") + 1)];
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });   // fresh storage: fresh quota
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
  await page.goto(`http://127.0.0.1:${port}/ai-detector.html`, { waitUntil: "load" });
  await page.waitForFunction(() => window.AICheck && window.OnnxDetector, null, { timeout: 30000 });
  if (kind === "text") {
    await page.click("#tab-text");
    await page.fill("#text-input", fs.readFileSync(p, "utf8"));
  } else {
    await page.click("#tab-image");
    await page.setInputFiles("#file-input", p);
  }
  const t0 = Date.now();
  await page.click("#check-btn");
  await page.waitForFunction(() => document.getElementById("result").classList.contains("show") &&
    !document.getElementById("check-btn").disabled, null, { timeout: 240000 });
  const seen = await page.evaluate(() => ({
    verdict: document.getElementById("verdict").textContent,
    tech: document.getElementById("verdict-tech") ? document.getElementById("verdict-tech").textContent : "",
    score: document.getElementById("score").textContent,
    meterHidden: document.getElementById("meter").hidden,
    summary: document.getElementById("result-summary").textContent,
    metric: (document.getElementById("result-metric-detail") || {}).textContent || "",
    kind: document.getElementById("result-kind").textContent,
  }));
  const shot = path.join(outDir, `ui_${i}_${kind}.png`);
  await page.locator("#result").screenshot({ path: shot });
  rows.push({ item, ms: Date.now() - t0, ...seen, errors, shot });
  console.log(JSON.stringify(rows[rows.length - 1]));
  await context.close();
}
await browser.close();
server.close();
fs.writeFileSync(path.join(outDir, "ui_results.json"), JSON.stringify(rows, null, 1));
