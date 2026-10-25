# Native MTP compatibility and experimental Legacy patch

The active application uses renderer-owned backends. This document records experimental Legacy work without changing runtime ownership, installing dependencies or replacing a binary.

## Original and corrected artifacts

| Artifact                  | SHA-256                                                            | Status                                                                    |
| ------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `build/mac/bin/mtp-cli`   | `cc258fc60879d4792acf9f60deb9aafd4730b6536e9736e8fb325bad7e6e1ff6` | Original tracked executable, unchanged; default path                      |
| T11.3 refined candidate   | `7a2cffb42fb4ed3bf78cc485551e344a18985e92e7d7c11487bd29d682089081` | External isolated x86_64 executable, min macOS 15.1; not bundled          |
| T11.4 same-source rebuild | `2dbc3c0ff469438d5ec97792924e54682b99d6f1ba42c4d5365593f550acb964` | External isolated x86_64 executable, target 10.14 / SDK 15.1; not bundled |

The two experimental hashes are the development selector's reviewed allowlist, not general signatures authorizing other downloads. Historical version text alone cannot distinguish these patched builds. Native source is pinned to [whoozle/android-file-transfer-linux revision 2ee1f663b34c731279e4b25a58c747ee3b6f79da](https://github.com/whoozle/android-file-transfer-linux/tree/2ee1f663b34c731279e4b25a58c747ee3b6f79da).

## Exact correction and attribution

The [preserved source patch](native/legacy-usb-discovery.patch) contains the same reviewed T11.3 source edits: 11 insertions and 2 deletions in three files. Its public representation uses a zero-context diff so Git does not interpret patch-context formatting as new-file whitespace errors. Applying it to the pinned base was checked to produce byte-identical versions of all three reviewed files; the original full-context private patch remains unchanged.

- `mtp/ptp/Device.cpp`: delay interface claiming until the existing MTP-name or class-6/subclass-1 match, and read the actual Darwin interface's cached string index.
- `mtp/backend/darwin/usb/Interface.h`: declare the cached getter.
- `mtp/backend/darwin/usb/Interface.cpp`: call the existing IOKit `USBInterfaceGetStringIndex` vtable API through the existing error wrapper.

Early unrelated claims caused exclusive-access warnings. Moving the claim exposed a second mismatch: the active interface iterator could contain an interface absent from the raw configuration-zero descriptor used by the old lookup. The getter fixes that identity mismatch without skipping errors, changing the match rules or hardcoding the AYN device. The first failed candidate and failure evidence were preserved privately; they are not presented as a successful final result.

This is modified **Android File Transfer for Linux**, copyright 2015–2018 Vladimir Menshakov in the pinned source files, licensed under **LGPL 2.1 or later**. The [verbatim LGPL 2.1 license](native/LICENSE.LGPL-2.1) is included. Modification record: isolated claim relocation and cached descriptor-index refinement reviewed in T11.3 (25 October 2026); deployment-target rebuild and development selection in T11.4. Preserve all original source headers when applying the patch. This patch is not part of the application's MIT licensing claim.

The native transfer implementations, token destructor, matching branches, error macro and native cleanup design were not redesigned. In particular, process close does not establish that every native close operation succeeded.

## T11.3 versus T11.4 evidence

**T11.3:** isolated native discovery testing, not application integration. Final mocked actual-function cases passed 26/26; actual Darwin implementation with a fake IOKit vtable passed 8/8. Bounded physical metadata checks showed clean storage and framed directory output after refinement. The application was not redirected to the experimental executable in that phase.

**T11.4:** explicit development-only executable selection and shell-free Legacy metadata execution were integrated. Four physical metadata processes succeeded through actual selector/datasource/repository/controller/queue code and extracted UI Paste preflight methods. Current device/storage identity was rechecked; a directory listing contained 916 entries; current existing-file lookup returned true and a synthetic absent-file lookup returned false. All four closed with exit 0, no signal and empty CLI stderr; maximum active process was one and the queue ended idle. This was a guarded integration host, **not a full application physical GUI interaction**. Separate offline Electron tests verified actual main/renderer IPC.

Neither phase performed physical transfers, thumbnails with the corrected executable, overwrites or cancellation acceptance. Raw device listings and machine-specific evidence remain private rather than being included in this public document.

