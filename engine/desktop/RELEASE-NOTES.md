Desktop builds of GAIC (Get AI Checked) — the on-device AI content checker. https://gaicheck.com

**What's new in 2.5.0: a more accurate checker, with a clear answer every time**

* Every check now ends with a lean (AI or real; AI-written or human-written for text), a confidence level, and an AI likelihood, instead of "inconclusive".
* Photos: on AI generators it was never trained on, the new checker called 67% of AI images AI, where 2.4.0 flagged about 1 in 5. About 4% of real images leaned AI. Screenshots of AI images: 71% called AI (2.4.0: 3%).
* Text: a trained on-device model replaces the old pattern rules.
* Photos up to 50 MB and 120 megapixels (was 8 MB).
* A new scanning animation that shows what the checker is looking at.
* Rewriting suggestions never change text outside the words they fix.

The desktop app itself is the same as 2.4.0: same look, same settings, same account. Standard checks still run entirely on your device. How the accuracy was measured: [engine/RESULTS.md](https://github.com/jessebuddy1-coder/gaic-desktop/blob/v2.5.0/engine/RESULTS.md).

**Windows** — `GAIC-Setup-2.5.0-x64.exe` (NSIS, x64). Installs over 2.4.0 and keeps your settings. Not code-signed yet, so SmartScreen shows "Windows protected your PC": choose **More info → Run anyway**.

**macOS** — `GAIC-2.5.0-universal.dmg` (universal). Ad-hoc signed and not notarized, so Gatekeeper will refuse to open it after a normal download. Published for reference only; use the Mac App Store build until a notarized Developer ID release exists.

Standard checks run entirely on your device.
