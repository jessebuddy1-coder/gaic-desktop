# GAIC desktop downloads

Installers for **GAIC — Get AI Checked**, the on-device AI content checker.
Website: https://gaicheck.com

This repository exists only to host release binaries for the download buttons on
gaicheck.com. Source lives elsewhere.

See [Releases](../../releases) for the current Windows and macOS builds.

The [`engine/`](engine/README.md) folder holds the checker engine v2 update
for the shared web runtime that every GAIC platform ships, with its measured
results and tests.

## Signing status

| Platform | Status | What the user sees |
|---|---|---|
| Windows | not code-signed | SmartScreen warns: "Windows protected your PC" → **More info → Run anyway** |
| macOS | ad-hoc signed, not notarized | Gatekeeper refuses to open it — use the Mac App Store build instead |

© NIRO CORP
