# GAIC checker engine update — for every platform

This folder holds an accuracy update to the GAIC checker engine, measured
against the engine that shipped in GAIC 2.4.0.

Every GAIC platform runs the same web runtime: gaicheck.com, the iOS and
Android apps (Capacitor), the Windows and macOS desktop apps (Electron serves
the runtime from `resources/app`), and the Chrome extension. So a single set of
runtime files carries the update to all of them. Every check still runs on the
device.

**What the owner asked for, and what this update does:**

1. **Accuracy.** A new image decision head, and a calibrated text decision.
2. **No "inconclusive" results.** Every completed check ends with a lean and a
   confidence level.
3. **A scanning animation that is nice and intriguing.**
4. **Nothing else about the app's look changes.**
5. **Photos over 8 MB are accepted.**

## What changed

| Area | Before (2.4.0) | After |
| --- | --- | --- |
| **Every result** | photos below the 95/100 band: "Model result is inconclusive", "No rating"; video and screen: "Sampled frames are inconclusive"; text: a pattern band | a **lean** (AI-generated / real, or AI-written / human-written), a **confidence level** (high / medium / low, each measured on held-out data), and an **AI likelihood**, e.g. "Likely AI-generated — high confidence · AI likelihood: 93%". The evidence read stays as the "Technical read" line. Genuine failures (too little text, unreadable file, quota) stay errors |
| **Photo detection** | the model's own last layer, max over 8 crops; caught about 1 in 5 images from 2025–2026 generators | the same network and weights, read by a new **decision head** trained on GPT-Image, Nano Banana, Midjourney, Seedream and others, and on real photos, art, charts and screenshots. On held-out generator families: **67%** of AI images called AI, 4% of real images called AI (2.4.0 at the same false-lean rate: 28%) |
| **Screenshots** | 3% of AI screenshots flagged | **69%** called AI; 3% of real screenshots called AI |
| **Text** | 4 hand-set cues | the trained model (56 writing measurements + 2,500-term vocabulary); lean threshold set so ≤5% of human writing from unseen sources leans AI; high-confidence AI leans right 98.5–99.8% of the time |
| **Mixed and disguised text** | a pasted AI section barely moved a human document's score; hidden characters were silently ignored | a human-leaning text also names a section that reads strongly machine-written (29% of 250-word and 54% of 400-word AI pastes found, ≤0.5% false reports); invisible characters and look-alike letters get a notice |
| **Video / screen** | 8 frames, warning only at ≥95 | the same 8 frames read by the decision head; the lean follows the median frame, with a flatter, more cautious calibration (see RESULTS) |
| **Large photos** | 8 MB / 24 MP cap | **50 MB / 120 MP**; photos above 24 MP are decoded to a downscaled copy, and smaller photos are scanned exactly as before |
| **Scanning panel** | fixed animation with timed narration, some of it for checks that did not run | a live viewfinder: the person's own photo develops from grey behind a sweeping beam, bracket boxes lock onto each view the model actually reads, a "picture" box marks a picture found in a screenshot, sampled video/screen frames appear as they are read, and text shows an excerpt with its real passage and word counts; one real progress bar; a still design for reduced motion. Everything outside the panel is pixel-identical |
| **Rewriting** | 26/77 reviewed cases; could corrupt text | 77/77; untouched text stays byte-identical |

Measured results are in [RESULTS.md](RESULTS.md). The model cards are
[runtime/models/GAIC-TEXT-MODEL.md](runtime/models/GAIC-TEXT-MODEL.md) and
[runtime/models/AICHECK-IMAGE-MODEL.md](runtime/models/AICHECK-IMAGE-MODEL.md).

## Files

`runtime/` mirrors the web runtime root, so each file drops in at the same
relative path. `runtime/FILES.txt` lists them.

