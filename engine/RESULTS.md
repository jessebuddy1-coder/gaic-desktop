# Engine v2 — measured results vs GAIC 2.4.0

Every comparison runs the **unmodified 2.4.0 code** and the engine v2 code on
the same inputs. Nothing here is a population accuracy claim: these are public
research corpora and curated image sets, described in `eval/README.md`.

## Text AI check

**Setup.** Documents pass the app's own gates first (≥1,000 characters, ≥3
sentences, English). The "high band" is the "Several formulaic patterns
matched" verdict, and "Few" is the lowest band.

**Corpora the model never trained on** (their repositories carry no license, so
they were used only for testing):

| Held-out set | AUC old → new | Humans wrongly flagged old → new | AI caught (high band) old → new | AI in "Few" old → new |
|---|---|---|---|---|
| DetectRL: ChatGPT, Claude-instant, PaLM-2, Llama-2-70B across 4 domains (3,167 human / 1,081 AI) | 0.83 → **0.94** | 0.0% → 0.1% | 0.2% → **31%** | 77% → **9%** |
| DetectRL: paraphrased, prompt-attacked, and perturbed AI (1,957 AI) | 0.81 → **0.93** | 0.0% → 0.1% | 0.1% → **28%** | 82% → **11%** |
| Student and college essays vs GPT (233 / 57) | 0.78 → **0.99** | 0% → 0% | 0% → **32%** | 77% → **2%** |
| ArguGPT AI essays (1,717 AI) | — | — | 0.3% → **52%** | 14% → **0.5%** |

**Leave-one-corpus-out**, where each corpus is scored by a model trained
without it:

* AUC rose on all seven corpora: 0.27–0.89 → 0.76–0.99. On 2024 models
  (GPT-4o, Claude 3.5 Sonnet, Gemini 1.5, Llama 3.3, Qwen 2.5), it rose from
  0.79 to **0.99**.
* Human text wrongly flagged was 0–0.8% per corpus. The one exception is 1 of
  26 documents in the smallest corpus.
* **Non-native English writers** (1,192 held-out learner essays): **0.5%**
  flagged in the high band.
* Humanized or paraphrased AI (7,443 documents): 38% flagged. The old
  heuristic left 86% of them in its lowest band.

The full table is in `runtime/models/GAIC-TEXT-MODEL.md`.

## Rewriting (writing assist)

The benchmark has 77 reviewed cases: wordy phrases, verb tenses, a/an
agreement, sentence capitals, and things that must not change (abbreviations,
indentation, quotes, URLs, code).

| | 2.4.0 | engine v2 |
|---|---|---|
| Correct outputs | 26 / 77 (34%) | **77 / 77 (100%)** |
| Corrupts untouched text | yes: `U.S.A` → `U. S. A`, `Node.JS` → `Node. JS`, indentation flattened | no: text outside an edit is byte-identical |
| Grammar at edit sites | `an additional fee` → `an more fee` | `an extra fee`; a/an repaired |
| Direct quotes, code, URLs | edited | never edited |

The cases were written alongside the new rules, so 77/77 is a regression floor,
not a population accuracy.

## Photos, screenshots, video, and screen checks

The ONNX model file is unchanged. Ordinary photos get the 2.4.0 scan
byte-for-byte: 149 of 150 sampled outputs were identical, and the 150th failed
to decode under both scanners.

The table runs the unmodified 2.4.0 worker and the engine v2 worker on the
same files, with the same model file.

| Set | Scanner | AUC | Real flagged ≥95 | Real flagged ≥99 | AI caught ≥95 | AI caught ≥99 |
|---|---|---:|---:|---:|---:|---:|
| **Screenshots** (520 real, 520 AI) | 2.4.0 | 0.608 | 0/520 | 0/520 | 16/520 (3.1%) | 11/520 (2.1%) |
| **Screenshots** (520 real, 520 AI) | engine v2 | **0.667** | **0/520** | **0/520** | **51/520 (9.8%)** | **32/520 (6.2%)** |
| Direct images (520 real, 1,447 AI) | 2.4.0 | 0.695 | 6/520 | 1/520 | 209/1447 (14.4%) | 151/1447 (10.4%) |
| Direct images (520 real, 1,447 AI) | engine v2 | 0.695 | 6/520 | 1/520 | 210/1447 (14.5%) | 151/1447 (10.4%) |

**Screenshots.** The six layouts are a dark AI chat, a light generator
portal, a phone social feed, a phone photo viewer, a news article, and a
letterboxed player.

* The new scanner caught about **3× more AI screenshots** at both warning
  bands and flagged no real screenshot.
* Every layout was equal or better. The generator portal went from 0/78 to
  10/78 AI caught at 95, and the news article from 1/101 to 13/101.
* In a headless-Chromium screen-capture test, a screenshot was played as a
  simulated shared-screen stream through the real capture code. The picture
  was located in 4 of 4 captures.

**Direct photos** are effectively unchanged, because this model misses most
modern closed-generator images (GPT-4o, Gemini) no matter how the pixels are
presented. Calibrated to the old scanner's false-alarm level, every scan
variant tried caught about the same 12–15% at the 95 band. Improving
direct-photo accuracy further needs a better image model. That would be a
reviewed model swap, which this update deliberately does not make.

**Video.** In real Chromium, on synthetic slideshow clips with fades, black
title cards, letterbox bars, and heavy compression:

* All **74 of 74** non-blank frames scored exactly as in 2.4.0.
* The **6** black title-card frames were skipped instead of being scored as
  evidence.

Detection did not change measurably on this set: 0 of 15 AI and 0 of 15 real
clips were flagged at the median, before and after. Video frames are
deliberately kept out of the screenshot reading. On lossy video it raised one
frame of a real clip to 95/100 in testing, so it was disabled for video.

## Speed

* **Text:** about 1 ms per 260-word passage in Node, and about 50 ms for the
  largest allowed input (100,000 characters).
* **Photos:** the same work as 2.4.0, plus one ≤512 px layout pass (a few ms).
* **Screenshots:** 12 model runs instead of 8.
* **Videos and screens:** 8 frames, as before. Blank frames trigger up to 2
  extra seeks, and unchanged screen frames skip the model. In the browser
  test, a static screen needed 1 scan instead of 8.
