# Desktop builds with the engine update

The GAIC desktop app serves the shared web runtime from `resources/app`
(Windows) or `GAIC.app/Contents/Resources/app` (macOS). The desktop shell
(`app.asar`, the executables, and their resources) never reads or checks those
files beyond serving them, so a release with the engine update can be built
from the published 2.4.0 installers without the GAIC source repository.

`.github/workflows/desktop-release.yml` does that on GitHub's Windows and macOS
machines whenever `engine/` changes on the engine branch:

1. Downloads the 2.4.0 release assets and checks their SHA-256 against
   `package.json` → `gaicRelease.baseAssets`.
2. `prepare-runtime.sh` applies `engine/runtime` with `engine/tools/apply-engine.sh`
   (which runs the engine tests on the result), removes the unused v2 model, and
   rewrites `desktop-build-manifest.json` with `write-manifest.mjs` (which
   reproduces the 2.4.0 manifest byte-for-byte from the 2.4.0 files).
3. **Windows:** electron-builder packs the prepared app with the 2.4.0 installer
   settings: app ID `com.nirocorp.aicheck`, the same uninstall GUID, a one-click
   per-user install, and the 2.4.0 installer icon (`build/icon.ico`, extracted
   from the 2.4.0 installer). The job checks the payload matches the prepared
   files exactly, installs 2.4.0, upgrades it with the new installer, checks
   Installed apps shows one GAIC entry at the new version, and uninstalls at
   the end.
4. **macOS:** the 2.4.0 `GAIC.app` gets the same runtime update and version
   number and is re-signed ad hoc, as 2.4.0 was. `dmgbuild` then writes the
   image with the 2.4.0 layout (`dmg_settings.py`); `compare_dmg_layout.py`
   checks the window, view options, and icon positions match 2.4.0.
5. `smoke.mjs` launches each built app, attaches over the DevTools protocol,
   and runs a text check, a photo check, and a 48 MP photo check through the
   real UI. Every result must be a lean with a confidence level and an AI
   likelihood, the text result must match this repository's engine, and the
   page must log no errors. Screenshots are kept as workflow artifacts.
6. When `package.json` → `gaicRelease.publish` is `true` and every job passed,
   the workflow publishes release `v<version>` with both files and
   `RELEASE-NOTES.md`. An existing release is never overwritten.

What stays the same as 2.4.0: every file outside the runtime folder, including
the executables and `app.asar` (which the Windows build checks byte for byte),
with one addition on Windows: the 2.4.0 installer shipped an empty `locales`
folder, and on Windows the app's page process then crashed at start (the
unchanged 2.4.0 app does the same on GitHub's Windows machines). The build
restores Electron 43.2.0's `locales/en-US.pak` from Electron's own release,
checked against its published SHA-256.
On macOS, only the runtime files, `Info.plist`'s version fields, and the ad hoc
signature change, so the About panel shows the new version. The version the
shell reports internally (`app.getVersion()`, from `app.asar`) stays 2.4.0;
no page in the app shows it.
