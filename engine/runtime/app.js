/* GAIC — client-side detector logic (rebuilt).
   Honest heuristics only. Every result is produced on-device first.
   Optional web-Pro cloud image analysis runs only after per-check approval and
   uses the configured API endpoint. This file remains fully useful offline.
   Video checks sample frames through the same on-device model; "Scan my
   screen" captures one display frame locally. Neither ever uploads pixels. */
(function (global) {
  const $ = (id) => document.getElementById(id);
  let mode = "text";
  let pickedFile = null;
  let pickedKind = null;
  let lastResult = null;
  let running = false;
  let autoRunAfterPick = false;

  // Every completed check ends with a lean and a confidence level (see the
  // decisive result layer below). The 99/95 bands remain the technical
  // warning bands named in the evidence read. Keep this policy synchronized
  // with test/honesty.mjs.
  const IMAGE_AI_BAND = 99;
  const IMAGE_AI_ELEVATED_BAND = 95;
  const IMAGE_REAL_BAND = null;
  const MIN_TEXT_CHARACTERS = 1000;
  // Keep these limits synchronized with the Android share-entry boundary in
  // AICheckEntryPlugin and the native bridge in native.js. The character cap
  // bounds browser/UI work; the UTF-8 cap also covers text where one character
  // occupies several bytes.
  const MAX_TEXT_CHARACTERS = 100000;
  const MAX_TEXT_BYTES = 256 * 1024;

  function analyticsTrack(eventName, dimension) {
    try {
      return !!(window.NiroAnalytics &&
        window.NiroAnalytics.track(eventName, dimension));
    } catch (_) {
      return false;
    }
  }

  function imageSignalVerdict(rawPercent) {
    if (!Number.isFinite(rawPercent)) return null;
    if (rawPercent >= IMAGE_AI_BAND) return "High AI-model signal — verify";
    if (rawPercent >= IMAGE_AI_ELEVATED_BAND) {
      return "Elevated AI-model signal — verify";
    }
    return "Model signal below warning bands";
  }

  // ---------- decisive result layer ----------
  // Every completed check ends with a lean and a confidence level: text leans
  // AI-written or human-written; photos, screenshots, video, and screens lean
  // AI-generated or real. Leans come from calibrated evidence, and each
  // confidence level's share of correct leans was measured on data the models
  // never trained on (models/GAIC-TEXT-MODEL.md, models/AICHECK-IMAGE-MODEL.md).
  // Genuine failures (unreadable file, too little text, quota) stay
  // kind:"error" and are never given a lean.
  const LEAN_WORDS = Object.freeze({
    ai: Object.freeze({ text: "AI-written", media: "AI-generated" }),
    human: Object.freeze({ text: "human-written", media: "real" }),
    real: Object.freeze({ text: "human-written", media: "real" }),
  });
  const CONFIDENCE_LEVELS = Object.freeze(["high", "medium", "low"]);

  function leanHeadline(kind, lean, confidence) {
    const words = LEAN_WORDS[lean];
    if (!words || !CONFIDENCE_LEVELS.includes(confidence)) return null;
    return (confidence === "low" ? "Leans " : "Likely ") +
      (kind === "text" ? words.text : words.media) + " — " + confidence + " confidence";
  }

  function applyDecision(out, decision) {
    if (!out || !decision) return out;
    const headline = leanHeadline(out.kind, decision.lean, decision.confidence);
    const percent = Number(decision.aiLikelihood);
    if (!headline || !Number.isFinite(percent)) return out;
    out.technicalVerdict = out.verdict || "";
    out.verdict = headline;
    out.lean = decision.lean;
    out.confidence = decision.confidence;
    out.score = Math.max(1, Math.min(99, Math.round(percent)));
    out.metricLabel = "AI likelihood";
    return out;
  }

  function leanSentence(out) {
    if (!out || !out.lean) return "";
    const subject = out.kind === "text" ? "this text is" : out.kind === "video" ? "this footage is" : "this image is";
    const words = LEAN_WORDS[out.lean] || {};
    const noun = out.kind === "text" ? words.text : words.media;
    return "GAIC's read: " + subject + " " + (out.confidence === "low" ? "leaning " : "likely ") + noun +
      " (" + out.confidence + " confidence), with an estimated " + out.score + "% AI likelihood.";
  }

  // Fallback lean when the evidence module is unavailable: pixel only, always
  // low confidence, and the displayed value stays on the lean's side of 50%.
  function fallbackLean(probability) {
    const p = Math.max(0.01, Math.min(0.99, probability));
    const lean = p >= 0.5 ? "ai" : "real";
    const shown = Math.round(p * 100) / 100;
    return { lean, confidence: "low", probabilityAi: lean === "ai" ? Math.max(0.5, shown) : Math.min(0.49, shown) };
  }

  // The warning bands of the evidence read (95 elevated, 99 high) follow the
  // decision head's measured confidence levels, so the technical line and the
  // headline never disagree: AI high reads as the high band, any other AI
  // lean as the elevated band, and a real lean stays below both.
  function headBandScore(probability, cuts) {
    const c = cuts || {};
    const aiHigh = Number.isFinite(c.aiHigh) ? c.aiHigh : 0.9;
    const aiMedium = Number.isFinite(c.aiMedium) ? Math.max(0.5, c.aiMedium) : 0.75;
    const pct = probability * 100;
    if (probability >= aiHigh) return Math.max(IMAGE_AI_BAND, pct);
    if (probability >= 0.5 && probability >= aiMedium) return Math.min(IMAGE_AI_BAND - 0.01, Math.max(IMAGE_AI_ELEVATED_BAND, pct));
    return Math.min(IMAGE_AI_ELEVATED_BAND - 0.01, pct);
  }

  function clampedLogOdds(probability) {
    const q = Math.min(0.995, Math.max(0.005, probability));
    return Math.log(q / (1 - q));
  }

  function medianOf(values) {
    const sorted = values.slice().sort((left, right) => left - right);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // Video and screen frames: the typical (median) frame decides, in log-odds,
  // using each frame's calibrated decision-head probability; frames without one
  // fall back to the engine v2 raw scores. A validated credential still decides
  // outright through decideImageLean.
  function frameDecision(frames, provenance) {
    const usable = frames.filter((frame) => frame && Number.isFinite(frame.pct));
    if (!usable.length) return null;
    const calibrated = usable.every((frame) => Number.isFinite(frame.probability));
    const probability = calibrated
      ? 1 / (1 + Math.exp(-medianOf(usable.map((frame) => clampedLogOdds(frame.probability)))))
      : null;
    const cuts = calibrated ? usable[0].cuts || null : null;
    const rawScore = calibrated ? headBandScore(probability, cuts) : medianOf(usable.map((frame) => frame.pct));
    const pixel = { available: true, rawScore, probability, scan: "direct-v5", cuts,
      elevatedBand: IMAGE_AI_ELEVATED_BAND, warningBand: IMAGE_AI_BAND };
    const verdictModule = window.ProvenanceVerdict;
    let lean = null;
    if (verdictModule && typeof verdictModule.decideImageLean === "function") {
      lean = verdictModule.decideImageLean({ provenance: provenance || {}, pixel });
    }
    if (!lean) lean = fallbackLean(calibrated ? probability : rawScore / 100);
    return { lean: lean.lean, confidence: lean.confidence, aiLikelihood: lean.probabilityAi * 100,
      calibrated, frames: usable.length };
  }

  function setCheckButtonLabel() {
    const button = $("check-btn");
    if (!button || running) return;
    button.textContent = mode === "text" ? "Check text for AI" : "Check selected file for AI";
  }

  function switchTab(which, recordChoice) {
    mode = which;
    const tabText = $("tab-text"), tabImage = $("tab-image");
    const paneText = $("pane-text"), paneImage = $("pane-image"), result = $("result");
    // Roving tabindex + aria-selected so the switcher works as a real tablist.
    [[tabText, "text"], [tabImage, "image"]].forEach(([tab, name]) => {
      if (!tab) return;
      const active = which === name;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
      tab.setAttribute("tabindex", active ? "0" : "-1");
    });
    if (paneText) paneText.classList.toggle("hidden", which !== "text");
    if (paneImage) paneImage.classList.toggle("hidden", which !== "image");
    if (which !== "image") clearCloudConsent();
    if (result) result.classList.remove("show");
    setCheckButtonLabel();
    if (recordChoice === true) {
      analyticsTrack("checker_mode_selected", which);
    }
  }

  // ---------- client-side image validation ----------
  // Keep this aligned with the optional cloud endpoint. The local checks also
  // benefit from a sane cap: a giant image can otherwise exhaust mobile canvas
  // memory before the user ever opts into a cloud upload.
  // Modern phone cameras (48-200 MP) routinely write 10-40 MB photos. The
  // on-device check accepts up to 50 MB; above the scan's 24 MP working limit
  // the detector decodes a downscaled copy (onnx-detector.js), so large photos
  // never need a full-resolution canvas.
  const MAX_IMAGE_BYTES = 50 * 1024 * 1024; // 50 MB
  // Vercel Functions accept at most a 4.5 MB request body. A raw 3 MiB image
  // expands to about 4 MiB as canonical base64, leaving safe JSON overhead.
  // This cloud-only cap must match the exact health contract and backend. The
  // bundled on-device model continues to accept images up to MAX_IMAGE_BYTES.
  const CLOUD_MAX_IMAGE_BYTES = 3 * 1024 * 1024;
  const MAX_IMAGE_DIMENSION = 16384;
  const MAX_IMAGE_PIXELS = 120_000_000;
  const CLOUD_ANALYSIS_TIMEOUT_MS = 18_000;

  function cloudIdempotencyKey() {
    try {
      if (typeof crypto !== "undefined" && crypto.randomUUID) {
        return "aicheck-" + crypto.randomUUID();
      }
      if (typeof crypto !== "undefined" && crypto.getRandomValues) {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        return "aicheck-" + Array.from(
          bytes,
          (value) => value.toString(16).padStart(2, "0")
        ).join("");
      }
    } catch (_) {}
    // This value is an idempotency hint, never an authentication credential.
    return "aicheck-" + Date.now().toString(36) + "-" +
      Math.random().toString(36).slice(2).padEnd(16, "0").slice(0, 16);
  }

  function cloudPollDelay(milliseconds, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("aborted"));
        return;
      }
      const abort = () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, milliseconds);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  async function cloudFetchJson(url, options) {
    const response = await fetch(url, options);
    let body = {};
    try { body = await response.json(); } catch (_) {}
    return { response, body };
  }

  async function cloudAnalysisRequest(url, options, hooks) {
    const controller = new AbortController();
    const outerSignal = options && options.signal;
    const abortFromOuter = () => controller.abort();
    let timer = 0;
    try {
      if (outerSignal) {
        if (outerSignal.aborted) controller.abort();
        else outerSignal.addEventListener("abort", abortFromOuter, {
          once: true
        });
      }
      timer = setTimeout(
        () => controller.abort(),
        CLOUD_ANALYSIS_TIMEOUT_MS
      );
      const idempotencyKey = cloudIdempotencyKey();
      const submitOptions = {
        ...options,
        headers: {
          ...(options && options.headers || {}),
          "Idempotency-Key": idempotencyKey
        },
        signal: controller.signal
      };
      let submission = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          submission = await cloudFetchJson(url, submitOptions);
          if (submission.response.status < 500 || attempt === 1) break;
        } catch (error) {
          if (attempt === 1) throw error;
        }
        await cloudPollDelay(250, controller.signal);
      }
      if (!submission) throw new Error("cloud queue unavailable");
      const submitted = submission.body;
      if (
        !submission.response.ok ||
        !submitted ||
        typeof submitted.jobId !== "string" ||
        !/^aj_[a-z0-9_-]{32}$/i.test(submitted.jobId)
      ) return submission;
      if (submitted.status === "complete" && submitted.result) {
        return { response: submission.response, body: submitted.result };
      }
      if (submitted.status === "failed") return submission;
      if (hooks && typeof hooks.onQueued === "function") {
        try { hooks.onQueued(submitted); } catch (_) {}
      }

      const pollHeaders = {};
      for (const [name, value] of Object.entries(
        options && options.headers || {}
      )) {
        if (/^(authorization|x-payment-token)$/i.test(name)) {
          pollHeaders[name] = value;
        }
      }
      let pollAfter = Number(submitted.pollAfterMs);
      pollAfter = Number.isFinite(pollAfter)
        ? Math.max(500, Math.min(2000, Math.round(pollAfter)))
        : 750;
      // QStash owns execution and retries. The UI performs only small,
      // owner-authenticated status reads; it never re-uploads the image.
      for (let attempt = 0; attempt < 32; attempt += 1) {
        await cloudPollDelay(pollAfter, controller.signal);
        const polled = await cloudFetchJson(
          url + "?jobId=" + encodeURIComponent(submitted.jobId),
          {
            method: "GET",
            headers: pollHeaders,
            cache: "no-store",
            credentials: "omit",
            signal: controller.signal
          }
        );
        const job = polled.body || {};
        if (job.status === "complete" && job.result) {
          return { response: polled.response, body: job.result };
        }
        if (
          job.status === "failed" ||
          polled.response.status === 404 ||
          (!polled.response.ok && polled.response.status !== 202)
        ) return polled;
        const suggested = Number(job.pollAfterMs);
        if (Number.isFinite(suggested)) {
          pollAfter = Math.max(
            500,
            Math.min(2000, Math.round(suggested))
          );
        }
      }
      return {
        response: submission.response,
        body: {
          error: "Cloud analysis is still running. The on-device result is unchanged."
        }
      };
    } finally {
      if (timer) clearTimeout(timer);
      if (outerSignal) {
        outerSignal.removeEventListener("abort", abortFromOuter);
      }
    }
  }

  // Video checks decode only the sampled frames (never the whole file into
  // memory), so the byte cap can be far above the image cap.
  const MAX_VIDEO_BYTES = 200 * 1024 * 1024; // 200 MB
  const VIDEO_FRAME_SAMPLES = 8;             // frames sampled per video check
  const VIDEO_SCAN_WINDOW_SECONDS = 10 * 60; // long videos: sample the first 10 minutes only
  const SCREEN_CAPTURE_SECONDS = 4;          // screen check: length of the capture window
  const SCREEN_FRAME_SAMPLES = 8;            // frames sampled across that window (~every 0.5s)

  // Videos are detected by MIME type first, filename as a fallback (some
  // pickers and share sheets hand over files with an empty type).
  function isVideoFile(file) {
    if (!file) return false;
    if (String(file.type || "").indexOf("video/") === 0) return true;
    return /\.(mp4|m4v|webm|mov|ogv|mkv)$/i.test(file.name || "");
  }

  function readU16LE(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8);
  }
  function readU16BE(bytes, offset) {
    return (bytes[offset] << 8) | bytes[offset + 1];
  }
  function readU32LE(bytes, offset) {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
  }
  function readI32LE(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24);
  }
  function readU32BE(bytes, offset) {
    return (((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0;
  }

  // Read dimensions directly from supported raster headers before creating an
  // Image or canvas. A small compressed file can otherwise expand into a giant
  // bitmap and exhaust a phone before local analysis gets a chance to resize it.
  function imageDimensions(bytes) {
    if (!bytes || bytes.length < 10) return null;
    // PNG
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
        bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a && bytes.length >= 24) {
      return { width: readU32BE(bytes, 16), height: readU32BE(bytes, 20), format: "PNG" };
    }
    // GIF
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes.length >= 10) {
      return { width: readU16LE(bytes, 6), height: readU16LE(bytes, 8), format: "GIF" };
    }
    // BMP
    if (bytes[0] === 0x42 && bytes[1] === 0x4d && bytes.length >= 26) {
      return { width: Math.abs(readI32LE(bytes, 18)), height: Math.abs(readI32LE(bytes, 22)), format: "BMP" };
    }
    // JPEG (find a Start Of Frame marker).
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) { offset += 1; continue; }
        while (bytes[offset] === 0xff) offset += 1;
        const marker = bytes[offset++];
        if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        if (offset + 1 >= bytes.length) break;
        const length = readU16BE(bytes, offset);
        if (length < 2 || offset + length > bytes.length) break;
        const isSOF = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
        if (isSOF && length >= 7) {
          return { width: readU16BE(bytes, offset + 5), height: readU16BE(bytes, offset + 3), format: "JPEG" };
        }
        offset += length;
      }
      return null;
    }
    // WebP: VP8X (extended), VP8L (lossless), and VP8 (lossy).
    if (bytes.length >= 30 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
      const kind = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
      if (kind === "VP8X") {
        return { width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16), height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16), format: "WebP" };
      }
      if (kind === "VP8L" && bytes[20] === 0x2f) {
        const width = 1 + bytes[21] + ((bytes[22] & 0x3f) << 8);
        const height = 1 + ((bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10));
        return { width, height, format: "WebP" };
      }
      // The fourcc for simple lossy WebP is "VP8 " — four characters, the last a
      // space. `kind` is always 4 chars, so comparing against a 3-char "VP8"
      // never matched, and every simple-lossy WebP (what most encoders emit by
      // default) was rejected as "Image is too large or unsupported".
      if (kind === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
        return { width: readU16LE(bytes, 26) & 0x3fff, height: readU16LE(bytes, 28) & 0x3fff, format: "WebP" };
      }
    }
    return null;
  }

  function imageGeometryError(dimensions) {
    if (!dimensions || !dimensions.width || !dimensions.height) return "A readable JPEG, PNG, GIF, WebP, or BMP image is required.";
    const pixels = dimensions.width * dimensions.height;
    if (dimensions.width > MAX_IMAGE_DIMENSION || dimensions.height > MAX_IMAGE_DIMENSION || pixels > MAX_IMAGE_PIXELS) {
      return "Image dimensions must be no larger than " + MAX_IMAGE_DIMENSION + "px on either side and " + (MAX_IMAGE_PIXELS / 1000000) + " megapixels.";
    }
    return "";
  }
  // Accepts a candidate file from any path (picker, drop, paste, share, camera).
  // Returns true and stores it if valid; otherwise shows an inline message
  // (never a blocking alert) and returns false.
  // Start loading the image model while a file is being chosen or reviewed,
  // so pressing Check does not wait for it. Nothing is read or scored here.
  function warmImageModel() {
    try {
      if (window.OnnxDetector && typeof window.OnnxDetector.warm === "function") window.OnnxDetector.warm();
    } catch (_) {}
  }

  function acceptImage(file, label, sourceKind) {
    if (!file) return false;
    const video = isVideoFile(file);
    const type = String(file.type || "").toLowerCase();
    const imageByName = /\.(jpe?g|png|gif|webp|bmp)$/i.test(file.name || "");
    if (!video && !type.startsWith("image/") && !imageByName) {
      switchTab("image");
      showResult({ kind: "error", score: null, verdict: "Unsupported file",
        explain: "Choose a JPEG, PNG, GIF, WebP, BMP, MP4, WebM, or MOV file.",
        guidance: "The file was not analyzed and did not use a free check.", countsTowardLimit: false });
      return false;
    }
    const byteCap = video ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
    if (typeof file.size === "number" && file.size > byteCap) {
      switchTab("image");
      showResult({ kind: "error", score: null, verdict: video ? "Video too large" : "Image too large",
        explain: video ? "Video must be 200MB or smaller." : "Image must be 50MB or smaller.",
        guidance: "The file was not analyzed and did not use a free check.", countsTowardLimit: false });
      return false;
    }
    scanReleasePreviews();
    pickedFile = file;
    pickedKind = sourceKind === "screen"
      ? "screen"
      : video ? "video" : "image";
    // Upload permission is deliberately per file and per check. Choosing a new
    // file must never inherit an earlier cloud opt-in or leave the prior
    // result's background poll alive.
    cancelActiveCloudAnalysis();
    clearCloudConsent();
    const name = $("file-name");
    if (name && label) name.textContent = label;
    const drop = $("drop");
    if (drop) drop.classList.add("has-file");
    announce((video ? "Video" : "Photo") + " selected. Choose Check selected file when you're ready.", false);
    setCheckButtonLabel();
    warmImageModel();
    return true;
  }

  // ---------- TEXT: descriptive, unvalidated pattern heuristic ----------
  // This is not a trained detector and has no measured accuracy. It reports a
  // bounded pattern signal only after a substantial English sample, never a
  // probability or authorship verdict.
  const FORMULAIC_PHRASES = ["moreover","furthermore","in conclusion","it is important to note",
    "it's important to note","delve","tapestry","underscore","navigating the","a testament to",
    "in today's fast-paced","landscape of","when it comes to","the world of","ever-evolving",
    "plays a crucial role","it is worth noting","in summary","overall,"];

  function utf8ByteLength(value) {
    return new TextEncoder().encode(String(value || "")).byteLength;
  }

  function normalizeTextForAnalysis(value) {
    const input = String(value || "");
    // NFKC makes compatibility forms comparable. Smart/modifier apostrophes
    // are then folded to the ASCII apostrophe so typography alone cannot
    // change phrase or contraction counts.
    return input.normalize("NFKC").replace(/[\u2018\u2019\u02bc]/g, "'");
  }

  function textLimitError(value) {
    const input = String(value || "");
    const characters = input.length;
    const bytes = utf8ByteLength(input);
    if (characters <= MAX_TEXT_CHARACTERS && bytes <= MAX_TEXT_BYTES) return null;
    return { kind: "error", score: null, verdict: "Text is too large",
      explain: "Text must be no larger than " + MAX_TEXT_CHARACTERS.toLocaleString() +
        " characters or 256 KB. This sample is " + characters.toLocaleString() +
        " characters and " + Math.ceil(bytes / 1024).toLocaleString() + " KB.",
      guidance: "Check a shorter excerpt. Nothing was scored, and your text stayed on this device.",
      countsTowardLimit: false };
  }

  // GAIC Text Model v2 (text-detector.js): a trained on-device classifier over
  // stylometric measurements and a general-vocabulary lexicon, scored per
  // passage. Its bands were set on corpora each fold never saw; see
  // models/GAIC-TEXT-MODEL.md. It still reports a pattern signal, not a
  // probability or an authorship finding. Returns null when unavailable so
  // the legacy heuristic below remains the fallback.
  const TEXT_BAND_VERDICTS = Object.freeze({
    few: "Few formulaic patterns matched",
    mixed: "Mixed writing patterns",
    several: "Several formulaic patterns matched",
  });
  function joinSignals(list) {
    if (!list.length) return "";
    if (list.length === 1) return list[0];
    return list.slice(0, -1).join(", ") + " and " + list[list.length - 1];
  }
  function disguiseSummary(disguise) {
    const bits = [];
    if (disguise.hiddenCharacters) bits.push(disguise.hiddenCharacters.toLocaleString() + " invisible character" + (disguise.hiddenCharacters === 1 ? "" : "s") + " inside words");
    if (disguise.lookalikeLetters) bits.push(disguise.lookalikeLetters.toLocaleString() + " look-alike letter" + (disguise.lookalikeLetters === 1 ? "" : "s") + " from other alphabets");
    return "this text contains " + bits.join(" and ");
  }

  function analyzeTextWithEngine(t) {
    const engine = global.AICheckTextEngine;
    if (!engine || !engine.model || typeof engine.analyze !== "function") return null;
    let result = null;
    try { result = engine.analyze(t); } catch (_) { result = null; }
    if (!result || !Number.isFinite(result.logit) || !TEXT_BAND_VERDICTS[result.band] ||
        !result.decision) return null;
    const parts = [];
    parts.push("GAIC Text Model v2 measured " + result.passages + " passage" + (result.passages === 1 ? "" : "s") +
      " on this device" + (result.passages > 1
        ? " (" + result.flaggedPassages + " in the high band)."
        : "."));
    if (result.aiSignals.length) parts.push("Leaning machine-like: " + joinSignals(result.aiSignals) + ".");
    if (result.humanSignals.length) parts.push("Leaning human-like: " + joinSignals(result.humanSignals) + ".");
    if (result.wordChoice !== "neutral") {
      parts.push("Overall word choice leaned " + (result.wordChoice === "ai" ? "machine-like" : "human-like") + ".");
    }
    parts.push("How sure: on public research collections it never trained on, about 3–5% of human-written documents leaned AI, and it caught about 64–79% of AI-written documents. High-confidence AI leans were right about 98% of the time. It is English-focused and can be unfair to non-native, translated, academic, formulaic, or heavily edited writing.");
    const section = result.machineLikeSection || null;
    const disguise = result.disguise || null;
    if (section) {
      parts.push("Mixed writing: words " + section.firstWord.toLocaleString() + "–" + section.lastWord.toLocaleString() +
        " of " + section.totalWords.toLocaleString() + " (starting \u201c" + section.opening + "\u2026\u201d) read strongly machine-like," +
        " although the text as a whole leans human-written. A section pasted from an AI tool reads this way" +
        (section.sections > 1 ? "; " + (section.sections - 1) + " other section" + (section.sections === 2 ? "" : "s") + " read the same way." : "."));
    }
    if (disguise) {
      parts.push("Hidden characters: " + disguiseSummary(disguise) + ". These are sometimes added to slip text past AI detectors;" +
        " GAIC read the text without them, so they did not change this result.");
    }
    const out = { kind: "text", score: result.score, metricLabel: "Text-pattern signal",
      verdict: TEXT_BAND_VERDICTS[result.band], explain: parts.join(" "),
      ...(section ? { textSection: section } : {}), ...(disguise ? { textDisguise: disguise } : {}),
      textModel: String(result.version || "").slice(0, 80),
      guidance: "Use this as a strong clue, not proof. If it matters, check drafts, citations, document history, and the author's explanation." };
    applyDecision(out, result.decision);
    out.explain = leanSentence(out) + " " + out.explain;
    return out;
  }

  function analyzeText(t) {
    const limitError = textLimitError(t);
    if (limitError) return limitError;
    const text = normalizeTextForAnalysis(t).trim();
    const words = text.split(/\s+/).filter(Boolean);
    if (text.length < MIN_TEXT_CHARACTERS) {
      return { kind: "error", score: null, verdict: "Sample too short for a score",
        explain: "GAIC does not score text below " + MIN_TEXT_CHARACTERS.toLocaleString() +
          " characters because short-text detection is especially unreliable. Current sample: " +
          text.length.toLocaleString() + " characters.",
        guidance: "Add a longer English sample, or review drafts and source history instead. No detector result should be used as proof of authorship.",
        countsTowardLimit: false };
    }
    const sentences = text.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 0);
    if (sentences.length < 3) {
      return { kind: "error", score: null, verdict: "Need several complete sentences",
        explain: "This sample is long enough, but it has fewer than three sentence boundaries. Lists, code, and repeated fragments cannot be reviewed meaningfully by this heuristic.",
        guidance: "Use continuous English prose, then corroborate any result with drafts, citations, and source history.",
        countsTowardLimit: false };
    }
    const lower = words.map(w => w.toLowerCase().replace(/[^a-z']/g, "")).filter(Boolean);
    if (!lower.length || lower.length / words.length < 0.7) {
      return { kind: "error", score: null, verdict: "English prose required",
        explain: "The text model only supports English prose, so this sample was not scored.",
        guidance: "Review the original source, drafts, citations, and document history instead.",
        countsTowardLimit: false };
    }
    const engineResult = analyzeTextWithEngine(t);
    if (engineResult) {
      return Object.assign(engineResult, {
        mediaSummary: "What I'm looking at: " + text.length.toLocaleString() + " characters of continuous English prose — about " +
          words.length.toLocaleString() + " words across " + sentences.length.toLocaleString() + " sentences.",
      });
    }
    const lens = sentences.map(s => s.split(/\s+/).length);
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    const variance = lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length;
    const std = Math.sqrt(variance);
    // Sentence-length uniformity is descriptive only; many human and machine
    // samples share it.
    const burstiness = Math.max(0, Math.min(1, 1 - std / 9)); // 0..1, higher = more uniform
    // Type-token ratio, likewise descriptive and strongly affected by genre.
    const uniq = new Set(lower).size;
    const ttr = lower.length ? uniq / lower.length : 0; // 0..1
    const diversitySignal = Math.max(0, Math.min(1, (0.55 - ttr) / 0.35)); // low diversity -> AI-ish
    // phrase hits
    const lc = text.toLowerCase();
    let hits = 0;
    FORMULAIC_PHRASES.forEach(p => { if (lc.includes(p)) hits++; });
    const phraseSignal = Math.min(1, hits / 4);
    // Contraction frequency receives light weight and is not treated as proof.
    const contractions = (lc.match(/\b\w+'\w+\b/g) || []).length / words.length;
    const contractionSignal = Math.max(0, Math.min(1, (0.03 - contractions) / 0.03)); // few contractions -> AI-ish

    const raw = 100 * (0.40 * burstiness + 0.28 * diversitySignal + 0.22 * phraseSignal + 0.10 * contractionSignal);
    // Avoid visually extreme values from an uncalibrated hand-built heuristic.
    const score = Math.round(Math.max(15, Math.min(85, raw)));

    let verdict, note;
    if (score < 34) verdict = "Few formulaic patterns matched";
    else if (score < 66) verdict = "Mixed writing patterns";
    else verdict = "Several formulaic patterns matched";
    note = `Descriptive components — sentence-length similarity ${(burstiness*100|0)}/100, vocabulary-repetition cue ${(diversitySignal*100|0)}/100, contraction-use cue ${(contractionSignal*100|0)}/100, and ${hits} formulaic phrase match${hits===1?"":"es"}. ` +
      `The trained text model was unavailable on this device, so this read comes from the older built-in heuristic and is always low confidence. It is English-focused and can be unfair to non-native, translated, academic, formulaic, or heavily edited writing.`;
    const fallback = { kind: "text", score, metricLabel: "Text-pattern signal", verdict, explain: note,
      mediaSummary: "What I'm looking at: " + text.length.toLocaleString() + " characters of continuous English prose — about " +
        words.length.toLocaleString() + " words across " + sentences.length.toLocaleString() + " sentences.",
      guidance: "Use this as a weak clue, not proof. Check drafts, citations, document history, and the author's explanation." };
    applyDecision(fallback, { lean: score >= 50 ? "ai" : "human", confidence: "low", aiLikelihood: score });
    fallback.explain = leanSentence(fallback) + " " + fallback.explain;
    return fallback;
  }

  // ---------- friendly one-liner about the checked media ----------
  // Describes verifiable file facts only (format, size, dimensions, camera
  // fields). GAIC has no on-device captioning model, so it never guesses at
  // scene content — that would be an unverifiable claim about the media.
  function describeMedia(file, dimensions, exif, extra) {
    try {
      const bits = [];
      let lead = "a file";
      const noun = dimensions && dimensions.format === "video"
        ? "video"
        : ((dimensions && dimensions.format ? dimensions.format + " " : "") + "image");
      if (dimensions && dimensions.width && dimensions.height) {
        lead = "a " + dimensions.width + "×" + dimensions.height + " " + noun;
      } else if (dimensions && dimensions.format) {
        lead = "a " + noun;
      } else if (file && /^video\//i.test(file.type || "")) {
        lead = "a video";
      }
      if (file && Number.isFinite(file.size) && file.size > 0) {
        const mb = file.size / (1024 * 1024);
        bits.push(mb >= 1 ? mb.toFixed(1) + " MB" : Math.max(1, Math.round(file.size / 1024)) + " KB");
      }
      if (extra) bits.push(extra);
      const e = exif || {};
      const camera = ((e.make ? e.make + " " : "") + (e.model || "")).trim();
      if (camera) bits.push("camera says " + camera);
      if (e.dateTime) bits.push("dated " + e.dateTime);
      return "What I'm looking at: " + lead + (bits.length ? " (" + bits.join(" · ") + ")" : "") + ".";
    } catch (_) { return ""; }
  }

  const IMAGE_REGION_LABELS = Object.freeze({
    whole: "whole frame",
    center: "center",
    "top-left": "top left",
    "top-right": "top right",
    "bottom-left": "bottom left",
    "bottom-right": "bottom right",
    "lower-center": "lower center",
    "middle-center": "middle center",
    "compatibility-frame": "compatibility frame",
    picture: "detected picture",
  });

  // The worker is same-origin, but treat its diagnostics as untrusted structured
  // input anyway: accept only known region ids, finite scores, and a small
  // bounded list. No pixels, crop coordinates, filenames, or page data enter
  // the result object.
  function normalizeImageRegionScores(modelResult) {
    if (!modelResult || !Array.isArray(modelResult.regionScores)) return [];
    const seen = new Set();
    const rows = [];
    for (const candidate of modelResult.regionScores.slice(0, 8)) {
      const id = String(candidate && candidate.id || "");
      const likelihood = Number(candidate && candidate.aiLikelihood);
      if (
        !IMAGE_REGION_LABELS[id] ||
        seen.has(id) ||
        !Number.isFinite(likelihood)
      ) continue;
      seen.add(id);
      rows.push({
        id,
        label: IMAGE_REGION_LABELS[id],
        aiLikelihood: Math.max(0, Math.min(1, likelihood)),
      });
    }
    return rows;
  }

  function isScreenCaptureLikeFrame(file, dimensions) {
    if (!dimensions || !dimensions.width || !dimensions.height) return false;
    const type = String(file && file.type || "").toLowerCase();
    const name = String(file && file.name || "").toLowerCase();
    return (
      /(?:^|[\s_-])screen(?:shot|[\s_-]?capture)(?:[\s_.-]|$)/.test(name) ||
      (
        type === "image/png" &&
        Math.max(dimensions.width, dimensions.height) >= 1000
      )
    );
  }

  function frameLayoutContext(file, dimensions, regionCount) {
    if (!dimensions || !dimensions.width || !dimensions.height || regionCount < 2) return "";
    const ratio = dimensions.width / dimensions.height;
    const screenLikeContainer = isScreenCaptureLikeFrame(file, dimensions);
    const layout = ratio >= 1.35 ? "wide" : ratio <= 0.74 ? "tall" : "full-frame";
    return "Layout context: this " + layout + " frame was checked as a whole and in overlapping center, corner, middle-center, and lower-center regions. " +
      (screenLikeContainer
        ? "Its PNG container and dimensions are consistent with a screenshot or exported graphic, but that is not proof of how it was made. "
        : "") +
      "This helps when a picture occupies only part of a generator portal screenshot. GAIC did not read a page URL, browser history, DOM, nearby text, or another app.";
  }

  const GENERATOR_SOURCE_HOSTS = Object.freeze([
    ["chatgpt.com", "ChatGPT"],
    ["openai.com", "OpenAI"],
    ["sora.com", "Sora"],
    ["midjourney.com", "Midjourney"],
    ["firefly.adobe.com", "Adobe Firefly"],
    ["gemini.google.com", "Google Gemini"],
    ["labs.google", "Google Labs"],
    ["bing.com", "Microsoft Image Creator"],
    ["designer.microsoft.com", "Microsoft Designer"],
    ["ideogram.ai", "Ideogram"],
    ["leonardo.ai", "Leonardo AI"],
    ["runwayml.com", "Runway"],
    ["dreamstudio.ai", "DreamStudio"],
    ["stability.ai", "Stability AI"],
    ["copilot.microsoft.com", "Microsoft Copilot"],
    ["meta.ai", "Meta AI"],
    ["krea.ai", "Krea"],
    ["recraft.ai", "Recraft"],
    ["getimg.ai", "getimg.ai"],
    ["clipdrop.co", "Clipdrop"],
    ["craiyon.com", "Craiyon"],
    ["artbreeder.com", "Artbreeder"],
    ["pika.art", "Pika"],
    ["lumalabs.ai", "Luma AI"],
    ["grok.com", "Grok"],
    ["x.ai", "xAI"],
    ["canva.com", "Canva"],
  ]);

  // Optional source context is deliberately tiny and local. Parse only the
  // hostname, never fetch the URL, retain the path, or place it in analytics.
  function normalizeSourceContext(value) {
    const raw = String(value || "").trim().slice(0, 2048);
    if (!raw) return null;
    try {
      const parsed = new URL(
        /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : "https://" + raw
      );
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
      const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
      if (!hostname || hostname.length > 253) return null;
      const match = GENERATOR_SOURCE_HOSTS.find(([host]) =>
        hostname === host || hostname.endsWith("." + host)
      );
      return Object.freeze({
        hostname,
        generatorName: match ? match[1] : "",
        knownGenerator: !!match,
      });
    } catch (_) {
      return null;
    }
  }

  function selectedSourceContext() {
    const input = $("source-url");
    // Keep the boundary single: analyzeImage normalizes the raw field once.
    // Passing an already-normalized object here would stringify it as
    // "[object Object]" and silently discard the user's hostname.
    return input ? input.value : "";
  }

  // ---------- IMAGE: Content Credentials (C2PA) + metadata read ----------
  // Generator clues in the file's own decoded metadata text (EXIF, XMP, and
  // PNG text fields; never the raw pixel bytes). Every one is unsigned and
  // editable, so each is a clue for the lean, not proof.
  //
  // Tool names. rangeToAscii turns each non-ASCII byte into a space, so
  // "DALL·E" arrives as "DALL  E"; a separator is required so that the
  // Italian word "dalle" does not count. The ambiguous names are also ordinary
  // words or names, so a match on them alone counts for less in the lean.
  const GENERATOR_NAMES = /\b(midjourney|stable[ -]?diffusion|sdxl|dall(?:-| {1,2})e|adobe firefly|generative[ -]?fill|openai|novelai|comfyui|automatic1111|invokeai|fooocus|diffusionbee|dreamstudio|nightcafe|craiyon|leonardo[. ]ai|stability[. ]ai|bing image creator|seedream)\b/i;
  const AMBIGUOUS_GENERATOR_NAMES = /\b(gemini|imagen|ideogram)\b/i;
  const METADATA_TEXT_LIMIT = 262144;

  function unescapeQuotes(text) {
    return text.replace(/&quot;|&#34;|&#x22;/gi, '"');
  }

  // Generation settings: the "Steps: 30, Sampler: Euler a, CFG scale: 7,
  // Seed: 1234" line that Stable Diffusion web UI and its forks write, or a
  // ComfyUI node graph. container-provenance.mjs finds them as PNG text-chunk
  // keys; JPEG and WebP files carry them in the EXIF user comment or XMP,
  // which only this check reads.
  function hasGenerationSettings(text) {
    const source = unescapeQuotes(String(text || "").slice(0, METADATA_TEXT_LIMIT));
    if (/\bSteps: \d{1,4}, Sampler: [^,\n]{1,48},/.test(source) && /\b(?:CFG scale|Seed): \d/.test(source)) return true;
    return /"class_type"\s*:\s*"[^"\n]{1,80}"/.test(source) && /"inputs"\s*:\s*\{/.test(source);
  }

  // China's mandatory labeling standard for AI-generated content
  // (GB 45438-2025) has generation services and sharing platforms write an
  // "AIGC" metadata field (in XMP, a PNG text chunk, or the EXIF user comment):
  // a small JSON object whose "Label" is 1 (AI-generated), 2 (possibly
  // AI-generated), or 3 (suspected AI-generated), beside the provider's code in
  // "ContentProducer". Returns "1", "2", "3", or "" when there is no label.
  function readAiContentLabel(text) {
    const source = String(text || "").slice(0, METADATA_TEXT_LIMIT);
    const lower = source.toLowerCase();
    let at = lower.indexOf("aigc");
    for (let seen = 0; at !== -1 && seen < 32; seen += 1) {
      const field = /^aigc[^{}<]{0,40}\{([^{}]{0,1500})\}/i.exec(unescapeQuotes(source.slice(at, at + 2400)));
      if (field) {
        const label = /"Label"\s*:\s*"?([123])\b/i.exec(field[1]);
        if (label && /"ContentProducer"\s*:/i.test(field[1])) return label[1];
      }
      at = lower.indexOf("aigc", at + 4);
    }
    return "";
  }

  // Captions, titles, keywords, and rights notes describe the picture
  // ("OpenAI CEO Sam Altman speaks...") rather than record the tool that made
  // it, so tool names are not looked for there: XMP free-text fields and the
  // EXIF image description are left out. Tool names still count in software
  // fields, generator text chunks, and edit histories.
  const CAPTION_FIELDS = ["dc:description", "dc:title", "dc:subject", "dc:rights", "photoshop:headline",
    "photoshop:instructions", "photoshop:captionwriter", "iptc4xmpcore:alttextaccessibility",
    "iptc4xmpcore:extdescraccessibility", "lr:hierarchicalsubject", "xmprights:usageterms", "exif:usercomment"];
  function withoutCaptions(text, exifCaption) {
    const source = String(text || "").slice(0, METADATA_TEXT_LIMIT);
    const lower = source.toLowerCase();
    if (lower.length !== source.length) return source;
    const cuts = [];
    for (const name of CAPTION_FIELDS) {
      // Element form: <name ...>...</name>
      for (let from = 0, n = 0; n < 64; n += 1) {
        const open = lower.indexOf("<" + name, from);
        if (open === -1) break;
        const close = lower.indexOf("</" + name + ">", open);
        if (close === -1) break;
        from = close + name.length + 3;
        cuts.push([open, from]);
      }
      // Attribute form: name="..."
      for (let from = 0, n = 0; n < 64; n += 1) {
        const at = lower.indexOf(name, from);
        if (at === -1) break;
        from = at + name.length;
        const quote = /^\s{0,4}=\s{0,4}(["'])/.exec(source.slice(from, from + 12));
        if (!quote) continue;
        const start = from + quote[0].length;
        const end = source.indexOf(quote[1], start);
        if (end === -1) break;
        cuts.push([at, end + 1]);
        from = end + 1;
      }
    }
    const caption = typeof exifCaption === "string" ? exifCaption : "";
    if (caption.trim().length >= 3) {
      for (let from = 0, n = 0; n < 8; n += 1) {
        const at = source.indexOf(caption, from);
        if (at === -1) break;
        from = at + caption.length;
        cuts.push([at, from]);
      }
    }
    if (!cuts.length) return source;
    cuts.sort((a, b) => a[0] - b[0]);
    let out = "", last = 0;
    for (const [start, end] of cuts) {
      if (end <= last) continue;
      out += source.slice(last, Math.max(last, start)) + " ";
      last = end;
    }
    return out + source.slice(last);
  }

  async function analyzeImage(file, sourceContextValue) {
    const derivedFromHEIF = !!(file && file.aicheckInputContext === "heif-derived-jpeg");
    // Any locally re-encoded input invalidates container evidence, because the
    // bytes being examined were written by GAIC or by the capture plugin rather
    // than by whatever produced the original. Encoder fingerprinting is only
    // ever valid on bytes this app did not write. Keep this list in step with
    // every path that sets aicheckInputContext.
    const locallyDerived = !!(file && (
      file.aicheckInputContext === "heif-derived-jpeg" ||
      file.aicheckInputContext === "device-capture-derived-jpeg"
    ));
    const buf = new Uint8Array(await file.arrayBuffer());
    scanStage("metadata");
    const dims = imageDimensions(buf);
    const geometryError = imageGeometryError(dims);
    if (geometryError) {
      return { kind: "error", score: null, verdict: "Image is too large or unsupported",
        explain: geometryError + " This protects your device before the image is decoded.",
        guidance: "Try a supported, smaller image. This failed read did not use a free check.",
        countsTowardLimit: false };
    }
    // Parse the container structure by marker/length so C2PA (JUMBF), EXIF,
    // and XMP evidence comes from format-defined segments and chunks instead
    // of substring-matching arbitrary compressed or trailing bytes.
    const meta = parseImageMetadata(buf);

    // A native HEIC/HEIF Shortcut is converted locally to a bounded JPEG for
    // browser/model compatibility. Never treat the derivative's missing
    // provenance or metadata as evidence about the original container.
    const hasC2PA = derivedFromHEIF ? false : meta.hasC2PA;
    const hasXMP = derivedFromHEIF ? false : meta.hasXMP;
    const hasExif = derivedFromHEIF ? false : meta.hasExif;
    const isGif = matchAt(buf, 0, "GIF87a") || matchAt(buf, 0, "GIF89a");
    // Only trust AI-generator tokens found inside a decoded XMP/EXIF field,
    // not anywhere in the raw byte stream (which produces false positives when
    // ordinary image bytes happen to contain a substring like "imagen").
    let generatorTextKeys = [];
    const metaText = derivedFromHEIF ? "" : (meta.metaText || "");
    const generationSettings = hasGenerationSettings(metaText);
    const aiContentLabel = readAiContentLabel(metaText);
    const toolText = withoutCaptions(metaText, meta.exif && meta.exif.captionText);
    const namedGenerator = GENERATOR_NAMES.test(toolText);
    let aiTags = generationSettings || namedGenerator || AMBIGUOUS_GENERATOR_NAMES.test(toolText);
    // Only an ambiguous name matched: it counts for less in the lean.
    const aiTagAmbiguous = aiTags && !generationSettings && !namedGenerator;

    let provenance = derivedFromHEIF
      ? { status: "unsupported", sourceClass: "unknown" }
      : { status: hasC2PA ? "unavailable" : "absent", sourceClass: "unknown" };
    if (!derivedFromHEIF && window.C2PAVerifier && typeof window.C2PAVerifier.verify === "function") {
      // The official Content Authenticity Initiative SDK validates the embedded
      // manifest, signature and asset binding locally. Its remote-manifest
      // fetch is disabled in c2pa-verifier.mjs, so a file cannot make this
      // check contact an address embedded inside it.
      scanStage("credentials");
      const checked = await window.C2PAVerifier.verify(file);
      provenance = checked && typeof checked.status === "string"
        ? checked
        : { status: hasC2PA ? "unavailable" : "absent", sourceClass: "unknown" };
    }

    // Container/encoder structure: how the file was written, not what it shows.
    // Skipped entirely for a HEIF-derived JPEG, because those bytes were written
    // by GAIC's own transcoder and would fingerprint GAIC rather than the user's
    // file. The module applies the same guard again defensively.
    let encoderEvidence = null;
    let containerDeclarations = null;
    if (!locallyDerived && window.ContainerProvenance &&
        typeof window.ContainerProvenance.readContainerStructure === "function" &&
        window.ProvenanceVerdict &&
        typeof window.ProvenanceVerdict.gradeEncoderStructure === "function") {
      scanStage("structure");
      try {
        const structure = window.ContainerProvenance.readContainerStructure(buf, {
          xmpText: meta.metaText || "",
          captureStructure: !!(meta.exif && (meta.exif.hasMakerNote || meta.exif.hasGps)),
        });
        const matched = window.ContainerProvenance.matchEncoderProfiles(structure);
        encoderEvidence = window.ProvenanceVerdict.gradeEncoderStructure(matched);
        containerDeclarations = structure.xmp;
        // A generator text key in a PNG is a metadata declaration naming an AI
        // tool, so it feeds the existing declaration path rather than pretending
        // to be structural inference.
        if (structure.png && structure.png.generatorTextKeys.length) {
          aiTags = true;
          generatorTextKeys = structure.png.generatorTextKeys.slice(0, 4);
        }
      } catch (_) {
        encoderEvidence = null;
        containerDeclarations = null;
      }
    }

    const sourceContext = normalizeSourceContext(sourceContextValue);
    let score = null, rawModelScore = null, metricLabel = "Image-model score";
    let imageRegionScores = [];
    let uncalibratedCompositeFrame = false;
    let headReading = null, scanKind = "direct-v5";
    let verdict = "No origin record or metadata clue found", parts = [];
    if (derivedFromHEIF) {
      parts.push("Original HEIC/HEIF limit: GAIC made a bounded JPEG derivative locally for the visual model. The original file's Content Credentials and EXIF/XMP metadata were not evaluated, and their presence or absence cannot be inferred from this derivative.");
    } else if (locallyDerived) {
      parts.push("Capture limit: this JPEG was encoded on this device by the capture path rather than written by the camera, so it carries no Content Credentials, no camera metadata, and no original file structure. Their absence says nothing about the photo you took.");
    } else if (provenance.status === "trusted") {
      parts.push("Content Credentials: the embedded manifest, signature, asset binding, and configured signer-trust checks passed. This validates the signed provenance record; it does not prove that the scene or claim is true.");
    } else if (provenance.status === "valid") {
      parts.push("Content Credentials: the embedded manifest, signature, and asset binding passed validation, but this device did not establish the signer as trusted. A valid credential records provenance; it does not prove that the content is true.");
    } else if (provenance.status === "invalid") {
      parts.push("Content Credentials: provenance data was found but failed validation. Do not rely on its claims; the file may be damaged, altered after signing, malformed, or use a credential this validator cannot verify.");
    } else if (provenance.status === "unavailable") {
      parts.push(hasC2PA
        ? "Content Credentials: C2PA/JUMBF structure was detected, but the local validator could not complete this check, so this result is based on the other evidence below."
        : "Content Credentials: the local validator could not complete this check, so this result is based on the other evidence below.");
    } else if (hasC2PA) {
      parts.push("Content Credentials: C2PA/JUMBF structure was detected, but no readable credential was validated on this device. Treat it only as an unverified marker.");
    } else if (provenance.status === "unsupported") {
      parts.push("Content Credentials: this file format is not supported by the local validator, so this result is based on the other evidence below.");
    } else {
      parts.push("Content Credentials: none detected. Credentials are optional and can be removed, so absence says nothing about whether an image is trustworthy.");
    }
    if ((provenance.status === "trusted" || provenance.status === "valid") && provenance.sourceClass === "ai") {
      parts.push("Signed source claim: the validated credential declares trained-algorithmic or AI-created media. This is a strong provenance clue, but review the signer and context before relying on it.");
    } else if ((provenance.status === "trusted" || provenance.status === "valid") && provenance.sourceClass === "capture") {
      parts.push("Signed source claim: the validated credential declares a digital or computational capture. That records the signed workflow; it does not prove the depicted event is true or unedited outside that workflow.");
    } else if ((provenance.status === "trusted" || provenance.status === "valid") && provenance.sourceClass === "screen") {
      parts.push("Signed source claim: the validated credential declares a screen capture. It does not authenticate what appeared on that screen.");
    }
    if (derivedFromHEIF) {
      parts.push("Metadata: the local JPEG derivative's metadata is intentionally ignored because it does not establish what the original HEIC/HEIF contained.");
    } else if (hasExif) {
      const e = meta.exif || {};
      const bits = [];
      if (e.make || e.model) bits.push(((e.make ? e.make + " " : "") + (e.model || "")).trim());
      if (e.dateTime) bits.push("taken " + e.dateTime);
      if (e.software) bits.push("edited with " + e.software);
      parts.push("Metadata: EXIF fields detected" + (bits.length ? " — " + bits.join(" · ") : "") +
        ". Metadata can be edited and is context, not proof.");
    } else {
      parts.push("Metadata: no EXIF fields detected. Social platforms, screenshots, and editing tools often remove them, so absence is not an AI signal.");
    }
    if (hasXMP) parts.push("Metadata: an XMP packet was detected.");
    if (aiTags && generatorTextKeys.length) {
      parts.push("Generator clue: this PNG carries the text chunk" +
        (generatorTextKeys.length === 1 ? " " : "s ") + generatorTextKeys.join(", ") +
        ", which generation tools write to record their own settings. The chunk is editable and " +
        "can be copied onto another file, so verify the original before relying on it.");
    } else if (generationSettings) {
      parts.push("Generator clue: the file's metadata records image-generation settings (sampler, steps, seed, or a node graph) " +
        "in the form Stable Diffusion tools write. The field is editable and can be copied onto another file, so verify the " +
        "original before relying on it.");
    } else if (aiTags) {
      parts.push("Generator clue: editable metadata names a known AI tool. Verify the original file and provenance before relying on it.");
    }
    if (aiContentLabel) {
      parts.push("AI-content label: the file's metadata carries the label defined by China's national standard for " +
        "AI-generated content (GB 45438-2025), marking it as " +
        (aiContentLabel === "1" ? "AI-generated" : aiContentLabel === "2" ? "possibly AI-generated" : "suspected AI-generated") +
        ". Generation services and sharing platforms write this label; like other metadata, it is unsigned and can be " +
        "edited or removed.");
    }
    if (sourceContext) {
      parts.push(sourceContext.knownGenerator
        ? "Source context: you said this came from " + sourceContext.hostname +
          ", which matches " + sourceContext.generatorName +
          ", a service that can generate or edit images with AI. This is a meaningful origin clue, but it does not prove that every image shown on that site was generated."
        : "Source context: you said this came from " + sourceContext.hostname +
          ". GAIC did not open that address or inspect its page. Use the original post, author, and publishing history as separate evidence.");
    }
    if (isGif) parts.push("Animated-image limit: a GIF is checked as one decoded frame. Other animation frames are not analyzed; export representative still frames for a broader review.");

    // On-device AI MODEL (ONNX). The engine v3 decision head gives a calibrated
    // AI likelihood; the engine v2 per-region scores stay as diagnostics and as
    // the fallback when the head is unavailable. It never establishes authorship.
    if (window.OnnxDetector) {
      const m = await window.OnnxDetector.detect(file, scanDetectOptions());
      if (m && Number.isFinite(m.aiLikelihood)) {
        rawModelScore = Math.max(0, Math.min(100, m.aiLikelihood * 100));
        score = Math.floor(rawModelScore + Number.EPSILON);
        const label = m.model || "GAIC Image Model";
        imageRegionScores = normalizeImageRegionScores(m);
        headReading = m.head && Number.isFinite(m.head.probability) &&
          m.head.probability >= 0 && m.head.probability <= 1 ? m.head : null;
        scanKind = m.regionScan === "content-aware-tta-v6" ? "composite-v6" : "direct-v5";
        if (headReading) {
          parts.push("GAIC Image Model v3: " + Math.round(headReading.probability * 100) +
            "% AI likelihood, averaged over " + (Number(headReading.views) || imageRegionScores.length) +
            " views of this " + (headReading.kind === "composite" ? "screenshot and the picture located inside it" : "image") +
            ". The decision head was trained on 2025–2026 generators and on real photos, artwork, charts, screenshots, and app interfaces, and calibrated on generator families and image sources it never saw in training.");
        }
        if (m.regionScan === "content-aware-tta-v6") {
          // Scan v6 composite frame: a picture surrounded by interface
          // background (screenshot, letterboxed frame) was located. The
          // headline is the higher of the picture reading and the reviewed
          // whole-frame scan, so the picture reading only adds detections.
          const viewCount = Number.isSafeInteger(m.viewsAveraged) ? m.viewsAveraged : 0;
          const picture = imageRegionScores.find((region) => region.id === "picture");
          const frame = imageRegionScores.find((region) => region.id !== "picture");
          const pct = (region) => (Math.round(region.aiLikelihood * 1000) / 10).toFixed(1) + "/100";
          const area = Number(m.pictureArea);
          metricLabel = "Screenshot scan: stronger of two readings";
          parts.push("Region scan (" + label + "): " + score + "/100, the higher of two local readings. " +
            (picture ? "Detected picture" +
              (Number.isFinite(area) && area > 0 ? " (about " + Math.round(area * 100) + "% of the frame)" : "") +
              ", averaged over " + viewCount + " views at the model's working scale: " + pct(picture) + ". " : "") +
            (frame ? "Whole-frame scan, strongest of its regions (" + frame.label + "): " + pct(frame) + "." : ""));
          parts.push("Layout context: the picture is surrounded by flat interface areas, such as a status bar, page margin, chat window, or player bars, so GAIC also scanned the picture itself. GAIC did not read a page URL, browser history, DOM, nearby text, or another app.");
          parts.push("Scan limits: locating the picture removes interface pixels the model was never trained on, and averaging several views steadies its reading, but screenshots hide detail, so a screenshot reading is less certain than a reading of the original file.");
          uncalibratedCompositeFrame = !headReading && rawModelScore < IMAGE_AI_ELEVATED_BAND;
        } else if (imageRegionScores.length > 1) {
          metricLabel = "Strongest-region model signal";
          const diagnostics = imageRegionScores.map((region) =>
            region.label + " " +
            (Math.round(region.aiLikelihood * 1000) / 10).toFixed(1) +
            "/100"
          );
          parts.push("Region scan (" + label + "): " + score + "/100 strongest-region model signal, the highest of " +
            imageRegionScores.length + " local views. Region diagnostics: " +
            diagnostics.join(" · ") + ".");
          const context = frameLayoutContext(file, dims, imageRegionScores.length);
          if (context) parts.push(context);
          uncalibratedCompositeFrame = !headReading &&
            isScreenCaptureLikeFrame(file, dims) &&
            rawModelScore < IMAGE_AI_ELEVATED_BAND;
          if (uncalibratedCompositeFrame) scanKind = "composite-v6";
        } else {
          parts.push("Region scan (" + label + "): " + score + "/100 model signal.");
        }
        parts.push("Model limits: heavy edits, screenshots, recompression, unusual content, and generators newer than its training data can still fool it in either direction.");
      }
    }
    if (rawModelScore == null) {
      const configured = !!(window.AICHECK_ONNX && window.AICHECK_ONNX.model);
      const boundedModelError =
        window.OnnxDetector &&
        typeof window.OnnxDetector.lastError === "string"
          ? window.OnnxDetector.lastError.slice(0, 300)
          : "";
      parts.push((configured
        ? "Model status: the bundled image model could not load on this device, so the pixel scan did not run."
        : "Model status: this build does not include a trained image model, so the pixel scan did not run.") +
        (boundedModelError ? " " + boundedModelError : ""));
    }

    // The evidence read (technical line) comes from provenance-verdict.mjs as
    // one auditable decision table: a validated Content Credential outranks
    // every other signal, and editable generator metadata outranks a bare
    // model score. The headline lean comes from decideImageLean, which weighs
    // the same evidence as calibrated likelihood ratios. See
    // test/provenance-verdict.mjs for the enforced invariants.
    scanStage("weigh");
    // With the decision head, the pixel evidence is its calibrated probability
    // (on the same 0-100 scale the warning bands use); without it, the engine v2
    // raw score and its measured likelihood-ratio table.
    const evidenceInput = {
      provenance,
      container: { hasC2PA, hasExif, hasXMP, derivedFromHEIF },
      metadata: { generatorTagged: aiTags, generatorTagAmbiguous: aiTagAmbiguous && !generatorTextKeys.length,
        generatorParameters: generatorTextKeys.length > 0 || generationSettings,
        aiContentLabel,
        exif: derivedFromHEIF ? {} : (meta.exif || {}) },
      encoder: encoderEvidence,
      declarations: containerDeclarations,
      sourceContext,
      pixel: {
        available: rawModelScore != null,
        rawScore: headReading ? headBandScore(headReading.probability, headReading.cuts) : rawModelScore,
        probability: headReading ? headReading.probability : null,
        cuts: headReading ? headReading.cuts || null : null,
        scan: scanKind,
        elevatedBand: IMAGE_AI_ELEVATED_BAND,
        warningBand: IMAGE_AI_BAND,
        compositeFrame: uncalibratedCompositeFrame,
      },
    };
    let evidence = null, decision = null;
    const verdictModule = window.ProvenanceVerdict;
    if (verdictModule && typeof verdictModule.assessImageEvidence === "function") {
      evidence = verdictModule.assessImageEvidence(evidenceInput);
    }
    if (verdictModule && typeof verdictModule.decideImageLean === "function") {
      decision = verdictModule.decideImageLean(evidenceInput);
    } else if (rawModelScore != null) {
      decision = fallbackLean(headReading ? headReading.probability : rawModelScore / 100);
    }

    if (evidence) {
      verdict = evidence.headline;
      // The tier's own limits are appended so a headline can never reach the UI
      // without the statement of what it does not establish.
      for (const limit of evidence.doesNotEstablish) {
        if (parts.indexOf(limit) === -1) parts.push(limit);
      }
    } else {
      verdict = rawModelScore != null
        ? imageSignalVerdict(evidenceInput.pixel.rawScore)
        : "No origin record or metadata clue found";
      parts.push("Evidence ordering unavailable on this device; this result is based on the pixel scan alone.");
    }

    if (!decision) {
      // Nothing to decide from: the model did not run and no origin clue was
      // found. That is a failed check, not a verdict, and it is not counted.
      return { kind: "error", score: null, verdict: "Couldn't complete the check",
        explain: parts.join("\n"),
        provenanceStatus: provenance.status,
        guidance: "Try again, or try a JPEG or PNG copy of the image. This failed check did not use a free check.",
        countsTowardLimit: false };
    }

    const imageResult = { kind: "image", score, metricLabel, verdict, explain: parts.join("\n"),
      provenanceStatus: provenance.status,
      evidenceTier: evidence ? evidence.tier : null,
      evidenceBand: evidence ? evidence.band : null,
      evidenceBandLabel: evidence ? evidence.bandLabel : null,
      evidenceLead: evidence ? evidence.lead : null,
      evidenceEstablishes: evidence ? evidence.establishes : [],
      evidenceDoesNotEstablish: evidence ? evidence.doesNotEstablish : [],
      // Structural strength is one of four frozen words, never a number, and is
      // never combined with the model score into an "overall" figure.
      structuralStrength: encoderEvidence ? encoderEvidence.strength : "none",
      structuralClasses: encoderEvidence ? encoderEvidence.classes : [],
      imageRegionScores,
      sourceContext: sourceContext ? {
        hostname: sourceContext.hostname,
        knownGenerator: sourceContext.knownGenerator,
      } : null,
      mediaSummary: describeMedia(file, dims, derivedFromHEIF ? null : (meta.exif || null),
        derivedFromHEIF ? "converted locally from HEIC/HEIF" : null),
      guidance: "Check the original source, compare important credentials in another reputable validator, and look for corroborating evidence. Never use this result alone for discipline, employment, legal, safety, or moderation decisions." };
    applyDecision(imageResult, { lean: decision.lean, confidence: decision.confidence,
      aiLikelihood: decision.probabilityAi * 100 });
    // The summary copy describes the pixel scan by its own band, never by the
    // combined likelihood (a signed record can decide without the pixels).
    imageResult.pixelBand = rawModelScore == null ? "none"
      : evidenceInput.pixel.rawScore >= IMAGE_AI_BAND ? "high"
        : evidenceInput.pixel.rawScore >= IMAGE_AI_ELEVATED_BAND ? "elevated" : "below";
    imageResult.leanAuthority = decision.authority || "";
    imageResult.leanDrivers = Array.isArray(decision.drivers) ? decision.drivers.slice(0, 8) : [];
    imageResult.explain = leanSentence(imageResult) + "\n" + imageResult.explain;
    return imageResult;
  }

  /* ================ BEGIN ON-DEVICE-ONLY (video + screen scan) ================
     Everything between these sentinels runs entirely on this device. The block
     must contain no network primitives at all — test/platform-readiness.mjs
     asserts that sampled video frames and captured screen pixels never leave
     the device. Every model score here is a weak signal, not proof. */

  // ---------- VIDEO: sample frames -> existing on-device image model ----------
  function fmtClock(seconds) {
    const m = Math.floor(seconds / 60), s = Math.round(seconds % 60);
    return m + ":" + String(s).padStart(2, "0");
  }

  function showProgress(text, fraction) {
    if (scanPanelProgress(fraction)) return;
    const wrap = $("scan-progress"), bar = $("scan-progress-bar"),
      track = $("scan-progress-track"), label = $("scan-progress-text");
    if (!wrap) return;
    wrap.hidden = false;
    const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
    // scaleX, not width: transform stays on the compositor while frame decode
    // and background-worker inference are in progress.
    if (bar) bar.style.transform = "scaleX(" + pct / 100 + ")";
    if (track) track.setAttribute("aria-valuenow", String(pct));
    if (label) label.textContent = text;
  }
  function hideProgress() { const wrap = $("scan-progress"); if (wrap) wrap.hidden = true; }

  // Seek and wait until the frame at `t` is actually presented. Prefers
  // requestVideoFrameCallback where available; otherwise falls back to the
  // `seeked` event plus a short settle delay. A hard timeout guarantees one
  // undecodable frame can never hang the whole check.
  function seekVideo(video, t, hardTimeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      let settleTimer = null;
      let frameCallbackId = null;
      const finish = (confirmed) => {
        if (done) return; done = true;
        clearTimeout(hardTimer);
        if (settleTimer != null) clearTimeout(settleTimer);
        if (frameCallbackId != null && typeof video.cancelVideoFrameCallback === "function") {
          try { video.cancelVideoFrameCallback(frameCallbackId); } catch (_) {}
        }
        video.removeEventListener("seeked", onSeeked);
        resolve(confirmed === true);
      };
      const onSeeked = () => {
        if (typeof video.requestVideoFrameCallback === "function") {
          try {
            frameCallbackId = video.requestVideoFrameCallback(() => finish(true));
            // The seeked event already confirmed the target seek. If Chromium
            // does not deliver rVFC for a paused video, a short settle period is
            // still a confirmed fallback; the hard timeout below is not.
            settleTimer = setTimeout(() => finish(true), 300);
          } catch (_) {
            settleTimer = setTimeout(() => finish(true), 60);
          }
        } else {
          settleTimer = setTimeout(() => finish(true), 60);
        }
      };
      const hardTimer = setTimeout(() => finish(false),
        Number.isFinite(hardTimeoutMs) && hardTimeoutMs >= 0 ? hardTimeoutMs : 4000);
      video.addEventListener("seeked", onSeeked, { once: true });
      try { video.currentTime = t; } catch (e) { finish(false); }
    });
  }

  // Reduce C2PA output to a fixed vocabulary before it reaches the result UI.
  // No manifest-provided labels, URLs, or free-form strings are displayed, and
  // only a validated credential may supply a source class.
  function sanitizeVideoProvenance(value) {
    const allowedStatuses = new Set(["absent", "trusted", "valid", "invalid", "unavailable", "unsupported"]);
    const status = value && allowedStatuses.has(value.status) ? value.status : "unavailable";
    const validated = status === "trusted" || status === "valid";
    const sourceClass = validated && value && ["ai", "capture", "screen"].includes(value.sourceClass)
      ? value.sourceClass : "unknown";
    return { status, sourceClass };
  }

  async function verifyVideoProvenance(file) {
    const verifier = window.C2PAVerifier;
    if (!verifier || typeof verifier.verify !== "function") {
      return { status: "unavailable", sourceClass: "unknown" };
    }
    try {
      return sanitizeVideoProvenance(await verifier.verify(file));
    } catch (_) {
      return { status: "unavailable", sourceClass: "unknown" };
    }
  }

  function videoProvenanceEvidence(value) {
    const provenance = sanitizeVideoProvenance(value);
    const validatedAi = (provenance.status === "trusted" || provenance.status === "valid") &&
      provenance.sourceClass === "ai";
    let verdict = null;
    const lines = [];

    if (provenance.status === "trusted") {
      lines.push("Content Credentials: the embedded manifest, signature, asset binding, and configured signer-trust checks passed. This validates the signed provenance record; it does not prove that the video or its claims are true.");
    } else if (provenance.status === "valid") {
      lines.push("Content Credentials: the embedded manifest, signature, and asset binding passed validation, but this device did not establish the signer as trusted. The credential records provenance; it does not prove that the video is true.");
    } else if (provenance.status === "invalid") {
      lines.push("Content Credentials: provenance data was found but failed validation. Do not rely on its claims; the file may be damaged, altered after signing, malformed, or use a credential this validator cannot verify.");
    } else if (provenance.status === "unavailable") {
      lines.push("Content Credentials: the local validator could not complete this check, so this result is based on the sampled frames.");
    } else if (provenance.status === "unsupported") {
      lines.push("Content Credentials: this video format is not supported by the local validator, so this result is based on the sampled frames.");
    } else {
      lines.push("Content Credentials: none detected. Credentials are optional and can be removed, so absence says nothing about whether a video is trustworthy or AI-generated.");
    }

    if (validatedAi) {
      verdict = "Validated AI-origin claim — verify context";
      lines.push("Signed source claim: the validated credential declares trained-algorithmic or AI-created media. This is a strong provenance clue, but review the signer and context before relying on it.");
    } else if (provenance.status === "invalid") {
      verdict = "Content Credential failed validation";
    } else if (provenance.status === "trusted") {
      verdict = "Trusted Content Credential found — not truth proof";
    } else if (provenance.status === "valid") {
      verdict = "Valid Content Credential — signer trust not established";
    } else if (provenance.status === "unavailable") {
      verdict = "Content Credential check did not complete";
    } else if (provenance.status === "unsupported") {
      verdict = "Content Credential check not supported for this format";
    }

    if (!validatedAi && provenance.sourceClass === "capture") {
      lines.push("Signed source claim: the validated credential declares a digital or computational capture. That records the signed workflow; it does not prove the depicted event is true.");
    } else if (!validatedAi && provenance.sourceClass === "screen") {
      lines.push("Signed source claim: the validated credential declares a screen capture. It does not authenticate what appeared on that screen.");
    }
    return { status: provenance.status, sourceClass: provenance.sourceClass, verdict, lines };
  }

  // A frame whose luminance barely varies (fade to black, solid title card,
  // blank stream start) carries no visual evidence; scoring it only adds
  // noise, so the sampler moves to a nearby moment instead. Screen capture
  // uses a far stricter limit: a sparse text page can look flat at 32x32, and
  // only a truly empty frame (such as a stream's black first frame) is dropped.
  const BLANK_FRAME_MAX_STD = 6;
  const BLANK_SCREEN_MAX_STD = 1;
  function frameLooksBlank(source, maxStd) {
    try {
      const probe = document.createElement("canvas");
      probe.width = 32; probe.height = 32;
      const context = probe.getContext("2d", { willReadFrequently: true });
      context.drawImage(source, 0, 0, 32, 32);
      const d = context.getImageData(0, 0, 32, 32).data;
      let sum = 0, squares = 0;
      for (let i = 0; i < d.length; i += 4) {
        const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        sum += y; squares += y * y;
      }
      const n = d.length / 4, mean = sum / n;
      return Math.sqrt(Math.max(0, squares / n - mean * mean)) <
        (Number.isFinite(maxStd) ? maxStd : BLANK_FRAME_MAX_STD);
    } catch (_) {
      return false;
    }
  }

  // A 16x16 luminance fingerprint lets an unchanged screen frame reuse the
  // score of the identical frame before it instead of re-running the model.
  function frameFingerprint(source) {
    try {
      const probe = document.createElement("canvas");
      probe.width = 16; probe.height = 16;
      const context = probe.getContext("2d", { willReadFrequently: true });
      context.drawImage(source, 0, 0, 16, 16);
      const d = context.getImageData(0, 0, 16, 16).data;
      const out = new Float32Array(256);
      for (let i = 0; i < 256; i += 1) out[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
      return out;
    } catch (_) {
      return null;
    }
  }
  function sameFrame(left, right) {
    if (!left || !right || left.length !== right.length) return false;
    let total = 0;
    for (let i = 0; i < left.length; i += 1) total += Math.abs(left[i] - right[i]);
    return total / left.length < 1;
  }

  // Draw the current video frame to a canvas and wrap it as a PNG File so the
  // existing on-device image pipeline (OnnxDetector.detect) scores it unchanged.
  // The frame is marked so the scanner keeps the reviewed 2.4.0 scan: the
  // located-picture reading was calibrated on screenshots, not on lossy video.
  function frameToFile(video, cv, frameNumber) {
    return new Promise((resolve) => {
      try {
        const vw = video.videoWidth || 0, vh = video.videoHeight || 0;
        if (!vw || !vh) return resolve(null);
        const scale = Math.min(1, 1024 / Math.max(vw, vh));
        cv.width = Math.max(1, Math.round(vw * scale));
        cv.height = Math.max(1, Math.round(vh * scale));
        cv.getContext("2d").drawImage(video, 0, 0, cv.width, cv.height);
        cv.toBlob((blob) => {
          if (!blob) return resolve(null);
          const frame = new File([blob], "frame-" + frameNumber + ".png", { type: "image/png" });
          try { Object.defineProperty(frame, "aicheckScanHint", { value: "video-frame" }); } catch (_) {}
          resolve(frame);
        }, "image/png");
      } catch (e) { resolve(null); }
    });
  }

  async function analyzeVideo(file) {
    showProgress("Checking local Content Credentials…", 0);
    scanStage("credentials");
    const provenance = await verifyVideoProvenance(file);
    const provenanceEvidence = videoProvenanceEvidence(provenance);
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.muted = true; video.playsInline = true; video.preload = "auto";
    try {
      scanStage("video-open");
      const loaded = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 15000);
        video.onloadedmetadata = () => { clearTimeout(timer); resolve(true); };
        video.onerror = () => { clearTimeout(timer); resolve(false); };
        video.src = url;
      });
      let duration = video.duration;
      if (loaded && duration === Infinity) {
        // Chromium reports Infinity for some WebM files (screen recorders,
        // MediaRecorder output) until a far seek forces it to compute the
        // real duration. Local-only workaround; nothing is decoded twice.
        duration = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(video.duration), 3000);
          video.ondurationchange = () => {
            if (isFinite(video.duration)) { clearTimeout(timer); resolve(video.duration); }
          };
          try { video.currentTime = 1e7; } catch (e) { clearTimeout(timer); resolve(video.duration); }
        });
        try { video.currentTime = 0; } catch (e) {}
      }
      if (!loaded || !isFinite(duration) || duration <= 0) {
        if (["trusted", "valid", "invalid"].includes(provenance.status)) {
          const credentialLean = credentialOnlyDecision(provenance);
          if (credentialLean) {
            const credentialResult = { kind: "video", score: null, verdict: provenanceEvidence.verdict,
              explain: provenanceEvidence.lines.concat([
                "Frame sampling: this device could not decode the video or read its duration, so this result rests on the Content Credential alone. Nothing was uploaded.",
                "Video limits: audio and motion over time were not analyzed. Content Credentials describe a signed provenance record, not whether the depicted event is true.",
              ]).join("\n"), provenanceStatus: provenance.status,
              guidance: "Check the original source and compare important credentials in another reputable validator. Do not make a consequential decision from this credential alone." };
            applyDecision(credentialResult, credentialLean);
            credentialResult.pixelBand = "none";
            credentialResult.explain = leanSentence(credentialResult) + "\n" + credentialResult.explain;
            return credentialResult;
          }
        }
        return { kind: "error", score: null, verdict: "Couldn't read this video",
          explain: provenanceEvidence.lines.concat(["This device couldn't decode the video or read its duration. Try a standard MP4 (H.264) or WebM file. Nothing was uploaded."]).join("\n"),
          provenanceStatus: provenance.status,
          guidance: "This failed read did not use a free check.", countsTowardLimit: false };
      }
      const windowSeconds = Math.min(duration, VIDEO_SCAN_WINDOW_SECONDS);
      const total = VIDEO_FRAME_SAMPLES;
      announce("Checking video — analyzing " + total + " frames on this device.", true);
      const cv = document.createElement("canvas");
      const frameScores = [];
      const frameReads = [];
      const frameNotes = [];
      const step = windowSeconds / total;
      for (let i = 0; i < total; i++) {
        showProgress("Analyzing frame " + (i + 1) + " of " + total + "…", i / total);
        scanStage("frame", { index: i, total });
        let pct = null, read = null;
        let note = "seek not confirmed";
        // Try the evenly spaced moment first, then two nearby moments within
        // the same sampling slot if that frame is blank or unreadable.
        for (const offset of [0, 0.3, -0.3]) {
          const t = Math.min(Math.max(0, windowSeconds * ((i + 0.5) / total) + offset * step),
            Math.max(0, duration - 0.05));
          if (!(await seekVideo(video, t))) { note = "seek not confirmed"; continue; }
          const frame = await frameToFile(video, cv, i + 1);
          if (!frame) { note = "frame unavailable"; continue; }
          if (frameLooksBlank(cv)) { note = "blank frame skipped"; continue; }
          note = "no model read";
          scanFrame(frame, i, total);
          if (window.OnnxDetector) {
            try {
              const m = await window.OnnxDetector.detect(frame, scanDetectOptions());
              if (m && Number.isFinite(m.aiLikelihood)) {
                pct = Math.max(0, Math.min(100, m.aiLikelihood * 100));
                read = frameRead(m, pct);
                note = frameNote(read);
              }
            } catch (_) {}
          }
          break;
        }
        frameScores.push(pct);
        frameReads.push(read);
        frameNotes.push(note);
        showProgress("Analyzed frame " + (i + 1) + " of " + total, (i + 1) / total);
      }
      scanStage("weigh");
      const valid = frameScores.filter((s) => Number.isFinite(s));
      if (!valid.length) {
        const credentialLean = credentialOnlyDecision(provenance);
        if (credentialLean) {
          const credentialResult = { kind: "video", score: null, verdict: provenanceEvidence.verdict,
            explain: provenanceEvidence.lines.concat([
              "Frame sampling: none of the " + total + " requested seeks produced a confirmed, model-scored still frame, so this result rests on the Content Credential alone. Nothing was uploaded.",
              "Video limits: audio and motion over time were not analyzed. The credential result is provenance evidence, not proof that the video is true.",
            ]).join("\n"), provenanceStatus: provenance.status,
            guidance: "Try a shorter standard MP4 or inspect representative still frames, and compare important credentials in another reputable validator." };
          applyDecision(credentialResult, credentialLean);
          credentialResult.pixelBand = "none";
          credentialResult.explain = leanSentence(credentialResult) + "\n" + credentialResult.explain;
          return credentialResult;
        }
        return { kind: "error", score: null, verdict: "Video frames couldn't be scored",
          explain: provenanceEvidence.lines.concat(["None of the requested seeks produced a confirmed, model-scored still frame. No score was invented, and nothing left your device."]).join("\n"),
          provenanceStatus: provenance.status,
          guidance: "Try a shorter standard MP4 or a few still screenshots. This failed check did not use a free check.",
          countsTowardLimit: false };
      }
      // Honest aggregation: median (typical frame) + max (worst frame). One
      // spiky frame is reported but doesn't masquerade as the whole video, and
      // the lean follows the typical frame (frameDecision).
      const frameSignal = frameSignalSummary(frameBandScores(frameReads, valid));
      const rawSignal = frameSignalSummary(valid);
      const decision = frameDecision(frameReads.filter(Boolean),
        { status: provenance.status, sourceClass: provenance.sourceClass });
      const median = rawSignal.median;
      const maxScore = rawSignal.maxScore;
      const modelVerdict = frameSignal.verdict;
      const verdict = provenanceEvidence.verdict || modelVerdict;
      const perFrame = frameNotes
        .map((note, i) => "Frame " + (i + 1) + " of " + total + " — " + note)
        .join("\n");
      const parts = provenanceEvidence.lines.concat([
        "Video sampling: " + valid.length + " of " + total + " frames sampled evenly across 0:00–" + fmtClock(windowSeconds) +
          (duration > VIDEO_SCAN_WINDOW_SECONDS ? " (long video: only the first " + fmtClock(VIDEO_SCAN_WINDOW_SECONDS) + " is sampled)" : "") +
          ", all on your device. A video check counts as one check against the free weekly allowance.",
        perFrame,
        "Region scan: median " + median + "/100, highest sampled frame " + maxScore + "/100.",
        "Video limits: this still-image model reads sampled frames; it has not been validated as a full-video detector. Only " + total + " still frames were sampled; motion over time and audio were not analyzed; compression and re-encoding can hide or mimic artifacts, so video confidence is lower than for still images. Nothing left your device.",
      ]);
      const videoResult = { kind: "video", score: frameSignal.score, metricLabel: "Median frame-model score", verdict, explain: parts.join("\n"),
        provenanceStatus: provenance.status,
        mediaSummary: describeMedia(file,
          video.videoWidth && video.videoHeight ? { width: video.videoWidth, height: video.videoHeight, format: "video" } : null,
          null, "runs " + fmtClock(duration)),
        guidance: "Inspect the original video, source account, edit history, and multiple representative frames. Never make a consequential decision from this sample alone." };
      applyDecision(videoResult, decision);
      videoResult.pixelBand = frameSignal.medianRaw >= IMAGE_AI_BAND ? "high"
        : frameSignal.medianRaw >= IMAGE_AI_ELEVATED_BAND ? "elevated" : "below";
      videoResult.explain = leanSentence(videoResult) + "\n" + videoResult.explain;
      return videoResult;
    } finally {
      hideProgress();
      try { video.removeAttribute("src"); video.load(); } catch (e) {}
      URL.revokeObjectURL(url);
    }
  }

  // ---------- SCAN MY SCREEN: one display frame -> same on-device pipeline ----------
  // Accessibility tool: one large button captures a single frame of a surface
  // the user explicitly picks, stops the capture immediately, and runs the
  // normal on-device analysis. Where getDisplayMedia doesn't exist (iOS
  // Safari, Android/iOS WebView shells), it explains the screenshot fallback
  // that hands the screenshot to the existing photo picker instead.
  async function scanScreen() {
    // One check at a time: a capture started mid-check would report its
    // recording progress into the running check's panel.
    if (running) { announce("Wait for the current check to finish, then scan your screen.", true); return; }
    switchTab("image");
    if (!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia)) {
      const how = "Screen capture isn't available in this browser or app — iPhone/iPad and most in-app views don't offer it. " +
        "Instead: take a screenshot (iPhone: Side button + Volume Up · Android: Power + Volume Down), " +
        "then tap 🖼 Choose Photo and pick the screenshot from Recents. It's analyzed the same way, on your device.";
      showResult({ kind: "error", score: null, verdict: "Use a screenshot instead", explain: how,
        guidance: "Choose the screenshot from your photo library. No free check was used.", countsTowardLimit: false });
      announce(how, true);
      speak("Screen capture isn't available here. Take a screenshot, then choose it with the photo picker, and I'll check it the same way.");
      analyticsTrack("check_failed", "unsupported");
      return;
    }
    // Privacy: a screen frame must never ride an earlier cloud opt-in. Clear
    // the per-check consent so this frame stays on-device no matter what.
    const consent = $("cloud-consent");
    if (consent) consent.checked = false;
    let stream = null;
    try {
      announce("Choose the screen or window to check. GAIC records about " + SCREEN_CAPTURE_SECONDS +
        " seconds, analyzes several frames on this device, and never uploads them.", true);
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const frames = await recordDisplayFrames(stream);
      stream.getTracks().forEach((t) => t.stop()); // stop sharing the moment the window closes
      stream = null;
      if (!frames.length) {
        showResult({ kind: "error", score: null, verdict: "Couldn't capture the screen",
          explain: "No frames could be read from the shared surface. Nothing was captured or uploaded.",
          guidance: "Try again, or take a screenshot and choose it from your photo library. No free check was used.",
          countsTowardLimit: false });
        analyticsTrack("check_failed", "model_error");
        return;
      }
      await runScreenCheck(frames);
    } catch (e) {
      showResult({ kind: "error", score: null, verdict: "Screen capture cancelled",
        explain: "No screen was shared, so nothing was captured, analyzed, or uploaded.",
        guidance: "No free check was used.", countsTowardLimit: false });
      analyticsTrack("check_failed", "permission_denied");
    } finally {
      if (stream) stream.getTracks().forEach((t) => t.stop());
    }
  }

  // Sample the shared surface for ~SCREEN_CAPTURE_SECONDS, returning several
  // still frames taken across that window.
  //
  // Frames are pulled straight off the live stream rather than encoded with
  // MediaRecorder and decoded again: it captures the same span of time, keeps
  // the pixels the model sees at full fidelity instead of through a lossy
  // intermediate codec, and — the point that matters most here — never
  // materializes a recording of the user's screen in memory or on disk.
  // Nothing but transient canvas frames ever exists, and none of it is uploaded.
  function recordDisplayFrames(stream) {
    return new Promise((resolve) => {
      const video = document.createElement("video");
      video.muted = true; video.playsInline = true; video.srcObject = stream;
      const frames = [];
      let settled = false;
      const cv = document.createElement("canvas");
      const cleanup = () => { try { video.pause(); video.srcObject = null; } catch (e) {} };
      const finish = () => {
        if (settled) return; settled = true;
        clearInterval(sampler); clearTimeout(hardStop);
        cleanup();
        resolve(frames.filter(Boolean));
      };
      // Screens keep up to 1600 px on the long side (video frames keep 1024):
      // the scan locates the picture inside the screen, and a small picture
      // needs the extra pixels to stay near the model's working scale.
      const grab = () => new Promise((done) => {
        try {
          const vw = video.videoWidth || 0, vh = video.videoHeight || 0;
          if (!vw || !vh) return done(null);
          const scale = Math.min(1, 1600 / Math.max(vw, vh));
          cv.width = Math.max(1, Math.round(vw * scale));
          cv.height = Math.max(1, Math.round(vh * scale));
          cv.getContext("2d").drawImage(video, 0, 0, cv.width, cv.height);
          // A blank frame (the stream is still starting, or the surface is
          // black) is not kept; the sampler simply takes the next one.
          if (frameLooksBlank(cv, BLANK_SCREEN_MAX_STD)) return done(null);
          const fingerprint = frameFingerprint(cv);
          cv.toBlob((blob) => {
            if (!blob) return done(null);
            const file = new File([blob], "screen-frame-" + (frames.length + 1) + ".png", { type: "image/png" });
            try { Object.defineProperty(file, "aicheckFingerprint", { value: fingerprint }); } catch (_) {}
            done(file);
          }, "image/png");
        } catch (e) { done(null); }
      });
      let sampler = 0;
      // Absolute ceiling: never keep the screen shared longer than the window
      // we promised, even if the stream stalls.
      const hardStop = setTimeout(finish, SCREEN_CAPTURE_SECONDS * 1000 + 2500);
      // The user can stop sharing from the browser's own bar at any time.
      try {
        const track = stream.getVideoTracks()[0];
        if (track) track.addEventListener("ended", finish);
      } catch (_) {}
      video.onloadedmetadata = () => {
        const p = video.play();
        if (p && p.catch) p.catch(() => {});
        const started = Date.now();
        const takeOne = async () => {
          const f = await grab();
          if (f) frames.push(f);
          const elapsed = Date.now() - started;
          showProgress("Recording your screen — frame " + frames.length + " of " + SCREEN_FRAME_SAMPLES + "…",
            Math.min(1, elapsed / (SCREEN_CAPTURE_SECONDS * 1000)));
          if (frames.length >= SCREEN_FRAME_SAMPLES) finish();
        };
        takeOne();
        sampler = setInterval(takeOne, Math.round((SCREEN_CAPTURE_SECONDS * 1000) / SCREEN_FRAME_SAMPLES));
      };
      video.onerror = finish;
    });
  }

  function frameSignalSummary(scores) {
    const sorted = scores.filter((score) => Number.isFinite(score))
      .slice()
      .sort((left, right) => left - right);
    if (!sorted.length) return null;
    const mid = sorted.length >> 1;
    const medianRaw = sorted.length % 2
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
    const maxRaw = sorted[sorted.length - 1];
    const highSignal = medianRaw >= IMAGE_AI_BAND;
    const elevatedSignal = medianRaw >= IMAGE_AI_ELEVATED_BAND;
    return {
      medianRaw,
      maxRaw,
      median: Math.floor(medianRaw + Number.EPSILON),
      maxScore: Math.floor(maxRaw + Number.EPSILON),
      score: Math.floor(medianRaw + Number.EPSILON),
      verdict: highSignal
        ? "High model signal in sampled frames — verify"
        : elevatedSignal
          ? "Elevated model signal in sampled frames — verify"
          : "Sampled frames below warning bands",
    };
  }

  // One frame's model read, for frameDecision: the engine v2 score plus the
  // decision head's calibrated probability when the head ran.
  function frameRead(m, pct) {
    const head = m && m.head && Number.isFinite(m.head.probability) ? m.head : null;
    return { pct, probability: head ? head.probability : null, cuts: head ? head.cuts || null : null };
  }

  // Per-frame scores for the evidence read: the decision head's band scores
  // when every scored frame has one, otherwise the engine v2 raw scores.
  function frameBandScores(reads, raw) {
    const scored = reads.filter(Boolean);
    return scored.length === raw.length && scored.every((read) => Number.isFinite(read.probability))
      ? scored.map((read) => headBandScore(read.probability, read.cuts))
      : raw;
  }

  function frameNote(read) {
    return Number.isFinite(read.probability)
      ? Math.round(read.probability * 100) + "% AI likelihood"
      : Math.floor(read.pct + Number.EPSILON) + "/100 model signal";
  }

  // A validated or trusted credential can decide a video on its own when no
  // frame could be read; anything weaker is a failed check.
  function credentialOnlyDecision(provenance) {
    const verdictModule = window.ProvenanceVerdict;
    if (!verdictModule || typeof verdictModule.decideImageLean !== "function") return null;
    const lean = verdictModule.decideImageLean({
      provenance: { status: provenance.status, sourceClass: provenance.sourceClass },
    });
    return lean ? { lean: lean.lean, confidence: lean.confidence, aiLikelihood: lean.probabilityAi * 100 } : null;
  }

  // Score every captured frame and aggregate into ONE verdict, mirroring the
  // video path: median is the typical frame, max is the worst, and a single
  // spiky frame is reported without masquerading as the whole capture. An
  // unchanged frame reuses the score of the identical frame before it.
  async function analyzeScreenFrames(frames) {
    const total = frames.length;
    const scores = [];
    const reads = [];
    const notes = [];
    let previous = null;
    for (let i = 0; i < total; i++) {
      showProgress("Analyzing frame " + (i + 1) + " of " + total + "…", i / total);
      scanStage("frame", { index: i, total });
      scanFrame(frames[i], i, total);
      let pct = null, read = null, note = "no model read";
      const fingerprint = frames[i] && frames[i].aicheckFingerprint;
      if (previous && Number.isFinite(previous.pct) && sameFrame(previous.fingerprint, fingerprint)) {
        pct = previous.pct;
        read = previous.read;
        scanStage("frame", { index: i, total, from: previous.index });
        note = frameNote(read) + " (unchanged from frame " + previous.index + ")";
      } else if (window.OnnxDetector) {
        try {
          const m = await window.OnnxDetector.detect(frames[i], scanDetectOptions());
          if (m && Number.isFinite(m.aiLikelihood)) {
            pct = Math.max(0, Math.min(100, m.aiLikelihood * 100));
            read = frameRead(m, pct);
            note = frameNote(read) +
              (m.regionScan === "content-aware-tta-v6" ? " (picture located on screen)" : "");
            previous = { pct, read, fingerprint, index: i + 1 };
          }
        } catch (_) {}
      }
      scores.push(pct); reads.push(read); notes.push(note);
      showProgress("Analyzed frame " + (i + 1) + " of " + total, (i + 1) / total);
    }
    scanStage("weigh");
    const valid = scores.filter((s) => Number.isFinite(s));
    if (!valid.length) {
      return { kind: "error", score: null, verdict: "Screen frames couldn't be scored",
        explain: "None of the " + total + " captured frames produced a model score. No score was invented, and nothing left your device.",
        guidance: "Try again on a screen with more visible content. This failed check did not use a free check.",
        countsTowardLimit: false };
    }
    const frameSignal = frameSignalSummary(frameBandScores(reads, valid));
    const rawSignal = frameSignalSummary(valid);
    const median = rawSignal.median;
    const maxScore = rawSignal.maxScore;
    const perFrame = notes.map((n, i) => "Frame " + (i + 1) + " of " + total + " — " + n).join("\n");
    const screenResult = {
      kind: "video",
      score: frameSignal.score,
      metricLabel: "Median frame-model score",
      verdict: frameSignal.verdict,
      explain: [
        "Screen capture: " + valid.length + " of " + total + " frames sampled across about " +
          SCREEN_CAPTURE_SECONDS + " seconds of the surface you chose, all on your device. Sharing stopped as soon as the capture finished, nothing was recorded to a file, and a screen check counts as one check against the free weekly allowance.",
        perFrame,
        "Region scan: median " + median + "/100, highest sampled frame " + maxScore + "/100.",
        "Screen limits: this still-image model reads sampled frames; it has not been validated as a screen-content or full-video detector. Only " + total +
          " still frames were sampled; motion over time and audio were not analyzed; scaling, compression, and display rendering can hide or mimic artifacts. Nothing left your device.",
      ].join("\n"),
      guidance: "Find the original file or post rather than judging a re-displayed copy on screen. Never make a consequential decision from this sample alone.",
    };
    applyDecision(screenResult, frameDecision(reads.filter(Boolean), null));
    screenResult.pixelBand = frameSignal.medianRaw >= IMAGE_AI_BAND ? "high"
      : frameSignal.medianRaw >= IMAGE_AI_ELEVATED_BAND ? "elevated" : "below";
    screenResult.explain = leanSentence(screenResult) + "\n" + screenResult.explain;
    return screenResult;
  }

  // Screen capture runs its own check: the frames already exist, so it does not
  // go through the file picker. Same gate, same animation, same accounting.
  async function runScreenCheck(frames) {
    if (running) return;
    running = true;
    beginResultRun();
    const btn = $("check-btn");
    if (btn) { btn.disabled = true; btn.textContent = "Checking…"; }
    const card = $("detector-card");
    if (card) card.setAttribute("aria-busy", "true");
    let analyzingSince = 0;
    try {
      const pro = !!(window.Purchases && window.Purchases.isPro());
      if (!pro) {
        const allowance = await quotaAllowsCheck();
        if (allowance !== true) {
          if (allowance === false) showLimitReached();
          else showQuotaUnavailable();
          return;
        }
      }
      analyticsTrack("check_started", "screen");
      setAnalyzing(true, "screen");
      analyzingSince = Date.now();
      await paintGate();
      const out = await analyzeScreenFrames(frames);
      if (!pro && out && out.countsTowardLimit !== false) {
        const granted = await quotaConsumeCheck();
        syncQuotaHint();
        if (granted !== true) {
          setAnalyzing(false);
          if (granted === false) showLimitReached();
          else showQuotaUnavailable();
          return;
        }
      }
      await finishAnalyzing(analyzingSince, "media");
      showResult(out);
      analyticsTrack(out && out.kind === "error" ? "check_failed" : "check_completed", "screen");
    } catch (e) {
      setAnalyzing(false);
      showResult({ kind: "error", score: null, verdict: "Couldn't complete the check",
        explain: "Something went wrong analyzing the captured frames.",
        guidance: "Try again. Failed checks do not use the free allowance.", countsTowardLimit: false });
      analyticsTrack("check_failed", "model_error");
    } finally {
      hideProgress();
      setAnalyzing(false);
      running = false;
      if (btn) btn.disabled = false;
      if (card) card.removeAttribute("aria-busy");
      setCheckButtonLabel();
    }
  }
  /* ================= END ON-DEVICE-ONLY (video + screen scan) ================= */

  function syncCloudConsentControl(){
    const input = $("cloud-consent"), copy = $("cloud-consent-copy");
    if (!input) return;
    const enabled = !!(window.Purchases && window.Purchases.cloudAnalysisAvailable && window.Purchases.cloudAnalysisAvailable());
    input.disabled = !enabled;
    if (!enabled) input.checked = false;
    if (!copy) return;
    if (enabled) {
      copy.textContent = "Also run optional cloud analysis (web Pro; images up to 3 MiB). Your on-device result appears first. Then this image is sent to our API and configured inference provider. GAIC keeps only an AES-GCM-encrypted temporary payload accessible to the job for up to 15 minutes, deletes it promptly on completion or failure, and removes expired records through bounded cleanup; account deletion purges them immediately. QStash sees only an opaque job ID and orchestration metadata. You must opt in separately for every check.";
    } else if (window.Native && window.Native.isNative) {
      copy.textContent = "Cloud model analysis is not available in the iOS or Android release yet. Your image checks stay on-device.";
    } else {
      copy.textContent = "Optional cloud analysis appears only for an active, server-verified GAIC Pro web subscription when its queue, trained model, and spend budget are ready. Until then, image checks stay on-device.";
    }
  }

  function clearCloudConsent(){
    const input = $("cloud-consent");
    if (input) input.checked = false;
  }

  // Resolve with RAW base64 (no "data:...;base64," prefix) so a backend that
  // base64-decodes imageBase64 receives valid bytes.
  function fileToBase64(file){
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => {
        const s = String(r.result || "");
        const comma = s.indexOf(",");
        res(comma >= 0 ? s.slice(comma + 1) : s);
      };
      r.onerror = () => rej(r.error || new Error("read failed"));
      r.readAsDataURL(file);
    });
  }

  // ASCII-decode an arbitrary byte range (non-printable -> space).
  function rangeToAscii(b, start, end){
    let s = "";
    const lo = Math.max(0, start|0);
    const hi = Math.min(b.length, end|0);
    for (let i = lo; i < hi; i++){ const c = b[i]; s += (c >= 32 && c < 127) ? String.fromCharCode(c) : " "; }
    return s;
  }

  // JPEG C2PA data is a JUMBF superbox carried by APP11. This deliberately
  // recognizes only the regular-size first JPEG XT packet that contains a
  // JUMBF description box with the C2PA Manifest Store UUID and `c2pa` label.
  // It reports structural marker presence only; it does not validate the
  // manifest, signature, issuer, claim, or asset binding.
  function isC2paJumbfApp11(b, start, end){
    const C2PA_UUID = [
      0x63, 0x32, 0x70, 0x61, 0x00, 0x11, 0x00, 0x10,
      0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71,
    ];
    const packetBytes = end - start;
    // CI (JP), En, Z, jumb header, and the minimum labelled jumd box.
    if (packetBytes < 46 || !matchAt(b, start, "JP")) return false;
    if (readU32BE(b, start + 4) !== 1) return false; // first packet only

    const superboxStart = start + 8;
    const superboxLength = readU32BE(b, superboxStart);
    if (superboxLength < 38 || !matchAt(b, superboxStart + 4, "jumb")) return false;

    const descriptionStart = superboxStart + 8;
    const descriptionLength = readU32BE(b, descriptionStart);
    if (descriptionLength < 30 || descriptionLength > superboxLength - 8 ||
        descriptionStart + descriptionLength > end ||
        !matchAt(b, descriptionStart + 4, "jumd")) return false;

    const uuidStart = descriptionStart + 8;
    for (let i = 0; i < C2PA_UUID.length; i++) {
      if (b[uuidStart + i] !== C2PA_UUID[i]) return false;
    }
    const toggles = b[uuidStart + 16];
    if ((toggles & 0x03) !== 0x03) return false; // requestable + label present
    return matchAt(b, uuidStart + 17, "c2pa") && b[uuidStart + 21] === 0x00;
  }

  // Structural metadata reader for JPEG, PNG, and WebP. It walks container
  // segments instead of scanning arbitrary pixel bytes. This only detects
  // marker presence; it is not a C2PA signature validator.
  function parseImageMetadata(b){
    const out = { hasExif: false, hasXMP: false, hasC2PA: false, metaText: "", exif: {} };
    if (!b || b.length < 4) return out;
    const EXIF_SIG = "Exif";               // followed by 00 00
    const addMeta = (start, end) => { out.metaText += rangeToAscii(b, start, end) + "\n"; };

    // ----- JPEG -----
    if (b[0] === 0xFF && b[1] === 0xD8) {
      let i = 2;
      while (i + 3 < b.length) {
        if (b[i] !== 0xFF) { i++; continue; }
        let marker = b[i + 1];
        // skip fill bytes
        while (marker === 0xFF && i + 1 < b.length) { i++; marker = b[i + 1]; }
        if (marker === 0xD9) { i += 2; break; }               // EOI
        // Standalone markers (no length): RSTn, SOI, TEM
        if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
        const len = (b[i + 2] << 8) | b[i + 3];               // includes the 2 length bytes
        if (len < 2) break;
        const payloadStart = i + 4;
        const payloadEnd = i + 2 + len;
        if (payloadEnd > b.length) break;
        if (marker === 0xE1) {                                // APP1: EXIF or XMP
          if (matchAt(b, payloadStart, EXIF_SIG) && b[payloadStart+4] === 0x00 && b[payloadStart+5] === 0x00) {
            out.hasExif = true;
            out.exif = parseExifIFD(b, payloadStart + 6); // TIFF header follows "Exif\0\0"
            addMeta(payloadStart, payloadEnd);
          } else if (asciiHas(b, payloadStart, Math.min(payloadEnd, payloadStart + 40), "http://ns.adobe.com/xap")) {
            out.hasXMP = true;
            addMeta(payloadStart, payloadEnd);
          }
        } else if (marker === 0xEB && isC2paJumbfApp11(b, payloadStart, payloadEnd)) {
          out.hasC2PA = true;
        } else if (marker === 0xDA) {                          // SOS: scan data follows; stop segment walk
          i = payloadEnd;
          break;
        }
        i = payloadEnd;
      }
      // Some existing files append an XMP packet after the JPEG EOI. Keep that
      // compatibility path limited to XMP: trailing text is not an APP11 JUMBF
      // structure and therefore cannot establish a C2PA marker.
      if (!out.hasXMP) {
        let trailerStart = -1;
        for (let k = Math.max(0, i); k + 1 < b.length; k++) {
          if (b[k] === 0xFF && b[k + 1] === 0xD9) { trailerStart = k + 2; break; }
        }
        if (trailerStart >= 0 && trailerStart < b.length) {
          const tail = rangeToAscii(b, trailerStart, b.length);
          if (!out.hasXMP && /<x:xmpmeta|xmlns:xmp/i.test(tail)) {
            out.hasXMP = true; out.metaText += tail + "\n";
          }
        }
      }
      return out;
    }

    // ----- PNG -----
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) {
      let i = 8; // skip PNG signature
      while (i + 8 <= b.length) {
        const len = (b[i] << 24 >>> 0) | (b[i+1] << 16) | (b[i+2] << 8) | b[i+3];
        const type = rangeToAscii(b, i + 4, i + 8);
        const dataStart = i + 8;
        const dataEnd = dataStart + len;
        if (len < 0 || dataEnd + 4 > b.length) break;
        if (type === "eXIf") {
          out.hasExif = true;
          out.exif = parseExifIFD(b, dataStart); // PNG eXIf chunk data is the TIFF block
          addMeta(dataStart, dataEnd);
        } else if (type === "iTXt" || type === "tEXt" || type === "zTXt") {
          const text = rangeToAscii(b, dataStart, dataEnd);
          if (/<x:xmpmeta|xmlns:xmp/i.test(text)) out.hasXMP = true;
          addMeta(dataStart, dataEnd);
        } else if (type === "caBX" || type === "jumb") {   // C2PA manifest chunk
          out.hasC2PA = true;
        }
        if (type === "IEND") break;
        i = dataEnd + 4; // skip 4-byte CRC
      }
      return out;
    }

    // ----- WebP (RIFF chunks) -----
    if (b.length >= 20 && matchAt(b, 0, "RIFF") && matchAt(b, 8, "WEBP")) {
      let i = 12;
      while (i + 8 <= b.length) {
        const type = rangeToAscii(b, i, i + 4);
        const len = readU32LE(b, i + 4);
        const dataStart = i + 8;
        const dataEnd = dataStart + len;
        if (dataEnd > b.length) break;
        if (type === "EXIF") {
          const tiff = matchAt(b, dataStart, EXIF_SIG) ? dataStart + 6 : dataStart;
          out.hasExif = true;
          out.exif = parseExifIFD(b, tiff);
          addMeta(dataStart, dataEnd);
        } else if (type === "XMP ") {
          out.hasXMP = true;
          addMeta(dataStart, dataEnd);
        } else if (type === "C2PA") {
          // C2PA specifies an exact RIFF chunk identifier for WebP. Keep the
          // unvalidated manifest bytes out of `metaText`: generator-name clues
          // must come only from editable EXIF/XMP fields, not provenance claims.
          out.hasC2PA = true;
        }
        i = dataEnd + (len % 2); // RIFF chunks are padded to an even length.
      }
      return out;
    }

    // ----- GIF -----
    // C2PA manifests in GIF use a specialized Application Extension named
    // `C2PA_GIF` before the first image descriptor. Walk the GIF block framing
    // instead of substring-searching image data, which could fabricate a marker.
    if (b.length >= 13 && (matchAt(b, 0, "GIF87a") || matchAt(b, 0, "GIF89a"))) {
      const packed = b[10];
      let i = 13;
      if (packed & 0x80) i += 3 * (1 << ((packed & 0x07) + 1));
      while (i < b.length) {
        const introducer = b[i++];
        if (introducer === 0x3B || introducer === 0x2C) break; // trailer or first image
        if (introducer !== 0x21 || i + 1 >= b.length) break;
        const label = b[i++];
        const blockSize = b[i++];
        if (i + blockSize > b.length) break;
        const isC2paExtension = label === 0xFF && blockSize === 0x0B &&
          matchAt(b, i, "C2PA_GIF") &&
          b[i + 8] === 0x01 && b[i + 9] === 0x00 && b[i + 10] === 0x00;
        i += blockSize;
        // Every extension's payload is a sequence of length-prefixed data
        // sub-blocks terminated by a zero byte. Do not report marker presence
        // until the C2PA extension has non-empty, complete data and a terminator.
        let hasNonEmptyData = false;
        let terminated = false;
        let malformed = false;
        while (i < b.length) {
          const size = b[i++];
          if (size === 0) { terminated = true; break; }
          if (i + size > b.length) { malformed = true; i = b.length; break; }
          hasNonEmptyData = true;
          i += size;
        }
        if (isC2paExtension && hasNonEmptyData && terminated && !malformed) {
          out.hasC2PA = true;
        }
      }
      return out;
    }

    // Unknown containers get no metadata inference. Full-buffer text searches
    // can mistake compressed pixel bytes for generator or provenance strings.
    return out;
  }

  // ---- minimal TIFF/EXIF IFD reader: extract real camera tags ----
  function rdU16(b, o, le){ return le ? (b[o] | (b[o+1] << 8)) : ((b[o] << 8) | b[o+1]); }
  function rdU32(b, o, le){ return le ? (b[o] + b[o+1]*256 + b[o+2]*65536 + b[o+3]*16777216)
                                       : (b[o]*16777216 + b[o+1]*65536 + b[o+2]*256 + b[o+3]); }
  // Bytes per TIFF field type, indexed by type code. 0 marks a type this reader
  // does not decode.
  const EXIF_TYPE_BYTES = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
  // A malformed or hostile file can claim an enormous entry count. Cap the walk.
  const EXIF_MAX_ENTRIES = 512;

  // Resolve the byte offset of a field's value. Values of 4 bytes or fewer are
  // stored inline in the entry; anything larger is stored at a TIFF-relative
  // offset. Returns -1 when the value would fall outside the buffer.
  function exifValueOffset(b, t, e, le, type, count){
    const unit = EXIF_TYPE_BYTES[type] || 0;
    if (!unit) return -1;
    const bytes = unit * count;
    if (!Number.isSafeInteger(bytes) || bytes <= 0) return -1;
    const offset = bytes <= 4 ? (e + 8) : (t + rdU32(b, e + 8, le));
    if (offset < 0 || offset + bytes > b.length) return -1;
    return offset;
  }

  function exifAscii(b, t, e, le, type, count){
    if (type !== 2) return "";
    const offset = exifValueOffset(b, t, e, le, type, count);
    if (offset < 0) return "";
    let text = "";
    for (let k = 0; k < count && k < 256; k++){
      const c = b[offset + k];
      if (c === 0) break;
      if (c >= 32 && c < 127) text += String.fromCharCode(c);
    }
    return text.trim();
  }

  // RATIONAL (5) and SRATIONAL (10) are two 32-bit values: numerator then
  // denominator. Also accepts SHORT/LONG so a camera that writes ISO as a plain
  // integer is still read.
  function exifNumber(b, t, e, le, type, count){
    const offset = exifValueOffset(b, t, e, le, type, count);
    if (offset < 0) return null;
    if (type === 5 || type === 10){
      const numerator = rdU32(b, offset, le);
      const denominator = rdU32(b, offset + 4, le);
      if (!denominator) return null;
      const value = numerator / denominator;
      return Number.isFinite(value) ? value : null;
    }
    if (type === 3) return rdU16(b, offset, le);
    if (type === 4) return rdU32(b, offset, le);
    return null;
  }

  // `t` = start of the TIFF header (right after "Exif\0\0" in JPEG, or the eXIf
  // chunk data in PNG).
  //
  // IFD0 alone carries only make/model/software/dateTime. The exposure triplet,
  // lens, original timestamp, GPS block, and maker note live in the Exif SubIFD
  // and the GPS IFD, which are reached through pointer tags. Those extra fields
  // are what let provenance-verdict.mjs grade how well the capture metadata
  // corroborates itself instead of reporting a bare "EXIF present". They remain
  // editable, and the grading says so.
  function parseExifIFD(b, t){
    const out = {};
    if (t + 8 > b.length) return out;
    const le = b[t] === 0x49 && b[t+1] === 0x49;        // II = little-endian, MM = big-endian
    if (!(le || (b[t] === 0x4D && b[t+1] === 0x4D))) return out;
    const ifd0 = t + rdU32(b, t + 4, le);

    const ASCII_TAGS = {
      0x010F: "make", 0x0110: "model", 0x0131: "software",
      0x0132: "dateTime", 0x8298: "copyright",
      0x9003: "dateTimeOriginal", 0xA434: "lensModel",
    };
    const NUMBER_TAGS = {
      0x829A: "exposureTime", 0x829D: "fNumber",
      0x8827: "isoSpeed", 0x920A: "focalLength",
    };

    // Walk IFD0, then whatever SubIFD/GPS pointers it declares. Each offset is
    // visited at most once so a self-referential pointer cannot loop.
    const queue = [ifd0];
    const visited = [];
    while (queue.length){
      const ifd = queue.shift();
      if (ifd < 0 || ifd + 2 > b.length) continue;
      if (visited.indexOf(ifd) !== -1) continue;
      visited.push(ifd);
      if (visited.length > 4) break;

      const entries = Math.min(rdU16(b, ifd, le), EXIF_MAX_ENTRIES);
      for (let i = 0; i < entries; i++){
        const e = ifd + 2 + i * 12;
        if (e + 12 > b.length) break;
        const tag = rdU16(b, e, le);
        const type = rdU16(b, e + 2, le);
        const count = rdU32(b, e + 4, le);
        if (!Number.isSafeInteger(count) || count < 0) continue;

        if (tag === 0x8769 || tag === 0x8825){         // Exif SubIFD / GPS IFD
          const pointer = exifNumber(b, t, e, le, type, count);
          if (pointer !== null && pointer > 0) queue.push(t + pointer);
          if (tag === 0x8825) out.hasGps = true;
          continue;
        }
        if (tag === 0x927C){                            // MakerNote
          if (count > 0) out.hasMakerNote = true;
          continue;
        }
        if (tag === 0x010E && type === 2){              // ImageDescription: a caption
          // Kept exactly as rangeToAscii renders it in metaText, so the tool-name
          // check can leave it out (see withoutCaptions).
          const offset = exifValueOffset(b, t, e, le, type, count);
          if (offset >= 0 && out.captionText === undefined) {
            out.captionText = rangeToAscii(b, offset, offset + Math.min(count, 65536));
          }
          continue;
        }
        if (ASCII_TAGS[tag]){
          const text = exifAscii(b, t, e, le, type, count);
          if (text && out[ASCII_TAGS[tag]] === undefined) out[ASCII_TAGS[tag]] = text;
          continue;
        }
        if (NUMBER_TAGS[tag]){
          const value = exifNumber(b, t, e, le, type, count);
          // Reject non-positive values: a zero exposure or f-number is a parse
          // artefact, not a camera reading.
          if (value !== null && value > 0 && out[NUMBER_TAGS[tag]] === undefined) {
            out[NUMBER_TAGS[tag]] = value;
          }
        }
      }
    }
    return out;
  }

  // True if the ASCII bytes at `start` equal `sig`.
  function matchAt(b, start, sig){
    if (start + sig.length > b.length) return false;
    for (let k = 0; k < sig.length; k++){ if (b[start + k] !== sig.charCodeAt(k)) return false; }
    return true;
  }
  // True if the ASCII substring `needle` occurs within b[start,end).
  function asciiHas(b, start, end, needle){
    return rangeToAscii(b, start, end).toLowerCase().includes(needle.toLowerCase());
  }

  // ---------- weekly rate limit: 3 free checks / week (matches UI hint) ----------
  // One unified allowance: EVERY successful check — text, image, video, or
  // screen frame — consumes one of the 3 weekly free checks. Failed or
  // rejected checks never consume one (countsTowardLimit:false). The counter
  // resets at the start of the next UTC week (Monday), matching the
  // account-scoped server authority. Pro/Unlimited subscribers bypass the
  // allowance entirely.
  const WEEKLY_LIMIT = 3;
  const LIMIT_KEY = "aicheck.usage";
  const ACCOUNT_LIMIT_KEY = "aicheck.usage.account.v1";
  const ACCOUNT_ID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  function weekKey(nowMs = Date.now()){
    // UTC Monday-start week, keyed by that Monday's date. Stored usage from
    // the retired daily scheme has no `week` field and reads as zero once.
    const d = new Date(nowMs);
    const monday = new Date(Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate() - ((d.getUTCDay() + 6) % 7)
    ));
    return [
      monday.getUTCFullYear(),
      String(monday.getUTCMonth() + 1).padStart(2, "0"),
      String(monday.getUTCDate()).padStart(2, "0")
    ].join("-");
  }
  function isoWeekKey(nowMs = Date.now()){
    const d = new Date(nowMs);
    const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dayNumber = (day.getUTCDay() + 6) % 7;
    day.setUTCDate(day.getUTCDate() - dayNumber + 3);
    const isoYear = day.getUTCFullYear();
    const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
    const firstDayNumber = (firstThursday.getUTCDay() + 6) % 7;
    firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNumber + 3);
    const week =
      1 + Math.round((day.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
    return isoYear + "-W" + String(week).padStart(2, "0");
  }
  function weekResetAtMs(nowMs = Date.now()){
    const d = new Date(nowMs);
    const dayNumber = (d.getUTCDay() + 6) % 7;
    return Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate() - dayNumber + 7
    );
  }
  function usageStorageKey(){
    return usageOwner ? ACCOUNT_LIMIT_KEY : LIMIT_KEY;
  }
  function readUsageRecord(raw, expectedOwner = usageOwner){
    try {
      const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
      const ownerMatches = expectedOwner
        ? obj && obj.owner === expectedOwner
        : obj && (obj.owner === undefined || obj.owner === "" ||
          obj.owner === "guest");
      if (
        ownerMatches &&
        obj.week === weekKey() &&
        Number.isSafeInteger(obj.count)
      ) {
        return Math.max(0, Math.floor(obj.count));
      }
    } catch (e) { /* unreadable record — treat as no usage */ }
    return 0;
  }
  function getUsage(){
    // The highest count any local store reports wins, so clearing one of them
    // does not hand back a free check. `mirroredUsage` is refreshed from the
    // IndexedDB mirror (and, for signed-in users, from the server) as soon as
    // those async reads resolve.
    resetMirroredUsageForCurrentWeek();
    let count = mirroredUsage;
    try {
      if (global.localStorage) {
        count = Math.max(
          count,
          readUsageRecord(localStorage.getItem(usageStorageKey()))
        );
      }
    } catch (e) { /* storage unavailable — fall back to the mirror */ }
    return count;
  }
  function bumpUsage(){
    const next = getUsage() + 1;
    setUsage(next);
  }
  function setUsage(next, expectedWeek = "", exact = false){
    const currentWeek = resetMirroredUsageForCurrentWeek();
    if (expectedWeek && currentWeek !== expectedWeek) return false;
    if (!Number.isSafeInteger(next) || next < 0) return false;
    const value = {
      week: currentWeek,
      count: next,
      ...(usageOwner ? { owner: usageOwner } : { owner: "guest" })
    };
    mirroredUsage = exact ? value.count : Math.max(mirroredUsage, value.count);
    const key = usageStorageKey();
    try {
      if (global.localStorage) localStorage.setItem(key, JSON.stringify(value));
    } catch (e) { /* storage unavailable — silently skip persistence */ }
    idbWriteUsage(value, key, exact);
    return true;
  }

  // ---------- durable local mirror (IndexedDB) ----------
  // A second on-device store so the free allowance is not reset by clearing
  // localStorage alone. This raises the bar for casual resets; it is NOT a
  // security boundary — a full app-data wipe or reinstall still clears local
  // state, which is exactly why a signed-in user is metered against their
  // account on the server instead (see accountQuota below).
  let mirroredUsage = 0;
  let mirroredUsageWeek = weekKey();
  let usageOwner = "";
  let usageScopeEpoch = 0;
  function switchUsageOwner(owner){
    const normalized = ACCOUNT_ID_RE.test(String(owner || ""))
      ? String(owner).toLowerCase()
      : "";
    if (normalized === usageOwner) return usageScopeEpoch;
    usageOwner = normalized;
    mirroredUsage = 0;
    mirroredUsageWeek = weekKey();
    usageScopeEpoch += 1;
    accountScopeActive = !!usageOwner;
    quotaAuthorityUnavailable = false;
    return usageScopeEpoch;
  }
  function resetMirroredUsageForCurrentWeek(){
    const currentWeek = weekKey();
    if (mirroredUsageWeek !== currentWeek) {
      mirroredUsageWeek = currentWeek;
      mirroredUsage = 0;
    }
    return currentWeek;
  }
  function currentQuotaResponseWeek(data, nowMs = Date.now()){
    // A request can start before the Monday boundary and finish after it. Only
    // reconcile a response whose ISO week and reset instant both describe the
    // client's current UTC week; an old response must not poison the new local
    // mirror.
    const resetAtMs = data && data.resetAtMs;
    if (
      !data ||
      data.week !== isoWeekKey(nowMs) ||
      !Number.isSafeInteger(resetAtMs) ||
      resetAtMs !== weekResetAtMs(nowMs)
    ) {
      return "";
    }
    return weekKey(nowMs);
  }
  function reconcileUsageForWeek(used, expectedWeek, exact = false){
    if (!Number.isSafeInteger(used) || used < 0 || used > WEEKLY_LIMIT) return;
    // Re-check synchronously at the write boundary in case the clock crossed
    // Monday after the response was validated.
    if (!expectedWeek || resetMirroredUsageForCurrentWeek() !== expectedWeek) return;
    if (exact || used > getUsage()) setUsage(used, expectedWeek, exact);
  }
  const IDB_NAME = "aicheck-usage";
  const IDB_STORE = "usage";
  function idbOpen(){
    return new Promise((resolve) => {
      try {
        if (!global.indexedDB) return resolve(null);
        const request = indexedDB.open(IDB_NAME, 1);
        request.onupgradeneeded = () => {
          try { request.result.createObjectStore(IDB_STORE); } catch (e) {}
        };
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => resolve(null);
        setTimeout(() => resolve(null), 2000); // never block a check on storage
      } catch (e) { resolve(null); }
    });
  }
  async function idbReadUsage(key = usageStorageKey(), owner = usageOwner){
    const db = await idbOpen();
    if (!db) return 0;
    return new Promise((resolve) => {
      const finish = (value) => {
        try { db.close(); } catch (e) {}
        resolve(value);
      };
      try {
        const tx = db.transaction(IDB_STORE, "readonly");
        const req = tx.objectStore(IDB_STORE).get(key);
        req.onsuccess = () => finish(readUsageRecord(req.result, owner));
        req.onerror = () => finish(0);
      } catch (e) { finish(0); }
    });
  }
  /* Within a week the mirror only moves up. An unconditional put would let a
     stale low count overwrite a higher stored one — a caller that reads the
     count before hydrateUsage()'s async read resolves would write 1 over a
     durable 3 and hand back two checks. The read happens inside the same
     readwrite transaction, so the comparison is atomic against a concurrent
     write.

     `exact` is the deliberate downgrade path: a new-week reset and
     server-authoritative reconciliation must both be able to lower the count,
     so they bypass the clamp. Only the incrementing path is clamped. */
  async function idbWriteUsage(value, key = usageStorageKey(), exact = false){
    const db = await idbOpen();
    if (!db) return;
    try {
      const tx = db.transaction(IDB_STORE, "readwrite");
      const store = tx.objectStore(IDB_STORE);
      if (exact) {
        store.put(value, key);
      } else {
        const existing = store.get(key);
        existing.onsuccess = () => {
          // Keep the stored record whenever it already counts at least as many
          // checks for this week; never write back a bare count.
          const keepStored =
            readUsageRecord(existing.result) >= readUsageRecord(value);
          try {
            if (!keepStored) store.put(value, key);
          } catch (e) { /* mirror is best effort */ }
        };
        existing.onerror = () => { try { store.put(value, key); } catch (e) {} };
      }
      const close = () => { try { db.close(); } catch (e) {} };
      tx.oncomplete = close;
      tx.onerror = close;
      tx.onabort = close;
    } catch (e) { /* mirror is best effort */ }
  }

  // ---------- account-scoped server enforcement ----------
  // For a SIGNED-IN user the server owns the count, so reinstalling the app or
  // clearing browser data does not restore free checks. The request carries no
  // submitted content — only the account's bearer token and "peek"/"consume".
  // Confirmed guests use the local counter above. Once an account token exists,
  // server authority is mandatory: an outage, invalid session, rate limit, or
  // malformed response withholds the check instead of minting device-local
  // allowance that could exceed 3/week across installs.
  const QUOTA_ENDPOINT = "/api/aicheck/quota";
  const ACCOUNT_SESSION_TIMEOUT_MS = 6_000;
  let accountScopeActive = false;
  let quotaAuthorityUnavailable = false;
  function quotaApiBase(){
    return String(
      global.AICHECK_QUOTA_API || global.AICHECK_API || ""
    ).replace(/\/+$/, "");
  }
  async function accountContext(){
    try {
      if (
        !global.AICheckAccount ||
        typeof global.AICheckAccount.sessionState !== "function"
      ) {
        return { kind: "unavailable", token: "", owner: "" };
      }
      const state = await new Promise((resolve) => {
        let settled = false;
        let timer = 0;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolve(value);
        };
        timer = setTimeout(
          () => finish(null),
          ACCOUNT_SESSION_TIMEOUT_MS
        );
        if (settled && timer) clearTimeout(timer);
        Promise.resolve()
          .then(() => global.AICheckAccount.sessionState())
          .then(finish, () => finish(null));
      });
      if (
        !state ||
        (state.status !== "account" &&
          state.status !== "signed-out" &&
          state.status !== "unavailable")
      ) {
        return { kind: "unavailable", token: "", owner: "" };
      }
      if (state.status === "signed-out") {
        return { kind: "guest", token: "", owner: "" };
      }
      if (state.status !== "account") {
        return { kind: "unavailable", token: "", owner: "" };
      }
      const s = state.session;
      const token = String((s && s.access_token) || "");
      if (!token) return { kind: "unavailable", token: "", owner: "" };
      const owner = String(s && s.user && s.user.id || "").toLowerCase();
      if (!ACCOUNT_ID_RE.test(owner)) {
        return { kind: "unavailable", token: "", owner: "" };
      }
      return { kind: "account", token, owner };
    } catch (e) {
      return { kind: "unavailable", token: "", owner: "" };
    }
  }
  // ---------- detached optional cloud enrichment ----------
  // A cloud job is never part of the local check's critical path. These
  // monotonic IDs and abort handles prevent an old job, old account, or hidden
  // page from patching a newer visible result.
  let resultRunSequence = 0;
  let activeCloudTask = null;
  function cancelActiveCloudAnalysis(){
    const task = activeCloudTask;
    activeCloudTask = null;
    if (task && task.controller) {
      try { task.controller.abort(); } catch (_) {}
    }
  }
  function invalidateCloudAnalysis(){
    cancelActiveCloudAnalysis();
    resultRunSequence =
      resultRunSequence >= Number.MAX_SAFE_INTEGER
        ? 1
        : resultRunSequence + 1;
  }
  function beginResultRun(){
    invalidateCloudAnalysis();
    return resultRunSequence;
  }
  function entitlementTokenOwner(token){
    try {
      let encoded = String(token || "").split(".")[0]
        .replace(/-/g, "+")
        .replace(/_/g, "/");
      encoded += "=".repeat((4 - encoded.length % 4) % 4);
      const payload = JSON.parse(atob(encoded));
      const owner = String(payload && payload.u || "").toLowerCase();
      return ACCOUNT_ID_RE.test(owner) ? owner : "";
    } catch (_) {
      return "";
    }
  }
  function cloudPlanForImage(file){
    const consent = $("cloud-consent");
    const requested = !!(consent && consent.checked);
    const purchases = window.Purchases;
    const available = !!(
      purchases &&
      purchases.cloudAnalysisAvailable &&
      purchases.cloudAnalysisAvailable()
    );
    const announcedCap = purchases && purchases.cloudMaxImageBytes
      ? purchases.cloudMaxImageBytes()
      : 0;
    const exactCap = announcedCap === CLOUD_MAX_IMAGE_BYTES;
    if (!requested) {
      return {
        requested: false,
        eligible: false,
        available: available && exactCap,
        file
      };
    }
    if (
      !available ||
      !exactCap ||
      !window.AICHECK_API ||
      !purchases.cloudAccessToken
    ) {
      return {
        requested: true,
        eligible: false,
        reason: "unavailable",
        file
      };
    }
    if (
      !file ||
      !Number.isSafeInteger(file.size) ||
      file.size < 1 ||
      file.size > CLOUD_MAX_IMAGE_BYTES
    ) {
      return {
        requested: true,
        eligible: false,
        reason: "size",
        file
      };
    }
    const paymentToken = purchases.cloudAccessToken();
    return {
      requested: true,
      eligible: !!paymentToken,
      reason: paymentToken ? "" : "unavailable",
      paymentToken,
      file
    };
  }
  function addCloudPlanStatus(result, plan){
    if (!result || result.kind !== "image" || !plan) return result;
    plan.baseExplain = result.explain || "";
    let status = "";
    if (plan.eligible) {
      status = "Optional cloud analysis: starting in the background now that the on-device result is complete. This separately consented web upload will not delay or replace the local result.";
    } else if (plan.requested && plan.reason === "size") {
      status = "Optional cloud analysis was not queued: web cloud uploads are limited to 3 MiB. This file was checked on-device only; choose a smaller or compressed copy if you want the separate cloud signal.";
    } else if (plan.requested) {
      status = "Optional cloud analysis was not available for this check, so the image stayed on-device.";
    } else if (plan.available) {
      status = "Everything above was read on-device. Tick “Also run cloud analysis” before a future check to request the optional web-Pro second signal.";
    }
    if (status) {
      result.explain = (result.explain ? result.explain + "\n" : "") + status;
    }
    return result;
  }
  function cloudTaskIsCurrent(task){
    return !!(
      task &&
      activeCloudTask === task &&
      !task.controller.signal.aborted &&
      resultRunSequence === task.runId &&
      lastResult === task.result
    );
  }
  function patchCurrentCloudStatus(task, text){
    if (!cloudTaskIsCurrent(task)) return false;
    task.result.explain = task.localExplain + "\n" + text;
    const explain = $("explain");
    if (explain) explain.textContent = task.result.explain;
    announce(text, false);
    return true;
  }
  async function startOptionalCloudAnalysis(plan, result, runId){
    if (!plan || !plan.eligible || !result || result.kind !== "image") {
      return false;
    }
    if (runId !== resultRunSequence || lastResult !== result) {
      return false;
    }
    const controller = new AbortController();
    const task = {
      controller,
      localExplain: plan.baseExplain || result.explain,
      owner: "",
      result,
      runId
    };
    activeCloudTask = task;
    try {
      const context = await accountContext();
      if (!cloudTaskIsCurrent(task)) return false;
      if (
        context.kind !== "account" ||
        !context.token ||
        !context.owner ||
        entitlementTokenOwner(plan.paymentToken) !== context.owner
      ) {
        patchCurrentCloudStatus(
          task,
          "Optional cloud analysis could not verify the owning Pro account, so the image stayed on-device and the local result is unchanged."
        );
        return false;
      }
      task.owner = context.owner;
      const imageBase64 = await fileToBase64(plan.file);
      if (!cloudTaskIsCurrent(task)) return false;

      // Re-check both account and entitlement after the file read. A sign-out
      // or cross-tab account switch must stop before any image bytes leave the
      // browser, even if its corresponding event was delayed.
      const current = await accountContext();
      const currentPaymentToken =
        window.Purchases &&
        window.Purchases.cloudAccessToken
          ? window.Purchases.cloudAccessToken()
          : "";
      if (
        !cloudTaskIsCurrent(task) ||
        current.kind !== "account" ||
        current.owner !== task.owner ||
        currentPaymentToken !== plan.paymentToken
      ) {
        cancelActiveCloudAnalysis();
        return false;
      }

      const cloud = await cloudAnalysisRequest(
        window.AICHECK_API + "/api/aicheck/analyze",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + current.token,
            "X-Payment-Token": plan.paymentToken
          },
          cache: "no-store",
          credentials: "omit",
          signal: controller.signal,
          body: JSON.stringify({ imageBase64 })
        },
        {
          onQueued(){
            patchCurrentCloudStatus(
              task,
              "Optional cloud analysis: queued in the background. The on-device result above is already complete and remains usable while the owner-scoped status is checked."
            );
          }
        }
      );
      if (!cloudTaskIsCurrent(task)) return false;
      const finalContext = await accountContext();
      if (
        !cloudTaskIsCurrent(task) ||
        finalContext.kind !== "account" ||
        finalContext.owner !== task.owner
      ) {
        cancelActiveCloudAnalysis();
        return false;
      }
      const response = cloud && cloud.response;
      const body = cloud && cloud.body || {};
      if (
        response &&
        response.ok &&
        body.method === "huggingface" &&
        Number.isFinite(body.aiLikelihood)
      ) {
        const cloudScore = Math.round(
          Math.max(0, Math.min(100, body.aiLikelihood * 100))
        );
        const model = body.model
          ? " · " + String(body.model).slice(0, 120)
          : "";
        const caveat = body.caveat
          ? " " + String(body.caveat).slice(0, 400)
          : "";
        patchCurrentCloudStatus(
          task,
          "Optional cloud model" + model + ": " + cloudScore +
          "/100 signal from the separately consented web upload. This is a second model output, not proof, and it did not replace the on-device score." +
          caveat
        );
        return true;
      }
      if (
        response &&
        response.ok &&
        body.method === "metadata"
      ) {
        patchCurrentCloudStatus(
          task,
          "Optional cloud processing returned metadata context rather than a trained detector result, so it did not change the on-device model score."
        );
        return true;
      }
      patchCurrentCloudStatus(
        task,
        "Optional cloud analysis could not complete. The on-device result is unchanged."
      );
      return false;
    } catch (_) {
      if (cloudTaskIsCurrent(task)) {
        patchCurrentCloudStatus(
          task,
          "Optional cloud analysis is unavailable or still running. The on-device result is complete and unchanged."
        );
      }
      return false;
    } finally {
      if (activeCloudTask === task) activeCloudTask = null;
    }
  }
  function scheduleOptionalCloudAnalysis(plan, result, runId){
    // A microtask begins only after run() reaches its finally block, releasing
    // the check button and aria-busy state. The local result never waits for
    // account lookup, base64 encoding, queue submission, or polling.
    Promise.resolve().then(() => {
      if (runId === resultRunSequence && lastResult === result) {
        void startOptionalCloudAnalysis(plan, result, runId);
        return;
      }
      if (lastResult === result) {
        result.explain = (plan.baseExplain || result.explain) +
          "\nOptional cloud analysis was canceled because the signed-in account or visible check changed. The image stayed on-device and the local result is unchanged.";
        const explain = $("explain");
        if (explain) explain.textContent = result.explain;
      }
    });
  }
  async function accountQuota(action, context, expectedEpoch){
    const base = quotaApiBase();
    if (
      !base ||
      !context ||
      context.kind !== "account" ||
      !context.token
    ) {
      quotaAuthorityUnavailable = true;
      return null;
    }
    let timer = 0;
    const requestNowMs = Date.now();
    try {
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      timer = controller ? setTimeout(() => controller.abort(), 6000) : 0;
      const response = await fetch(base + QUOTA_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + context.token
        },
        body: JSON.stringify({ action: action === "consume" ? "consume" : "peek" }),
        cache: "no-store",
        credentials: "omit",
        signal: controller ? controller.signal : undefined,
      });
      if (!response.ok) return null;
      const data = await response.json();
      const responseWeek = currentQuotaResponseWeek(data, requestNowMs);
      const allowanceCoherent = action === "consume"
        ? (
            data &&
            typeof data.allowed === "boolean" &&
            (data.allowed
              ? Number.isSafeInteger(data.used) && data.used >= 1
              : data.used === WEEKLY_LIMIT)
          )
        : (
            data &&
            typeof data.allowed === "boolean" &&
            data.allowed === (data.used < WEEKLY_LIMIT)
          );
      if (
        !data ||
        data.ok !== true ||
        data.scope !== "account" ||
        data.limit !== WEEKLY_LIMIT ||
        !Number.isSafeInteger(data.used) ||
        data.used < 0 ||
        data.used > WEEKLY_LIMIT ||
        !Number.isSafeInteger(data.remaining) ||
        data.remaining !== WEEKLY_LIMIT - data.used ||
        !allowanceCoherent ||
        !responseWeek ||
        usageOwner !== context.owner ||
        usageScopeEpoch !== expectedEpoch
      ) return null;
      accountScopeActive = true;
      quotaAuthorityUnavailable = false;
      // Keep the local stores at least as high as the account truth so a later
      // render can show it. Account authority is exact (not max-merged with a
      // previous account); the server's `used` already includes the check.
      reconcileUsageForWeek(data.used, responseWeek, true);
      return data;
    } catch (e) {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
      if (
        context &&
        usageOwner === context.owner &&
        usageScopeEpoch === expectedEpoch
      ) {
        // A successful response cleared this above. Every other exit is an
        // authority failure, including 401/429/5xx and malformed JSON.
        if (!accountScopeActive || quotaAuthorityUnavailable) {
          quotaAuthorityUnavailable = true;
        }
      }
    }
  }

  // Gate a check before it runs. Guests read the durable on-device counter.
  // Signed-in users await an authoritative account peek, which both prevents
  // account A's local mirror from blocking account B and fails closed when the
  // cross-device allowance cannot be verified.
  async function quotaAllowsCheck(){
    const context = await accountContext();
    if (context.kind === "unavailable") {
      quotaAuthorityUnavailable = true;
      return null;
    }
    const epoch = switchUsageOwner(
      context.kind === "account" ? context.owner : ""
    );
    if (context.kind === "guest") {
      accountScopeActive = false;
      quotaAuthorityUnavailable = false;
      return getUsage() < WEEKLY_LIMIT;
    }
    accountScopeActive = true;
    quotaAuthorityUnavailable = true;
    const server = await accountQuota("peek", context, epoch);
    return server ? server.allowed === true : null;
  }
  // Consume exactly one check. Returns false when the server says exhausted,
  // and null when signed-in authority is unavailable. Both withhold the result,
  // so a race or provider outage cannot exceed the weekly ceiling.
  async function quotaConsumeCheck(){
    const context = await accountContext();
    if (context.kind === "unavailable") {
      quotaAuthorityUnavailable = true;
      return null;
    }
    const epoch = switchUsageOwner(
      context.kind === "account" ? context.owner : ""
    );
    if (context.kind === "guest") {
      accountScopeActive = false;
      quotaAuthorityUnavailable = false;
      if (getUsage() >= WEEKLY_LIMIT) return false;
      bumpUsage();
      return true;
    }
    accountScopeActive = true;
    quotaAuthorityUnavailable = true;
    const server = await accountQuota("consume", context, epoch);
    return server ? server.allowed === true : null;
  }

  // Hydrate both async sources at startup so the very first check is gated by
  // the true count, not just whatever localStorage happens to hold.
  async function hydrateUsage(){
    const context = await accountContext();
    if (context.kind === "unavailable") {
      quotaAuthorityUnavailable = true;
      syncQuotaHint();
      return;
    }
    const epoch = switchUsageOwner(
      context.kind === "account" ? context.owner : ""
    );
    if (context.kind === "guest") {
      accountScopeActive = false;
      quotaAuthorityUnavailable = false;
      try {
        const key = usageStorageKey();
        const mirrored = await idbReadUsage(key, "");
        if (epoch !== usageScopeEpoch || usageOwner) return;
      // The webview can remain alive across Monday while this asynchronous
      // read is in flight. Never let an earlier week's in-memory count win
      // after the UTC week changes.
        resetMirroredUsageForCurrentWeek();
        if (mirrored > mirroredUsage) mirroredUsage = mirrored;
        // Write back so a cleared localStorage is immediately repaired.
        if (mirrored > 0) setUsage(getUsage());
      } catch (e) {}
      syncQuotaHint();
      return;
    }
    accountScopeActive = true;
    quotaAuthorityUnavailable = true;
    await accountQuota("peek", context, epoch);
    if (epoch === usageScopeEpoch && usageOwner === context.owner) {
      syncQuotaHint();
    }
  }

  // The one place the exhausted-allowance outcome is produced, so every path
  // (pre-check gate and post-check server refusal) blocks identically and
  // surfaces the upgrade paywall rather than another free check.
  function showLimitReached(){
    const subscriptionCopy = newSubscriptionAvailable()
      ? " Go Pro for unlimited checks."
      : " New web subscriptions are not available right now; your free allowance resets next week.";
    const scopeCopy = accountScopeActive
      ? " This allowance follows your GAIC account."
      : "";
    showResult({ kind: "error", score: null, verdict: "Weekly limit reached",
      // Scoped to this checker on purpose. The public quick-photo page has its
      // own separate one-per-day allowance, so an unqualified "every check
      // counts as one" would not be true of the site as a whole.
      explain: "You've used your " + WEEKLY_LIMIT + " free checks for this week — every text, image, video, or screen check in this checker counts as one." + subscriptionCopy + scopeCopy,
      guidance: "Your free allowance resets at the start of the next week.", countsTowardLimit: false });
    syncQuotaHint();
    if (window.Purchases) window.Purchases.showPaywall("limit"); // surface the subscription
  }
  function showQuotaUnavailable(){
    showResult({
      kind: "error",
      score: null,
      verdict: "Free-check status unavailable",
      explain:
        "GAIC couldn’t verify this signed-in account’s weekly allowance, so the result was withheld. No extra device-local allowance was granted.",
      guidance:
        "Reconnect and try again to refresh the account’s 3-check weekly allowance.",
      countsTowardLimit: false
    });
    syncQuotaHint();
  }

  function newSubscriptionAvailable(){
    if (window.Native && window.Native.isNative) return true;
    return !!(window.Purchases && window.Purchases.newSubscriptionAvailable &&
      window.Purchases.newSubscriptionAvailable());
  }

  function syncQuotaHint(){
    const q = $("quota-hint");
    if (!q) return;
    const pro = !!(window.Purchases && window.Purchases.isPro && window.Purchases.isPro());
    q.replaceChildren();
    if (pro) {
      const strong = document.createElement("strong");
      strong.textContent = "GAIC Pro";
      q.append(document.createTextNode("✨ "), strong,
        document.createTextNode(window.Native && window.Native.isNative
          ? " · unlimited on-device checks"
          : " · unlimited checks"));
      return;
    }
    if (accountScopeActive && quotaAuthorityUnavailable) {
      q.append(document.createTextNode(
        "Usage: signed-in allowance temporarily unavailable · try again shortly"
      ));
      return;
    }
    const remaining = Math.max(0, WEEKLY_LIMIT - getUsage());
    q.append(document.createTextNode(
      "Usage: " + remaining + " of " + WEEKLY_LIMIT + " free checks left this week · "
    ));
    const link = document.createElement("a");
    link.href = "#";
    link.className = "quota-upgrade";
    link.textContent = newSubscriptionAvailable() ? "Go Pro for unlimited" : "Plans & billing";
    link.addEventListener("click", (event) => {
      event.preventDefault();
      if (window.Purchases && window.Purchases.showPaywall) window.Purchases.showPaywall();
    });
    q.appendChild(link);
  }

  // ---------- friendly result voice ----------
  // A display-only layer. Completed checks headline their decisive lean (see
  // leanHeadline); this map rephrases the evidence read shown as the technical
  // line, status notes, and errors in a warmer voice. Nothing here adds a
  // certainty claim the underlying result does not make.
  const FRIENDLY_VERDICTS = {
    // image
    "Model signal below warning bands": "The pixel scan stayed below GAIC's AI warning bands",
    "Elevated AI-model signal — verify": "AI warning signs detected — check the original source",
    "High AI-model signal — verify": "Strong AI warning detected — check the original source",
    "No origin record or metadata clue found": "No creation record or metadata clue was found",
    "Screenshot scan below warning bands": "The screenshot scan stayed below GAIC's AI warning bands",
    "Generator-site source supplied — verify output": "The source is an AI-generation site — verify the exact output",
    "Validated AI-origin claim — verify context": "A signed creation record says this was AI-made — check the context",
    "AI tool named in metadata — verify": "The file history names an AI tool — verify how it was used",
    "Content Credential failed validation": "The signed creation record did not pass validation",
    "Trusted Content Credential found — not truth proof": "A trusted signed creation record was found — it confirms history, not truth",
    "Valid Content Credential — signer trust not established": "The creation record is valid, but the signer could not be trusted",
    "Content Credential check did not complete": "The signed creation record could not be checked this time",
    "Content Credential check not supported for this format": "This format can't carry a creation record GAIC can check",
    "Provenance data found — not validated": "Creation-history data was found, but it could not be validated",
    "Camera metadata found — not proof": "Camera details were found in the file — useful context, not proof",
    // Provenance-first tiers. Each names the evidence found and stops there:
    // none of them claims an image is real, and none turns a structural match
    // into an AI accusation.
    "Corroborating camera metadata — not proof": "Several camera details agree with each other — supporting context, not proof",
    "Camera metadata and write structure agree — not proof": "Camera details and how the file was saved both point the same way — still not proof",
    "Metadata declares AI origin — unsigned": "The file's own labels say it was AI-made, but nothing signed that claim",
    "Metadata labels this as possibly AI-generated — unsigned": "The file's own labels say it may be AI-made, but nothing signed that claim",
    "Edit history records a generative step": "The file's edit history mentions an AI editing step — check what it changed",
    "File structure matches a generator write path": "How this file was saved matches a known AI-tool save path — this is about the file, not the picture",
    "Container was rewritten — origin unrecoverable": "This file was re-saved along the way, so its original creation details are gone",
    "Converted copy checked — original container not evaluated": "GAIC checked a converted copy, so the original file's records weren't read",
    "Cloud model signal returned — verify": "The optional cloud scan returned a warning signal — check the original source",
    // text
    "Few formulaic patterns matched": "Few common AI-style writing patterns were found",
    "Mixed writing patterns": "Some common AI-style writing patterns were found",
    "Several formulaic patterns matched": "Several common AI-style writing patterns were found — review the text closely",
    // video
    "High model signal in sampled frames — verify": "Strong AI warning signs were found in sampled frames — check the source",
    "Elevated model signal in sampled frames — verify": "AI warning signs were found in sampled frames — check the source",
    "Sampled frames below warning bands": "The sampled frames stayed below GAIC's AI warning bands",
    // gentle status notes
    "Weekly limit reached": "Your 3 free checks have been used for this week",
    "Free-check status unavailable": "Your free-check status could not be confirmed — try again",
    "No image or video selected": "Choose an image or video to scan",
    "Couldn't complete the check": "The scan could not be completed — try again",
    "Sample too short for a score": "Add more text — GAIC needs at least 1,000 characters",
    "Need several complete sentences": "Add a few complete sentences so GAIC can read the writing",
    "English prose required": "GAIC's text check reads English prose only",
  };
  function friendlyVerdict(verdict) {
    return FRIENDLY_VERDICTS[verdict] || null;
  }

  function updateUpsell() {
    const box = $("result-upsell");
    if (!box) return;
    const res = $("result");
    const pro = !!(window.Purchases && window.Purchases.isPro && window.Purchases.isPro());
    const visible = !!(res && res.classList.contains("show")) && !pro;
    box.hidden = !visible;
    if (!visible) return;
    const copy = $("result-upsell-copy"), btn = $("result-upsell-btn");
    const native = !!(window.Native && window.Native.isNative);
    const cloudReady = !!(
      window.Purchases &&
      window.Purchases.cloudAnalysisAvailable &&
      window.Purchases.cloudAnalysisAvailable()
    );
    if (copy) copy.textContent = native
      ? "Upgrade to GAIC Pro for unlimited private checks. Every native scan stays on-device."
      : cloudReady
        ? "Upgrade to GAIC Pro for unlimited checks and Advanced Scan — a second cloud AI check for images you choose."
        : "Upgrade to GAIC Pro for unlimited photo, video-frame, screenshot, and text checks.";
    if (btn) btn.textContent = newSubscriptionAvailable() ? "Go Pro" : "Plans & billing";
  }

  function resultMetric(out) {
    if (out.lean && out.score != null) {
      return "AI likelihood: " + out.score + "% · " + out.confidence + " confidence";
    }
    return out.score == null ? "Not scored" :
      (out.metricLabel || "Model signal") + ": " + out.score + "/100";
  }

  function primaryResultMetric(out) {
    if (out.lean && out.score != null) return "AI likelihood: " + out.score + "%";
    if (out.score == null) return "Not scored";
    if (out.kind === "text") return "Pattern signal: " + out.score + "/100";
    if (out.kind === "image" || out.kind === "video") {
      return "Warning signal: " + out.score + "/100";
    }
    return "Scan signal: " + out.score + "/100";
  }

  function plainResultCopy(out) {
    const lead = out.lean ? leanSentence(out) : "";
    const detail = evidenceCopy(out);
    return lead ? (detail ? lead + " " + detail : lead) : detail;
  }

  // What the evidence behind a result shows, keyed on the evidence read.
  function evidenceCopy(out) {
    const verdict = String(out.technicalVerdict || out.verdict || "");
    const strongPixels = out.pixelBand === "high";
    const elevatedPixels = out.pixelBand === "high" || out.pixelBand === "elevated";
    if (verdict === "Validated AI-origin claim — verify context") {
      return "GAIC found a signed origin label saying this file was AI-generated." +
        (strongPixels
          ? " The pixel scan also found strong AI warning signs."
          : elevatedPixels
            ? " The pixel scan also found AI warning signs."
            : out.pixelBand === "below"
              ? " GAIC checked the pixels separately."
              : " The pixels were not scanned for this result.");
    }
    if (verdict === "Generator-site source supplied — verify output") {
      return "The source you entered is a site with AI-generation tools. Confirm that this exact image came from that page.";
    }
    if (verdict === "AI tool named in metadata — verify") {
      return "The file history names an AI tool. That is useful context, but it does not explain exactly how the tool was used.";
    }
    if (verdict === "Trusted Content Credential found — not truth proof") {
      return "GAIC verified a signed creation record. It confirms recorded history, not whether the scene or claim is true.";
    }
    if (verdict === "Valid Content Credential — signer trust not established") {
      return "The signed creation record is valid, but GAIC could not confirm that its signer is trusted.";
    }
    if (verdict === "Content Credential failed validation") {
      return "The signed creation record did not pass validation. Do not rely on its claims.";
    }
    if (verdict === "Content Credential check did not complete") {
      return "GAIC could not finish checking the signed creation record, so this result rests on the other evidence.";
    }
    if (verdict === "Content Credential check not supported for this format") {
      return "This format can't carry a creation record GAIC can check, so this result rests on the sampled frames.";
    }
    if (verdict === "Provenance data found — not validated") {
      return "The file contains creation-history data, but GAIC could not validate it.";
    }
    if (verdict === "Camera metadata found — not proof") {
      return "The file contains camera details. They count a little toward a real photo, but they can be edited.";
    }
    if (verdict === "Corroborating camera metadata — not proof") {
      return "Several camera details are present and agree with each other, which a stripped or edited file " +
        "usually does not manage. That counts toward a real photo, though every field can still be written by hand.";
    }
    if (verdict === "Camera metadata and write structure agree — not proof") {
      return "The camera details agree with each other, and the way the file was saved also matches a camera. " +
        "Two separate kinds of evidence pointing the same way is the strongest support GAIC can offer — and it " +
        "is still not proof that the image is real.";
    }
    if (verdict === "Metadata declares AI origin — unsigned") {
      return "The file's own labels say it was AI-generated. Nothing signed that label, so it could have been " +
        "written or copied by anyone — but a file rarely claims this about itself without reason.";
    }
    if (verdict === "Metadata labels this as possibly AI-generated — unsigned") {
      return "The file carries a label saying it may be AI-generated, of the kind sharing platforms add when an uploader " +
        "declares AI or the platform suspects it. Nothing signed that label, and it can be edited or removed.";
    }
    if (verdict === "Edit history records a generative step") {
      return "The file's edit history mentions an AI editing step. That means AI touched part of this image, " +
        "not necessarily that the whole picture was generated. The history is editable and can be removed.";
    }
    if (verdict === "File structure matches a generator write path") {
      return "The way this file was written matches a save path GAIC associates with AI tools. This describes " +
        "the file, not the picture, and re-saving any image through the same tool would look identical.";
    }
    if (verdict === "Converted copy checked — original container not evaluated") {
      return "This device converted the image to a format GAIC can read, so the picture itself was checked, " +
        "but the original file's Content Credentials and camera details were not read.";
    }
    if (verdict === "Container was rewritten — origin unrecoverable") {
      return "This file was re-saved somewhere along the way — usually by a phone gallery, a messaging app, or " +
        "a website — and the original creation details did not survive that. That is normal for images shared " +
        "online, and it is not a sign of AI either way.";
    }
    if (verdict === "Cloud model signal returned — verify") {
      return "The optional cloud scan found AI warning signs. Check the original source before you decide what to trust.";
    }
    if (verdict === "High AI-model signal — verify") {
      return "GAIC found strong visual patterns that can appear in AI-generated content. This is a warning, not proof.";
    }
    if (verdict === "Elevated AI-model signal — verify") {
      return "GAIC found visual patterns that can appear in AI-generated content. Check the source before you trust it.";
    }
    if (verdict === "High model signal in sampled frames — verify") {
      return "GAIC found strong AI warning signs in the sampled video or screen frames. It did not analyze every frame, audio, or full motion.";
    }
    if (verdict === "Elevated model signal in sampled frames — verify") {
      return "GAIC found AI warning signs in the sampled video or screen frames. It did not analyze every frame, audio, or full motion.";
    }
    if (verdict === "Sampled frames below warning bands") {
      return "The typical sampled frame stayed below GAIC's AI warning bands. Only sampled still frames were read, not audio or motion.";
    }
    if (verdict === "Model signal below warning bands" || verdict === "Screenshot scan below warning bands") {
      return "The pixel scan stayed below GAIC's AI warning bands.";
    }
    if (out.kind === "text") {
      const notes = [];
      if (out.textSection) {
        notes.push("One section (words " + out.textSection.firstWord.toLocaleString() + "–" + out.textSection.lastWord.toLocaleString() +
          ", starting \u201c" + out.textSection.opening + "\u2026\u201d) reads strongly machine-written, even though the text as a whole leans human-written.");
      }
      if (out.textDisguise) {
        notes.push("It also contains hidden characters or look-alike letters that are sometimes added to fool AI detectors; GAIC read the text without them.");
      }
      return notes.length ? notes.join(" ")
        : "GAIC compared the writing with patterns common in AI-generated and human-written text. Human writing can share some of those patterns.";
    }
    if (out.kind === "error") {
      return out.explain || "GAIC could not complete this scan.";
    }
    return "";
  }

  function resultSummary(out) {
    const parts = [
      "GAIC result: " + ((out.lean ? null : friendlyVerdict(out.verdict)) || out.verdict),
      primaryResultMetric(out),
      plainResultCopy(out)
    ];
    if (out.guidance) parts.push(out.guidance);
    parts.push("AI scans can be wrong. Use this as a lead, not proof.");
    return parts.join("\n");
  }

  function showResult(out) {
    out = out || { kind: "error", score: null, verdict: "No result",
      explain: "GAIC did not receive a result.", guidance: "Please try again." };
    lastResult = out;
    // Offer the "Was this right?" correction on image results only: a text or
    // video verdict has no single image a label could apply to. The exact File
    // is handed over so an opted-in answer can stage it; with the preference off
    // the control still appears and stores nothing.
    try {
      if (window.TrainingConsentUI &&
          typeof window.TrainingConsentUI.presentFor === "function") {
        window.TrainingConsentUI.presentFor(out, pickedFile);
      }
    } catch (_) {
      // Feedback is additive. It must never prevent a result from rendering.
    }
    const res = $("result");
    if (res) {
      res.classList.add("show");
      res.dataset.kind = out.kind || "check";
    }
    const verdictEl = $("verdict"), scoreEl = $("score"), barEl = $("bar"),
      meterEl = $("meter"), explainEl = $("explain"), guidanceEl = $("result-guidance"),
      kindEl = $("result-kind"), summaryEl = $("result-summary"),
      metricDetailEl = $("result-metric-detail");
    const kindLabels = { text: "Text scan", image: "Photo scan",
      video: "Video-frame scan", error: "Scan status" };
    if (kindEl) kindEl.textContent = kindLabels[out.kind] || "GAIC result";
    const friendly = out.lean ? null : friendlyVerdict(out.verdict);
    if (verdictEl) verdictEl.textContent = friendly || out.verdict;
    const techEl = $("verdict-tech");
    const technical = out.lean ? out.technicalVerdict : (friendly ? out.verdict : "");
    if (techEl) {
      techEl.hidden = !technical;
      techEl.textContent = technical ? "Technical read: " + technical : "";
    }
    const descEl = $("content-desc");
    if (descEl) {
      descEl.hidden = !out.mediaSummary;
      descEl.textContent = out.mediaSummary || "";
    }
    if (summaryEl) summaryEl.textContent = plainResultCopy(out);
    if (metricDetailEl) metricDetailEl.textContent = out.lean
      ? "Technical metric: " + resultMetric(out) + ". An estimate from the evidence, not proof."
      : out.score == null ? "" : "Technical metric: " + resultMetric(out) + ".";
    updateUpsell();
    if (out.score == null) {
      if (scoreEl) scoreEl.textContent = "Not scored";
      if (barEl) barEl.style.width = "0%";
      if (meterEl) meterEl.hidden = true;
    } else {
      const pct = Math.max(0, Math.min(100, Number(out.score) || 0));
      if (scoreEl) scoreEl.textContent = primaryResultMetric(out);
      if (barEl) barEl.style.width = pct + "%";
      if (meterEl) {
        meterEl.hidden = false;
        meterEl.setAttribute("aria-label", resultMetric(out) + ".");
      }
    }
    if (explainEl) explainEl.textContent = out.explain;
    if (guidanceEl) guidanceEl.textContent = out.guidance ||
      "Use this as one clue, not proof. Verify the original source and surrounding context.";
    announceResult(out);
    if (res) {
      try { res.focus({ preventScroll: true }); } catch (e) { try { res.focus(); } catch (error) {} }
      setTimeout(() => {
        try {
          const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          res.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "nearest" });
        } catch (e) {}
      }, 0);
    }
  }

  // ---------- accessibility: spoken results + live-region announcements ----------
  function announce(text, assertive) {
    const el = $("a11y-status");
    if (el) { el.setAttribute("aria-live", assertive ? "assertive" : "polite"); el.textContent = text; }
  }
  function speak(text) {
    try {
      if (window.speechSynthesis) {
        const u = new SpeechSynthesisUtterance(text);
        u.rate = 1.02; window.speechSynthesis.cancel(); window.speechSynthesis.speak(u);
      }
    } catch (e) {}
  }
  function announceResult(out) {
    const heading = (out.lean ? null : friendlyVerdict(out.verdict)) || out.verdict;
    const spoken = out.score == null
      ? heading
      : heading + ". " + resultMetric(out) + ".";
    announce(spoken, true);
    if (window.Native) window.Native.haptic(out.lean === "ai" && out.confidence === "high" ? "heavy" : "medium");
  }

  function readResult() {
    if (!lastResult) {
      announce("Run a check before reading a result.", true);
      return;
    }
    speak(resultSummary(lastResult));
  }

  async function shareResult() {
    if (!lastResult) {
      announce("Run a check before sharing a result.", true);
      return;
    }
    const text = resultSummary(lastResult);
    if (window.Native && window.Native.canShare) {
      const shared = await window.Native.share({ title: "GAIC result", text });
      if (shared) announce("Result shared.", false);
      return;
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        announce("Result copied to the clipboard.", false);
        const button = $("share-result-btn");
        if (button) {
          const old = button.textContent;
          button.textContent = "Copied";
          setTimeout(() => { button.textContent = old; }, 1600);
        }
      } else {
        announce("Sharing is not available in this browser.", true);
      }
    } catch (e) {
      announce("Sharing is not available in this browser.", true);
    }
  }

  // ---------- analyzing state: the on-device scan viewfinder ----------
  // A deliberate beat between "Check" and the result. The panel shows the
  // person's own picture, video frame, or text in a small viewfinder and
  // narrates the checks as they actually run: every stage is a real pipeline
  // event, and every lock-on box is a view the model is really reading. Nothing
  // is named that does not run for this kind of input. It is all transient UI
  // state: no preview URL, rectangle, or stage ever enters a result,
  // lastResult, or the shared or read-aloud text. Web, desktop (Electron), iOS,
  // and Android share this exact code path. The minimum on-screen time is
  // purely visual and collapses to a blink when the user prefers reduced motion.
  const SCAN_KINDS = ["image", "video", "screen", "text", "media"];
  const SCAN_DWELL_MS = 420;       // minimum time each stage stays readable
  const SCAN_SETTLE_MAX_MS = 900;  // longest the result waits for queued stages
  const SCAN_MODEL_SLOW_MS = 450;  // name the model load only when it is slow
  // Rough share of an image check each stage marks, for the progress bar. The
  // model's own views fill the span between them.
  const SCAN_STAGE_AT = Object.freeze({
    metadata: 0.04, credentials: 0.08, structure: 0.12, "model-load": 0.14, weigh: 0.97,
  });
  const scan = {
    active: false, kind: "media", queue: null, urls: new Set(), marks: null, lock: null,
    views: { done: 0, total: 0 }, frame: { index: 0, total: 0 }, pct: 0,
    modelReady: false, modelTimer: 0, swapFlip: false, onResize: null, token: 0,
  };
  let analyzeTargetMs = 0;
  function prefersReducedMotion() {
    try { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (_) { return false; }
  }
  function setAnalyzeProgress(pct) {
    const bar = $("analyzing-progress-bar");
    const value = Math.max(0, Math.min(100, pct));
    // scaleX, not width: avoid layout work while the on-device worker runs.
    if (bar) bar.style.transform = "scaleX(" + value / 100 + ")";
    const track = $("analyzing-progress");
    if (track && track.getAttribute("role") === "progressbar") {
      track.setAttribute("aria-valuenow", String(Math.round(value)));
    }
  }
  // A real analysis does not take the same time twice. Vary the floor per run
  // so the scan reads as work rather than a fixed canned pause.
  function analyzeDurationFor(kind) {
    if (prefersReducedMotion()) return 350;
    return kind === "text"
      ? 1200 + Math.floor(Math.random() * 1400)   // 1.2s – 2.6s
      : 2400 + Math.floor(Math.random() * 2800);  // 2.4s – 5.2s
  }
  // Hand the browser a real chance to composite the panel BEFORE the model
  // starts. Without this the panel is un-hidden and re-hidden without ever
  // painting, so on a slower device the scan appears not to run at all.
  function paintGate() {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      try {
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(finish, 0)));
      } catch (_) { finish(); }
      setTimeout(finish, 250); // never stall a check on a hidden tab
    });
  }

  // Stages arrive as fast as the pipeline runs (metadata takes milliseconds),
  // so each one stays up for a minimum dwell and they appear in the order they
  // happened. Consecutive updates of one stage ("region 3", "region 4", …)
  // replace each other instead of queueing, so the words never fall far
  // behind the real work. render(stage, inPlace) paints a stage.
  function createStageQueue(render, options) {
    const opts = options || {};
    const dwell = Number.isFinite(opts.dwell) ? Math.max(0, opts.dwell) : SCAN_DWELL_MS;
    const now = opts.now || (() => Date.now());
    const later = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
    const cancel = opts.clearTimer || ((id) => clearTimeout(id));
    const pending = [];
    const waiters = [];
    let current = null, shownAt = 0, timer = 0;
    function pump() {
      timer = 0;
      const wait = current ? dwell - (now() - shownAt) : 0;
      if (wait > 0) { timer = later(pump, wait); return; }
      if (!pending.length) {
        while (waiters.length) waiters.shift()();
        return;
      }
      current = pending.shift();
      shownAt = now();
      render(current, false);
      timer = later(pump, dwell);
    }
    return {
      push(stage) {
        if (!stage || !stage.id) return;
        const last = pending.length ? pending[pending.length - 1] : null;
        if (last && last.id === stage.id) {
          pending[pending.length - 1] = Object.assign({}, stage, { say: stage.say || last.say });
          return;
        }
        if (!last && current && current.id === stage.id) {
          // Same stage, newer detail: update in place and restart its dwell
          // so the latest detail stays readable before the next stage.
          current = stage;
          shownAt = now();
          render(stage, true);
          if (!timer) timer = later(pump, dwell);
          return;
        }
        pending.push(stage);
        if (!timer) pump();
      },
      // Resolves once every queued stage has been shown for its dwell.
      idle() {
        if (!pending.length && !timer) return Promise.resolve();
        return new Promise((resolve) => waiters.push(resolve));
      },
      clear() {
        if (timer) cancel(timer);
        timer = 0;
        pending.length = 0;
        current = null;
        while (waiters.length) waiters.shift()();
      },
      get size() { return pending.length; },
      get current() { return current; },
      // The stage that will be showing once the queue drains.
      get last() { return pending.length ? pending[pending.length - 1] : current; },
    };
  }

  // What each stage says. `text` is shown; `say` (major steps only) goes to
  // the polite live region, so a screen reader hears a handful of steps rather
  // than every region tick.
  function scanCopy(id, d, kind) {
    const n = (value) => Number(value || 0).toLocaleString();
    const of = (i, total) => (i + 1) + " of " + total;
    const frames = kind === "screen" ? "Checking" : "Sampling";
    switch (id) {
      case "read":
        return { text: kind === "video" ? "Reading the video" : kind === "screen" ? "Checking the captured frames" : "Reading the file" };
      case "metadata": return { text: "Reading the metadata" };
      case "credentials": return { text: "Checking Content Credentials", say: "Checking Content Credentials" };
      case "structure": return { text: "Checking the file structure" };
      case "model-load": return { text: "Loading the on-device image model", say: "Loading the on-device image model" };
      case "region":
        return { text: "Scanning region " + of(d.index, d.total), say: d.index === 0 ? "Scanning the image in " + d.total + " regions" : "" };
      case "picture": {
        const text = kind === "screen" ? "Picture located on screen" : "Picture located inside the screenshot";
        return { text, say: text };
      }
      case "picture-view":
        return { text: "Reading the picture · view " + of(d.index, d.total), say: d.index === 0 ? "Reading the located picture" : "" };
      case "video-open": return { text: "Opening the video" };
      case "frame":
        if (d.picture) return { text: "Frame " + of(d.index, d.total) + " · picture located", say: "Picture located on screen" };
        if (d.from) return { text: "Frame " + of(d.index, d.total) + " unchanged · reusing frame " + d.from };
        return { text: frames + " frame " + of(d.index, d.total), say: d.index === 0 && !d.quiet ? frames + " " + d.total + " frames" : "" };
      case "text-read":
        return d.words ? { text: "Reading " + n(d.words) + " word" + (d.words === 1 ? "" : "s"), say: "Reading " + n(d.words) + " words" } : { text: "Reading the text" };
      case "text-passages":
        return { text: d.count === 1 ? "Scored as one passage" : "Split into " + n(d.count) + " passages" };
      case "text-features": return { text: "Measured " + n(d.count) + " writing features per passage" };
      case "text-vocab": return { text: "Compared word choice with a " + n(d.count) + "-term vocabulary" };
      case "text-legacy": return { text: "Checked sentence rhythm and phrasing" };
      case "weigh": {
        const text = kind === "text" ? "Weighing writing patterns"
          : kind === "video" || kind === "screen" ? "Weighing the sampled frames" : "Weighing the evidence";
        return { text, say: text };
      }
      case "done": return { text: "Done — preparing the result" };
      default: return null;
    }
  }
  function renderScanStage(stage, inPlace) {
    const el = $("analyzing-stage"), text = $("analyzing-stage-text"), sr = $("analyzing-stage-sr");
    const panel = $("analyzing");
    if (panel) panel.setAttribute("data-stage", stage.id);
    if (!el) return;
    if (stage.say && sr && sr.textContent !== stage.say) sr.textContent = stage.say;
    if (!text) { el.textContent = stage.text; return; }
    text.textContent = stage.text;
    if (inPlace) return;
    // A new stage slides in at once, so it stays legible for its whole dwell.
    // Alternating two identical animations restarts it without a reflow.
    scan.swapFlip = !scan.swapFlip;
    text.classList.remove(scan.swapFlip ? "stage-in-b" : "stage-in-a");
    text.classList.add(scan.swapFlip ? "stage-in-a" : "stage-in-b");
  }
  // Pipeline hook: queue a real stage. A UI failure can never fail a check.
  function scanStage(id, detail) {
    try {
      if (!scan.active || !scan.queue) return;
      const d = detail || {};
      const copy = scanCopy(id, d, scan.kind);
      if (!copy) return;
      scan.queue.push({ id, text: copy.text, say: copy.say || "" });
      if ((scan.kind === "image" || scan.kind === "media") && SCAN_STAGE_AT[id]) scanProgress(SCAN_STAGE_AT[id]);
    } catch (_) {}
  }
  // One monotonic bar for the whole check: 8% at the start, 88% when every
  // real step has run, 100% only with the result.
  function scanProgress(fraction) {
    const pct = 8 + 80 * Math.max(0, Math.min(1, Number(fraction) || 0));
    if (pct <= scan.pct) return;
    scan.pct = pct;
    setAnalyzeProgress(pct);
  }
  // Video and screen already measure progress in frames (showProgress). While
  // the panel is open it owns the only visible bar, so the frame bar stays
  // hidden and its value flows here instead.
  function scanPanelProgress(fraction) {
    if (!scan.active) return false;
    const wrap = $("scan-progress");
    if (wrap) wrap.hidden = true;
    scanProgress(fraction);
    return true;
  }

  // ----- viewfinder layers -----
  function scanElement(tag, className) {
    const node = document.createElement(tag);
    node.className = className;
    return node;
  }
  function scanPlace(node, rect) {
    node.style.left = (rect.x * 100) + "%";
    node.style.top = (rect.y * 100) + "%";
    node.style.width = (rect.width * 100) + "%";
    node.style.height = (rect.height * 100) + "%";
  }
  function scanRevoke(url) {
    if (!url || !scan.urls.has(url)) return;
    scan.urls.delete(url);
    try { URL.revokeObjectURL(url); } catch (_) {}
  }
  // Revoke every preview URL. Idempotent: safe on teardown and on a new pick.
  function scanReleasePreviews() {
    for (const url of Array.from(scan.urls)) scanRevoke(url);
  }
  // Fit a picture box inside the viewfinder the way object-fit: contain would,
  // as percentages, so region boxes can be placed in the picture's own
  // coordinates. Recomputed only when the viewport changes size.
  function scanFit(media) {
    const view = media && media.parentNode;
    const iw = Number(media && media.dataset.w), ih = Number(media && media.dataset.h);
    if (!view || !iw || !ih) return;
    const fw = view.clientWidth, fh = view.clientHeight;
    if (!fw || !fh) return;
    const pad = 10;
    const s = Math.min((fw - 2 * pad) / iw, (fh - 2 * pad) / ih);
    if (!(s > 0)) return;
    const w = (iw * s) / fw * 100, h = (ih * s) / fh * 100;
    scanPlace(media, { x: (100 - w) / 200, y: (100 - h) / 200, width: w / 100, height: h / 100 });
  }
  function scanRefit() {
    const view = $("analyzing-view");
    if (!view) return;
    for (const media of view.querySelectorAll(".analyzing-media[data-w]")) scanFit(media);
  }
  // Show one picture (the chosen photo, or a sampled video or screen frame) in
  // the viewfinder. It starts desaturated and develops to full colour behind
  // a sweeping beam; an earlier frame fades out underneath the new one.
  // The picked photo is previewed only after its header proves it small
  // enough to decode for a 260px viewfinder (the scan itself decodes large
  // photos to a downscaled copy); under reduced motion an animated GIF, WebP,
  // or APNG is shown as a still of its first frame.
  const SCAN_PREVIEW_MAX_PIXELS = 24 * 1000 * 1000;
  async function scanPreviewPicked(file) {
    try {
      const token = scan.token;
      const head = new Uint8Array(await file.slice(0, Math.min(file.size, 512 * 1024)).arrayBuffer());
      const dims = imageDimensions(head);
      if (!dims || !(dims.width * dims.height <= SCAN_PREVIEW_MAX_PIXELS)) return;
      if (!scan.active || scan.token !== token) return;
      let shown = file;
      if (prefersReducedMotion() && /^image\/(gif|webp|png|apng)$/i.test(String(file.type || "")) &&
          typeof createImageBitmap === "function") {
        const scale = Math.min(1, 640 / Math.max(dims.width, dims.height));
        const bitmap = await createImageBitmap(file);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(dims.width * scale));
        canvas.height = Math.max(1, Math.round(dims.height * scale));
        canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        if (bitmap.close) bitmap.close();
        shown = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
        if (!shown || !scan.active || scan.token !== token) return;
      }
      scanShowPicture(shown);
    } catch (_) {}
  }
  function scanShowPicture(file) {
    const view = $("analyzing-view"), panel = $("analyzing");
    if (!view || !panel || !file) return;
    let url = "";
    try { url = URL.createObjectURL(file); } catch (_) { return; }
    scan.urls.add(url);
    const media = scanElement("div", "analyzing-media");
    const shot = scanElement("img", "analyzing-shot");
    const veil = scanElement("div", "analyzing-veil");
    const mono = scanElement("img", "analyzing-shot");
    const marks = scanElement("div", "analyzing-marks");
    shot.alt = ""; mono.alt = "";
    shot.decoding = "async"; mono.decoding = "async";
    veil.appendChild(mono);
    media.appendChild(shot);
    media.appendChild(veil);
    media.appendChild(scanElement("span", "analyzing-beam"));
    media.appendChild(marks);
    view.appendChild(media);
    panel.classList.add("has-view");
    scan.marks = marks;
    scan.lock = null;
    const retire = (old, delay) => {
      old.classList.add("is-leaving");
      setTimeout(() => {
        if (old.parentNode) old.parentNode.removeChild(old);
        scanRevoke(old.dataset.url);
      }, delay);
    };
    shot.onload = () => {
      if (!media.parentNode) return;
      // A newer frame already on show wins; this one arrived too late.
      for (let next = media.nextElementSibling; next; next = next.nextElementSibling) {
        if (next.classList.contains("is-ready")) { retire(media, 0); return; }
      }
      media.dataset.w = String(shot.naturalWidth || 0);
      media.dataset.h = String(shot.naturalHeight || 0);
      scanFit(media);
      media.classList.add("is-ready");
      for (let old = media.previousElementSibling; old; old = old.previousElementSibling) {
        if (!old.classList.contains("is-leaving")) retire(old, 320);
      }
    };
    shot.onerror = () => {
      // Undisplayable here: keep the boxes on a plain full-frame stage.
      scanRevoke(url);
      if (shot.parentNode) shot.parentNode.removeChild(shot);
      if (veil.parentNode) veil.parentNode.removeChild(veil);
      media.classList.add("is-ready", "is-plain");
    };
    media.dataset.url = url;
    shot.src = url;
    mono.src = url;
  }
  // Snap a bracket box onto the view the model is reading. Its geometry is set
  // once; it animates in and out with transform and opacity only.
  function scanLock(rect) {
    if (!scan.marks || !rect) return;
    const box = scanElement("span", "analyzing-lock");
    scanPlace(box, rect);
    scan.marks.appendChild(box);
    const previous = scan.lock;
    scan.lock = box;
    if (previous && previous.parentNode) {
      previous.classList.add("is-done");
      setTimeout(() => { if (previous.parentNode) previous.parentNode.removeChild(previous); }, 600);
    }
  }
  function scanPictureBox(rect) {
    if (!scan.marks || !rect) return;
    const box = scanElement("span", "analyzing-found");
    const tag = scanElement("span", "analyzing-found-tag");
    tag.textContent = "picture";
    box.appendChild(tag);
    scanPlace(box, rect);
    scan.marks.appendChild(box);
  }
  // Text: a clipped excerpt of the person's own text with a highlighter
  // reading down it. It never leaves this panel.
  function scanPreviewText(value) {
    try {
      if (!scan.active) return;
      const view = $("analyzing-view"), panel = $("analyzing");
      const raw = String(value || "");
      const words = normalizeTextForAnalysis(raw).trim().split(/\s+/).filter(Boolean).length;
      const excerpt = raw.slice(0, 900).replace(/\s+/g, " ").trim().slice(0, 520);
      if (view && panel && excerpt) {
        const wrap = scanElement("div", "analyzing-text");
        const body = scanElement("p", "analyzing-text-body");
        const mark = scanElement("span", "analyzing-text-mark");
        body.textContent = excerpt;
        mark.appendChild(document.createElement("span"));
        wrap.appendChild(body);
        wrap.appendChild(mark);
        view.appendChild(wrap);
        panel.classList.add("has-view");
      }
      scanStage("text-read", { words });
      scanProgress(0.1);
    } catch (_) {}
  }
  // The text engine is synchronous and finishes in milliseconds, so its real
  // numbers are replayed while the panel is up: how many passages it scored,
  // what it measured, and the vocabulary it compared against.
  function scanTextReplay(out, value) {
    try {
      if (!scan.active || !out || out.kind !== "text" || !Number.isFinite(out.score)) return;
      const engine = global.AICheckTextEngine;
      if (out.textModel && engine && engine.model && typeof engine.chunkText === "function") {
        const passages = engine.chunkText(engine.normalize(value)).length;
        if (passages) scanStage("text-passages", { count: passages });
        if (engine.DENSE_NAMES && engine.DENSE_NAMES.length) scanStage("text-features", { count: engine.DENSE_NAMES.length });
        if (engine.model.lexicon && engine.model.lexicon.size) scanStage("text-vocab", { count: engine.model.lexicon.size });
      } else {
        scanStage("text-legacy");
      }
      scanStage("weigh");
      scanProgress(1);
    } catch (_) {}
  }
  // Video and screen: show the frame being analyzed. The frame already exists
  // as a PNG File for the model, so nothing is decoded a second time.
  function scanFrame(frame, index, total) {
    try {
      if (!scan.active) return;
      scan.frame = { index, total };
      scan.views = { done: 0, total: 0 };
      scanShowPicture(frame);
      scanProgress(index / Math.max(1, total));
    } catch (_) {}
  }
  // Options for OnnxDetector.detect: follow the model through its views.
  function scanDetectOptions() {
    try {
      if (scan.active) {
        scan.modelReady = false;
        clearTimeout(scan.modelTimer);
        scan.modelTimer = setTimeout(() => {
          const last = scan.queue && scan.queue.last;
          if (scan.active && !scan.modelReady && !(last && (last.id === "weigh" || last.id === "done"))) {
            scanStage("model-load");
          }
        }, SCAN_MODEL_SLOW_MS);
      }
    } catch (_) {}
    return { onProgress: scanModelProgress };
  }
  function scanModelProgress(p) {
    try {
      if (!scan.active || !p) return;
      const stills = scan.kind === "image" || scan.kind === "media";
      if (p.phase === "model-ready") {
        scan.modelReady = true;
        clearTimeout(scan.modelTimer);
        // Frames have no per-region words, so once a slow model load ends the
        // frame being read takes the stage back.
        const latest = scan.queue && scan.queue.last;
        if (!stills && scan.frame.total && latest && latest.id === "model-load") {
          scanStage("frame", { index: scan.frame.index, total: scan.frame.total, quiet: true });
        }
        return;
      }
      if (p.phase === "decoded") {
        scan.views = { done: 0, total: p.total };
        return;
      }
      if (p.phase === "picture") {
        scan.views.total += p.total;
        scanPictureBox(p.rect);
        if (stills) scanStage("picture");
        else if (scan.kind === "screen") scanStage("frame", { index: scan.frame.index, total: scan.frame.total, picture: true });
        return;
      }
      if (p.phase !== "region" && p.phase !== "picture-view") return;
      scan.modelReady = true;
      clearTimeout(scan.modelTimer);
      scanLock(p.rect);
      scan.views.done += 1;
      if (stills) scanStage(p.phase, { index: p.index, total: p.total });
      const within = scan.views.total ? Math.min(1, scan.views.done / scan.views.total) : 0;
      if (stills) scanProgress(0.16 + 0.78 * within);
      else scanProgress((scan.frame.index + within) / Math.max(1, scan.frame.total));
    } catch (_) {}
  }

  function scanTeardown() {
    scan.active = false;
    if (scan.queue) scan.queue.clear();
    scan.queue = null;
    clearTimeout(scan.modelTimer);
    scan.modelTimer = 0;
    scan.marks = null; scan.lock = null; scan.pct = 0;
    scan.views = { done: 0, total: 0 };
    scan.frame = { index: 0, total: 0 };
    if (scan.onResize) {
      try { window.removeEventListener("resize", scan.onResize); } catch (_) {}
      scan.onResize = null;
    }
    scanReleasePreviews();
    const view = $("analyzing-view");
    if (view) while (view.firstChild) view.removeChild(view.firstChild);
    const panel = $("analyzing");
    if (panel) {
      panel.classList.remove("has-view", "is-resolving");
      panel.removeAttribute("data-kind");
      panel.removeAttribute("data-stage");
    }
    // Hand the progressbar role back to the frame bar.
    const track = $("analyzing-progress"), frameTrack = $("scan-progress-track");
    if (track) {
      track.removeAttribute("role");
      track.removeAttribute("aria-label");
      track.removeAttribute("aria-valuemin");
      track.removeAttribute("aria-valuemax");
      track.removeAttribute("aria-valuenow");
      track.setAttribute("aria-hidden", "true");
    }
    if (frameTrack) frameTrack.setAttribute("role", "progressbar");
  }
  function setAnalyzing(on, kind) {
    const el = $("analyzing");
    if (el) el.hidden = !on;
    scanTeardown();
    const stageEl = $("analyzing-stage"), stageText = $("analyzing-stage-text"), stageSr = $("analyzing-stage-sr");
    if (on) {
      const res = $("result");
      if (res) res.classList.remove("show");
      announce("Analyzing on this device…", false);
      const reduced = prefersReducedMotion();
      scan.kind = SCAN_KINDS.indexOf(kind) >= 0 ? kind : "media";
      scan.active = true;
      scan.token += 1;
      analyzeTargetMs = analyzeDurationFor(scan.kind);
      if (el) el.setAttribute("data-kind", scan.kind);
      // One visible bar, and it is the one exposed as the progressbar.
      const track = $("analyzing-progress"), frameTrack = $("scan-progress-track"), frameWrap = $("scan-progress");
      if (frameWrap) frameWrap.hidden = true;
      if (frameTrack) frameTrack.removeAttribute("role");
      if (track) {
        track.removeAttribute("aria-hidden");
        track.setAttribute("role", "progressbar");
        track.setAttribute("aria-label", "Check progress");
        track.setAttribute("aria-valuemin", "0");
        track.setAttribute("aria-valuemax", "100");
      }
      setAnalyzeProgress(8);
      scan.pct = 8;
      scan.queue = createStageQueue(renderScanStage, { dwell: SCAN_DWELL_MS });
      scanStage(scan.kind === "text" ? "text-read" : "read", {});
      if (scan.kind === "image" && pickedFile) scanPreviewPicked(pickedFile);
      scan.onResize = () => { try { scanRefit(); } catch (_) {} };
      try { window.addEventListener("resize", scan.onResize); } catch (_) {}
      // Bring the theater into view — on phones the card top sits off-screen
      // when the check starts from the quick-scan button.
      if (el && !reduced && el.scrollIntoView) {
        try { el.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (_) {}
      }
    } else {
      if (stageText) {
        stageText.textContent = "";
        stageText.classList.remove("stage-in-a", "stage-in-b");
      }
      if (stageSr) stageSr.textContent = "";
      if (stageEl && !stageText) stageEl.textContent = "";
      setAnalyzeProgress(0);
    }
  }
  // Wait (bounded) until the queued real stages have each had their dwell.
  function scanStagesSettled(maxMs) {
    if (!scan.active || !scan.queue) return Promise.resolve();
    return Promise.race([
      scan.queue.idle(),
      new Promise((resolve) => setTimeout(resolve, Math.max(0, maxMs))),
    ]);
  }
  async function finishAnalyzing(since, kind) {
    if (!since) return;
    const reduced = prefersReducedMotion();
    // This run's randomized floor, chosen when the scan started.
    const minShow = analyzeTargetMs || (reduced ? 350 : kind === "text" ? 1300 : 2600);
    const left = minShow - (Date.now() - since);
    if (left > 0) await new Promise((resolve) => setTimeout(resolve, left));
    if (!reduced) await scanStagesSettled(SCAN_SETTLE_MAX_MS);
    setAnalyzeProgress(100);
    // The resolve beat (under 400 ms): the brackets converge and the beam
    // flashes out, then the unchanged result card takes over.
    if (scan.queue) scan.queue.clear();
    renderScanStage({ id: "done", text: scanCopy("done", {}, scan.kind).text, say: "" }, true);
    const panel = $("analyzing");
    if (panel && scan.active) panel.classList.add("is-resolving");
    if (!reduced) await new Promise((resolve) => setTimeout(resolve, 320));
    setAnalyzing(false);
  }

  async function run() {
    if (running) return;
    running = true;
    const runId = beginResultRun();
    const runMode = mode;
    let analyticsMode = runMode === "text"
      ? "text"
      : pickedKind || (isVideoFile(pickedFile) ? "video" : "image");
    let checkStarted = false;
    let analyzingSince = 0;
    let cloudPlan = null;
    const btn = $("check-btn");
    if (btn) { btn.disabled = true; btn.textContent = "Checking…"; }
    const card = $("detector-card");
    if (card) card.setAttribute("aria-busy", "true");
    try {
      let out;
      // Free tier = 3 checks per week across every mode (text, image, video,
      // screen frame); GAIC Pro / Unlimited subscribers bypass the gate.
      const pro = !!(window.Purchases && window.Purchases.isPro());
      if (runMode !== "text" && !pickedFile) {
        showResult({ kind: "error", score: null, verdict: "No image or video selected",
          explain: "Choose an image or video first — tap the upload box above.",
          guidance: "Nothing was analyzed and no free check was used.", countsTowardLimit: false });
        analyticsTrack("check_failed", "invalid_input");
        return;
      }
      // Enforcement gate. For a signed-in user this consults the account's
      // server-side count first; everyone else is gated by the on-device
      // counter. Either way the 4th check in a week never runs.
      if (!pro) {
        const allowance = await quotaAllowsCheck();
        if (allowance !== true) {
          if (allowance === false) showLimitReached();
          else showQuotaUnavailable();
          return;
        }
      }
      if (runMode === "text") {
        checkStarted = true;
        analyticsTrack("check_started", analyticsMode);
        setAnalyzing(true, "text");
        scanPreviewText(($("text-input") || {}).value);
        analyzingSince = Date.now();
        await paintGate();
        const input = $("text-input");
        out = analyzeText((input && input.value) || "");
        scanTextReplay(out, (input && input.value) || "");
      } else {
        checkStarted = true;
        analyticsTrack("check_started", analyticsMode);
        setAnalyzing(true, isVideoFile(pickedFile) ? "video" : "image");
        analyzingSince = Date.now();
        if (!isVideoFile(pickedFile)) {
          // Capture this check's one-time consent and verified entitlement
          // before local analysis. No network work starts until after quota is
          // consumed and the local result has rendered.
          cloudPlan = cloudPlanForImage(pickedFile);
        }
        // Paint the progress state before asynchronous decode/worker inference.
        await paintGate();
        // A video routes through this same gate and the single bumpUsage below,
        // so a whole video check counts as one check against the free weekly
        // allowance — never one per sampled frame.
        out = isVideoFile(pickedFile)
          ? await analyzeVideo(pickedFile)
          : addCloudPlanStatus(
              await analyzeImage(pickedFile, selectedSourceContext()),
              cloudPlan
            );
      }
      // One successful check of ANY kind consumes exactly one weekly use;
      // failed or rejected checks (countsTowardLimit:false) stay free. If the
      // account server refuses at this point (a concurrent device used the
      // last check), the result is withheld and the paywall is shown instead.
      if (!pro && out && out.countsTowardLimit !== false) {
        const granted = await quotaConsumeCheck();
        syncQuotaHint();
        if (granted !== true) {
          setAnalyzing(false);
          if (granted === false) showLimitReached();
          else showQuotaUnavailable();
          return;
        }
      }
      await finishAnalyzing(analyzingSince, runMode === "text" ? "text" : "media");
      showResult(out);
      if (out && out.kind === "error") {
        analyticsTrack("check_failed", "invalid_input");
      } else {
        analyticsTrack("check_completed", analyticsMode);
      }
      // Deliberately detached: the button, aria-busy state, and local result
      // are all released before the optional upload is encoded, queued, or
      // polled. A later completion may patch only this same visible result.
      if (
        cloudPlan &&
        cloudPlan.eligible &&
        out &&
        out.kind === "image"
      ) {
        scheduleOptionalCloudAnalysis(cloudPlan, out, runId);
      }
    } catch (e) {
      setAnalyzing(false);
      showResult({ kind: "error", score: null, verdict: "Couldn't complete the check",
        explain: "Something went wrong reading that input. The file may be damaged, unsupported, or no longer available.",
        guidance: "Select the file again or try a standard JPEG, PNG, MP4, or WebM. Failed checks do not use the free allowance.",
        countsTowardLimit: false });
      analyticsTrack("check_failed", checkStarted ? "model_error" : "unknown");
    } finally {
      setAnalyzing(false);
      running = false;
      if (runMode === "image") clearCloudConsent();
      if (btn) btn.disabled = false;
      if (card) card.removeAttribute("aria-busy");
      setCheckButtonLabel();
    }
  }

  // wire up file input
  document.addEventListener("DOMContentLoaded", () => {
    const drop = $("drop"), input = $("file-input");
    if (drop && input) {
      drop.addEventListener("click", () => { autoRunAfterPick = false; });
      // Keyboard: the dropzone acts as a button — Enter/Space opens the picker.
      drop.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault(); autoRunAfterPick = false; input.click();
        }
      });
      // A normal file choice pauses for review before consuming a free check.
      // The explicit Quick Scan shortcut may opt into immediate analysis.
      // Every way of opening the file picker clicks this input.
      input.addEventListener("click", warmImageModel);
      input.addEventListener("change", e => {
        const f = e.target.files && e.target.files[0];
        const shouldRun = autoRunAfterPick;
        autoRunAfterPick = false;
        if (f && acceptImage(f, "Ready: " + f.name)) {
          switchTab("image");
          if (shouldRun) run();
        }
        try { e.target.value = ""; } catch (error) {}
      });
      ["dragover","dragenter"].forEach(ev => drop.addEventListener(ev, e => {
        e.preventDefault(); drop.classList.add("is-dragging");
      }));
      drop.addEventListener("dragenter", warmImageModel);
      ["dragleave","drop"].forEach(ev => drop.addEventListener(ev, e => {
        e.preventDefault(); drop.classList.remove("is-dragging");
      }));
      drop.addEventListener("drop", e => {
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f && acceptImage(f, "Ready: " + f.name)) switchTab("image");
      });
    }
    // Tab switcher keyboard support: Enter/Space activates, arrows move focus.
    const tabText = $("tab-text"), tabImage = $("tab-image");
    [tabText, tabImage].forEach(tab => {
      if (!tab) return;
      tab.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault(); switchTab(tab === tabText ? "text" : "image", true);
        } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          const next = tab === tabText ? tabImage : tabText;
          if (next) { switchTab(next === tabText ? "text" : "image", true); next.focus(); }
        }
      });
    });
    const limitationsLink = document.querySelector(".learn-link");
    if (limitationsLink) limitationsLink.addEventListener("click", () => {
      analyticsTrack("help_opened", "limitations");
    });
    // Paste and the S shortcut remain available without hijacking two-finger
    // gestures; users must be able to pinch-zoom the interface.
    document.addEventListener("paste", e => {
      const items = ((e.clipboardData || {}).items) || [];
      for (const it of items) {
        if (it.type && it.type.indexOf("image") === 0) {
          const f = it.getAsFile();
          if (f && acceptImage(f, "Ready: pasted image")) switchTab("image");
          break;
        }
      }
    });
    document.addEventListener("keydown", e => {
      const t = (e.target && e.target.tagName) || "";
      if (/INPUT|TEXTAREA/.test(t) || (e.target && e.target.isContentEditable)) return;
      if (e.key === "s" || e.key === "S") quickScan();
    });
    const textInput = $("text-input"), textCount = $("text-count");
    const updateTextCount = () => {
      if (!textInput || !textCount) return;
      const n = textInput.value.length;
      const scoreableCharacters = normalizeTextForAnalysis(textInput.value).trim().length;
      const bytes = utf8ByteLength(textInput.value);
      const tooLarge = n > MAX_TEXT_CHARACTERS || bytes > MAX_TEXT_BYTES;
      textCount.textContent = n.toLocaleString() + " characters · " +
        Math.ceil(bytes / 1024).toLocaleString() + " KB · minimum " +
        MIN_TEXT_CHARACTERS.toLocaleString() + " characters, maximum " +
        MAX_TEXT_CHARACTERS.toLocaleString() + " characters / 256 KB" +
        (tooLarge ? " — shorten this text before checking" : "");
      textCount.classList.toggle("ready", scoreableCharacters >= MIN_TEXT_CHARACTERS && !tooLarge);
      textInput.setAttribute("aria-invalid", tooLarge ? "true" : "false");
    };
    if (textInput) textInput.addEventListener("input", updateTextCount);
    updateTextCount();
    // Reflect verified subscription state and this week's remaining checks.
    syncQuotaHint();
    // Then reconcile against the durable mirror and, when signed in, the
    // account's server-side count — so a cleared local store is repaired
    // before the user can spend a check it no longer knows about.
    hydrateUsage();
    setCheckButtonLabel();
    syncCloudConsentControl();
    document.addEventListener("aicheck:entitlementchange", () => {
      if (
        !window.Purchases ||
        !window.Purchases.cloudAnalysisAvailable ||
        !window.Purchases.cloudAnalysisAvailable()
      ) {
        invalidateCloudAnalysis();
      }
      syncQuotaHint();
      syncCloudConsentControl();
      updateUpsell(); // a new Pro entitlement removes the result upsell in place
    });
    // Signing in adopts that account's allowance immediately.
    document.addEventListener("aicheck:accountchange", () => {
      invalidateCloudAnalysis();
      hydrateUsage();
    });
    document.addEventListener("niro:accountdeleted", () => {
      invalidateCloudAnalysis();
      switchUsageOwner("");
      mirroredUsage = 0;
      mirroredUsageWeek = weekKey();
      accountScopeActive = false;
      quotaAuthorityUnavailable = false;
      syncQuotaHint();
    });
    document.addEventListener("aicheck:checkoutavailabilitychange", () => {
      syncQuotaHint();
      updateUpsell();
    });
    document.addEventListener("aicheck:cloudavailabilitychange", () => {
      if (
        !window.Purchases ||
        !window.Purchases.cloudAnalysisAvailable ||
        !window.Purchases.cloudAnalysisAvailable()
      ) {
        invalidateCloudAnalysis();
      }
      syncCloudConsentControl();
      updateUpsell();
    });
    // Native Shortcut/share handoffs must wait for this exact point. Merely
    // finding the DOM elements is not enough: the file-input listener above is
    // what validates and stores the selected File before a check can run.
    if (global.AICheck) global.AICheck.nativeEntryReady = true;
  });
  if (global && typeof global.addEventListener === "function") {
    global.addEventListener("pagehide", cancelActiveCloudAnalysis);
    global.addEventListener("beforeunload", cancelActiveCloudAnalysis);
  }

  // Camera capture uses Capacitor. Gallery selection always uses the browser's
  // file input, including inside WKWebView: Capacitor Camera 8.2's
  // chooseFromGallery implementation requests read/write access to the whole
  // iOS photo library, while the system file picker grants only the item the
  // user explicitly chooses.
  async function pickPhoto(source, analyzeNow){
    try {
      if (source === "photos") {
        const inp = $("file-input");
        if (inp) { autoRunAfterPick = !!analyzeNow; inp.click(); }
        return;
      }
      if (!(window.Native && window.Native.canCamera)) {
        const inp = $("file-input");
        if (inp) { autoRunAfterPick = !!analyzeNow; inp.click(); }
        return;
      }
      const dataUrl = await window.Native.pickImage(source);
      if (!dataUrl) return;
      const blob = await (await fetch(dataUrl)).blob();
      const f = new File([blob], "photo.jpg", { type: blob.type || "image/jpeg" });
      // This JPEG was encoded by the capture plugin on its way through a data
      // URL, not by the camera. Its EXIF and any Content Credentials are gone,
      // and its container structure describes the plugin. Mark it so the
      // provenance path discards container evidence instead of reporting that
      // "a general-purpose tool rewrote this file" about a live capture.
      try {
        Object.defineProperty(f, "aicheckInputContext", {
          value: "device-capture-derived-jpeg",
          enumerable: false, configurable: false, writable: false,
        });
      } catch (_) {
        // A frozen File implementation is not a reason to abandon the check;
        // analyzeImage treats an unreadable context as "no container evidence".
      }
      if (acceptImage(f, "Ready: photo from " + (source === "camera" ? "the camera" : "your library"))) {
        switchTab("image");
        if (analyzeNow) run();
      }
    } catch (e) {
      showResult({ kind: "error", score: null, verdict: "Couldn't open that photo",
        explain: "GAIC could not read the selected photo. It may have been moved or use an unsupported format.",
        guidance: "Try a JPEG or PNG from your photo library. No free check was used.", countsTowardLimit: false });
    }
  }

  // ---------- accessible Quick Scan: one gesture -> grab a photo -> scan ----------
  // Triggered by a large button or keyboard (S). If an image is already
  // selected it re-scans; otherwise the picker opens and the chosen image scans.
  async function quickScan() {
    if (window.Native) window.Native.haptic("light");
    switchTab("image");
    if (pickedFile) { run(); return; }
    announce("Choose a photo. It will be analyzed on this device.", true);
    if (window.Native && window.Native.canCamera) { await pickPhoto("photos", true); return; }
    const inp = $("file-input");
    if (inp) { autoRunAfterPick = true; inp.click(); }
  }

  // ---------- local writing assist ----------
  // This deterministic editor never calls the network and never claims to
  // identify or disguise authorship. The user sees and reviews an editable
  // suggestion before choosing whether to use it.
  function improveDraft() {
    const input = $("text-input"), mode = $("writing-mode"), output = $("writing-output");
    const wrap = $("writing-output-wrap"), summary = $("writing-summary");
    const text = input ? input.value : "";
    if (!text.trim()) {
      if (summary) summary.textContent = "Add a draft above before requesting edits.";
      if (wrap) wrap.hidden = false;
      announce("Add a draft before requesting edits.", true);
      if (input) input.focus();
      return null;
    }
    const limitError = textLimitError(text);
    if (limitError) {
      if (summary) summary.textContent = limitError.explain;
      if (wrap) wrap.hidden = false;
      announce("Shorten the draft before requesting edits.", true);
      if (input) input.focus();
      return null;
    }
    if (!window.AICheckWritingAssist || typeof window.AICheckWritingAssist.improve !== "function") {
      if (summary) summary.textContent = "Writing assist is unavailable in this build.";
      if (wrap) wrap.hidden = false;
      announce("Writing assist is unavailable.", true);
      return null;
    }
    const result = window.AICheckWritingAssist.improve(text, mode ? mode.value : "clear");
    if (output) output.value = result.output;
    if (summary) summary.textContent = result.modeLabel + " · " + result.summary;
    if (wrap) wrap.hidden = false;
    announce(result.changed ? "Suggested edits are ready for review." : "No automatic wording changes were found.", true);
    if (output) output.focus();
    return result;
  }

  function useImprovedDraft() {
    const input = $("text-input"), output = $("writing-output"), wrap = $("writing-output-wrap");
    if (!input || !output || !output.value.trim()) return false;
    input.value = output.value;
    if (wrap) wrap.hidden = true;
    try { input.dispatchEvent(new Event("input", { bubbles: true })); } catch (_) {}
    input.focus();
    announce("Suggested draft moved into the text checker. Review it before continuing.", true);
    return true;
  }

  async function copyImprovedDraft() {
    const output = $("writing-output");
    if (!output || !output.value) return false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(output.value);
      } else {
        output.focus();
        output.select();
        if (!document.execCommand || !document.execCommand("copy")) throw new Error("copy unavailable");
      }
      announce("Suggested draft copied.", true);
      return true;
    } catch (_) {
      announce("Copy was unavailable. Select the suggested text and copy it manually.", true);
      return false;
    }
  }

  global.AICheck = {
    nativeEntryReady: false,
    switchTab, run, pickPhoto, quickScan, scanScreen, readResult, shareResult,
    improveDraft, useImprovedDraft, copyImprovedDraft,
    _test: Object.freeze({
      analyzeText, analyzeImage, analyzeVideo, imageSignalVerdict, imageDimensions, parseImageMetadata,
      normalizeImageRegionScores, isScreenCaptureLikeFrame, frameLayoutContext,
      normalizeSourceContext,
      seekVideo, sanitizeVideoProvenance, verifyVideoProvenance, videoProvenanceEvidence,
      frameSignalSummary, frameLooksBlank, frameFingerprint, sameFrame,
      recordDisplayFrames, analyzeScreenFrames, analyzeTextWithEngine,
      cloudAnalysisRequest, cloudPlanForImage, addCloudPlanStatus,
      startOptionalCloudAnalysis, scheduleOptionalCloudAnalysis,
      cancelActiveCloudAnalysis, beginResultRun, showResult,
      normalizeTextForAnalysis, utf8ByteLength, textLimitError,
      getUsage, bumpUsage, hydrateUsage, weekKey, quotaAllowsCheck, quotaConsumeCheck,
      reconcileUsageForWeek, analyzeDurationFor,
      IMAGE_AI_BAND, IMAGE_AI_ELEVATED_BAND, IMAGE_REAL_BAND,
      MIN_TEXT_CHARACTERS, MAX_TEXT_CHARACTERS,
      MAX_TEXT_BYTES, WEEKLY_LIMIT, SCREEN_CAPTURE_SECONDS, SCREEN_FRAME_SAMPLES,
      ACCOUNT_SESSION_TIMEOUT_MS, CLOUD_ANALYSIS_TIMEOUT_MS,
      CLOUD_MAX_IMAGE_BYTES,
    }),
  };
})(window);

