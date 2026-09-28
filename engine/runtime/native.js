/* NIRO — native bridge over Capacitor plugins. Uses real device features on
   iOS/Android; degrades gracefully to web APIs (or no-ops) in a browser.
   Accessed via window.Native.  */
(function () {
  const Cap = window.Capacitor;
  const P = (Cap && Cap.Plugins) || {};
  const native = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
  const ENTRY_IMAGE_BYTES = 8 * 1024 * 1024;
  const ENTRY_TEXT_CHARACTERS = 100000;
  const ENTRY_TEXT_BYTES = 256 * 1024;
  const ENTRY_IMAGE_TYPES = Object.freeze({
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
  });
  const ENTRY_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const LAUNCH_URL_SESSION_KEY = "aicheck.launch-url-consumed.v1";
  let entryProcessing = false;
  let entryQueued = false;
  let entryRetryTimer = 0;

  function exactScannerUrl(value) {
    if (typeof value !== "string" || !/^aicheck:\/\/scan\/?$/i.test(value)) return false;
    try {
      const url = new URL(value);
      return url.protocol.toLowerCase() === "aicheck:" &&
        url.hostname.toLowerCase() === "scan" &&
        !url.port && !url.username && !url.password &&
        (!url.pathname || url.pathname === "/") &&
        !url.search && !url.hash;
    } catch (e) { return false; }
  }

  function onDetectorPage() {
    return /(^|\/)ai-detector\.html$/.test(window.location.pathname || "");
  }

  function openDetectorPage() {
    if (onDetectorPage()) return true;
    // Keep a pending Android share in the native plugin while the WebView moves
    // to the checker. No shared text or media is put in the URL or web storage.
    window.location.assign("ai-detector.html");
    return false;
  }

  function entryNotice(message, error) {
    const card = document.getElementById("detector-card");
    if (!card) return;
    let notice = document.getElementById("native-entry-notice");
    if (!notice) {
      notice = document.createElement("p");
      notice.id = "native-entry-notice";
      notice.setAttribute("role", "status");
      notice.setAttribute("aria-live", "polite");
      notice.setAttribute("tabindex", "-1");
      notice.style.cssText = "margin:0 0 14px;padding:12px 14px;border:1px solid #9ccce9;border-radius:12px;background:#eef8ff;color:#123f5d;font-weight:650;line-height:1.45";
      card.insertBefore(notice, card.firstChild);
    }
    notice.textContent = String(message || "GAIC is ready.");
    notice.style.borderColor = error ? "#cf7272" : "#9ccce9";
    notice.style.background = error ? "#fff3f3" : "#eef8ff";
    notice.style.color = error ? "#711f1f" : "#123f5d";
    const live = document.getElementById("a11y-status");
    if (live) {
      live.setAttribute("aria-live", error ? "assertive" : "polite");
      live.textContent = notice.textContent;
    }
  }

  function readyScanner() {
    return onDetectorPage() && window.AICheck &&
      typeof window.AICheck.switchTab === "function" &&
      window.AICheck.nativeEntryReady === true &&
      document.getElementById("file-input") && document.getElementById("text-input");
  }

  function waitForScanner(timeoutMs) {
    const started = Date.now();
    return new Promise(resolve => {
      function check() {
        if (readyScanner()) { resolve(true); return; }
        if (Date.now() - started >= timeoutMs) { resolve(false); return; }
        setTimeout(check, 40);
      }
      // app.js wires its input listener from a later DOMContentLoaded handler.
      // A short turn ensures that handler is installed before we dispatch.
      setTimeout(check, 0);
    });
  }

  function textByteLength(value) {
    try { return new TextEncoder().encode(value).byteLength; }
    catch (e) { return new Blob([value]).size; }
  }

  function safeCopiedFileUrl(value, token, extension) {
    if (typeof value !== "string" || !ENTRY_TOKEN.test(token || "")) return false;
    try {
      const url = new URL(value);
      const segments = url.pathname.split("/").filter(Boolean);
      const cacheDirectory = segments.length >= 3 ? segments[segments.length - 3].toLowerCase() : "";
      return url.protocol === "file:" && !url.hostname && !url.username && !url.password &&
        !url.search && !url.hash &&
        (cacheDirectory === "cache" || cacheDirectory === "caches") &&
        segments[segments.length - 2] === "aicheck-entry" &&
        segments[segments.length - 1] === token + extension;
    } catch (e) { return false; }
  }

  async function clearConsumedEntry(token) {
    if (!P.AICheckEntry || typeof P.AICheckEntry.completePending !== "function") return false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await P.AICheckEntry.completePending({ token: token });
        if (result && result.cleared === true) return true;
      } catch (e) {}
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 40 * (attempt + 1)));
    }
    return false;
  }

  async function applyNativeEntry(entry) {
    if (!entry || typeof entry.kind !== "string") {
      entryNotice("GAIC could not safely open that shared item.", true);
      return;
    }
    if (entry.kind === "none") return;
    if (entry.kind === "error") {
      entryNotice(typeof entry.message === "string" && entry.message.length <= 240
        ? entry.message
        : "GAIC could not safely open that shared item.", true);
      return;
    }
    if (entry.kind === "scan") {
      window.AICheck.switchTab("image", true);
      entryNotice("Scanner opened. Choose a photo or video when you are ready; nothing is captured automatically.", false);
      const button = document.getElementById("quick-scan-btn");
      if (button) button.focus();
      return;
    }
    if (entry.kind === "text") {
      const text = typeof entry.text === "string" ? entry.text : "";
      const explicitShortcutRun = entry.autoRun === true;
      if (!text.trim() || text.length > ENTRY_TEXT_CHARACTERS || textByteLength(text) > ENTRY_TEXT_BYTES) {
        entryNotice("That shared text was empty or too large. Share plain text under 100,000 characters and 256 KB.", true);
        return;
      }
      const input = document.getElementById("text-input");
      window.AICheck.switchTab("text", true);
      input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      if (explicitShortcutRun) {
        entryNotice("Checking the text supplied to your GAIC Shortcut on this device.", false);
        await window.AICheck.run();
      } else {
        entryNotice("Shared text is ready. Review it, then tap Check text patterns; GAIC did not run automatically.", false);
        input.focus();
      }
      return;
    }
    if (entry.kind !== "image") {
      entryNotice("GAIC rejected an unsupported shared item.", true);
      return;
    }

    const mime = typeof entry.mimeType === "string" ? entry.mimeType.toLowerCase() : "";
    const extension = ENTRY_IMAGE_TYPES[mime];
    const token = typeof entry.token === "string" ? entry.token : "";
    const size = Number(entry.size);
    const explicitShortcutRun = entry.autoRun === true;
    const convertedFromHEIF = entry.convertedFromHEIF === true;
    if (!extension || !Number.isSafeInteger(size) || size <= 0 || size > ENTRY_IMAGE_BYTES ||
        !safeCopiedFileUrl(entry.url, token, extension)) {
      entryNotice("GAIC rejected an invalid shared-image handoff.", true);
      return;
    }

    const localUrl = Cap && typeof Cap.convertFileSrc === "function"
      ? Cap.convertFileSrc(entry.url)
      : "";
    if (!localUrl) {
      entryNotice("GAIC could not open its protected copy of that image.", true);
      return;
    }
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 10000) : 0;
    try {
      const response = await fetch(localUrl, {
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: controller ? controller.signal : undefined,
      });
      if (!response.ok) throw new Error("local copy unavailable");
      const blob = await response.blob();
      if (blob.size !== size || blob.size > ENTRY_IMAGE_BYTES ||
          (blob.type && blob.type !== "application/octet-stream" && blob.type.toLowerCase() !== mime)) {
        throw new Error("local copy changed");
      }
      if (typeof DataTransfer !== "function") throw new Error("file handoff unavailable");
      const file = new File([blob], "shared-image" + extension, { type: mime });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const selectedFile = transfer.files[0];
      if (!selectedFile) throw new Error("file handoff unavailable");
      if (convertedFromHEIF) {
        // Mark the exact File object returned by WebKit's FileList; some engines
        // do not preserve expando properties from the object added above.
        Object.defineProperty(selectedFile, "aicheckInputContext", {
          value: "heif-derived-jpeg", enumerable: false, configurable: false, writable: false,
        });
        if (selectedFile.aicheckInputContext !== "heif-derived-jpeg") {
          throw new Error("conversion context unavailable");
        }
      }
      const input = document.getElementById("file-input");
      window.AICheck.switchTab("image", true);
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      if (explicitShortcutRun) {
        entryNotice(convertedFromHEIF
          ? "This HEIC/HEIF image was converted locally to JPEG so GAIC can read it. The picture itself is checked; the original file's Content Credentials and metadata were not read."
          : "Checking the image supplied to your GAIC Shortcut on this device.", false);
        await window.AICheck.run();
      } else {
        entryNotice("Shared image is ready. Review it, then tap Check photo; GAIC did not run automatically.", false);
        const check = document.getElementById("check-btn");
        if (check) check.focus();
      }
    } catch (e) {
      entryNotice("GAIC could not safely read that shared image. Try sharing one supported image under 8 MB.", true);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function processPendingSoon() {
    if (entryProcessing) {
      entryQueued = true;
      return;
    }
    clearTimeout(entryRetryTimer);
    entryRetryTimer = setTimeout(processPendingEntry, 30);
  }

  async function processPendingEntry() {
    if (entryProcessing || !native || !P.AICheckEntry) return;
    entryProcessing = true;
    let token = "";
    try {
      const peek = await P.AICheckEntry.peekPending();
      if (!peek || !peek.available) return;
      if (!openDetectorPage()) return;
      if (!(await waitForScanner(5000))) {
        entryNotice("GAIC could not finish opening the scanner. Reopen the app and try again.", true);
        return;
      }
      const entry = await P.AICheckEntry.consumePending();
      token = entry && typeof entry.token === "string" ? entry.token : "";
      await applyNativeEntry(entry);
    } catch (e) {
      if (onDetectorPage()) entryNotice("GAIC could not safely open that shared item.", true);
    } finally {
      if (token && ENTRY_TOKEN.test(token)) {
        if (!(await clearConsumedEntry(token))) {
          entryNotice("GAIC finished the handoff but could not remove its protected temporary copy yet. Close and reopen GAIC to retry cleanup.", true);
        }
      }
      entryProcessing = false;
      if (entryQueued) {
        entryQueued = false;
        processPendingSoon();
      }
    }
  }

  async function openFromExactUrl(value) {
    // A URL can only request the scanner screen. It is never fetched, treated as
    // media, or used to trigger a check.
    if (!exactScannerUrl(value)) return;
    if (!openDetectorPage()) return;
    if (!(await waitForScanner(5000))) return;
    window.AICheck.switchTab("image", true);
    entryNotice("Scanner opened. Choose something when you are ready; GAIC never watches your screen in the background.", false);
    const button = document.getElementById("quick-scan-btn");
    if (button) button.focus();
  }

  function installNativeEntryBridge() {
    if (!native) return;
    try {
      if (P.App && P.App.addListener) {
        P.App.addListener("appUrlOpen", data => openFromExactUrl(data && data.url));
        P.App.addListener("resume", processPendingSoon);
      }
      if (P.App && P.App.getLaunchUrl) {
        let shouldReadLaunchUrl = true;
        try {
          if (window.sessionStorage && window.sessionStorage.getItem(LAUNCH_URL_SESSION_KEY) === "1") {
            shouldReadLaunchUrl = false;
          } else if (window.sessionStorage) {
            window.sessionStorage.setItem(LAUNCH_URL_SESSION_KEY, "1");
          }
        } catch (e) {}
        if (shouldReadLaunchUrl) {
          Promise.resolve(P.App.getLaunchUrl()).then(data => openFromExactUrl(data && data.url)).catch(() => {});
        }
      }
      if (P.AICheckEntry && P.AICheckEntry.addListener) {
        P.AICheckEntry.addListener("entryAvailable", processPendingSoon);
        processPendingSoon();
      }
    } catch (e) {}
  }

  function init() {
    if (!native) return;
    // Capacitor's LIGHT setting retains dark system-bar glyphs against this
    // app's light surface on current Android WebViews. iOS is pinned to
    // UIStatusBarStyleDarkContent in Info.plist.
    try { P.StatusBar && P.StatusBar.setStyle({ style: "LIGHT" }); } catch (e) {}
    try { P.StatusBar && P.StatusBar.setOverlaysWebView && P.StatusBar.setOverlaysWebView({ overlay: false }); } catch (e) {}
    try { P.StatusBar && P.StatusBar.setBackgroundColor && P.StatusBar.setBackgroundColor({ color: "#fdfaf7" }); } catch (e) {}
    try { if (P.SplashScreen) setTimeout(() => { try { P.SplashScreen.hide(); } catch (e) {} }, 250); } catch (e) {}
    // Android hardware back button
    try { P.App && P.App.addListener && P.App.addListener("backButton", () => {
      if (window.history.length > 1) window.history.back(); else if (P.App.exitApp) P.App.exitApp();
    }); } catch (e) {}
  }

  // Real Taptic Engine / vibration on device; navigator.vibrate on web.
  function haptic(kind) {
    if (native && P.Haptics) {
      try { P.Haptics.impact({ style: kind === "heavy" ? "HEAVY" : kind === "light" ? "LIGHT" : "MEDIUM" }); return; } catch (e) {}
    }
    try { if (navigator.vibrate) navigator.vibrate(kind === "heavy" ? [15, 30, 15] : 10); } catch (e) {}
  }

  // Native OS share sheet on device; Web Share API in supporting browsers.
  async function share(opts) {
    if (native && P.Share) { try { await P.Share.share(opts); return true; } catch (e) { return false; } }
    if (navigator.share) { try { await navigator.share(opts); return true; } catch (e) { return false; } }
    return false;
  }

  // Convert Capacitor 8's efficient local media URL to the data URL expected by
  // the existing detector. Keeping the photo at 2048px/85% JPEG avoids creating
  // a large base64 string that the 8 MB cloud endpoint will reject.
  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("Couldn't read the photo."));
      reader.readAsDataURL(blob);
    });
  }

  async function mediaToDataUrl(media) {
    if (!media) return null;
    if (media.dataUrl) return media.dataUrl; // Capacitor's legacy result.
    // Newer native Camera results normally include `webPath`, but some Android
    // and iOS paths only expose a file URI. `convertFileSrc` turns that into a
    // URL the bundled WebView is allowed to fetch. Try the direct web path
    // first, then its converted native equivalent, without exposing the file
    // outside the app.
    const candidates = [];
    if (media.webPath) candidates.push(media.webPath);
    const nativeUri = media.uri || media.path;
    if (nativeUri && Cap && typeof Cap.convertFileSrc === "function") {
      candidates.push(Cap.convertFileSrc(nativeUri));
    }
    if (nativeUri) candidates.push(nativeUri);
    for (const url of [...new Set(candidates)]) {
      try {
        const response = await fetch(url);
        if (response.ok) return blobToDataUrl(await response.blob());
      } catch (e) { /* Try the next platform-safe URL. */ }
    }
    throw new Error("Couldn't read the selected photo.");
  }

  // Resolve CAMERA permission before opening the camera so the first capture
  // is not lost behind a grant dialog. Gallery selection never enters this
  // bridge: app.js uses the WebView's system file picker because Capacitor
  // Camera 8.2 requests read/write access to the whole iOS photo library.
  async function ensureMediaPermission(source) {
    try {
      if (!P.Camera || typeof P.Camera.checkPermissions !== "function") return;
      if (source !== "camera") return;
      const key = "camera";
      const status = await P.Camera.checkPermissions();
      const current = status && status[key];
      if (current === "granted" || current === "limited") return;
      if (typeof P.Camera.requestPermissions === "function") {
        await P.Camera.requestPermissions({ permissions: [key] });
      }
    } catch (e) { /* fall through — the picker itself may still prompt */ }
  }

  function isPickCancel(e) {
    return /cancel|denied|dismiss/i.test(String((e && e.message) || e || ""));
  }

  async function attemptPick(source) {
    const photoOptions = {
      quality: 85, targetWidth: 2048, targetHeight: 2048,
      correctOrientation: true, includeMetadata: true, saveToGallery: false,
    };
    if (source === "camera" && typeof P.Camera.takePhoto === "function") {
      return await mediaToDataUrl(await P.Camera.takePhoto(photoOptions));
    }
    // Capacitor < 8 fallback. It is retained solely for an old installed
    // shell's camera path; gallery selection stays on the permission-minimal
    // WebView file picker in every shell.
    const p = await P.Camera.getPhoto({ quality: 85, width: 2048, height: 2048,
      allowEditing: false, resultType: "dataUrl", correctOrientation: true, saveToGallery: false,
      source: "CAMERA" });
    return (p && p.dataUrl) || null;
  }

  // Native camera capture → data URL. Returns null on web (caller falls back to
  // <input type=file>). Gallery selection is handled in app.js.
  async function pickImage(source) {
    if (source !== "camera") return null;
    if (native && P.Camera) {
      await ensureMediaPermission(source);
      try {
        return await attemptPick(source);
      } catch (e) {
        // A user cancel stays silent. Anything else (e.g. the picker torn down
        // by the first-run permission dialog) gets exactly one clean retry so
        // the first granted pick still lands.
        if (isPickCancel(e)) return null;
        try { return await attemptPick(source); } catch (e2) { return null; }
      }
    }
    return null;
  }

  window.Native = {
    init, haptic, share, pickImage,
    get isNative() { return native; },
    get canShare() { return !!(native || (typeof navigator !== "undefined" && navigator.share)); },
    get canCamera() { return !!(native && P.Camera); },
  };
  installNativeEntryBridge();
  if (document.readyState !== "loading") init(); else document.addEventListener("DOMContentLoaded", init);
})();
