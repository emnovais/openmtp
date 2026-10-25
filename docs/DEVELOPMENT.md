# Development and validation

English is primary; [English](../README.md) and [Brazilian Portuguese](../README.pt-BR.md) READMEs share this guide. Read [known limitations](KNOWN_LIMITATIONS.md) before connecting a device. This guide supersedes the historical root development instructions; it does not authorize packaging or publication.

## Reproducible toolchain

Use **Node 16.19.0 (darwin-arm64 on the tested host), npm 8.16.0, Yarn Classic 1.22.17** in an isolated directory outside the checkout. Electron 18.3.15, React 17, Redux 4, Webpack 5 and electron-builder 23 come from the existing manifest/lockfile. The recorded upstream starting revision is `5da350b69c6d0d4aed67a063498ee89c7448400a`; the current stabilization commit and uncommitted changes are described in the publication plan.

Download tools only from their official distribution sources, verify archive checksums and use absolute paths or a command-local wrapper. Do not change global Node/npm, shell profiles or system Go to reproduce this branch. A reusable pattern for an already prepared toolchain is:

```sh
# Substitute your own verified external toolchain root.
OPENMTP_TOOLS=/absolute/path/to/isolated-toolchain
# This changes PATH/caches for this command only.
env PATH="$OPENMTP_TOOLS/tools/bin:$OPENMTP_TOOLS/node/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  npm_config_cache="$OPENMTP_TOOLS/npm-cache" \
  YARN_CACHE_FOLDER="$OPENMTP_TOOLS/yarn-cache" yarn --version
```

Use the same wrapper for subsequent commands. Verify `node --version`, `npm --version` and `yarn --version` before installing. No global `npm install -g`, Homebrew or full Xcode installation is required by these instructions.

Requirements observed on the tested macOS host: Command Line Tools with Apple clang/make/SDK and Python available to node-gyp. The existing CLT Python rebuilt the Electron addons. `pkg-config` and native build tooling may be needed for rebuilding particular dependencies; do not install them speculatively. Go/libusb development headers and a native Kalam build are **not required for the normal checked-in-binary application build**.

## Install and compile

From the intended fork checkout, with the isolated toolchain selected:

```sh
HUSKY_SKIP_INSTALL=1 yarn install --frozen-lockfile --non-interactive
yarn lint
yarn lint-styles
yarn build-dll
yarn build
```

The install lifecycle already runs `build-dll` and `electron-builder install-app-deps`; an explicit DLL rebuild is useful after relevant development configuration changes. The frozen lockfile must remain unchanged. The production `build` command runs JavaScript lint and both main/renderer compilers. It does **not** package or publish an application.

Do not use `lint-fix` as validation: its inherited script forces a successful exit. Do not use `build-no-verify` as a replacement for the standard build. Existing nonfatal warnings include Browserslist data age, Sass slash division, Webpack optimizeChunkAssets deprecation and Yarn's global-folder notice. These are not instructions to upgrade dependencies during baseline reproduction.

## Run the development GUI safely

The existing interactive command is:

```sh
env -u ELECTRON_RUN_AS_NODE yarn dev
```

**This command alone does not isolate settings.** The inherited app ID is `io.ganeshrvel.openmtp`; the application builds its settings path from the home directory and Electron also maintains user-data/cache paths. Do not launch it against an installed OpenMTP profile. Use a separate disposable macOS test account, or a reviewed private launcher that sets Electron `userData`/cache/temp and the application's home/settings resolution before application imports. Setting only `--user-data-dir` does not establish isolation of the application's separate settings file. Prior physical tests used private launchers; those machine-specific harnesses are not repository dependencies.

Keep Android unplugged for a general startup smoke test; the explorer can initialize MTP automatically and Grid can read device thumbnail content. Close competing OpenMTP/MTP processes through normal application shutdown; never terminate unrelated processes or reset USB interfaces as a routine workaround. Do not run the original installed application as a test fixture.