/* Opt-in weekly local reminder (native only). Purely a local OS alarm: no
   server, no telemetry. The row stays hidden unless the Capacitor
   LocalNotifications plugin is actually available; the OS permission prompt
   appears only after the person turns the toggle on. */
(function () {
  "use strict";
  var REMIND_KEY = "aicheck.remind.v1";
  function notifier() {
    try {
      var ln = window.Capacitor && window.Capacitor.Plugins &&
        window.Capacitor.Plugins.LocalNotifications;
      return (window.Capacitor && window.Capacitor.isNativePlatform &&
        window.Capacitor.isNativePlatform() && ln) ? ln : null;
    } catch (e) { return null; }
  }
  function init() {
    var ln = notifier(); if (!ln) return;
    var row = document.getElementById("remind-row");
    var toggle = document.getElementById("remind-toggle");
    if (!row || !toggle) return;
    row.hidden = false;
    try { toggle.checked = localStorage.getItem(REMIND_KEY) === "on"; } catch (e) {}
    toggle.addEventListener("change", async function () {
      if (toggle.checked) {
        try {
          var perm = await ln.requestPermissions();
          if (!perm || perm.display !== "granted") { toggle.checked = false; return; }
          await ln.schedule({ notifications: [{
            id: 7100,
            title: "GAIC",
            body: "Your 3 free weekly checks have refreshed.",
            // weekday 2 = Monday in Capacitor's iOS-style numbering (1 = Sunday),
            // and 15:00 local is after 00:00 Monday UTC in every time zone
            // (including UTC+14), so the refresh claim is never early.
            schedule: { on: { weekday: 2, hour: 15, minute: 0 } },
          }] });
          try { localStorage.setItem(REMIND_KEY, "on"); } catch (e) {}
        } catch (e) { toggle.checked = false; }
      } else {
        try { await ln.cancel({ notifications: [{ id: 7100 }] }); } catch (e) {}
        try { localStorage.setItem(REMIND_KEY, "off"); } catch (e) {}
      }
    });
  }
  if (document.readyState !== "loading") init();
  else document.addEventListener("DOMContentLoaded", init);
})();
