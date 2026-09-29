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
trained on. Thresholds were set on these held-out scores.

| | 2.4.0 warning (≥95) | 2.4.0 model at the same false-lean rate | **Updated** |
| --- | ---: | ---: | ---: |
| AI images called AI (family-balanced) | 20.6% | 28.3% | **67.7%** |
| Real images called AI (source-balanced) | 1.6% | 3.8% | **4.0%** |
| AUC | 0.719 | 0.719 | **0.954** |

| Held-out AI family | 2.4.0 model at the same rate | **Updated** |
| --- | ---: | ---: |
| Photorealistic social posts, avatars, product shots | 17% | **81%** |
| OpenAI (GPT-4o, gpt-image-1/1.5/2/2.5) | 14% | **70%** |
| Seedream 4.5/5.0 | 16% | **69%** |
| Midjourney v6–v7 | 30% | **62%** |
| Google Nano Banana / Pro | 18% | **60%** |

**Real images leaning AI, per held-out source:**

| Source | Leaned AI |
| --- | ---: |
| Charts | 0% |
| App screenshots | 2.1% |
| Open Images photos | 1.8% |
| Digital paintings | 2.8% |
| Memes | 6.4% |
| Open Images non-photo images | 9.8% |
| 2023 camera photos (DOCCI) | 10.7% |

The DOCCI figure falls to 0.1% when that kind of photo is represented in
training, as it is in the shipped head.

**How often each confidence level was right:**

| Lean / confidence | Right |
| --- | ---: |
| AI, high | **98%** |
| AI, medium | 90% |
| Real, high | **97%** |
| Real, medium | 83% |
| Real, low (a close call) | 42% |

## Screenshots

1,040 screenshots (520 real, 520 AI) of the same images in six app and web
layouts. Scores are held out by generator family, like the photo numbers.

| | 2.4.0 | Engine v2 (scan v6) | **Updated** |
| --- | ---: | ---: | ---: |
| AI screenshots called AI | 3.1% (≥95) | 9.8% (≥95) | **70.4%** |
| Real screenshots called AI | 0% | 0% | **4.0%** |
| AUC | 0.608 | 0.667 | **0.929** |

Per layout (AI called AI / real called AI):

| Layout | AI called AI | Real called AI |
| --- | ---: | ---: |
| News article | 64% | 3.0% |
| Dark AI chat | 71% | 2.4% |
| Letterboxed player | 78% | 4.1% |
| Light generator portal | 77% | 1.4% |
| Phone social feed | 60% | 3.2% |
| Phone photo viewer | 75% | 10.5% |

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
* **Browser test timings:**
  * about 10–14 s per photo, including the animation floor
  * about 45 s per 8-frame video on a 4-core test machine
