#!/usr/bin/env bash
# Apply the GAIC engine update to a web runtime folder, the one folder every
# platform ships: gaicheck.com (Vercel), the iOS/Android apps (Capacitor
# copies it into the native projects), the Windows/macOS desktop app
# (Electron serves it from resources/app), and the Chrome extension.
#
#   engine/tools/apply-engine.sh <path-to-web-runtime-root>
#
# The target must contain ai-detector.html, app.js, and detector-worker.js.
# Files that still match GAIC 2.4.0 are replaced outright. If a target file
# has changed since 2.4.0, the script stops and tells you to apply
# engine/patches/gaic-engine-v2.patch with
# `git apply -3 --directory=<web folder>` instead, so no newer work is
# overwritten.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="${1:-}"
if [[ -z "$target" || ! -f "$target/ai-detector.html" || ! -f "$target/app.js" || ! -f "$target/detector-worker.js" ]]; then
  echo "usage: $0 <web-runtime-root containing ai-detector.html, app.js, detector-worker.js>" >&2
  exit 2
fi

changed=()
while read -r sum rel; do
  [[ -z "$rel" ]] && continue
  if [[ -f "$target/$rel" ]]; then
    now="$(sha256sum "$target/$rel" | cut -d' ' -f1)"
    [[ "$now" == "$sum" ]] || changed+=("$rel")
  fi
done < "$here/runtime/BASELINE-2.4.0.sha256"

if (( ${#changed[@]} )); then
  echo "These target files differ from GAIC 2.4.0, so they were not overwritten:" >&2
  printf '  %s\n' "${changed[@]}" >&2
  echo "Apply the reviewed diff instead:  git -C <repo> apply -3 --directory=<web-folder-in-repo> $here/patches/gaic-engine-v2.patch" >&2
  exit 1
fi

while read -r rel; do
  [[ -z "$rel" ]] && continue
  mkdir -p "$target/$(dirname "$rel")"
  cp "$here/runtime/$rel" "$target/$rel"
  echo "updated $rel"
done < "$here/runtime/FILES.txt"

echo "running engine tests against $target"
GAIC_RUNTIME="$target" node --test "$here"/test/*.test.mjs
