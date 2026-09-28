/* GAIC content localizer v2 (prototype for evaluation; the shipped copy lives
   in detector-worker.js and onnx-detector.js).
   Finds the main picture inside a composite frame such as a portal or phone
   screenshot, or a letterboxed video frame. Works on an RGBA buffer already
   downscaled so its long side is at most ~512 px. Returns a rectangle in the
   buffer's coordinates plus how much of the rest of the frame is flat
   interface background, or null when no separate picture is found. */
"use strict";

const LOCALIZER = Object.freeze({
  block: 8,
  richColors: 8,         // distinct 4-bit/channel colors in an 8x8 block
  dominantMax: 0.6,      // top color above this share => not a rich block
  flatShare: 0.9,        // top color above this share => flat block
  ringBlocks: 2,         // outer ring (in blocks) that defines the UI palette
  paletteMinShare: 0.04, // a flat color covering >=4% of the ring is UI background
  flatPenalty: 0.5,
  growMaxBackground: 0.3,
  minAreaFrac: 0.02,
  maxAreaFrac: 0.9,
  minSideBlocks: 6,
});

function blockStats(rgba, width, height) {
  const block = LOCALIZER.block;
  const cols = Math.floor(width / block);
  const rows = Math.floor(height / block);
  const n = block * block;
  const rich = new Uint8Array(cols * rows);
  const dominant = new Int32Array(cols * rows);
  const share = new Float32Array(cols * rows);
  const counts = new Map();
  for (let by = 0; by < rows; by += 1) {
    for (let bx = 0; bx < cols; bx += 1) {
      counts.clear();
      let top = 0, topKey = 0;
      for (let y = by * block; y < by * block + block; y += 1) {
        let o = (y * width + bx * block) * 4;
        for (let x = 0; x < block; x += 1, o += 4) {
          const key = ((rgba[o] >> 4) << 8) | ((rgba[o + 1] >> 4) << 4) | (rgba[o + 2] >> 4);
          const c = (counts.get(key) || 0) + 1;
          counts.set(key, c);
          if (c > top) { top = c; topKey = key; }
        }
      }
      const i = by * cols + bx;
      dominant[i] = topKey;
      share[i] = top / n;
      rich[i] = counts.size >= LOCALIZER.richColors && top / n <= LOCALIZER.dominantMax ? 1 : 0;
    }
  }
  // Interface background palette: flat-block colors on the frame's outer ring,
  // where status bars, page margins, sidebars, and letterbox bars live. Flat
  // areas inside a picture rarely reach the ring, so they are not mistaken for
  // interface background.
  const ring = LOCALIZER.ringBlocks;
  const flatCounts = new Map();
  let ringTotal = 0;
  for (let by = 0; by < rows; by += 1) {
    for (let bx = 0; bx < cols; bx += 1) {
      if (by >= ring && by < rows - ring && bx >= ring && bx < cols - ring) continue;
      ringTotal += 1;
      const i = by * cols + bx;
      if (share[i] >= LOCALIZER.flatShare) flatCounts.set(dominant[i], (flatCounts.get(dominant[i]) || 0) + 1);
    }
  }
  const palette = new Set();
  for (const [key, c] of flatCounts) if (c >= LOCALIZER.paletteMinShare * ringTotal) palette.add(key);
  const background = new Uint8Array(cols * rows);
  for (let i = 0; i < cols * rows; i += 1) {
    background[i] = palette.has(dominant[i]) && share[i] >= LOCALIZER.dominantMax ? 1 : 0;
  }
  return { cols, rows, rich, background };
}

// Maximum-sum subrectangle (Kadane over column pairs): rich blocks +1, other
// blocks -flatPenalty. O(cols^2 * rows) on a grid of at most 64 x 64.
function bestRectangle(stats) {
  const { rich, cols, rows } = stats;
  let best = { sum: -Infinity, x0: 0, x1: 0, y0: 0, y1: 0 };
  const rowSums = new Float64Array(rows);
  for (let x0 = 0; x0 < cols; x0 += 1) {
    rowSums.fill(0);
    for (let x1 = x0; x1 < cols; x1 += 1) {
      for (let y = 0; y < rows; y += 1) rowSums[y] += rich[y * cols + x1] ? 1 : -LOCALIZER.flatPenalty;
      let run = 0, start = 0;
      for (let y = 0; y < rows; y += 1) {
        if (run <= 0) { run = rowSums[y]; start = y; } else run += rowSums[y];
        if (run > best.sum) best = { sum: run, x0, x1, y0: start, y1: y };
      }
    }
  }
  return best;
}

function stripBackground(stats, x0, x1, y0, y1) {
  let bg = 0, total = 0;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) { bg += stats.background[y * stats.cols + x]; total += 1; }
  }
  return total ? bg / total : 1;
}

// Grow the core rectangle while the next row/column strip is picture, not
// interface background, so smooth skies and plain studio backdrops inside a
// picture stay inside it.
function grow(stats, rect) {
  let { x0, x1, y0, y1 } = rect;
  const limit = LOCALIZER.growMaxBackground;
  let changed = true;
  while (changed) {
    changed = false;
    if (y0 > 0 && stripBackground(stats, x0, x1, y0 - 1, y0 - 1) <= limit) { y0 -= 1; changed = true; }
    if (y1 < stats.rows - 1 && stripBackground(stats, x0, x1, y1 + 1, y1 + 1) <= limit) { y1 += 1; changed = true; }
    if (x0 > 0 && stripBackground(stats, x0 - 1, x0 - 1, y0, y1) <= limit) { x0 -= 1; changed = true; }
    if (x1 < stats.cols - 1 && stripBackground(stats, x1 + 1, x1 + 1, y0, y1) <= limit) { x1 += 1; changed = true; }
  }
  return { x0, x1, y0, y1 };
}

function localizeContent(rgba, width, height) {
  const block = LOCALIZER.block;
  const stats = blockStats(rgba, width, height);
  const { cols, rows } = stats;
  if (cols < 8 || rows < 8) return null;
  let richCount = 0;
  for (const v of stats.rich) richCount += v;
  if (richCount < 12) return null;
  const core = bestRectangle(stats);
  const r = grow(stats, core);
  const wBlocks = r.x1 - r.x0 + 1, hBlocks = r.y1 - r.y0 + 1;
  if (Math.min(wBlocks, hBlocks) < LOCALIZER.minSideBlocks) return null;
  const areaFrac = (wBlocks * hBlocks) / (cols * rows);
  if (areaFrac < LOCALIZER.minAreaFrac || areaFrac > LOCALIZER.maxAreaFrac) return null;
  // How much of the frame outside the picture is flat interface background.
  let outside = 0, outsideBg = 0;
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) continue;
      outside += 1; outsideBg += stats.background[y * cols + x];
    }
  }
  return {
    x: r.x0 * block, y: r.y0 * block, width: wBlocks * block, height: hBlocks * block,
    areaFrac, outsideBackground: outside ? outsideBg / outside : 0,
  };
}

module.exports = { LOCALIZER, blockStats, bestRectangle, grow, localizeContent };
