# OpenMTP development baseline

Assessment date: 2026-10-22 (Australia/Brisbane).

Repository revision: `5da350b69c6d0d4aed67a063498ee89c7448400a`.
Application version: `3.3.0`.
Target: macOS on Apple Silicon.

## Result

| Check | Result |
| --- | --- |
| Isolated Node/npm/Yarn setup | Passed: 16.19.0 / 8.16.0 / 1.22.17 |
| Locked dependency installation | Passed, including install lifecycle and Electron native module rebuilds |
| JavaScript lint | Failed: two existing formatting errors in website source |
| Stylesheet lint | Failed: three existing website stylesheet errors |
| Standard `yarn build` | Failed at the JavaScript lint gate; compilers were not reached |
| Production compilation through existing `build-no-verify` script | Passed: main and renderer, exit 0 |
| ARM64 Kalam load through Node/Koffi | Passed |
| ARM64 Kalam load through Electron 18/Koffi | Passed; USB detection and permissions addons also loaded |
| Development application startup | Blocked: DevTools extension download failure followed by main-process logging exception |
| Physical Android device functionality | Not tested |
| Android transfers or mutations | Not performed |

Successful compilation and shared-library loading do not establish successful application startup or physical-device MTP compatibility.

No application source, backend, build configuration, manifest, or lockfile was changed. No Go, Xcode, or additional native dependencies were installed. No packaging, signing, notarization, publishing, commit, or push was performed. This report is the only intentional tracked-tree addition.

## Environment

| Tool or platform | Observed value |
| --- | --- |
| macOS | 26.6.2, build 25G83 |
| Hardware/process architecture | arm64 |
| Global Node | 22.19.0, universal executable running as arm64 |
| Global npm | 10.9.3 |
| Global Yarn | Not available on initial PATH |
| Isolated Node | 16.19.0, darwin-arm64 |
| Isolated npm | 8.16.0 |
| Isolated Yarn Classic | 1.22.17 |
| Electron runtime | 18.3.15; embedded Node 16.13.2; ABI 103; arm64 |
| Go | Not available; not needed for checked-in native binaries |
| Active developer directory | `/Library/Developer/CommandLineTools` |
| Apple Clang | 16.0.0, clang-1600.0.26.4 |
| SDK selected by xcrun | 15.1 |
| Full Xcode | Not selected; no Xcode app found in the standard Applications location |
| Python on ordinary PATH | Homebrew Python 3.15.0 |
| Python actually used by node-gyp | Existing CLT Python 3.9.6 at `/Library/Developer/CommandLineTools/usr/bin/python3` |
| pkg-config/pkgconf | 3.0.10 |
| System libusb development package | Not found by pkg-config |
| Make | GNU Make 3.81 |
| CMake | 4.4.4 |
| Homebrew LLVM | 23.1.3_2; not required for this build |
| Git | 2.56.0 |
| Rosetta | Installation detected; legacy CLI execution was not tested |

The existing Command Line Tools were sufficient to rebuild the Electron addons. No Python installation was necessary. SDK/host version differences did not prevent this compilation, but broader compatibility is untested.

The repository's preinstall check in `internals/scripts/CheckYarn.js` requires npm `>=6.x <=8.16.0`; global npm 10 is unsuitable. Babel targets Node 16, and Codemagic pins Node 16.19.0/npm 8.16.0.

### Installed versions from the existing lockfile

| Package | Installed version |
| --- | --- |
| electron | 18.3.15 |
| react | 17.0.2 |
| react-dom | 17.0.0+4.13.0, the manifest's hot-loader alias |
| redux | 4.0.5 |
| webpack | 5.91.0 |
| electron-builder | 23.3.3 |
| koffi | 2.8.7 |
| usb-detection | 4.14.1 |
| node-mac-permissions | 2.2.1 |
| electron-devtools-installer | 0.0.1, repository's Git dependency |
| console-log-plus | 1.0.8 |
| eslint | 8.27.0 |
| stylelint | 14.15.0 |

These are locked versions, not dependency upgrades.

## Isolation and reproduction

The session's temporary environment is `/private/tmp/openmtp-baseline.jK8pkG`:

