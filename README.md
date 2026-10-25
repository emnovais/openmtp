# OpenMTP — File Explorer Development Fork

**[English → README.md](README.md) | [Português (Brasil) → README.pt-BR.md](README.pt-BR.md)**

A development fork of [OpenMTP by Ganesh Rathinavel](https://github.com/ganeshrvel/openmtp), exploring a faster macOS/Android file browser and safer existing USB transfers. This fork preserves the Electron 18, React 17 and Redux architecture. It is not an official upstream release.

**Status: unreleased development work.** Local and bounded Legacy-device browsing/thumbnail checks have passed. The recent transfer-safety changes have offline regression coverage, but physical file transfers with those changes have not been validated. No installable public release containing these improvements is verified or advertised here. `3.3.0` is the inherited package version, not a new fork release.

## Improvements

- **Independent List/Grid controls:** each Computer and Phone toolbar selects its own mode, synchronized with Settings and existing persistence. Current directories, selection, sorting and clipboard state are preserved.
- **Grid performance:** viewport windowing mounts only visible/nearby rows, with scroll/resize scheduling and selection over the complete logical listing. List view remains unvirtualized. Bounded physical testing on a 916-entry directory observed 24–36 mounted Grid tiles; this is a test observation, not a general performance guarantee.
- **Image thumbnails:** local JPEG/PNG previews and Legacy Android `get-thumb` previews load progressively through real viewport visibility. Unsupported, unavailable or stale results retain the file icon. No full-resolution Android download is used as a thumbnail fallback.
- **Bounded caching:** completed previews can be reused across Grid → List → Grid in the same context. In-flight consumer replacement avoids duplicate work. Context checks include file/listing identity and, for Android, backend, storage and renderer session scope. Native temporary output is validated and removed; completed previews are held in a bounded memory cache, not a persistent disk library.
- **Clipboard navigation:** copied paths survive navigation. Endpoint/context checks reject stale source identities, retargeted destinations and delayed confirmations.
- **Transfer outcomes:** progress reaching 100% is not treated as success. Terminal evidence, native return/process closure and error propagation are checked. Destination presence is verified after a reported successful transfer; presence alone does not prove byte-for-byte integrity.
- **Destination preflight:** existing, absent and unknown are distinct. Lookup errors block continuation instead of silently authorizing an overwrite or treating a destination as missing.
- **MTP serialization:** supported renderer-owned execution paths share a FIFO queue. A JavaScript timeout does not release an operation that may still be running. This is not a system-wide or cross-process lock.

Detailed statuses and source references are maintained in the [feature inventory](docs/FEATURE_STATUS.md).

## Operations and scope

| Operation                                                    | Current status                                                                                           |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Mac → Android Copy/Paste                                     | Existing path preserved and hardened; automated validation, physical transfer acceptance pending         |
| Android → Mac Copy/Paste                                     | Existing path preserved and hardened; automated validation, physical transfer acceptance pending         |
| Directory navigation, multiple selection, sorting, List/Grid | Implemented; automated and bounded UI/device observations                                                |
| Independent Delete, Rename and New Folder                    | Existing functionality preserved; offline regression coverage does not establish new physical acceptance |
| Mac → Mac or Android → Android Paste                         | Restricted; excluded from this project's current scope                                                   |
| Cut, Move, source deletion during Paste                      | Excluded; not implemented by this work                                                                   |
| Video thumbnails, adjustable small/medium/large icon modes   | Not implemented by this work                                                                             |

Copy/Paste preserves source files. Independent Delete remains an explicit destructive action; it is not part of copying.

## Native MTP compatibility

The default Legacy backend still uses the original bundled CLI. T11.3 tested an isolated native USB-discovery correction; **T11.4 separately integrated an explicit development-only override** and tested the actual datasource/repository/controller/queue and extracted Paste preflight logic.

Four T11.4 physical metadata queries succeeded on an AYN Thor running Android 13, including existing/missing destination results. The corrected executable was not bundled or released. Packaged builds ignore the override. Its x86_64 build targets macOS 10.14, but runtime testing occurred only on macOS 26.6.2 on Apple Silicon; this does **not** establish older-macOS compatibility.

Legacy thumbnails have bounded positive device evidence, including cache reuse. Some device objects returned `GeneralError (0x2002)` and kept fallback icons. Kalam navigation has earlier positive observations and unresolved `LIBUSB_ERROR_NOT_FOUND`/session diagnostics; Kalam image thumbnails are not implemented. The native ownership redesign is paused; the active application remains renderer-owned.

See [native compatibility and reproduction](docs/NATIVE_MTP.md) and [known limitations](docs/KNOWN_LIMITATIONS.md). A successful thumbnail or metadata query is not proof of general USB health or transfer correctness.

## Installation and development

This checkout is for development. For the original application's downloads, use the [upstream website](https://openmtp.ganeshrvel.com/) or [upstream releases](https://github.com/ganeshrvel/openmtp/releases); those builds do not contain this fork's unpublished improvements. No fork installer is provided here.

Use isolated **Node 16.19.0, npm 8.16.0 and Yarn Classic 1.22.17**, macOS Command Line Tools and the existing lockfile. Do not upgrade dependencies to follow these instructions. Go and a native rebuild are unnecessary for the normal JavaScript build using the checked-in libraries.

```sh
git clone https://github.com/emnovais/openmtp.git
cd openmtp
# First select the isolated toolchain described in docs/DEVELOPMENT.md.
HUSKY_SKIP_INSTALL=1 yarn install --frozen-lockfile --non-interactive
yarn lint
yarn lint-styles
yarn build
```

The install lifecycle builds the development DLL and Electron native addons. `yarn build-dll` can rebuild the DLL explicitly. For an interactive session, the existing command is `yarn dev`; **read the profile-isolation instructions first and disconnect Android devices before a general startup smoke test**. The inherited app identity/settings location can overlap with an installed OpenMTP, and opening the explorer can initialize MTP automatically.

The [development guide](docs/DEVELOPMENT.md) contains reproducible test commands, safe profile guidance and the native-override boundary. Do not run package, signing or publishing commands as part of ordinary validation.

## Testing and release status

The publication-preparation validation on 25 October 2026 passed **846/846 Node cases across 17 suites**, **156/156 mocked Electron Grid/UI checks**, **5/5 real Electron main/renderer IPC checks**, JavaScript lint, stylesheet lint and both production compilers. These are offline checks; this documentation task performed no Android operations.

Historical physical observations are deliberately bounded: browsing, selected thumbnails, progressive rendering, cache reuse and T11.4 metadata/preflight. Physical transfer correctness, content integrity, overwrite execution and cancellation remain acceptance work. Older macOS, other devices and Intel-host runtime compatibility are not established by this host's results.

See the [changelog](CHANGELOG.md), [limitations](docs/KNOWN_LIMITATIONS.md), [draft bilingual release notes](docs/RELEASE_NOTES.md) and [publication plan](docs/PUBLICATION_PLAN.md). Publishing source and distributing a finished macOS application have separate readiness requirements, including third-party binary licensing and fork-specific release identity.

T14 produced an unsigned local ARM64 application (3.3.0) and verified compiled Explorer startup in a private, device-blocked smoke copy. It contains the original Legacy CLI; the corrected development executable is not included. This is not a public installer. See the [local test-build record and pending disposable-file procedure](docs/LOCAL_TEST_BUILD.md).

T14 authorizes conditional source publication. Publication of this complete Git history remains on hold for [native provenance/license review](docs/NATIVE_PROVENANCE.md), because inherited binaries are already tracked. No physical Copy/Paste, overwrite or cancellation acceptance is claimed.

## Credits and contributions

OpenMTP was created by **Ganesh Rathinavel**. The original [MIT license](LICENSE) and copyright notices are preserved. Legacy MTP derives from Vladimir Menshakov's Android File Transfer for Linux under its own LGPL terms; third-party native code and artwork are not relicensed by OpenMTP's MIT license.

Full original credits, logo/artwork attribution, upstream support links and redistribution-review notes are retained in [attribution](docs/ATTRIBUTION.md). The [upstream connection guide](https://openmtp.ganeshrvel.com/how-to-connect-devices.html) and [FAQ](https://openmtp.ganeshrvel.com/#faq) remain useful references for the original application.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a change. Report this fork's issues to this repository and include sanitized environment/backend information; do not post personal device listings, photos or credentials.

**Documentation languages:** English is primary. Brazilian Portuguese is maintained in `README.pt-BR.md`; changes to feature status, safety limits and release claims must update both READMEs. Detailed technical documents are shared between the two languages to avoid duplicate specifications.
