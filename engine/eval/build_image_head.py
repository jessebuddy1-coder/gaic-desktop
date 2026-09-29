"""Write runtime/image-head.js from ../data/rfeat/final_head.json."""
import json
h = json.load(open("../data/rfeat/final_head.json"))
def num(v): return float(f"{v:.6g}")
weights = [num(v) for v in h["weights"]]
cal = {k: {"knots": [[num(a), num(b)] for a, b in v["knots"]], "cuts": {kk: num(vv) for kk, vv in v["cuts"].items()}}
       for k, v in h["calibration"].items()}
body = {
    "version": "GAIC image head v1 (2026-09)",
    "dim": len(weights),
    "bias": num(h["bias"]),
    "composite": h["rule"],
    "calibration": cal,
    "weights": weights,
}
js = ("/* GAIC image decision head (engine v3), on-device only.\n"
      "   A linear read of the 2,304-value feature the v3 model file exposes (the class\n"
      "   token and mean patch token after blocks 6, 9, and 12 of the bundled network;\n"
      "   feature standardization is folded into the weights). Calibration tables map\n"
      "   the mean over views to a displayed AI likelihood per scan kind, and the cuts\n"
      "   are the confidence levels. Training data, protocol, and measured results:\n"
      "   models/AICHECK-IMAGE-MODEL.md. */\n"
      "(function () {\n"
      "  const runtime = typeof window !== \"undefined\" ? window : self;\n"
      "  runtime.AICHECK_IMAGE_HEAD = Object.freeze(" + json.dumps(body, separators=(",", ":")) + ");\n"
      "})();\n")
open("runtime/image-head.js", "w").write(js)
print("bytes", len(js))
