# T13 local commit and publication record

T13 explicitly authorized reviewed staging and local commits. **No push, remote change, tag or release is authorized.** This replaces the earlier seven-group proposal; that proposal remains in the private audit evidence. English and Brazilian Portuguese introductions are maintained in the [English README](../README.md) and [README em português](../README.pt-BR.md).

## Git baseline and local branch

Original branch: `feature/advanced-file-manager`, original HEAD `efadaa0745168c9e297eac514b3d2f271ca1d687`. It has no remote tracking branch; local `master` tracks `origin/master`. Origin remains `https://github.com/emnovais/openmtp` for fetch/push. There are no submodules or active Git hook files; the checked-in Husky settings were inspected but their hook is not installed.

The local publication branch is `publication/t11-4-reviewed`, created from that original HEAD while preserving the entire dirty tree. The original feature branch is retained as a rollback reference, without reset, clean, stash or history rewriting. New local commits use the public repository-owner handle and noreply email as command-local author/committer identity; global/local Git identity settings remain unchanged. Prior author metadata is not rewritten and still needs intentional review before public history distribution.

## Coherent commit boundaries

The originally proposed toolbar-only commit is unsafe as a standalone final-file split: `ToolbarAreaPane.jsx` also imports new renderer scope functions and includes session fences. Thumbnails, controller plumbing, the repository, callback outcomes, passive IPC dependencies and their tests also cross historical milestone boundaries. Rather than fabricate a chronological split or commit broken intermediate code, T13 uses three coherent groups:

1. **57 runtime/test files:** final renderer-owned Explorer, virtualized Grid/previews/cache, source-preserving cross-endpoint transfer/clipboard checks, destination validation, FIFO/native-return barriers and development-only Legacy selection, with their regression suites. This combined commit preserves the paused alternative-owner research modules that remain imported/tested; it does not activate main-process MTP ownership.
2. **2 pure-Go research files:** preserve the isolated lifecycle prototype without wiring it into the native backend or rebuilding a binary.
3. **15 documentation/notice files:** bilingual introduction, shared status/build/limitations, attribution, source patch and license, native provenance and publication guidance.

See the local Git log and final private audit report for commit hashes; a document cannot embed its own final commit hash. Commit messages describe the final combined behavior rather than claiming each historical phase was committed independently. The manifest below is an explicit audit record, not an instruction to repeat staging after the commits exist.

## Reviewed staging manifest

### 1. feat: integrate scoped Explorer previews and safer cross-device operations

```sh
git add -- \
  app/containers/HomePage/components/ToolbarAreaPane.jsx \
  app/containers/HomePage/components/ToolbarBody.jsx \
  app/classes/AppUpdate.js \
  app/containers/ErrorBoundary/components/GenerateErrorReport.jsx \
  app/containers/HomePage/actions.js \
  app/containers/HomePage/components/FileExplorer.jsx \
  app/containers/HomePage/reducers.js \
  app/containers/Settings/actions.js \
  app/data/file-explorer/controllers/FileExplorerController.js \
  app/data/file-explorer/repositories/FileExplorerRepository.js \
  app/data/file-explorer/data-sources/FileExplorerKalamDataSource.js \
  app/data/file-explorer/data-sources/FileExplorerLegacyDataSource.js \
  app/data/file-explorer/data-sources/FileExplorerLocalDataSource.js \
  app/data/file-explorer/MtpOperationQueue.js \
  app/data/file-explorer/transferResult.js \
  app/data/file-explorer/MtpMainBackendFactory.js \
  app/data/file-explorer/MtpSessionClient.js \
  app/data/file-explorer/MtpSessionIpc.js \
  app/data/file-explorer/MtpSessionOwner.js \
  app/data/file-explorer/MtpSessionService.js \
  app/data/file-explorer/MtpSessionTransport.js \
  app/data/file-explorer/data-sources/FileExplorerMtpIpcDataSource.js \
  app/main.dev.js \
  app/services/ipc-events/IpcEventHandler.js \
  app/services/ipc-events/IpcEventType.js \
  ffi/kalam/src/Kalam.js \
  app/containers/HomePage/components/FileExplorerTableBodyGridRender.jsx \
  app/containers/HomePage/components/FileExplorerTableBodyGridWrapperRender.jsx \
  app/containers/HomePage/styles/FileExplorerTableBodyGridRender.js \
  app/containers/HomePage/components/FileExplorerThumbnail.jsx \
  app/data/file-explorer/thumbnails/LocalThumbnailProvider.js \
  app/data/file-explorer/thumbnails/MtpThumbnailProvider.js \
  app/data/file-explorer/thumbnails/ThumbnailService.js \
  app/helpers/binaries.js \
  app/helpers/legacyCliSelection.js \
  tests/clipboard-safety.test.js \
  tests/cross-endpoint-fixtures.test.js \
  tests/cross-endpoint-safety.test.js \
  tests/destination-existence.test.js \
  tests/file-management-regression.test.js \
  tests/grid-scrolling.test.js \
  tests/grid-virtualization.test.js \
  tests/image-thumbnails.test.js \
  tests/kalam-existence.test.js \
  tests/legacy-cli-selection.test.js \
  tests/legacy-thumbnails.test.js \
  tests/mtp-owner-cutover.test.js \
  tests/mtp-serialization.test.js \
  tests/mtp-session-ipc.test.js \
  tests/mtp-session-lifecycle.test.js \
  tests/mtp-session-transport.test.js \
  tests/transfer-reliability.test.js \
  tests/grid-scrolling-electron.test.js \
  tests/grid-scrolling-renderer.js \
  tests/grid-scrolling-safety.js \
  tests/fixtures/grid-windowed-prototype.jsx \
  tests/fixtures/grid-batched-wrapper.jsx
```

