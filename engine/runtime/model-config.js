/* GAIC Image Model v3 — bundled, on-device only.
   Source: OwensLab/commfor-model-224 (Community Forensics, arXiv:2411.04125),
   MIT license, converted to ONNX fp16 locally from the published safetensors.
   v3 is the same network with the same weights; the file also exposes a
   2,304-value feature output that the GAIC decision head (image-head.js)
   reads. Attribution, checksums, preprocessing, training data, and limitations
   are recorded in models/AICHECK-IMAGE-MODEL.md. */
(function () {
  const runtime = typeof window !== "undefined" ? window : self;
  runtime.AICHECK_ONNX = Object.freeze({
    id: "GAIC Image Model v3",
    source: "OwensLab/commfor-model-224",
    revision: "26afc31e6b40c312c3fd42c05a758be62446215b",
    model: "models/aicheck-ai-image-v3-fp16.onnx",
    size: 224,
    resizeShortest: 256,
    crop: "center",
    // The worker preserves the reviewed two-step resize-shortest then center
    // crop and adds a bounded whole/corner plus middle/lower-center scan for
    // composite frames such as portal screenshots.
    regionScan: "whole-official-center-mid-lower-v5",
    maxRegions: 8,
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
    output: "sigmoid",
    softmax: false,
    aiIndex: 0,
  });
})();
