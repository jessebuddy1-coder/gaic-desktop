// Render each evaluation image inside realistic app/web UI mockups and save
// lossless PNG screenshots, exactly like a user's "screenshot of a picture".
// Usage: node make_screens.mjs <manifest.json> <outDir> [limitPerClass]
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import crypto from "crypto";
const require = createRequire(import.meta.url);
const { chromium } = require("/opt/node22/lib/node_modules/playwright");

const LOREM = "The committee met on Thursday to review the proposal and agreed to revisit the budget next month after the survey results are in.";
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const TEMPLATES = {
  "chat-dark": { vw: 1440, vh: 900, dpr: 1, html: (src) => `
    <body style="margin:0;background:#212121;font:15px/1.5 -apple-system,Segoe UI,Arial;color:#ececec;display:flex;height:100vh">
      <aside style="width:260px;background:#171717;padding:14px;box-sizing:border-box">
        ${Array.from({ length: 14 }, (_, i) => `<div style="padding:8px 10px;border-radius:8px;color:#bbb;${i === 2 ? "background:#2f2f2f" : ""}">Chat about ${["travel", "recipes", "poster ideas", "resume", "logo", "birthday card", "fantasy art", "product photo"][i % 8]} ${i + 1}</div>`).join("")}
      </aside>
      <main style="flex:1;display:flex;flex-direction:column;align-items:center;overflow:hidden">
        <div style="width:768px;padding-top:28px">
          <div style="margin-left:auto;width:fit-content;max-width:70%;background:#303030;border-radius:18px;padding:10px 16px">Create an image: ${esc(LOREM.slice(0, 80))}</div>
          <div style="margin:22px 0 8px;color:#aaa">Image created</div>
          <img src="${src}" style="max-width:512px;max-height:560px;border-radius:14px;display:block">
          <div style="margin-top:10px;color:#9a9a9a;letter-spacing:10px">⎘ ⤓ ♡ ⟳ ⋯</div>
        </div>
        <div style="margin-top:auto;margin-bottom:22px;width:768px;height:52px;border-radius:26px;background:#303030;color:#8f8f8f;display:flex;align-items:center;padding-left:22px;box-sizing:border-box">Ask anything</div>
      </main></body>` },
  "social-phone": { vw: 390, vh: 844, dpr: 3, html: (src) => `
    <body style="margin:0;background:#fff;font:14px/1.35 -apple-system,Arial;color:#111;height:100vh;overflow:hidden">
      <div style="height:47px;display:flex;justify-content:space-between;align-items:center;padding:0 22px;font-weight:600">9:41<span>▂▄▆ ◔ ▭</span></div>
      <div style="display:flex;align-items:center;padding:6px 12px;gap:10px"><div style="width:32px;height:32px;border-radius:50%;background:linear-gradient(45deg,#f58529,#dd2a7b)"></div><b>travel.daily</b><span style="margin-left:auto">⋯</span></div>
      <div style="width:390px;height:488px;background:#000;display:flex;align-items:center;justify-content:center;overflow:hidden"><img src="${src}" style="width:390px;height:488px;object-fit:cover"></div>
      <div style="padding:10px 12px;font-size:22px;letter-spacing:12px">♡ ◯ ➤<span style="float:right">⚑</span></div>
      <div style="padding:0 12px"><b>12,408 likes</b><br><b>travel.daily</b> ${esc(LOREM)}<br><span style="color:#888">View all 214 comments</span></div>
      <div style="position:absolute;bottom:0;width:390px;height:83px;border-top:1px solid #ddd;display:flex;justify-content:space-around;font-size:24px;padding-top:10px;box-sizing:border-box">⌂ ⌕ ⊕ ▶ ◉</div>
    </body>` },
  "viewer-phone": { vw: 390, vh: 844, dpr: 3, html: (src) => `
    <body style="margin:0;background:#000;color:#fff;font:15px -apple-system,Arial;height:100vh;overflow:hidden;display:flex;flex-direction:column">
      <div style="height:47px;display:flex;justify-content:space-between;align-items:center;padding:0 22px;font-weight:600">9:41<span>▂▄▆ ◔ ▭</span></div>
      <div style="height:44px;display:flex;align-items:center;padding:0 12px;gap:12px"><span style="font-size:26px;color:#0a84ff">‹</span><div style="text-align:center;flex:1"><b>Today</b><br><span style="font-size:12px;color:#aaa">4:12 PM</span></div><span style="color:#0a84ff">Edit</span></div>
      <div style="flex:1;display:flex;align-items:center;justify-content:center"><img src="${src}" style="max-width:390px;max-height:600px;object-fit:contain"></div>
      <div style="height:80px;display:flex;justify-content:space-around;align-items:center;font-size:22px;color:#0a84ff">⇪ ♡ ⓘ ⌫</div>
    </body>` },
  "article-desktop": { vw: 1280, vh: 800, dpr: 1, html: (src) => `
    <body style="margin:0;background:#fff;font:17px/1.6 Georgia,serif;color:#222">
      <div style="height:56px;background:#0b3d91;color:#fff;font:bold 20px Arial;display:flex;align-items:center;padding-left:40px">The Daily Ledger <span style="font:14px Arial;margin-left:40px;opacity:.85">World · Business · Tech · Culture · Opinion</span></div>
      <div style="width:760px;margin:24px auto">
        <h1 style="font:bold 30px/1.25 Arial;margin:0 0 8px">City council approves new waterfront plan after months of debate</h1>
        <div style="color:#777;font:13px Arial;margin-bottom:14px">By Staff Reporter · Updated 2 hours ago</div>
        <figure style="margin:0"><img src="${src}" style="max-width:720px;max-height:420px;display:block"><figcaption style="font:13px Arial;color:#666;margin-top:6px">The proposed site, photographed this week.</figcaption></figure>
        <p>${esc(LOREM)} ${esc(LOREM)}</p><p>${esc(LOREM)}</p>
      </div></body>` },
  "letterbox": { vw: 1280, vh: 720, dpr: 1, html: (src) => `
    <body style="margin:0;background:#000;height:100vh;display:flex;align-items:center;justify-content:center;overflow:hidden">
      <img src="${src}" style="max-width:1280px;max-height:720px;object-fit:contain"></body>` },
  "portal-light": { vw: 1440, vh: 900, dpr: 2, html: (src) => `
    <body style="margin:0;background:#f7f7f8;font:14px/1.5 Inter,Arial;color:#202123;height:100vh;display:flex;overflow:hidden">
      <div style="flex:1.4;display:flex;align-items:center;justify-content:center;padding:24px"><img src="${src}" style="max-width:100%;max-height:820px;border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,.15)"></div>
      <div style="flex:1;background:#fff;border-left:1px solid #e5e5e5;padding:28px">
        <div style="display:flex;gap:10px;align-items:center;margin-bottom:18px"><div style="width:36px;height:36px;border-radius:50%;background:#7c5cff"></div><b>@creator</b></div>
        <div style="color:#555;margin-bottom:18px">${esc(LOREM)}</div>
        ${["Vary (Subtle)", "Vary (Strong)", "Upscale", "Remix", "Download"].map((b) => `<div style="display:inline-block;border:1px solid #d0d0d0;border-radius:8px;padding:8px 14px;margin:0 8px 8px 0">${b}</div>`).join("")}
        <div style="margin-top:24px;color:#999">Created 3 minutes ago · 1024 × 1024</div>
      </div></body>` },
};
const NAMES = Object.keys(TEMPLATES);

const [, , manifestPath, outDir, limitArg] = process.argv;
const items = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const limit = Number(limitArg) || Infinity;
fs.mkdirSync(outDir, { recursive: true });
const perClass = { 0: 0, 1: 0 };
const chosen = [];
for (const it of items) {
  if (perClass[it.label] >= limit) continue;
  perClass[it.label] += 1;
  chosen.push(it);
}
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" }).catch(() => chromium.launch());
const pages = {};
const out = [];
let n = 0;
for (const it of chosen) {
  const h = crypto.createHash("sha1").update(it.file).digest();
  const name = NAMES[h[0] % NAMES.length];
  const t = TEMPLATES[name];
  if (!pages[name]) {
    const context = await browser.newContext({ viewport: { width: t.vw, height: t.vh }, deviceScaleFactor: t.dpr });
    pages[name] = await context.newPage();
  }
  const page = pages[name];
  const target = path.join(outDir, crypto.createHash("sha1").update(it.file).digest("hex").slice(0, 16) + ".png");
  if (!fs.existsSync(target)) {
    const htmlPath = path.join(outDir, "_page.html");
    fs.writeFileSync(htmlPath, "<!doctype html><meta charset=utf-8>" + t.html("file://" + it.file));
    await page.goto("file://" + path.resolve(htmlPath), { waitUntil: "load" });
    const ok = await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 15000 }).then(() => true).catch(() => false);
    if (!ok) { console.error("image failed to load", it.file); continue; }
    await page.screenshot({ path: target });
  }
  out.push({ ...it, file: path.resolve(target), original: it.file, template: name });
  if (++n % 100 === 0) console.error(n, "screens");
}
await browser.close();
fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(out, null, 0));
console.error("done", out.length);