### 2. chore(native): preserve isolated lifecycle research

```sh
git add -- \
  ffi/kalam/native/lifecycle/core.go \
  ffi/kalam/native/lifecycle/core_test.go
```

### 3. docs: add bilingual project and native provenance documentation

```sh
git add -- \
  README.md \
  README.pt-BR.md \
  DEVELOPMENT.md \
  CONTRIBUTING.md \
  CHANGELOG.md \
  docs/FEATURE_STATUS.md \
  docs/KNOWN_LIMITATIONS.md \
  docs/DEVELOPMENT.md \
  docs/NATIVE_MTP.md \
  docs/ATTRIBUTION.md \
  docs/RELEASE_NOTES.md \
  docs/PUBLICATION_PLAN.md \
  docs/native/legacy-usb-discovery.patch \
  docs/native/LICENSE.LGPL-2.1 \
  docs/NATIVE_PROVENANCE.md
```

Before each authorized commit, inspect the intended staged file list, full patch/content audit, `git diff --cached --stat` and `git diff --cached --check`. No binary or private evidence is staged. Do not use indiscriminate `git add .` or delete files to force a clean status.

## Native licensing and privacy decisions

Read [native provenance](NATIVE_PROVENANCE.md) and [attribution](ATTRIBUTION.md). The original Legacy executable and bundled Kalam/libusb libraries are inherited tracked assets and remain unchanged. Experimental corrected executables stay external. The source patch retains LGPL terms, notices and a change record; it is not a released binary integration.

Go build metadata identifies different dependency generations in inherited binaries. Some BSD/LGPL terms are established; complete artifact/source/license correspondence is not, including license permission not established from the inspected pinned `go-mtpx` files. **The complete branch/history must not be pushed until inherited native redistribution questions are resolved.** No destructive removal or history rewrite is attempted to hide them.

The current reviewed text contains no confirmed secret/private key or raw device listing. Legitimate upstream author/contact/artwork notices remain. One physical-test-derived image label in a mocked regression was replaced with a synthetic fixture name; assertions and execution are unchanged. Other user/home/serial strings are deliberate synthetic denied-path or identity fixtures, not captured device identifiers. Private reports, logs, temporary profiles, screenshots and executables remain outside the repository.

Existing environment/certificate/build ignore rules remain intact. No blanket ignore of tests/docs/native assets is introduced. Ignore rules cannot remove already tracked/history content. Existing history includes an author email; the new commits avoid adding it, but that does not clear privacy of inherited history.

## Validation and limits

After local commits, run all 17 Node suites, offline Electron Grid checks, real Electron main/renderer selection IPC checks, JavaScript/style lint, both production compilers, documentation/link/language checks and `git diff --check`. Preserve outputs outside the repository. No physical device operation is needed or authorized by T13. Physical Copy/Paste correctness, integrity, overwrite and cancellation remain unvalidated; older macOS runtime and a public installer remain unvalidated too.

`package.json` remains 3.3.0. The fork has no verified installable release containing this work. Do not tag a stable release or infer release readiness from compilation. See [draft bilingual notes/descriptions](RELEASE_NOTES.md), [feature inventory](FEATURE_STATUS.md) and [limitations](KNOWN_LIMITATIONS.md).

## Recommended publication arrangement

Prefer an identifiable GitHub fork of `ganeshrvel/openmtp` so ancestry and attribution remain visible. Keep the existing `origin` pointed at the intended `emnovais/openmtp`; do not point it at upstream for publishing. Whether GitHub currently labels that remote as a fork was not changed or assumed. An independent repository is an alternative only after an explicit identity/attribution and inherited-content review. No repository or remote was created/modified in T13.

Publish `publication/t11-4-reviewed` as a review/development branch only after the blockers are resolved. Do not overwrite upstream maintenance branches or force-push. Keep original MIT and third-party notices and the upstream links in both READMEs.

Inherited app ID/settings, updater/publish targets, telemetry identifiers, CI and `docs/CNAME` still contain upstream identity. Do not enable Pages or release credentials as-is. A binary release needs a separate fork identity/version/signing/notarization plan, full native notices/corresponding source and physical transfer acceptance.

## Proposed push commands — not executed

Only after **separate publication approval** and resolution of native/history-privacy blockers:

```sh
git status --short
git remote get-url origin
git log --oneline efadaa0745168c9e297eac514b3d2f271ca1d687..publication/t11-4-reviewed
git diff --stat efadaa0745168c9e297eac514b3d2f271ca1d687..publication/t11-4-reviewed
# Confirm the destination is the intended fork, never ganeshrvel/openmtp.
git push --dry-run origin publication/t11-4-reviewed:refs/heads/publication/t11-4-reviewed
git push --set-upstream origin publication/t11-4-reviewed:refs/heads/publication/t11-4-reviewed
```

These commands create no release/tag and use no force option, but a push would still publish inherited binary/history content. Do not execute them just because the new commits are text-only. No push is performed by this plan.

Suggested first announcement: **Development source snapshot: independent List/Grid, virtualized Explorer previews and stronger Mac↔Android transfer safeguards. Experimental native work is documented separately; physical transfer acceptance and an installable release remain pending.** Use the English/Portuguese descriptions and matching draft notes in [RELEASE_NOTES.md](RELEASE_NOTES.md), without claiming a public installer or older-macOS support.
