/* GAIC local writing assist (v2).
   Deterministic editing rules improve clarity and readability without sending
   a draft anywhere. This is an editing aid, not an authorship or detector-
   avoidance tool; the writer reviews every proposed change.

   v2 accuracy rules: text outside an edit stays byte-identical; direct quotes,
   code, URLs, and email addresses are never edited; verb rules keep tense and
   person; a/an agreement and sentence capitals are repaired at edit sites only.
   No regex lookbehind is used, so the file still parses on iOS 15 Safari. */
(function (global) {
  const MODES = Object.freeze({
    clear: "Clearer",
    concise: "More concise",
    plain: "Plain language",
  });

  const EDIT = "";      // boundary of a replaced span
  const DELETED = "";   // a removed span
  const CAPITAL = "";   // capitalize the next letter
  const HOLD_OPEN = "";
  const HOLD_CLOSE = "";
  const MARKERS_RE = /[]/g;

  const DETERMINERS = "a|an|the|this|that|these|those|your|our|their|my|his|her|its|some|more|new|any|each|every";

  // A verb rule rewrites every inflection and keeps the tense: the four forms
  // are base, third person, past, and -ing. Optional `tail` is matched and
  // re-emitted verbatim (used to require a following word such as "to").
  function verbRule(label, from, to, tail) {
    const suffix = tail ? "(?=" + tail + ")" : "";
    return from.map((form, index) => [
      label,
      new RegExp("\\b" + form + "\\b" + suffix, "gi"),
      to[index],
    ]);
  }

  const COMMON_RULES = Object.freeze([
    ["in order to", /\bin order to\b/gi, "to"],
    ["in order for", /\bin order for\b/gi, "for"],
    ["due to the fact that", /\bdue to the fact that\b/gi, "because"],
    ["owing to the fact that", /\bowing to the fact that\b/gi, "because"],
    ["in view of the fact that", /\bin view of the fact that\b/gi, "because"],
    ["in light of the fact that", /\bin light of the fact that\b/gi, "because"],
    ["on account of the fact that", /\bon account of the fact that\b/gi, "because"],
    ["for the reason that", /\bfor the reason that\b/gi, "because"],
    ["despite the fact that", /\bdespite the fact that\b/gi, "although"],
    ["in spite of the fact that", /\bin spite of the fact that\b/gi, "although"],
    ["regardless of the fact that", /\bregardless of the fact that\b/gi, "although"],
    ["at this point in time", /\bat this point in time\b/gi, "now"],
    ["at the present time", /\bat the present time\b/gi, "now"],
    ["at this moment in time", /\bat this moment in time\b/gi, "now"],
    ["in this day and age", /\bin this day and age\b/gi, "today"],
    ["in the event that", /\bin the event that\b/gi, "if"],
    ["has the ability to", /\bhas the ability to\b/gi, "can"],
    ["have the ability to", /\bhave the ability to\b/gi, "can"],
    ["had the ability to", /\bhad the ability to\b/gi, "could"],
    ["has the capacity to", /\bhas the capacity to\b/gi, "can"],
    ["have the capacity to", /\bhave the capacity to\b/gi, "can"],
    ...verbRule("make use of",
      ["make use of", "makes use of", "made use of", "making use of"],
      ["use", "uses", "used", "using"]),
    ["for the purpose of", /\bfor the purpose of\b/gi, "for"],
    ["with regard to", /\bwith regards? to\b/gi, "about"],
    ["in regard to", /\bin regards? to\b/gi, "about"],
    ["in reference to", /\bin reference to\b/gi, "about"],
    ["a large number of", /\ba (?:large|great|significant) number of\b/gi, "many"],
    ["the majority of", /\b(?:the|a) (?:vast )?majority of\b/gi, "most"],
    ["in close proximity to", /\bin close proximity to\b/gi, "near"],
    ["until such time as", /\buntil such time as\b/gi, "until"],
    ["in the near future", /\bin the near future\b/gi, "soon"],
    ["on a daily basis", /\bon a daily basis\b/gi, "daily"],
    ["on a weekly basis", /\bon a weekly basis\b/gi, "weekly"],
    ["on a monthly basis", /\bon a monthly basis\b/gi, "monthly"],
    ["on a regular basis", /\bon a regular basis\b/gi, "regularly"],
    ["on an annual basis", /\bon an? (?:annual|yearly) basis\b/gi, "every year"],
    ["is in need of", /\bis in need of\b/gi, "needs"],
    ["are in need of", /\bare in need of\b/gi, "need"],
    ...verbRule("give consideration to",
      ["give consideration to", "gives consideration to", "gave consideration to", "giving consideration to"],
      ["consider", "considers", "considered", "considering"]),
    ...verbRule("take into consideration",
      ["take into consideration", "takes into consideration", "took into consideration", "taking into consideration"],
      ["consider", "considers", "considered", "considering"]),
    ...verbRule("come to the conclusion",
      ["come to the conclusion", "comes to the conclusion", "came to the conclusion", "coming to the conclusion"],
      ["conclude", "concludes", "concluded", "concluding"]),
    ...verbRule("make a decision",
      ["make (?:a|the) decision", "makes (?:a|the) decision", "made (?:a|the) decision", "making (?:a|the) decision"],
      ["decide", "decides", "decided", "deciding"]),
    ...verbRule("conduct an investigation",
      ["conduct an investigation (?:into|of)", "conducts an investigation (?:into|of)",
        "conducted an investigation (?:into|of)", "conducting an investigation (?:into|of)"],
      ["investigate", "investigates", "investigated", "investigating"]),
    ...verbRule("provide assistance to",
      ["provide assistance to", "provides assistance to", "provided assistance to", "providing assistance to"],
      ["help", "helps", "helped", "helping"]),
    // "We are in the process of reviewing" -> "We are reviewing".
    ["in the process of", /\bin the process of (?=[a-z]+ing\b)/gi, ""],
  ]);

  const CONCISE_RULES = Object.freeze([
    ["it is important to note that", /\bit is important to note that\b/gi, "note that"],
    ["it's important to note that", /\bit's important to note that\b/gi, "note that"],
    ["it should be noted that", /\bit should be noted that\b/gi, "note that"],
    ["it is worth noting that", /\bit(?: is|'s) worth noting that\b/gi, "note that"],
    ["it is interesting to note that", /\bit is interesting to note that\b/gi, "note that"],
    ["needless to say", /(^|[.!?]\s+|\n)needless to say, /gi, "$1"],
    ["as a matter of fact", /\bas a matter of fact\b/gi, "in fact"],
    ["the fact of the matter is that", /\bthe fact of the matter is(?: that)?,? ?/gi, "in fact, "],
    ["basically", /(^|[.!?]\s+|\n)basically, /gi, "$1"],
    ["essentially", /(^|[.!?]\s+|\n)essentially, /gi, "$1"],
    ["first and foremost", /\bfirst and foremost\b/gi, "first"],
    ["each and every", /\beach and every\b/gi, "each"],
    ["any and all", /\bany and all\b/gi, "all"],
    ["null and void", /\bnull and void\b/gi, "void"],
    ["whether or not", /\bwhether or not\b/gi, "whether"],
    ["the reason why", /\bthe reason why\b/gi, "the reason"],
    ["in spite of", /\bin spite of\b/gi, "despite"],
    ["at all times", /\bat all times\b/gi, "always"],
    ["final outcome", /\bfinal outcome\b/gi, "outcome"],
    ["end result", /\bend results?\b/gi, (m) => (/s$/i.test(m) ? "results" : "result")],
    ["future plans", /\bfuture plans\b/gi, "plans"],
    ["past history", /\bpast history\b/gi, "history"],
    ["past experience", /\bpast experiences?\b/gi, (m) => (/s$/i.test(m) ? "experiences" : "experience")],
    ["personal opinion", /\bpersonal opinion\b/gi, "opinion"],
    ["basic fundamentals", /\bbasic fundamentals\b/gi, "fundamentals"],
    ["absolutely essential", /\babsolutely essential\b/gi, "essential"],
    ["added bonus", /\badded bonus\b/gi, "bonus"],
    ["free gift", /\bfree gifts?\b/gi, (m) => (/s$/i.test(m) ? "gifts" : "gift")],
    ["unexpected surprise", /\bunexpected surprise\b/gi, "surprise"],
    ["true facts", /\btrue facts\b/gi, "facts"],
    ["close proximity", /\bclose proximity\b/gi, "proximity"],
    ["advance warning", /\badvance warning\b/gi, "warning"],
    ["advance planning", /\badvance planning\b/gi, "planning"],
    ["mutual cooperation", /\bmutual cooperation\b/gi, "cooperation"],
    ["completely eliminate", /\bcompletely (eliminat(?:e|es|ed|ing))\b/gi, "$1"],
    ["completely unanimous", /\bcompletely unanimous\b/gi, "unanimous"],
    ["very unique", /\bvery unique\b/gi, "unique"],
    ["over-exaggerate", /\bover[- ]?(exaggerat(?:e|es|ed|ing))\b/gi, "$1"],
    ["still remains", /\bstill (remains?|remained)\b/gi, "$1"],
    ["collaborate together", /\b(collaborat(?:e|es|ed|ing)) together\b/gi, "$1"],
    ["combine together", /\b(combin(?:e|es|ed|ing)) together\b/gi, "$1"],
    ["join together", /\b(join(?:s|ed|ing)?) together\b/gi, "$1"],
    ["merge together", /\b(merg(?:e|es|ed|ing)) together\b/gi, "$1"],
    ["repeat again", /\b(repeat(?:s|ed|ing)?) again\b/gi, "$1"],
    ["revert back", /\b(revert(?:s|ed|ing)?) back\b/gi, "$1"],
    ["return back", /\b(return(?:s|ed|ing)?) back\b/gi, "$1"],
  ]);

  const PLAIN_RULES = Object.freeze([
    ...verbRule("utilize",
      ["utili[sz]e", "utili[sz]es", "utili[sz]ed", "utili[sz]ing"],
      ["use", "uses", "used", "using"]),
    ["utilization", /\butili[sz]ation\b/gi, "use"],
    ...verbRule("commence",
      ["commence", "commences", "commenced", "commencing"],
      ["start", "starts", "started", "starting"]),
    ["commencement", /\bcommencement\b/gi, "start"],
    ...verbRule("terminate",
      ["terminate", "terminates", "terminated", "terminating"],
      ["end", "ends", "ended", "ending"]),
    ...verbRule("obtain",
      ["obtain", "obtains", "obtained", "obtaining"],
      ["get", "gets", "got", "getting"]),
    ...verbRule("demonstrate",
      ["demonstrate", "demonstrates", "demonstrated", "demonstrating"],
      ["show", "shows", "showed", "showing"]),
    ...verbRule("ascertain",
      ["ascertain", "ascertains", "ascertained", "ascertaining"],
      ["find out", "finds out", "found out", "finding out"]),
    ...verbRule("endeavor to",
      ["endeavou?r", "endeavou?rs", "endeavou?red", "endeavou?ring"],
      ["try", "tries", "tried", "trying"], " to\\b"),
    ...verbRule("initiate",
      ["initiate", "initiates", "initiated", "initiating"],
      ["start", "starts", "started", "starting"]),
    ...verbRule("modify",
      ["modify", "modifies", "modified", "modifying"],
      ["change", "changes", "changed", "changing"]),
    ...verbRule("transmit",
      ["transmit", "transmits", "transmitted", "transmitting"],
      ["send", "sends", "sent", "sending"]),
    ...verbRule("inquire",
      ["inquire", "inquires", "inquired", "inquiring"],
      ["ask", "asks", "asked", "asking"]),
    ...verbRule("assist",
      ["assist", "assists", "assisted", "assisting"],
      ["help", "helps", "helped", "helping"]),
    ...verbRule("purchase",
      ["purchase", "purchases", "purchased", "purchasing"],
      ["buy", "buys", "bought", "buying"], "\\s+(?:" + DETERMINERS + ")\\b"),
    ["approximately", /\bapproximately\b/gi, "about"],
    ["assistance", /\bassistance\b/gi, "help"],
    ["additional", /\badditional\b/gi, "extra"],
    ["a sufficient number of", /\ban? (?:sufficient|adequate) (?:number|amount) of\b/gi, "enough"],
    ["sufficient", /\bsufficient\b/gi, "enough", { unlessPrecededBy: /\b(?:a|an)\s+$/i }],
    ["regarding", /\bregarding\b/gi, "about", { unlessFollowedBy: /^\s+(?:him|her|them|it|me|us|you|this|that)\s+as\b/i }],
    ["nevertheless", /\bnevertheless\b/gi, "still"],
    ["nonetheless", /\bnonetheless\b/gi, "still"],
    ["numerous", /\bnumerous\b/gi, "many"],
    ["subsequently", /\bsubsequently\b/gi, "later"],
    ["prior to", /\bprior to\b/gi, "before"],
    ["subsequent to", /\bsubsequent to\b/gi, "after"],
    ["in excess of", /\bin excess of\b/gi, "more than"],
    ["with the exception of", /\bwith the exception of\b/gi, "except for"],
    ["per annum", /\bper annum\b/gi, "a year"],
    ["henceforth", /\bhenceforth\b/gi, "from now on"],
    ["the remainder of", /\bthe remainder of\b/gi, "the rest of"],
    ["optimal", /\boptimal\b/gi, "best"],
    ["equitable", /\bequitable\b/gi, "fair"],
    ["is required to", /\bis required to\b/gi, "must"],
    ["are required to", /\bare required to\b/gi, "must"],
    ["at this juncture", /\bat this juncture\b/gi, "now"],
    ["in the vicinity of", /\bin the vicinity of\b/gi, "near"],
  ]);

  // Typo repair limited to words that are never correctly doubled.
  const DOUBLED_WORD_RULE = Object.freeze([
    "repeated word",
    /\b(the|a|an|to|of|and|in|on|is|for|with|at|by|from|as|or)\s+\1\b/gi,
    "$1",
  ]);

  function matchCase(original, replacement) {
    if (!replacement || !original) return replacement;
    const letters = original.replace(/[^A-Za-z]/g, "");
    if (letters.length > 1 && letters === letters.toUpperCase()) return replacement.toUpperCase();
    const first = original.match(/[A-Za-z]/);
    if (first && first[0] === first[0].toUpperCase()) {
      return replacement.replace(/^([^A-Za-z]*)([a-z])/, (m, pre, ch) => pre + ch.toUpperCase());
    }
    return replacement;
  }

  // ---------- protected spans ----------
  const PROTECT_PATTERNS = [
    /```[\s\S]*?```/g,
    /`[^`\n]+`/g,
    /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi,
    /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g,
    /"[^"\n]{1,600}"/g,
    /“[^”\n]{1,600}”/g,
  ];

  function protect(text) {
    const held = [];
    let output = text;
    for (const pattern of PROTECT_PATTERNS) {
      output = output.replace(pattern, (match) => {
        // Never nest: a span that already contains a placeholder stays as is.
        if (match.indexOf(HOLD_OPEN) !== -1) return match;
        held.push(match);
        return HOLD_OPEN + (held.length - 1).toString(36) + HOLD_CLOSE;
      });
    }
    return { text: output, held };
  }

  function restore(text, held) {
    return text.replace(/([0-9a-z]+)/g, (m, id) => {
      const value = held[parseInt(id, 36)];
      return value === undefined ? m : value;
    });
  }

  // ---------- rule application ----------
  function applyRules(text, rules, changes) {
    let output = text;
    for (const rule of rules) {
      const [name, pattern, replacement, options] = rule;
      let count = 0;
      output = output.replace(pattern, function () {
        const args = Array.prototype.slice.call(arguments);
        const matched = args[0];
        const hasGroups = typeof args[args.length - 1] === "object";
        const whole = hasGroups ? args[args.length - 2] : args[args.length - 1];
        const offset = hasGroups ? args[args.length - 3] : args[args.length - 2];
        const groups = args.slice(1, hasGroups ? -3 : -2);
        if (options && options.unlessPrecededBy &&
            options.unlessPrecededBy.test(whole.slice(Math.max(0, offset - 24), offset))) {
          return matched;
        }
        if (options && options.unlessFollowedBy &&
            options.unlessFollowedBy.test(whole.slice(offset + matched.length, offset + matched.length + 40))) {
          return matched;
        }
        let value = typeof replacement === "function"
          ? replacement(matched, ...groups)
          : replacement.replace(/\$(\d)/g, (m, n) => (groups[Number(n) - 1] || ""));
        // Keep a leading capture (sentence boundary) outside the edit marks.
        let lead = "";
        if (typeof replacement === "string" && replacement.indexOf("$1") === 0 && groups.length &&
            /^(?:|[.!?]\s+|\n)$/.test(groups[0] || "")) {
          lead = groups[0] || "";
          value = value.slice(lead.length);
        }
        count += 1;
        const core = matched.slice(lead.length);
        if (!value.trim()) return lead + DELETED;
        return lead + EDIT + matchCase(core, value) + EDIT;
      });
      if (count) changes.push({ phrase: name, count });
    }
    return output;
  }

  function startsWithVowelSound(word) {
    const w = String(word || "").toLowerCase();
    if (!w) return false;
    if (/^(?:hour|honest|honou?r|heir)/.test(w)) return true;
    if (/^(?:uni|use|usu|uti|eu|ewe|one|once|ur[aei])/.test(w)) return false;
    if (/^[0-9]/.test(w)) return /^(?:8|11|18)/.test(w);
    return /^[aeiou]/.test(w);
  }

  function finishEdits(text) {
    let output = text;
    // Deleted spans: keep exactly one separating space, none before punctuation
    // or at a line edge, and capitalize a sentence that now starts later.
    output = output.replace(/([ \t]*)([ \t]*)/g, (m, before, after, offset, whole) => {
      const prev = whole.slice(0, offset);
      const next = whole[offset + m.length];
      const lineStart = prev === "" || /\n$/.test(prev);
      if (lineStart) return before + CAPITAL; // keep the line's indentation
      if (next === undefined || next === "\n") return "";
      if (/[,.;:!?)\]]/.test(next)) return "";
      if (/[.!?]["')\]]*$/.test(prev)) return " " + CAPITAL;
      return " ";
    });
    output = output.replace(/([\s"'(\[]*)([a-z])/g, (m, pre, ch) => pre + ch.toUpperCase());
    // a/an agreement for an article directly before an edited word.
    output = output.replace(/\b(a|an|A|An|AN)([ \t]+)([^\s]+)/g, (m, article, space, word) => {
      const wantsAn = startsWithVowelSound(word.replace(MARKERS_RE, ""));
      let fixed = wantsAn ? "an" : "a";
      if (article === "AN" || (article === "A" && word === word.toUpperCase() && word.length > 1)) {
        fixed = fixed.toUpperCase();
      } else if (article[0] === "A") {
        fixed = fixed[0].toUpperCase() + fixed.slice(1);
      }
      return fixed + space + EDIT + word;
    });
    return output.replace(MARKERS_RE, "");
  }

  function wordCount(text) {
    const words = String(text || "").trim().match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu);
    return words ? words.length : 0;
  }

  function improve(input, requestedMode) {
    const original = String(input || "");
    const mode = Object.prototype.hasOwnProperty.call(MODES, requestedMode)
      ? requestedMode
      : "clear";
    const changes = [];
    const guarded = protect(original.replace(/[-]/g, ""));
    // Separators are retained verbatim, so paragraph order and blank-line
    // structure do not disappear during a local edit.
    const pieces = guarded.text.split(/(\n[ \t]*\n+)/);
    const edited = pieces.map((piece, index) => {
      if (index % 2 === 1) return piece;
      let out = applyRules(piece, [DOUBLED_WORD_RULE], changes);
      out = applyRules(out, COMMON_RULES, changes);
      if (mode === "concise") out = applyRules(out, CONCISE_RULES, changes);
      if (mode === "plain") out = applyRules(out, PLAIN_RULES, changes);
      return finishEdits(out);
    }).join("");
    const merged = [];
    for (const entry of changes) {
      const existing = merged.find((item) => item.phrase === entry.phrase);
      if (existing) existing.count += entry.count;
      else merged.push({ phrase: entry.phrase, count: entry.count });
    }
    const output = restore(edited, guarded.held);
    const before = wordCount(original);
    const after = wordCount(output);
    const replacements = merged.reduce((sum, entry) => sum + entry.count, 0);
    return Object.freeze({
      mode,
      modeLabel: MODES[mode],
      original,
      output,
      changes: Object.freeze(merged.map((entry) => Object.freeze({ ...entry }))),
      replacements,
      wordsBefore: before,
      wordsAfter: after,
      changed: output !== original,
      summary: replacements
        ? `${replacements} wording ${replacements === 1 ? "change" : "changes"} suggested · ${before} → ${after} words`
        : `No automatic wording changes found · ${after} words`,
    });
  }

  global.AICheckWritingAssist = Object.freeze({ MODES, improve });
})(typeof window !== "undefined" ? window : globalThis);