Optional development DevTools installation can fail without preventing normal startup. A usable window, successful compilation, native-library loading and physical MTP functionality are different acceptance results.

## Offline Node regression suites

There is no aggregate `yarn test` script. Run every Node suite while excluding the Electron entry, and preserve failures:

```sh
for suite in tests/*.test.js; do
  case "$suite" in *-electron.test.js) continue ;; esac
  NODE_ENV=test node "$suite" || exit "$?"
done
git diff --check
```

The current set is **17 suites / 846 cases**. Strict mocked imports prevent real USB/FFI/CLI execution. Some tests create explicitly owned disposable fixtures under the macOS temporary directory; they do not use personal Downloads or Android files. Keep generated fixture paths/results out of commits. The publication audit also used a private preload to confine those fixtures to one audit workspace; that preload is optional and not required to run the tests.

Coverage includes terminal transfer evidence, duplicated callbacks, uncertain outcomes, process-close barriers, FIFO serialization, renderer session fencing, true/false/unknown preflight, stale/delayed Paste, clipboard identities, same-endpoint restrictions, independent mutations with mocked adapters, thumbnail cache/consumer/error behavior, Grid windowing and development executable selection. Historical main-owner/IPC tests exercise retained research contracts; they are not proof that the active app owns MTP in main.

## Offline Electron Grid/UI checks

Use the existing test entry, not the normal application. It installs its own private profile and denies physical MTP, diagnostics and native execution. The artifact directory must have the expected prefix:

```sh
OPENMTP_UI_ARTIFACTS=$(mktemp -d /private/tmp/openmtp-t3-offline-XXXXXX)
env -u ELECTRON_RUN_AS_NODE NODE_ENV=test \
  OPENMTP_T3_ARTIFACTS="$OPENMTP_UI_ARTIFACTS" OPENMTP_T4_EXTENDED=1 \
  node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  tests/grid-scrolling-electron.test.js
```

On the validated host this passed **156 checks** over 100/500/1000-item mocked cases. Review `electron-results.json` and `electron-quit.json`, not just process output. Screenshots and metrics are temporary test artifacts. Do not treat mocked Electron results as a full application/device GUI test.

## Experimental native override

Default selection is the original bundled CLI. Only an unpackaged main process launched in development can select a reviewed executable using `OPENMTP_DEV_LEGACY_CLI`. Path/type/executable access and fixed SHA allowlist validation are mandatory; renderer input cannot choose a path or supply a new checksum. A missing or mismatched explicit override fails safely.

The corrected executable is **not included** in the checkout. Do not paste historical temporary paths from a private report into another machine. See [native provenance, exact source patch and reproduction](NATIVE_MTP.md). A rebuilt binary is not automatically approved merely because it compiles or reports the same version. Packaged applications ignore the override; rollback is to restart development without the variable. Never overwrite `build/mac/bin/mtp-cli` as part of reproduction.

## Packaging, CI and physical acceptance

`electron-builder-config.js`, `codemagic.yaml`, `.github/workflows/main.yml` and publishing scripts retain upstream identity/destinations and signing expectations. The inherited workflow also contains tolerated packaging failures. They are not a ready fork release pipeline. No signing credentials are needed for offline lint/tests/production compilation.

Do not run `yarn package*`, signing, notarization or publish scripts as part of this guide. Review [publication readiness](PUBLICATION_PLAN.md) and [third-party attribution](ATTRIBUTION.md) first. Do not execute `dev-kalam-ffi` for routine development; it is a native rebuild path.

Any physical acceptance must be separately scoped to disposable fixtures and explicit read/write permissions. A metadata-only or thumbnail-only test is not permission to transfer. Current evidence does not confirm physical transfer content integrity, overwrite or cancellation with the corrected Legacy executable.

## Documentation maintenance

Update both READMEs for feature/release/safety status changes, and update the shared feature inventory, limitations and changelog once. Preserve the original MIT notice and applicable native/artwork notices. The [historical baseline](development-baseline.md) retains its original chronological results; it is not the current support matrix.
