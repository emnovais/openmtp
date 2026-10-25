# Contributing to this OpenMTP development fork

[English](README.md) · [Português (Brasil)](README.pt-BR.md)

OpenMTP was created by [Ganesh Rathinavel](https://github.com/ganeshrvel/openmtp). Preserve the existing [MIT license](LICENSE), copyright notices and [third-party attributions](docs/ATTRIBUTION.md). Changes to separately licensed native components retain their applicable licenses.

## Propose and implement a change

1. Check this repository's issues and [feature inventory](docs/FEATURE_STATUS.md). Confirm scope before implementing a new backend or destructive operation.
2. Branch from the maintainer-designated development branch; do not assume upstream's historical master/development PR rules apply to this fork. Target the branch agreed with the maintainer.
3. Keep changes focused and preserve the lockfile/toolchain unless a dependency change is explicitly part of the proposal.
4. Add deterministic mocked regression coverage for behavior changes. Never add a test that automatically opens USB, runs native diagnostics or mutates personal files.
5. Run the [documented Node and offline Electron checks](docs/DEVELOPMENT.md), JavaScript/style lint, both production compilers and `git diff --check`. Report actual counts, failures and warnings.
6. Update English and Brazilian Portuguese READMEs when feature status or release/safety claims change. Keep detailed specifications in the shared documents.
7. Describe the problem, final behavior, validation and remaining limits in the PR. Link the issue where available and request review. A compile result is not device compatibility evidence.

## Current boundaries

Mac → Android and Android → Mac source-preserving Copy/Paste are the supported development directions. Same-endpoint Paste, Cut and Move are excluded. Do not add source deletion to Copy/Paste. Preserve independent Delete, Rename and New Folder.

Use disposable local fixtures and mocked MTP by default. Physical tests need explicit device/path/operation limits, process-close evidence and permission for any content read or write. No automatic retries after uncertain execution; do not release the MTP queue on a timer or weaken unknown destination checks to obtain a pass. Existing personal files are not test fixtures.

## Reports, privacy and release changes

Provide macOS/architecture, isolated toolchain versions, backend, device model/OS and a sanitized reproduction. Remove personal filenames, home paths, USB serial numbers, photos, tokens and credentials before attaching logs. Do not post an API key or private-key material in an issue. Use a maintainer-approved private channel for sensitive reports.

Keep temporary profiles, raw device evidence, build outputs and experimental executables out of commits. Do not enable upstream publishing, reuse signing credentials or redirect auto-update as an incidental change. See [publication blockers and commit plan](docs/PUBLICATION_PLAN.md).

Contributions to the MIT-covered application are proposed under the existing MIT license. This statement does not change the license of third-party source, artwork or native dependencies; preserve their notices and discuss any ambiguity before inclusion.
