/* Provenance-first evidence assessment for image results.

   Why this module exists
   ----------------------
   The pixel detector cannot carry a verdict. Measured on the mandatory release
   gate (ops/aicheck-detector-release-gate, report 2026-07-28), the shipping
   model reached 8/33 generated recall on direct images and 3/33 on portal
   composites at the 95 band, with 1/12 real images falsely flagged. Those are
   not numbers a product can lead with, and the published research ceiling for
   pixel-only detection on recompressed, phone-handled images is not far above
   them.

   Content Credentials are different in kind. A validated C2PA manifest is a
   signature chain over a declared origin: checkable, reproducible, and either
   present or absent. It cannot tell you whether a scene is true, and it is
   absent from most images in circulation, but when present it is real evidence
   rather than a guess.

   So GAIC leads with provenance and metadata, and demotes the pixel score to a
   supporting signal that can never own the headline. This module makes that
   ordering explicit, deterministic, and testable, instead of leaving it implicit
   in a chain of else-ifs.

   Design rules enforced here
   --------------------------
   1. The tier table below names what kind of evidence was found. It stays the
      technical read, and no tier headline asserts that an image is authentic.
   2. Every check still ends with a decision. decideImageLean() combines the
      evidence as log-likelihood ratios into one lean (AI-generated or real)
      and a confidence level. The pixel term is the engine v3 decision head's
      probability, calibrated on held-out generators and real-image sources
      (models/AICHECK-IMAGE-MODEL.md); confidence levels were set so each
      level's share of correct leans meets a stated target on that data.
   3. A validated AI-origin credential decides AI outright, and a trusted
      capture credential decides real outright. Evidence toward AI may promote;
      camera metadata may lower confidence but can never flip a warning-band
      pixel reading to "real".
   4. Absence is never evidence. No credential, no EXIF, and no metadata each
      contribute nothing to the lean in either direction.
   5. Every tier carries an explicit doesNotEstablish list, so the UI cannot
      present a tier without also being able to state its limits.

   This module is pure: same input, same output, no I/O, no DOM, no clock. */

/* Tier precedence, in exactly the order assessImageEvidence evaluates them.
   tierRank is derived from this array, so any divergence would make tierRank
   contradict the module's own decision order. test/provenance-verdict.mjs drives
   one input per tier and asserts the observed order matches this list.

   Asymmetric promotion is the rule that decides where structural evidence sits:
   origin-implicating evidence may promote a tier; origin-exculpating evidence
   may only enrich the establishes list of a corroboration tier.

   So an unsigned AI source-type declaration and a generative edit-history step
   rank ABOVE the pixel bands — they are positive written records naming a
   synthetic origin for this file, and the band they outrank is an operating
   point that STREAMING-TRAINING.md measured as not defensible on an unseen
   generator family, and that fires on genuine photographs.

   Encoder-structure tiers rank BELOW the pixel bands, for three reasons all of
   which apply: structural matching has no population base rate at all, where
   the pixel bands at least carry a declared fixture measurement; encoder
   profiles are non-exclusive by construction, since the same bytes come from a
   re-save; and a capture-leaning match must never suppress a warning. */
import { ENCODER_EVIDENCE_BASIS } from "./container-provenance.mjs";

const TIER_ORDER = Object.freeze([
  "signed-ai-origin",
  "signed-screen-capture",
  "signed-capture",
  "signed-origin-unspecified",
  "declared-ai-source-type",
  "metadata-generator-named",
  "edit-history-generative-step",
  "credential-validation-failed",
  "credential-present-unverified",
  "declared-generator-source",
  "pixel-high-warning",
  "pixel-elevated-evidence",
  "encoder-profile-generator-consistent",
  "portal-scan-inconclusive",
  "capture-encoder-corroborated",
  "capture-metadata-corroborated",
  "capture-metadata-present",
  "container-rewritten-origin-unrecoverable",
  "pixel-below-bands",
  "no-decisive-evidence",
]);

const BANDS = Object.freeze({
  SIGNED_ORIGIN_RECORD: "signed-origin-record",
  FAILED_ORIGIN_RECORD: "failed-origin-record",
  UNVERIFIED_ORIGIN_MARKER: "unverified-origin-marker",
  DECLARED_GENERATOR_CLUE: "declared-generator-clue",
  PIXEL_SUPPORTING_ONLY: "pixel-supporting-only",
  CAPTURE_CORROBORATION: "capture-corroboration",
  NO_EVIDENCE: "no-evidence",
});

const BAND_LABELS = Object.freeze({
  [BANDS.SIGNED_ORIGIN_RECORD]:
    "Signed origin record — validated on this device",
  [BANDS.FAILED_ORIGIN_RECORD]:
    "Origin record present but failed validation",
  [BANDS.UNVERIFIED_ORIGIN_MARKER]:
    "Origin marker present, not validated here",
  [BANDS.DECLARED_GENERATOR_CLUE]:
    "Declared generator clue — editable, not verified",
  [BANDS.PIXEL_SUPPORTING_ONLY]:
    "Pixel-model signal — supporting evidence only",
  [BANDS.CAPTURE_CORROBORATION]:
    "Capture metadata present — editable, not proof",
  [BANDS.NO_EVIDENCE]:
    "No origin record or metadata clue found",
});

/* Measured basis for the pixel bands. Quoted from the mandatory release-gate
   report so the UI can never imply a calibration that was never established.
   Update these only from a fresh gate run, never by estimate. */
const PIXEL_EVIDENCE_BASIS = Object.freeze({
  source: "ops/aicheck-detector-release-gate report 2026-07-28",
  directGeneratedFlagged: 8,
  directGeneratedTotal: 33,
  portalGeneratedFlagged: 3,
  portalGeneratedTotal: 33,
  realFalsePositives: 1,
  realTotal: 12,
  note:
    "Small-sample gate measurement, not population calibration. A miss is " +
    "common and a false positive has been observed.",
});

const VALIDATED_STATUSES = Object.freeze(new Set(["trusted", "valid"]));

/* Structural evidence strength. Four frozen words, counted over independent
   signal CLASSES rather than fields: five observations that all fall out of one
   encoder call are one piece of evidence, not five.

   These strings are the entire confidence expression. They are never mapped to
   a number, a percentage, or a 0-1 score, never averaged with the pixel score,
   and never rendered as a bar or meter. There is no denominator of images to
   support any of that — the only denominator GAIC has is how many profiles it
   can recognise, which is what ENCODER_EVIDENCE_BASIS reports. */
const STRUCTURAL_STRENGTH = Object.freeze({
  0: "none",
  1: "single-structure",
  2: "multi-structure",
});

