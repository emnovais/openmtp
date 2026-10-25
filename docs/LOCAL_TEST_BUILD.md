# Local macOS build and pending physical acceptance

## T14 result

On macOS 26.6.2 / Apple Silicon, the existing isolated Node 16.19.0, npm 8.16.0 and Yarn 1.22.17 produced a local **ARM64 OpenMTP.app**, inherited version **3.3.0**, with electron-builder 23.3.3 and Electron 18.3.15. No dependency installation, native rebuild, signing credential, notarization, installer or binary publication was involved.

An isolated copy of that compiled application rendered both Explorer panels in a visible window and quit with exit code 0. A temporary bootstrap set a private home, application-data directory, Electron profile/cache/temp paths and renderer preload before loading the unchanged production bundle. It denied USB monitoring, native loading and MTP execution, and blocked renderer network requests. The automatic Legacy initialization attempt was denied intentionally. This verifies compiled startup and rendering, **not Android connectivity**. The uninstrumented package was not launched against an attached device or the original user profile.

The packaged Legacy CLI is the **original** x86_64 binary, SHA-256 `cc258fc60879d4792acf9f60deb9aafd4730b6536e9736e8fb325bad7e6e1ff6`. All packaged ARM64 Kalam/libusb files match their checked-in originals. The corrected development CLI is **not included**. An ARM64 Electron executable does not make every bundled helper ARM64; running the Legacy CLI on Apple Silicon requires x86_64 execution support already available on the validation host.

Signing was explicitly disabled. The inherited Electron executable retains a linker ad-hoc signature, but the assembled bundle has no valid sealed Developer ID signature; `codesign --verify --deep --strict` fails. It is not notarized or ready for Gatekeeper distribution. No Intel application was built: the available Electron distribution is ARM64, and the inherited native-file filter uses the build process architecture. Passing `--x64` alone would not establish a correct Intel package.

Packaging emitted dependency-resolution diagnostics and an electron-builder update-check/config-store warning. No dependencies or permissions were changed to silence them. The offline compiled Explorer still loaded without uncaught exceptions or renderer/resource-load errors. Existing Browserslist, Webpack and Sass deprecation warnings remain.

## Reproducing the local package

First select the isolated toolchain in [DEVELOPMENT.md](DEVELOPMENT.md). Inspect the actual builder configuration and `internals/scripts/AfterPack.js` / `Notarize.js` before packaging. Do not run inherited publishing scripts or supply release credentials.

Use a private temporary directory outside the checkout, with restrictive permissions. In that directory create a temporary CommonJS configuration that imports `<PROJECT_ROOT>/electron-builder-config.js`, keeps its files and original native assets, and overrides only these local test options:

```js
const base = require('<PROJECT_ROOT>/electron-builder-config.js')();
module.exports = {
  ...base,
  forceCodeSigning: false,
  afterSign: null,
  electronDist: '<PROJECT_ROOT>/node_modules/electron/dist',
  directories: { output: __dirname + '/package' },
  mac: { ...base.mac, identity: null, target: 'dir' },
};
```

After substituting the placeholders, invoke existing tools from the project root:

```sh
yarn build
CSC_IDENTITY_AUTO_DISCOVERY=false ELECTRON_NOTARIZE=NO \
  XDG_CONFIG_HOME="<TEMP_DIR>/builder-config" \
  node_modules/.bin/electron-builder --config "<TEMP_DIR>/package-config.cjs" \
  --mac --arm64 --dir --publish never
```

This is a local exception to ordinary compilation-only validation. No checked-in signing, identity, publish or build configuration is changed. The output is `<TEMP_DIR>/package/mac-arm64/OpenMTP.app`; it must not replace an installed app. **Do not double-click it using the normal profile.** Merely changing Electron `userData` is insufficient: application settings derive from `os.homedir()` too. Use a reviewed launcher/bootstrap that isolates both main and renderer before production modules load. The T14 private smoke copy has device access denied and is unsuitable for physical transfers.

## Separate corrected-CLI test-build strategy

Before physical transfer testing, prepare and review a **separate local candidate**, preserving both the normal package and every checkout binary. Copy the normal package to a distinct private destination/name, then replace only that candidate's `Contents/Resources/bin/mtp-cli` with the reviewed external T11.4 executable. Verify SHA-256 `2dbc3c0ff469438d5ec97792924e54682b99d6f1ba42c4d5365593f550acb964`, executable permissions, x86_64 architecture, deployment target and required notices/source evidence. Record both original and candidate hashes. Do not replace `build/mac/bin/mtp-cli`, modify the selector allowlist or weaken preflight checks. Packaged apps ignore `OPENMTP_DEV_LEGACY_CLI`.

Use a reviewed private-profile bootstrap in both main and renderer, select Legacy explicitly, disable updates/analytics, and point local navigation only at disposable fixtures. Label this candidate experimental and unsigned. Validate its offline startup before authorizing USB access. This strategy was **not executed in T14**; the corrected native binary remains external and distribution is not cleared. An alternative is the existing unpackaged development-only override with the same verified executable and complete profile isolation.

## Disposable Mac fixture commands — do not run before test authorization

With the isolated toolchain selected, the following commands create only new disposable files. They do not access Android. Keep the printed workspace path in the private test log:

