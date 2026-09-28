import test from "node:test";
import vm from "node:vm";
import assert from "node:assert/strict";
import { loadScript, appSection, read } from "./helpers.mjs";

const E = loadScript("text-detector.js").AICheckTextEngine;

// Public-domain human prose (Jane Austen, Pride and Prejudice, 1813).
const HUMAN = `It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife. However little known the feelings or views of such a man may be on his first entering a neighbourhood, this truth is so well fixed in the minds of the surrounding families, that he is considered the rightful property of some one or other of their daughters. "My dear Mr. Bennet," said his lady to him one day, "have you heard that Netherfield Park is let at last?" Mr. Bennet replied that he had not. "But it is," returned she; "for Mrs. Long has just been here, and she told me all about it." Mr. Bennet made no answer. "Do you not want to know who has taken it?" cried his wife impatiently. "You want to tell me, and I have no objection to hearing it." This was invitation enough. "Why, my dear, you must know, Mrs. Long says that Netherfield is taken by a young man of large fortune from the north of England; that he came down on Monday in a chaise and four to see the place, and was so much delighted with it, that he agreed with Mr. Morris immediately; that he is to take possession before Michaelmas, and some of his servants are to be in the house by the end of next week."`;
// Written for this test in the stock style of chat-model essays.
const MACHINE = `In today's fast-paced world, technology plays a crucial role in shaping how we live, work, and connect with one another. From smartphones to smart homes, innovative tools have transformed everyday experiences in profound ways. Moreover, the rapid evolution of artificial intelligence has opened up new possibilities for businesses and individuals alike. It is important to note that these advancements also bring significant challenges, including concerns about privacy, security, and the potential impact on employment. Furthermore, as we navigate this ever-evolving landscape, it is essential to strike a balance between embracing innovation and addressing its ethical implications. Ultimately, by fostering collaboration between policymakers, industry leaders, and communities, we can harness the transformative potential of technology while ensuring that its benefits are shared equitably. In conclusion, technology is a powerful force that, when used responsibly, can pave the way for a brighter and more inclusive future for all.`;

test("model is embedded and matches the engine", () => {
  assert.equal(E.model.version, "GAIC Text Model v2 (2026-09)");
  assert.equal(E.model.dense.length, E.DENSE_NAMES.length);
  assert.equal(E.model.lexicon.size, 2500);
  assert.ok(E.model.bands.high > E.model.bands.low);
});

test("display mapping keeps the 15-85 range and the 34/66 band edges", () => {
  assert.equal(E.displayScore(E.model.bands.low), 34);
  assert.equal(E.displayScore(E.model.bands.high), 66);
  assert.equal(E.displayScore(-50), 15);
  assert.equal(E.displayScore(50), 85);
});

test("scores are deterministic and banded", () => {
  const a = E.analyze(HUMAN), b = E.analyze(HUMAN);
  assert.equal(a.logit, b.logit);
  assert.notEqual(a.band, "several");
  const m = E.analyze(MACHINE);
  assert.equal(m.band, "several");
  assert.ok(m.score >= 66 && m.score <= 85);
});

test("zero-width characters and look-alike letters do not change the score", () => {
  const disguised = MACHINE
    .replace(/a/g, "а")          // Cyrillic a
    .replace(/ /g, " ​")          // zero-width spaces
    .replace(/o/g, "ο");          // Greek omicron
  assert.ok(Math.abs(E.analyze(disguised).logit - E.analyze(MACHINE).logit) < 1e-9);
});

test("explanations only cite measurements in their standalone direction", () => {
  for (const text of [HUMAN, MACHINE]) {
    const r = E.analyze(text);
    assert.ok(r.aiSignals.length + r.humanSignals.length > 0);
    assert.ok(r.aiSignals.every((s) => typeof s === "string" && s.length > 2));
  }
});

test("long documents are scored in bounded passages", () => {
  const long = Array.from({ length: 200 }, () => HUMAN).join("\n\n");
  const r = E.analyze(long);
  assert.ok(r.passages <= 64 && r.passages > 1);
});

test("app.js keeps the gates and verdict contract and falls back without the engine", () => {
  const code = "(function (global) {" +
    appSection("  const MIN_TEXT_CHARACTERS = 1000;", "  function analyticsTrack") +
    appSection("  const FORMULAIC_PHRASES", "  // ---------- friendly one-liner") +
    "\nglobalThis.analyzeText = analyzeText;\n})(globalThis);";

  const withEngine = loadScript("text-detector.js");
  vm.runInContext(code, withEngine);
  const machine = withEngine.analyzeText(MACHINE);
  assert.equal(machine.kind, "text");
  assert.equal(machine.metricLabel, "Text-pattern signal");
  assert.equal(machine.verdict, "Several formulaic patterns matched");
  assert.match(machine.explain, /not a probability/);
  assert.equal(withEngine.analyzeText("short").score, null);

  const withoutEngine = { TextEncoder };
  withoutEngine.globalThis = withoutEngine;
  vm.createContext(withoutEngine);
  vm.runInContext(code, withoutEngine);
  const legacy = withoutEngine.analyzeText(MACHINE);
  assert.equal(legacy.kind, "text");
  assert.ok(legacy.score >= 15 && legacy.score <= 85);

  const html = read("ai-detector.html");
  assert.ok(html.indexOf('<script src="text-detector.js"></script>') > -1);
  assert.ok(html.indexOf('<script src="text-detector.js"></script>') < html.indexOf('<script src="app.js"></script>'));
});
