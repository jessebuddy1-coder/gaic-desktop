/* GAIC image-model worker.
   Decode, picture localization, bounded multi-region preprocessing,
   normalization, WASM inference, and output conversion all run off the UI
   thread. The worker receives one transferable image buffer and returns only
   bounded per-region scores. */
"use strict";

importScripts("model-config.js", "vendor/ort/ort.min.js");
// The decision head ships as its own file so a missing copy degrades to the
// engine v2 scan instead of stopping the worker.
try { importScripts("image-head.js"); } catch (_) {}

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_RESIZED_LONG_EDGE = 8192;
const DEFAULT = {
  model: "models/ai-detector.onnx",
  size: 224,
  mean: [0.485, 0.456, 0.406],
  std: [0.229, 0.224, 0.225],
  aiIndex: 0,
  softmax: true,
};
const cfg = Object.assign({}, DEFAULT, self.AICHECK_ONNX || {});
let sessionPromise = null;
const REGION_SCAN_VERSION = [
  "whole-center-corners-v1",
  "whole-center-corners-lower-v2",
  "whole-center-grid-v3",
  "whole-center-mid-lower-v4",
  "whole-official-center-mid-lower-v5",
].includes(cfg.regionScan)
  ? cfg.regionScan
  : "whole-official-center-mid-lower-v5";
const MAX_REGION_OUTPUTS = Number.isSafeInteger(cfg.maxRegions) &&
  cfg.maxRegions >= 1 && cfg.maxRegions <= 8
  ? cfg.maxRegions
  : 8;
const REGION_LABELS = Object.freeze({
  whole: "Whole frame",
  center: "Center",
  "top-left": "Top left",
  "top-right": "Top right",
  "bottom-left": "Bottom left",
  "bottom-right": "Bottom right",
  "lower-center": "Lower center",
  "middle-center": "Middle center",
  "compatibility-frame": "Compatibility frame",
  picture: "Detected picture",
});

function configureOrtRuntime() {
  if (!self.ort || !self.ort.env || !self.ort.env.wasm) return;
  // importScripts() does not give ONNX Runtime a reliable script URL inside a
  // dedicated worker. Pin both reviewed sidecars to absolute, same-origin URLs
  // so web, Capacitor, Electron, and the extension all load the bundled files
  // instead of incorrectly probing the site root.
  self.ort.env.wasm.wasmPaths = {
    mjs: new URL(
      "vendor/ort/ort-wasm-simd-threaded.jsep.mjs",
      self.location.href,
    ).href,
    wasm: new URL(
      "vendor/ort/ort-wasm-simd-threaded.jsep.wasm",
      self.location.href,
    ).href,
  };
  self.ort.env.wasm.numThreads = 1;
}

function boundedError(code) {
  return { ok: false, code };
}

async function session() {
  if (!sessionPromise) {
    try { configureOrtRuntime(); } catch (_) {}
    sessionPromise = self.ort.InferenceSession.create(cfg.model, {
      executionProviders: ["wasm"],
    }).catch(() => null);
  }
  const value = await sessionPromise;
  if (!value) sessionPromise = null;
  return value;
}

function finiteDimension(value) {
  return Number.isFinite(value) && value > 0 ? Number(value) : 0;
}

function boundedCrop(sourceX, sourceY, sourceWidth, sourceHeight, width, height) {
  const x = Math.max(0, Math.min(width, sourceX));
  const y = Math.max(0, Math.min(height, sourceY));
  const cropWidth = Math.max(1, Math.min(width - x, sourceWidth));
  const cropHeight = Math.max(1, Math.min(height - y, sourceHeight));
  return {
    sourceX: x,
    sourceY: y,
    sourceWidth: cropWidth,
    sourceHeight: cropHeight,
  };
}

/* torchvision Resize(int) floors the proportional long edge, and CenterCrop
   uses Python's round-half-to-even rule. Keep those integer geometry rules
   explicit instead of replacing both operations with one fractional Canvas2D
   source crop: the one-step shortcut materially changed reviewed model scores. */
function roundHalfToEven(value) {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction === 0.5) return floor % 2 === 0 ? floor : floor + 1;
  return Math.round(value);
}

