// Localizer features for every image (no model): picture rect, share of the
// outside area that is UI background, and share of outside blocks carrying
// marks (text/icons: not background, not rich).
const fs = require("fs");
const { createCanvas, loadImage } = require("@napi-rs/canvas");
const L = require("./localizer.js");
(async () => {
  const [, , listPath, outPath] = process.argv;
  const files = fs.readFileSync(listPath, "utf8").trim().split("\n");
  const out = fs.createWriteStream(outPath);
  for (const file of files) {
    let img; try { img = await loadImage(fs.readFileSync(file)); } catch (e) { continue; }
    const sc = Math.min(1, 512 / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * sc)), h = Math.max(1, Math.round(img.height * sc));
    const c = createCanvas(w, h); const x = c.getContext("2d");
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = "high"; x.drawImage(img, 0, 0, w, h);
    const px = x.getImageData(0, 0, w, h).data;
    const loc = L.localizeContent(px, w, h);
    let marks = null;
    if (loc) {
      const st = L.blockStats(px, w, h); const b = L.LOCALIZER.block;
      const x0 = loc.x / b, x1 = (loc.x + loc.width) / b - 1, y0 = loc.y / b, y1 = (loc.y + loc.height) / b - 1;
      let outside = 0, mk = 0;
      for (let yy = 0; yy < st.rows; yy++) for (let xx = 0; xx < st.cols; xx++) {
        if (xx >= x0 && xx <= x1 && yy >= y0 && yy <= y1) continue;
        outside++; const i = yy * st.cols + xx;
        if (!st.background[i] && !st.rich[i]) mk++;
      }
      marks = outside ? mk / outside : 0;
    }
    out.write(JSON.stringify({ file, loc, marks }) + "\n");
  }
  out.end();
})();