function structuralStrength(classCount) {
  if (classCount >= 3) return "converged-structure";
  return STRUCTURAL_STRENGTH[classCount] || "none";
}

const EMPTY_ENCODER_EVIDENCE = Object.freeze({
  strength: "none",
  classCount: 0,
  classes: Object.freeze([]),
  profiles: Object.freeze([]),
  generatorProfiles: Object.freeze([]),
  genericProfiles: Object.freeze([]),
  captureProfiles: Object.freeze([]),
  independentCaptureProfiles: Object.freeze([]),
  catalogMismatch: false,
});

/* Grade the structural signals into a strength word plus the profile breakdown.

   Shaped like gradeCaptureMetadata's return on purpose, so the UI has one
   pattern to learn. */
export function gradeEncoderStructure(profileMatch) {
  const source = profileMatch && typeof profileMatch === "object" ? profileMatch : {};
  if (source.catalogMismatch === true) {
    // A pinned catalogue version that does not match degrades everything to
    // silence rather than trusting a stale entry. Incomparable inputs must not
    // produce comparable-looking output.
    return Object.freeze({ ...EMPTY_ENCODER_EVIDENCE, catalogMismatch: true });
  }
  const matches = Array.isArray(source.matches) ? source.matches : [];
  if (!matches.length) return EMPTY_ENCODER_EVIDENCE;

  const classes = [];
  for (const match of matches) {
    const klass = typeof match.klass === "string" ? match.klass : "";
    if (klass && classes.indexOf(klass) === -1) classes.push(klass);
  }
  classes.sort();

  const byClass = (wanted) =>
    Object.freeze(matches.filter((m) => m.profileClass === wanted).map((m) => m.id));
  // Capture profiles that are NOT derived from the EXIF block. Only these can
  // corroborate an EXIF-based metadata grade without double-counting one source.
  const independentCapture = Object.freeze(
    matches
      .filter((m) => m.profileClass === "capture-isp-writer" && m.independentOfExif === true)
      .map((m) => m.id)
  );

  return Object.freeze({
    strength: structuralStrength(classes.length),
    classCount: classes.length,
    classes: Object.freeze(classes),
    profiles: Object.freeze(matches.map((m) => m.id)),
    generatorProfiles: byClass("generator-default-writer"),
    genericProfiles: byClass("generic-reencoder"),
    captureProfiles: byClass("capture-isp-writer"),
    independentCaptureProfiles: independentCapture,
    catalogMismatch: false,
  });
}

/* THE GUARD.

   The named failure mode: a fingerprint reads "this file was written by
   Pillow", which is equally true of a generator's output pipeline and of a
   family photo the user re-saved, resized, or received through an app. Every
   profile is treated as non-exclusive by default and exclusivity must be earned
   entry by entry.

   Four gates, each returning its reason so the suppression is testable rather
   than an invisible early return. */
export function encoderEvidenceGate(encoder, captureGrade, hasCaptureResidue) {
  const evidence = encoder && typeof encoder === "object" ? encoder : EMPTY_ENCODER_EVIDENCE;

  if (evidence.catalogMismatch) {
    return { admissible: false, suppressedBy: "catalog-version-mismatch" };
  }

  // Gate 1: only a generator-default-writer profile can contribute to a
  // generator-leaning verdict. A generic re-encoder never can, by any path.
  if (!evidence.generatorProfiles.length) {
    return { admissible: false, suppressedBy: "no-generator-default-writer-profile" };
  }

  // Gate 2: capture-structure veto, unconditional. A re-saved photograph
  // usually retains some capture residue; where it retains none, silence is the
  // right output anyway.
  if (hasCaptureResidue === true || (typeof captureGrade === "string" && captureGrade !== "none")) {
    return { admissible: false, suppressedBy: "capture-structure-veto" };
  }

  // Gate 3: ambiguity veto. If the same structure is also consistent with a
  // generic re-encoder, it fires identically on the target class and the
  // innocent class, so it carries no information however many fields matched.
  if (evidence.genericProfiles.length) {
    return { admissible: false, suppressedBy: "ambiguous-with-generic-reencoder" };
  }

  // Gate 4: minimum strength. A single-class match is never a tier.
  if (evidence.strength !== "multi-structure" && evidence.strength !== "converged-structure") {
    return { admissible: false, suppressedBy: "below-minimum-strength" };
  }

  return { admissible: true, suppressedBy: "" };
}

function normalizeString(value, limit) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function finiteOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/* EXIF timestamps are "YYYY:MM:DD HH:MM:SS". Return comparable parts or null.
   Parsing is deliberately strict: a field that does not match the EXIF shape is
   not a camera timestamp, and counting it would inflate the grade. */
function parseExifTimestamp(value) {
  const text = normalizeString(value, 32).trim();
  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(text);
  if (!match) return null;
  const parts = match.slice(1).map((piece) => Number(piece));
  const [year, month, day, hour, minute, second] = parts;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 60) return null;
  // A lexical compare over zero-padded fields is enough for ordering.
  return { text, key: `${match[1]}${match[2]}${match[3]}${match[4]}${match[5]}${match[6]}` };
}

/* Grade how well a set of EXIF capture fields corroborate each other.

   Presence alone is weak, and counting presence while *claiming* mutual
   consistency would be a lie the UI then repeats. So this actually checks
   consistency: timestamps must parse in the EXIF shape and be correctly
   ordered, and exposure values must fall in physically plausible ranges. A
   field that fails its check is not counted.

   Even a fully consistent block is not proof. Every one of these fields can be
   written by hand or copied from another file, and the returned object says so
   with `editable: true`. The point is to give the provenance-first path
   something better than "EXIF present: yes/no", not to manufacture certainty. */