## Build-target evidence and reproduction

T11.4 used existing Apple clang 16.0.0, CMake 4.4.4 and CLT SDK 15.1 on macOS 26.6.2 ARM64. The new executable is x86_64, linked with system IOKit, CoreFoundation, libedit, libc++ and libSystem. No Go/libusb dependency was added.

The SDK documents interface API 942 as shipped in macOS 10.14, with the cached getter available on API 182+ without opening. The two changed implementation files passed syntax checks using their actual 10.14 compile commands plus `-Werror=unguarded-availability` and `-Werror=unguarded-availability-new`. Load commands record minimum 10.14. Imported-symbol review also identified compiler-dependent C++ exception symbols compared with the original.

**This establishes build-target evidence, not older-macOS runtime compatibility.** No 10.14 host or older system library runtime was tested. No Intel host was tested. Do not distribute this as a generally compatible replacement.

The following is a research reproduction recipe, not a required application setup step. Use an external isolated workspace and existing reviewed tools. Do not install a toolchain or rebuild native components implicitly when running JavaScript tests.

```sh
# Set these to external, dedicated directories; keep the source checkout pinned.
# OPENMTP_NATIVE_SOURCE: pinned android-file-transfer-linux checkout
# OPENMTP_NATIVE_BUILD: separate build output
# OPENMTP_REPO: this repository
cd "$OPENMTP_NATIVE_SOURCE"
git rev-parse HEAD
# Verify: 2ee1f663b34c731279e4b25a58c747ee3b6f79da; review a clean source tree first.
git apply --unidiff-zero --check "$OPENMTP_REPO/docs/native/legacy-usb-discovery.patch"
# Apply only in that dedicated research checkout after reviewing the patch.
git apply --unidiff-zero "$OPENMTP_REPO/docs/native/legacy-usb-discovery.patch"
cmake -S "$OPENMTP_NATIVE_SOURCE" -B "$OPENMTP_NATIVE_BUILD" \
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
  -DCMAKE_OSX_ARCHITECTURES=x86_64 -DCMAKE_OSX_DEPLOYMENT_TARGET=10.14 \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_EXPORT_COMPILE_COMMANDS=ON \
  -DBUILD_QT_UI=OFF -DBUILD_FUSE=OFF -DBUILD_SHARED_LIB=OFF \
  -DUSB_BACKEND_LIBUSB=OFF
cmake --build "$OPENMTP_NATIVE_BUILD" --target aft-mtp-cli --parallel 4
```

Run configure from the pinned source directory because this historical CMake project obtains its version from the current working directory. Use isolated HOME/TMPDIR/compiler caches. The compatibility flag adapts old CMake policy handling without editing its build files. A new compiler/environment may yield a different hash; do not add that hash to the allowlist without review and validation. No source archive or exact reproducible-binary guarantee is implied by this recipe.

## Development selection and rollback

`app/helpers/legacyCliSelection.js` validates a launch-supplied `OPENMTP_DEV_LEGACY_CLI` only in development and only when unpackaged. `app/helpers/binaries.js` captures selection in main and returns that fixed value to the renderer; IPC does not accept a path/hash from UI content. Canonical path, regular executable file, size and SHA validation must pass. Legacy metadata uses literal argv with `shell:false`, sharing the existing queue and process-close barriers. Existing transfer/thumbnail spawn paths also remain shell-free.

Do not select an arbitrary system executable or overwrite the original CLI. Packaged builds ignore the override. To roll back, quit development normally and restart without the variable. A fresh checkout lacking the external corrected candidate uses the original bundled CLI, with its known preflight/USB limitations.

## Redistribution is a separate review

The native patch, base revision and license are preserved here, but the corrected binary is not added. Before distributing any native artifact, establish exact corresponding source, all notices and any applicable linking/relinking obligations for that artifact. Existing tracked Legacy, Kalam and libusb binaries also need this review even when the publication is described as source-only. See [attribution](ATTRIBUTION.md), [limitations](KNOWN_LIMITATIONS.md) and [publication plan](PUBLICATION_PLAN.md).

T13 performed additional read-only binary/module and license inspection; see [native provenance findings](NATIVE_PROVENANCE.md). Local source commits preserve all original binaries and do not clear complete-history publication or a corrected binary release.
