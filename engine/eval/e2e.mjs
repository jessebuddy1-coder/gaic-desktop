// Drive the real GAIC page in headless Chromium: real ORT-Web WASM worker,
// real Canvas2D, real <video> decoding. Usage:
//   node e2e.mjs <runtimeDir> <image|video|text|screen> <manifest.json> <out.jsonl> [limit]
import fs from "fs";
import http from "http";
import path from "path";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { chromium } = require("/opt/node22/lib/node_modules/playwright");

const [, , runtimeDir, mode, manifestPath, outPath, limitArg] = process.argv;
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm",
  ".onnx": "application/octet-stream", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".webm": "video/webm", ".mp4": "video/mp4", ".txt": "text/plain",
};
const root = path.resolve(runtimeDir);
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let file;
  if (url.pathname === "/__asset") file = url.searchParams.get("p");
  else file = path.join(root, decodeURIComponent(url.pathname === "/" ? "/ai-detector.html" : url.pathname));
  if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
    "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("[pageerror]", String(e).slice(0, 300)));
await page.goto(`http://127.0.0.1:${port}/ai-detector.html`, { waitUntil: "load" });
await page.waitForFunction(() => window.AICheck && window.AICheck._test && window.OnnxDetector, null, { timeout: 30000 });

const items = JSON.parse(fs.readFileSync(manifestPath, "utf8")).slice(0, Number(limitArg) || Infinity);
const done = new Set();
if (fs.existsSync(outPath)) for (const l of fs.readFileSync(outPath, "utf8").trim().split("\n").filter(Boolean)) done.add(JSON.parse(l).file);
const out = fs.createWriteStream(outPath, { flags: "a" });
const t0 = Date.now(); let n = 0;
for (const it of items) {
  if (done.has(it.file)) continue;
  const assetUrl = `/__asset?p=${encodeURIComponent(it.file)}`;
  const type = TYPES[path.extname(it.file).toLowerCase()] || "application/octet-stream";
  let result;
  try {
    result = await page.evaluate(async ({ assetUrl, name, type, mode, text }) => {
      const T = window.AICheck._test;
      if (mode === "text") {
        const r = T.analyzeText(text);
        return { score: r.score, verdict: r.verdict, explain: r.explain };
      }
      const blob = await (await fetch(assetUrl)).blob();
      const file = new File([blob], name, { type });
      if (mode === "image") {
        const m = await window.OnnxDetector.detect(file);
        return m ? { aiLikelihood: m.aiLikelihood, strongestRegion: m.strongestRegion, regionScan: m.regionScan,
          regionScores: m.regionScores } : { error: window.OnnxDetector.lastError };
      }
      if (mode === "video") {
        const r = await T.analyzeVideo(file);
        return { score: r.score, verdict: r.verdict, explain: r.explain, metricLabel: r.metricLabel };
      }
      if (mode === "screen") {
        // Play the screenshot as a 4 s "shared screen" stream and run the real
        // capture sampler and frame analysis.
        const img = await createImageBitmap(blob);
        const canvas = document.createElement("canvas");
        canvas.width = img.width; canvas.height = img.height;
        const ctx = canvas.getContext("2d");
        const paint = () => ctx.drawImage(img, 0, 0);
        paint();
        const timer = setInterval(paint, 100);
        const stream = canvas.captureStream(10);
        try {
          const frames = await T.recordDisplayFrames(stream);
          const r = await T.analyzeScreenFrames(frames);
          return { frames: frames.length, score: r.score, verdict: r.verdict, explain: r.explain };
        } finally {
          clearInterval(timer);
          stream.getTracks().forEach((t) => t.stop());
        }
      }
      return { error: "unknown mode" };
    }, { assetUrl, name: path.basename(it.file), type, mode, text: it.text || "" });
  } catch (e) {
    result = { error: String(e).slice(0, 200) };
  }
  out.write(JSON.stringify({ file: it.file, label: it.label, ...result }) + "\n");
  if (++n % 10 === 0) console.error(n, "items", ((Date.now() - t0) / n / 1000).toFixed(1), "s/item");
}
out.end();
await browser.close();
server.close();
console.error("done", n);