| File | Change |
| --- | --- |
| `models/aicheck-ai-image-v3-fp16.onnx` | **new** (43 MB): the v2 network and weights, plus a `features` output for the decision head |
| `image-head.js` | **new**: the image decision head and its calibration tables (28 KB) |
| `model-config.js` | points at the v3 model file |
| `text-detector.js` | **new**: text engine, weights, and the lean/confidence decision; machine-like section and disguise-trick checks; a language check, so text in another language is not scored by the English model |
| `app.js` | the decisive result layer (lean, confidence, AI likelihood) for text, photo, screenshot, video, and screen results; the text engine; the scanning viewfinder; blank-frame and screen-frame handling; the 50 MB / 120 MP photo limits; loading the photo model while a file is chosen; photo metadata clues (more tool names, never read from captions; generation settings in the EXIF comment or XMP; China's AI-content label) |
| `provenance-verdict.mjs` | `decideImageLean`: combines the pixel reading with Content Credential and metadata clues; signed AI-origin and trusted capture credentials decide outright; undecided headlines renamed; China's AI-content label in the evidence read and the lean |
| `detector-worker.js` | the decision head (per view, averaged, calibrated per scan kind); scan v6 picture reading; progress messages for the viewfinder; downscaled decoding above 24 MP; a `warm` message that loads the model without a reply. The 2.4.0 v5 functions are unchanged and pinned by tests |
| `onnx-detector.js` | the same for the iOS 15 path; `detect(file, { onProgress })`; the large-photo decode hint; `warm()`, which starts loading the model in the worker when a file is being chosen (the first photo check in the desktop app went from 7.7–8.4 s to 5.1–5.7 s with a 3 s pause before Check) |
| `ai-detector.html`, `styles.css` | the viewfinder layers and `.analyzing*` rules only; the score placeholder reads "Not scored" |
| `is-this-ai.js`, `is-this-ai.html` | the quick-check page gives the same lean and confidence and accepts the same photo sizes |
| `native.js` | one sentence about converted HEIC photos |
| `writing-assist.js` | rewriter v2 |
| `support.html` | the accuracy section now states the measured leans and confidence levels |
| `models/*.md` | model cards; `models/README.md` now describes the v3 model file |

`patches/gaic-engine-v2.patch` holds the text files as a reviewable unified
diff against the 2.4.0 runtime. Binary files are not in the patch:
`apply-engine.sh` copies the v3 model file.

## Shipping it to every platform

1. In the GAIC source repository (the one that builds
   `desktop-build-manifest.json`), apply the update to the web runtime folder:

   ```sh
   engine/tools/apply-engine.sh <source-repo>/<web-runtime-folder>
   # or, if those files have moved on since 2.4.0:
   git -C <source-repo> apply -3 --directory=<web-runtime-folder> <this-repo>/engine/patches/gaic-engine-v2.patch
   cp engine/runtime/models/aicheck-ai-image-v3-fp16.onnx <source-repo>/<web-runtime-folder>/models/
   ```

   The script refuses to overwrite files that changed after 2.4.0, then runs
   the engine tests against the target.
2. Add `text-detector.js`, `image-head.js`, and
   `models/aicheck-ai-image-v3-fp16.onnx` to any runtime file list your build
   keeps: the desktop build manifest, the extension's file list, the Capacitor
   copy step, and any service-worker precache. The v2 model file is no longer
   loaded and can be dropped from bundles.
3. Optional: raise the native share-sheet image cap to match. It is 8 MB in
   `AICheckEntryPlugin` (Android) and the iOS App Intent, and privacy.html
   describes it. The in-app picker, the web page, and the desktop app already
   take 50 MB.
4. Run your normal release for each platform:
   * **Web:** deploy to Vercel.
   * **iOS and Android:** `npx cap sync`, then archive and submit.
   * **Windows and macOS:** run the electron-builder release, which regenerates
     `desktop-build-manifest.json`, then upload the installers to this
     repository's Releases. Without the source repository,
     [desktop/README.md](desktop/README.md) rebuilds both downloads from the
     2.4.0 installers with this update and tests them on real Windows and
     macOS machines.
   * **Chrome extension:** rebuild it with the updated worker files.
5. Decide on the terms. They still call the text tool "an unvalidated,
   English-focused pattern heuristic" and disclaim correctness. That is still
   true, but results now state a lean with a measured confidence, so review
   the wording before release.

## Tests

```sh
GAIC_RUNTIME=<full runtime folder> node --test engine/test/*.test.mjs
```

Against `engine/runtime` alone, the tests that need unchanged runtime files
(for example `container-provenance.mjs`) are skipped. The tests need no
dependencies. They cover:

* **Decisions:**
  * every scored text gets a lean and a confidence;
  * the lean and the displayed likelihood never disagree at 50%;
  * signed credentials decide;
  * weak metadata alone never decides, and cannot flip a warning-band pixel
    reading;
  * no shipped result wording is undecided.
* **Image worker, end to end:**
  * photo, located-picture screenshot, video frame, and missing-head fallback
    through the real message handler;
  * large photos decode downscaled;
  * the shipped head and calibration are complete and monotone.
* **Existing guarantees:**
  * the rewriting benchmark;
  * the text model's determinism and evasion hygiene;
  * picture localization;
  * the pinned 2.4.0 photo-scan functions;
  * the video and screen sampling contract;
  * no network calls in the on-device-only block.
* **Scanning viewfinder:**
  * progress never resolves a request;
  * stage order and dwell;
  * preview URLs are revoked;
  * no preview or rectangle reaches a result;
  * every animation has a reduced-motion state.
