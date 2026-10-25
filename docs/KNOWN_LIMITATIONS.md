# Known limitations

## Transfer acceptance and scope

Only existing **Mac → Android** and **Android → Mac** Copy/Paste paths are in scope. Mac → Mac and Android → Android Paste remain restricted. Cut, Move and source deletion as part of Paste are excluded. Existing independent Delete, Rename and New Folder remain; their offline tests do not establish new destructive physical-device acceptance.

Transfer-safety changes have mocked/offline coverage. **No physical file transfer with the current corrections is confirmed.** Physical content integrity, recursive-copy behavior, real conflict replacement, partial-file recovery and cancellation still need separate disposable-file acceptance. A terminal backend acknowledgment and a destination-presence check are not proof of identical contents. A failed/partial/uncertain transfer may leave destination data; it is not automatically deleted or reported as safe to overwrite.

Unknown destination existence must block continuation. Permission, device, CLI, parse or stale-context errors are not confirmed absence. Legacy preflight intentionally requires clean stderr and complete framing; it may refuse to proceed with the original CLI when USB discovery diagnostics are present. Thumbnail-specific acceptance of valid output with diagnostics does not relax transfer or destination-preflight checks.

## Native execution and USB

- The default bundled Legacy CLI is unchanged. Its broad device scan can emit `USBInterfaceOpen ... 0xe00002c5` on unrelated interfaces. Do not globally suppress those diagnostics or infer that every such warning is harmless.
- T11.3 corrected discovery only in an isolated native checkout. T11.4 added a development-only selector and physically verified metadata/preflight through application modules. The corrected executable is external, not a checkout dependency or a public download.
- Native tests/metadata success do not prove complete resource cleanup. Existing native close-error handling is unchanged. Process exit and JavaScript timeouts do not acknowledge every resource's safe release.
- Queue serialization is limited to the supported owner/module graph. It cannot exclude other processes, original OpenMTP instances or third-party MTP clients.
- An operation that does not return or whose process does not close cannot be made safe by releasing the queue on a deadline. Stop further admission and preserve evidence; do not switch backends in the same uncertain process.
- Kalam had bounded positive navigation observations but unresolved `LIBUSB_ERROR_NOT_FOUND` and session-timeout evidence. The native ownership redesign is paused; no new Kalam physical transfer claim is made.
- Device/protocol support varies. No general MoveObject/CopyObject, native same-device copy or reliable global identity/reconnection guarantee is claimed.

## Thumbnails and rendering

JPEG/JPG and PNG are the implemented image types. No video, HEIC, GIF, RAW or new icon-size modes are claimed. Local source inspection is limited to 25 MiB, a 256 KiB header window, 16,384 pixels per dimension and 40 million pixels. Unusual JPEG headers, large or changed sources keep fallback icons.

Android previews use **Legacy `get-thumb` only**; no full-resolution retrieval fallback is implemented. Device thumbnail output is limited to 4 MiB, validated by supported image content and decode, then resized to a bounded preview. A PNG-named source can legitimately yield a JPEG device thumbnail. Device `GeneralError (0x2002)` does not establish any specific image-format defect; failed objects keep icons and are not automatically retried in a loop.

Cache memory accounting and entries are bounded (default 16 MiB / 64 entries per service), with two local jobs and one Android job; Android pending jobs are limited to eight. This does not bound the entire renderer heap, native decoder allocations or full listing metadata. Temporary raw Android thumbnails are removed by the provider; successful previews are held in memory. Cache reuse is scoped to file/listing/session identity, not guaranteed across refresh, directory/session changes or restart.

Grid virtualization bounds mounted tiles, not the complete Redux listing or sorting work. List remains unvirtualized. Fast movement can briefly expose fallback icons while measurement/visibility settles. Bounded physical observations are not unrestricted 916-image loading approval or a general benchmark.

## Platform and release

Validated development host: **macOS 26.6.2, Apple Silicon**. The experimental Legacy CLI remains x86_64 and ran on that host. A 10.14 deployment target and availability checks are build evidence only; older-macOS runtime and Intel-host compatibility remain unverified. The inherited app metadata, upstream README requirements and per-library minimum OS versions are not a unified tested fork support policy.

Node 16 / Electron 18 and the locked dependencies are retained; this work is not a dependency/security modernization. A complete vulnerability and supply-chain audit was not performed. The native prototype is not a general replacement or an official release. The inherited package version remains 3.3.0.

The inherited app ID/settings, updater destinations, telemetry identifiers, CI and website branding still refer to upstream in places. Ordinary `yarn dev` can share the installed app's settings and automatically initialize MTP; use an isolated test environment. Do not describe the fork as collecting no data: analytics code and inherited service identifiers exist, even though development flags disable its normal reporting paths.

Source publication and installable distribution both require attribution/provenance review because native binaries are already tracked. See [attribution](ATTRIBUTION.md), [native notes](NATIVE_MTP.md), [development](DEVELOPMENT.md) and [publication blockers](PUBLICATION_PLAN.md).