- `node-v16.19.0-darwin-arm64/`: downloaded Node distribution.
- `tools/`: npm 8.16.0 and Yarn 1.22.17 installed with an explicit prefix.
- `npm-cache/`, `yarn-cache/`, `electron-cache/`, `electron-builder-cache/`: dedicated download caches.
- `run-isolated.sh`: process-local environment wrapper used for the checks below.
- `*.log`: full command output from this assessment.

Temporary paths may be removed by macOS. Preserve the logs elsewhere if long-term raw evidence is needed. No shell profile, global Node/npm installation, or global package-manager activation was changed. Global Node/npm still report 22.19.0/10.9.3 afterward.

The ARM64 Node archive was downloaded from `https://nodejs.org/dist/v16.19.0/node-v16.19.0-darwin-arm64.tar.gz` and verified with the matching entry in that release's `SHASUMS256.txt`. The checksum check passed.

Initial tool installation used the extracted Node on PATH and:

```sh
npm install --global --prefix /private/tmp/openmtp-baseline.jK8pkG/tools \
  npm@8.16.0 yarn@1.22.17 --no-audit --no-fund
```

Despite `--global`, the explicit prefix confines these packages to the temporary directory. It does not target the system installation.

The wrapper supplies these process-local values:

```sh
export PATH=/private/tmp/openmtp-baseline.jK8pkG/tools/bin:/private/tmp/openmtp-baseline.jK8pkG/node-v16.19.0-darwin-arm64/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin
export npm_config_cache=/private/tmp/openmtp-baseline.jK8pkG/npm-cache
export YARN_CACHE_FOLDER=/private/tmp/openmtp-baseline.jK8pkG/yarn-cache
export YARN_GLOBAL_FOLDER=/private/tmp/openmtp-baseline.jK8pkG/yarn-global
export ELECTRON_CACHE=/private/tmp/openmtp-baseline.jK8pkG/electron-cache
export ELECTRON_BUILDER_CACHE=/private/tmp/openmtp-baseline.jK8pkG/electron-builder-cache
```

Existing install scripts also wrote Electron headers to `~/.electron-gyp/18.3.15`; that cache is not a global toolchain replacement. The app launch used its existing macOS profile/log locations and Electron's user-data cache. No existing profile was reset or removed. The project lifecycle's Husky installation was skipped with `HUSKY_SKIP_INSTALL=1` to avoid changing Git hooks.

### Commands and logs

Commands ran from the repository root with the isolated PATH/caches above. Full output was captured with `tee` and shell `pipefail` so a pipeline could not conceal the command's failure.

| Command | Exit/status | Raw log in temporary environment |
| --- | --- | --- |
| `HUSKY_SKIP_INSTALL=1 yarn install --frozen-lockfile --non-interactive` | 0 | `install.log` |
| `yarn lint` | 1 | `lint.log` |
| `yarn lint-styles` | 2 | `lint-styles.log` |
| `yarn build` | 1 | `build.log` |
| `yarn build-no-verify` | 0 | `compile.log` |
| Node/Koffi load check | 0 | `native-node.log` |
| Electron/Koffi/addon load check | 0 | `native-electron.log` |
| `yarn dev` with inherited environment | Wrapper exited 0 despite runtime exception | `dev.log` |
| `env -u ELECTRON_RUN_AS_NODE yarn dev` | Runtime startup failed; processes stopped after diagnosis | `dev-gui.log` |

For this session, prefix a command with:

```sh
sh /private/tmp/openmtp-baseline.jK8pkG/run-isolated.sh yarn build
```

On a fresh machine, recreate the same versioned toolchain in a new isolated directory and substitute its absolute path. Keep `--frozen-lockfile`; do not update dependencies or the Browserslist database as part of reproduction.

## Dependency installation results

Installation completed in approximately 55 seconds. The repository postinstall successfully ran `yarn build-dll` and `electron-builder install-app-deps`.

`usb-detection` had no Electron 18.3.15/ABI 103/darwin-arm64 prebuilt asset: GitHub returned 404. The normal source-build fallback succeeded. `node-mac-permissions` also compiled successfully. Both resulting `.node` files and Electron itself are ARM64.

Warnings retained in `install.log`:

