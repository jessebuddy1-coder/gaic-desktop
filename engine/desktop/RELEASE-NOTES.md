Desktop builds of GAIC (Get AI Checked) — the on-device AI content checker. https://gaicheck.com

**What's new in 2.5.0: a more accurate checker, with a clear answer every time**

* Every check now ends with a lean (AI or real; AI-written or human-written for text), a confidence level, and an AI likelihood, instead of "inconclusive".
* Photos: on AI generators it was never trained on, the new checker called 67% of AI images AI, where 2.4.0 flagged about 1 in 5. About 4% of real images leaned AI. Screenshots of AI images: 69% called AI (2.4.0: 3%).
* Photos: GAIC also reads more of the records AI tools leave in files: Stable Diffusion settings in JPEG and WebP files, China's mandatory AI-content label, and more tool names. An AI company named in a real photo's caption (for example a news photo of OpenAI's CEO) no longer counts as a sign the photo was generated.
* Photos up to 50 MB and 120 megapixels (was 8 MB). The first photo check starts sooner, because the photo model loads while you choose the file.
* Text: a trained on-device model replaces the old pattern rules. It also points out a section that reads machine-written inside writing that otherwise reads human (for example a pasted AI paragraph), and warns when a text contains hidden characters or look-alike letters used to fool AI detectors.
* Text in another language (Spanish, French, German, and others) now gets "English prose required" instead of a score. The English model used to score it anyway, and in testing called as many as 36% of human-written paragraphs in some languages AI-written.
* A new scanning animation that shows what the checker is looking at.
* Rewriting suggestions never change text outside the words they fix.

The desktop app itself is the same as 2.4.0: same look, same settings, same account. Standard checks still run entirely on your device. How the accuracy was measured: [engine/RESULTS.md](https://github.com/jessebuddy1-coder/gaic-desktop/blob/v2.5.0/engine/RESULTS.md).

**Windows** — `GAIC-Setup-2.5.0-x64.exe` (NSIS, x64). Installs over 2.4.0 and keeps your settings. Not code-signed yet, so SmartScreen shows "Windows protected your PC": choose **More info → Run anyway**. This build also fixes a start-up problem: the 2.4.0 installer left out Electron's language file, and on the Windows test machines 2.4.0's window stopped responding right after it opened. 2.5.0 includes the file.

**macOS** — `GAIC-2.5.0-universal.dmg` (universal). Ad-hoc signed and not notarized, so Gatekeeper will refuse to open it after a normal download. Published for reference only; use the Mac App Store build until a notarized Developer ID release exists.

Standard checks run entirely on your device.