function officialCenterGeometry(
  widthValue,
  heightValue,
  resizeShortestValue,
  cropSizeValue,
) {
  const width = finiteDimension(widthValue);
  const height = finiteDimension(heightValue);
  const resizeShortest = Number(resizeShortestValue);
  const cropSize = Number(cropSizeValue);
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    !Number.isSafeInteger(resizeShortest) ||
    !Number.isSafeInteger(cropSize) ||
    resizeShortest < cropSize ||
    cropSize < 1
  ) return null;
  const short = Math.min(width, height);
  const long = Math.max(width, height);
  const resizedLong = Math.floor(resizeShortest * long / short);
  const resizedWidth = width <= height ? resizeShortest : resizedLong;
  const resizedHeight = width <= height ? resizedLong : resizeShortest;
  if (
    resizedWidth < cropSize ||
    resizedHeight < cropSize ||
    resizedWidth > MAX_RESIZED_LONG_EDGE ||
    resizedHeight > MAX_RESIZED_LONG_EDGE
  ) return null;
  return {
    resizedWidth,
    resizedHeight,
    cropX: roundHalfToEven((resizedWidth - cropSize) / 2),
    cropY: roundHalfToEven((resizedHeight - cropSize) / 2),
  };
}

/* The reviewed model was trained with random crops and evaluated with a center
   crop after first resizing the shortest edge. Preserve that two-step official
   center view exactly at the geometry level. A single center crop is still a
   poor fit for a portal screenshot, where the generated picture may occupy one
   side of a much larger browser frame, so add one whole-frame overview, four
   corner detail crops, and two center-column detail crops. This is
   multiple-instance use of the same model, not a new model or an accuracy
   claim. */
function buildRegionPlan(widthValue, heightValue) {
  const width = finiteDimension(widthValue);
  const height = finiteDimension(heightValue);
  if (!width || !height) return [];
  const shortest = Math.min(width, height);
  const resizeShortest = Number(cfg.resizeShortest);
  const modelSize = Number(cfg.size);
  const centerScale = Number.isFinite(resizeShortest) &&
    resizeShortest >= modelSize && modelSize > 0
    ? modelSize / resizeShortest
    : 1;
  const centerSide = Math.max(1, Math.min(shortest, shortest * centerScale));
  // A smaller detail window gives the corner views enough separation to find
  // an embedded picture while retaining surrounding visual context.
  const detailSide = Math.max(
    1,
    Math.min(shortest, Math.max(modelSize || 224, shortest * 0.68)),
  );
  const center = boundedCrop(
    (width - centerSide) / 2,
    (height - centerSide) / 2,
    centerSide,
    centerSide,
    width,
    height,
  );
  const corners = [
    ["top-left", 0, 0],
    ["top-right", width - detailSide, 0],
    ["bottom-left", 0, height - detailSide],
    ["bottom-right", width - detailSide, height - detailSide],
  ];
  const candidates = [
    {
      id: "whole",
      label: REGION_LABELS.whole,
      mode: "contain",
      sourceX: 0,
      sourceY: 0,
      sourceWidth: width,
      sourceHeight: height,
    },
    {
      id: "center",
      label: REGION_LABELS.center,
      mode: "official-center",
      ...center,
    },
    ...corners.map(([id, x, y]) => ({
      id,
      label: REGION_LABELS[id],
      mode: "crop",
      ...boundedCrop(x, y, detailSide, detailSide, width, height),
    })),
    {
      id: "lower-center",
      label: REGION_LABELS["lower-center"],
      mode: "crop",
      ...boundedCrop(
        (width - detailSide) / 2,
        height - detailSide,
        detailSide,
        detailSide,
        width,
        height,
      ),
    },
    {
      id: "middle-center",
      label: REGION_LABELS["middle-center"],
      mode: "crop",
      ...boundedCrop(
        (width - detailSide) / 2,
        (height - detailSide) / 2,
        detailSide,
        detailSide,
        width,
        height,
      ),
    },
  ];
  const seen = new Set();
  return candidates.filter((region) => {
    const key = [
      region.mode,
      Math.round(region.sourceX),
      Math.round(region.sourceY),
      Math.round(region.sourceWidth),
      Math.round(region.sourceHeight),
    ].join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_REGION_OUTPUTS);
}

function neutralFill(context, size) {
  const mean = Array.isArray(cfg.mean) && cfg.mean.length === 3
    ? cfg.mean
    : DEFAULT.mean;
  const channels = mean.map((value) =>
    Math.max(0, Math.min(255, Math.round(Number(value) * 255))));
  context.fillStyle = `rgb(${channels[0]},${channels[1]},${channels[2]})`;
  context.fillRect(0, 0, size, size);
}

function tensorForRegion(bitmap, region) {
  const size = cfg.size;
  const canvas = new OffscreenCanvas(size, size);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  neutralFill(context, size);
  if (region.mode === "official-center") {
    const geometry = officialCenterGeometry(
      bitmap.width,
      bitmap.height,
      cfg.resizeShortest,
      size,
    );
    if (!geometry) return null;
    const resized = new OffscreenCanvas(
      geometry.resizedWidth,
      geometry.resizedHeight,
    );
    const resizedContext = resized.getContext("2d");
    if (!resizedContext) return null;
    resizedContext.imageSmoothingEnabled = true;
    resizedContext.imageSmoothingQuality = "high";
    resizedContext.drawImage(
      bitmap,
      0,
      0,
      bitmap.width,
      bitmap.height,
      0,
      0,
      geometry.resizedWidth,
      geometry.resizedHeight,
    );
    context.imageSmoothingEnabled = false;
    context.drawImage(
      resized,
      geometry.cropX,
      geometry.cropY,
      size,
      size,
      0,
      0,
      size,
      size,
    );
  } else if (region.mode === "contain") {
    const scale = Math.min(size / bitmap.width, size / bitmap.height);
    const drawWidth = bitmap.width * scale;
    const drawHeight = bitmap.height * scale;
    context.drawImage(
      bitmap,
      0,
      0,
      bitmap.width,
      bitmap.height,
      (size - drawWidth) / 2,
      (size - drawHeight) / 2,
      drawWidth,
      drawHeight,
    );
  } else {
    context.drawImage(
      bitmap,
      region.sourceX,
      region.sourceY,
      region.sourceWidth,
      region.sourceHeight,
      0,
      0,
      size,
      size,
    );
  }
  const pixels = context.getImageData(0, 0, size, size).data;
  const values = new Float32Array(3 * size * size);
  for (let index = 0; index < size * size; index += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      values[channel * size * size + index] =
        (pixels[index * 4 + channel] / 255 - cfg.mean[channel]) / cfg.std[channel];
    }
  }
  return new self.ort.Tensor("float32", values, [1, 3, size, size]);
}