export function gradeCaptureMetadata(exif) {
  const fields = exif && typeof exif === "object" ? exif : {};
  const present = [];
  const failures = [];

  // Identity of the capturing device.
  if (normalizeString(fields.make, 64).trim()) present.push("make");
  if (normalizeString(fields.model, 64).trim()) present.push("model");
  if (normalizeString(fields.lensModel, 64).trim()) present.push("lensModel");

  // Exposure triplet, range-checked. These are the values a camera records and
  // an editor rarely rebuilds, but an implausible value means the field was
  // synthesised or misparsed rather than measured.
  const ranged = [
    ["exposureTime", 1e-6, 3600],
    ["fNumber", 0.5, 100],
    ["isoSpeed", 1, 4000000],
    ["focalLength", 0.1, 2000],
  ];
  for (const [name, minimum, maximum] of ranged) {
    const value = finiteOrNull(fields[name]);
    if (value === null) continue;
    if (value >= minimum && value <= maximum) present.push(name);
    else failures.push(`${name} out of plausible range`);
  }

  // Timestamps, parsed strictly and checked for ordering.
  const original = parseExifTimestamp(fields.dateTimeOriginal);
  const modified = parseExifTimestamp(fields.dateTime);
  if (original) present.push("dateTimeOriginal");
  else if (normalizeString(fields.dateTimeOriginal, 32).trim()) {
    failures.push("dateTimeOriginal is not an EXIF timestamp");
  }
  if (modified) present.push("dateTime");
  else if (normalizeString(fields.dateTime, 32).trim()) {
    failures.push("dateTime is not an EXIF timestamp");
  }
  if (original && modified && modified.key < original.key) {
    // A file cannot have been modified before it was captured.
    failures.push("dateTime precedes dateTimeOriginal");
  }

  if (fields.hasGps === true) present.push("gps");
  if (fields.hasMakerNote === true) present.push("makerNote");

  const count = present.length;
  const consistent = failures.length === 0;
  const hasExposureEvidence = present.some((name) =>
    name === "exposureTime" || name === "fNumber" || name === "isoSpeed" || name === "focalLength");
  const hasTimestamp = present.includes("dateTimeOriginal") || present.includes("dateTime");

  // "corroborated" is the only grade whose copy claims mutual consistency, so it
  // requires consistency to have been checked and passed, plus independent
  // evidence of an actual exposure and an actual capture time. Field count
  // alone can never reach it.
  let grade = "none";
  if (count >= 6 && consistent && hasExposureEvidence && hasTimestamp) grade = "corroborated";
  else if (count >= 3) grade = "partial";
  else if (count >= 1) grade = "minimal";

  return Object.freeze({
    grade,
    fieldCount: count,
    fields: Object.freeze(present.slice()),
    consistencyChecked: true,
    consistent,
    consistencyFailures: Object.freeze(failures.slice()),
    editable: true,
  });
}

function pixelView(pixel) {
  const source = pixel && typeof pixel === "object" ? pixel : {};
  const rawScore = finiteOrNull(source.rawScore);
  const elevatedBand = finiteOrNull(source.elevatedBand);
  const warningBand = finiteOrNull(source.warningBand);
  const probability = finiteOrNull(source.probability);
  return {
    available: source.available === true && rawScore !== null,
    rawScore,
    // Calibrated probability from the engine v3 decision head, when present.
    probability: probability !== null && probability >= 0 && probability <= 1 ? probability : null,
    scan: source.scan === "composite-v6" ? "composite-v6" : "direct-v5",
    cuts: source.cuts && typeof source.cuts === "object" ? source.cuts : null,
    elevatedBand,
    warningBand,
    compositeFrame: source.compositeFrame === true,
    atWarningBand:
      rawScore !== null && warningBand !== null && rawScore >= warningBand,
    atElevatedBand:
      rawScore !== null && elevatedBand !== null && rawScore >= elevatedBand,
  };
}

/* Headline for any validated credential.

   All four validated tiers share one of two shipped strings, chosen by whether
   signer trust was established. The finer distinction between an AI claim, a
   capture claim, a screen-capture claim, and an unspecified credential lives in
   the structured `tier` field and in the evidence paragraph, which already
   states each case explicitly.

   These exact strings must stay in sync with FRIENDLY_VERDICTS and
   plainResultCopy in app.js. A headline those two do not recognise renders as a
   generic fallback line, which would be a worse result than the
   ladder this module replaced. test/provenance-verdict.mjs enforces the
   coverage. */
function credentialHeadline(status) {
  return status === "trusted"
    ? "Trusted Content Credential found — not truth proof"
    : "Valid Content Credential — signer trust not established";
}

function result(fields) {
  return Object.freeze({
    tier: fields.tier,
    tierRank: TIER_ORDER.indexOf(fields.tier),
    lead: fields.lead,
    headline: fields.headline,
    band: fields.band,
    bandLabel: BAND_LABELS[fields.band] || BAND_LABELS[BANDS.NO_EVIDENCE],
    establishes: Object.freeze(fields.establishes.slice()),
    doesNotEstablish: Object.freeze(fields.doesNotEstablish.slice()),
    pixelRole: "supporting",
    displayScore: fields.displayScore === undefined ? null : fields.displayScore,
    pixelEvidenceBasis:
      fields.lead === "pixel" || fields.pixelCited === true
        ? PIXEL_EVIDENCE_BASIS
        : null,
    // Kept as a separate object from pixelEvidenceBasis on purpose. The two are
    // never merged into an "overall confidence", because there is no calibration
    // behind such a number and combining a bad denominator with no denominator
    // would only disguise both.
    encoderEvidenceBasis:
      fields.lead === "container" || fields.structuralCited === true
        ? ENCODER_EVIDENCE_BASIS
        : null,
    // The precise wording this tier would use if its copy were approved. The UI
    // reads `headline`, which is always one of the shipped strings so a new tier
    // can never render as generic fallback copy. This field exists so the copy
    // decision is visible and reviewable rather than silently made here.
    proposedHeadline: typeof fields.proposedHeadline === "string" ? fields.proposedHeadline : "",
  });
}

/* Statements that apply to every tier without exception. Keeping them in one
   place stops a future tier from quietly omitting them. */
const UNIVERSAL_LIMITS = Object.freeze([
  "This result is evidence to weigh, not proof of authorship.",
  "A \"real\" lean is an estimate from the evidence above, not proof that an image is authentic.",
  "Never use this result alone for discipline, employment, legal, safety, or moderation decisions.",
]);

function withUniversalLimits(specific) {
  return specific.concat(UNIVERSAL_LIMITS);
}

/* Assess one image's evidence and return the provenance-first verdict.

   Ordering is deliberate and is the whole point of the module:
     validated credential  >  named generator metadata  >  failed/unverified
     credential  >  user-declared generator source  >  pixel bands  >  capture
     metadata  >  nothing.

   The pixel model appears only after every provenance and declared-origin
   signal has been considered, and even then its band is labelled
   supporting-only. */