- Peer mismatches involving Material UI 4 and React 17; React Redux 5 and React 17; the hot-loader React DOM version and React 17.0.2; electron-ga/Electron; older ESLint peer ranges; and optimize-css-assets-webpack-plugin/Webpack 5.
- The Git dependency's preparation emitted unmet semantic-release/Mocha peers and a Yarn temporary Node-path warning.
- Outdated caniuse-lite/Browserslist database.
- electron-builder dependency-resolution diagnostics, including `unresolved deps` messages. Installation nevertheless exited 0; runtime imports were tested separately for the native addons.
- Five C++ warnings in usb-detection: anonymous struct linkage warnings and unused-but-set variables.
- Empty static archive warning for node-mac-permissions' `nothing.a`.

Early lint runs also emitted sandbox cache/global-folder warnings. Later commands used the explicit cache wrapper; Yarn still warned about its preferred global installation folder. These warnings did not alter the locked dependencies.

## Lint and compilation

### Existing lint failures

| File and line | Rule/result |
| --- | --- |
| `docs-sources/index.js:175` | `prettier/prettier`: formatting of a wrapped template-string assignment |
| `docs-sources/index.js:274` | `prettier/prettier`: formatting of the sort callback |
| `docs-sources/styles/global.scss:1704` | `no-duplicate-selectors`: `.faq-window` also appears at line 1522 |
| `docs-sources/styles/global.scss:2646` | `declaration-empty-line-before` |
| `docs-sources/styles/global.scss:2694` | `declaration-block-no-redundant-longhand-properties`: flex-flow shorthand |

These files match the original revision. No auto-fix was run. The JavaScript errors block `yarn build`; stylesheet lint is a separate script.

### Production compiler result

After reporting the lint failure, the existing `build-no-verify` script was used solely to distinguish compilation from lint. It invokes the same `build-main` and `build-renderer` commands without the lint gate.

Both compilers exited 0. Outputs include `app/main.prod.js`, its related chunks/maps, and renderer assets under `app/dist`. The development DLL and manifest were also generated under `dll`.

Compiler warnings:

- Outdated Browserslist databases.
- Deprecated Webpack `optimizeChunkAssets` hook.
- Sass slash-division deprecation in `app/styles/scss/base/mixins/_rem.scss:28`, reached through `themes/reset.scss`.

This is a successful compiler baseline with a failing standard build gate. No dependency or configuration changes were made to obtain it.

## Native library compatibility

`app/helpers/binaries.js` selects `build/mac/bin/arm64/kalam-seg5.dylib` on this host because the configured alternate-library range is macOS `>=26`.

Static checks established:

- Selected Kalam and its `libusb-seg5.dylib` are ARM64.
- Kalam links to `@loader_path/libusb-seg5.dylib`, which is present beside it.
- The selected Kalam library's recorded minimum OS and SDK are 26.0.
- The selected Kalam library and debug executable pass `codesign --verify` inspection. No signing action was performed.
- The ordinary ARM64 Kalam library is also present; its recorded minimum OS is 14.0.
- Legacy `build/mac/bin/mtp-cli` is x86_64; it was not executed.

The load test used `koffi.load()` and resolved `Initialize` and `Dispose` function symbols without invoking them. It passed under isolated Node 16.19.0 and under Electron's Node mode:

```text
Electron: 18.3.15
Embedded Node: 16.13.2
ABI: 103
Architecture: arm64
Kalam loaded: true
Addons imported: koffi, usb-detection, node-mac-permissions
Device functions called: false
```

The Electron check used `ELECTRON_RUN_AS_NODE=1` intentionally. No USB monitoring, MTP initialization, transfer, rename, mkdir, or deletion was requested by the smoke tests. Library loading proves loader/ABI compatibility for this environment, not physical-device protocol behavior.

## Application startup investigation

### Inherited environment failure

The execution environment already had `ELECTRON_RUN_AS_NODE=1`. The first unmodified `yarn dev` inherited it, causing Electron to run without main-process APIs. `@electron/remote/main` failed because `ipcMain` was undefined.

The launcher still exited 0, so that exit code is not evidence of successful startup. The retry removed this variable for the launch process only; no source or configuration file changed.