async function decodedRegions(bytes, type, allowPicture) {
  if (
    !(bytes instanceof ArrayBuffer) ||
    bytes.byteLength < 1 ||
    bytes.byteLength > MAX_INPUT_BYTES ||
    typeof createImageBitmap !== "function" ||
    typeof OffscreenCanvas !== "function"
  ) {
    return null;
  }
  const bitmap = await createImageBitmap(new Blob([bytes], {
    type: typeof type === "string" && type.startsWith("image/") ? type : "application/octet-stream",
  }));
  let picture = null;
  if (allowPicture) {
    try { picture = locatePicture(bitmap); } catch (_) { picture = null; }
  }
  const regions = buildRegionPlan(bitmap.width, bitmap.height);
  if (!regions.length) {
    bitmap.close();
    return null;
  }
  return { bitmap, regions, picture };
}

function tensorFromRgba(pixels, width, height) {
  const size = cfg.size;
  if (
    !(pixels instanceof ArrayBuffer) ||
    width !== size ||
    height !== size ||
    pixels.byteLength !== size * size * 4
  ) return null;
  const rgba = new Uint8ClampedArray(pixels);
  const values = new Float32Array(3 * size * size);
  for (let index = 0; index < size * size; index += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      values[channel * size * size + index] =
        (rgba[index * 4 + channel] / 255 - cfg.mean[channel]) /
        cfg.std[channel];
    }
  }
  return new self.ort.Tensor(
    "float32",
    values,
    [1, 3, size, size]
  );
}

function boundedRgbaRegions(request) {
  const regions = request && request.regions;
  if (
    !Array.isArray(regions) ||
    regions.length < 1 ||
    regions.length > MAX_REGION_OUTPUTS
  ) return null;
  const seen = new Set();
  const safe = [];
  for (const region of regions) {
    if (!region || typeof region !== "object") return null;
    const id = String(region.id || "");
    if (
      id === "compatibility-frame" ||
      id === "picture" ||
      !REGION_LABELS[id] ||
      seen.has(id) ||
      !(region.pixels instanceof ArrayBuffer) ||
      region.width !== cfg.size ||
      region.height !== cfg.size ||
      region.pixels.byteLength !== cfg.size * cfg.size * 4
    ) return null;
    seen.add(id);
    safe.push({
      id,
      pixels: region.pixels,
      width: region.width,
      height: region.height,
    });
  }
  return safe;
}

function softmax(values) {
  const maximum = Math.max.apply(null, values);
  const exponentials = values.map((value) => Math.exp(value - maximum));
  const total = exponentials.reduce((sum, value) => sum + value, 0);
  return exponentials.map((value) => value / total);
}

function resultScore(values) {
  if (cfg.output === "sigmoid") return 1 / (1 + Math.exp(-values[0]));
  const probabilities = cfg.softmax ? softmax(values) : values;
  return probabilities.length > cfg.aiIndex
    ? probabilities[cfg.aiIndex]
    : probabilities[0];
}

function boundedRegionScore(region) {
  if (!region || typeof region !== "object") return null;
  const id = String(region.id || "");
  const score = Number(region.aiLikelihood);
  if (!REGION_LABELS[id] || !Number.isFinite(score)) return null;
  return {
    id,
    label: REGION_LABELS[id],
    aiLikelihood: Math.max(0, Math.min(1, score)),
  };
}

