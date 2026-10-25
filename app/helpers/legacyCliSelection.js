import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// Reviewed T11.3 prototype and T11.4 rebuild of the same pinned native source.
// This is a development experiment, not a distribution mechanism.
const developmentHashes = new Set([
  '7a2cffb42fb4ed3bf78cc485551e344a18985e92e7d7c11487bd29d682089081',
  '2dbc3c0ff469438d5ec97792924e54682b99d6f1ba42c4d5365593f550acb964',
]);

export function selectLegacyCli({ bundledPath, packaged, environment }) {
  const override = environment.OPENMTP_DEV_LEGACY_CLI;

  if (packaged || environment.NODE_ENV !== 'development' || !override) {
    return bundledPath;
  }

  if (
    !path.isAbsolute(override) ||
    path.normalize(override) !== override ||
    fs.realpathSync(override) !== override
  ) {
    throw new Error('Invalid development Legacy executable path.');
  }

  const stat = fs.lstatSync(override);

  if (!stat.isFile() || stat.size === 0 || stat.size > 16 * 1024 * 1024) {
    throw new Error('Invalid development Legacy executable file.');
  }

  fs.accessSync(override, fs.constants.X_OK);
  const hash = crypto
    .createHash('sha256')
    .update(fs.readFileSync(override))
    .digest('hex');

  if (!developmentHashes.has(hash)) {
    throw new Error('Unrecognized development Legacy executable checksum.');
  }

  return override;
}
