import test from "node:test";
import assert from "node:assert/strict";
import { loadScript } from "./helpers.mjs";
import { CASES } from "./writing-cases.mjs";

const WA = loadScript("writing-assist.js").AICheckWritingAssist;

test("rewriting benchmark: every case produces the reviewed output", () => {
  const failures = [];
  for (const [mode, input, expected] of CASES) {
    const got = WA.improve(input, mode).output;
    if (got !== expected) failures.push({ mode, input, expected, got });
  }
  assert.deepEqual(failures, []);
});

test("text without a matching rule is returned byte-identical", () => {
  const text = "Plain words stay put.\n\n    Indented   spacing, e.g. U.S. data, Node.JS, and \"quotes\" survive.";
  for (const mode of Object.keys(WA.MODES)) {
    const result = WA.improve(text, mode);
    assert.equal(result.output, text);
    assert.equal(result.changed, false);
  }
});

test("quotes, code, URLs, and emails are never edited", () => {
  const text = "He wrote \"in order to utilize it\" at https://x.test/in-order-to and `utilize()` to a@b.co.";
  assert.equal(WA.improve(text, "plain").output, text);
});

test("result contract is unchanged", () => {
  const r = WA.improve("We met in order to plan.", "clear");
  for (const key of ["mode", "modeLabel", "original", "output", "changes", "replacements", "wordsBefore", "wordsAfter", "changed", "summary"]) {
    assert.ok(key in r, key);
  }
  assert.equal(r.replacements, 1);
  assert.match(r.summary, /1 wording change suggested/);
  assert.equal(WA.improve("x", "unknown-mode").mode, "clear");
});

test("the file parses without regex lookbehind (iOS 15 Safari)", async () => {
  const { read } = await import("./helpers.mjs");
  assert.doesNotMatch(read("writing-assist.js"), /\(\?<[=!]/);
});