/* This is intentionally max/strongest-region aggregation: the product asks
   whether any visible region contains a detector signal. The result contract
   names that choice and returns every bounded component score so the UI can
   disclose it. The 99-point product warning band remains unchanged because
   multi-crop calibration has not yet been measured. */
function aggregateRegionScores(regionScores) {
  const safe = (Array.isArray(regionScores) ? regionScores : [])
    .map(boundedRegionScore)
    .filter(Boolean)
    .slice(0, MAX_REGION_OUTPUTS);
  if (!safe.length) return null;
  let strongest = safe[0];
  for (const region of safe.slice(1)) {
    if (region.aiLikelihood > strongest.aiLikelihood) strongest = region;
  }
  return {
    aiLikelihood: strongest.aiLikelihood,
    strongestRegion: strongest.id,
    regionScores: safe,
    aggregation: "strongest-region",
    regionScan: REGION_SCAN_VERSION,
    centerPreprocessing: "resize-shortest-center-crop-v1",
  };
}

async function inferScore(activeSession, input) {
  const feeds = { [activeSession.inputNames[0]]: input };
  const output = await activeSession.run(feeds);
  const values = Array.from(output[activeSession.outputNames[0]].data);
  const score = resultScore(values);
  return Number.isFinite(score) ? score : null;
}

/* ---------- decision head (engine v3) ----------
   The bundled model's own last layer reads a single 384-value summary of the
   picture. The v3 model file exposes a little more of what the same network
   already computes (weights unchanged): the class token and the mean patch
   token after blocks 6, 9, and 12, 2,304 values per view. A second linear head,
   trained on 2025-2026 generators and on real photos, artwork, charts,
   screenshots, and app interfaces, reads them. Every view the scan already runs
   is read by the head; views are averaged in logit space, and the average is
   mapped to a calibrated probability per scan kind (models/AICHECK-IMAGE-MODEL.md). */
let imageHeadCache;
function imageHead() {
  if (imageHeadCache !== undefined) return imageHeadCache;
  imageHeadCache = null;
  const head = self.AICHECK_IMAGE_HEAD;
  if (!head || !Number.isSafeInteger(head.dim) || head.dim < 1 ||
      !head.weights || head.weights.length !== head.dim || !Number.isFinite(head.bias) ||
      !head.calibration) return null;
  const weights = Float32Array.from(head.weights);
  if (!weights.every(Number.isFinite)) return null;
  imageHeadCache = { version: String(head.version || ""), dim: head.dim, weights, bias: head.bias,
    composite: head.composite === "picture" || head.composite === "mean" ? head.composite : "max",
    calibration: head.calibration };
  return imageHeadCache;
}

function headLogit(features) {
  const head = imageHead();
  if (!head || !features || features.length !== head.dim) return null;
  let z = head.bias;
  for (let i = 0; i < head.dim; i += 1) z += head.weights[i] * features[i];
  return Number.isFinite(z) ? z : null;
}

async function inferView(activeSession, input) {
  const feeds = { [activeSession.inputNames[0]]: input };
  const output = await activeSession.run(feeds);
  const values = Array.from(output[activeSession.outputNames[0]].data);
  const score = resultScore(values);
  const features = output.features;
  return {
    score: Number.isFinite(score) ? score : null,
    head: features && features.data ? headLogit(features.data) : null,
  };
}

function interpolateKnots(knots, x) {
  if (x <= knots[0][0]) return knots[0][1];
  for (let i = 1; i < knots.length; i += 1) {
    if (x <= knots[i][0]) {
      const [x0, y0] = knots[i - 1], [x1, y1] = knots[i];
      return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
    }
  }
  return knots[knots.length - 1][1];
}

function calibratedHead(kind, logit) {
  const head = imageHead();
  const table = head && head.calibration && head.calibration[kind];
  if (!table || !Array.isArray(table.knots) || table.knots.length < 2 || !Number.isFinite(logit)) return null;
  const logOdds = interpolateKnots(table.knots, logit);
  const probability = 1 / (1 + Math.exp(-logOdds));
  return Number.isFinite(probability) ? { probability, cuts: table.cuts || null } : null;
}

