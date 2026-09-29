# Engine update — measured results vs GAIC 2.4.0

Every comparison runs the **unmodified 2.4.0 code** and the updated code on
the same inputs. These are public research corpora and curated image sets,
described in `eval/README.md`. The confidence levels are measured on them, not
on the population of things people check.

## Every check now ends with an answer

2.4.0 withheld a result for most checks. Photos below the 95/100 band showed
"No rating" with "Model result is inconclusive", text showed a pattern band,
and video and screen checks showed "Sampled frames are inconclusive".

Now every completed check shows a **lean** (AI-written or human-written;
AI-generated or real), a **confidence level** (high, medium, or low), and an
estimated **AI likelihood**. Genuine failures stay errors and are never given
a lean: text under 1,000 characters, an unreadable file, or a model that could
not run with no other evidence. Each confidence level was set on held-out data
so that its share of correct leans meets a target. A low-confidence lean is a
close call, and the app says so.

## Photos

The image network is the same, with the same weights. Engine v3 exposes more
of what that network computes and reads it with a new decision head, trained
on 2025–2026 generators and on real photos, art, charts, and screenshots
(`runtime/models/AICHECK-IMAGE-MODEL.md`).

**Protocol: leave one group out.** 13,926 images: 10 AI generator families and
9 real-image sources. Each group is scored by a head that **never saw that
group**, so every AI image comes from a generator family the head was not
trained on. Thresholds were set on these held-out scores, and every figure is
computed by the app's own decision code: the worker's calibration and
rounding, including the composite path for the 440 photos where the scan
locates a picture inside the image, and `decideImageLean`
(`eval/image_report_v3.mjs`).

| | 2.4.0 warning (≥95) | 2.4.0 model at the same false-lean rate | **Updated** |
| --- | ---: | ---: | ---: |
| AI images called AI (family-balanced) | 20.6% | 28.5% | **67.4%** |
| Real images called AI (source-balanced) | 1.6% | 4.0% | **4.0%** |
| AUC | 0.719 | 0.719 | **0.954** |

| Held-out AI family | 2.4.0 model at the same rate | **Updated** |
| --- | ---: | ---: |
| Photorealistic social posts, avatars, product shots | 17% | **80%** |
| OpenAI (GPT-4o, gpt-image-1/1.5/2/2.5) | 14% | **70%** |
| Seedream 4.5/5.0 | 16% | **68%** |
| Midjourney v6–v7 | 30% | **61%** |
| Google Nano Banana / Pro | 18% | **59%** |

**Real images leaning AI, per held-out source:**

| Source | Leaned AI |
| --- | ---: |
| Charts | 0% |
| App screenshots | 1.5% |
| Open Images photos | 1.9% |
| Digital paintings | 3.4% |
| Memes | 7.0% |
| Open Images non-photo images | 10.0% |
| 2023 camera photos (DOCCI) | 10.0% |

The DOCCI figure falls to 0.1% when that kind of photo is represented in
training, as it is in the shipped head.

**How often each confidence level was right:**

| Lean / confidence | Right |
| --- | ---: |
| AI, high | **98%** |
| AI, medium | 90% |
| AI, low (a close call; 0.1% of images) | 33% |
| Real, high | **97%** |
| Real, medium | 83% |
| Real, low (a close call) | 41% |

## Screenshots

1,040 screenshots (520 real, 520 AI) of the same images in six app and web
layouts. Scores are held out by generator family, like the photo numbers. The
composite calibration (a picture located inside the frame) was set on these
screenshots and on the photos that take the same path, so it keeps the photo
limits too.

| | 2.4.0 | Engine v2 (scan v6) | **Updated** |
| --- | ---: | ---: | ---: |
| AI screenshots called AI | 3.1% (≥95) | 9.8% (≥95) | **69.0%** |
| Real screenshots called AI | 0% | 0% | **3.3%** |
| AUC | 0.608 | 0.667 | **0.939** |

Per layout (AI called AI / real called AI):

