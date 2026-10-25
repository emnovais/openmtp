# T13 native licensing and provenance review

This is an engineering review of the artifacts already present, not permission to publish an unreviewed binary. The active application's MIT source changes and the separately licensed native patch can be reviewed independently of unresolved inherited binary redistribution. No native executable was added or replaced in T13.

## Recorded findings

| Question                                                             | Finding                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Is the original Legacy executable tracked?                           | Yes, `build/mac/bin/mtp-cli`; its recorded SHA-256 remains `cc258fc60879d4792acf9f60deb9aafd4730b6536e9736e8fb325bad7e6e1ff6`. The same bytes were already checked in at upstream commit `017a11c`.                                                                                      |
| Is a corrected executable tracked?                                   | No. T11.3 and T11.4 corrected candidates remain external; new local commits contain no native binary additions or changes.                                                                                                                                                               |
| Can modified Legacy code be redistributed?                           | The pinned source grants LGPL 2.1-or-later permissions subject to its conditions. Preserve notices, modification records and the LGPL license; distribute modified library source under the applicable LGPL terms. This does not make a binary distribution automatically compliant.     |
| What is needed for a corrected binary?                               | Establish complete corresponding source, headers/build scripts, modification notices and the applicable executable/linking/relinking provisions for the actual artifact. Review the system-library exceptions and distribution method; do not infer compliance solely from a source URL. |
| Are third-party notices needed?                                      | Yes. OpenMTP's MIT notice does not replace Legacy LGPL, libusb, Go-runtime/module, npm or artwork notices.                                                                                                                                                                               |
| Is the build reproducible?                                           | The pinned source plus reviewed patch rebuilt and ran for bounded metadata testing on one host. The recipe and source identity are available. A bit-identical build from a clean independent environment and complete older-macOS runtime acceptance have not been established.          |
| Is the corrected binary necessary to commit the source improvements? | No. Default selection still uses the original executable; the optional selector fails closed without a reviewed external candidate. Binary distribution is a separate decision.                                                                                                          |

See [native patch/build evidence](NATIVE_MTP.md), [attribution](ATTRIBUTION.md) and the [included LGPL text](native/LICENSE.LGPL-2.1). The license permissions and conditions are also described by [Choose a License](https://choosealicense.com/licenses/lgpl-2.1/).

## Legacy source correspondence

The version string reconstructed without executing the bundled CLI is `v3.9-2-g2ee1f66`. Relevant native functions match source/disassembly at `2ee1f663b34c731279e4b25a58c747ee3b6f79da`. This is strong source-lineage evidence, not cryptographic proof of every compiler input or every instruction in the original executable. Its original full build manifest is not available here.

The public source patch preserves the reviewed T11.3 edits, attribution and license. The zero-context representation was applied in an isolated copy to verify that all three resulting source files match the reviewed source hashes. The private original patch and binaries were not modified. Anyone redistributing a complete modified native source tree must also ensure prominent change/date notices in the modified files as required by the applicable license, rather than treating this short patch notice as blanket binary clearance.

## Bundled Go and USB artifacts

Read-only inspection of Go build metadata found:

- Standard amd64/arm64 and historic Kalam libraries report Go **1.19.5**; the ARM64 `seg5` library reports Go **1.27.0**. This metadata was read without loading or executing the libraries.
- The bundled artifacts contain at least two generations of `go-mtpfs` and `go-mtpx`: `77ef22eca9ca` / `b8aa8311a1ed` and `1c3302b3c476` / `18f12db021cc`. A single current `go.mod` does not establish source correspondence for every bundled artifact.
- Other recorded modules include `github.com/ganeshrvel/usb` at `14d96f5ae403`, JSON iterator and modern-go concurrency/reflection dependencies. Version metadata identifies dependencies; it is not a complete notice manifest.
- Previously acquired pristine `go-mtpfs` at `1c3302b3c476` and `usb` at `14d96f5ae403` include BSD notices naming Google Inc. and an endorsement condition. Source and binary redistribution retain different notice obligations. Do not replace their existing copyright/endorsement text with guessed names or a generic MIT label.
- At pinned `go-mtpx` revision `18f12db021cc`, the inspected root file index has no license-named file, and inspected README, packaging notes and `main.go` do not establish license terms. **Permission for redistributing that module as bundled has not been established by this review.** This is a limited inspected-file finding, not proof that no grant exists elsewhere. Obtain authoritative terms/rightsholder clarification and complete the source-file audit before clearing that artifact.
- Upstream [libusb's license file](https://github.com/libusb/libusb/blob/master/COPYING) contains LGPL 2.1. Exact versions, local patches and corresponding sources for all four bundled libusb dylibs were not established from static metadata. A current upstream license does not establish the complete build provenance of those older files.

Private evidence records file hashes and module metadata without publishing compiler-local paths. The source repositories and pinned revisions are the primary references; no Go dependency installation, module resolution, native rebuild, USB access or binary loading was performed.

## Decisions and exclusions

**Local commit scope:** reviewed application/test source, isolated Go research source, documentation, the LGPL source patch and license text. The new patch remains LGPL-covered; it is not relicensed under the application's MIT license. No experimental binary, raw physical evidence or private profile is staged.

**Existing tracked binaries:** preserve them exactly. They remain inherited in Git history and are not newly staged, silently removed or hidden by ignore rules. Excluding them from local diffs does not remove them from a future clone/push. Resolving that historical distribution issue requires source/notices/permission evidence or a separately approved repository strategy; no reset, deletion or history rewrite is authorized here.

**Public source-repository publication:** the new text changes are prepared as local review commits, but publishing this complete branch/history remains on hold because it would also publish inherited native binaries with outstanding provenance/license questions. Do not run the proposed push commands until those blockers and historical author-privacy review are cleared.

**Public binary distribution:** not cleared. In addition to licensing/provenance, physical transfers, content integrity, overwrite/cancellation, supported OS ranges and fork-specific signing/update identity remain release work. The development-only CLI override is not equivalent to a released native integration.