export function assessImageEvidence(input) {
  const evidence = input && typeof input === "object" ? input : {};
  const container = evidence.container && typeof evidence.container === "object"
    ? evidence.container
    : {};
  const provenanceInput = evidence.provenance && typeof evidence.provenance === "object"
    ? evidence.provenance
    : {};
  const metadata = evidence.metadata && typeof evidence.metadata === "object"
    ? evidence.metadata
    : {};
  const sourceContext = evidence.sourceContext && typeof evidence.sourceContext === "object"
    ? evidence.sourceContext
    : null;

  const derivedFromHEIF = container.derivedFromHEIF === true;

  /* Self-fingerprinting guard, the highest-severity trap this feature adds.
     When derivedFromHEIF is true the JPEG being examined was written by GAIC's
     own transcoder, so its tables, layout, and ICC identity describe GAIC — not
     the user's file. Without this, every HEIC a user submits would produce a
     confident structural match on whatever library GAIC transcodes with: a
     systematic, reproducible, self-inflicted signal on iPhone photographs, the
     single most common real-capture input the product will ever see.

     The general rule: encoder fingerprinting is only ever valid on bytes GAIC
     did not write. Any future preprocessing that re-encodes before analysis —
     downscaling, format normalisation, orientation baking, a canvas round-trip —
     invalidates all container evidence and must set this same flag. */
  const encoder = derivedFromHEIF
    ? EMPTY_ENCODER_EVIDENCE
    : (evidence.encoder && typeof evidence.encoder === "object"
        ? evidence.encoder
        : EMPTY_ENCODER_EVIDENCE);
  const declarations = derivedFromHEIF
    ? {}
    : (evidence.declarations && typeof evidence.declarations === "object"
        ? evidence.declarations
        : {});
  const status = normalizeString(provenanceInput.status, 32);
  const sourceClass = normalizeString(provenanceInput.sourceClass, 32);
  const validated = VALIDATED_STATUSES.has(status);
  const hasC2PA = container.hasC2PA === true && !derivedFromHEIF;
  const hasExif = container.hasExif === true && !derivedFromHEIF;
  const generatorTagged = metadata.generatorTagged === true && !derivedFromHEIF;
  // China's AI-content label (GB 45438-2025): "1" AI-generated, "2" possibly,
  // "3" suspected AI-generated; "" when absent.
  const aiContentLabel = derivedFromHEIF ? "" : normalizeString(metadata.aiContentLabel, 1);
  const capture = gradeCaptureMetadata(derivedFromHEIF ? {} : metadata.exif);
  const pixel = pixelView(evidence.pixel);
  const knownGenerator = !!(sourceContext && sourceContext.knownGenerator === true);

  const trustNote = status === "trusted"
    ? "The signer was matched against the bundled trust list."
    : "The signature validated, but this device did not establish the signer as trusted.";

  /* ---- Tier 1: a validated credential that declares AI origin. ---- */
  if (validated && sourceClass === "ai") {
    return result({
      tier: "signed-ai-origin",
      lead: "provenance",
      headline: "Validated AI-origin claim — verify context",
      band: BANDS.SIGNED_ORIGIN_RECORD,
      establishes: [
        "A signed Content Credential validated on this device.",
        "That credential declares trained-algorithmic or AI-created media.",
        trustNote,
      ],
      doesNotEstablish: withUniversalLimits([
        "It does not establish who made the image or why.",
        "It does not prove the whole image is generated; part of it may be a real capture.",
        "A signer can sign a false claim. Review the signer before relying on this.",
      ]),
      displayScore: null,
    });
  }

  /* ---- Tier 2: validated credential declaring a screen capture. ---- */
  if (validated && sourceClass === "screen") {
    return result({
      tier: "signed-screen-capture",
      lead: "provenance",
      headline: credentialHeadline(status),
      band: BANDS.SIGNED_ORIGIN_RECORD,
      establishes: [
        "A signed Content Credential validated on this device.",
        "That credential declares a screen capture.",
        trustNote,
      ],
      doesNotEstablish: withUniversalLimits([
        "It says nothing about whether what appeared on that screen was real or generated.",
        "A screenshot of generated media is still generated media.",
      ]),
      displayScore: null,
    });
  }

  /* ---- Tier 3: validated credential declaring a camera capture. ----
     This is the strongest available evidence *toward* a real capture, and it is
     still not a clearance: the credential covers the signed workflow only. */
  if (validated && sourceClass === "capture") {
    return result({
      tier: "signed-capture",
      lead: "provenance",
      headline: credentialHeadline(status),
      band: BANDS.SIGNED_ORIGIN_RECORD,
      establishes: [
        "A signed Content Credential validated on this device.",
        "That credential declares a digital or computational capture.",
        trustNote,
      ],
      doesNotEstablish: withUniversalLimits([
        "It does not prove the depicted event happened as it appears.",
        "It does not cover edits made outside the signed workflow.",
        "Computational capture can include heavy in-camera generative processing.",
      ]),
      displayScore: null,
    });
  }

  /* ---- Tier 4: validated credential with no declared source type. ---- */
  if (validated) {
    return result({
      tier: "signed-origin-unspecified",
      lead: "provenance",
      headline: credentialHeadline(status),
      band: BANDS.SIGNED_ORIGIN_RECORD,
      establishes: [
        "A signed Content Credential validated on this device.",
        trustNote,
      ],
      doesNotEstablish: withUniversalLimits([
        "The credential does not declare whether the image was captured or generated.",
        "A validated record of provenance is not a statement that the content is true.",
      ]),
      displayScore: null,
    });
  }

  /* ---- Tier 5: an unsigned digitalSourceType declaring synthetic origin. ----
     Ranks above a named tool because it is a controlled-vocabulary assertion
     about the media's ORIGIN, where a named tool only says a tool touched the
     file — "Photoshop" in a CreatorTool field is compatible with a crop.

     Ranks above the pixel bands because it is a positive written record of a
     synthetic origin for this file, and a declaration against interest. The
     inverse is deliberately refused: an unsigned digitalCapture declaration is
     a self-report in favour of interest and earns no promotion at all. */
  const labelLine = {
    "1": "The file's metadata carries China's AI-generated content label (GB 45438-2025), marking it as AI-generated.",
    "2": "The file's metadata carries China's AI-generated content label (GB 45438-2025), marking it as possibly AI-generated.",
    "3": "The file's metadata carries China's AI-generated content label (GB 45438-2025), marking it as suspected AI-generated.",
  }[aiContentLabel];
  if (declarations.declaresAiSource === true || labelLine) {
    const declared = declarations.declaresAiSource === true || aiContentLabel === "1";
    return result({
      tier: "declared-ai-source-type",
      lead: "metadata",
      headline: declared
        ? "Metadata declares AI origin — unsigned"
        : "Metadata labels this as possibly AI-generated — unsigned",
      band: BANDS.DECLARED_GENERATOR_CLUE,
      establishes: (declarations.declaresAiSource === true ? [
        "The file's own metadata declares a synthetic digital source type.",
        "That is a controlled-vocabulary claim about origin, not merely a tool name.",
      ] : []).concat(labelLine ? [labelLine] : []),
      doesNotEstablish: withUniversalLimits([
        "This declaration is not signed, so nothing verifies who wrote it.",
        "Metadata is freely editable and can be copied onto an unrelated file.",
        "It does not establish which parts of the image were generated.",
      ]),
      displayScore: null,
    });
  }

  /* ---- Tier 6: editable metadata names a generator. ----
     Ranked above a failed credential because it is a positive origin clue,
     while a validation failure is mostly a statement about the file's integrity. */
  if (generatorTagged) {
    return result({
      tier: "metadata-generator-named",
      lead: "metadata",
      headline: "AI tool named in metadata — verify",
      band: BANDS.DECLARED_GENERATOR_CLUE,
      establishes: [
        "The file's own metadata names a known AI image tool — either a decoded XMP or " +
        "EXIF field, or a PNG text chunk that generation tools write to record their settings.",
      ],
      doesNotEstablish: withUniversalLimits([
        "Metadata is freely editable and can be copied onto an unrelated file.",
        "The named tool may have been used only for a minor edit.",
        "Absence of such a tag on another file means nothing.",
      ]),
      displayScore: null,
    });
  }

  /* ---- Tier 7: the edit history records a generative step. ----
     Below a named tool because a history entry establishes a step, not an
     origin: a generative fill on one region does not make the image generated. */
  if (declarations.generativeHistoryStep) {
    const agents = Array.isArray(declarations.historySoftwareAgents)
      ? declarations.historySoftwareAgents.slice(0, 3)
      : [];
    return result({
      tier: "edit-history-generative-step",
      lead: "metadata",
      headline: "Edit history records a generative step",
      band: BANDS.DECLARED_GENERATOR_CLUE,
      establishes: [
        "The file's edit history records a generative operation on this image.",
      ].concat(agents.length ? [`Recorded software agent: ${agents.join(", ")}.`] : []),
      doesNotEstablish: withUniversalLimits([
        "A history step is not an origin: a generative edit on one region does not make the whole image generated.",
        "The history is unsigned and editable, and it can be removed entirely.",
        "Absence of such a step in another file means nothing.",
      ]),
      displayScore: null,
    });
  }

  /* ---- Tier 8: a credential was found and failed validation. ---- */
  if (status === "invalid") {
    return result({
      tier: "credential-validation-failed",
      lead: "provenance",
      headline: "Content Credential failed validation",
      band: BANDS.FAILED_ORIGIN_RECORD,
      establishes: [
        "Provenance data was present and did not pass validation on this device.",
      ],
      doesNotEstablish: withUniversalLimits([
        "A failed credential is not evidence that the image is generated.",
        "The file may be damaged, re-saved, altered after signing, or use a credential this validator cannot check.",
      ]),
      displayScore: null,
    });
  }

  /* ---- Tier 7: provenance structure present but not validated. ---- */
  if (hasC2PA || status === "unavailable") {
    return result({
      tier: "credential-present-unverified",
      lead: "provenance",
      headline: hasC2PA
        ? "Provenance data found — not validated"
        : "Content Credential check did not complete",
      band: BANDS.UNVERIFIED_ORIGIN_MARKER,
      establishes: hasC2PA
        ? ["A C2PA/JUMBF structure is present in the file."]
        : ["The local validator could not complete a check."],
      doesNotEstablish: withUniversalLimits([
        "No credential validity, signer trust, or origin conclusion is available.",
        "Treat the marker as unverified; it is not a claim in either direction.",
      ]),
      displayScore: null,
    });
  }

  /* ---- Tier 8: the user told us the image came from a generator site. ---- */
  if (knownGenerator) {
    return result({
      tier: "declared-generator-source",
      lead: "context",
      headline: "Generator-site source supplied — verify output",
      band: BANDS.DECLARED_GENERATOR_CLUE,
      establishes: [
        "You stated the image came from a service that can generate or edit images with AI.",
      ],
      doesNotEstablish: withUniversalLimits([
        "GAIC did not open that address or inspect the page.",
        "Not every image shown on a generator site was generated there.",
      ]),
      displayScore: null,
      pixelCited: pixel.available,
    });
  }

  /* ---- Tier 9 and 10: pixel model inside a reviewed band. ----
     Reached only when no provenance, metadata, or declared-origin signal
     exists. The band label still says supporting-only, and the measured gate
     basis travels with the result. */
  /* Capture evidence cannot outrank a pixel warning — the asymmetry rule forbids
     exculpatory evidence from promoting a tier, because otherwise forged EXIF
     would silence a genuine warning. But the rule explicitly permits it to
     ENRICH, and it must here: a file that carries corroborating camera metadata
     AND trips the model is a direct conflict between two signals, and the model
     is the one with a measured false positive. Saying so is the difference
     between a warning and an accusation. */
  const captureConflict = capture.grade === "corroborated"
    ? [
      "This file also carries " + capture.fieldCount + " internally consistent capture fields, " +
      "which conflicts with the model result.",
      "Where the two disagree, weigh that the model has an observed false positive on " +
      "genuine photographs at gate, and that a camera-metadata block is harder to fabricate " +
      "consistently than a model score is to trip.",
    ]
    : capture.grade !== "none"
      ? ["This file also carries " + capture.fieldCount + " capture field" +
         (capture.fieldCount === 1 ? "" : "s") + ", which the model result does not account for."]
      : [];

  if (pixel.available && !pixel.compositeFrame && pixel.atWarningBand) {
    return result({
      tier: "pixel-high-warning",
      lead: "pixel",
      headline: "High AI-model signal — verify",
      band: BANDS.PIXEL_SUPPORTING_ONLY,
      establishes: [
        "The on-device model scored this image inside its reviewed high-warning band.",
      ],
      doesNotEstablish: withUniversalLimits(captureConflict.concat([
        "The pixel reading is an estimate from image content, not provenance.",
        "Genuine photographs and artwork occasionally score this high; see the model card for measured rates.",
      ])),
      displayScore: pixel.rawScore,
      pixelCited: true,
    });
  }

  if (pixel.available && !pixel.compositeFrame && pixel.atElevatedBand) {
    return result({
      tier: "pixel-elevated-evidence",
      lead: "pixel",
      headline: "Elevated AI-model signal — verify",
      band: BANDS.PIXEL_SUPPORTING_ONLY,
      establishes: [
        "The on-device model scored this image inside its reviewed elevated-evidence band.",
      ],
      doesNotEstablish: withUniversalLimits(captureConflict.concat([
        "The pixel reading is an estimate from image content, not provenance.",
        "Genuine photographs and artwork sometimes score in this band; see the model card for measured rates.",
      ])),
      displayScore: pixel.rawScore,
      pixelCited: true,
    });
  }

  /* ---- Tier 13: encoder structure consistent with a generator write path. ----
     Deliberately positioned AFTER both pixel branches: because this branch sits
     later in the same if-chain, a pixel warning physically cannot be overwritten
     by an encoder match. That is structural enforcement of the asymmetry rule
     rather than a rule engine.

     Reaching this tier requires all four gates in encoderEvidenceGate to pass,
     which with the shipped catalogue is close to impossible on purpose. Every
     current generator-default-writer profile is a single text-declaration class,
     and Gate 4 refuses a single-class tier. The tier stays live code because a
     future catalogue entry earning two independent classes should have somewhere
     to land — not because it is expected to fire. Rarity here is the evidence
     that the guard works; nobody should later loosen the gates because the tier
     "never fires". */
  const encoderGate = encoderEvidenceGate(
    encoder,
    capture.grade,
    hasExif || declarations.declaresCaptureSource === true
  );
  if (encoderGate.admissible) {
    return result({
      tier: "encoder-profile-generator-consistent",
      lead: "container",
      headline: "File structure matches a generator write path",
      band: BANDS.NO_EVIDENCE,
      establishes: [
        "The structure of this file matches a catalogued generator write path across " +
        `${encoder.classCount} independent structural classes (${encoder.strength}).`,
        "No general-purpose imaging library is catalogued as producing this structure at default settings.",
      ],
      doesNotEstablish: withUniversalLimits([
        "This identifies the last program that wrote the file, never the image's origin.",
        "It makes no assertion about the picture itself.",
        "No rate is implied. GAIC has no measurement of how often this structure occurs among real photographs.",
        "Re-saving through the same program would produce the same structure from any source image.",
      ]),
      displayScore: null,
      structuralCited: true,
    });
  }

  /* ---- Tier 14: a screenshot-like composite below the warning bands. ----
     The tier id is kept for stored feedback compatibility. */
  if (pixel.available && pixel.compositeFrame) {
    return result({
      tier: "portal-scan-inconclusive",
      lead: "pixel",
      headline: "Screenshot scan below warning bands",
      band: BANDS.PIXEL_SUPPORTING_ONLY,
      establishes: [
        "The frame looks like a screenshot or exported composite, and the model's reading of it stayed below the warning bands.",
      ],
      doesNotEstablish: withUniversalLimits([
        "Screenshots, re-display, and downscaling hide detail, so a screenshot reading is less certain than a reading of the original file.",
      ]),
      displayScore: null,
      pixelCited: true,
    });
  }

  /* ---- Tier 12 and 13: capture metadata only. ---- */
  /* ---- Tier 15: a camera write path agreeing with capture metadata. ----
     Origin-exculpating evidence, so under the asymmetry rule it may only enrich
     a corroboration tier. It is reached only after every warning branch has been
     considered, and it never clears an image or suppresses anything. */
  // Requires a capture profile that is NOT derived from the EXIF block. The
  // first version of this tier accepted any capture profile, and the only one
  // catalogued reads EXIF tag presence — the same bytes gradeCaptureMetadata
  // already counted. It told users "two independent kinds of evidence agree"
  // while counting one source twice, which is precisely the double-counting the
  // class-independence rule exists to prevent. Genuinely independent capture
  // evidence would be a camera ICC profile description or an ISP
  // quantization-table match; neither is catalogued yet, so this tier does not
  // currently fire. That is the honest state, not a bug to route around.
  if (
    hasExif &&
    capture.grade === "corroborated" &&
    encoder.independentCaptureProfiles.length > 0 &&
    !encoder.generatorProfiles.length
  ) {
    return result({
      tier: "capture-encoder-corroborated",
      lead: "metadata",
      headline: "Camera metadata and write structure agree — not proof",
      band: BANDS.CAPTURE_CORROBORATION,
      establishes: [
        `${capture.fieldCount} capture fields are present and internally consistent.`,
        "Separately from that metadata, the file's write structure matches a catalogued " +
        "camera write path.",
        "These are two independent observations — the metadata block and the encoding " +
        "itself — rather than one source counted twice.",
      ],
      doesNotEstablish: withUniversalLimits([
        "This is still not a clearance. There is no authenticity verdict available from any evidence GAIC has.",
        "Both the metadata and the write structure can be reproduced deliberately.",
        "It does not establish that the depicted event happened as it appears.",
      ]),
      displayScore: null,
      structuralCited: true,
    });
  }

  if (hasExif && capture.grade === "corroborated") {
    return result({
      tier: "capture-metadata-corroborated",
      lead: "metadata",
      headline: "Corroborating camera metadata — not proof",
      band: BANDS.CAPTURE_CORROBORATION,
      establishes: [
        `${capture.fieldCount} capture fields are present, and the ones that can be ` +
        "cross-checked agree: timestamps parse in the EXIF format and are correctly " +
        "ordered, and the exposure values are physically plausible.",
        "A generator pipeline would have to forge all of them consistently.",
      ],
      doesNotEstablish: withUniversalLimits([
        "Every one of these fields can be written by hand or copied from another file.",
        "Consistency is not authenticity: a careful forgery is also consistent.",
        "This is the strongest metadata-only signal GAIC reports and it is still not a clearance.",
      ]),
      displayScore: null,
    });
  }

  // A metadata block with no decoded capture field is not "camera metadata".
  // Orientation-only or thumbnail-only EXIF is extremely common on exported and
  // re-saved images, and announcing it as camera evidence would overstate it.
  if (hasExif && capture.grade !== "none") {
    const inconsistent = capture.consistencyFailures.length > 0;
    return result({
      tier: "capture-metadata-present",
      lead: "metadata",
      headline: "Camera metadata found — not proof",
      band: BANDS.CAPTURE_CORROBORATION,
      establishes: [
        `${capture.fieldCount} capture field${capture.fieldCount === 1 ? "" : "s"} detected.`,
      ],
      doesNotEstablish: withUniversalLimits(
        (inconsistent
          ? ["Some fields did not pass their consistency check, so they are not counted as corroboration."]
          : []
        ).concat([
          "Metadata is editable and partial metadata corroborates little.",
          "Platforms and editors routinely strip or rewrite these fields.",
        ])
      ),
      displayScore: null,
    });
  }

  /* ---- Tier 18: the container was rewritten and the origin is unrecoverable.
     The explanation tier. It carries no accusatory content whatsoever: it says
     only that a general-purpose program was the last thing to write this file,
     which is why no provenance survived. This is the honest and by far the most
     common structural outcome, and it is genuinely useful — it tells the user
     WHY there is nothing to find, instead of leaving a bare "no signal". ---- */
  if (
    encoder.genericProfiles.length > 0 &&
    !encoder.generatorProfiles.length &&
    !hasC2PA &&
    capture.grade === "none"
  ) {
    return result({
      tier: "container-rewritten-origin-unrecoverable",
      lead: "container",
      headline: "Container was rewritten — origin unrecoverable",
      band: BANDS.NO_EVIDENCE,
      establishes: [
        "The last program to write this file was a general-purpose imaging tool, and no " +
        "credential or capture metadata survived that write. That program is most often " +
        "the sharing app, phone gallery, or website the file passed through.",
        "That explains the absence of provenance rather than adding evidence about origin.",
      ],
      doesNotEstablish: withUniversalLimits([
        "A general-purpose write path says nothing about origin: the same program is used for " +
        "generated images and for ordinary photographs alike.",
        "Re-encoding by a messaging app, a CDN, or a screenshot tool produces this same result, " +
        "and that describes most images in circulation.",
        "A rewritten container is not an AI signal and is not a capture signal.",
      ]),
      displayScore: null,
      structuralCited: true,
    });
  }

  /* ---- Tier 19: the model ran, landed below the warning bands, and there is
     no metadata to fall back on. The lean comes from decideImageLean(). ---- */
  if (pixel.available) {
    return result({
      tier: "pixel-below-bands",
      lead: "pixel",
      headline: "Model signal below warning bands",
      band: BANDS.PIXEL_SUPPORTING_ONLY,
      establishes: [
        "The on-device model ran and its reading stayed below the warning bands.",
      ],
      doesNotEstablish: withUniversalLimits([
        "A low reading makes AI generation less likely; it does not prove the image is a real capture.",
      ]),
      displayScore: null,
      pixelCited: true,
    });
  }

  /* ---- Tier 15: no origin evidence of any kind. ---- */
  return result({
    tier: "no-decisive-evidence",
    lead: "none",
    headline: derivedFromHEIF
      ? "Converted copy checked — original container not evaluated"
      : "No origin record or metadata clue found",
    band: BANDS.NO_EVIDENCE,
    establishes: derivedFromHEIF
      ? ["A bounded local JPEG derivative was analysed; the original HEIC/HEIF container was not."]
      : [],
    doesNotEstablish: withUniversalLimits([
      "No provenance, metadata, or model evidence reached a warning band.",
      "Missing credentials and stripped metadata are normal and are not an AI signal.",
    ]),
    displayScore: null,
    pixelCited: pixel.available,
  });
}

