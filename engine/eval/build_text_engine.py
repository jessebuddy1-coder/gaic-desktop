import json, sys
src = open("engine-text-src.js").read()
m = json.load(open("../data/text/model_K2500_B8.json"))
model = {
    "version": "GAIC Text Model v2 (2026-09)",
    "bias": round(m["bias"], 6),
    "dense": [[round(a, 5), round(b, 5), round(c, 6), d] for a, b, c, d in m["dense"]],
    "lexicon": {k: round(v, 5) for k, v in sorted(m["lexicon"].items()) if abs(round(v, 5)) > 0},
    "lexCap": m["lexCap"],
    "bands": {"low": -0.63, "high": 2.47},
    # Standalone direction (Cohen's d, AI minus human) of each measurement on the
    # training data; explanations cite a measurement only when its contribution
    # agrees with this direction.
    "effect": json.load(open("../data/text/dense_effect.json")),
}
block = ("\n/* GAIC Text Model v2 weights: logistic regression over the measurements above\n"
         "   plus a 2,500-term general-vocabulary lexicon. Provenance, training corpora,\n"
         "   held-out results, and limits: models/GAIC-TEXT-MODEL.md. */\n"
         "(function (global) {\n  if (!global.AICheckTextEngine) return;\n  global.AICheckTextEngine.setModel(" +
         json.dumps(model, separators=(",", ":")) + ");\n})(typeof window !== \"undefined\" ? window : globalThis);\n")
open("runtime/text-detector.js", "w").write(src + block)
print("bytes", len(src + block), "lexicon", len(model["lexicon"]))