function meanOf(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/* The frame reading is the mean over the v5 views. A located picture (scan
   v6) is read on its own views, and the composite reading follows the head's
   declared rule. Video frames report their per-frame logit; the caller takes
   the median over frames and calibrates it as "frame". */
function headResult(frameLogits, pictureLogits, videoFrame) {
  const head = imageHead();
  if (!head || !frameLogits.length || frameLogits.some((value) => value === null)) return null;
  const frame = meanOf(frameLogits);
  let logit = frame, kind = videoFrame ? "frame" : "direct";
  const picture = pictureLogits.length && pictureLogits.every((value) => value !== null)
    ? meanOf(pictureLogits) : null;
  if (picture !== null && !videoFrame) {
    kind = "composite";
    logit = head.composite === "picture" ? picture
      : head.composite === "mean" ? (picture + frame) / 2
        : Math.max(picture, frame);
  }
  const calibrated = calibratedHead(kind, logit);
  if (!calibrated) return null;
  return {
    version: head.version.slice(0, 80),
    kind,
    logit: Math.round(logit * 1e4) / 1e4,
    probability: Math.round(calibrated.probability * 1e4) / 1e4,
    cuts: calibrated.cuts,
    views: frameLogits.length + (picture !== null ? pictureLogits.length : 0),
  };
}

/* ---------- scan v6: composite frames (screenshots, letterboxed frames) ----------
   The bundled model was trained on whole pictures resized so the shortest
   side is ~225-275 px, then randomly cropped and mirrored. A screenshot of a
   picture puts status bars, page margins, chat chrome, or player bars around
   it, so every v5 view of such a frame mixes interface pixels the model never
   saw with a downscaled copy of the picture. When the frame is clearly a
   picture surrounded by flat interface background, v6 locates the picture
   and averages the model over mirrored and corner views of it at the trained
   scale. The reviewed v5 scan still runs on every frame, and a composite's
   headline is the higher of the two readings, so the picture reading can only
   add detections. Ordinary photos and images get the v5 scan alone,
   unchanged. The averaged logit gets one fixed shift, chosen on a
   calibration half of 520 real-photo screenshots so that no real screenshot
   reaches the 95/100 band, minus a 0.5-logit safety margin (see
   models/AICHECK-IMAGE-MODEL.md). */
const PICTURE_SCAN_VERSION = "content-aware-tta-v6";
const PICTURE_SCAN = Object.freeze({
  localizeLongSide: 512,
  pictureInset: 0.02,
  // Share of the frame outside the picture that must be flat interface
  // background, and the most that may carry other marks. Screenshots have
  // clean interface backgrounds; ordinary photos with a plain backdrop do not.
  pictureGate: 0.9,
  marksMax: 0.02,
  views: Object.freeze([
    Object.freeze({ id: "center", resize: 256, fx: 0.5, fy: 0.5, flip: false }),
    Object.freeze({ id: "center-flip", resize: 256, fx: 0.5, fy: 0.5, flip: true }),
    Object.freeze({ id: "top-left", resize: 256, fx: 0, fy: 0, flip: false }),
    Object.freeze({ id: "bottom-right", resize: 256, fx: 1, fy: 1, flip: false }),
  ]),
  calibrationShift: 1.5,
});
const PICTURE_VIEW_IDS = Object.freeze(PICTURE_SCAN.views.map((view) => "picture:" + view.id));
const LOCALIZER = Object.freeze({
  block: 8,
  richColors: 8,
  dominantMax: 0.6,
  flatShare: 0.9,
  ringBlocks: 2,
  paletteMinShare: 0.04,
  flatPenalty: 0.5,
  growMaxBackground: 0.3,
  minAreaFrac: 0.02,
  maxAreaFrac: 0.9,
  minSideBlocks: 6,
});

// Resize a subject so its shortest side is `resizeShortest`, then place a
// crop of `cropSize` at relative position (fx, fy). With 256 and 0.5/0.5 this
// is exactly officialCenterGeometry().
function viewGeometry(width, height, resizeShortest, cropSize, fx, fy) {
  if (
    !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
    width < 1 || height < 1 ||
    !Number.isSafeInteger(resizeShortest) || !Number.isSafeInteger(cropSize) ||
    resizeShortest < cropSize || cropSize < 1
  ) return null;
  const short = Math.min(width, height);
  const long = Math.max(width, height);
  const resizedLong = Math.floor(resizeShortest * long / short);
  const resizedWidth = width <= height ? resizeShortest : resizedLong;
  const resizedHeight = width <= height ? resizedLong : resizeShortest;
  if (
    resizedWidth < cropSize || resizedHeight < cropSize ||
    resizedWidth > MAX_RESIZED_LONG_EDGE || resizedHeight > MAX_RESIZED_LONG_EDGE
  ) return null;
  const place = (free, f) => (f === 0.5 ? roundHalfToEven(free / 2) : Math.round(free * f));
  return {
    resizedWidth,
    resizedHeight,
    cropX: place(resizedWidth - cropSize, fx),
    cropY: place(resizedHeight - cropSize, fy),
  };
}

/* Picture localization, mirrored in onnx-detector.js. Classifies 8x8 blocks
   of a <=512 px copy as rich (many colors, no dominant flat color) or not,
   finds the maximum-sum rectangle of rich blocks, then grows it until it
   meets interface background: flat colors found on the frame's outer ring
   (status bars, page margins, sidebars, letterbox bars). */
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

function growRectangle(stats, rect) {
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

// Returns the picture rectangle (buffer coordinates), the share of the rest
// of the frame that is interface background, and the share carrying other
// marks; or null when no separate picture exists.
function localizeContent(rgba, width, height) {
  const block = LOCALIZER.block;
  const stats = blockStats(rgba, width, height);
  const { cols, rows } = stats;
  if (cols < 8 || rows < 8) return null;
  let richCount = 0;
  for (const v of stats.rich) richCount += v;
  if (richCount < 12) return null;
  const r = growRectangle(stats, bestRectangle(stats));
  const wBlocks = r.x1 - r.x0 + 1, hBlocks = r.y1 - r.y0 + 1;
  if (Math.min(wBlocks, hBlocks) < LOCALIZER.minSideBlocks) return null;
  const areaFrac = (wBlocks * hBlocks) / (cols * rows);
  if (areaFrac < LOCALIZER.minAreaFrac || areaFrac > LOCALIZER.maxAreaFrac) return null;
  let outside = 0, outsideBg = 0, outsideMarks = 0;
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) continue;
      const i = y * cols + x;
      outside += 1;
      outsideBg += stats.background[i];
      if (!stats.background[i] && !stats.rich[i]) outsideMarks += 1;
    }
  }
  return {
    x: r.x0 * block, y: r.y0 * block, width: wBlocks * block, height: hBlocks * block,
    areaFrac,
    outsideBackground: outside ? outsideBg / outside : 0,
    outsideMarks: outside ? outsideMarks / outside : 0,
  };
}

