(function () {
  "use strict";

  const DAILY_LIMIT = 1;
  // Phone photos from 48-200 MP cameras are often 10-40 MB; the detector
  // decodes anything above its 24 MP working size as a downscaled copy.
  const MAX_BYTES = 50 * 1024 * 1024;
  const MAX_SIDE = 16384;
  const MAX_PIXELS = 120_000_000;
  const HIGH_SIGNAL = 0.99;
  const ELEVATED_SIGNAL = 0.95;
  const USAGE_KEY = "aicheck.quick.daily.v1";
  let selected = null;
  let selectedDimensions = null;
  let previewUrl = "";
  let running = false;

  const byId = (id) => document.getElementById(id);

  /* UTC, not local time. A local-date key let the same browser reset its own
     allowance just by changing timezone, so "one quick check per day" was not
     actually true. The full checker's weekly key is already UTC; match it. */
  function dayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  /* The allowance is mirrored to IndexedDB and the higher count always wins, so
     clearing localStorage alone no longer hands the check back — the same
     property the weekly counter in app.js relies on. The mirror is refreshed
     asynchronously; until it resolves, `mirrored` holds the last value read, and
     a mirrored count is never lowered by a stale local read. */
  const IDB_NAME = "aicheck-quick-usage";
  const IDB_STORE = "usage";
  let mirrored = 0;
  let mirroredDay = "";

  function idbOpen() {
    return new Promise((resolve) => {
      try {
        if (!window.indexedDB) { resolve(null); return; }
        const request = window.indexedDB.open(IDB_NAME, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      } catch (_) { resolve(null); }
    });
  }

  function readRecord(raw) {
    try {
      const value = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (value && value.day === dayKey() && Number.isInteger(value.used)) {
        return Math.max(0, Math.min(DAILY_LIMIT, value.used));
      }
    } catch (_) { /* unreadable — treat as unused */ }
    return 0;
  }

  function localUsage() {
    try { return readRecord(localStorage.getItem(USAGE_KEY)); } catch (_) { return 0; }
  }

  function usage() {
    if (mirroredDay !== dayKey()) { mirrored = 0; mirroredDay = dayKey(); }
    return Math.max(mirrored, localUsage());
  }

  async function hydrateUsage() {
    const db = await idbOpen();
    if (!db) return;
    try {
      const tx = db.transaction(IDB_STORE, "readonly");
      const get = tx.objectStore(IDB_STORE).get(USAGE_KEY);
      get.onsuccess = () => {
        mirroredDay = dayKey();
        mirrored = Math.max(mirrored, readRecord(get.result));
        renderAvailability();
        try { db.close(); } catch (_) {}
      };
      get.onerror = () => { try { db.close(); } catch (_) {} };
    } catch (_) { try { db.close(); } catch (_) {} }
  }

  async function writeMirror(record) {
    const db = await idbOpen();
    if (!db) return;
    try {
      const tx = db.transaction(IDB_STORE, "readwrite");
      const store = tx.objectStore(IDB_STORE);
      const existing = store.get(USAGE_KEY);
      existing.onsuccess = () => {
        // Within a day the mirror only moves up.
        if (readRecord(existing.result) < record.used) {
          try { store.put(record, USAGE_KEY); } catch (_) {}
        }
      };
      existing.onerror = () => { try { store.put(record, USAGE_KEY); } catch (_) {} };
      const close = () => { try { db.close(); } catch (_) {} };
      tx.oncomplete = close; tx.onerror = close; tx.onabort = close;
    } catch (_) { try { db.close(); } catch (_) {} }
  }

  function consume() {
    const record = { day: dayKey(), used: DAILY_LIMIT };
    mirroredDay = record.day;
    mirrored = Math.max(mirrored, record.used);
    try { localStorage.setItem(USAGE_KEY, JSON.stringify(record)); } catch (_) {}
    void writeMirror(record);
  }

  function renderAvailability() {
    const remaining = Math.max(0, DAILY_LIMIT - usage());
    byId("usage").textContent = remaining
      ? "1 quick check available today"
      : "Today’s quick check used";
    byId("check-button").disabled = running || !selected || remaining === 0;
    byId("choose-button").disabled = running || remaining === 0;
    const quickEntry = byId("entry-quick");
    if (quickEntry) quickEntry.disabled = running || remaining === 0;
    byId("change-button").disabled = running || remaining === 0;
  }

  function readU16BE(bytes, offset) {
    return (bytes[offset] << 8) | bytes[offset + 1];
  }

  function readU32BE(bytes, offset) {
    return (((bytes[offset] << 24) >>> 0) +
      (bytes[offset + 1] << 16) +
      (bytes[offset + 2] << 8) +
      bytes[offset + 3]) >>> 0;
  }

  function dimensions(bytes) {
    if (bytes.length >= 24 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 &&
      bytes[2] === 0x4e && bytes[3] === 0x47) {
      return { width: readU32BE(bytes, 16), height: readU32BE(bytes, 20) };
    }
    if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) { offset += 1; continue; }
        while (bytes[offset] === 0xff) offset += 1;
        const marker = bytes[offset++];
        if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 ||
          (marker >= 0xd0 && marker <= 0xd7)) continue;
        if (offset + 1 >= bytes.length) break;
        const length = readU16BE(bytes, offset);
        if (length < 2 || offset + length > bytes.length) break;
        const isStartOfFrame =
          (marker >= 0xc0 && marker <= 0xc3) ||
          (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) ||
          (marker >= 0xcd && marker <= 0xcf);
        if (isStartOfFrame && length >= 7) {
          return {
            width: readU16BE(bytes, offset + 5),
            height: readU16BE(bytes, offset + 3),
          };
        }
        offset += length;
      }
    }
    return null;
  }

  async function validate(file) {
    if (!file || !["image/jpeg", "image/png"].includes(String(file.type || "").toLowerCase())) {
      return "Choose a JPEG or PNG image.";
    }
    if (!Number.isFinite(file.size) || file.size < 1 || file.size > MAX_BYTES) {
      return "Choose an image no larger than 50 MB.";
    }
    const header = new Uint8Array(await file.slice(0, Math.min(file.size, 1024 * 1024)).arrayBuffer());
    const size = dimensions(header);
    if (!size) return "That file does not contain a readable JPEG or PNG header.";
    if (
      size.width < 1 ||
      size.height < 1 ||
      size.width > MAX_SIDE ||
      size.height > MAX_SIDE ||
      size.width * size.height > MAX_PIXELS
    ) {
      return "Choose an image up to 16,384 px per side and 120 megapixels.";
    }
    return "";
  }

  function clearResult() {
    byId("result").hidden = true;
    byId("error").textContent = "";
  }

  const GENERATOR_HOSTS = Object.freeze([
    "chatgpt.com", "openai.com", "sora.com", "midjourney.com",
    "firefly.adobe.com", "gemini.google.com", "labs.google",
    "bing.com", "designer.microsoft.com", "ideogram.ai", "leonardo.ai",
    "runwayml.com", "dreamstudio.ai", "stability.ai", "grok.com",
    "copilot.microsoft.com", "meta.ai", "krea.ai", "recraft.ai",
    "getimg.ai", "clipdrop.co", "craiyon.com", "artbreeder.com",
    "pika.art", "lumalabs.ai", "x.ai", "canva.com",
  ]);

  function sourceContext() {
    const input = byId("source-url");
    const raw = String(input && input.value || "").trim().slice(0, 2048);
    if (!raw) return null;
    try {
      const parsed = new URL(
        /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : "https://" + raw
      );
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
      const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
      const knownGenerator = GENERATOR_HOSTS.some((host) =>
        hostname === host || hostname.endsWith("." + host)
      );
      return hostname ? { hostname, knownGenerator } : null;
    } catch (_) {
      return null;
    }
  }

  async function choose(file) {
    clearResult();
    const error = await validate(file);
    if (error) {
      selected = null;
      selectedDimensions = null;
      byId("error").textContent = error;
      renderAvailability();
      return;
    }
    const header = new Uint8Array(
      await file.slice(0, Math.min(file.size, 1024 * 1024)).arrayBuffer()
    );
    const size = dimensions(header);
    selected = file;
    selectedDimensions = size;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(file);
    byId("preview").src = previewUrl;
    byId("preview-wrap").hidden = false;
    byId("choose-button").hidden = true;
    renderAvailability();
  }

  // Quick-check decision: the decision head's calibrated probability (or, on
  // an older cached model, the strongest-region value through the same
  // measured likelihood table the app uses), plus the generator-site clue.
  const FALLBACK_KNOTS = [[0, -0.55], [5, -0.3], [30, 0], [70, 0.5], [90, 1.1], [95, 1.3], [99, 3.0], [100, 3.3]];
  const DEFAULT_CUTS = { aiHigh: 0.9, aiMedium: 0.75, realHigh: 0.1, realMedium: 0.25 };
  function knotValue(x) {
    if (x <= FALLBACK_KNOTS[0][0]) return FALLBACK_KNOTS[0][1];
    for (let i = 1; i < FALLBACK_KNOTS.length; i += 1) {
      if (x <= FALLBACK_KNOTS[i][0]) {
        const [x0, y0] = FALLBACK_KNOTS[i - 1], [x1, y1] = FALLBACK_KNOTS[i];
        return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
      }
    }
    return FALLBACK_KNOTS[FALLBACK_KNOTS.length - 1][1];
  }
  function quickDecision(result, likelihood, source) {
    const head = result.head && Number.isFinite(result.head.probability) ? result.head : null;
    let z;
    if (head) {
      const q = Math.min(0.995, Math.max(0.005, head.probability));
      z = Math.log(q / (1 - q));
    } else {
      z = knotValue(likelihood * 100);
    }
    const onlyPixel = !(source && source.knownGenerator);
    if (!onlyPixel) z += 1.5;
    z = Math.max(-4.6, Math.min(4.6, z));
    const p = Math.round(Math.max(0.01, Math.min(0.99, 1 / (1 + Math.exp(-z)))) * 100) / 100;
    const cuts = onlyPixel && head && head.cuts ? head.cuts : DEFAULT_CUTS;
    const lean = p >= 0.5 ? "ai" : "real";
    const confidence = lean === "ai"
      ? (p >= cuts.aiHigh ? "high" : p >= cuts.aiMedium ? "medium" : "low")
      : (p <= cuts.realHigh ? "high" : p <= cuts.realMedium ? "medium" : "low");
    return { lean, confidence, percent: Math.max(1, Math.min(99, Math.round(p * 100))),
      calibrated: !!head, views: head ? head.views : 0 };
  }

  async function run() {
    if (running || !selected || usage() >= DAILY_LIMIT) return;
    running = true;
    clearResult();
    byId("progress").hidden = false;
    renderAvailability();
    try {
      const detector = window.OnnxDetector;
      const result = detector && typeof detector.detect === "function"
        ? await detector.detect(selected)
        : null;
      if (!result || !Number.isFinite(result.aiLikelihood)) {
        byId("error").textContent =
          "The on-device model could not start in this browser. No quick check was used.";
        return;
      }
      const likelihood = Math.max(0, Math.min(1, result.aiLikelihood));
      const raw = Math.floor(likelihood * 100 + Number.EPSILON);
      const source = sourceContext();
      const decision = quickDecision(result, likelihood, source);
      byId("score").textContent = String(decision.percent);
      byId("score-unit").hidden = false;
      const noun = decision.lean === "ai" ? "AI-generated" : "real";
      byId("verdict").textContent = (decision.confidence === "low" ? "Leans " : "Likely ") + noun +
        " — " + decision.confidence + " confidence";
      byId("explanation").textContent = (decision.lean === "ai"
        ? "GAIC's read: this image is " + (decision.confidence === "low" ? "leaning" : "likely") +
          " AI-generated, with an estimated " + decision.percent + "% AI likelihood. Check the original source before you trust or share it."
        : "GAIC's read: this image is " + (decision.confidence === "low" ? "leaning" : "likely") +
          " real, with an estimated " + decision.percent + "% AI likelihood. Detectors can still be wrong, so check the source if it matters.") +
        (source && source.knownGenerator
          ? " You said it came from " + source.hostname + ", a site with AI-generation tools, which counted toward AI."
          : "");
      byId("technical-explanation").textContent = "Technical detail: " + (decision.calibrated
        ? "the decision head read " + (decision.views || "several") + " views of the image" +
          (result.head && result.head.kind === "composite" ? ", including the picture located inside the screenshot" : "") +
          "; its calibrated AI likelihood was " + Math.round(result.head.probability * 100) + "%."
        : "the decision head was unavailable, so this read uses the older strongest-region value of " + raw + "/100.") +
        " Confidence levels were set on generators and image sources the model never trained on. An estimate, not proof.";
      consume();
      byId("result").hidden = false;
      byId("result").focus();
    } catch (_) {
      byId("error").textContent =
        "The on-device check did not finish. No quick check was used.";
    } finally {
      running = false;
      byId("progress").hidden = true;
      renderAvailability();
    }
  }

  async function share() {
    const url = "https://gaicheck.com/is-this-ai";
    const data = {
      title: "Is This AI? — GAIC",
      text: "Try this private, on-device AI image checker. Results are signals, not proof.",
      url,
    };
    try {
      if (navigator.share) {
        await navigator.share(data);
        return;
      }
      await navigator.clipboard.writeText(url);
      byId("share-button").textContent = "Link copied";
      setTimeout(() => { byId("share-button").textContent = "Share this checker"; }, 1800);
    } catch (_) {}
  }

  /* The Quick scan entry scans as soon as a photo is chosen; the card's own
     Choose/Change buttons keep the pick-then-review behaviour. The flag is
     one-shot so a later pick from the card never silently auto-scans.

     This changes only WHEN run() is called, never WHETHER it may: run() still
     returns early on usage() >= DAILY_LIMIT, and openQuickScan() refuses to open
     the picker at all once the day is used. The daily limit is untouched. */
  let scanOnNextPick = false;
  function openPicker() {
    if (!running && usage() < DAILY_LIMIT) byId("image-input").click();
  }
  function openQuickScan() {
    if (running || usage() >= DAILY_LIMIT) return;
    scanOnNextPick = true;
    byId("image-input").click();
  }

  byId("year").textContent = String(new Date().getFullYear());
  byId("entry-quick").addEventListener("click", openQuickScan);
  byId("choose-button").addEventListener("click", openPicker);
  byId("change-button").addEventListener("click", openPicker);
  byId("check-button").addEventListener("click", run);
  byId("share-button").addEventListener("click", share);
  byId("image-input").addEventListener("change", (event) => {
    const file = event.target.files && event.target.files[0];
    const auto = scanOnNextPick;
    scanOnNextPick = false;
    if (file) {
      void choose(file).then(() => {
        // choose() refuses invalid files and leaves `selected` null, so an
        // auto-scan can never start on a file the validator rejected.
        if (auto && selected) {
          byId("checker").scrollIntoView({ block: "start", behavior: "smooth" });
          void run();
        }
      }, () => {});
    }
    event.target.value = "";
  });
  window.addEventListener("pagehide", () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, { once: true });
  renderAvailability();
  // Refresh from the durable mirror, then re-render. Until this resolves the
  // gate uses the local value, which can only ever be lower — so a stale read
  // withholds nothing it should not.
  void hydrateUsage();
})();
