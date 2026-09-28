# Engine evaluation — how the numbers were produced

Working layout the scripts expect (paths are relative to the script folder):

```
work/                 these scripts, plus
  runtime/            the engine v2 runtime (engine/runtime overlaid on 2.4.0)
  runtime-orig/       the 2.4.0 runtime, extracted from GAIC-Setup-2.4.0-x64.exe
                      (7z x the installer, then 7z x $PLUGINSDIR/app-64.7z; use resources/app)
data/text/            cloned text corpora (see below)
data/img/, data/video/  image and video sets (see below)
```

Node 22, Python 3.11 with numpy/scipy/scikit-learn/Pillow, `onnxruntime-node`
and `@napi-rs/canvas` (install onnxruntime-node with
`ONNXRUNTIME_NODE_INSTALL_CUDA=skip`), and Playwright's Chromium for
`make_screens.mjs` and `e2e.mjs`.

Everything here is reproducible from public sources. No third-party text or
image is committed to this repository; the scripts rebuild the sets from the
original locations. Per-item scores and summaries are in `results/`.

## Text detector

| Step | Script | Notes |
| --- | --- | --- |
| 1. Clone corpora | see list below | `GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 <repo>` into `data/text/` |
| 2. Build corpus | `build_corpus.py` | unify labels; trim every sample to its last full sentence; dedupe; mark license (`train_ok`) |
| 3. Sample pool | `build_corpus.py` output → pool | ≤1,500 per corpus/label/generator/variant/domain cell |
| 4. Featurize | `featurize.mjs` | runs the **shipped** `text-detector.js` engine in Node, so training and production share one implementation |
| 5. Baseline | `baseline.mjs` | runs the **exact v2.4.0** `analyzeText`, sliced verbatim from the 2.4.0 `app.js` |
| 6. Train + LOCO | `train_final.py 2500 8` | C = 0.003 logistic regression; lexicon pruned inside every fold; leave-one-corpus-out scores |
| 7. Bands | `bands.py` | band edges from out-of-fold scores |
| 8. Build | `build_text_engine.py` | embeds the weights in `text-detector.js` |
| 9. Report | `text_eval_final.mjs`, `text_report.py`, `text_loco_table.py` | held-out corpora, LOCO table, old-vs-new |

Training corpora (permissive licenses): `baoguangsheng/truth-mirror` (HART,
RAID subset; MIT), `baoguangsheng/glimpse` and `baoguangsheng/fast-detect-gpt`
(MIT), `vivek3141/ghostbuster-data` (CC BY 3.0), `ryuryukke/OUTFOX`
(Apache-2.0), `botianzhe/CHEAT` (MIT), `Jiaqi-Chen-00/ImBD` (Apache-2.0).

Held-out only (no license, never trained on): `NLP2CT/DetectRL`,
`Weixin-Liang/ChatGPT-Detector-Bias`, `huhailinguist/ArguGPT`.

## Rewriting (writing assist)

`../test/writing-cases.mjs` holds 77 reviewed input → expected-output cases:
wordy phrases, inflections, a/an agreement, sentence capitals, and "must not
touch" cases (abbreviations such as U.S.A., file names, indentation, direct
quotes, URLs, code). Run `node ../test/writing-assist.test.mjs`. The v2.4.0
rules pass 26/77; v2 passes 77/77. The cases were written alongside the new
rules, so treat 77/77 as a regression floor, not a population accuracy.

## Image, screenshot, video, and screen scan

| Step | Script | Notes |
| --- | --- | --- |
| Real photos | Open Images V4 validation (CC BY 2.0, S3 mirror) | 520 random images, rotation 0 |
| AI images | GitHub galleries of generator outputs | GPT-4o / gpt-image (`songguoxs/gpt4o-image-prompts`, `jamez-bondos/awesome-gpt4o-images` `example_*` only), Gemini 2.5 Flash Image (`PicoTrex/Awesome-Nano-Banana-images`, `output*` only — never the real `input.*` photos), hand-checked samples from Kolors, HunyuanDiT, Stable Diffusion, PixArt-α, SGM |
| Screenshots | `make_screens.mjs` | every image rendered by headless Chromium inside six mock UIs (dark AI chat, light generator portal, phone social feed, phone photo viewer, news article, letterboxed player) at real device pixel ratios |
| Old scanner | `worker_harness.mjs` | runs the **unmodified** v2.4.0 `detector-worker.js` in Node (Skia canvas + native ONNX Runtime) |
| New scanner | `worker_harness.mjs` | same harness, v6 worker |
| Plan search | `explore_views.cjs`, `explore_analyze.py` | stores per-view logits; compares plans with calibration/test halves |
| Composite gate | `loc_features.cjs`, `gate_eval.py` | picture-finder features for every image; gate thresholds |
| Direct-image plans | `direct_eval2.py` | every plan calibrated to the old scanner's false-positive count, compared on the test half |
| Calibration shift | `screens_eval.py` | largest shift keeping zero calibration-half real screenshots at 95/99, minus 0.5 |
| Final report | `image_report.py`, `video_report.py` | old vs new worker results with Wilson intervals |
| Browser parity | `e2e.mjs` | drives the real page in Chromium (ORT-Web WASM) |
| Videos | `make_videos.py` + `e2e.mjs video` | slideshow clips with fades, a black title card, letterbox bars, VP9 at two bitrates — a pipeline test, **not** real AI video |

The image model itself is unchanged (`aicheck-ai-image-v2-fp16.onnx`,
same checksum). All image gains come from how the pixels are presented to it.
