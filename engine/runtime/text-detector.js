/* GAIC on-device text engine v2.
   A compact linear classifier over stylometric measurements and a pruned
   word/phrase lexicon, trained offline on permissively licensed public
   research corpora (see models/GAIC-TEXT-MODEL.md) and evaluated on corpora it
   never saw. Runs entirely on this device: no text leaves it. The output is a
   pattern signal, not a probability and not proof of authorship. */
(function (global) {
  "use strict";

  const VERSION = "gaic-text-v2.1";
  const CHUNK_WORDS = 260;
  const MIN_CHUNK_WORDS = 120;
  const MAX_CHUNKS = 64;

  // ---------- normalization ----------
  // Zero-width and bidi controls carry no visible text and are a known way to
  // disguise generated prose; lookalike Cyrillic/Greek letters are another.
  // Fold both so the measurements describe what a reader actually sees.
  const INVISIBLE_RE = /[­᠎​-‏‪-‮⁠-⁤⁦-⁯﻿]/g;
  const HOMOGLYPHS = {
    "а": "a", "е": "e", "о": "o", "р": "p", "с": "c",
    "х": "x", "у": "y", "і": "i", "ј": "j", "ѕ": "s",
    "һ": "h", "ԁ": "d", "ԛ": "q", "ԝ": "w", "ɡ": "g",
    "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M",
    "Н": "H", "О": "O", "Р": "P", "С": "C", "Т": "T",
    "Х": "X", "У": "Y", "І": "I", "Ј": "J", "Ѕ": "S",
    "ο": "o", "α": "a", "ε": "e", "ι": "i", "κ": "k",
    "ν": "v", "ρ": "p", "τ": "t", "υ": "u", "χ": "x",
    "Α": "A", "Β": "B", "Ε": "E", "Ζ": "Z", "Η": "H",
    "Ι": "I", "Κ": "K", "Μ": "M", "Ν": "N", "Ο": "O",
    "Ρ": "P", "Τ": "T", "Υ": "Y", "Χ": "X",
  };
  const HOMOGLYPH_RE = new RegExp("[" + Object.keys(HOMOGLYPHS).join("") + "]", "g");

  function normalize(value) {
    return String(value || "")
      .normalize("NFKC")
      .replace(INVISIBLE_RE, "")
      .replace(HOMOGLYPH_RE, (ch) => HOMOGLYPHS[ch] || ch)
      .replace(/[‘’‚‛ʼ′`´]/g, "'")
      .replace(/[“”„‟″«»]/g, '"')
      .replace(/…/g, "...")
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t  -   　]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // ---------- tokenization ----------
  const WORD_RE = /[a-z]+(?:['-][a-z]+)*/g;
  const TOKEN_RE = /[A-Za-z]+(?:['-][A-Za-z]+)*|\d+(?:[.,]\d+)*/g;
  const ABBREVIATIONS = new Set([
    "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc", "e.g", "i.e",
    "inc", "ltd", "co", "corp", "no", "fig", "al", "approx", "dept", "est", "u.s",
    "u.k", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct",
    "nov", "dec", "gen", "gov", "sen", "rep", "rev", "lt", "col", "capt", "sgt",
  ]);

  function splitSentences(text) {
    const out = [];
    const paragraphs = text.split(/\n+/);
    for (const paragraph of paragraphs) {
      const trimmed = paragraph.trim();
      if (!trimmed) continue;
      let start = 0;
      const re = /[.!?]+["')\]]*(?=\s+["'(\[]?[A-Z0-9])/g;
      let match;
      while ((match = re.exec(trimmed))) {
        const end = match.index + match[0].length;
        const before = trimmed.slice(start, match.index);
        const lastWord = (before.match(/([A-Za-z.]+)$/) || ["", ""])[1].toLowerCase();
        if (match[0][0] === "." && match[0].length === 1 &&
            (ABBREVIATIONS.has(lastWord) || /^[a-z]$/.test(lastWord) ||
             /^(?:[a-z]\.)+[a-z]$/.test(lastWord))) {
          continue;
        }
        const sentence = trimmed.slice(start, end).trim();
        if (sentence) out.push(sentence);
        start = end;
      }
      const rest = trimmed.slice(start).trim();
      if (rest) out.push(rest);
    }
    return out;
  }

  // ---------- word lists ----------
  const FUNCTION_WORDS = new Set((
    "a about above after again against all am an and any are as at be because been before being below " +
    "between both but by can could did do does doing down during each few for from further had has have " +
    "having he her here hers herself him himself his how i if in into is it its itself just me more most " +
    "my myself no nor not now of off on once only or other our ours ourselves out over own same she should " +
    "so some such than that the their theirs them themselves then there these they this those through to " +
    "too under until up very was we were what when where which while who whom why will with would you your " +
    "yours yourself yourselves also however although though may might must shall upon whether yet"
  ).split(" "));
  const FIRST_SINGULAR = new Set(["i", "me", "my", "mine", "myself", "i'm", "i've", "i'd", "i'll"]);
  const FIRST_PLURAL = new Set(["we", "us", "our", "ours", "ourselves", "we're", "we've", "we'd", "we'll"]);
  const SECOND_PERSON = new Set(["you", "your", "yours", "yourself", "yourselves", "you're", "you've", "you'd", "you'll"]);
  const THIRD_PERSON = new Set(["he", "him", "his", "she", "her", "hers", "they", "them", "their", "theirs", "it", "its"]);
  const CONTRACTION_RE = /^[a-z]+(?:n't|'re|'ve|'ll|'d|'m)$/;
  // Vocabulary that large language models measurably over-use relative to
  // pre-2023 human writing (published excess-vocabulary studies), plus stock
  // transitions. Used as one aggregate rate, never as proof on its own.
  const LLM_FAVORED = new Set((
    "delve delves delved delving showcase showcases showcased showcasing underscore underscores " +
    "underscored underscoring intricate intricacies meticulous meticulously pivotal realm realms tapestry " +
    "testament commendable invaluable noteworthy crucial vital essential comprehensive robust seamless " +
    "seamlessly leverage leverages leveraging foster fosters fostering fostered garner garnered surpass " +
    "surpassing strategically profound nuanced multifaceted holistic paramount transformative innovative " +
    "unwavering bustling vibrant embark embarking navigate navigating navigates landscape landscapes " +
    "beacon symphony resonate resonates resonating captivating captivate enhance enhances enhancing " +
    "elevate elevates elevating unlock unlocking unleash harness harnessing streamline streamlining empower " +
    "empowering empowers bolster bolstering facilitate facilitates facilitating optimize optimizing pave " +
    "paving insights insightful additionally furthermore moreover ultimately notably importantly " +
    "consequently thereby interplay nuances evolving ever-evolving ever-changing fast-paced dynamic " +
    "dynamics intriguing fascinating remarkable remarkably endeavor endeavors realm vast myriad plethora " +
    "cornerstone hallmark encompass encompasses encompassing profoundly crucially whimsical enigmatic " +
    "serene juxtaposition palpable indelible poignant labyrinth kaleidoscope camaraderie"
  ).split(" "));
  const LLM_PHRASES = [
    "it is important to note", "it's important to note", "it is worth noting", "it's worth noting",
    "in conclusion", "in summary", "plays a crucial role", "play a crucial role", "a testament to",
    "in today's", "delve into", "dive into", "shed light on", "sheds light on", "navigate the",
    "stands as", "serves as a", "not only", "in the realm of", "a rich tapestry", "the world of",
    "when it comes to", "a wide range of", "a variety of", "overall,", "as a result,", "in addition,",
    "on the other hand", "it is essential", "it is crucial", "a deeper understanding", "the importance of",
    "a sense of", "in order to", "the potential to", "can help", "ensure that", "helps to",
  ];
  const HUMAN_INFORMAL = new Set((
    "lol haha hahaha gonna wanna gotta kinda sorta yeah yep nope ok okay dude guys stuff anyway anyways " +
    "honestly literally basically totally pretty super damn crap wtf omg btw idk tbh imo u ur cuz bc " +
    "thats dont cant wont im ive doesnt didnt isnt wasnt youre theyre whats hes shes lmao huh hmm yup " +
    "alright gotten ain't y'all nah meh ugh wow cool awesome"
  ).split(" "));
  const TRANSITION_STARTS = new Set((
    "however moreover furthermore additionally overall ultimately consequently therefore thus " +
    "nevertheless nonetheless meanwhile similarly likewise importantly notably finally firstly secondly " +
    "lastly in conclusion additionally"
  ).split(" "));

  // ---------- dense measurements ----------
  const DENSE_NAMES = Object.freeze([
    "sent_len_mean", "sent_len_std", "sent_len_cv", "frac_short_sent", "frac_long_sent",
    "sent_len_local_diff", "sent_len_max_ratio", "word_len_mean", "word_len_std", "frac_long_words",
    "frac_short_words", "mattr50", "hapax100", "function_ratio", "comma_rate", "semicolon_rate",
    "colon_rate", "dash_rate", "spaced_hyphen_rate", "hyphen_word_rate", "paren_rate", "quote_rate",
    "exclaim_rate", "question_rate", "ellipsis_rate", "contraction_rate", "first_sing_rate",
    "first_plural_rate", "second_rate", "third_rate", "digit_rate", "cap_mid_rate", "allcaps_rate",
    "para_len_sent", "para_rate", "lower_start_rate", "lower_i_rate", "repeat_punct_rate",
    "start_diversity", "transition_start_rate", "llm_word_rate", "llm_phrase_rate",
    "informal_rate", "trigram_repeat", "bigram_repeat", "list_line_rate", "markdown_rate",
    "sent_len_skew", "commas_per_sent_std", "missing_space_rate", "space_before_punct_rate",
    "double_word_rate", "the_rate", "and_start_rate", "but_start_rate", "comma_and_rate",
  ]);

  function mean(values) {
    if (!values.length) return 0;
    let total = 0;
    for (const value of values) total += value;
    return total / values.length;
  }
  function std(values, center) {
    if (values.length < 2) return 0;
    const m = center == null ? mean(values) : center;
    let total = 0;
    for (const value of values) total += (value - m) * (value - m);
    return Math.sqrt(total / values.length);
  }
  function count(text, re) {
    const found = text.match(re);
    return found ? found.length : 0;
  }

  function mattr(words, window) {
    if (words.length <= window) {
      return words.length ? new Set(words).size / words.length : 0;
    }
    const counts = new Map();
    let unique = 0;
    for (let i = 0; i < window; i += 1) {
      const c = counts.get(words[i]) || 0;
      if (!c) unique += 1;
      counts.set(words[i], c + 1);
    }
    let total = unique / window;
    let steps = 1;
    for (let i = window; i < words.length; i += 1) {
      const out = words[i - window];
      const outCount = counts.get(out) - 1;
      if (!outCount) { unique -= 1; counts.delete(out); } else counts.set(out, outCount);
      const c = counts.get(words[i]) || 0;
      if (!c) unique += 1;
      counts.set(words[i], c + 1);
      total += unique / window;
      steps += 1;
    }
    return total / steps;
  }

  function hapaxRate(words, window) {
    if (!words.length) return 0;
    const rates = [];
    for (let start = 0; start < words.length; start += window) {
      const slice = words.slice(start, start + window);
      if (slice.length < window / 2 && rates.length) break;
      const counts = new Map();
      for (const w of slice) counts.set(w, (counts.get(w) || 0) + 1);
      let hapax = 0;
      for (const c of counts.values()) if (c === 1) hapax += 1;
      rates.push(hapax / slice.length);
    }
    return mean(rates);
  }

  function repeatRate(words, n) {
    if (words.length < n + 1) return 0;
    const seen = new Map();
    let total = 0;
    for (let i = 0; i + n <= words.length; i += 1) {
      const key = words.slice(i, i + n).join(" ");
      seen.set(key, (seen.get(key) || 0) + 1);
      total += 1;
    }
    let repeated = 0;
    for (const c of seen.values()) if (c > 1) repeated += c;
    return total ? repeated / total : 0;
  }

  function measure(text) {
    const lower = text.toLowerCase();
    const words = lower.match(WORD_RE) || [];
    const tokens = text.match(TOKEN_RE) || [];
    const sentences = splitSentences(text);
    const n = Math.max(1, words.length);
    const per100 = (value) => (100 * value) / n;

    const sentLens = sentences.map((s) => (s.match(TOKEN_RE) || []).length).filter((len) => len > 0);
    const sentMean = mean(sentLens);
    const sentStd = std(sentLens, sentMean);
    let localDiff = 0;
    for (let i = 1; i < sentLens.length; i += 1) localDiff += Math.abs(sentLens[i] - sentLens[i - 1]);
    localDiff = sentLens.length > 1 ? localDiff / (sentLens.length - 1) / Math.max(1, sentMean) : 0;
    let skew = 0;
    if (sentLens.length > 2 && sentStd > 0) {
      for (const len of sentLens) skew += Math.pow((len - sentMean) / sentStd, 3);
      skew /= sentLens.length;
    }
    const commasPerSent = sentences.map((s) => count(s, /,/g));

    const wordLens = words.map((w) => w.replace(/['-]/g, "").length);
    const wordMean = mean(wordLens);

    let functionCount = 0, contractions = 0, firstSing = 0, firstPlural = 0, second = 0, third = 0;
    let llmWords = 0, informal = 0, hyphenWords = 0, theCount = 0;
    for (const w of words) {
      if (FUNCTION_WORDS.has(w)) functionCount += 1;
      if (CONTRACTION_RE.test(w)) contractions += 1;
      if (FIRST_SINGULAR.has(w)) firstSing += 1;
      if (FIRST_PLURAL.has(w)) firstPlural += 1;
      if (SECOND_PERSON.has(w)) second += 1;
      if (THIRD_PERSON.has(w)) third += 1;
      if (LLM_FAVORED.has(w)) llmWords += 1;
      if (HUMAN_INFORMAL.has(w)) informal += 1;
      if (w.indexOf("-") > 0) hyphenWords += 1;
      if (w === "the") theCount += 1;
    }
    let llmPhrases = 0;
    for (const phrase of LLM_PHRASES) {
      let index = lower.indexOf(phrase);
      while (index !== -1) { llmPhrases += 1; index = lower.indexOf(phrase, index + phrase.length); }
    }

    let capMid = 0, allCaps = 0, digits = 0;
    for (const t of tokens) {
      if (/^\d/.test(t)) digits += 1;
      else if (t.length > 1 && t === t.toUpperCase() && /[A-Z]/.test(t)) allCaps += 1;
    }
    // Capitalized words after the first word of each sentence (names, titles).
    for (const sentence of sentences) {
      const sTokens = sentence.match(TOKEN_RE) || [];
      for (let i = 1; i < sTokens.length; i += 1) {
        const t = sTokens[i];
        if (/^[A-Z][a-z]/.test(t) && t !== "I") capMid += 1;
      }
    }

    const firstWords = sentences.map((s) => ((s.match(/[A-Za-z']+/) || [""])[0]).toLowerCase()).filter(Boolean);
    let transitionStarts = 0, andStarts = 0, butStarts = 0;
    for (const w of firstWords) {
      if (TRANSITION_STARTS.has(w)) transitionStarts += 1;
      if (w === "and") andStarts += 1;
      if (w === "but") butStarts += 1;
    }
    const lowerStarts = sentences.filter((s) => /^["'(\[]?[a-z]/.test(s)).length;

    const paragraphs = text.split(/\n\s*\n|\n/).map((p) => p.trim()).filter(Boolean);
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const listLines = lines.filter((l) => /^(?:[-*•]|\d{1,2}[.)])\s+/.test(l)).length;
    const markdown = count(text, /\*\*[^*\n]+\*\*|^#{1,6}\s/gm);

    let doubleWords = 0;
    for (let i = 1; i < words.length; i += 1) if (words[i] === words[i - 1] && words[i].length > 1) doubleWords += 1;

    const sentCount = Math.max(1, sentLens.length);
    const values = {
      sent_len_mean: sentMean,
      sent_len_std: sentStd,
      sent_len_cv: sentMean ? sentStd / sentMean : 0,
      frac_short_sent: sentLens.filter((l) => l <= 8).length / sentCount,
      frac_long_sent: sentLens.filter((l) => l >= 30).length / sentCount,
      sent_len_local_diff: localDiff,
      sent_len_max_ratio: sentMean ? Math.max(0, ...sentLens) / sentMean : 0,
      word_len_mean: wordMean,
      word_len_std: std(wordLens, wordMean),
      frac_long_words: wordLens.filter((l) => l >= 8).length / n,
      frac_short_words: wordLens.filter((l) => l <= 3).length / n,
      mattr50: mattr(words, 50),
      hapax100: hapaxRate(words, 100),
      function_ratio: functionCount / n,
      comma_rate: per100(count(text, /,/g)),
      semicolon_rate: per100(count(text, /;/g)),
      colon_rate: per100(count(text, /:(?!\/\/)/g)),
      dash_rate: per100(count(text, /[—–]|--/g)),
      spaced_hyphen_rate: per100(count(text, / - /g)),
      hyphen_word_rate: per100(hyphenWords),
      paren_rate: per100(count(text, /\(/g)),
      quote_rate: per100(count(text, /"/g)),
      exclaim_rate: per100(count(text, /!/g)),
      question_rate: per100(count(text, /\?/g)),
      ellipsis_rate: per100(count(text, /\.\.\./g)),
      contraction_rate: per100(contractions),
      first_sing_rate: per100(firstSing),
      first_plural_rate: per100(firstPlural),
      second_rate: per100(second),
      third_rate: per100(third),
      digit_rate: per100(digits),
      cap_mid_rate: per100(capMid),
      allcaps_rate: per100(allCaps),
      para_len_sent: paragraphs.length ? sentCount / paragraphs.length : sentCount,
      para_rate: per100(paragraphs.length),
      lower_start_rate: lowerStarts / sentCount,
      lower_i_rate: per100(count(text, /(?:^|[\s(])i(?=[\s,.;:!?)'])/g)),
      repeat_punct_rate: per100(count(text, /[!?]{2,}|,,|\.\.(?!\.)/g)),
      start_diversity: firstWords.length ? new Set(firstWords).size / firstWords.length : 0,
      transition_start_rate: transitionStarts / sentCount,
      llm_word_rate: per100(llmWords),
      llm_phrase_rate: per100(llmPhrases),
      informal_rate: per100(informal),
      trigram_repeat: repeatRate(words, 3),
      bigram_repeat: repeatRate(words, 2),
      list_line_rate: lines.length ? listLines / lines.length : 0,
      markdown_rate: per100(markdown),
      sent_len_skew: skew,
      commas_per_sent_std: std(commasPerSent),
      missing_space_rate: per100(count(text, /[a-z][,;][A-Za-z]|[a-z]\.[A-Z][a-z]/g)),
      space_before_punct_rate: per100(count(text, /[A-Za-z] [,.;:!?](?:\s|$)/g)),
      double_word_rate: per100(doubleWords),
      the_rate: per100(theCount),
      and_start_rate: andStarts / sentCount,
      but_start_rate: butStarts / sentCount,
      comma_and_rate: per100(count(lower, /, and /g)),
    };
    const dense = new Float64Array(DENSE_NAMES.length);
    DENSE_NAMES.forEach((name, index) => {
      const v = values[name];
      dense[index] = Number.isFinite(v) ? v : 0;
    });
    return { dense, words, sentences, values };
  }

  // Unigram and bigram relative frequencies (per 100 words) for the lexicon.
  function lexicalCounts(words) {
    const counts = new Map();
    for (let i = 0; i < words.length; i += 1) {
      const w = words[i];
      counts.set(w, (counts.get(w) || 0) + 1);
      if (i > 0) {
        const bigram = words[i - 1] + " " + w;
        counts.set(bigram, (counts.get(bigram) || 0) + 1);
      }
    }
    return counts;
  }

  // Split long inputs into sentence-aligned chunks near the training length.
  function chunkText(text) {
    const sentences = splitSentences(text);
    const chunks = [];
    let current = [];
    let words = 0;
    for (const sentence of sentences) {
      const length = (sentence.match(TOKEN_RE) || []).length;
      current.push(sentence);
      words += length;
      if (words >= CHUNK_WORDS) {
        chunks.push(current.join(" "));
        current = [];
        words = 0;
      }
    }
    if (current.length) {
      if (words < MIN_CHUNK_WORDS && chunks.length) {
        chunks[chunks.length - 1] += " " + current.join(" ");
      } else {
        chunks.push(current.join(" "));
      }
    }
    if (chunks.length <= MAX_CHUNKS) return chunks;
    // Evenly subsample very long documents to bound on-device work.
    const picked = [];
    for (let i = 0; i < MAX_CHUNKS; i += 1) {
      picked.push(chunks[Math.floor((i * chunks.length) / MAX_CHUNKS)]);
    }
    return picked;
  }

  // ---------- model ----------
  let MODEL = null;
  function setModel(model) {
    if (!model || !Array.isArray(model.dense) || model.dense.length !== DENSE_NAMES.length) {
      throw new Error("text model does not match this engine");
    }
    const lexicon = new Map();
    for (const [term, weight] of Object.entries(model.lexicon || {})) lexicon.set(term, Number(weight));
    MODEL = Object.freeze({
      version: String(model.version || ""),
      bias: Number(model.bias) || 0,
      dense: model.dense.map((entry) => ({
        mean: Number(entry[0]) || 0,
        scale: Number(entry[1]) || 1,
        weight: Number(entry[2]) || 0,
        clip: Number(entry[3]) || 6,
      })),
      lexicon,
      lexCap: Number(model.lexCap) || 5,
      bands: model.bands || { high: 0, low: 0 },
      effect: Array.isArray(model.effect) && model.effect.length === DENSE_NAMES.length
        ? model.effect.map(Number) : DENSE_NAMES.map(() => 0),
      decision: validDecision(model.decision),
    });
  }

  // A decision is a threshold on the document logit (AI at or above it), a
  // monotone knot table mapping the logit to log-odds for the displayed AI
  // likelihood (0.5 exactly at the threshold), and confidence cut points.
  function validDecision(decision) {
    if (!decision || !Number.isFinite(decision.threshold) || !Array.isArray(decision.knots) ||
        decision.knots.length < 2 || !decision.cuts) return null;
    const knots = decision.knots.map((knot) => [Number(knot[0]), Number(knot[1])]);
    for (let i = 1; i < knots.length; i += 1) {
      if (!(knots[i][0] > knots[i - 1][0]) || knots[i][1] < knots[i - 1][1]) return null;
    }
    const cuts = decision.cuts;
    return Object.freeze({
      threshold: Number(decision.threshold),
      knots: Object.freeze(knots),
      aiHigh: Number(cuts.aiHigh), aiMedium: Number(cuts.aiMedium),
      humanHigh: Number(cuts.humanHigh), humanMedium: Number(cuts.humanMedium),
    });
  }

  function interpolate(knots, x) {
    if (x <= knots[0][0]) return knots[0][1];
    const last = knots[knots.length - 1];
    if (x >= last[0]) return last[1];
    let i = 1;
    while (knots[i][0] < x) i += 1;
    const [x0, y0] = knots[i - 1], [x1, y1] = knots[i];
    return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
  }

  // Every scored document gets a lean and a confidence. The lean is AI at or
  // above the threshold, which was set so that at most 5% of human documents
  // in corpora the model never trained on lean AI. Confidence levels were set
  // so each level's share of correct leans meets a target on those corpora
  // (AI: high 95%, medium 85%; human: high 90%, medium 75%); see
  // models/GAIC-TEXT-MODEL.md.
  function decide(logit) {
    const d = MODEL.decision;
    if (!d || !Number.isFinite(logit)) return null;
    const lean = logit >= d.threshold ? "ai" : "human";
    let percent = Math.round(100 / (1 + Math.exp(-interpolate(d.knots, logit))));
    percent = lean === "ai" ? Math.max(50, Math.min(99, percent)) : Math.max(1, Math.min(49, percent));
    const confidence = lean === "ai"
      ? (logit >= d.aiHigh ? "high" : logit >= d.aiMedium ? "medium" : "low")
      : (logit <= d.humanHigh ? "high" : logit <= d.humanMedium ? "medium" : "low");
    return Object.freeze({ lean, confidence, aiLikelihood: percent });
  }

  function chunkLogit(text) {
    const measured = measure(text);
    const parts = { dense: 0, lexical: 0 };
    let logit = MODEL.bias;
    const contributions = [];
    for (let i = 0; i < DENSE_NAMES.length; i += 1) {
      const spec = MODEL.dense[i];
      let z = (measured.dense[i] - spec.mean) / spec.scale;
      if (z > spec.clip) z = spec.clip;
      if (z < -spec.clip) z = -spec.clip;
      const c = spec.weight * z;
      logit += c;
      parts.dense += c;
      contributions.push([DENSE_NAMES[i], c]);
    }
    const n = Math.max(1, measured.words.length);
    const counts = lexicalCounts(measured.words);
    for (const [term, c] of counts) {
      const weight = MODEL.lexicon.get(term);
      if (weight === undefined) continue;
      const rate = Math.min(MODEL.lexCap, (100 * c) / n);
      logit += weight * rate;
      parts.lexical += weight * rate;
    }
    return { logit, parts, contributions, measured, words: measured.words.length };
  }

  function scoreText(input) {
    if (!MODEL) return null;
    const text = normalize(input);
    const chunks = chunkText(text);
    if (!chunks.length) return null;
    const rows = chunks.map(chunkLogit);
    let weighted = 0, totalWords = 0;
    for (const row of rows) { weighted += row.logit * row.words; totalWords += row.words; }
    const logit = totalWords ? weighted / totalWords : rows[0].logit;
    const flaggedChunks = rows.filter((row) => row.logit >= MODEL.bands.high).length;
    return { logit, chunks: rows, flaggedChunks, text };
  }

  // ---------- display mapping and explanation ----------
  // Bands were set on out-of-fold scores (every corpus scored by a model that
  // never saw it): the high band is where no large held-out human corpus
  // exceeded 2% flags, the low band holds about 70% of held-out human text.
  const SIGNAL_LABELS = Object.freeze({
    sent_len_mean: "average sentence length", sent_len_std: "sentence-length spread",
    sent_len_cv: "sentence-length variation", frac_short_sent: "very short sentences",
    frac_long_sent: "very long sentences", sent_len_local_diff: "changes in length between neighboring sentences",
    sent_len_max_ratio: "longest-sentence outliers", word_len_mean: "average word length",
    word_len_std: "word-length spread", frac_long_words: "long words", frac_short_words: "short words",
    mattr50: "vocabulary variety", hapax100: "one-off words", function_ratio: "function-word share",
    comma_rate: "comma use", semicolon_rate: "semicolons", colon_rate: "colons", dash_rate: "dashes",
    spaced_hyphen_rate: "spaced hyphens", hyphen_word_rate: "hyphenated words", paren_rate: "parentheses",
    quote_rate: "quotation marks", exclaim_rate: "exclamation marks", question_rate: "questions",
    ellipsis_rate: "ellipses", contraction_rate: "contractions", first_sing_rate: "first person (I/me)",
    first_plural_rate: "first person plural (we/our)", second_rate: "second person (you)",
    third_rate: "third-person pronouns", digit_rate: "numbers", cap_mid_rate: "capitalized names and titles",
    allcaps_rate: "all-caps words", para_len_sent: "paragraph length", para_rate: "paragraph breaks",
    lower_start_rate: "sentences starting in lowercase", lower_i_rate: "lowercase \"i\"",
    repeat_punct_rate: "repeated punctuation", start_diversity: "variety of sentence openings",
    transition_start_rate: "stock transitions (Moreover, Overall…)", llm_word_rate: "words language models over-use",
    llm_phrase_rate: "stock phrases", informal_rate: "informal words", trigram_repeat: "repeated three-word phrases",
    bigram_repeat: "repeated word pairs", list_line_rate: "list formatting", markdown_rate: "markdown formatting",
    sent_len_skew: "sentence-length skew", commas_per_sent_std: "uneven comma rhythm",
    missing_space_rate: "missing spaces after punctuation", space_before_punct_rate: "spaces before punctuation",
    double_word_rate: "doubled words", the_rate: "use of \"the\"", and_start_rate: "sentences starting with And",
    but_start_rate: "sentences starting with But", comma_and_rate: "\", and\" constructions",
  });

  function displayScore(logit) {
    const bands = MODEL.bands;
    const slope = 32 / Math.max(0.5, bands.high - bands.low);
    const raw = 34 + (logit - bands.low) * slope;
    return Math.round(Math.max(15, Math.min(85, raw)));
  }

  function band(logit) {
    if (logit >= MODEL.bands.high) return "several";
    if (logit < MODEL.bands.low) return "few";
    return "mixed";
  }

  function analyze(input) {
    const scored = scoreText(input);
    if (!scored) return null;
    // Word-weighted mean of every passage's measurement contributions.
    const totals = new Map();
    let lexical = 0, totalWords = 0;
    for (const row of scored.chunks) {
      for (const [name, value] of row.contributions) {
        totals.set(name, (totals.get(name) || 0) + value * row.words);
      }
      lexical += row.parts.lexical * row.words;
      totalWords += row.words;
    }
    // Cite a measurement only when its contribution points the same way as its
    // standalone difference between human and AI text; conditional corrections
    // between correlated measurements are real but misleading to display.
    const ranked = [...totals.entries()].map(([name, value]) => [name, value / Math.max(1, totalWords)])
      .filter(([name, value]) => {
        const effect = MODEL.effect[DENSE_NAMES.indexOf(name)] || 0;
        return Math.abs(effect) >= 0.1 && Math.sign(effect) === Math.sign(value);
      })
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    const aiSignals = ranked.filter(([, v]) => v > 0.12).slice(0, 3).map(([name]) => SIGNAL_LABELS[name] || name);
    const humanSignals = ranked.filter(([, v]) => v < -0.12).slice(0, 3).map(([name]) => SIGNAL_LABELS[name] || name);
    const lexicalLean = lexical / Math.max(1, totalWords);
    return Object.freeze({
      version: MODEL.version,
      logit: scored.logit,
      score: displayScore(scored.logit),
      band: band(scored.logit),
      decision: decide(scored.logit),
      passages: scored.chunks.length,
      flaggedPassages: scored.flaggedChunks,
      aiSignals: Object.freeze(aiSignals),
      humanSignals: Object.freeze(humanSignals),
      wordChoice: lexicalLean > 0.25 ? "ai" : lexicalLean < -0.25 ? "human" : "neutral",
    });
  }

  global.AICheckTextEngine = Object.freeze({
    analyze,
    displayScore: (logit) => (MODEL ? displayScore(logit) : null),
    decide: (logit) => (MODEL ? decide(logit) : null),
    VERSION,
    DENSE_NAMES,
    normalize,
    splitSentences,
    measure,
    lexicalCounts,
    chunkText,
    setModel,
    scoreText,
    get model() { return MODEL; },
  });
})(typeof window !== "undefined" ? window : globalThis);

/* GAIC Text Model v2 weights: logistic regression over the measurements above
   plus a 2,500-term general-vocabulary lexicon. Provenance, training corpora,
   held-out results, and limits: models/GAIC-TEXT-MODEL.md. */
(function (global) {
  if (!global.AICheckTextEngine) return;
  global.AICheckTextEngine.setModel({"version":"GAIC Text Model v2 (2026-09)","bias":0.192139,"dense":[[29.26154,21.58199,0.156212,6.0],[11.90327,9.69226,0.305576,6.0],[0.42258,0.20117,-0.232106,6.0],[0.07661,0.13243,0.048811,6.0],[0.34052,0.29637,-0.012543,6.0],[0.49275,0.23965,-0.242377,6.0],[1.81289,0.60558,0.027509,6.0],[5.00001,5.44324,0.030119,6.0],[2.68554,0.7025,0.161826,6.0],[0.19353,0.10264,0.215863,6.0],[0.38386,0.08105,-0.066805,6.0],[0.81348,0.06855,0.247036,6.0],[0.58584,0.10466,0.368563,6.0],[0.42376,0.0838,-0.044733,6.0],[5.27277,22.87995,0.352576,6.0],[0.10645,0.41307,-0.225438,6.0],[0.40699,1.20898,0.0832,6.0],[0.11026,0.68281,0.152622,6.0],[0.2587,0.75901,0.088047,6.0],[0.5665,1.00182,-0.147806,6.0],[0.38763,0.89357,-0.388537,6.0],[0.94846,1.98302,-0.079691,6.0],[0.08394,0.4849,0.133717,6.0],[0.1897,5.36871,0.182894,6.0],[0.0717,0.4201,-0.053259,6.0],[0.22725,0.7493,-0.025839,6.0],[1.24874,2.84842,0.038058,6.0],[0.4905,1.08738,-0.003024,6.0],[0.42973,1.34117,0.034664,6.0],[3.0093,2.663,0.026523,6.0],[35.91249,159.96089,0.410308,6.0],[6.05087,5.74241,-0.133974,6.0],[0.63346,1.80443,-0.167751,6.0],[10.00644,5.05454,0.137597,6.0],[0.61898,0.94769,0.161942,6.0],[0.00449,0.04026,-0.050761,6.0],[0.02596,0.22205,-0.197677,6.0],[0.08181,0.4043,0.031972,6.0],[0.81039,0.16492,-0.235505,6.0],[0.09599,0.1283,-0.073204,6.0],[0.51607,0.95518,0.553454,6.0],[0.15214,0.34225,0.196896,6.0],[0.13139,0.44034,-0.09302,6.0],[0.04069,0.08294,0.602643,6.0],[0.11898,0.10072,0.059788,6.0],[0.0033,0.05731,0.087113,6.0],[0.00572,0.12293,0.083241,6.0],[0.3805,0.73753,-0.048473,6.0],[0.98018,0.69053,-0.124625,6.0],[0.02837,0.3634,0.029439,6.0],[0.02382,0.26801,0.012193,6.0],[0.05993,0.66749,-0.263698,6.0],[5.88355,2.89011,0.197452,6.0],[0.00823,0.03528,0.008002,6.0],[0.01211,0.04029,0.093161,6.0],[0.33572,0.57225,0.119025,6.0]],"lexicon":{"a":0.11368,"a better":-0.15245,"a big":-0.0465,"a bit":0.02371,"a certain":0.02827,"a chance":0.04089,"a comprehensive":0.03115,"a couple":-0.033,"a critical":0.0416,"a crucial":0.04509,"a deep":0.06454,"a different":0.07578,"a few":0.04267,"a friend":-0.04258,"a good":-0.12945,"a group":0.06965,"a high":-0.02639,"a huge":-0.05675,"a large":0.07528,"a little":-0.07317,"a long":-0.03896,"a lot":-0.14028,"a major":0.05803,"a man":0.07098,"a more":0.15098,"a new":0.01627,"a number":-0.06204,"a part":0.04916,"a person":-0.07222,"a place":0.02407,"a positive":0.03347,"a powerful":0.04908,"a result":-0.17506,"a second":-0.06963,"a sense":0.10938,"a significant":0.21002,"a single":-0.02233,"a small":0.09578,"a specific":-0.05722,"a testament":0.06796,"a time":0.05568,"a unique":0.02908,"a variety":0.02896,"a way":0.07662,"a world":0.09055,"a year":-0.06204,"a young":0.05792,"abilities":0.03607,"ability":0.08734,"ability to":0.12707,"able":0.0155,"able to":-0.00959,"about":0.10428,"about the":0.04878,"about this":0.03791,"above":-0.09466,"academic":0.22097,"access":0.08037,"access to":0.09835,"according":0.07277,"according to":0.05783,"account":0.04108,"accounts":0.04163,"accurate":0.19174,"accurately":0.16817,"achieve":0.04367,"achieved":-0.02648,"achievement":0.05535,"achieving":0.05811,"across":0.1457,"across the":-0.01825,"actions":0.06464,"activities":0.15869,"activity":-0.03111,"actual":-0.04062,"actually":-0.0464,"adapt":0.04936,"add":0.03711,"added":-0.03793,"addition":-0.09852,"addition to":0.05563,"additional":-0.04235,"additionally":0.08858,"additionally the":0.04738,"address":0.02966,"addressing":0.02403,"advanced":0.06472,"advantage":0.06778,"advantages":0.21593,"adventure":0.08898,"advice":0.13144,"affect":-0.10395,"affected":-0.02457,"africa":-0.06274,"after":-0.13054,"after a":0.0242,"after the":-0.03622,"again":0.06433,"against":0.10911,"against the":-0.01984,"age":0.05465,"ago":-0.10339,"agree":-0.16006,"ahead":0.11652,"aid":-0.02727,"aim":-0.02622,"aimed":0.06695,"aimed at":0.0271,"aims":0.04349,"aims to":0.0931,"air":0.06528,"al":-0.26435,"alien":0.11464,"alike":0.075,"all":-0.16813,"all of":-0.15521,"all the":-0.04921,"allow":-0.10592,"allowed":-0.02718,"allowing":0.15746,"allows":-0.06953,"almost":-0.22562,"alone":0.02806,"along":-0.04647,"along with":-0.05354,"alongside":0.05026,"already":0.05213,"also a":0.02394,"alternative":0.02802,"although":-0.23139,"always":-0.06081,"american":0.1044,"amidst":0.1279,"among":0.08816,"amount":-0.05883,"amount of":-0.10656,"an":-0.04229,"analysis":-0.03038,"ancient":0.06067,"and":0.04372,"and a":-0.08545,"and all":-0.05257,"and also":-0.16469,"and an":-0.03433,"and are":0.02429,"and as":0.03516,"and can":0.05446,"and even":-0.03525,"and has":0.04659,"and have":-0.02788,"and he":0.01603,"and his":-0.0504,"and i":0.0319,"and is":0.04614,"and it":-0.05141,"and its":-0.01814,"and make":0.02567,"and many":-0.04525,"and my":-0.03891,"and not":-0.0254,"and now":-0.02497,"and on":-0.04165,"and one":-0.07898,"and other":0.04333,"and so":0.03406,"and some":-0.0713,"and that":0.04248,"and the":0.05376,"and their":-0.06509,"and then":-0.07041,"and they":0.02575,"and this":-0.02626,"and to":0.0956,"and was":0.06332,"and we":0.07574,"and what":-0.03096,"and will":0.04292,"anger":-0.05807,"angry":-0.06038,"animals":-0.03846,"announced":0.11206,"another":-0.02136,"any":0.17662,"anyone":0.16504,"anything":0.03651,"appear":-0.02801,"appearance":-0.02579,"appears":-0.04256,"application":-0.22634,"applications":0.02625,"applied":-0.04704,"apply":-0.02988,"appreciate":0.04825,"approach":0.12515,"approach to":0.03385,"approaches":-0.23845,"appropriate":-0.03131,"approximately":0.05274,"april":0.03114,"are":-0.23752,"are a":0.03937,"are also":0.06658,"are being":0.04328,"are in":0.03532,"are not":0.1022,"are the":-0.04922,"are you":0.04095,"area":-0.09,"areas":0.10009,"argue":0.12168,"argue that":0.08035,"army":-0.08864,"around":-0.0117,"around the":-0.02769,"art":-0.03807,"article":-0.08758,"artificial":0.05587,"as":0.05645,"as a":-0.12195,"as an":-0.02577,"as he":0.02163,"as i":0.17582,"as if":0.09882,"as it":0.03598,"as one":0.02873,"as she":0.03725,"as the":0.14419,"as they":0.05081,"as we":0.08722,"as well":-0.11365,"as you":0.07742,"ask":-0.05914,"asked":-0.02575,"asking":-0.11921,"aspect":-0.04215,"aspects":-0.03891,"assessment":-0.12615,"associated":-0.02561,"associated with":0.02039,"association":0.01867,"at":-0.01252,"at a":0.03794,"at all":0.05643,"at first":0.07408,"at her":-0.0467,"at least":0.02242,"at the":-0.10518,"at this":-0.03146,"attack":-0.06618,"attacks":-0.02621,"attempt":-0.03195,"attempt to":-0.03209,"attempts":-0.0372,"attention":-0.04738,"attention to":-0.04248,"authorities":0.11413,"authority":-0.02901,"availability":-0.03759,"average":-0.11145,"away":-0.0141,"away from":-0.04036,"baby":-0.03433,"back":-0.12521,"back in":0.02954,"back to":0.02242,"background":-0.06609,"bad":-0.02364,"balance":0.09491,"ball":-0.04082,"bank":0.0109,"bar":-0.01579,"base":-0.05608,"based":-0.16675,"based on":-0.0344,"basic":-0.03423,"basis":-0.11238,"be":-0.03202,"be a":-0.04759,"be able":-0.0832,"be an":0.03293,"be in":-0.06834,"be the":-0.04237,"be used":0.10067,"beautiful":-0.0458,"beauty":0.03797,"because":-0.24538,"because it":-0.07049,"because of":-0.04444,"because the":-0.02462,"because they":-0.07732,"become":0.11752,"becomes":-0.0242,"becoming":-0.06116,"bed":-0.05291,"been":0.07046,"been a":0.07619,"before":-0.02387,"before the":-0.03795,"began":0.01421,"begin":-0.04813,"beginning":-0.04214,"begins":-0.0591,"behavior":0.04928,"behind":0.0598,"being":0.01405,"being a":-0.03831,"beings":0.03668,"believe that":-0.14219,"believed":0.05432,"believes":-0.04587,"beloved":0.05687,"below":0.01855,"beneficial":-0.04928,"benefit":-0.03032,"benefits":0.18748,"best":0.03086,"better":-0.01767,"between":-0.00912,"between the":-0.02494,"beyond":0.08714,"beyond the":0.02933,"big":-0.19253,"biggest":-0.04292,"bill":-0.04923,"bit":-0.02716,"black":-0.04163,"blue":-0.04684,"board":0.07179,"body":-0.08734,"book":-0.08907,"books":-0.02553,"born":0.10669,"both":0.08841,"bound":-0.03144,"box":-0.02812,"boy":-0.01935,"brain":-0.03901,"brand":-0.07126,"break":-0.02336,"breaking":0.03169,"bright":0.02161,"bring":0.05957,"bringing":0.0282,"british":0.00975,"broader":0.10373,"broke":0.03722,"brother":-0.0651,"brought":-0.05237,"brown":-0.06788,"building":-0.09595,"business":-0.13173,"businesses":0.0228,"but":0.09125,"but a":-0.02902,"but also":0.02519,"but as":0.10246,"but i":0.03434,"but it":0.1094,"but that":-0.04875,"but the":-0.01976,"buy":-0.09663,"by":-0.05997,"by a":0.04891,"by an":0.03416,"by the":0.09055,"called":-0.04243,"calling":0.0349,"calls":0.048,"came":-0.05557,"camera":-0.07189,"campaign":-0.06136,"can":-0.01403,"can also":0.02238,"can be":-0.01763,"can do":-0.05014,"can help":-0.11188,"can lead":0.1148,"capabilities":0.03099,"capable":0.04253,"capable of":0.03835,"capacity":-0.02155,"capital":-0.07315,"captain":0.07381,"capture":0.04636,"car":-0.08926,"care":-0.01573,"care of":-0.02735,"career":0.03267,"careful":0.0743,"carefully":0.0818,"carried":-0.05347,"carry":-0.04631,"case":-0.05905,"cases":-0.05028,"cast":0.05451,"caught":0.04702,"cause":-0.08711,"caused":0.02411,"caused by":0.02259,"causing":0.08631,"cell":0.10864,"center":-0.0288,"centre":-0.06056,"century":-0.11772,"certain":0.1634,"challenge":0.06497,"challenges":0.17683,"challenging":0.03007,"chance":-0.03959,"chance to":-0.04684,"change":-0.05362,"changed":-0.0784,"changes":-0.03273,"changing":-0.05465,"channel":-0.03228,"chaos":0.10913,"character":0.06984,"characteristics":-0.0469,"characters":0.0741,"child":-0.04936,"childhood":-0.03512,"children":0.05487,"china":0.06681,"chinese":-0.05165,"choice":-0.01557,"chosen":0.04779,"circumstances":0.08487,"cities":0.05105,"city":-0.00726,"civil":-0.02638,"claim":-0.03446,"claimed":0.07001,"claims":-0.03822,"class":-0.13753,"classes":-0.03905,"clean":0.03063,"clear":0.1293,"clearly":-0.0475,"climate":0.04898,"clinical":-0.01749,"close":-0.02959,"club":0.02358,"cold":0.03845,"collaboration":0.03152,"college":0.12526,"color":-0.05425,"combination":0.0401,"combination of":0.05205,"combined":0.02975,"come":-0.01416,"come to":0.02461,"comes":0.07753,"comfort":0.04542,"comfortable":-0.04166,"coming":0.03701,"commitment":0.12404,"common":-0.05057,"communication":-0.01916,"communities":0.03114,"community":0.15868,"companies":0.03253,"company":0.02527,"compared":-0.05881,"compared to":0.07133,"comparison":-0.03978,"compelling":0.03567,"competition":0.09678,"complete":-0.05989,"complex":0.05716,"complexity":-0.04451,"comprehensive":0.05575,"computer":-0.21603,"concept":-0.05443,"concepts":-0.04389,"concern":0.09848,"concerns":0.21484,"conclusion":0.08053,"conditions":0.02231,"conducted":-0.02592,"confidence":0.07896,"conflict":0.02998,"connected":-0.0392,"connection":0.05695,"consequences":0.12557,"consequently":-0.05218,"consider":0.03198,"considered":-0.04049,"considering":-0.02578,"constant":0.05635,"construction":-0.0431,"content":-0.02666,"context":-0.04065,"continue":0.16234,"continue to":0.05244,"continued":0.06025,"continued to":0.03538,"continues":0.09711,"continues to":0.0672,"contribute":0.11117,"contribute to":0.10991,"contributing":0.04914,"control":-0.06777,"conventional":-0.0735,"conversation":0.07375,"cool":0.04084,"core":-0.07131,"costs":0.13892,"could":-0.12662,"could have":-0.01853,"could not":-0.05707,"couldn't":0.02131,"council":-0.03365,"countries":0.03304,"country":0.04963,"couple":-0.0681,"couple of":-0.03902,"courage":0.04925,"court":-0.01257,"covered":-0.08386,"create":0.06817,"create a":0.02702,"created":-0.05876,"creating":0.01788,"criminal":-0.01977,"critical":0.06866,"criticism":0.03076,"critics":0.04789,"crucial":0.10417,"crucial for":0.04406,"cultural":0.06906,"culture":-0.07759,"cultures":0.02936,"cup":0.39484,"current":-0.0424,"currently":0.05273,"customer":0.0299,"customers":0.09137,"cut":-0.02726,"daily":0.02794,"damage":0.02598,"danger":0.04525,"dangerous":0.0717,"dark":0.01475,"data":-0.13132,"david":0.02186,"day":-0.04879,"days":-0.04872,"dead":-0.11777,"deal":0.02522,"deal with":-0.04872,"debate":0.11413,"decades":0.05258,"decision":0.14276,"decision to":0.0365,"decisions":0.08862,"deep":-0.05337,"deeper":0.07738,"deeply":0.05723,"definitely":-0.11333,"degree":0.02535,"delicate":0.03954,"delivery":0.02153,"demand":0.06575,"democratic":0.04196,"demonstrate":0.02018,"demonstrated":-0.03495,"department":-0.0269,"depth":0.0422,"describe":-0.08155,"described":-0.06386,"design":-0.1877,"designed":-0.02114,"designed to":0.08762,"desire":0.04282,"despite":0.22295,"despite the":0.07672,"details":0.04315,"determination":0.09695,"determine":0.05156,"determined":0.08825,"develop":-0.02441,"developed":-0.10334,"developing":-0.02616,"development":-0.03045,"devices":-0.01411,"did":-0.11236,"did not":-0.10592,"didn't":-0.06644,"died":-0.06805,"differences":-0.05829,"different":-0.05855,"difficult":0.03985,"difficulties":0.05772,"digital":0.05293,"dinner":-0.03521,"direct":0.04459,"directly":-0.0992,"discover":-0.0403,"discovered":0.0659,"discovery":0.07042,"discuss":0.03044,"discussed":-0.08432,"discussions":0.05067,"disease":-0.0319,"distance":-0.09767,"distribution":-0.0526,"diverse":0.05022,"diversity":-0.03842,"do not":0.02192,"do you":0.08664,"doctor":-0.04173,"does":0.0126,"does not":-0.09292,"dog":-0.0271,"doing":-0.12342,"don't":0.02815,"don't know":0.04056,"door":-0.03691,"doubt":-0.03195,"down":-0.11892,"down and":-0.04883,"down the":0.03541,"down to":-0.03365,"dr":0.02007,"dream":0.0301,"drink":-0.03217,"drive":-0.01614,"driven":0.03207,"driven by":0.04993,"driving":-0.02311,"drop":-0.03695,"drug":-0.03892,"due":-0.03062,"due to":-0.06419,"during":0.11781,"during the":-0.07562,"dynamic":-0.23677,"dynamics":-0.0648,"each":0.16481,"each other":-0.06566,"earlier":-0.04318,"early":-0.01236,"earth":-0.01428,"easier":-0.02792,"east":-0.03064,"easy":0.06116,"eating":-0.02871,"economic":0.02497,"economy":0.01837,"edge":-0.06858,"education":-0.03794,"educational":0.10102,"effective":0.11389,"effectively":0.08247,"effectiveness":0.17743,"effects":-0.01372,"efficiency":0.09369,"efficient":0.10878,"effort":0.05271,"efforts":0.10214,"eight":-0.06465,"elderly":-0.0442,"election":0.10273,"electric":-0.0541,"elements":-0.01705,"else":0.15835,"embrace":0.09466,"emerged":0.1068,"emergency":0.0625,"emotional":0.11211,"emotions":-0.02509,"employees":-0.03497,"employment":-0.0378,"enabling":0.05407,"encourage":0.04049,"end":-0.00742,"end of":-0.09847,"energy":-0.06255,"engage":0.0401,"engaging":0.05971,"engineering":-0.05106,"england":0.09038,"english":-0.0466,"enhance":0.01728,"enhanced":0.05795,"enhancing":0.02514,"enjoy":0.07863,"enough":-0.04482,"enough to":-0.03605,"ensure":0.1677,"ensuring":0.15674,"entirely":0.06389,"environment":-0.01474,"environmental":-0.04351,"era":0.03348,"escape":0.09511,"especially":0.03165,"essence":0.04127,"essential":-0.01995,"establish":0.04004,"established":-0.04199,"etc":0.02715,"europe":0.04218,"evaluation":-0.06686,"even":-0.02794,"even in":0.0587,"evening":0.0902,"event":0.05189,"events":-0.12129,"eventually":0.02283,"ever":-0.07557,"everyday":-0.05488,"everyone":0.04674,"everything":0.02109,"evidence":0.12857,"evolution":-0.03537,"exactly":0.02838,"example":-0.20438,"example of":-0.0238,"examples":-0.03784,"excellent":0.03615,"exchange":-0.03973,"excitement":0.05005,"exciting":0.03325,"existence":0.0578,"existing":-0.04787,"expansion":0.02061,"expectations":0.06578,"expected":0.10495,"expected to":0.13548,"expensive":-0.04582,"experience":0.18486,"experienced":0.08647,"experiences":0.16986,"experts":0.05463,"explained":0.0491,"exploration":0.13929,"explores":0.05536,"expressed":0.24569,"expression":0.01726,"extraordinary":0.03575,"extremely":-0.03857,"eye":0.03338,"eyes":0.1213,"face":0.0434,"face of":0.04897,"faced":0.11882,"faces":0.07641,"facing":0.05605,"fact":-0.09463,"factor":-0.02485,"factors":0.0472,"failed":0.03031,"failed to":0.05689,"failure":-0.03131,"fall":-0.02397,"falling":-0.03082,"familiar":0.07324,"family":0.02477,"family and":0.03045,"fans":0.14056,"far":0.0154,"fast":-0.07445,"fate":0.08792,"father":-0.06568,"favorite":-0.04111,"fear":0.06546,"feature":0.0605,"features":-0.0496,"february":-0.04154,"feel":-0.08185,"feeling":0.10369,"felt":0.13378,"female":-0.05766,"few":-0.07278,"field":0.03539,"field of":0.14472,"fields":0.0642,"fight":0.02348,"fighting":-0.0325,"figure":0.06156,"figures":0.06341,"filled":0.13425,"filled with":0.10127,"film":0.08599,"final":0.05307,"finally":-0.07018,"finance":-0.02388,"financial":0.05746,"find":0.18052,"finding":-0.02783,"findings":0.02991,"fine":-0.04018,"fire":0.05634,"firm":-0.04083,"first":-0.10681,"first time":-0.02134,"firstly":-0.02993,"fit":-0.03704,"five":-0.1453,"floor":-0.01838,"flow":0.02255,"focus":0.10802,"focus on":0.06778,"focused":-0.05193,"focused on":-0.0426,"focuses":0.09054,"follow":-0.04598,"followed":-0.07503,"following":0.0666,"follows":0.03396,"food":-0.07882,"football":0.0431,"for":0.14837,"for a":-0.01302,"for all":0.07625,"for an":0.05043,"for any":0.04453,"for each":-0.05154,"for example":-0.08368,"for her":0.03933,"for his":0.1107,"for instance":-0.08344,"for its":0.04304,"for me":-0.01993,"for my":-0.03455,"for one":-0.06446,"for the":-0.05697,"for their":-0.03271,"for them":-0.08334,"for those":0.03381,"for us":-0.03301,"for years":0.04799,"for you":0.02687,"for your":0.03342,"force":-0.02901,"foreign":0.03106,"forever":0.12397,"form":-0.05044,"formed":-0.03964,"former":0.01478,"forms":-0.02887,"forward":0.11456,"fostering":0.03073,"found":0.08791,"foundation":-0.02007,"fourth":-0.0289,"france":-0.08885,"freedom":0.0814,"french":-0.13196,"fresh":0.10277,"friend":-0.07632,"friends":-0.12365,"from":-0.06784,"from a":-0.02616,"from his":-0.02452,"from my":-0.10557,"from the":-0.06442,"front":-0.07043,"front of":-0.03932,"full":-0.04798,"fully":0.03287,"fun":-0.07983,"function":-0.09753,"further":0.14855,"furthermore":-0.09577,"future":0.08449,"future of":0.03272,"gained":0.02784,"game":0.08176,"games":-0.04369,"gave":-0.10689,"general":-0.07799,"generation":-0.06623,"generations":0.03313,"german":-0.04131,"get":-0.12688,"get a":-0.02444,"get to":-0.0752,"gets":0.04772,"getting":-0.01603,"girl":0.03067,"give":0.05946,"given":-0.0736,"gives":-0.03361,"global":-0.03241,"go":-0.1087,"go to":-0.05304,"goals":0.06132,"god":-0.07346,"goes":-0.04075,"going":-0.06248,"going to":-0.03683,"gold":0.04742,"golden":0.03336,"gone":0.04864,"good":-0.11903,"government":-0.02639,"governments":0.04676,"great":0.01901,"greater":0.08164,"greatest":-0.05426,"green":-0.04771,"grew":0.04061,"ground":0.0243,"group":-0.04571,"group of":0.03414,"groups":0.0112,"grow":-0.05415,"growing":0.06164,"growth":0.05976,"guess":-0.03227,"guide":0.02958,"guy":-0.02289,"had":0.03397,"had been":0.07207,"hair":-0.03234,"half":-0.10785,"handle":0.0318,"hands":0.02352,"happen":-0.0813,"happened":0.08166,"happens":0.03973,"happy":-0.06305,"hard":-0.06825,"hard to":-0.06288,"has":0.17486,"has a":-0.15851,"has also":0.05901,"has been":0.06488,"has the":-0.04629,"has to":-0.04566,"have":-0.00655,"have a":-0.0456,"have an":0.05806,"have been":-0.00827,"have no":0.03271,"have not":0.03518,"have to":-0.0266,"have you":-0.04436,"having":-0.11773,"having a":-0.04028,"he":-0.05546,"he could":-0.03961,"he had":0.05024,"he has":0.0582,"he is":0.0574,"he said":0.0087,"he was":0.10938,"he will":0.03963,"he would":0.05784,"he's":0.03515,"head":-0.14921,"health":-0.02972,"health and":0.04872,"healthcare":0.10391,"healthy":-0.05683,"hear":-0.05167,"heard":-0.0307,"heart":0.3009,"heart of":0.04615,"heat":-0.0234,"heavily":0.02515,"heavy":0.04044,"held":0.03053,"help":-0.14348,"helped":-0.0259,"helps":-0.02501,"hence":-0.07853,"her":0.1141,"here":-0.00861,"here's":0.20287,"hero":0.03843,"herself":0.02588,"hidden":0.09714,"high":-0.05493,"higher":0.04933,"highlight":0.03928,"highlighted":0.07989,"highlighting":0.12794,"highlights":0.13445,"highlights the":0.10646,"highly":0.02045,"him":-0.12572,"him to":0.0237,"himself":-0.03747,"his":0.09653,"his own":0.05527,"history":0.02761,"hit":-0.03945,"home":0.03802,"hope":0.18108,"hopes":0.02969,"hoping":0.05169,"hot":-0.02068,"hour":-0.05459,"hours":-0.01362,"house":-0.03717,"how":0.04959,"how much":0.04144,"how the":-0.10518,"how to":0.0175,"however":0.16728,"however the":0.11693,"huge":-0.12302,"humans":-0.09629,"husband":-0.04306,"i":-0.145,"i believe":-0.13729,"i can":-0.05917,"i can't":0.07235,"i didn't":-0.03884,"i don't":0.0266,"i feel":0.03213,"i felt":0.02156,"i found":0.05883,"i had":0.04471,"i have":0.08912,"i knew":0.04655,"i know":-0.01948,"i said":0.03578,"i think":-0.16479,"i want":-0.01836,"i was":0.01013,"i will":-0.03026,"i would":0.04674,"i'd":-0.09906,"i'll":0.02302,"i'm":0.19822,"i've":0.08357,"idea":-0.11545,"ideas":0.022,"identified":-0.07276,"identify":0.0171,"identifying":0.02327,"identity":-0.10852,"if":0.0977,"if a":-0.08135,"if it":0.0549,"if they":-0.06531,"if you":-0.04905,"ii":0.05844,"image":-0.08741,"images":0.0307,"imagination":0.09224,"immediate":0.07243,"immediately":0.03417,"immense":0.05354,"impact":0.13237,"impact of":0.05364,"impact on":0.02676,"implementation":-0.03556,"implementation of":0.02368,"implemented":-0.05085,"implications":0.13621,"importance":0.06916,"importance of":0.08824,"important":0.03805,"impossible":0.0444,"impressive":0.07104,"improve":0.12128,"improve the":0.08446,"improvement":-0.0516,"improving":0.15065,"in":0.01271,"in a":-0.00637,"in addition":-0.1295,"in all":0.02908,"in an":0.04823,"in and":0.02847,"in both":-0.03852,"in conclusion":0.05117,"in fact":-0.05047,"in front":-0.03215,"in her":0.05269,"in his":-0.0259,"in its":0.07938,"in many":-0.07019,"in my":-0.06337,"in new":0.03812,"in one":-0.06531,"in order":-0.18973,"in other":0.02714,"in our":-0.07709,"in particular":-0.05794,"in recent":0.13601,"in response":0.06473,"in terms":0.06805,"in that":-0.02289,"in the":0.07903,"in their":0.05864,"in these":0.03198,"in this":-0.24058,"in various":0.12528,"in which":-0.08513,"include":-0.02343,"included":-0.06014,"includes":-0.02015,"including":0.21853,"including the":0.03188,"income":-0.08753,"increase":-0.01902,"increased":0.04415,"increases":-0.105,"increasing":-0.02001,"increasingly":0.02765,"indeed":-0.05329,"independence":-0.02821,"independent":-0.05759,"india":0.02762,"indicate":0.02727,"individual":0.05921,"individuals":0.28998,"industrial":-0.07327,"industries":-0.03457,"industry":0.0639,"information":-0.26091,"informed":0.04457,"infrastructure":0.03621,"initially":0.03952,"injuries":0.08494,"innovation":0.04619,"inside":0.04778,"insight":0.04351,"insights":0.1302,"insights into":0.08732,"instance":-0.08465,"instead":0.09718,"integration":-0.01931,"intelligence":-0.04327,"intense":0.06199,"interest":-0.03799,"interested":0.0301,"interesting":-0.04249,"interests":0.05953,"internal":-0.03139,"international":0.0679,"internet":-0.0181,"intervention":0.02778,"into":0.03959,"into the":0.03487,"intricate":0.05813,"introduce":-0.10906,"introduced":-0.11593,"introduction":-0.04262,"investigation":0.16185,"investment":0.07122,"involved":0.15535,"involved in":0.10012,"involvement":0.06988,"involves":0.1467,"involving":0.04304,"is":-0.23876,"is a":0.18885,"is also":0.06864,"is an":0.02123,"is based":0.13405,"is being":0.05457,"is crucial":0.04322,"is important":0.07703,"is it":0.0727,"is just":-0.02774,"is my":-0.03849,"is no":0.03972,"is not":0.12929,"is now":0.05363,"is set":0.0677,"is so":0.03631,"is still":0.02773,"is that":0.04011,"is the":-0.02512,"is this":0.0389,"is to":-0.03092,"is what":-0.07472,"issue":0.02861,"issues":0.03644,"it":-0.03325,"it a":0.0488,"it all":0.02955,"it also":-0.03099,"it and":-0.08041,"it can":-0.03045,"it could":-0.04615,"it has":-0.0722,"it in":-0.0255,"it is":0.10775,"it may":0.06708,"it seems":0.03428,"it should":0.03356,"it the":-0.05999,"it to":-0.04711,"it was":0.07088,"it will":-0.01912,"it's":0.09887,"it's a":0.04983,"it's not":0.13021,"its":0.22483,"itself":-0.07824,"japanese":-0.03711,"job":-0.10504,"jobs":0.02367,"john":-0.05255,"joined":-0.03255,"joint":-0.06559,"journey":0.22092,"joy":0.10899,"june":-0.02113,"just":0.05366,"just a":0.02664,"just as":0.02752,"just like":-0.05015,"justice":0.04825,"keep":-0.06337,"key":0.0444,"kid":-0.08814,"kids":-0.09448,"kill":-0.05232,"knew":0.0755,"know":-0.09711,"know that":0.04634,"know what":-0.02757,"knowing":0.03282,"knowledge":-0.06163,"known":0.09959,"known as":0.02115,"knows":-0.0378,"lack":0.05683,"lack of":0.03955,"landscape":0.03372,"language":-0.06563,"large":-0.07314,"largest":0.06387,"last":-0.0525,"later":-0.05239,"latest":0.07677,"law":-0.02922,"lay":0.02895,"lead":0.14654,"lead to":0.11446,"leader":-0.04818,"leading":0.18091,"leading to":0.13098,"learned":-0.05305,"learning":0.00948,"least":-0.02106,"leave":0.05869,"leaving":0.1386,"led":0.13112,"led by":0.03825,"left":0.08386,"legacy":0.07022,"legal":0.05234,"less":0.01097,"let":0.1257,"let me":0.03654,"let's":0.05677,"letter":-0.07148,"level":-0.03413,"levels":0.16403,"levels of":0.0232,"lies":0.06091,"life":0.13449,"life and":0.0336,"light":0.05269,"like":0.12054,"like it":-0.03294,"like that":-0.04008,"like to":-0.1296,"likely to":0.01971,"limitations":0.05419,"line":0.02672,"lines":-0.06421,"listen":0.02438,"literature":-0.10386,"little":-0.1005,"live":-0.03727,"live in":-0.03225,"lives":0.07168,"living":0.04704,"local":0.06822,"located":0.04823,"location":-0.02509,"london":0.04505,"long":0.0651,"long-term":0.07769,"look":-0.07766,"looked":-0.12058,"looking":0.0233,"looks":-0.02952,"lose":-0.03284,"loss":0.03906,"loss of":0.05322,"lost":0.04934,"lot":-0.15893,"lot of":-0.04167,"lots":-0.04523,"love":0.02736,"low":-0.07344,"machine":-0.07783,"machines":0.05863,"made":-0.01227,"magic":0.08291,"main":-0.16091,"mainly":-0.10198,"maintain":0.11972,"maintaining":0.10706,"maintenance":0.03961,"majority":0.02831,"make":-0.07649,"make a":-0.03282,"make it":0.03245,"make sure":0.02945,"make the":-0.06619,"makes":-0.06366,"making":0.24186,"making it":0.1515,"man":-0.09994,"manage":-0.03322,"management":-0.11874,"managing":0.05419,"many":-0.1146,"many of":-0.0939,"many people":0.08244,"march":-0.05993,"mark":0.20968,"marked":0.07687,"market":-0.14906,"marriage":-0.04036,"match":0.09408,"materials":-0.03525,"matter":0.12866,"matters":0.03245,"may":-0.02501,"may be":-0.10824,"may not":0.10743,"maybe":-0.03788,"me":-0.0132,"me and":-0.07289,"me the":0.03782,"mean":-0.06323,"meaning":-0.02716,"means":0.0242,"measures":0.07007,"mechanisms":-0.0382,"medical":0.04448,"member":0.08999,"members":-0.09069,"memories":0.05268,"memory":-0.02886,"men":-0.19004,"mental":0.01411,"mentioned":-0.04195,"mere":0.0921,"message":0.04604,"met":0.0159,"met with":0.04321,"method":0.01114,"methods":0.05633,"middle":-0.05255,"might":0.06546,"might be":0.03929,"miles":-0.03505,"military":-0.0578,"million":0.00473,"mind":0.055,"minutes":0.09993,"mirror":0.04956,"miss":0.03748,"missing":0.07035,"mission":0.07969,"model":-0.22599,"models":-0.02924,"modern":-0.04408,"moment":0.1653,"moments":0.08339,"money":-0.0686,"monitoring":0.04374,"month":-0.07322,"months":0.10703,"moral":0.03211,"more":0.01229,"more than":-0.06463,"moreover":-0.14091,"morning":0.02437,"most":-0.23478,"most of":-0.12376,"mostly":-0.0667,"mother":-0.05954,"move":0.03894,"movement":-0.048,"movie":0.09449,"moving":-0.055,"much":-0.16455,"much more":-0.0456,"multiple":-0.05024,"music":0.04368,"must":0.16293,"must be":0.07135,"my":0.03901,"my life":-0.04976,"my own":0.0577,"myself":0.06025,"mystery":0.08998,"name":0.01187,"named":0.1735,"nation":0.04711,"national":0.02283,"nations":0.04371,"natural":-0.036,"nature":-0.02235,"nature of":0.03081,"navigate":0.046,"near":-0.05055,"nearby":-0.03698,"necessary":0.16336,"necessary to":0.0449,"need":-0.01243,"need for":0.07741,"need to":-0.06859,"needed":0.01533,"needed to":0.03182,"needs":-0.04295,"needs to":-0.08536,"network":-0.23682,"networks":0.10468,"new":-0.03733,"news":0.01253,"next":-0.03495,"night":0.1766,"no":0.08599,"no longer":0.0657,"no one":-0.02571,"noise":0.07925,"nor":-0.05229,"north":-0.06589,"not":-0.13517,"not a":0.04609,"not be":-0.02643,"not in":0.03775,"not just":0.12341,"not only":-0.14063,"note":-0.03915,"notes":-0.051,"nothing":-0.02181,"novel":0.02632,"now":0.05727,"number":-0.09075,"number of":-0.10898,"numbers":-0.03404,"numerous":0.03158,"object":-0.02413,"objective":-0.03721,"objects":-0.06771,"obvious":0.04409,"occur":-0.05258,"occurred":0.06097,"of":0.00533,"of a":-0.0691,"of all":-0.1021,"of an":-0.03958,"of any":-0.03742,"of being":0.05272,"of course":-0.02304,"of his":-0.06722,"of hope":0.07931,"of human":0.02348,"of information":-0.02661,"of life":0.09832,"of my":-0.03715,"of new":0.02166,"of our":0.01906,"of such":0.04616,"of that":-0.06162,"of the":0.00932,"of them":-0.07197,"of these":0.02912,"of things":-0.0438,"of this":0.04465,"of two":0.05799,"of us":-0.06134,"of which":-0.06879,"off the":0.02836,"offer":0.02466,"offered":-0.02672,"offering":0.09503,"offers":0.06117,"office":0.03748,"officer":0.02323,"official":-0.02961,"often":0.03727,"oh":-0.16044,"oil":0.03276,"old":0.03822,"older":-0.0323,"on":-0.03591,"on a":0.01018,"on his":-0.04664,"on its":-0.05863,"on my":0.01891,"on the":-0.02102,"on this":-0.06542,"once":0.05862,"one":-0.04075,"one of":-0.02192,"one's":0.05437,"ones":-0.08252,"ongoing":0.17593,"online":-0.06429,"only":-0.11331,"only a":-0.02929,"only one":0.03605,"operating":-0.03756,"operation":-0.05575,"operations":0.03255,"opportunities":0.092,"opportunities for":0.06426,"opportunity":0.14383,"opportunity to":0.07077,"option":-0.06015,"options":0.06902,"or":0.11861,"or a":-0.02201,"or not":-0.02297,"or the":0.02124,"order":-0.15561,"order to":-0.18914,"organizations":0.04389,"other":-0.05403,"others":0.07856,"our":0.19065,"out":-0.13931,"out of":-0.08419,"out that":0.03229,"out the":-0.04948,"outcome":0.05333,"outcomes":0.04622,"outside":0.10742,"over":0.13488,"over a":-0.02818,"over the":-0.04108,"over time":0.05425,"overall":0.32803,"overcome":0.03985,"own":0.16392,"page":0.06775,"pain":0.04207,"paper":-0.05821,"parents":0.03794,"park":0.05103,"part":0.02002,"part of":0.08491,"particular":-0.06573,"particularly":0.03888,"parties":0.02051,"party":-0.01774,"passing":0.03358,"passion":0.07924,"past":0.01806,"patient":0.00901,"patients":-0.16825,"patterns":0.06246,"paul":0.02213,"pay":-0.0164,"peace":0.06146,"people":-0.27421,"people and":0.03924,"people are":-0.03943,"people who":0.03184,"per":0.0738,"perfect":0.03955,"perform":-0.12285,"perhaps":0.03382,"period":-0.09392,"person":-0.03109,"personal":0.12084,"phenomenon":0.03059,"phone":0.04703,"physical":-0.02629,"pick":-0.0387,"picture":-0.02981,"piece":-0.0446,"piece of":-0.05455,"place":0.07574,"placed":-0.03294,"places":-0.05919,"plan":-0.11216,"planet":-0.02825,"planning":-0.0487,"plans":0.05278,"platform":-0.11424,"platforms":-0.04987,"play":-0.0365,"play a":-0.03022,"played":0.01932,"player":0.08771,"playing":0.08559,"plays":-0.05187,"please":0.07655,"plus":-0.03744,"point":-0.12535,"point of":-0.02286,"points":-0.02101,"police":0.12925,"policies":0.01513,"policy":0.00988,"political":-0.05739,"popular":0.13517,"population":-0.05522,"position":-0.02364,"positive":0.02637,"possibilities":0.06485,"possibility":0.10274,"possibly":-0.04349,"post":0.04298,"potential":0.33419,"potential for":0.09391,"potentially":0.17314,"power":0.07939,"power of":0.07103,"powerful":0.07785,"practices":0.0641,"predict":-0.02293,"prepared":0.06701,"preparing":0.03787,"presence":0.15238,"presence of":0.03889,"present":-0.05745,"presented":-0.18257,"presents":0.02759,"president":-0.06696,"pretty":0.04407,"prevent":0.07313,"previous":-0.07527,"previously":-0.11049,"primarily":0.04401,"primary":0.09796,"prior":-0.04071,"prison":0.03192,"probably":-0.05462,"problem":-0.30073,"problems":-0.17126,"process":-0.02242,"processes":-0.04633,"produce":-0.02645,"product":-0.08587,"production":-0.02712,"products":-0.02845,"profit":0.01989,"program":0.03265,"programs":0.06289,"progress":0.08042,"project":-0.14543,"projects":0.0427,"prominent":0.03513,"promise":0.07423,"promising":0.15804,"promoting":0.06156,"property":-0.0334,"proposed":0.06229,"protect":0.06859,"protection":-0.02929,"prove":0.04492,"proved":-0.04545,"provide":0.0826,"provide a":0.04482,"provided":-0.12719,"provides":0.16104,"provides a":0.12316,"providing":0.09606,"public":0.02064,"purpose":0.07749,"put":-0.02702,"quality":-0.08088,"quest":0.04066,"questions":0.07223,"quickly":0.01751,"quite":-0.08538,"race":0.02515,"radio":-0.08158,"raise":0.02739,"raised":0.07942,"range of":0.03378,"rapidly":-0.05387,"rare":0.05437,"rate":-0.03943,"rates":0.057,"rather":-0.02406,"rather than":0.07313,"reached":0.03694,"read":-0.10001,"reading":-0.03397,"ready":0.04535,"ready to":0.05771,"real":-0.07796,"reality":0.08541,"realize":0.0429,"realized":0.10063,"really":-0.05914,"realm":0.05408,"reason":-0.13573,"reasons":-0.17508,"recent":0.06259,"recent years":0.06095,"recently":-0.09405,"recognition":0.0608,"recognize":-0.03888,"record":-0.03412,"red":-0.03506,"reduce":0.08237,"reduce the":0.04184,"reduced":0.04478,"reducing":0.10942,"reduction":0.02476,"reference":0.0546,"reflecting":0.03083,"regarding":0.04869,"regardless":0.02904,"region":0.03236,"regions":0.04108,"regular":0.04883,"regulations":0.04569,"related":-0.02863,"relations":-0.08828,"relationship":-0.03237,"relatively":-0.058,"release":0.05245,"released":0.08353,"relentless":0.08776,"reliability":0.03536,"reliable":0.16125,"relief":0.05189,"rely":0.03517,"remain":0.10084,"remained":0.09747,"remaining":-0.05743,"remains":0.15523,"reminder":0.16837,"reminder of":0.12736,"replaced":0.03836,"report":-0.12778,"reported":0.05396,"reports":0.0199,"represent":0.06235,"represents":0.04904,"requirements":-0.03237,"requires":-0.05691,"research":-0.00822,"researchers":-0.04025,"resilience":0.08375,"resistance":0.05445,"resources":0.01014,"respect":0.05476,"response":0.04288,"responsibility":0.11571,"responsible":0.06107,"responsible for":0.03523,"rest":-0.03471,"rest of":-0.07895,"result":-0.04275,"result in":0.04138,"results":-0.05069,"return":0.03157,"return to":0.04545,"revealed":0.06508,"revealing":0.03639,"revenue":0.0634,"review":0.06874,"revolution":-0.03611,"right":-0.0279,"rights":0.0586,"rise":0.09749,"rising":0.0492,"risk":-0.00893,"risk of":0.06568,"risks":0.11221,"road":0.03146,"robust":-0.13309,"rock":-0.04022,"role":0.06961,"royal":-0.03847,"run":-0.10006,"running":-0.05057,"safe":-0.0431,"safety":0.21799,"said":-0.50453,"said the":-0.04005,"same":-0.02728,"same time":-0.09145,"sample":-0.02031,"save":-0.03987,"saw":-0.05187,"say":-0.08652,"say that":-0.05422,"saying":-0.05988,"says":-0.1492,"scale":-0.0472,"scene":0.03198,"school":-0.02083,"schools":0.10756,"science":-0.0466,"screen":-0.02147,"sea":0.05758,"search":-0.03454,"season":0.03743,"second":-0.18503,"secondly":-0.08177,"seconds":-0.03672,"secret":0.0214,"secrets":0.10991,"sector":0.02502,"secure":0.0602,"security":0.08567,"see":-0.05267,"seek":0.09718,"seeking":0.08358,"seem":0.0578,"seem to":0.03283,"seemed":0.15832,"seemed to":0.05175,"seen":0.07043,"seen as":0.0228,"selection":-0.07436,"self":-0.02044,"send":-0.04077,"sense":0.14709,"sense of":0.14336,"separate":0.04886,"series":0.09599,"serious":0.02291,"serve":0.10962,"served":0.07431,"serves":0.07835,"serves as":0.056,"service":0.0169,"services":-0.07411,"set":-0.02335,"set of":-0.13152,"sets":-0.02551,"seven":-0.03316,"several":0.0655,"severe":0.03724,"sex":-0.01916,"shadow":0.03739,"shadows":0.09241,"shape":0.01879,"share":-0.05473,"shared":0.11904,"sharp":-0.03173,"she":-0.01576,"she had":0.07019,"she is":-0.03003,"she was":-0.02363,"shift":0.11302,"shock":0.05508,"shot":-0.08901,"should":-0.1652,"should be":-0.08148,"should not":-0.04362,"show that":0.01559,"showed":-0.05502,"shown":-0.0168,"shows":-0.167,"sick":-0.04034,"side":0.02072,"sight":0.03468,"significance":0.03461,"significant":0.22562,"significantly":0.06894,"signs":0.04461,"silent":0.04921,"simple":-0.07639,"simply":0.03843,"simultaneously":-0.09084,"since":-0.05128,"since the":-0.10107,"single":-0.11415,"sit":-0.06647,"sitting":-0.04342,"situation":0.09182,"situations":-0.02196,"six":-0.0702,"size":-0.12553,"skill":-0.05386,"skills":0.0266,"skin":-0.08177,"sky":0.02508,"slowly":-0.03486,"small":0.04196,"smaller":0.07613,"smart":-0.1449,"smith":0.03412,"so":-0.03863,"so i":-0.07195,"so it":0.03402,"so much":0.04764,"so that":-0.02,"social":-0.10899,"society":-0.03184,"software":-0.12068,"solution":-0.0414,"solutions":-0.02707,"solve":-0.04823,"some":-0.05748,"some of":-0.03505,"someone":0.01994,"something":0.11204,"sometimes":-0.03191,"somewhere":-0.03302,"son":-0.04609,"song":0.01988,"soon":-0.06988,"sorry":0.02673,"sort":-0.03054,"sort of":-0.03133,"sought":0.06385,"sounds":0.04341,"source":-0.07369,"source of":0.03342,"sources":0.072,"south":-0.02634,"space":0.01009,"sparked":0.13753,"species":-0.01339,"specific":-0.06282,"speech":0.03593,"speed":-0.02131,"spend":-0.06029,"spending":-0.04345,"spent":0.03619,"spirit":0.08508,"spoke":0.04543,"sport":-0.0198,"sports":-0.05601,"st":0.04803,"stability":0.06721,"stable":-0.02587,"staff":0.04569,"stage":-0.01564,"standard":-0.08955,"standards":0.08507,"standing":0.03736,"stark":0.09464,"stars":0.06345,"start":-0.02794,"starting":0.02323,"state":-0.03222,"stated":0.06661,"statement":0.03254,"states":0.00994,"status":-0.05576,"stay":-0.07204,"step":0.01787,"steps":0.02501,"still":-0.09857,"stood":0.02412,"stopped":-0.0909,"store":-0.0709,"stories":0.0487,"story":0.06131,"strange":0.14392,"strategic":0.06245,"strategy":-0.08066,"street":0.01733,"streets":0.09163,"strength":0.0607,"stress":-0.06928,"strong":0.08267,"stronger":0.02997,"structure":-0.0823,"structures":-0.04916,"struggling":0.10333,"students":-0.10462,"studied":-0.06483,"studies":-0.02402,"study":0.12732,"studying":-0.10723,"stuff":0.03153,"subjects":-0.03511,"substantial":0.05851,"success":0.12277,"successful":0.06417,"successfully":-0.05828,"such":0.03533,"such a":0.0312,"such as":0.01438,"sufficient":-0.0371,"suggested":-0.10962,"summer":0.06627,"sun":0.05534,"superior":0.05486,"support":0.07747,"supporting":0.04497,"sure":0.18287,"surface":0.02576,"surge":0.0594,"surrounding":0.09837,"survival":-0.0279,"survive":-0.06129,"sustainable":0.06512,"swiftly":0.04872,"system":0.02548,"systems":0.04931,"table":-0.02384,"take":0.10261,"take a":0.0295,"taken":0.11892,"takes":-0.0292,"taking":-0.03777,"tale":0.05293,"talk":-0.06677,"target":-0.05391,"task":-0.02471,"tasks":0.02324,"taste":0.08151,"teach":-0.02968,"teacher":-0.03706,"team":0.04855,"tears":0.06487,"technical":-0.03961,"techniques":0.14425,"technological":0.07008,"technologies":-0.09217,"technology":-0.00585,"television":-0.05845,"tell":-0.02205,"telling":-0.05643,"ten":-0.0807,"term":-0.04473,"terms of":0.05821,"test":-0.0275,"testament":0.0648,"testament to":0.0743,"text":-0.05218,"than":-0.16235,"than a":-0.04555,"than the":-0.06979,"thanks":0.0551,"that":0.09554,"that a":-0.08432,"that are":0.09091,"that can":0.08999,"that could":0.06654,"that had":0.06188,"that has":0.05915,"that he":0.0542,"that i":-0.02199,"that if":0.04368,"that in":-0.03678,"that is":0.08488,"that it":0.13757,"that of":-0.08737,"that people":-0.03244,"that the":0.18712,"that their":0.06871,"that there":-0.02173,"that they":0.06581,"that this":0.01582,"that was":-0.06385,"that we":0.02922,"that were":-0.02689,"that will":0.0655,"the":-0.1432,"the ability":-0.05927,"the air":0.02652,"the american":0.03114,"the beginning":-0.03002,"the best":-0.03759,"the biggest":-0.04193,"the book":-0.07293,"the case":0.02125,"the challenges":0.07574,"the company":0.09141,"the concept":-0.02642,"the country":0.07916,"the current":0.06353,"the decision":0.04534,"the development":0.05908,"the early":-0.03058,"the face":0.0702,"the field":0.14698,"the final":0.04398,"the first":-0.02276,"the future":0.01423,"the game":0.10373,"the global":-0.02232,"the great":-0.06189,"the ground":-0.04679,"the heart":0.04516,"the high":-0.03834,"the impact":0.05192,"the importance":0.11896,"the information":-0.0309,"the issue":0.04274,"the last":-0.13745,"the local":0.04624,"the main":-0.08472,"the man":-0.0498,"the middle":-0.02662,"the most":0.09485,"the music":0.02858,"the need":0.08348,"the next":-0.02357,"the night":0.07543,"the number":0.08364,"the old":0.03583,"the only":-0.03964,"the opportunity":0.06489,"the other":-0.01725,"the overall":0.07567,"the potential":0.16554,"the power":0.05191,"the primary":0.03405,"the problem":-0.07176,"the process":0.03631,"the public":0.03129,"the reason":-0.03133,"the region":0.03564,"the rest":-0.09587,"the results":0.15799,"the right":0.02055,"the risk":0.04243,"the role":0.02467,"the same":-0.03807,"the second":-0.08645,"the situation":0.06345,"the state":-0.04346,"the story":0.04217,"the study":0.14707,"the sun":0.02811,"the system":0.12075,"the team":0.04812,"the third":-0.02296,"the time":0.09473,"the true":0.0426,"the truth":0.04322,"the uk":0.1433,"the united":0.04842,"the us":-0.02728,"the use":0.24505,"the very":0.02371,"the way":0.09819,"the whole":0.02394,"the world":-0.04931,"the world's":0.06695,"the year":0.03138,"their":0.20906,"their lives":0.0254,"their own":-0.02834,"them":-0.05605,"them and":-0.0881,"them in":-0.08229,"them to":0.06194,"themselves":0.03195,"then":-0.02063,"then i":0.04276,"then the":-0.03927,"theories":0.02061,"theory":-0.07354,"there":-0.00499,"there are":0.13993,"there is":0.01222,"there was":-0.1538,"there were":0.03865,"there's":-0.09161,"thereby":0.02962,"therefore":-0.33386,"these":0.08724,"they":-0.04531,"they also":0.02952,"they are":-0.01451,"they can":0.08876,"they could":-0.02672,"they do":0.03021,"they had":0.0573,"they were":0.04087,"they will":-0.09789,"they would":-0.04777,"they're":0.08025,"thick":-0.05778,"thing":-0.01293,"things":-0.07899,"think":-0.19593,"think that":-0.09203,"thinking":0.02622,"third":-0.05508,"this":0.18796,"this is":-0.03401,"this new":0.0337,"this was":0.01936,"those":0.03466,"those who":0.1047,"though":-0.06736,"thought":-0.05255,"threat":0.04123,"three":-0.18727,"through":0.09729,"through a":0.03274,"through the":-0.032,"throughout":0.03679,"thus":-0.18611,"time":-0.12823,"time and":0.04717,"time i":-0.02845,"time to":-0.02354,"times":-0.0781,"title":0.14433,"to":0.00889,"to achieve":0.02684,"to address":0.0473,"to change":-0.05717,"to come":0.03209,"to consider":0.03792,"to continue":0.03164,"to create":0.03662,"to develop":0.05947,"to do":-0.13483,"to enhance":0.03427,"to ensure":0.10919,"to find":0.07418,"to get":0.04525,"to give":0.07751,"to go":-0.06045,"to have":-0.06312,"to help":-0.01532,"to her":-0.01845,"to him":-0.0588,"to identify":0.03059,"to improve":0.07191,"to increase":-0.06794,"to keep":-0.05878,"to learn":0.04659,"to maintain":0.06691,"to make":0.0388,"to me":-0.03395,"to other":0.04513,"to our":-0.0292,"to play":-0.02014,"to prevent":0.0327,"to protect":0.0666,"to reduce":0.0411,"to say":-0.02845,"to see":0.05206,"to show":-0.03037,"to study":-0.02465,"to take":0.07261,"to that":-0.04739,"to the":-0.00433,"to their":0.03784,"to this":-0.02693,"to understand":-0.03238,"to use":-0.04158,"today":0.11417,"together":0.17075,"told":-0.11716,"too":0.1114,"took":-0.04342,"tool":0.07759,"tools":-0.01994,"top":-0.02237,"topic":-0.10844,"total":-0.02759,"touch":0.02424,"toward":-0.04937,"towards":0.04967,"towards the":-0.04916,"town":0.05867,"track":0.03317,"trade":0.00874,"traditional":0.07191,"traffic":0.02886,"training":-0.13919,"transition":0.07987,"transport":0.16983,"transportation":0.03903,"travel":0.03585,"treatment":0.06786,"tree":-0.02616,"trip":0.03409,"true":0.12259,"trust":-0.03873,"truth":0.11903,"trying":0.02765,"turn":0.05459,"turning":0.04522,"turns":-0.03039,"tv":-0.07237,"two":-0.1773,"type":-0.06607,"types":-0.05138,"types of":-0.01992,"uk":0.06956,"ultimately":0.05496,"uncertainty":0.06642,"under":0.01023,"under the":-0.04955,"understand":0.01304,"understanding":0.13733,"understanding of":0.04001,"unexpected":0.08508,"union":0.04677,"unique":0.1142,"unit":-0.07057,"united":0.07825,"united states":-0.02363,"universe":0.04389,"university":-0.02786,"unlike":-0.03432,"until":0.14527,"until the":0.04505,"up":-0.0835,"up and":-0.08729,"up in":-0.02926,"up the":-0.05371,"up to":0.04636,"upon":0.10555,"urban":0.02994,"us":0.01873,"us to":0.02928,"use":-0.02616,"use of":0.17107,"used for":0.04395,"used in":0.06537,"used to":0.16037,"useful":0.03358,"users":-0.15465,"uses":-0.02931,"using":-0.06323,"using a":-0.02151,"using the":-0.11052,"usually":-0.07467,"valuable":0.18068,"value":-0.01621,"values":-0.10147,"various":0.23727,"vehicle":-0.01587,"vehicles":0.18143,"very":-0.02582,"via":-0.12314,"vibrant":0.07559,"victory":0.06099,"video":-0.09508,"view":0.02466,"views":0.05723,"vision":0.02633,"visit":-0.04609,"vital":-0.08635,"voice":0.20635,"volume":-0.01874,"vulnerable":0.02811,"wait":-0.05371,"walk":-0.05438,"walked":-0.0432,"wall":-0.03889,"want":-0.0871,"want to":-0.06001,"wanted":-0.0142,"wanted to":0.01759,"war":-0.0537,"was":-0.1471,"was a":0.118,"was in":0.03219,"was just":0.03492,"was the":-0.05516,"wasn't":-0.033,"watch":-0.01942,"watched":0.03163,"watching":0.02754,"wave":0.03694,"way":0.10978,"way of":0.03486,"way to":-0.0435,"we":-0.16007,"we are":0.19995,"we can":0.05383,"we had":0.04589,"we need":0.07109,"we were":0.09511,"we will":0.07502,"we're":0.05131,"web":-0.05211,"week":0.07412,"weight":0.1218,"well":-0.06276,"well as":-0.08273,"went":0.02552,"went to":-0.03299,"were":-0.17666,"were the":-0.0313,"west":-0.05745,"what":-0.03779,"what is":0.04202,"what it":-0.03761,"what the":-0.05903,"what they":-0.08675,"when":-0.09584,"when a":-0.04633,"when it":0.05724,"when the":-0.07433,"when we":0.03421,"where":0.25781,"where he":0.06268,"where the":-0.03859,"where they":0.0552,"whether":0.12855,"which":-0.00801,"which are":0.11703,"which can":0.02795,"which has":0.07183,"which have":0.04173,"which is":0.07466,"which the":-0.03047,"while":0.24621,"while the":0.05208,"whispers":0.06664,"who":0.3231,"who are":0.07957,"who had":0.04816,"who has":0.07586,"who have":0.0908,"who is":0.06484,"who was":0.06271,"whole":-0.0218,"why":-0.15186,"why i":-0.08934,"wide":-0.01548,"widely":0.05928,"widespread":0.06073,"wife":0.0307,"will":0.00313,"will be":0.04822,"will have":0.05411,"will help":-0.05174,"willing":0.02789,"win":0.05808,"wind":0.04727,"wisdom":0.04666,"wish":-0.01745,"with":0.03935,"with a":0.14128,"with an":-0.05415,"with each":0.07032,"with his":-0.10495,"with its":0.0516,"with many":0.08086,"with some":0.03463,"with the":-0.16624,"with them":-0.0456,"with this":-0.06817,"within":0.08458,"within a":-0.06239,"within the":0.04743,"without":0.17319,"witness":0.04197,"witnessed":0.052,"woman":0.06275,"women":-0.04113,"won":0.03894,"won't":-0.03897,"wonder":0.07596,"word":-0.02249,"words":0.13592,"work":-0.18288,"workers":0.02023,"working":-0.02483,"works":-0.09541,"world":0.11815,"world's":0.08264,"worldwide":0.02762,"worse":0.03266,"worst":-0.0345,"would":-0.19298,"would be":-0.09693,"would have":-0.05006,"wouldn't":-0.03265,"wrote":-0.05405,"year":-0.0754,"years":0.07367,"years of":0.03624,"years old":0.03729,"years the":0.03184,"yes":0.27929,"yet":0.08649,"york":-0.02752,"you":-0.04282,"you are":0.07926,"you can":-0.02911,"you could":-0.02996,"you have":0.06837,"you in":-0.05329,"you know":-0.03117,"you the":-0.07012,"you want":0.02287,"you were":0.06589,"you would":-0.02898,"you'll":0.05847,"you're":0.08251,"young":0.07378,"your":0.15012,"your life":-0.0497,"your own":0.04299},"lexCap":5.0,"bands":{"low":-0.63,"high":2.47},"effect":[-0.031,-0.306,-0.56,-0.293,-0.217,-0.571,-0.405,0.127,0.407,0.865,-0.851,0.406,0.517,-0.611,0.008,-0.167,-0.085,0.107,-0.108,0.264,-0.418,-0.283,-0.114,-0.02,-0.139,-0.093,-0.255,-0.075,-0.174,-0.168,-0.119,-0.262,-0.105,-0.07,-0.019,-0.081,-0.169,-0.16,-0.056,0.144,0.864,0.367,-0.292,0.075,-0.119,-0.002,-0.009,-0.196,-0.125,-0.037,-0.096,-0.068,-0.099,-0.048,-0.072,0.214],"decision":{"threshold":0.77,"knots":[[-4.0,-2.659],[-3.75,-2.483],[-3.5,-2.483],[-3.25,-2.483],[-3.0,-2.354],[-2.75,-2.354],[-2.5,-2.354],[-2.25,-2.331],[-2.0,-2.331],[-1.75,-2.133],[-1.5,-2.133],[-1.25,-2.133],[-1.0,-2.002],[-0.75,-1.944],[-0.5,-1.565],[-0.25,-1.385],[0.0,-1.132],[0.25,-0.824],[0.5,-0.485],[0.75,-0.032],[1.0,0.398],[1.25,0.828],[1.5,1.338],[1.75,1.688],[2.0,1.698],[2.25,2.331],[2.5,2.976],[2.75,3.144],[3.0,3.415],[3.25,3.517],[3.5,3.517],[3.75,4.07],[4.0,4.07],[4.25,4.216],[4.5,4.216],[4.75,4.519],[5.0,4.52]],"cuts":{"aiHigh":2.12,"aiMedium":1.26,"humanHigh":-5.42,"humanMedium":-0.71}}});
})(typeof window !== "undefined" ? window : globalThis);
