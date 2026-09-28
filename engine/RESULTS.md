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

__IMAGE_TABLE__

__VIDEO_TABLE__

## Speed

* **Text:** about 1 ms per 260-word passage in Node, and about 50 ms for the
  largest allowed input (100,000 characters).
* **Photos:** the same work as 2.4.0, plus one ≤512 px layout pass (a few ms).
* **Screenshots:** 12 model runs instead of 8.
* **Videos and screens:** 8 frames, as before. Blank frames trigger up to 2
  extra seeks, and unchanged screen frames skip the model. In the browser
  test, a static screen needed 1 scan instead of 8.
