# Changelog

This log describes the development fork, not the complete historical OpenMTP release history. English is primary; see the [Brazilian Portuguese README](README.pt-BR.md) and [bilingual draft release notes](docs/RELEASE_NOTES.md).

## Unreleased

No new release version or downloadable fork build has been published by this work. The manifest retains inherited version **3.3.0**.

### Explorer and previews

- Expose independent List/Grid toolbar menus with existing settings persistence and focus behavior.
- Window Grid rendering over the complete sorted list, with bounded tile mounting and keyboard selection/reveal behavior.
- Add lazy local JPEG/PNG and Legacy Android native-thumbnail previews, bounded memory caching, eviction, context fencing, in-flight consumer replacement and capacity notification.
- Preserve icons for unsupported/unavailable/stale previews; validate private native output and remove owned temporary files. No Android full-file fallback.

### Clipboard and transfer safety

- Preserve clipboard source paths across navigation while binding Paste to its source endpoint, destination, storage and renderer scope.
- Restrict Paste to Mac → Android and Android → Mac; exclude Cut, Move and same-endpoint copying.
- Normalize transfer outcomes and require terminal evidence/native return or process closure before success; protect against duplicate terminal callbacks.
- Distinguish existing, absent and unknown destinations across local/Legacy/Kalam lookups; block unsafe continuation and stale/delayed confirmations.
- Check destination presence after reported success without claiming content integrity or deleting sources/partial destinations.
- Serialize supported MTP execution paths and retain ownership through native return/process close. Active MTP ownership remains in the renderer; the alternative native/main-owner redesign is paused.

### Development compatibility

- Preserve earlier committed startup/logging and development Webpack fixes.
- Add explicit main-validated development-only Legacy executable selection; packaged builds ignore it, default binary remains unchanged.
- Remove the OS shell from Legacy metadata execution while preserving CLI argv and strict preflight error rules.
- Preserve the reviewed experimental Legacy USB-discovery patch and LGPL text as documentation; no corrected binary is bundled.

### Validation and remaining work

- Publication preparation: **846/846 Node cases**, **156/156 offline Electron Grid/UI checks**, both lint checks and both production compilers passed on the tested macOS host.
- Historical bounded Legacy physical browsing/thumbnails/cache and T11.4's four metadata/preflight queries have supporting evidence. This publication-preparation task operated no Android device.
- Current physical transfer correctness, content integrity, real overwrite execution, cancellation, older macOS and broader device compatibility remain unvalidated. No production-ready native replacement or installer is claimed.

## Upstream history

The recorded starting revision is `5da350b69c6d0d4aed67a063498ee89c7448400a`. Existing commit `efadaa0745168c9e297eac514b3d2f271ca1d687` contains baseline stabilization. Retain the repository's original history and [upstream release history](https://github.com/ganeshrvel/openmtp/releases); this file does not rename or recreate upstream releases.
