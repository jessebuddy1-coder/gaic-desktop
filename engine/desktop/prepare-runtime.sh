#!/usr/bin/env bash
# Turn a GAIC 2.4.0 desktop runtime folder (resources/app of the installed
# app) into the updated one: apply the engine update (which also runs the
# engine tests against the result), drop the v2 model file that nothing loads
# any more, and rewrite desktop-build-manifest.json.
#
#   engine/desktop/prepare-runtime.sh <resources/app> <version> <engine-commit>
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
engine="$(cd "$here/.." && pwd)"
runtime="${1:?runtime folder}"
version="${2:?version}"
commit="${3:?engine commit}"

grep -q '"version": "2.4.0"' "$runtime/desktop-build-manifest.json" || {
  echo "expected a GAIC 2.4.0 runtime in $runtime" >&2
  exit 1
}

"$engine/tools/apply-engine.sh" "$runtime"

if grep -q 'aicheck-ai-image-v2-fp16' "$runtime/model-config.js"; then
  echo "model-config.js still loads the v2 model" >&2
  exit 1
fi
rm -f "$runtime/models/aicheck-ai-image-v2-fp16.onnx"

node "$here/write-manifest.mjs" "$runtime" "$version" "$commit"

# Every engine file now matches this repository.
while read -r rel; do
  [[ -z "$rel" ]] && continue
  cmp -s "$engine/runtime/$rel" "$runtime/$rel" || { echo "not updated: $rel" >&2; exit 1; }
done < "$engine/runtime/FILES.txt"
echo "runtime ready: $runtime"
