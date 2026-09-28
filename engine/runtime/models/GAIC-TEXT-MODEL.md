# GAIC Text Model v2 — provenance, evaluation, and limitations

`text-detector.js` replaces the four-feature hand-tuned text heuristic that
shipped through GAIC 2.4.0. It runs entirely on the device: the text never
leaves it, and there is no network call, remote model, or telemetry.

| Field | Value |
| --- | --- |
| File | `text-detector.js` (engine and weights in one file, ~75 KB) |
| Model | logistic regression, 56 stylometric measurements + 2,500-term lexicon |
| Version string | `GAIC Text Model v2 (2026-09)` |
| Input | English prose that already passed the app's gates (≥1,000 characters, ≥3 sentences, ≥70% English word tokens) |
| Output | a 15–85 **pattern signal**, not a probability, plus the band and the measurements that drove it |
| Scoring unit | sentence-aligned passages of ~260 words; the document score is the word-weighted mean of passage logits (at most 64 passages) |

## What it measures

* **Stylometry (56 measurements):** sentence-length mean, spread, variation,
  local changes and skew; word-length profile; windowed type-token ratio
  (MATTR-50) and one-off-word rate; function-word share; punctuation rates
  (commas, semicolons, colons, dashes, parentheses, quotes, ellipses,
  question/exclamation marks); contractions; first/second/third-person
  pronouns; numbers, capitalized names, all-caps words; paragraph structure;
  lowercase sentence starts and lowercase "i"; repeated punctuation; variety
  of sentence openings and stock transitions; repeated word pairs and
  three-word phrases; list and markdown formatting; doubled words and
  spacing slips; rates of vocabulary that published excess-vocabulary
  studies found language models over-use; informal words.
* **Lexicon (2,500 unigrams/bigrams):** chosen by L2-regularized weight ×
  spread, *only* from general-purpose vocabulary that appears in ≥1% of
  documents in at least 8 different training domains. This rule removed
  topic and dataset-format artifacts found in an earlier candidate (for
  example `br` from HTML line breaks, `answer yes` from a QA format, and
  recipe words).
* **Evasion hygiene:** input is NFKC-normalized; zero-width and bidi control
  characters are removed; Cyrillic/Greek look-alike letters are folded to
  Latin; curly quotes and spacing are normalized — so these known tricks
  change neither the measurements nor the score.

## Training data (permissively licensed only)

43,505 documents (20,661 human, 22,844 AI) from 66 generator/attack
configurations. Only corpora whose repositories carry a permissive license
were used for training:

| Corpus | License | Content |
| --- | --- | --- |
| HART (baoguangsheng/truth-mirror) | MIT | essays, news, creative writing, arXiv; GPT-4o, Claude 3.5 Sonnet, Gemini 1.5 Pro, Qwen 2.5 72B, Llama 3.3 70B, GPT-3.5; humanizer-tool and LLM-humanized AI text |
| RAID subset (truth-mirror copy) | MIT | 8 domains, 11 generators, 11 adversarial attacks (homoglyph, zero-width, paraphrase, synonym, …) |
| Glimpse / Fast-DetectGPT data | MIT | XSum, WritingPrompts, PubMedQA; GPT-4, GPT-3.5, Claude 3 Opus/Sonnet, Gemini 1.5 Pro, davinci |
| Ghostbuster data | CC BY 3.0 | essays, Reuters, WritingPrompts (ChatGPT, Claude); learner corpora (TOEFL, ETS, Lang-8, PELIC, BAWE) as human text |
| OUTFOX | Apache-2.0 | student essays vs ChatGPT / davinci-003 / Flan-T5; DIPPER and OUTFOX attacks |
| CHEAT | MIT | IEEE abstracts vs ChatGPT |
| ImBD | Apache-2.0 | XSum vs GPT-4o, GPT-3.5, Llama-3-8B, Qwen2-7B, Mistral-7B, DeepSeek-7B |

Every text was trimmed to its last complete sentence (both classes) so that
truncation artifacts could not be learned. Human text rephrased by an LLM
("AI-polished") was excluded from training and from the binary metrics
because its correct label is ambiguous.

DetectRL, the Liang et al. detector-bias essays, and ArguGPT have no license
in their repositories, so they were used **only as held-out tests** and
never for training.

## Bands

The pattern signal maps the model logit piecewise-linearly so that logit
−0.63 → 34 and logit 2.47 → 66 (clamped to 15–85). The existing verdicts
are reused unchanged:

