import path from 'path';
import macosVersion from 'macos-version';
import { app, ipcMain, ipcRenderer } from 'electron';
import { selectLegacyCli } from './legacyCliSelection';
import {
  getPlatform,
  getBinariesSupportedSystemArchitecture,
} from '../utils/getPlatform';
import { IS_PROD } from '../constants/env';
import { PATHS } from '../constants/paths';
import { isPackaged } from '../utils/isPackaged';
import {
  KALAM_HISTORIC_MACOS_VERSION_RANGE,
  KALAM_MODE_MIN_MACOS_VERSION,
  KALAM_SEG5_MACOS_VERSION_RANGE,
  OS_ARCH_TYPE,
} from '../constants';
import { undefinedOrNull } from '../utils/funcs';

const { root } = PATHS;

const binariesPath = ({ includeArchDirectory = true }) => {
  const isPackagedBuild = IS_PROD && isPackaged;
  const debugBinDir = path.join(root, './build', getPlatform(), './bin');

  let historicBinaryVersionName;

  for (const [key, value] of Object.entries(
    KALAM_HISTORIC_MACOS_VERSION_RANGE
  )) {
    if (macosVersion.is(value)) {
      historicBinaryVersionName = key;
      break;
    }
  }

  const doesCurrentOsSupportLatestBinaries = undefinedOrNull(
    historicBinaryVersionName
  );

  let binariesArchDir;

  if (doesCurrentOsSupportLatestBinaries) {
    binariesArchDir = getBinariesSupportedSystemArchitecture();
  } else {
    binariesArchDir = path.join(
      historicBinaryVersionName,
      getBinariesSupportedSystemArchitecture()
    );
  }

  /// release build binaries path
  if (isPackagedBuild) {
    const packagedBinDir = path.join(
      root,
      './Contents',
      './Resources',
      './bin'
    );

    /// if [includeArchDirectory] is true then dont include the architecture directories
    if (!includeArchDirectory) {
      return packagedBinDir;
    }

    return path.join(packagedBinDir, binariesArchDir);
  }

  /// debug build binaries path

  /// if [includeArchDirectory] is true then dont include the architecture directories
  if (!includeArchDirectory) {
    return debugBinDir;
  }

  return path.join(debugBinDir, binariesArchDir);
};

const shouldUseKalamSeg5Binaries = () =>
  getPlatform() === 'mac' &&
  getBinariesSupportedSystemArchitecture() === OS_ARCH_TYPE.arm64 &&
  macosVersion.is(KALAM_SEG5_MACOS_VERSION_RANGE);

const bundledMtpCliPath = path.resolve(
  path.join(binariesPath({ includeArchDirectory: false }), './mtp-cli')
);

// Only the main process reads launch configuration. The renderer can ask for
// the fixed selection, but cannot supply a path, checksum or environment.
const legacySelectionChannel = 'OPENMTP_LEGACY_EXECUTABLE';
const legacySelection = (() => {
  if (process.type === 'renderer') {
    return ipcRenderer.sendSync(legacySelectionChannel);
  }

  try {
    return {
      path: selectLegacyCli({
        bundledPath: bundledMtpCliPath,
        packaged: app.isPackaged,
        environment: { ...process.env },
      }),
    };
  } catch (error) {
    return { error: error.message };
  }
})();

if (process.type === 'browser') {
  ipcMain.on(legacySelectionChannel, (event) => {
    const responseEvent = event;

    responseEvent.returnValue = legacySelection;
  });
}

if (!legacySelection?.path) {
  throw new Error(
    legacySelection?.error || 'Missing main-process Legacy selection.'
  );
}

export const mtpCliPath = legacySelection.path;

export const kalamDebugReportCli = path.resolve(
  path.join(
    binariesPath({ includeArchDirectory: true }),
    shouldUseKalamSeg5Binaries()
      ? './kalam_debug_report-seg5'
      : './kalam_debug_report'
  )
);

export const kalamLibPath = path.resolve(
  path.join(
    binariesPath({ includeArchDirectory: true }),
    shouldUseKalamSeg5Binaries() ? './kalam-seg5.dylib' : './kalam.dylib'
  )
);

// We have now officially retired the support for `Kalam` Kernel on macOS 10.13 (OS X El High Sierra) and lower. Only the "Legacy" MTP mode will continue working on these outdated machines.
export function isKalamModeSupported() {
  return macosVersion.is(KALAM_MODE_MIN_MACOS_VERSION);
}