### Remaining development startup blocker

The corrected launch started Electron and the server on `127.0.0.1:4642`, but failed before constructing a usable main window:

1. `app/main.dev.js:createWindow` awaits `installExtensions`.
2. The pinned `electron-devtools-installer` tries the React DevTools Chrome download URL with `prodversion=32`.
3. The downloaded CRX is zero bytes. A separate request to the identical URL returned HTTP 204 with zero bytes; the server's reason for returning no content was not established.
4. CRX parsing rejects it with `Invalid header: Does not start with Cr24`.
5. The catch handler calls `log.error`. `console-log-plus@1.0.8` accesses `parent.window.console` in the Electron main process, where `parent` is undefined.
6. Further catch handlers encounter the same logging exception. An unhandled promise rejection is printed, and no usable browser window is established.

The localhost root returned HTTP 404; a running server/process did not establish a rendered application. Errors are also recorded in the app's existing `OpenMTP-error-2026-10.dev.log`.

All processes in the specific development process group created for this check were stopped with SIGTERM after diagnosis. Port 4642 was no longer listening. No existing unrelated application process was targeted.

No startup workaround was applied. The smallest proposed source-level follow-up is a safe main-process logging path and nonfatal handling of optional extension installation errors. Changes require approval. A production GUI launch was not substituted for the requested development startup.

## Manual regression checklist

All items below are **not run**. The development startup blocker must be resolved first. Use a dedicated disposable fixture tree on macOS and a clearly named disposable Android directory. Record Android model, OS, storage, USB mode, MTP backend, and Mac OS/architecture. Keep original fixtures and SHA-256 hashes for comparison. Never use personal files or accept an overwrite prompt during baseline copying.

| Check | Manual procedure | Expected baseline behavior |
| --- | --- | --- |
| Android detection | Connect one unlocked Android device, select File Transfer, grant access; refresh | Correct device/storage list or explicit error; record backend and device details |
| Directory navigation | Browse fixture subfolders, breadcrumb, Folder Up, refresh | Correct listing/path, no stale entries; selection clears appropriately |
| List/Grid | Switch each panel through Settings, navigate and restart | Both modes render; panel preferences persist |
| Multiple selection | Select via mouse/checkbox, Command/Shift actions, select-all and keyboard navigation | Correct paths/count; behavior remains consistent in both views |
| Android to macOS copy | Copy disposable fixtures to a new empty local directory | Destination contents/hashes match; Android sources remain |
| macOS to Android copy | Copy disposable fixtures to a new empty Android destination | Names/sizes match; subsequently read back for hash verification; local sources remain |
| Folder creation | Create a uniquely named empty fixture folder on each endpoint | Appears after refresh and is navigable |
| Rename | Rename a disposable fixture on each endpoint | New name appears; contents remain unchanged |
| Delete confirmation | Select only a disposable fixture, open confirmation, then Cancel | File remains; no deletion is executed |
| Actual Delete | Deferred; requires explicit authorization for disposable targets | Do not execute during this milestone |
| Clipboard across navigation | Copy fixtures, navigate to an empty destination on the opposite endpoint, Paste | Clipboard survives navigation; correct sources copied; same-endpoint Paste remains disabled in current app |
| Copy to Queue | Add disposable paths from multiple directories on the same endpoint | Queue survives navigation and contains intended unique paths |
| Storage/reconnect handling | Observe with disposable queued references; do not paste after changing storage/device | Record behavior as a known clipboard-identity risk; do not risk retargeted operations |

Mkdir and rename are device mutations and were not performed in this milestone. Transfers and actual deletion are likewise untested. No claim of Android compatibility or data integrity is made.

## Integrity evidence and next actions

Manifest hashes before and after installation/build:

```text
package.json  1944963f93376695e34edfd13bddff7d9cda027f8fd008db512323d5bf1fa232
yarn.lock     7fa1c0f658782556f5ee06330a9772b46231ca5d14198ffe4af889e1b749d508
```

The working tree was clean before this report was added. Generated build/dependency outputs are ignored. `git diff --check` found no whitespace errors in the tracked changes checked before documentation.

Before Milestone 1:

1. Approve narrowly scoped fixes for the existing website lint errors, or explicitly accept the failing standard build gate as a baseline limitation.
2. Approve the minimal development-startup correction for optional DevTools failure handling and main-process logging. Re-run `yarn dev` and verify a rendered, usable window.
3. Run the non-destructive UI/device checks with a physical Android device. Separately authorize disposable transfers/mutations if desired.
4. Keep Go/native-library rebuilding, packaging, and release qualification out of scope until needed and explicitly approved.

Milestone 0 establishes reproducible dependency installation, compiler success, and ARM64 loader success. It does not yet establish a working development UI or physical-device regression baseline.

## Milestone 0.1 — approved baseline stabilization

Assessment date: 2026-10-22 (Australia/Brisbane). The original Milestone 0 results above are retained as historical evidence. This section records the approved corrections and current status.

### Changes applied

| File | Change |
| --- | --- |
| `docs-sources/index.js` | Corrected only the two Prettier formatting errors |
| `docs-sources/styles/global.scss` | Consolidated `.faq-window`, added the required blank line, and replaced equivalent flex longhands with `flex-flow: row wrap` |
| `app/utils/log.js` | Used native `console.info`/`console.error` outside the renderer; retained styled renderer output, file logging, redaction, reporting, and production-console gates |
| `app/main.dev.js` | Caught import, synchronous installer, and rejected-promise failures inside optional DevTools initialization so window creation can continue |

Dependencies, manifests, lockfile, build configuration, MTP backend, and transfer behavior were not changed. The existing isolated toolchain was reused. No additional software was installed.

### Validation results

Commands below used `sh /private/tmp/openmtp-baseline.jK8pkG/run-isolated.sh` as their prefix.

| Check | Result | Evidence in temporary environment |
| --- | --- | --- |
| `yarn lint` | Passed, exit 0 | `m01-lint.log` |
| `yarn lint-styles` | Passed, exit 0 | `m01-lint-styles.log` |
| Standard `yarn build` | Passed, exit 0, including lint and both production compilers | `m01-build.log` |
| Focused logging checks | Passed: main/renderer paths, original Error objects, file logging/redaction/reporting, production-console gates | `m01-diagnostics.log` |
| Optional extension checks | Passed: success, rejection, synchronous failure, import failure, force-download option | `m01-diagnostics.log` |
| Stylesheet comparison | Passed: compiled before/after CSS has identical per-selector/media-context declaration values after expanding flex shorthand | `m01-diagnostics.log` |
| Electron/Koffi native smoke check | Passed, exit 0: Electron 18.3.15, arm64, ABI 103, selected Kalam and both native addons loaded | `m01-native.log` |
| `env -u ELECTRON_RUN_AS_NODE yarn dev` | Main window created; optional extension failure logged without the previous main-process exception | `m01-dev-final.log` |
| Rendered-window observation | Visible=true, loading=false, document readyState=complete, React root populated, local file listing present | `m01-dev-final.log`, `m01-window.png` |
| No uncaught startup exceptions | **Not satisfied:** a separate generated development DLL syntax error remains | `m01-dev-final.log` |

The focused checks used temporary/in-memory diagnostic stubs, with no repository test framework installation. The CSS comparison checks declaration equivalence rather than a full visual regression suite.

The window was inspected visually from an Electron `capturePage` screenshot. It rendered the local file browser, toolbars, and expected Android-not-connected panel. This establishes a visible, populated application window; it does not establish complete UI or physical-device correctness. The saved profile selected Legacy Mode during this GUI check; Kalam loading was verified separately through the smoke check.

A temporary `NODE_OPTIONS` observer recorded window visibility, renderer errors, DOM readiness, and the screenshot. It did not replace application modules or modify source. Its first launch failed because it accessed Electron APIs too early; the temporary observer was corrected before collecting the final results. That diagnostic failure is separate from application failures.

The validation application was quit after inspection. Its development launcher exited 0, the Electron process ended, and port 4642 was confirmed no longer listening.

The user disconnected the Android device before GUI validation, and the host USB inventory was checked. No connected Android device operations, transfers, creation, rename, or deletion were performed. Native smoke checks resolved symbols but did not invoke device functions.

### Additional renderer findings — no configuration changes applied