```sh
OPENMTP_ACCEPTANCE_ROOT=$(mktemp -d "${TMPDIR:-/private/tmp}/openmtp-acceptance-XXXXXX")
export OPENMTP_ACCEPTANCE_ROOT
python3 - <<'PYFIXTURE'
import os
from pathlib import Path
root = Path(os.environ['OPENMTP_ACCEPTANCE_ROOT'])
for name in ['source', 'source/nested', 'received', 'conflict']:
    (root / name).mkdir()
for name, data in [
    ('source/alpha.txt', b'OpenMTP disposable transfer acceptance\n'),
    ('source/sample.bin', bytes(range(256)) * 4096),
    ('source/nested/beta.txt', b'Nested disposable fixture\n'),
    ('conflict/alpha.txt', b'Different disposable conflict contents\n'),
]:
    with (root / name).open('xb') as stream:
        stream.write(data)
print(root)
PYFIXTURE
find "$OPENMTP_ACCEPTANCE_ROOT/source" -type f -exec stat -f '%z %N' {} \;
find "$OPENMTP_ACCEPTANCE_ROOT/source" -type f -exec shasum -a 256 {} \;
```

After the authorized round trip, compare complete relative file sets, sizes and hashes:

```sh
python3 - <<'PYCOMPARE'
import hashlib, os
from pathlib import Path
root = Path(os.environ['OPENMTP_ACCEPTANCE_ROOT'])
def inventory(directory):
    return {
        str(p.relative_to(directory)): (p.stat().st_size, hashlib.sha256(p.read_bytes()).hexdigest())
        for p in directory.rglob('*') if p.is_file()
    }
source, received = inventory(root / 'source'), inventory(root / 'received')
assert source and source == received, 'File set, byte size or SHA-256 mismatch'
print('Returned file set, sizes and SHA-256 match:', len(source), 'files')
PYCOMPARE
```

Keep the initial source hash listing too: a matching round trip alone cannot prove the original sources were preserved if their initial state was not recorded.

## Future disposable-file acceptance — not executed

These steps require a subsequent explicit physical-write authorization. Close competing MTP clients normally before connecting the unlocked AYN Thor in File Transfer mode; do not change USB settings automatically. Start only the reviewed isolated Legacy candidate/development launcher. Confirm storage identity and keep both panels in List view initially to avoid unrelated thumbnail requests.

1. Create a new private Mac fixture workspace with an unpredictable name using `mktemp -d`, outside personal directories. Create separate `source`, `received` and `conflict` subdirectories. Generate new small text and binary files, plus a nested folder, entirely in `source`. Record relative names, byte sizes and `shasum -a 256` for each source before testing. Do not use personal files or the designated personal Downloads directory.
2. Through the Phone panel create a uniquely named disposable Android directory, for example `OPENMTP-ACCEPTANCE-<random-id>`, **only after confirming that name is absent**. Record the selected storage and exact directory. Never reuse an existing directory or create a name by overwriting something.
3. **Mac → Android:** Copy multiple fixture files and the nested folder from `source`; navigate to the new Android workspace and Paste. Require conflict-free destination preflight. Record terminal transfer outcome, progress, listed destination sizes and any errors. Reaching 100% is insufficient. Recheck the original Mac source hashes and sizes; every source must remain present and unchanged.
4. **Android → Mac:** Copy those newly created Android test objects to the empty Mac `received` directory. Require terminal completion. Compare every returned file's relative name, byte count (`stat -f '%z'`) and SHA-256 with the original Mac source. This round trip validates returned bytes, not an independently measured Android filesystem hash. Check that Android source objects remain listed with unchanged sizes and names. Do not claim independent Android source hashes without separately authorized device-side tooling.
5. **Conflict refusal:** Copy the same disposable object into its existing test destination and cancel the conflict prompt. Verify the destination is unchanged. For a genuine same-name/different-content check, create another disposable Mac fixture in `conflict` and use the same test filename, then cancel when prompted. Do not approve replacement under this plan; actual overwrite acceptance requires explicit authorization limited to test copies. Destination lookup errors must block Paste.
6. **Cancellation:** Use a newly generated larger disposable fixture and a new empty destination. Cancel once after transfer starts. Record the reported cancelled/partial/unknown state; wait for actual native return or CLI close. Verify the source size/hash is unchanged. Inspect only destination metadata for residual partial data. Do not retry, overwrite, delete partial data, release an uncertain queue or switch backends in the same uncertain process. A very fast completed transfer is not a passed cancellation test.
7. Check clipboard persistence across navigation, multiple selection, independent List/Grid and existing same-endpoint Paste restrictions using only these fixtures. No Cut, Move or source deletion is part of this workflow. Thumbnail loading is a separate content-read permission; keep List mode unless the fixture image reads are explicitly included.
8. Quit normally after confirmed operation closure. Preserve logs and the disposable workspace. Do not run automatic cleanup or delete Android data; a later cleanup must verify harness ownership and have explicit permission.

Acceptance remains pending for both transfer directions, byte integrity, actual overwrite execution, cancellation, partial outcomes, older macOS/Intel runtime and broader devices. A successful metadata query or thumbnail does not prove general USB health. See [native limitations](KNOWN_LIMITATIONS.md), [provenance](NATIVE_PROVENANCE.md) and [publication status](PUBLICATION_PLAN.md).
