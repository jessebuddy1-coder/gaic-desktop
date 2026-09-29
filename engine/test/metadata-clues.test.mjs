// Generator clues read from a photo's own metadata text: tool names,
// generation settings, and China's AI-content label (GB 45438-2025).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { pathToFileURL } from "node:url";
import { read, RUNTIME, appSection, functionSource } from "./helpers.mjs";

const app = read("app.js");
const ctx = { console };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext("(function(){" +
  appSection("  // Generator clues in the file's own decoded metadata", "  async function analyzeImage(") +
  functionSource(app, "rangeToAscii") +
  "\nObject.assign(globalThis, { GENERATOR_NAMES, AMBIGUOUS_GENERATOR_NAMES, hasGenerationSettings, readAiContentLabel, withoutCaptions, rangeToAscii }); })();", ctx);
// The metadata text exactly as the app's parser hands it over: UTF-8 bytes,
// every non-ASCII byte turned into a space.
const asParsed = (text) => { const bytes = new TextEncoder().encode(text); return ctx.rangeToAscii(bytes, 0, bytes.length); };

test("tool names: DALL·E with its middle dot counts, the Italian word \"dalle\" does not", () => {
  for (const text of ["DALL·E 3", "Created with DALL-E", "dall e 2", "NovelAI", "ComfyUI", "InvokeAI 4.2",
    "Fooocus v2.5.0", "Leonardo.Ai", "Stability AI", "Midjourney", "Stable Diffusion XL", "SDXL 1.0",
    "Bing Image Creator", "Seedream 4.0", "Made in Adobe Firefly"]) {
    assert.ok(ctx.GENERATOR_NAMES.test(asParsed(text)), text);
  }
  for (const text of ["Vista dalle montagne", "Foto dalle Alpi", "Dallas skyline", "Dalle 9 alle 18",
    "Stability of the tripod", "Leonardo da Vinci", "Canon EOS R5", "Adobe Photoshop Lightroom Classic",
    "Gemini constellation", "Imagen de la playa", "an ideogram"]) {
    assert.ok(!ctx.GENERATOR_NAMES.test(asParsed(text)), text);
  }
  for (const text of ["Gemini constellation", "Imagen de la playa", "Ideogram"]) {
    assert.ok(ctx.AMBIGUOUS_GENERATOR_NAMES.test(asParsed(text)), text + " stays in the ambiguous tier");
  }
});

test("tool names in captions, titles, and keywords do not count; in software fields and generator chunks they do", () => {
  const named = (text, caption) => ctx.GENERATOR_NAMES.test(ctx.withoutCaptions(text, caption)) ||
    ctx.AMBIGUOUS_GENERATOR_NAMES.test(ctx.withoutCaptions(text, caption));
  const newsPhoto = '<x:xmpmeta><rdf:RDF><rdf:Description rdf:about="" photoshop:Headline="Midjourney founder on stage" ' +
    'photoshop:CaptionWriter = \'DALL-E desk\'>' +
    '<dc:description><rdf:Alt><rdf:li xml:lang="x-default">OpenAI CEO Sam Altman speaks about Stable Diffusion and Gemini</rdf:li></rdf:Alt></dc:description>' +
    '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Google Imagen launch</rdf:li></rdf:Alt></dc:title>' +
    '<dc:subject><rdf:Bag><rdf:li>OpenAI</rdf:li><rdf:li>Midjourney</rdf:li></rdf:Bag></dc:subject>' +
    '<xmp:CreatorTool>Adobe Photoshop Lightroom Classic 13.0</xmp:CreatorTool></rdf:Description></rdf:RDF></x:xmpmeta>';
  assert.equal(named(newsPhoto), false, "a news photo's caption names AI companies");
  assert.equal(named(newsPhoto.replace("Adobe Photoshop Lightroom Classic 13.0", "Adobe Firefly")), true, "CreatorTool still counts");
  assert.equal(named('<exif:UserComment><rdf:Alt><rdf:li>shot for an OpenAI story</rdf:li></rdf:Alt></exif:UserComment>'), false);
  assert.equal(named('prompt {"9": {"inputs": {"filename_prefix": "ComfyUI"}, "class_type": "SaveImage"}}'), true, "ComfyUI graph");
  assert.equal(named("Software NovelAI Source NovelAI Diffusion V4"), true, "PNG Software chunk");
  // An EXIF image description is left out wherever it appears in the text.
  const caption = "The OpenAI logo is displayed on a smartphone screen " + "in a photo illustration ".repeat(20);
  assert.equal(named("Exif  MM *  " + caption + "  Canon EOS R5 ", caption), false);
  assert.equal(named("Exif  MM *  " + caption + "  Canon EOS R5 "), true, "without the parsed caption the words would count");
  // Unclosed or hostile markup stays cheap and never removes text it cannot bound.
  assert.equal(named("<dc:description>no end tag, DALL-E"), true);
  const started = process.hrtime.bigint();
  ctx.withoutCaptions('<dc:title photoshop:headline="'.repeat(12000));
  assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 500);
});

