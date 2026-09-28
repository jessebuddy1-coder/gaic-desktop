/* GAIC — on-device image likelihood model via ONNX Runtime Web.
   The reviewed model is configured in model-config.js and bundled with the
   app. This loader also remains usable for an explicitly configured replacement
   model; see models/AICHECK-IMAGE-MODEL.md for provenance and limitations. */
(function () {
  let lastError = "";
  let worker = null, workerUnavailable = false, workerSequence = 0;
  const workerRequests = new Map();
  // One decode now produces a bounded whole/center/corner plus middle/lower
  // center scan. Allow enough time for eight sequential WASM inferences on
  // slower web devices without
  // moving any model work back onto the UI thread.
  const WORKER_TIMEOUT_MS = 90 * 1000;
  const MAX_INPUT_BYTES = 8 * 1024 * 1024;
  // iOS 15 lacks worker OffscreenCanvas, so its compatibility path must decode
  // on the UI thread. Keep that exceptional path much smaller than the normal
  // 8 MiB / 24 MP worker path and reject it from raw headers before new Image()
  // can allocate a full decoded bitmap.
  const LEGACY_MAX_INPUT_BYTES = 2 * 1024 * 1024;
  const LEGACY_MAX_DIMENSION = 4096;
  const LEGACY_MAX_PIXELS = 12 * 1000 * 1000;
  const LEGACY_HEADER_BYTES = 512 * 1024;
  const LEGACY_LIMIT_ERROR =
    "On this older browser, the on-device model needs a readable image no larger than 2 MiB, 4096px per side, and 12 megapixels. File evidence was still checked locally.";
  const DEFAULT_SIZE = 224;
  const MAX_REGION_OUTPUTS = 8;
  const MAX_RESIZED_LONG_EDGE = 8192;
  const REGION_IDS = Object.freeze([
    "whole",
    "center",
    "top-left",
    "top-right",
    "bottom-left",
    "bottom-right",
    "lower-center",
    "middle-center",
  ]);

  function paintYield() {
    return new Promise((resolve) => {
      try {
        requestAnimationFrame(() => setTimeout(resolve, 0));
      } catch (_) {
        setTimeout(resolve, 0);
      }
    });
  }

  function u16be(bytes, offset) {
    return (bytes[offset] << 8) | bytes[offset + 1];
  }
  function u16le(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8);
  }
  function u24le(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16);
  }
  function u32be(bytes, offset) {
    return (
      bytes[offset] * 0x1000000 +
      (bytes[offset + 1] << 16) +
      (bytes[offset + 2] << 8) +
      bytes[offset + 3]
    );
  }
  function u32le(bytes, offset) {
    return (
      bytes[offset] +
      (bytes[offset + 1] << 8) +
      (bytes[offset + 2] << 16) +
      bytes[offset + 3] * 0x1000000
    );
  }
  function asciiAt(bytes, offset, text) {
    if (offset < 0 || offset + text.length > bytes.length) return false;
    for (let index = 0; index < text.length; index += 1) {
      if (bytes[offset + index] !== text.charCodeAt(index)) return false;
    }
    return true;
  }
  function encodedImageGeometry(bytes) {
    if (
      bytes.length >= 24 &&
      bytes[0] === 0x89 &&
      asciiAt(bytes, 1, "PNG\r\n\u001a\n")
    ) {
      return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
    }
    if (
      bytes.length >= 10 &&
      (asciiAt(bytes, 0, "GIF87a") || asciiAt(bytes, 0, "GIF89a"))
    ) {
      return { width: u16le(bytes, 6), height: u16le(bytes, 8) };
    }
    if (bytes.length >= 26 && asciiAt(bytes, 0, "BM")) {
      return {
        width: Math.abs(u32le(bytes, 18)),
        height: Math.abs(u32le(bytes, 22))
      };
    }
    if (
      bytes.length >= 30 &&
      asciiAt(bytes, 0, "RIFF") &&
      asciiAt(bytes, 8, "WEBP")
    ) {
      if (asciiAt(bytes, 12, "VP8X")) {
        return {
          width: 1 + u24le(bytes, 24),
          height: 1 + u24le(bytes, 27)
        };
      }
      if (asciiAt(bytes, 12, "VP8L") && bytes.length >= 25) {
        return {
          width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
          height: 1 + (bytes[22] >> 6) + (bytes[23] << 2) +
            ((bytes[24] & 0x0f) << 10)
        };
      }
      if (
        asciiAt(bytes, 12, "VP8 ") &&
        bytes.length >= 30 &&
        bytes[23] === 0x9d &&
        bytes[24] === 0x01 &&
        bytes[25] === 0x2a
      ) {
        return {
          width: u16le(bytes, 26) & 0x3fff,
          height: u16le(bytes, 28) & 0x3fff
        };
      }
    }
    if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      let offset = 2;
      while (offset + 8 < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
        const marker = bytes[offset];
        offset += 1;
        if (
          marker === 0xd8 ||
          marker === 0xd9 ||
          marker === 0x01 ||
          (marker >= 0xd0 && marker <= 0xd7)
        ) continue;
        if (offset + 2 > bytes.length) return null;
        const length = u16be(bytes, offset);
        if (length < 2 || offset + length > bytes.length) return null;
        if (
          length >= 7 &&
          ((marker >= 0xc0 && marker <= 0xc3) ||
            (marker >= 0xc5 && marker <= 0xc7) ||
            (marker >= 0xc9 && marker <= 0xcb) ||
            (marker >= 0xcd && marker <= 0xcf))
        ) {
          return {
            width: u16be(bytes, offset + 5),
            height: u16be(bytes, offset + 3)
          };
        }
        offset += length;
      }
    }
    return null;
  }
  function legacyGeometryAllowed(dimensions) {
    return !!(
      dimensions &&
      Number.isSafeInteger(dimensions.width) &&
      Number.isSafeInteger(dimensions.height) &&
      dimensions.width > 0 &&
      dimensions.height > 0 &&
      dimensions.width <= LEGACY_MAX_DIMENSION &&
      dimensions.height <= LEGACY_MAX_DIMENSION &&
      dimensions.width * dimensions.height <= LEGACY_MAX_PIXELS
    );
  }
  async function legacyInputAllowed(file) {
    if (
      !file ||
      !Number.isSafeInteger(file.size) ||
      file.size < 1 ||
      file.size > LEGACY_MAX_INPUT_BYTES ||
      typeof file.slice !== "function"
    ) return false;
    const header = file.slice(
      0,
      Math.min(file.size, LEGACY_HEADER_BYTES)
    );
    if (!header || typeof header.arrayBuffer !== "function") return false;
    const bytes = new Uint8Array(await header.arrayBuffer());
    return legacyGeometryAllowed(encodedImageGeometry(bytes));
  }

  function finiteDimension(value) {
    return Number.isFinite(value) && value > 0 ? Number(value) : 0;
  }

  function boundedCrop(sourceX, sourceY, sourceWidth, sourceHeight, width, height) {
    const x = Math.max(0, Math.min(width, sourceX));
    const y = Math.max(0, Math.min(height, sourceY));
    return {
      sourceX: x,
      sourceY: y,
      sourceWidth: Math.max(1, Math.min(width - x, sourceWidth)),
      sourceHeight: Math.max(1, Math.min(height - y, sourceHeight)),
    };
  }

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

  // Mirror detector-worker.js exactly for iOS 15, where workers exist but
  // worker OffscreenCanvas does not. The main thread only decodes and produces
  // at most eight fixed-size RGBA frames; normalization and every inference stay
  // in the worker.
  function buildCompatibilityRegionPlan(widthValue, heightValue, cfg, size) {
    const width = finiteDimension(widthValue);
    const height = finiteDimension(heightValue);
    if (!width || !height) return [];
    const shortest = Math.min(width, height);
    const resizeShortest = Number(cfg.resizeShortest);
    const centerScale = Number.isFinite(resizeShortest) &&
      resizeShortest >= size && size > 0
      ? size / resizeShortest
      : 1;
    const centerSide = Math.max(1, Math.min(shortest, shortest * centerScale));
    const detailSide = Math.max(
      1,
      Math.min(shortest, Math.max(size, shortest * 0.68)),
    );
    const center = boundedCrop(
      (width - centerSide) / 2,
      (height - centerSide) / 2,
      centerSide,
      centerSide,
      width,
      height,
    );
    const candidates = [
      {
        id: "whole",
        mode: "contain",
        sourceX: 0,
        sourceY: 0,
        sourceWidth: width,
        sourceHeight: height,
      },
      { id: "center", mode: "official-center", ...center },
      {
        id: "top-left",
        mode: "crop",
        ...boundedCrop(0, 0, detailSide, detailSide, width, height),
      },
      {
        id: "top-right",
        mode: "crop",
        ...boundedCrop(
          width - detailSide,
          0,
          detailSide,
          detailSide,
          width,
          height,
        ),
      },
      {
        id: "bottom-left",
        mode: "crop",
        ...boundedCrop(
          0,
          height - detailSide,
          detailSide,
          detailSide,
          width,
          height,
        ),
      },
      {
        id: "bottom-right",
        mode: "crop",
        ...boundedCrop(
          width - detailSide,
          height - detailSide,
          detailSide,
          detailSide,
          width,
          height,
        ),
      },
      {
        id: "lower-center",
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
    const configuredMaximum = Number.isSafeInteger(cfg.maxRegions) &&
      cfg.maxRegions >= 1 && cfg.maxRegions <= MAX_REGION_OUTPUTS
      ? cfg.maxRegions
      : MAX_REGION_OUTPUTS;
    const seen = new Set();
    return candidates.filter((region) => {
      if (!REGION_IDS.includes(region.id)) return false;
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
    }).slice(0, configuredMaximum);
  }

  function paintCompatibilityRegion(context, image, region, size, cfg) {
    const mean = Array.isArray(cfg.mean) && cfg.mean.length === 3
      ? cfg.mean
      : [0.485, 0.456, 0.406];
    const channels = mean.map((value) =>
      Math.max(0, Math.min(255, Math.round(Number(value) * 255))));
    context.clearRect(0, 0, size, size);
    context.fillStyle = `rgb(${channels[0]},${channels[1]},${channels[2]})`;
    context.fillRect(0, 0, size, size);
    if (region.mode === "official-center") {
      const width = image.naturalWidth || image.width;
      const height = image.naturalHeight || image.height;
      const geometry = officialCenterGeometry(
        width,
        height,
        cfg.resizeShortest,
        size,
      );
      if (!geometry) return false;
      const resized = document.createElement("canvas");
      resized.width = geometry.resizedWidth;
      resized.height = geometry.resizedHeight;
      const resizedContext = resized.getContext("2d");
      if (!resizedContext) return false;
      resizedContext.imageSmoothingEnabled = true;
      resizedContext.imageSmoothingQuality = "high";
      resizedContext.drawImage(
        image,
        0,
        0,
        width,
        height,
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
      return true;
    }
    if (region.mode === "contain") {
      const width = image.naturalWidth || image.width;
      const height = image.naturalHeight || image.height;
      const scale = Math.min(size / width, size / height);
      const drawWidth = width * scale;
      const drawHeight = height * scale;
      context.drawImage(
        image,
        0,
        0,
        width,
        height,
        (size - drawWidth) / 2,
        (size - drawHeight) / 2,
        drawWidth,
        drawHeight,
      );
      return true;
    }
    context.drawImage(
      image,
      region.sourceX,
      region.sourceY,
      region.sourceWidth,
      region.sourceHeight,
      0,
      0,
      size,
      size,
    );
    return true;
  }

  /* ---------- scan v6 composite branch (mirrors detector-worker.js) ----------
     Screenshots and letterboxed frames: locate the picture and render its
     mirrored and corner views at the trained scale, in addition to the v5
     regions below; the worker reports the higher reading. Ordinary images get
     the v5 plan alone. The shared constants and functions are copied verbatim
     from detector-worker.js; test/image-scan.test.mjs keeps them identical. */
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

  function locatePicture(image, width, height) {
    const scale = Math.min(1, PICTURE_SCAN.localizeLongSide / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, width, height, 0, 0, w, h);
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

  function paintCompatibilityView(context, image, rect, view, size) {
    const geometry = viewGeometry(rect.width, rect.height, view.resize, size, view.fx, view.fy);
    if (!geometry) return false;
    const resized = document.createElement("canvas");
    resized.width = geometry.resizedWidth;
    resized.height = geometry.resizedHeight;
    const resizedContext = resized.getContext("2d");
    if (!resizedContext) return false;
    resizedContext.imageSmoothingEnabled = true;
    resizedContext.imageSmoothingQuality = "high";
    resizedContext.drawImage(
      image, rect.x, rect.y, rect.width, rect.height,
      0, 0, geometry.resizedWidth, geometry.resizedHeight,
    );
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, size, size);
    context.imageSmoothingEnabled = false;
    if (view.flip) {
      context.translate(size, 0);
      context.scale(-1, 1);
    }
    context.drawImage(resized, geometry.cropX, geometry.cropY, size, size, 0, 0, size, size);
    context.setTransform(1, 0, 0, 1, 0, 0);
    return true;
  }

  // Scan progress for the checker's viewfinder (see detector-worker.js). The
  // worker's messages are re-validated here: a known phase, small integers,
  // and a rectangle inside the unit square. Progress is UI-only; it never
  // settles a request and never enters a result.
  const PROGRESS_PHASES = Object.freeze(["model-ready", "decoded", "picture", "region", "picture-view"]);
  function unitRect(value) {
    if (!value || typeof value !== "object") return null;
    const x = Number(value.x), y = Number(value.y);
    const width = Number(value.width), height = Number(value.height);
    if (![x, y, width, height].every(Number.isFinite)) return null;
    if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1.001 || y + height > 1.001) return null;
    return { x, y, width, height };
  }
  function sanitizeProgress(value) {
    if (!value || typeof value !== "object" || !PROGRESS_PHASES.includes(value.phase)) return null;
    const count = (n) => (Number.isSafeInteger(n) && n >= 0 && n <= 64 ? n : 0);
    return { phase: value.phase, index: count(value.index), total: count(value.total), rect: unitRect(value.rect) };
  }
  function progressReporter(onProgress) {
    if (typeof onProgress !== "function") return () => {};
    return (value) => {
      const progress = sanitizeProgress(value);
      if (!progress) return;
      try { onProgress(progress); } catch (_) {}
    };
  }
  function sourceUnitRect(x, y, width, height, sourceWidth, sourceHeight) {
    if (!(sourceWidth > 0 && sourceHeight > 0)) return null;
    return unitRect({ x: x / sourceWidth, y: y / sourceHeight, width: width / sourceWidth, height: height / sourceHeight });
  }
  function viewUnitRect(rect, view, size, sourceWidth, sourceHeight) {
    const geometry = viewGeometry(rect.width, rect.height, view.resize, size, view.fx, view.fy);
    if (!geometry) return null;
    const sx = rect.width / geometry.resizedWidth, sy = rect.height / geometry.resizedHeight;
    return sourceUnitRect(rect.x + geometry.cropX * sx, rect.y + geometry.cropY * sy,
      size * sx, size * sy, sourceWidth, sourceHeight);
  }

  // iOS 15 supports dedicated workers but not worker OffscreenCanvas. For a
  // conservative pre-validated input only, decode and resize on the UI thread,
  // then transfer a bounded eight-region RGBA batch. Pixel normalization and
  // every ONNX/WASM operation remain in detector-worker.js.
  async function preprocessSmallRgba(file, report) {
    report = typeof report === "function" ? report : () => {};
    if (!(await legacyInputAllowed(file))) {
      lastError = LEGACY_LIMIT_ERROR;
      return null;
    }
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => {
        const im = new Image();
        im.decoding = "async";
        im.onload = () => res(im);
        im.onerror = rej;
        im.src = url;
      });
      if (!legacyGeometryAllowed({
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height
      })) {
        lastError = LEGACY_LIMIT_ERROR;
        return null;
      }
      const cfg = Object.assign(
        { size: DEFAULT_SIZE },
        window.AICHECK_ONNX || {}
      );
      const s = Number.isSafeInteger(cfg.size) &&
        cfg.size >= 64 && cfg.size <= 512
        ? cfg.size
        : DEFAULT_SIZE;
      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;
      const plan = buildCompatibilityRegionPlan(width, height, cfg, s);
      if (!plan.length) return null;
      report({ phase: "decoded", index: 0, total: plan.length, rect: null });
      const progressRects = { region: [], view: [] };
      await paintYield();
      const cv = document.createElement("canvas"); cv.width = s; cv.height = s;
      const context = cv.getContext("2d", { willReadFrequently: true });
      if (!context) return null;
      const regions = [];
      for (const region of plan) {
        if (!paintCompatibilityRegion(context, img, region, s, cfg)) {
          return null;
        }
        const pixels = context.getImageData(0, 0, s, s).data;
        regions.push({
          id: region.id,
          pixels: pixels.buffer,
          width: s,
          height: s,
        });
        progressRects.region.push(sourceUnitRect(region.sourceX, region.sourceY, region.sourceWidth, region.sourceHeight, width, height));
        await paintYield();
      }
      // Composite frames (screenshots, letterboxed frames) add the located
      // picture's views to the same batch; the worker reports the higher of
      // the v5 reading and the picture reading.
      let picture = null;
      if (!(file && file.aicheckScanHint === "video-frame")) {
        try { picture = locatePicture(img, width, height); } catch (_) { picture = null; }
      }
      if (picture) {
        report({ phase: "picture", index: 0, total: PICTURE_SCAN.views.length, rect: sourceUnitRect(picture.rect.x, picture.rect.y, picture.rect.width, picture.rect.height, width, height) });
        for (const view of PICTURE_SCAN.views) {
          if (!paintCompatibilityView(context, img, picture.rect, view, s)) continue;
          regions.push({
            id: "picture:" + view.id,
            pixels: context.getImageData(0, 0, s, s).data.buffer,
            width: s,
            height: s,
          });
          progressRects.view.push(viewUnitRect(picture.rect, view, s, width, height));
          await paintYield();
        }
      }
      return {
        regions,
        sourceWidth: width,
        sourceHeight: height,
        pictureArea: picture ? picture.areaFrac : 0,
        progressRects,
      };
    } finally { URL.revokeObjectURL(url); }
  }

  function stopWorker(error) {
    workerUnavailable = true;
    if (worker) {
      try { worker.terminate(); } catch (_) {}
      worker = null;
    }
    for (const request of workerRequests.values()) {
      clearTimeout(request.timeout);
      request.resolve({ attempted: true, result: null });
    }
    workerRequests.clear();
    if (error) lastError = error;
  }

  function ensureWorker() {
    if (worker || workerUnavailable || typeof Worker !== "function") return worker;
    try {
      worker = new Worker("detector-worker.js");
      worker.addEventListener("message", (event) => {
        const response = event.data && typeof event.data === "object" ? event.data : {};
        const request = workerRequests.get(response.id);
        if (!request) return;
        if (response.progress) {
          // A progress note is not an answer: the request stays open, and its
          // timeout restarts because the worker is demonstrably still working.
          if (request.expire) {
            clearTimeout(request.timeout);
            request.timeout = setTimeout(request.expire, WORKER_TIMEOUT_MS);
          }
          if (request.progress) request.progress(response.progress);
          return;
        }
        workerRequests.delete(response.id);
        clearTimeout(request.timeout);
        if (response.ok === true && response.result) {
          request.resolve({ attempted: true, result: response.result });
          return;
        }
        if (response.code === "worker_unsupported") {
          lastError = "Worker canvas unavailable; using bounded compatibility preprocessing.";
          request.resolve({
            attempted: false,
            needsPixels: true,
            result: null
          });
          return;
        }
        const messages = {
          model_unavailable: "The bundled model could not load in the background worker.",
          invalid_request: "The background worker rejected the image request.",
          invalid_output: "The bundled model returned an unusable score.",
          inference_failed: "The background model could not finish this image."
        };
        lastError = messages[response.code] ||
          "Background inference failed.";
        request.resolve({ attempted: true, result: null });
      });
      worker.addEventListener("error", () => stopWorker("Background inference worker failed."));
    } catch (_) {
      workerUnavailable = true;
      worker = null;
    }
    return worker;
  }

  async function detectInWorker(file, report) {
    const activeWorker = ensureWorker();
    if (
      !activeWorker ||
      !file ||
      !Number.isSafeInteger(file.size) ||
      file.size < 1 ||
      file.size > MAX_INPUT_BYTES ||
      typeof file.arrayBuffer !== "function"
    ) {
      return { attempted: false, result: null };
    }
    let bytes;
    try { bytes = await file.arrayBuffer(); }
    catch (_) { return { attempted: true, result: null }; }
    const id = ++workerSequence;
    return new Promise((resolve) => {
      const expire = () => {
        workerRequests.delete(id);
        stopWorker("Background inference timed out.");
        resolve({ attempted: true, result: null });
      };
      const timeout = setTimeout(expire, WORKER_TIMEOUT_MS);
      workerRequests.set(id, { resolve, timeout, expire, progress: report });
      try {
        activeWorker.postMessage({
          id,
          kind: "detect",
          composite: !(file && file.aicheckScanHint === "video-frame"),
          bytes,
          type: String(file.type || "").slice(0, 100),
        }, [bytes]);
      } catch (_) {
        workerRequests.delete(id);
        clearTimeout(timeout);
        stopWorker("Background inference could not start.");
        resolve({ attempted: false, result: null });
      }
    });
  }

  async function detectPixelsInWorker(file, report) {
    const activeWorker = ensureWorker();
    if (!activeWorker) return null;
    report = typeof report === "function" ? report : () => {};
    let prepared;
    try { prepared = await preprocessSmallRgba(file, report); }
    catch (_) {
      lastError = "This device could not prepare a bounded image frame.";
      return null;
    }
    if (!prepared) {
      if (!lastError) {
        lastError = "This device could not prepare a bounded image frame.";
      }
      return null;
    }
    const id = ++workerSequence;
    // The worker names each region by its place in the batch; the rectangles
    // were measured here while the batch was prepared and never leave this page.
    const rects = prepared.progressRects || { region: [], view: [] };
    return new Promise((resolve) => {
      const expire = () => {
        workerRequests.delete(id);
        stopWorker("Background inference timed out.");
        resolve(null);
      };
      const timeout = setTimeout(expire, WORKER_TIMEOUT_MS);
      workerRequests.set(id, {
        timeout,
        expire,
        progress: (value) => {
          const progress = sanitizeProgress(value);
          if (!progress) return;
          const list = progress.phase === "region" ? rects.region
            : progress.phase === "picture-view" ? rects.view : null;
          if (!progress.rect && list) progress.rect = list[progress.index] || null;
          report(progress);
        },
        resolve: (outcome) => resolve(outcome && outcome.result || null)
      });
      try {
        const transferables = prepared.regions.map((region) => region.pixels);
        activeWorker.postMessage({
          id,
          kind: "detect-rgba",
          composite: !(file && file.aicheckScanHint === "video-frame"),
          regions: prepared.regions,
          sourceWidth: prepared.sourceWidth,
          sourceHeight: prepared.sourceHeight,
          pictureArea: prepared.pictureArea || 0,
        }, transferables);
      } catch (_) {
        workerRequests.delete(id);
        clearTimeout(timeout);
        lastError = "Background inference could not start.";
        resolve(null);
      }
    });
  }

  async function detect(file, options) {
    lastError = "";
    // Optional options.onProgress(progress) follows the scan for the UI. It is
    // sanitized and wrapped, so a failing callback can never fail a check.
    const report = progressReporter(options && options.onProgress);
    // Modern browsers keep decode, resize, normalization, and ONNX inference in
    // the worker. iOS 15 fails closed for larger legacy inputs before its
    // conservative compatibility decode; model loading and inference never
    // leave the worker.
    const background = await detectInWorker(file, report);
    if (background.attempted) return background.result;
    if (background.needsPixels) return detectPixelsInWorker(file, report);
    lastError = "This device cannot run the image model in a background worker.";
    return null;
  }

  window.OnnxDetector = {
    detect,
    get available() {
      return !workerUnavailable && typeof Worker === "function";
    },
    get lastError() { return lastError; },
  };
})();