// Picture rectangle in source pixels when the frame is a composite, else null.
function locatePicture(bitmap) {
  const width = bitmap.width, height = bitmap.height;
  const scale = Math.min(1, PICTURE_SCAN.localizeLongSide / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, width, height, 0, 0, w, h);
  const found = localizeContent(context.getImageData(0, 0, w, h).data, w, h);
  if (
    !found ||
    found.outsideBackground < PICTURE_SCAN.pictureGate ||
    found.outsideMarks >= PICTURE_SCAN.marksMax
  ) return null;
  const inset = PICTURE_SCAN.pictureInset;
  const x = found.x / scale, y = found.y / scale;
  const pw = found.width / scale, ph = found.height / scale;
  const rect = {
    x: Math.max(0, Math.floor(x + pw * inset)),
    y: Math.max(0, Math.floor(y + ph * inset)),
    width: Math.floor(pw * (1 - 2 * inset)),
    height: Math.floor(ph * (1 - 2 * inset)),
  };
  rect.width = Math.min(rect.width, width - rect.x);
  rect.height = Math.min(rect.height, height - rect.y);
  if (Math.min(rect.width, rect.height) < 32) return null;
  return { rect, areaFrac: found.areaFrac };
}

function tensorFromPixels(pixels) {
  const size = cfg.size;
  const values = new Float32Array(3 * size * size);
  for (let index = 0; index < size * size; index += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      values[channel * size * size + index] =
        (pixels[index * 4 + channel] / 255 - cfg.mean[channel]) / cfg.std[channel];
    }
  }
  return new self.ort.Tensor("float32", values, [1, 3, size, size]);
}

function tensorForView(bitmap, rect, view) {
  const size = cfg.size;
  const geometry = viewGeometry(rect.width, rect.height, view.resize, size, view.fx, view.fy);
  if (!geometry) return null;
  const resized = new OffscreenCanvas(geometry.resizedWidth, geometry.resizedHeight);
  const resizedContext = resized.getContext("2d");
  if (!resizedContext) return null;
  resizedContext.imageSmoothingEnabled = true;
  resizedContext.imageSmoothingQuality = "high";
  resizedContext.drawImage(
    bitmap, rect.x, rect.y, rect.width, rect.height,
    0, 0, geometry.resizedWidth, geometry.resizedHeight,
  );
  const canvas = new OffscreenCanvas(size, size);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.imageSmoothingEnabled = false;
  if (view.flip) {
    context.translate(size, 0);
    context.scale(-1, 1);
  }
  context.drawImage(resized, geometry.cropX, geometry.cropY, size, size, 0, 0, size, size);
  return tensorFromPixels(context.getImageData(0, 0, size, size).data);
}

function scoreLogit(score) {
  const q = Math.min(1 - 1e-7, Math.max(1e-7, score));
  return Math.log(q / (1 - q));
}

