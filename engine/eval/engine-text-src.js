/* GAIC on-device text engine v2.
   A compact linear classifier over stylometric measurements and a pruned
   word/phrase lexicon, trained offline on permissively licensed public
   research corpora (see models/GAIC-TEXT-MODEL.md) and evaluated on corpora it
   never saw. Runs entirely on this device: no text leaves it. The output is a
   lean (AI-written or human-written) with a measured confidence level and an
   estimated AI likelihood; it is evidence, not proof of authorship. */
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