/* ---------- decisive lean ----------
   Every image check ends with a lean and a confidence level. Evidence classes
   are added as natural-log likelihood ratios (AI versus real, even prior odds);
   inside a class only the strongest clue counts, so one XMP packet is never
   counted twice. The pixel term is measured (the decision head's calibrated
   probability); the metadata weights below are judgment-set priors for clues
   that are too rare in public data to measure, and are documented as such in
   models/AICHECK-IMAGE-MODEL.md. */
const LEAN_WEIGHTS = Object.freeze({
  declaresAiSource: 3.0,
  generatorParameters: 3.5,
  generatorTagged: 2.5,
  // "gemini" and "imagen" are also ordinary words and names in captions.
  generatorTaggedAmbiguous: 1.0,
  generativeHistoryStep: 1.5,
  // China's AI-content label (GB 45438-2025). Label 1 is written by the
  // generation service itself; under the labeling rules a platform writes 2
  // when the uploader declared the content AI-generated and 3 when it only
  // suspects so from visible marks or other traces.
  aiContentLabel: 3.0,
  aiContentLabelDeclared: 2.0,
  aiContentLabelSuspected: 1.0,
  knownGenerator: 1.5,
  validCaptureCredential: -2.5,
  exifCorroborated: -1.5,
  exifPartial: -0.4,
  exifMinimal: -0.2,
});
const LEAN_LIMIT = 4.6;
// Used when no measured cut points arrive with the pixel reading, and whenever
// non-pixel clues contribute: confidence from the combined probability.
const DEFAULT_CONFIDENCE_CUTS = Object.freeze({ aiHigh: 0.9, aiMedium: 0.75, realHigh: 0.1, realMedium: 0.25 });
/* Fallback when the decision head is unavailable (an older cached model file):
   raw strongest-region score (0-100) to log-likelihood ratio, measured on the
   engine v2 evaluation sets (520 real photos, 1,447 AI images; 520 + 520
   screenshots). Monotone, piecewise linear. */