// Split a compatibility RGBA batch into reviewed v5 regions and picture views.
function splitRgbaRequest(request) {
  const all = request && request.regions;
  if (!Array.isArray(all)) return null;
  const picture = [];
  const regions = [];
  for (const item of all) {
    (item && PICTURE_VIEW_IDS.includes(String(item.id)) ? picture : regions).push(item);
  }
  if (picture.length > PICTURE_VIEW_IDS.length) return null;
  const safeRegions = boundedRgbaRegions({ regions });
  if (!safeRegions) return null;
  const seen = new Set();
  const safePicture = [];
  for (const view of picture) {
    const id = String(view.id);
    if (
      seen.has(id) ||
      !(view.pixels instanceof ArrayBuffer) ||
      view.width !== cfg.size ||
      view.height !== cfg.size ||
      view.pixels.byteLength !== cfg.size * cfg.size * 4
    ) return null;
    seen.add(id);
    safePicture.push(new Uint8ClampedArray(view.pixels));
  }
  return { regions: safeRegions, picture: safePicture };
}

/* The picture's views are averaged in logit space (test-time augmentation
   over views the model was trained on) and shifted once onto the reviewed
   95/99 band scale. The headline is the higher of that reading and the v5
   strongest-region value; both are returned so the UI can disclose them. */
function combineWithPicture(regionResult, pictureLogits, pictureArea) {
  if (!regionResult || !pictureLogits.length) return regionResult;
  const mean = pictureLogits.reduce((sum, value) => sum + value, 0) / pictureLogits.length;
  const picture = Math.max(0, Math.min(1,
    1 / (1 + Math.exp(-(mean + PICTURE_SCAN.calibrationShift)))));
  const strongest = regionResult.regionScores.find((region) =>
    region.id === regionResult.strongestRegion) || regionResult.regionScores[0];
  return {
    aiLikelihood: Math.max(regionResult.aiLikelihood, picture),
    strongestRegion: picture > regionResult.aiLikelihood ? "picture" : regionResult.strongestRegion,
    regionScores: [
      { id: "picture", label: REGION_LABELS.picture, aiLikelihood: picture },
      strongest,
    ],
    viewsAveraged: pictureLogits.length,
    frameRegions: regionResult.regionScores.length,
    pictureArea: Math.max(0, Math.min(1, Math.round(pictureArea * 1000) / 1000)),
    aggregation: "strongest-of-picture-and-regions",
    regionScan: PICTURE_SCAN_VERSION,
    frameRegionScan: regionResult.regionScan,
    centerPreprocessing: regionResult.centerPreprocessing,
  };
}

/* Scan progress for the checker's on-screen viewfinder. Before each view is
   read, the worker names it: the phase, its place in the plan, and the
   rectangle it covers as fractions (0-1) of the source image. Progress
   messages carry no pixels and no scores, never settle a request, and never
   enter the result. */
function progressRect(x, y, width, height, sourceWidth, sourceHeight) {
  if (!(sourceWidth > 0 && sourceHeight > 0)) return null;
  const unit = (value) => Math.max(0, Math.min(1, Math.round(value * 10000) / 10000));
  const left = unit(x / sourceWidth), top = unit(y / sourceHeight);
  return {
    x: left,
    y: top,
    width: Math.min(1 - left, unit(width / sourceWidth)),
    height: Math.min(1 - top, unit(height / sourceHeight)),
  };
}

function viewProgressRect(rect, view, sourceWidth, sourceHeight) {
  const geometry = viewGeometry(rect.width, rect.height, view.resize, cfg.size, view.fx, view.fy);
  if (!geometry) return null;
  const sx = rect.width / geometry.resizedWidth, sy = rect.height / geometry.resizedHeight;
  return progressRect(rect.x + geometry.cropX * sx, rect.y + geometry.cropY * sy,
    cfg.size * sx, cfg.size * sy, sourceWidth, sourceHeight);
}

function reportProgress(id, phase, index, total, rect) {
  try { self.postMessage({ id, progress: { phase, index, total, rect: rect || null } }); } catch (_) {}
}