test("the EXIF parser keeps the image description as the metadata text shows it", () => {
  const P = { console };
  P.globalThis = P;
  vm.createContext(P);
  const slice = (from, to) => { const a = app.indexOf(from), b = app.indexOf(to, a + 1); assert.ok(a >= 0 && b > a, from); return app.slice(a, b); };
  vm.runInContext("(function(){" +
    slice("  function readU16LE(bytes, offset) {", "  function readU32BE(bytes, offset) {") +
    slice("  function readU32BE(bytes, offset) {", "\n  }\n") + "\n  }\n" +
    slice("  function rangeToAscii(b, start, end){", "  // ---------- weekly rate limit") +
    "\nglobalThis.parseImageMetadata = parseImageMetadata; })();", P);
  // A JPEG whose EXIF IFD0 holds one ImageDescription longer than the 256
  // characters other EXIF text fields keep, with a non-ASCII character.
  const text = Buffer.from("Caf\u00e9 photo: the Midjourney logo " + "x".repeat(300) + "\0", "utf8");
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write("MM", 0, "latin1"); tiff.writeUInt16BE(42, 2); tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x010E, 10); tiff.writeUInt16BE(2, 12); tiff.writeUInt32BE(text.length, 14); tiff.writeUInt32BE(tiff.length, 18);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff, text]);
  const app1 = Buffer.concat([Buffer.from([0xFF, 0xE1, (payload.length + 2) >> 8, (payload.length + 2) & 255]), payload]);
  const jpeg = new Uint8Array(Buffer.concat([Buffer.from([0xFF, 0xD8]), app1, Buffer.from([0xFF, 0xDA, 0, 2, 0xFF, 0xD9])]));
  const meta = P.parseImageMetadata(jpeg);
  assert.equal(meta.hasExif, true);
  assert.ok(meta.exif.captionText.startsWith("Caf   photo: the Midjourney logo xxx"));
  assert.ok(meta.metaText.includes(meta.exif.captionText), "rendered exactly as in the metadata text");
  assert.equal(ctx.GENERATOR_NAMES.test(meta.metaText), true);
  assert.equal(ctx.GENERATOR_NAMES.test(ctx.withoutCaptions(meta.metaText, meta.exif.captionText)), false);
});