const PIXEL_LLR_KNOTS = Object.freeze({
  "direct-v5": Object.freeze([[0, -0.55], [5, -0.3], [30, 0], [70, 0.5], [90, 1.1], [95, 1.3], [99, 3.0], [100, 3.3]]),
  "composite-v6": Object.freeze([[0, -0.45], [5, -0.25], [30, 0], [60, 0.8], [90, 2.0], [95, 3.0], [99, 3.3], [100, 3.5]]),
});

function interpolateKnots(knots, x) {
  if (x <= knots[0][0]) return knots[0][1];
  for (let i = 1; i < knots.length; i += 1) {
    if (x <= knots[i][0]) {
      const [x0, y0] = knots[i - 1], [x1, y1] = knots[i];
      return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
    }
  }
  return knots[knots.length - 1][1];
}

export function pixelLogLikelihoodRatio(pixelInput) {
  const pixel = pixelView(pixelInput);
  if (!pixel.available) return 0;
  if (pixel.probability !== null) {
    const q = Math.min(0.995, Math.max(0.005, pixel.probability));
    return Math.log(q / (1 - q));
  }
  return interpolateKnots(PIXEL_LLR_KNOTS[pixel.scan], Math.max(0, Math.min(100, pixel.rawScore)));
}

function validCuts(cuts) {
  if (!cuts) return DEFAULT_CONFIDENCE_CUTS;
  const c = {
    aiHigh: finiteOrNull(cuts.aiHigh), aiMedium: finiteOrNull(cuts.aiMedium),
    realHigh: finiteOrNull(cuts.realHigh), realMedium: finiteOrNull(cuts.realMedium),
  };
  const ok = c.aiHigh !== null && c.aiMedium !== null && c.realHigh !== null && c.realMedium !== null &&
    c.realHigh <= c.realMedium && c.realMedium <= 0.5 && c.aiMedium >= 0.5 && c.aiMedium <= c.aiHigh;
  return ok ? c : DEFAULT_CONFIDENCE_CUTS;
}