The approved fixes allow startup to proceed far enough to expose additional existing development-renderer problems:

1. **Generated DLL syntax error.** Electron reports `Uncaught SyntaxError: Invalid or unexpected token` at `dll/renderer.dev.dll.js:30`. The emitted line is:

   ```js
   module.exports = @electron/remote;
   ```

   A standalone JavaScript parse check reproduces it. `webpack/config.renderer.dev.dll.babel.js` sets `output.libraryTarget: 'var'` while inheriting package externals from the base configuration. Those externals are emitted as variable expressions, including package names that are not valid JavaScript identifiers. Proposed follow-up: explicitly set `externalsType: 'commonjs2'` for the DLL, retaining its existing library output, then rebuild and parse-check the DLL. This requires approval before changing configuration.

2. **Malformed development font assets.** Renderer messages include `Failed to decode downloaded font` and `OTS parsing error: invalid sfntVersion: 1702391919`. The served `.woff2` response begins:

   ```js
   export default __webpack_public_path__ + "92fbd4e93cf0a5dbebaa100066de8653.woff2";
   ```

   It is JavaScript rather than font bytes. The renderer bundle points to this intermediate asset. The development font rules use legacy url-loader/file-loader without an explicit module type, consistent with Webpack 5 asset handling processing their generated JavaScript as an asset. Proposed follow-up: explicitly use `type: 'javascript/auto'` on affected legacy font-loader rules, then verify font signatures and renderer behavior. Production has similar rules; its runtime behavior has not been established and should be assessed before extending any change there.

3. **React development warning.** `Warning: Cannot update during an existing state transition (such as within render)` remains. The stack includes `Extended`, `ThemeProvider`, and `App`. Its root cause was not established; no component changes were made.

The optional CRX download still fails, but is now logged and nonfatal. Build warnings about Browserslist, Sass slash division, deprecated Webpack hooks, and Yarn's preferred global folder remain. No updates or warning suppression were applied.

### Current acceptance status and next action

The approved lint and main-process startup fixes pass their targeted checks. Standard production compilation and ARM64 loading pass, and a populated Electron window appears. The requirement for no uncaught startup exceptions remains open because of the generated DLL syntax error; font decoding is also unresolved.

Request approval for the narrowly scoped development Webpack corrections above, then rebuild the DLL, rerun full lint/build checks, and repeat rendered-window validation. Do not treat Milestone 0.1 as fully accepted or begin Milestone 1 until the remaining startup acceptance issue is resolved or explicitly accepted as a limitation.

Manifest/lockfile hashes remain:

```text
package.json  1944963f93376695e34edfd13bddff7d9cda027f8fd008db512323d5bf1fa232
yarn.lock     7fa1c0f658782556f5ee06330a9772b46231ca5d14198ffe4af889e1b749d508
```

## Milestone 0.1 — development Webpack follow-up

Assessment date: 2026-10-22 (Australia/Brisbane). This approved follow-up resolves the DLL and font issues recorded in the preceding section. Earlier results remain historical records.

### Scope and corrections

Only two development Webpack files and this report were changed during this follow-up:

| File | Correction |
| --- | --- |
| `webpack/config.renderer.dev.dll.babel.js` | Added `externalsType: 'commonjs2'` so external packages are emitted as CommonJS requires while the DLL retains its existing `var` library output |
| `webpack/config.renderer.dev.babel.js` | Added `type: 'javascript/auto'` and `url-loader` option `esModule: false` to the two affected WOFF/WOFF2 rules |

The module type prevents Webpack 5 asset handling from emitting loader-generated JavaScript as font bytes. During validation, setting the module type alone exposed a second interoperability issue: CSS requested `[object Module]` as a file URL, and three font faces failed. `esModule: false` makes the existing loaders provide plain CommonJS URL strings. After both settings, the fonts load successfully.

The TTF/EOT/SVG/image rules were not changed. The application requests WOFF/WOFF2 fonts in the tested development UI. Production and shared Webpack configuration, application source, MTP code, dependency installations, and lockfile were not changed in this follow-up. The previous milestone's approved source edits were preserved.

Production renderer configuration SHA-256 before and after:

```text
a6f4e3250fbc0ebee8ce979fe25ff2e2f2e3654452a092809689712aed61e655
```

### Commands and final results

The same isolated Node 16.19.0/npm 8.16.0/Yarn 1.22.17 environment was used. Commands were prefixed with `sh /private/tmp/openmtp-baseline.jK8pkG/run-isolated.sh`. No dependencies were installed, upgraded, replaced, or reinstalled.

| Check | Final result | Evidence under `/private/tmp/openmtp-baseline.jK8pkG` |
| --- | --- | --- |
| `yarn build-dll` | Passed, exit 0 | `webpack-dll-final.log` |
| Generated DLL parse check with Node `vm.Script` | Passed; `@electron/remote` emitted as `require("@electron/remote")` | `webpack-font-assets.log` |
| `yarn lint` | Passed, exit 0 | `webpack-lint-final.log` |
| `yarn lint-styles` | Passed, exit 0 | `webpack-lint-styles-final.log` |
| Complete `yarn build` | Passed, exit 0: lint, production main, production renderer | `webpack-production-build-final.log` |
| ARM64 Electron/Koffi loading | Passed: Electron 18.3.15, selected Kalam, usb-detection, node-mac-permissions; no device functions invoked | `webpack-native.log` |
| `env -u ELECTRON_RUN_AS_NODE yarn dev` | Visible, fully loaded window; React root populated | `webpack-dev-final.log` |
| Font asset binary checks | All 24 files passed: 12 WOFF and 12 WOFF2, HTTP 200, correct `wOFF`/`wOF2` signatures, header lengths matching response lengths | `webpack-font-assets.log` |
| Chromium font loading | Three used font faces loaded; zero font faces in error state; no font parsing/decoding console errors | `webpack-window-result.json` |
| Main/renderer exception check | No uncaught exceptions, unhandled promise rejections, renderer process termination, or main-frame load failure observed | `webpack-dev-final.log` |
| Local sorting | Name sort changed from ascending to descending after clicking the local header | `webpack-window-result.json` |
| Local navigation | Local Folder Up changed the listing from 59 entries to 4 entries | `webpack-window-result.json` |
| `git diff --check` | Passed | Final working-tree check |
| Lockfile and production/shared configuration integrity | Unchanged | SHA-256 and Git comparisons |

The temporary observer collected renderer console messages, resource failures, font responses, window state, and a screenshot. It clicked only the local Name sort control and local Folder Up button. The observed window had `visible=true`, `loading=false`, and document `readyState=complete`. The screenshot `webpack-window.png` was visually inspected and shows the local browser and expected no-device panel.

### Remaining diagnostics and limits

- The optional DevTools CRX download still fails with `Invalid header: Does not start with Cr24`. It is logged in the main process, and startup continues normally.
- The React warning about updating during an existing state transition remains. Fixing component lifecycle behavior is outside this Webpack scope.
- Electron prints its development Content Security Policy warning. No security or runtime configuration was changed to suppress it.
- Webpack development-server warnings reflect the existing Sass slash-division deprecation. Browserslist, deprecated Webpack-hook, and Yarn preferred-global-folder warnings remain.
- Three font `net::ERR_CACHE_MISS` events were recorded. The same resources subsequently returned HTTP 200 and decoded successfully; all used faces loaded. No persistent missing-font URL or `[object Module]` request remained in the final check.

The Android device remained disconnected for GUI validation, and the app showed the expected device-not-connected state. No Android file operations were performed. This validates development startup, local browsing controls, and native loading; physical-device MTP compatibility and the full regression checklist remain untested. The saved GUI profile used Legacy Mode; Kalam was tested separately by loading the existing library without invoking device functions.

The development application now starts and renders successfully, with no observed uncaught startup exception or font parsing error. The approved DLL/font blockers are resolved. Remaining diagnostics above are recorded rather than suppressed. Production configuration was preserved and production compilation passes; no production GUI, packaged application, or release behavior is claimed as tested.

The validation application was quit afterward. The development launcher exited 0 and port 4642 was confirmed no longer listening.

`package.json` and `yarn.lock` retain the SHA-256 hashes recorded above. No commit, push, package, signing, notarization, or publishing action was performed.