| Band | Verdict | How the cut-off was chosen |
| --- | --- | --- |
| ≥ 66 | Several formulaic patterns matched | on leave-one-corpus-out scores, no training corpus with ≥100 human documents exceeds 2% flagged, and the corpus-balanced rate is ≤1% |
| 34–65 | Mixed writing patterns | — |
| < 34 | Few formulaic patterns matched | holds ~70% of human documents (corpus-balanced, leave-one-corpus-out) |

## Evaluation

All numbers use only documents that pass the app's own text gates, and
compare against the exact v2.4.0 `analyzeText` code on the same documents.

### Leave-one-corpus-out (each corpus scored by a model trained without it)

| Held-out corpus | Humans / AI | AUC old → new | Humans flagged old → new | AI flagged old → new | AI in "Few" old → new |
|---|---|---|---|---|---|
| cheat | 726 / 449 | 0.89 → **0.95** | 0.0% → 0.1% | 0.0% → **40.1%** | 51.7% → **2.0%** |
| ghostbuster | 4031 / 782 | 0.55 → **0.91** | 0.0% → 0.3% | 0.0% → **34.5%** | 78.3% → **7.3%** |
| glimpse | 143 / 449 | 0.77 → **0.94** | 0.0% → 0.0% | 0.0% → **41.0%** | 90.2% → **9.4%** |
| hart (2024 models) | 3374 / 3604 | 0.79 → **0.99** | 0.0% → 0.8% | 0.0% → **70.0%** | 74.6% → **0.1%** |
| imbd | 26 / 1640 | 0.72 → **0.87** | 0.0% → 3.8% (1 of 26) | 0.0% → **30.5%** | 91.0% → **4.8%** |
| outfox | 1352 / 1191 | 0.27 → **0.87** | 0.0% → 0.1% | 0.0% → **3.4%** | 98.4% → **32.9%** |
| raid | 232 / 224 | 0.68 → **0.76** | 0.0% → 0.0% | 4.5% → **19.6%** | 79.5% → **41.1%** |

* Non-native English writers (1,192 TOEFL/ETS/Lang-8/PELIC essays, held out
  with their corpus): **0.5%** flagged in the top band; 81% in the lowest band.
* Humanized, paraphrased, or attacked AI text (7,443 documents, held out):
  38% flagged, 29% in the lowest band (old heuristic: 86% in the lowest band).

### Fully held-out corpora (never used for training)

| Held-out set | AUC old → new | Humans flagged old → new | AI flagged old → new | AI in "Few" old → new |
|---|---|---|---|---|
| DetectRL (ChatGPT, Claude-instant, PaLM-2, Llama-2-70B; 4 domains) | 0.83 → **0.94** | 0.0% → 0.1% | 0.2% → **31.4%** | 77.1% → **8.8%** |
| DetectRL paraphrased / prompt-attacked / perturbed AI | 0.81 → **0.93** | 0.0% → 0.1% | 0.1% → **27.8%** | 82.0% → **10.5%** |
| Detector-bias student & college essays vs GPT-3 | 0.78 → **0.99** | 0% → 0% | 0% → **31.6%** | 77.2% → **1.8%** |
| ArguGPT AI essays (AI only) | — | — | 0.3% → **51.7%** | 13.6% → **0.5%** |

The old heuristic almost never reached its top band for anything, and put
most AI text in its lowest band.

## Limitations that still apply

* It is a **pattern signal**, not a probability, not proof of authorship, and
  not suitable as the sole basis for any academic, employment, legal, or
  moderation decision. The app copy says so on every result.
* It is English-only and tuned on research corpora from 2019–2024 models.
  Newer models, heavy human editing, deliberate style prompting, and
  paraphrasing reduce recall (see the RAID and OUTFOX rows).
* The top band is conservative by design: it misses much AI text in exchange
  for rarely flagging human writing. "Mixed" is genuinely uncertain.
* Some human genres (formal college essays, formulaic abstracts) land in
  "Mixed" more often than casual writing does.
* Measured rates come from public research collections; they are not a
  guarantee for any single document or population.

## Reproducing

The corpus builder, featurizer (which runs this exact JavaScript engine in
Node so training and shipping share one implementation), trainer, band
selection, and reports live in `engine/eval/` of the gaic-desktop
repository, with a README listing the public sources to clone.