| Layout | AI called AI | Real called AI |
| --- | ---: | ---: |
| News article | 64% | 3.0% |
| Dark AI chat | 70% | 2.4% |
| Letterboxed player | 76% | 2.1% |
| Light generator portal | 73% | 1.4% |
| Phone social feed | 59% | 2.1% |
| Phone photo viewer | 75% | 9.2% |

## Text

Same trained model as engine v2. The lean threshold, AI likelihood, and
confidence levels were set on leave-one-corpus-out scores. A gradient-boosted
alternative did not beat it on unseen corpora, so the simpler model stays.

**Human-written documents leaning AI:**

| Set | Leaned AI |
| --- | ---: |
| Unseen training corpora | 4.8% |
| DetectRL | 2.9% |
| Non-native English essays | 2.6% |

**AI documents leaning AI:**

| Set | Leaned AI |
| --- | ---: |
| Unseen training corpora | 64% |
| DetectRL | 67% |
| Detector-bias GPT essays | 79% |
| ArguGPT | 92% |

**How often each confidence level was right:**

| Lean / confidence | Unseen corpora | Held-out corpora |
| --- | ---: | ---: |
| AI, high | **98.5%** | **99.8%** |
| AI, medium | 90% | 96% |
| Human, medium | 81% | 93% |

**Pasted AI sections.** When a document leans human-written, the app also
checks stretches of about 200 words and reports one that reads strongly
machine-written, naming its words and opening. On held-out corpora:

| Human writing | Section reported |
| --- | ---: |
| Documents on their own | 0.0% |
| 3, 6, or 10 documents joined into one long text | 0.3–0.5% |

| AI words pasted into human writing | Document leans AI | Leans AI or section reported |
| --- | ---: | ---: |
| About 250 | 0.2% | **29%** |
| About 400 | 3.0% | **54%** |

**Disguise tricks.** Texts with invisible characters inside words or
look-alike letters from other alphabets now get a notice. It fired on 100% of
RAID's zero-width attacks and 99.8% of its homoglyph attacks, and on none of
3,401 held-out human documents. The score already ignored these characters.

**Text in other languages.** The model reads English only, but Spanish,
German, or Polish text got past the old letter test and was scored anyway.
On real human writing, the English model called 36% of Basque, 15% of
Finnish, and 10% of Polish paragraphs AI-written. Such text now gets "English
prose required" instead of a score. Measured on Universal Dependencies
treebanks and the English evaluation corpora (`eval/language_check.mjs`):

| Text | Not scored |
| --- | ---: |
| Human writing in 13 common Latin-script languages (3,513 paragraphs) | **100%** |
| Human writing in 8 other languages the check has no word list for (2,233 paragraphs) | **99.8%** |
| English prose from 9 sources, including non-native English (4,936 texts) | **0%** |

Against 2.4.0's heuristic, on the held-out DetectRL corpus:

| | 2.4.0 | Updated |
| --- | ---: | ---: |
| AUC | 0.83 | **0.94** |
| AI texts in the lowest band | 77% | **9%** |

Full tables are in `runtime/models/GAIC-TEXT-MODEL.md`.

## Video and screen checks

In real Chromium, on 30 synthetic slideshow clips (15 AI, 15 real), with fades,
title cards, letterbox bars, and VP9 compression:

| | 2.4.0 | **Updated** |
| --- | ---: | ---: |
| AI clips called AI | 0 of 15 | **5 of 15** |
| Real clips called AI | 0 of 15 | **0 of 15** |

The other 10 AI clips mostly read "Leans real — low confidence". Real clips
read "Likely real" at high or medium confidence, 12 of 15.

Video is the weakest check. It reads 8 sampled still frames, and no public
AI-video set was reachable for calibration. Video frames therefore use a
deliberately flatter calibration. Blank frames are skipped, and unchanged
screen frames reuse a score, as in engine v2.

## Large photos

The on-device check now accepts photos up to **50 MB** and **120 MP**. The old
limits were 8 MB and 24 MP, which rejected many modern phone photos.

* Photos above the scan's 24 MP working size are decoded straight to a
  downscaled copy, so a large photo never needs a full-resolution canvas.
