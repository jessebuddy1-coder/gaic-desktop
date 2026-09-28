# GAIC checker engine v2 — accuracy update for every platform

This folder holds an accuracy update to the GAIC checker engine, measured
against the engine that shipped in GAIC 2.4.0.

Every GAIC platform runs the same web runtime: gaicheck.com, the iOS and
Android apps (Capacitor), the Windows and macOS desktop apps (Electron serves
the runtime from `resources/app`), and the Chrome extension. So a single set
of runtime files carries the update to all of them.

Nothing else changes. The UI, verdict wording, result format, quotas,
privacy behavior, the bundled image model file, and the cloud path all stay
the same, and every check still runs on the device. The only other
user-visible edits are the in-progress scanning panel (below), the result
explanations, which describe what was measured, and one support-page
sentence (listed below).

## What changed

| Area | Before (2.4.0) | After (engine v2) |
| --- | --- | --- |
| **Text AI check** | 4 hand-set cues, score clamped 15–85 | trained on-device model (56 writing measurements + 2,500-term vocabulary), scored per passage, with an explanation of what drove it; same 15–85 scale, same three verdicts |
| **Photo / screenshot scan** | max over 8 fixed crops of the whole frame, including the phone UI, page, or player bars around a picture | ordinary photos: **unchanged**, the same 8-crop scan byte-for-byte. Screenshots and letterboxed frames: the scanner also locates the picture inside the interface and reads it at the scale the model was trained on (scan v6), and the higher of the two readings is used; same model file |
| **Video scan** | 8 evenly spaced frames, blank or fade frames scored as-is | same 8 frames and the same per-frame scan, but a blank or fade frame is re-sampled nearby within its slot instead of being scored |
| **Screen scan** | 8 frames at 1024 px | 8 frames at up to 1600 px so small pictures keep detail; blank start frames are skipped; unchanged frames reuse the previous score |
| **Scanning panel** | a fixed animation with timed narration, some of it for checks that did not run (a screen check "looked for signed creation history"); video and screen showed two progress bars | a viewfinder showing the person's own photo, sampled frame, or text: the picture develops from grey behind a sweeping beam, a bracket box locks onto each view the model is actually reading, a "picture" box marks a picture found inside a screenshot, and the narration follows real pipeline events in order. One progress bar fed by real progress; a still design for reduced motion. Everything outside the panel is pixel-identical |
| **Rewriting (writing assist)** | 26/77 reviewed cases correct; could corrupt text (`an additional` → `an more`, `U.S.A` → `U. S. A`, flattened indentation, edited quotes) | 77/77; untouched text stays byte-identical; quotes, code, URLs, and emails are protected; verbs keep their tense; a/an and sentence capitals are fixed at edit sites |

Measured results are in [RESULTS.md](RESULTS.md). The text model card is
[runtime/models/GAIC-TEXT-MODEL.md](runtime/models/GAIC-TEXT-MODEL.md), and
the image scan changes are recorded in
[runtime/models/AICHECK-IMAGE-MODEL.md](runtime/models/AICHECK-IMAGE-MODEL.md).

## Files

`runtime/` mirrors the web runtime root, so each file drops in at the same
relative path.

| File | Change |
| --- | --- |
| `text-detector.js` | **new**: text engine and embedded weights (~75 KB) |
| `ai-detector.html` | one added line: `<script src="text-detector.js"></script>` before `app.js`; the scanning panel gains a viewfinder layer, a flash layer, and a visible/announced pair of stage spans |
| `app.js` | text check calls the new engine, falling back to the old heuristic if it is missing; explanation for screenshot results; blank-frame and screen-frame handling; video frames are marked to keep the 2.4.0 scan; the scanning viewfinder (`setAnalyzing`/`finishAnalyzing`, an event-driven stage queue, and one-line hooks in the pipeline) |
| `detector-worker.js` | adds the scan v6 composite-frame reading; the v5 functions are unchanged and pinned by tests; progress messages (phase, position, and view rectangle) before each view is read |
| `onnx-detector.js` | the same composite-frame reading for the iOS 15 compatibility path; optional `detect(file, { onProgress })`, where progress never settles a request |
| `styles.css` | only the `.analyzing*` panel rules: the viewfinder's compositor-only animations and their reduced-motion states |
| `writing-assist.js` | rewriter v2 (same API and modes) |
| `support.html` | one sentence: the text tool is now described as a trained pattern model, not a "hand-built heuristic" |
| `models/GAIC-TEXT-MODEL.md` | **new** model card |
| `models/AICHECK-IMAGE-MODEL.md` | scan v6 section and results |

`patches/gaic-engine-v2.patch` holds the same change as a reviewable
unified diff against the 2.4.0 runtime.

## Shipping it to every platform

1. In the GAIC source repository (the one that builds `desktop-build-manifest.json`),
   apply the update to the web runtime folder:

   ```sh
   engine/tools/apply-engine.sh <source-repo>/<web-runtime-folder>
   # or, if those files have moved on since 2.4.0:
   git -C <source-repo> apply -3 --directory=<web-runtime-folder> <this-repo>/engine/patches/gaic-engine-v2.patch
   ```

   The script refuses to overwrite files that changed after 2.4.0, then runs
   the engine tests against the target.
2. Add `text-detector.js` to any runtime file list your build scripts keep,
   such as the desktop build manifest, the extension's file list, or a
   Capacitor copy step.
3. Run your normal release for each platform:
   * **Web:** deploy to Vercel.
   * **iOS and Android:** `npx cap sync`, then archive and submit.
   * **Windows and macOS:** run the electron-builder release, which regenerates
     `desktop-build-manifest.json`, then upload the installers to this
     repository's Releases.
   * **Chrome extension:** rebuild it with the updated worker files.
4. Optionally, update the terms, which still call the text tool "an
   unvalidated, English-focused pattern heuristic". The wording is still
   accurate, because the tool is still unvalidated as an authorship detector,
   so the terms version date was left alone.

## Tests

```sh
GAIC_RUNTIME=engine/runtime node --test engine/test/*.test.mjs
```

The tests need no dependencies. They cover:

* the rewriting benchmark and rewriter invariants;
* the text model's bands, determinism, evasion hygiene, and `app.js`
  fallback;
* picture localization on synthetic screenshots and letterboxed frames;
* that the 2.4.0 photo-scan functions are byte-for-byte unchanged (source hashes pinned);
* exact parity of the v6 center view with the reviewed v5 official view;
* that the worker and the iOS 15 path share one composite-frame plan;
* the video and screen sampling contract;
* that the on-device-only block contains no network calls;
* the scanning viewfinder: progress never resolves a request, stages keep
  their order and dwell, preview URLs are revoked, no preview or rectangle
  reaches a result, and every animation has a reduced-motion state.
