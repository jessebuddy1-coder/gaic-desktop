# GAIC Image Model v3 — provenance, preprocessing, decision head, and limitations

This document records the exact bundled on-device image model used by the
GAIC likelihood signal. It runs locally in ONNX Runtime Web; no image is
sent to a server for this result.

| Field | Value |
| --- | --- |
| File | `models/aicheck-ai-image-v3-fp16.onnx` (engine v3; same network and weights as v2, plus a `features` output) |
| SHA-256 | `bc7f12a0ca9750791607bbcf32159749e06079e4145a3e62c602e40f015f4fab` (v3); v2 was `bb98ce3021b2717595b3fe625871e247a7ac15623296e4ad1e2207453d529b57` |
| Decision head | `image-head.js`, SHA-256 `dbf6037db474cbfd6d078fe33bbd48cb31511541b54ec1504f59aedec128cb00` (see "Engine v3" below) |
| Source | [OwensLab/commfor-model-224](https://huggingface.co/OwensLab/commfor-model-224) at revision `26afc31e6b40c312c3fd42c05a758be62446215b` |
| Paper | Community Forensics: Using Thousands of Generators to Train Fake Image Detectors ([arXiv:2411.04125](https://arxiv.org/abs/2411.04125), CVPR 2025) |
| License | MIT (model weights and reference code) |
| Architecture | timm `vit_small_patch16_224.augreg_in21k_ft_in1k` backbone + 1-logit head (21.7M params) |
| Conversion | safetensors → ONNX opset 17 locally (torch 2.8), ORT transformer-optimizer fusion, fp16 weights with fp32 I/O; torch-vs-ORT parity ≤ 7e-06, fp32-vs-fp16 per-image score delta ≤ 0.22 points |
| Preprocessing | the official center view first resizes the complete image so its shortest edge is 256, then applies an integer 224×224 center crop; other declared views are rendered at 224×224; every view uses x/255, then ImageNet mean `[0.485,0.456,0.406]` / std `[0.229,0.224,0.225]` |
| Output | per view: the original logit (engine v2 diagnostics) and a 2,304-value feature read by the decision head; the app shows the head's calibrated AI likelihood, a lean, and a confidence level |
| Training basis | ~2.7M images spanning several thousand community generative models (through 2024), per the paper |

## Why v2 replaced v1

v1 (`aicheck-ai-image-v1-q4.onnx`, CIFAKE-derived ViT, retired July 22, 2026)
was measured on genuine camera photographs and produced 70–99.6 "AI" scores on
7/7 real photos — no usable separation from AI content (rank AUC ≈ 0.44 on
solid-ground-truth sets, worse than chance). On the same local benchmark, v2
scored:

| Metric (local July 22 benchmark) | v1 shipped | v2 (this file) |
| --- | --- | --- |
| Rank AUC, real photos vs labeled AI (DALL·E-3 web set + paper samples) | 0.44 | 0.82 |
| Real photos falsely scored ≥90 | 4/7 | **0/7** |
| Real photos falsely scored ≥99 | 3/7 | **0/7** |
| Labeled AI caught at ≥50 | (meaningless — flags everything) | 62% |

Benchmark inputs and harness: repo `ops/aicheck-eval-2026-07-22/` and the
regenerated deterministic fixture suite in `test/model-benchmark.mjs`.

## Limitations that still apply

- The score is a likelihood signal from a binary classifier, **not a
  probability, not provenance, and not proof**. C2PA Content Credentials and
  EXIF review remain the leading evidence in every result.
- The local benchmark above is small (7 real / 21 labeled-AI images). It
  demonstrates the v1 failure and the v2 direction, not a product accuracy
  percentage. The paper reports strong in-benchmark numbers, but a
  representative, licensed, ground-truth evaluation on current generators is
  still required before ANY public accuracy claim.
- Web-recompressed AI images (small JPEG rips) score materially lower than
  originals; the newest generators, heavy edits, screenshots, and unusual
  content can fool the model in either direction, and the app copy says so.
- A low score never clears an image as authentic; a high score never convicts.

## Composite-frame and portal-screenshot scan

The upstream test transform uses the center crop documented above, while its
training transform includes random crops. A single center crop can omit the
actual generated picture when the submitted file is a screenshot of a generator
portal. The web worker therefore decodes the file once and evaluates at most eight
bounded local views with the same reviewed model:

1. one whole-frame overview, letterboxed with the model's normalization mean;
2. the original two-step scale-shortest-edge-to-256, then integer
   center-crop-224 view (product contract
   `resize-shortest-center-crop-v1`);
3. overlapping top-left, top-right, bottom-left, and bottom-right detail views;
4. lower-center and middle-center detail views covering the usual portal output
   column.

The displayed visual score is the strongest of these views. The result also
lists every bounded per-region score and explicitly says that it is
strongest-region aggregation, not an average or probability. Only fixed region
names and clamped numeric scores leave the worker; crop coordinates and pixels
do not.

This change improves spatial coverage; it does **not** train a new model or
establish better accuracy. Multiple views may uncover a high false-positive
outlier. The hash-pinned July 28 orientation set described below supports a
separately worded 95/100 elevated-evidence band and the existing 99/100
high-warning band, but it is far too small and narrow to establish population
calibration. Every lower score remains inconclusive rather than "real." For a
screenshot-like composite below 95, the app does not promote the strongest raw
region value into a headline numeric score; it reports that the portal scan is
inconclusive and keeps the component values in the diagnostic text. PNG
dimensions, filename, and aspect ratio may be described locally as consistent
with a screenshot or exported graphic, but that layout context is not counted
as AI evidence. The standalone web app does not read the page URL, DOM, browser
history, nearby text, or another app. The optional Chrome extension, after the
user clicks Scan, can add the current hostname and the geometry of the largest
visible media element as separate context; it does not turn those clues into an
authorship percentage.

The current browser contract is
`whole-official-center-mid-lower-v5`. Earlier v4 builds collapsed the official
resize and center crop into one fractional Canvas2D source crop. An independent
July 28 audit found that shortcut could materially change a reviewed score (one
pinned image fell from 9.6672 to 1.466839). v5 restores the two distinct
operations and records the center-preprocessing contract in every worker
result. Browser resampling remains an implementation detail that must be
measured against the pinned evaluation set; it is not claimed to be
pixel-identical to Pillow.

### July 28 licensed orientation set

`ops/aicheck-eval-2026-07-28/` contains a reproducible 35-asset manifest and a
real-browser runner for the exact bundled worker, fp16 ONNX artifact,
preprocessing, eight-region maximum, strongest-region aggregation, and two
display bands. Its 11 real-photo labels comprise five local Apple simulator
camera samples whose capture metadata predates current generators and six
individually sourced CC0/public-domain photographs. Its 24 generated labels
comprise eight project-owned concept renders and 16 images from a pinned
MIT-licensed DALL·E 3 dataset revision. Every asset is SHA-256 pinned; no failed
download is replaced or relabeled.

| Exact declared-set count | Direct image | Deterministic portal composite |
| --- | ---: | ---: |
| Real fixtures flagged at 95 | 0/11 | 0/11 |
| Generated fixtures flagged at 95 | 6/24 | 3/24 |
| Real fixtures flagged at 99 | 0/11 | 0/11 |
| Generated fixtures flagged at 99 | 5/24 | 2/24 |

The zero observed real-photo flags does not imply a zero population false
positive rate: the two-sided 95% Wilson upper bound is about 25.9% with only 11
real fixtures. Portal recall remains poor even after the targeted scan. The
result is evidence that the original center/corner scan missed portal output,
not evidence that the detector is broadly reliable. Region ablation shows the
six-view plan found 0/24 portal fixtures at either 95 or 99; adding lower-center
found 3/24 at 95, and adding middle-center raised two of those to the 99 band.
See the evaluation README and JSON artifacts for exact per-asset and per-region
scores.

## Scan v6: located-picture reading for composite frames (engine v2)

The model file, checksum, and the v5 eight-view scan above are unchanged, and
ordinary photos and images still get exactly that scan. Engine v2 adds one
reading for **composite frames**: a picture surrounded by flat interface
background, such as a phone or portal screenshot, a news page, a chat window,
or a letterboxed video frame.

1. **Locate the picture.** On a ≤512 px copy, 8×8 blocks are classified as
   *rich* (≥8 distinct 4-bit colors, no color above 60%) or not. The
   maximum-sum rectangle (+1 rich, −0.5 other) is grown outward until it
   meets interface background: flat colors taken from the frame's outer ring.
2. **Gate.** The frame counts as a composite only if ≥90% of the area outside
   the picture is that interface background and <2% carries other marks. Real
   screenshots have clean interface backgrounds, with text drawn on the page
   color; ordinary photos with plain backdrops do not. On the evaluation sets
   below, the gate fired on 901 of 1,040 screenshots and on 28 of 1,970 direct
   images.
3. **Read the picture at the trained scale.** The upstream training
   transform resizes the whole picture so its shortest side is 225–275 px,
   then randomly crops and mirrors it. v6 renders the picture with the
   reviewed resize-256 geometry: center, mirrored center, top-left, and
   bottom-right crops. It averages the four logits and adds one fixed shift
   of +1.5.
4. **Report the stronger reading.** The headline is the higher of the picture
   reading and the v5 strongest-region value, so the new reading can only add
   detections. Both values are shown in the explanation. Low values on
   composite frames are now read by the engine v3 decision head below.

The +1.5 shift was chosen by a fixed rule. It is the largest shift that kept
zero real screenshots at the 95/100 band on a calibration half (by file
hash), minus a 0.5-logit safety margin. It was not tuned on the test half.

### Evaluation (September 2026)

The AI images are 1,450 curated generator outputs:

* GPT-4o / gpt-image: `songguoxs/gpt4o-image-prompts`, and the `example_*`
  files from `jamez-bondos/awesome-gpt4o-images`;
* Gemini 2.5 Flash Image: only the `output*` files from
  `PicoTrex/Awesome-Nano-Banana-images`, never the real `input.*` photos;
* hand-checked samples from Kolors, HunyuanDiT, Stable Diffusion, PixArt-α,
  and SGM.

The real images are 520 random Open Images V4 validation photographs (CC BY
2.0). For the screenshot set, every image, real or AI, was rendered by
headless Chromium inside six mock interfaces at real device pixel ratios:

* a dark AI chat;
* a light generator portal;
* a phone social feed;
* a phone photo viewer;
* a news article;
* a letterboxed player.

Both scanners ran unmodified: the 2.4.0 `detector-worker.js` and the engine v2
worker. They used the same ONNX file and the same harness.

| Set | Scanner | AUC | Real ≥95 | Real ≥99 | AI ≥95 | AI ≥99 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Screenshots (520 real / 520 AI) | 2.4.0 v5 | 0.608 | 0/520 | 0/520 | 16/520 (3.1%) | 11/520 (2.1%) |
| Screenshots (520 real / 520 AI) | engine v2 | **0.667** | **0/520** | **0/520** | **51/520 (9.8%)** | **32/520 (6.2%)** |
| Direct images (520 real / 1,447 AI) | 2.4.0 v5 | 0.695 | 6/520 | 1/520 | 209/1447 (14.4%) | 151/1447 (10.4%) |
| Direct images (520 real / 1,447 AI) | engine v2 | 0.695 | 6/520 | 1/520 | 210/1447 (14.5%) | 151/1447 (10.4%) |

* On screenshots, the located-picture reading catches about three times as
  many AI images at both bands, and it raised no real screenshot to either
  band. With 0 of 520, the two-sided 95% Wilson upper bound on the
  real-screenshot false-positive rate is about 0.7%.
* Direct images are effectively unchanged. 149 of 150 randomly sampled
  non-composite images produced byte-identical worker output, and the 150th
  failed to decode under both scanners. Because the composite headline is the
  higher of the two readings, no image scored lower than under 2.4.0.
* The model still misses most modern closed-generator images. Among direct
  images, GPT-4o/gpt-image and Gemini outputs were flagged far less often than
  open diffusion-model samples. That limit is in the model, not the scan.
  Calibrated to the old scanner's false-positive level, every scan-plan
  variant we tried (view means, detail crops, multi-scale) caught roughly the
  same 12–15% at the 95 band on direct images.

Video frames are excluded from the picture reading and keep the v5 scan.
In a browser test on 30 synthetic slideshow clips, the picture reading raised
one frame of a heavily compressed real-photo clip to 95/100, so its
screenshot calibration does not transfer to lossy video. Screen-capture
frames are lossless renderings of the display, like screenshots, so they keep
the reading.

Limits: the screenshots are synthetic renderings of real and generated
images, not captures from real devices. Open Images photos are web-resized
Flickr JPEGs, not camera originals. The AI set over-represents GPT-4o gallery
images, many of which are stylized. None of this is a population accuracy
claim.

## Engine v3: decision head and decisive results (September 2026)

The v5 scan and the v6 picture reading still choose **which views** of an
image the model reads; the pinned v5 functions are unchanged. What changed is
**how the model's reading of those views is decided**.

**Why.** Measured on the images below, the v2 model's own last layer caught
about one in five images from 2025–2026 generators (GPT-Image, Nano Banana,
Seedream, Midjourney v6–v7, Ideogram, MAI-Image) at its warning bands. The
network's internal features separate those images much better than its final
layer does.

**The v3 model file.** The same fp16 network with the same weights. The file
adds one output, `features`: the class token and the mean of the 196 patch
tokens at three depths (the LayerNorm outputs entering blocks 7 and 10, and
the final LayerNorm), 6 × 384 = 2,304 values per view. The original `logit`
output is still output 0, and it matches v2 exactly. The conversion script is
`eval/add_rich.py`. The worker reads `outputNames[0]` as before, so a cached
v2 file keeps working; the head then stays off.

**The head.** `image-head.js` holds one logistic-regression layer over the
2,304 values, with feature standardization folded into the weights (C =
0.005). The worker applies it to every view the scan already runs and
averages in logit space. For a located picture (scan v6), the headline uses
the higher of the picture average and the frame average. A monotone knot table
maps that average to the displayed AI likelihood, with separate tables for
direct images, composite frames, and video frames. Each table has one knot at
exactly 50%, at its lean threshold, a knot 1e-5 below it and every other knot
at least 0.05 log-odds away, so the lean follows the threshold to within 1e-5
of a logit even after the worker rounds the likelihood to 4 decimals
(`eval/calib_image.py` `pin_knots`). The composite table applies to any
upload where scan v6 locates a picture, screenshots and ordinary photos alike
(for example a painting with a border), so it was calibrated on both
(`eval/recalibrate_composite.py`): the rule is the higher of the picture and
frame averages, with its lean threshold at a head logit of 1.79. The worker computes the
head only when both `image-head.js` and the feature output are present, and
otherwise returns the engine v2 reading unchanged.

**Training data** (on-device features extracted by the real worker code;
nothing is committed; see `eval/README.md`):

| Class | Source | Images |
| --- | --- | ---: |
| AI | OpenAI GPT-4o, gpt-image-1/1.5/2/2.5 (public prompt galleries) | 3,729 |
| AI | Google Nano Banana / Nano Banana Pro / Gemini image | 964 |
| AI | mixed-generator poster, comparison, and case galleries | 895 |
| AI | photorealistic social posts, avatars, and product shots (mixed generators) | 721 |
| AI | Midjourney v6, v6.1, v7 | 678 |
| AI | Seedream 4.5 / 5.0 | 201 |
| AI | older open models (Kolors, HunyuanDiT, SD, PixArt, SGM) | 184 |
| AI | FLUX, Ideogram 4.0, MAI-Image 2.5 | 92 |
| Real | Open Images photos (Flickr, CC BY 2.0) | 3,020 |
| Real | DOCCI photos (2023 camera photos, CC BY 4.0) | 693 |
| Real | human-made graphics rendered locally (dashboards, documents, code, slides, forms, memes) | 700 |
| Real | Open Images non-photo images (drawings, comics, screenshots, diagrams) | 400 |
| Real | Rico Android app screenshots | 390 |
| Real | Wesnoth digital paintings | 358 |
| Real | Pokémon official digital illustrations | 383 |
| Real | ChartQA charts | 331 |
| Real | meme templates | 187 |

Each picked image was presented once, either as the original file or as a
re-encoded copy: 35% JPEG and 15% WebP at quality 60–95, randomly resized and
flattened on white. That way no class can be told apart by codec, size, or
alpha. Near-duplicates (dHash ≤ 4 bits) were removed across all sources. Some
AI galleries come from social posts and may include edits of real photos,
which makes the AI side harder, not easier.

**Evaluation protocol: leave one group out.** Each of the 10 AI generator
families and each of the 9 real sources is held out in turn, and a head trained
on everything else scores it. Every number below is therefore on a generator
family, or a kind of real image, that the head never saw. All thresholds and
confidence levels were set on these held-out scores. They are then applied
unchanged to the production head, which is trained on all groups, so these
figures are conservative for kinds of images that were in training.

**Lean threshold and confidence levels.** An image leans AI when its displayed
likelihood is ≥ 50%. The threshold maximizes the family-balanced share of AI
images caught, subject to two limits: the source-balanced share of real images
leaning AI is at most 5%, and no single real source exceeds 10%. Confidence
cut points are where the held-out isotonic estimate of the share of correct
leans reaches its target: AI high ≥ 95% and medium ≥ 85%; real high ≥ 90% and
medium ≥ 75%.

**Results, direct images** (13,926 images, every one scored by a head that
never saw its group):

| | GAIC 2.4.0 warning (≥95) | v2 model at the same real false-lean rate | **engine v3** |
| --- | ---: | ---: | ---: |
| AI images called AI (family-balanced) | 20.6% | 28.5% | **67.4%** |
| Real images called AI (source-balanced) | 1.6% | 4.0% | **4.0%** |
| AUC (pooled) | 0.719 | 0.719 | **0.954** |

| AI family (held out) | v2 at same rate | **v3** |
| --- | ---: | ---: |
| Photorealistic social / avatar / product | 17% | **80%** |
| OpenAI GPT-4o / gpt-image | 14% | **70%** |
| Seedream | 16% | **68%** |
| mixed galleries | 23% | **67%** |
| Midjourney | 30% | **61%** |
| Google Nano Banana | 18% | **59%** |
| Ideogram (27 images) | 11% | **37%** |

Real images leaning AI, per held-out source: charts 0.0%, rendered graphics
0.3%, Rico app screens 1.5%, Pokémon art 1.8%, Open Images photos 1.9%,
Wesnoth paintings 3.4%, memes 7.0%, Open Images non-photo 10.0%, DOCCI camera
photos 10.0%. In a 5-fold split where every source is represented in training
(closer to the shipped head), DOCCI photos leaned AI 0.1% of the time.

Every figure here is computed by the app's own decision code (the worker's
calibration, composite path, and rounding, and `decideImageLean`), applied to
the committed per-image held-out scores (`eval/image_report_v3.mjs`). The
scan locates a picture in 440 of these photos, which then take the composite
path.

Share of correct leans per confidence level (held out, balanced classes):

| Lean / confidence | Share of images | Correct |
| --- | ---: | ---: |
| AI, high | 25% | **98.0%** |
| AI, medium | 10% | 90.0% |
| AI, low | 0.1% | 33% (a close call, labelled as one) |
| Real, high | 33% | **97.3%** |
| Real, medium | 9% | 83.4% |
| Real, low | 23% | 41.4% (a close call, labelled as one) |

**Screenshots** (1,040 screenshots of the same images in six app and web
layouts): 69.0% of AI screenshots and 3.3% of real ones leaned AI, AUC 0.939.
See `RESULTS.md` for the held-out numbers per layout.

**Video.** Video frames skip the picture reading and use the direct table
flattened by a factor of 0.75 in log-odds, with stricter confidence cuts. No
public AI-video set was reachable for calibration, so video leans are
deliberately less confident than photo leans. See `RESULTS.md`.

**Limitations.**
* The AI side is dominated by public prompt galleries: stylized,
  poster-like, and social images. Unedited photorealistic output from the
  newest generators, heavily edited or composited images, and generators with
  no gallery (for example Recraft, Imagen standalone, Firefly) are the most
  likely misses.
* A kind of real image that is unlike every training source can lean AI more
  often. The worst held-out sources were modern high-quality camera photos
  and scans or photos of artwork, at about 10%.
* Confidence levels are measured on these sets, not on the population of
  images people check. A low-confidence lean is a close call.
* The metadata and Content Credential weights that `decideImageLean` adds to
  the pixel reading are judgment-set priors, not measured. A validated
  AI-origin credential and a trusted capture credential decide the lean
  outright.

## Independent second-model candidate

Nonescape Mini v0 was evaluated as a possible separate local signal after the
portal-screenshot miss was reproduced. It caught substantially more generated
images, but useful thresholds also produced confident false positives on
genuine camera photos and on otherwise identical real-photo portal
composites. It is therefore **not bundled** and is not averaged into this
model's result. See
[`NONESCAPE-MINI-CANDIDATE-EVALUATION.md`](NONESCAPE-MINI-CANDIDATE-EVALUATION.md)
for the pinned artifact, raw operating-point measurements, conversion size,
training-data caveat, and reconsideration bar.

## Reproducibility and evidence boundaries

- The fp16 ONNX artifact is checksum-pinned above, but the safetensors→ONNX
  conversion itself is **not reproducible from this checkout** alone: it
  requires downloading the pinned upstream revision and a local torch/ORT
  toolchain. Treat the checksum, source id, and revision as the provenance
  contract.
- The July 22 comparison table is a small local measurement. It documents why
  v1 was retired and the direction of v2; it must not be advertised as verified product
  accuracy.
- Reproducible synthetic stress benchmark: `test/model-benchmark.mjs` pins a
  deterministic fixture set and score digest to catch silent model/runtime
  drift. It **does not measure accuracy, AUC, calibration**, false-positive or
  false-negative rates.