* Photos within the old limits get exactly the same scan as before.
* In the browser test, a 20 MB, 55 MP JPEG was checked in 10 s.
* The quick-check page (`is-this-ai.html`) accepts the same sizes.
* The native share-sheet entry keeps its 8 MB cap. It is set in native app
  code outside this runtime (see README).

## Photo metadata clues

Some AI images still carry their generator's own records. GAIC now reads
three more of them from the file's metadata text:

* **Generation settings in JPEG and WebP.** Stable Diffusion tools write their
  settings line (`Steps: 30, Sampler: …, CFG scale: 7, Seed: …`) or a ComfyUI
  node graph into the EXIF comment or XMP. Before, only the PNG form was read.
* **China's AI-content label** (GB 45438-2025). This label has been mandatory
  since September 2025 for AI images made or shared through Chinese services.
  Label 1 (AI-generated) counts like a declared AI source type; labels 2
  (possibly) and 3 (suspected) count for less.
* **More tool names**, among them NovelAI, ComfyUI, InvokeAI, Fooocus, and
  "DALL·E" written with its middle dot. The Italian word "dalle" no longer
  counts as DALL·E.
* **No tool names from captions.** A tool name now counts only where a tool
  records itself (software fields, generator text chunks, edit histories),
  not in a caption, title, or keyword list. A real news photo captioned
  "OpenAI CEO Sam Altman speaks…" used to count as naming an AI tool. On the
  evaluation sets every tool-name hit came from a generator's own record (a
  ComfyUI node graph), so this change costs nothing measured.

Measured on the evaluation files that carry metadata text or credentials:

| Files with metadata | A metadata clue fires: 2.4.0 | Now |
| --- | ---: | ---: |
| AI images (1,344) | 769 | **772** |
| Real images from the evaluation sets (2,255) | 0 | **0** |
| Real camera photos from the public `exif-samples` collection (89) | 0 | **0** |

The gain on these sets is small because most public AI images have lost their
metadata on the way. The clues matter most for files straight from a
generator. Every clue is unsigned and editable, so each one adds weight to
the lean rather than deciding it. Script: `eval/metadata_clues.mjs`.

## Rewriting (writing assist)

The benchmark has 77 reviewed cases: wordy phrases, verb tenses, a/an
agreement, sentence capitals, and things that must not change (abbreviations,
indentation, quotes, URLs, code).

| | 2.4.0 | Updated |
| --- | --- | --- |
| Correct outputs | 26 / 77 (34%) | **77 / 77 (100%)** |
| Corrupts untouched text | yes: `U.S.A` → `U. S. A`, `Node.JS` → `Node. JS`, indentation flattened | no: text outside an edit is byte-identical |
| Grammar at edit sites | `an additional fee` → `an more fee` | `an extra fee`; a/an repaired |
| Direct quotes, code, URLs | edited | never edited |

The cases were written alongside the new rules, so 77/77 is a regression
floor, not a population accuracy.

## Scanning animation

The scanning panel is now a live viewfinder driven by real pipeline events.

* **Photos and screenshots.** The user's own picture develops from grey to
  colour behind a sweeping beam. Bracket boxes lock onto each region the model
  actually reads, and a "picture located" box appears on screenshots.
* **Video and screen.** Each sampled frame is shown as it is read.
* **Text.** Shows an excerpt of the user's text, with its real passage and
  word counts.
* **Rest of the page.** Pixel-identical to 2.4.0, in idle and result states,
  on desktop and phone widths.
* **Reduced motion.** A designed still state.
* **Performance.** All animations run on the compositor, off the main thread.

## Speed

* **Text:** about 1 ms per 260-word passage, and 50 ms for the largest input.
* **Photos:** the same model runs as before. The decision head is one
  2,304-value dot product per view.
* **First photo check:** GAIC now starts loading the photo model while a file
  is being chosen. In the Linux desktop app, with a 3 s pause before Check,
  the first photo check went from 7.7–8.4 s to 5.1–5.7 s. Later checks took
  4.4–4.9 s either way.
* **Browser test timings:**
  * about 10–14 s per photo, including the animation floor
  * about 45 s per 8-frame video on a 4-core test machine
