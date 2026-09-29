# GAIC Text Model v2 — provenance, evaluation, and limitations

`text-detector.js` replaces the four-feature hand-tuned text heuristic that
shipped through GAIC 2.4.0. It runs entirely on the device: the text never
leaves it, and there is no network call, remote model, or telemetry.

| Field | Value |
| --- | --- |
| File | `text-detector.js` (engine and weights in one file, ~75 KB) |
| Model | logistic regression, 56 stylometric measurements + 2,500-term lexicon |
| Version string | `GAIC Text Model v2 (2026-09)`, engine `gaic-text-v2.1` (adds the decision below) |
| Input | English prose that already passed the app's gates (≥1,000 characters, ≥3 sentences, ≥70% of words written in English letters, and the language check below) |
| Output | a **lean** (AI-written or human-written), a **confidence level** (high, medium, low), and an estimated **AI likelihood** (1–99%), plus the technical band and the measurements that drove it |
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

## Decision: lean, confidence, and AI likelihood

Every scored document ends with a lean and a confidence level; there is no
undecided result. All three parts were set on **leave-one-corpus-out**
scores, so they describe writing from sources the model never trained on.
The script is `eval/textcal.py`.

* **Lean.** AI-written when the document logit is ≥ **0.77**, otherwise
  human-written. The threshold maximises balanced accuracy subject to at most
  **5%** of human documents leaning AI (pooled out-of-corpus).
* **AI likelihood.** A monotone knot table from isotonic regression (balanced
  classes) maps the logit to the displayed percentage, shifted so that 50%
  falls exactly on the lean threshold. That shift is a mild prior toward
  "human-written", so a borderline document is never called AI.
* **Confidence.** Each level's cut point is where the isotonic estimate of the
  share of correct leans reaches its target: AI high ≥ 95% (logit ≥ 2.12),
  AI medium ≥ 85% (≥ 1.26); human high ≥ 90% (≤ −5.42, rare), human medium
  ≥ 75% (≤ −0.71). Everything else is low confidence.

Measured share of correct leans per level (balanced classes):

| Lean / confidence | Out-of-corpus: share of docs / correct | Held-out corpora: share / correct |
| --- | --- | --- |
| AI, high | 20% / **98.5%** | 23% / **99.8%** |
| AI, medium | 9% / 90% | 11% / 96% |
| AI, low | 6% / 76% | 6% / 84% |
| Human, medium | 42% / 81% | 41% / 93% |
| Human, low | 23% / 58% | 19% / 52% |

At the lean threshold, human-written documents leaning AI: 4.8% out-of-corpus
(per corpus 0.7–15%; the highest are ImBD-style polished text and CHEAT
abstracts), 2.9% on DetectRL, and 2.6% on the non-native essays of the
detector-bias set. AI documents leaning AI: 64% out-of-corpus, 67% on
DetectRL, 79% on detector-bias, 92% on ArguGPT. A low-confidence lean in
either direction is a close call and the app says so.

A gradient-boosted alternative (dense features alone, stacked on the
logistic margin, or blended with it) was tested under the same protocol and
did not beat this model on out-of-corpus AUC by the required margin, so the
logistic model stays.

## Mixed documents and disguise tricks

**A machine-like section inside human writing.** A document score averages
every passage, so a few paragraphs pasted from an AI tool into an essay barely
move it. When a document leans human-written, the engine also scores
sentence-aligned windows of about 200 words, started every 50 words, and
reports a section when one reaches the model's high band (log-odds 2.47). The
section's location is the run of sentences whose covering windows average at
least 1.5. The app names the words and quotes where the section starts; the
lean is unchanged. Measured on held-out corpora (DetectRL, the detector-bias
essays, and ArguGPT; `eval/mixed_text_eval.mjs`,
`eval/results/text_mixed_disguise.json`):

| | Section reported |
| --- | ---: |
| Human documents on their own | 0.0% |
| 3, 6, or 10 human documents joined into one long text | 0.3–0.5% |

| AI excerpt pasted between three human documents | Document leans AI | Leans AI **or section reported** |
| --- | ---: | ---: |
| about 150 words | 0.0% | 6% |
| about 250 words | 0.2% | **29%** |
| about 400 words | 3.0% | **54%** |

97% of the words in a reported section were the pasted text, the quoted opening
was inside it 90% of the time, and a report covered about 60% of the pasted
section.

**Hidden characters and look-alike letters.** Invisible characters inside
words and letters swapped for look-alikes from other alphabets are common ways
to slip text past detectors. The engine removes both before measuring, so they
cannot move the score, and now also counts them. With three or more, the app
says so. Counting is conservative: soft hyphens, emoji joiners, and Greek
letters in science notation (NF-κB, α-helix) never count. RAID's zero-width
and homoglyph attacks were noticed in 100% and 99.8% of texts. Their plain
versions and the 3,401 held-out human documents triggered it 0% of the time.

## Other languages

The model was trained on English only. The app's letter test (at least 70% of
words written in the letters a–z) turned away Chinese, Arabic, or Cyrillic
text, but Spanish, German, or Polish passed it, and the English model scored
them. On human writing from Universal Dependencies treebanks (paragraphs of
1,200 or more characters), it leaned AI-written on 36% of Basque, 15% of
Finnish, and 10% of Polish paragraphs, and human-written on most of the rest:
either way a read with no basis.

`languageCheck` now runs first, on the normalized text, and counts the
commonest short words:

* **Mostly another language:** at least 12 frequent function words of 13
  widely used Latin-script languages (Spanish, French, German, Italian,
  Portuguese, Dutch, Catalan, Polish, Czech, Swedish, Indonesian, Turkish,
  Vietnamese), and more than twice as many as English ones.
* **No English:** fewer than 3% English function words in 80 or more words.
  This catches languages the list does not cover, and lists such as a
  recipe's ingredients, which are not prose either. Text carrying disguise
  tricks skips this test, so hidden letters cannot turn a check into a refusal.

English function words that are also common words elsewhere (a, i, in, is,
on, to, do, no, me, by, was, will, for, ...) do not count as English, and the
other list leaves out one-letter words and words shared with English. The app
answers "English prose required" and does not count the check. Measured with
`eval/language_check.mjs` (`eval/results/language_check.json`):

| Text | Not scored |
| --- | ---: |
| Human writing in the 13 listed languages (3,513 paragraphs) | **100%** (before: 0%) |
| Human writing in 8 languages not on the list: Afrikaans, Basque, Croatian, Danish, Finnish, Hungarian, Latvian, Romanian (2,233 paragraphs) | **99.8%**, each language at least 99.0% (before: 0%) |
| English prose: essays, news, papers, reviews, web text, and non-native English (9 sources, 4,936 texts) | **0%** |
| RAID and DetectRL English sets, including attacked texts (7,970 texts) | 0.6% |

The RAID and DetectRL cases are texts that are not English prose at all:
posts, poems, and articles in Spanish, Portuguese, Turkish, French, and Welsh
filed in the English sets, ingredient lists, and degenerate repetition.

## Bands (technical read)

The older pattern-signal scale maps the logit piecewise-linearly so that
logit −0.63 → 34 and logit 2.47 → 66 (clamped to 15–85). Its bands are kept
as the "technical read" line under the decisive headline:

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
* It is English-only (text mostly in another language is not scored) and tuned on research corpora from 2019–2024 models.
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