self.addEventListener("message", async (event) => {
  const request = event.data && typeof event.data === "object" ? event.data : {};
  const id = Number(request.id);
  if (!Number.isSafeInteger(id) || id < 1) return;
  if (request.kind !== "detect" && request.kind !== "detect-rgba") {
    self.postMessage({ id, ...boundedError("invalid_request") });
    return;
  }
  try {
    const activeSession = await session();
    if (!activeSession) {
      self.postMessage({ id, ...boundedError("model_unavailable") });
      return;
    }
    reportProgress(id, "model-ready", 0, 0, null);
    let regionScores = [];
    const pictureLogits = [];
    const frameHeadLogits = [];
    const pictureHeadLogits = [];
    let pictureArea = 0;
    let sourceWidth = 0;
    let sourceHeight = 0;
    if (request.kind === "detect-rgba") {
      const split = splitRgbaRequest(request);
      if (!split) {
        self.postMessage({ id, ...boundedError("worker_unsupported") });
        return;
      }
      for (const region of split.regions) {
        reportProgress(id, "region", split.regions.indexOf(region), split.regions.length, null);
        const input = tensorFromRgba(
          region.pixels,
          region.width,
          region.height,
        );
        if (!input) {
          self.postMessage({ id, ...boundedError("worker_unsupported") });
          return;
        }
        const view = await inferView(activeSession, input);
        const score = view.score;
        if (!Number.isFinite(score)) {
          self.postMessage({ id, ...boundedError("invalid_output") });
          return;
        }
        regionScores.push({ id: region.id, aiLikelihood: score });
        frameHeadLogits.push(view.head);
      }
      for (const pixels of split.picture) {
        reportProgress(id, "picture-view", split.picture.indexOf(pixels), split.picture.length, null);
        const view = await inferView(activeSession, tensorFromPixels(pixels));
        const score = view.score;
        if (!Number.isFinite(score)) {
          self.postMessage({ id, ...boundedError("invalid_output") });
          return;
        }
        pictureLogits.push(scoreLogit(score));
        pictureHeadLogits.push(view.head);
      }
      pictureArea = Number(request.pictureArea) || 0;
      sourceWidth = Number(request.sourceWidth) || 0;
      sourceHeight = Number(request.sourceHeight) || 0;
    } else {
      // Video frames opt out: the picture reading was calibrated on
      // screenshots and screen captures, not on lossy video frames.
      const decoded = await decodedRegions(request.bytes, request.type, request.composite !== false);
      if (!decoded) {
        self.postMessage({ id, ...boundedError("worker_unsupported") });
        return;
      }
      sourceWidth = decoded.bitmap.width;
      sourceHeight = decoded.bitmap.height;
      reportProgress(id, "decoded", 0, decoded.regions.length, null);
      if (decoded.picture) reportProgress(id, "picture", 0, PICTURE_SCAN.views.length, progressRect(decoded.picture.rect.x, decoded.picture.rect.y, decoded.picture.rect.width, decoded.picture.rect.height, sourceWidth, sourceHeight));
      try {
        for (const region of decoded.regions) {
          reportProgress(id, "region", decoded.regions.indexOf(region), decoded.regions.length, progressRect(region.sourceX, region.sourceY, region.sourceWidth, region.sourceHeight, sourceWidth, sourceHeight));
          const input = tensorForRegion(decoded.bitmap, region);
          if (!input) {
            self.postMessage({ id, ...boundedError("worker_unsupported") });
            return;
          }
          const view = await inferView(activeSession, input);
          const score = view.score;
          if (!Number.isFinite(score)) {
            self.postMessage({ id, ...boundedError("invalid_output") });
            return;
          }
          regionScores.push({ id: region.id, aiLikelihood: score });
          frameHeadLogits.push(view.head);
        }
        if (decoded.picture) {
          for (const view of PICTURE_SCAN.views) {
            reportProgress(id, "picture-view", PICTURE_SCAN.views.indexOf(view), PICTURE_SCAN.views.length, viewProgressRect(decoded.picture.rect, view, sourceWidth, sourceHeight));
            const input = tensorForView(decoded.bitmap, decoded.picture.rect, view);
            if (!input) continue;
            const view = await inferView(activeSession, input);
            const score = view.score;
            if (!Number.isFinite(score)) {
              self.postMessage({ id, ...boundedError("invalid_output") });
              return;
            }
            pictureLogits.push(scoreLogit(score));
            pictureHeadLogits.push(view.head);
          }
          pictureArea = decoded.picture.areaFrac;
        }
      } finally {
        decoded.bitmap.close();
      }
    }
    const result = combineWithPicture(aggregateRegionScores(regionScores), pictureLogits, pictureArea);
    if (!result) {
      self.postMessage({ id, ...boundedError("invalid_output") });
      return;
    }
    // Absent when the head file or the model's feature output is missing; the
    // caller then falls back to the engine v2 reading.
    const head = headResult(frameHeadLogits, pictureHeadLogits, request.composite === false);
    self.postMessage({
      id,
      ok: true,
      result: {
        ...result,
        ...(head ? { head } : {}),
        model: String(cfg.id || cfg.model).slice(0, 160),
        revision: String(cfg.revision || "").slice(0, 80),
        sourceWidth: Math.max(0, Math.round(sourceWidth)),
        sourceHeight: Math.max(0, Math.round(sourceHeight)),
      },
    });
  } catch (_) {
    self.postMessage({ id, ...boundedError("inference_failed") });
  }
});
