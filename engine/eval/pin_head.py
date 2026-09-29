"""Pin the shipped image head's calibration at its lean thresholds.

The published tables came from calib_image.knots() before it pinned the
threshold: the isotonic fit is flat around each threshold, so a band of head
logits just below it (direct and frame: 2.5 to 2.656; composite: 1.25 to
1.603) read exactly 50% and leaned AI. This rewrites runtime/image-head.js
with calib_image.pin_knots() applied to every table, at the thresholds in
results/image_v3_calibration.json. Weights, bias, and cuts are unchanged.

  python3 pin_head.py"""
import json, re
import calib_image as CI

path = "../runtime/image-head.js"
src = open(path).read()
m = re.search(r"Object\.freeze\((\{.*\})\);\n", src)
head = json.loads(m.group(1))
thresholds = json.load(open("results/image_v3_calibration.json"))["thresholds"]
for kind, table in head["calibration"].items():
    table["knots"] = CI.pin_knots(table["knots"], thresholds[kind])
    xs = [x for x, _ in table["knots"]]; vs = [v for _, v in table["knots"]]
    assert xs == sorted(xs) and len(set(xs)) == len(xs), kind
    assert all(b >= a for a, b in zip(vs, vs[1:])), kind
out = src[:m.start(1)] + json.dumps(head, separators=(",", ":")) + src[m.end(1):]
open(path, "w").write(out)
print("pinned", {k: thresholds[k] for k in head["calibration"]}, "bytes", len(out))
