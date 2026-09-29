// Human-made, non-photographic "real" images (not AI): dashboards with SVG
// charts, documents, code editors, spreadsheets, slides, forms, flat vector
// art, and photo memes with caption text. They keep a decision head from
// learning "not a camera photo = AI".  Usage: node make_nonphoto.mjs <outDir> <n> <seed> [photoList]
import fs from "fs";
import path from "path";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { chromium } = require("/opt/node22/lib/node_modules/playwright");
const [, , outDir, nArg, seedArg, photoList] = process.argv;
const N = +nArg || 100;
let seed = (+seedArg || 1) >>> 0;
const rnd = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const photos = photoList ? fs.readFileSync(photoList, "utf8").trim().split("\n") : [];
const WORDS = "the of and to in is for on with as by at from that this report data total growth region quarter revenue users sales plan team project update meeting budget review design launch market customer support service order status account balance invoice summary result analysis weekly monthly annual north south east west product feature release version change issue fixed open closed pending approved schedule deadline progress target actual forecast".split(" ");
const sent = (n) => { const w = Array.from({ length: n }, () => pick(WORDS)); w[0] = w[0][0].toUpperCase() + w[0].slice(1); return w.join(" ") + "."; };
const para = (k) => Array.from({ length: k }, () => sent(int(6, 16))).join(" ");
const PAL = [["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948"], ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd"], ["#264653", "#2a9d8f", "#e9c46a", "#f4a261", "#e76f51"], ["#003f5c", "#58508d", "#bc5090", "#ff6361", "#ffa600"]];
const FONTS = ["Arial", "Helvetica", "Georgia", "Verdana", "Times New Roman", "Courier New", "Trebuchet MS", "DejaVu Sans"];

function barChart(w, h, pal) {
  const k = int(4, 12), vals = Array.from({ length: k }, () => rnd());
  const bw = (w - 60) / k;
  return `<svg width="${w}" height="${h}" style="background:#fff"><line x1="40" y1="${h - 30}" x2="${w - 10}" y2="${h - 30}" stroke="#999"/>` +
    vals.map((v, i) => `<rect x="${45 + i * bw}" y="${h - 30 - v * (h - 60)}" width="${bw * 0.7}" height="${v * (h - 60)}" fill="${pal[i % pal.length]}"/><text x="${45 + i * bw}" y="${h - 12}" font-size="11" fill="#555">${pick(WORDS).slice(0, 5)}</text>`).join("") + `</svg>`;
}
function lineChart(w, h, pal) {
  const series = int(1, 3); let s = `<svg width="${w}" height="${h}" style="background:#fff">`;
  for (let g = 0; g < 5; g++) s += `<line x1="40" x2="${w - 10}" y1="${20 + g * (h - 50) / 4}" y2="${20 + g * (h - 50) / 4}" stroke="#eee"/>`;
  for (let j = 0; j < series; j++) {
    let y = rnd(); const pts = [];
    for (let i = 0; i < 24; i++) { y = Math.min(1, Math.max(0, y + (rnd() - 0.5) * 0.25)); pts.push(`${40 + i * (w - 50) / 23},${h - 30 - y * (h - 60)}`); }
    s += `<polyline points="${pts.join(" ")}" fill="none" stroke="${pal[j]}" stroke-width="${int(1, 3)}"/>`;
  }
  return s + `</svg>`;
}
function pieChart(w, h, pal) {
  const k = int(3, 6), vals = Array.from({ length: k }, () => rnd() + 0.1), tot = vals.reduce((a, b) => a + b);
  const r = Math.min(w, h) / 2 - 20, cx = w / 2, cy = h / 2; let a0 = 0, s = `<svg width="${w}" height="${h}" style="background:#fff">`;
  vals.forEach((v, i) => { const a1 = a0 + v / tot * Math.PI * 2; const large = a1 - a0 > Math.PI ? 1 : 0;
    s += `<path d="M${cx},${cy} L${cx + r * Math.cos(a0)},${cy + r * Math.sin(a0)} A${r},${r} 0 ${large} 1 ${cx + r * Math.cos(a1)},${cy + r * Math.sin(a1)} Z" fill="${pal[i % pal.length]}"/>`; a0 = a1; });
  return s + `</svg>`;
}
const chart = (w, h, pal) => pick([barChart, lineChart, pieChart])(w, h, pal);

const KINDS = {
  dashboard: () => { const pal = pick(PAL); const f = pick(FONTS);
    return { vw: pick([1280, 1440, 1920]), vh: pick([800, 900, 1080]), html: `<body style="margin:0;font:14px ${f};background:${pick(["#f4f6f9", "#fff", "#1e1e2e"])};color:${pick(["#222", "#333"])}">
    <div style="height:54px;background:${pal[0]};color:#fff;display:flex;align-items:center;padding:0 24px;font-size:18px">${sent(3)}</div>
    <div style="display:grid;grid-template-columns:repeat(${int(2, 3)},1fr);gap:16px;padding:20px">${Array.from({ length: int(3, 6) }, () => `<div style="background:#fff;border-radius:${int(0, 10)}px;padding:12px;box-shadow:0 1px 3px rgba(0,0,0,.15)"><div style="font-weight:bold;margin-bottom:6px">${sent(3)}</div>${chart(380, 220, pal)}</div>`).join("")}</div></body>` }; },
  document: () => ({ vw: pick([900, 1024, 1280]), vh: pick([1100, 1200, 900]), html: `<body style="margin:0;background:${pick(["#e8e8e8", "#fff", "#f1f3f4"])};font:${int(13, 17)}px/1.6 ${pick(FONTS)}"><div style="width:${pick([680, 760, 816])}px;margin:24px auto;background:#fff;padding:48px;box-shadow:0 1px 4px rgba(0,0,0,.2)"><h1 style="font-size:${int(22, 30)}px">${sent(5)}</h1>${Array.from({ length: int(3, 7) }, () => `<p>${para(int(2, 6))}</p>`).join("")}${rnd() < 0.5 ? `<table border="1" cellpadding="6" style="border-collapse:collapse">${Array.from({ length: int(3, 7) }, () => `<tr>${Array.from({ length: 4 }, () => `<td>${rnd() < 0.5 ? pick(WORDS) : (rnd() * 1e4).toFixed(int(0, 2))}</td>`).join("")}</tr>`).join("")}</table>` : ""}</div></body>` }),
  code: () => { const kw = ["function", "const", "return", "if", "else", "for", "import", "export", "class", "def", "let"]; const dark = rnd() < 0.7;
    return { vw: pick([1280, 1440, 1600]), vh: pick([800, 900]), html: `<body style="margin:0;background:${dark ? "#1e1e1e" : "#fff"};color:${dark ? "#d4d4d4" : "#222"};font:${int(12, 15)}px/1.5 'DejaVu Sans Mono',monospace;display:flex;height:100vh"><div style="width:${int(180, 260)}px;background:${dark ? "#252526" : "#f3f3f3"};padding:10px">${Array.from({ length: 18 }, () => `<div>${pick(WORDS)}_${pick(WORDS)}.${pick(["js", "py", "ts", "css", "md"])}</div>`).join("")}</div><pre style="margin:0;padding:12px;flex:1">${Array.from({ length: 40 }, (_, i) => `<span style="color:#858585">${String(i + 1).padStart(3)}</span>  ${" ".repeat(int(0, 3) * 2)}<span style="color:${dark ? "#569cd6" : "#0000ff"}">${pick(kw)}</span> ${pick(WORDS)}_${pick(WORDS)}(<span style="color:${dark ? "#ce9178" : "#a31515"}">"${pick(WORDS)}"</span>, ${int(0, 99)});`).join("\n")}</pre></body>` }; },
  spreadsheet: () => ({ vw: pick([1280, 1440]), vh: pick([800, 900]), html: `<body style="margin:0;font:13px Arial"><div style="height:60px;background:#107c41;color:#fff;padding:8px">${sent(2)}</div><table style="border-collapse:collapse">${Array.from({ length: 30 }, (_, r) => `<tr>${Array.from({ length: 12 }, (_, c) => `<td style="border:1px solid #ddd;width:100px;height:20px;padding:0 4px;${r === 0 || c === 0 ? "background:#f3f3f3" : ""}">${r === 0 ? String.fromCharCode(65 + c) : c === 0 ? r : rnd() < 0.7 ? (rnd() * 1e4).toFixed(2) : pick(WORDS)}</td>`).join("")}</tr>`).join("")}</table></body>` }),
  slide: () => { const pal = pick(PAL);
    return { vw: 1280, vh: 720, html: `<body style="margin:0;height:100vh;background:${rnd() < 0.5 ? pal[0] : `linear-gradient(${int(0, 360)}deg,${pal[0]},${pal[1]})`};color:#fff;font:${pick(FONTS)};display:flex;flex-direction:column;justify-content:center;padding:80px;box-sizing:border-box"><h1 style="font-size:${int(40, 64)}px;margin:0">${sent(int(3, 6))}</h1><ul style="font-size:24px">${Array.from({ length: int(2, 5) }, () => `<li>${sent(int(4, 8))}</li>`).join("")}</ul>${rnd() < 0.5 ? `<div style="position:absolute;right:60px;bottom:60px">${chart(420, 260, pal)}</div>` : ""}</body>` }; },
  form: () => ({ vw: pick([390, 414, 1280]), vh: pick([844, 896, 800]), html: `<body style="margin:0;font:15px -apple-system,Arial;background:#fff;padding:24px">${Array.from({ length: int(4, 9) }, () => rnd() < 0.7 ? `<label style="display:block;margin:12px 0 4px;color:#555">${sent(2)}</label><input style="width:90%;padding:10px;border:1px solid #ccc;border-radius:6px" value="${rnd() < 0.5 ? pick(WORDS) + " " + pick(WORDS) : ""}">` : `<button style="margin:14px 8px 0 0;padding:10px 18px;border:0;border-radius:6px;background:${pick(pick(PAL))};color:#fff">${pick(WORDS)}</button>`).join("")}</body>` }),
  vector: () => { const pal = pick(PAL); const w = pick([800, 1024, 1200]), h = pick([600, 800, 1024]); let s = `<svg width="${w}" height="${h}"><rect width="100%" height="100%" fill="${pick(["#fff", pal[0], "#fafafa", "#111"])}"/>`;
    for (let i = 0; i < int(8, 60); i++) { const c = pick(pal); const t = rnd();
      s += t < 0.4 ? `<circle cx="${rnd() * w}" cy="${rnd() * h}" r="${int(5, 200)}" fill="${c}" opacity="${(0.4 + rnd() * 0.6).toFixed(2)}"/>` : t < 0.8 ? `<rect x="${rnd() * w}" y="${rnd() * h}" width="${int(10, 300)}" height="${int(10, 300)}" fill="${c}" transform="rotate(${int(0, 90)} ${w / 2} ${h / 2})"/>` : `<polygon points="${Array.from({ length: 3 }, () => `${rnd() * w},${rnd() * h}`).join(" ")}" fill="${c}"/>`; }
    return { vw: w, vh: h, html: `<body style="margin:0">${s}</svg></body>` }; },
  meme: () => { if (!photos.length) return KINDS.slide(); const p = pick(photos); const b64 = fs.readFileSync(p).toString("base64");
    const t = `font:bold ${int(34, 56)}px Impact,'DejaVu Sans',Arial;color:#fff;-webkit-text-stroke:2px #000;text-transform:uppercase;text-align:center;position:absolute;left:0;right:0`;
    return { vw: pick([600, 800, 1080]), vh: pick([600, 800, 1080]), html: `<body style="margin:0;background:#000;height:100vh;position:relative;overflow:hidden"><img src="data:image/jpeg;base64,${b64}" style="width:100%;height:100%;object-fit:cover"><div style="${t};top:12px">${sent(int(3, 6))}</div><div style="${t};bottom:12px">${sent(int(3, 6))}</div></body>` }; },
};
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const manifest = [];
for (let i = 0; i < N; i++) {
  const kind = pick(Object.keys(KINDS)); const spec = KINDS[kind]();
  const dpr = spec.vw <= 450 ? pick([2, 3]) : pick([1, 1, 2]);
  const page = await browser.newPage({ viewport: { width: spec.vw, height: spec.vh }, deviceScaleFactor: dpr });
  await page.setContent(spec.html, { waitUntil: "load" });
  const jpeg = rnd() < 0.35;
  const file = path.resolve(outDir, `np_${seedArg}_${i}_${kind}.${jpeg ? "jpg" : "png"}`);
  await page.screenshot({ path: file, type: jpeg ? "jpeg" : "png", quality: jpeg ? int(70, 92) : undefined });
  await page.close();
  manifest.push({ file, label: 0, source: "nonphoto-" + kind, generator: "human-graphic", family: "nonphoto" });
}
await browser.close();
fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest));
console.log("wrote", manifest.length);