function leanResult(probabilityAi, cuts, authority, drivers, confidenceOverride) {
  // Lean and confidence use the exact probability; the displayed value is
  // rounded afterwards and kept on the lean's side of 50%.
  const p = Math.max(0.01, Math.min(0.99, probabilityAi));
  const lean = p >= 0.5 ? "ai" : "real";
  const confidence = confidenceOverride || (lean === "ai"
    ? (p >= cuts.aiHigh ? "high" : p >= cuts.aiMedium ? "medium" : "low")
    : (p <= cuts.realHigh ? "high" : p <= cuts.realMedium ? "medium" : "low"));
  const shown = Math.round(p * 100) / 100;
  return Object.freeze({
    lean, confidence, authority,
    probabilityAi: lean === "ai" ? Math.max(0.5, shown) : Math.min(0.49, shown),
    drivers: Object.freeze(drivers.slice()),
  });
}

/* Returns { lean: "ai"|"real", confidence: "high"|"medium"|"low",
   probabilityAi (0-1, two decimals), authority, drivers } for any image with
   a pixel reading or an origin clue, and null only when there is no evidence
   at all (the model did not run and nothing else was found), which the caller
   reports as a failed check. */
export function decideImageLean(input) {
  const evidence = input && typeof input === "object" ? input : {};
  const container = evidence.container && typeof evidence.container === "object" ? evidence.container : {};
  const prov = evidence.provenance && typeof evidence.provenance === "object" ? evidence.provenance : {};
  const metadata = evidence.metadata && typeof evidence.metadata === "object" ? evidence.metadata : {};
  const heif = container.derivedFromHEIF === true;
  const declarations = heif ? {} : (evidence.declarations && typeof evidence.declarations === "object" ? evidence.declarations : {});
  const status = normalizeString(prov.status, 32);
  const sourceClass = normalizeString(prov.sourceClass, 32);
  const validated = VALIDATED_STATUSES.has(status);
  const pixel = pixelView(evidence.pixel);
  const cuts = validCuts(pixel.cuts);

  if (validated && sourceClass === "ai") {
    return leanResult(0.99, DEFAULT_CONFIDENCE_CUTS, "signed-ai-origin", ["signed-ai-claim"], "high");
  }
  if (status === "trusted" && sourceClass === "capture") {
    // A trusted signed capture decides the lean; a warning-band pixel reading
    // only lowers the confidence and is named as a conflict.
    return leanResult(0.03, DEFAULT_CONFIDENCE_CUTS, "signed-capture",
      ["trusted-capture-credential"].concat(pixel.atWarningBand ? ["pixel-conflict"] : []),
      pixel.atWarningBand ? "medium" : "high");
  }

  const drivers = [];
  let origin = 0;
  if (declarations.declaresAiSource === true) { origin = Math.max(origin, LEAN_WEIGHTS.declaresAiSource); drivers.push("ai-source-declared"); }
  if (!heif && metadata.generatorParameters === true) { origin = Math.max(origin, LEAN_WEIGHTS.generatorParameters); drivers.push("generator-parameters"); }
  else if (!heif && metadata.generatorTagged === true) {
    origin = Math.max(origin, metadata.generatorTagAmbiguous === true
      ? LEAN_WEIGHTS.generatorTaggedAmbiguous : LEAN_WEIGHTS.generatorTagged);
    drivers.push("generator-named");
  }
  if (declarations.generativeHistoryStep) { origin = Math.max(origin, LEAN_WEIGHTS.generativeHistoryStep); drivers.push("generative-edit-step"); }
  const aiLabel = heif ? "" : normalizeString(metadata.aiContentLabel, 1);
  const labelWeight = aiLabel === "1" ? LEAN_WEIGHTS.aiContentLabel
    : aiLabel === "2" ? LEAN_WEIGHTS.aiContentLabelDeclared
      : aiLabel === "3" ? LEAN_WEIGHTS.aiContentLabelSuspected : 0;
  if (labelWeight) { origin = Math.max(origin, labelWeight); drivers.push("ai-content-label"); }
  const context = evidence.sourceContext && evidence.sourceContext.knownGenerator === true ? LEAN_WEIGHTS.knownGenerator : 0;
  if (context) drivers.push("generator-site");
  let capture = 0;
  if (validated && sourceClass === "capture") { capture = LEAN_WEIGHTS.validCaptureCredential; drivers.push("capture-credential"); }
  else if (!heif && container.hasExif === true) {
    const grade = gradeCaptureMetadata(metadata.exif).grade;
    capture = grade === "corroborated" ? LEAN_WEIGHTS.exifCorroborated
      : grade === "partial" ? LEAN_WEIGHTS.exifPartial
        : grade === "minimal" ? LEAN_WEIGHTS.exifMinimal : 0;
    if (capture) drivers.push("camera-metadata");
  }
  const px = pixel.available ? pixelLogLikelihoodRatio(evidence.pixel) : 0;
  if (pixel.available) drivers.push("pixel-model");
  // Without a pixel reading, only an origin clue, a generator site, a signed
  // capture credential, or corroborated camera metadata can carry a lean; a
  // stray EXIF field alone is not enough to decide, so that is a failed check.
  const strongCapture = capture <= LEAN_WEIGHTS.exifCorroborated;
  if (!pixel.available && !origin && !context && !strongCapture) return null;

  let z = origin + context + capture + px;
  // Asymmetry clamp: camera metadata or an untrusted capture credential can
  // lower confidence, never flip a warning-band pixel reading to "real".
  if (pixel.available && pixel.atElevatedBand) z = Math.max(z, 0.05);
  z = Math.max(-LEAN_LIMIT, Math.min(LEAN_LIMIT, z));
  // Measured cut points travel with the pixel reading and are kept when other
  // clues move the probability; the defaults apply only without a pixel read.
  return leanResult(1 / (1 + Math.exp(-z)), pixel.available ? cuts : DEFAULT_CONFIDENCE_CUTS, "", drivers);
}

export const PROVENANCE_TIERS = Object.freeze(TIER_ORDER.slice());
export const PROVENANCE_BANDS = Object.freeze({ ...BANDS });
export const PIXEL_BASIS = PIXEL_EVIDENCE_BASIS;

if (typeof window !== "undefined") {
  window.ProvenanceVerdict = Object.freeze({
    assessImageEvidence,
    decideImageLean,
    pixelLogLikelihoodRatio,
    gradeCaptureMetadata,
    gradeEncoderStructure,
    encoderEvidenceGate,
    ENCODER_EVIDENCE_BASIS,
    PROVENANCE_TIERS,
    PROVENANCE_BANDS,
    PIXEL_BASIS,
  });
}