test("generation settings in the EXIF comment or XMP count; ordinary captions do not", () => {
  const a1111 = "ASCII   portrait, film grain Negative prompt: blurry, lowres Steps: 32, Sampler: DPM++ 2M Karras, " +
    "CFG scale: 6.5, Seed: 3985326596, Size: 512x512, Model hash: e4a30e4607, Model: majicmixRealistic_v6";
  assert.equal(ctx.hasGenerationSettings(asParsed(a1111)), true);
  assert.equal(ctx.hasGenerationSettings("Steps: 20, Sampler: Euler a, Schedule type: Automatic, CFG scale: 7, Seed: 1"), true);
  const comfy = '{"3": {"class_type": "KSampler", "inputs": {"seed": 1, "steps": 20, "model": ["4", 0]}}}';
  assert.equal(ctx.hasGenerationSettings(comfy), true);
  assert.equal(ctx.hasGenerationSettings("<exif:UserComment>" + comfy.replace(/"/g, "&quot;") + "</exif:UserComment>"), true);
  for (const caption of ["Steps: 3 to the beach", "Steps: 12, Sampler: none", "Sampler: Euler a", "Seed: 42",
    "Exposure program: Manual, ISO: 200, Seed pods in autumn", '{"inputs": {"a": 1}}', '{"class_type": "x"}']) {
    assert.equal(ctx.hasGenerationSettings(caption), false, caption);
  }
});

test("the AI-content label is read in each form the standard allows", () => {
  // As found in a real file: an XMP attribute whose JSON is XML-escaped.
  const xmpAttribute = '<rdf:Description rdf:about="" xmlns:AIGC="http://ns.adobe.com/AIGC/1.0/" AIGC:AIGC="{&quot;Label&quot;: ' +
    '&quot;2&quot;, &quot;ContentProducer&quot;: &quot;001191110000802100433B10005&quot;, &quot;ProduceID&quot;: ' +
    '&quot;1246820975200729695&quot;, &quot;ReservedCode1&quot;: &quot;&quot;, &quot;ContentPropagator&quot;: ' +
    '&quot;001191110000802100433B10005&quot;, &quot;PropagateID&quot;: &quot;1246820975200729695&quot;, &quot;ReservedCode2&quot;: &quot;&quot;}"/>';
  assert.equal(ctx.readAiContentLabel(asParsed(xmpAttribute)), "2");
  assert.equal(ctx.readAiContentLabel('<TC260:AIGC>{"Label":"1","ContentProducer":"001191110000MA01ABCD","ProduceID":"x"}</TC260:AIGC>'), "1");
  assert.equal(ctx.readAiContentLabel('AIGC {"Label": "3", "ContentProducer": "", "ProduceID": ""}'), "3", "PNG text chunk");
  assert.equal(ctx.readAiContentLabel('ASCII   {"AIGC":{"Label":1,"ContentProducer":"p","ProduceID":"q"}}'), "1", "EXIF user comment");
  for (const text of ['AIGC {"ContentProducer": "p"}', 'AIGC {"Label": "0", "ContentProducer": "p"}',
    'AIGC {"Label": "12", "ContentProducer": "p"}', 'AIGC {"Label": "1"}', "AIGC art contest winner 2025",
    '{"Label": "1", "ContentProducer": "p"}', ""]) {
    assert.equal(ctx.readAiContentLabel(text), "", text);
  }
  // Bounded work on hostile input.
  const started = process.hrtime.bigint();
  ctx.readAiContentLabel("AIGC{".repeat(60000));
  ctx.hasGenerationSettings("Steps: 1, Sampler: ".repeat(20000));
  assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 500, "readers stay fast on repeated markers");
});

test("analyzeImage reads the clues from the decoded metadata text and passes them on", () => {
  const body = functionSource(app, "analyzeImage");
  assert.match(body, /const metaText = derivedFromHEIF \? "" : \(meta\.metaText \|\| ""\);/);
  assert.match(body, /const toolText = withoutCaptions\(metaText, meta\.exif && meta\.exif\.captionText\); const namedGenerator = GENERATOR_NAMES\.test\(toolText\);/);
  assert.match(body, /generatorParameters: generatorTextKeys\.length > 0 \|\| generationSettings, aiContentLabel,/);
  assert.match(body, /China's national standard for " \+ "AI-generated content \(GB 45438-2025\)/);
});

// provenance-verdict.mjs imports container-provenance.mjs, which the engine
// update does not change; run these checks against a full runtime.
const full = fs.existsSync(path.join(RUNTIME, "container-provenance.mjs"));
const PV = full ? await import(pathToFileURL(path.join(RUNTIME, "provenance-verdict.mjs")).href) : null;
const CUTS = { aiHigh: 0.7668, aiMedium: 0.5, realHigh: 0.0162, realMedium: 0.0425 };
const pixel = (p) => ({ available: true, rawScore: p * 100, probability: p, cuts: CUTS, elevatedBand: 95, warningBand: 99 });

test("the AI-content label moves the lean by its level; label 1 counts like a declared AI source type", { skip: !full }, () => {
  const lean = (label, extra = {}) => PV.decideImageLean({ pixel: pixel(0.1), metadata: { aiContentLabel: label }, ...extra });
  const [none, one, two, three] = ["", "1", "2", "3"].map((label) => lean(label));
  assert.ok(one.probabilityAi > two.probabilityAi && two.probabilityAi > three.probabilityAi && three.probabilityAi > none.probabilityAi);
  assert.ok(one.drivers.includes("ai-content-label") && !none.drivers.includes("ai-content-label"));
  const declared = PV.decideImageLean({ pixel: pixel(0.1), declarations: { declaresAiSource: true } });
  assert.equal(one.probabilityAi, declared.probabilityAi);
  const heif = { container: { derivedFromHEIF: true } };
  assert.equal(lean("1", heif).probabilityAi, PV.decideImageLean({ pixel: pixel(0.1), ...heif }).probabilityAi,
    "a converted HEIC copy's metadata is never evidence");
  assert.equal(lean("7").probabilityAi, none.probabilityAi, "unknown label values are ignored");
});

test("the evidence read names the label and its level", { skip: !full }, () => {
  const read = (label) => PV.assessImageEvidence({ pixel: pixel(0.1), metadata: { aiContentLabel: label } });
  const one = read("1"), two = read("2"), three = read("3");
  assert.equal(one.tier, "declared-ai-source-type");
  assert.equal(one.headline, "Metadata declares AI origin — unsigned");
  assert.match(one.establishes.join(" "), /GB 45438-2025\), marking it as AI-generated\./);
  for (const [r, level] of [[two, "possibly"], [three, "suspected"]]) {
    assert.equal(r.tier, "declared-ai-source-type");
    assert.equal(r.headline, "Metadata labels this as possibly AI-generated — unsigned");
    assert.match(r.establishes.join(" "), new RegExp("marking it as " + level + " AI-generated"));
  }
  assert.notEqual(read("").tier, "declared-ai-source-type");
  const both = PV.assessImageEvidence({ pixel: pixel(0.1), metadata: { aiContentLabel: "3" }, declarations: { declaresAiSource: true } });
  assert.equal(both.headline, "Metadata declares AI origin — unsigned");
  assert.equal(both.establishes.length, 3);
});

test("the new headline has friendly and plain-language copy", () => {
  assert.match(app, /"Metadata labels this as possibly AI-generated — unsigned": "The file's own labels say it may be AI-made/);
  assert.match(functionSource(app, "evidenceCopy"), /if \(verdict === "Metadata labels this as possibly AI-generated — unsigned"\) \{ return "The file carries a label saying it may be AI-generated/);
});
