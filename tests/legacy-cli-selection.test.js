/* Offline only: never execute either native CLI. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { load } = require('./transfer-reliability.test');

const tests = [];
const test = (name, run) => tests.push({ name, run });
// Filesystem/hash responses are mocked here; real-byte verification is part
// of the separately gated integration harness, never a test-side CLI launch.
const bytes = Buffer.from('offline approved executable fixture');
const mockFs = {
  constants: fs.constants,
  realpathSync(value) {
    if (value.includes('missing')) throw new Error('ENOENT');

    return value.includes('symlink') ? '/resolved/other' : value;
  },
  lstatSync(value) {
    return { isFile: () => value !== '/private/tmp', size: bytes.length };
  },
  accessSync(value, mode) {
    assert.strictEqual(mode, fs.constants.X_OK);
    if (value.includes('non-executable')) throw new Error('EACCES');
  },
  readFileSync(value) {
    return value === candidate ? bytes : Buffer.from('unapproved');
  },
};
const { selectLegacyCli } = load('app/helpers/legacyCliSelection.js', {
  fs: mockFs,
  path,
  crypto: {
    createHash(algorithm) {
      assert.strictEqual(algorithm, 'sha256');

      return {
        update(value) {
          return {
            digest(encoding) {
              assert.strictEqual(encoding, 'hex');

              return value.equals(bytes)
                ? '7a2cffb42fb4ed3bf78cc485551e344a18985e92e7d7c11487bd29d682089081'
                : crypto.createHash(algorithm).update(value).digest(encoding);
            },
          };
        },
      };
    },
  },
});
const candidate = '/private/tmp/openmtp-reviewed-cli-fixture';
const original = path.resolve(__dirname, '../build/mac/bin/mtp-cli');
const select = (environment, packaged = false) =>
  selectLegacyCli({
    bundledPath: original,
    packaged,
    environment,
  });
const development = {
  NODE_ENV: 'development',
  OPENMTP_DEV_LEGACY_CLI: candidate,
};

test('Default selection preserves the bundled executable', () => {
  assert.strictEqual(select({ NODE_ENV: 'development' }), original);
});
test('Reviewed candidate selects by approved checksum without executing it', () => {
  assert.strictEqual(select(development), candidate);
});
test('Packaged build ignores even an invalid override', () => {
  assert.strictEqual(
    select({ ...development, OPENMTP_DEV_LEGACY_CLI: '/missing' }, true),
    original
  );
});
test('Production and test environments ignore the development override', () => {
  for (const NODE_ENV of ['production', 'test', undefined]) {
    assert.strictEqual(select({ ...development, NODE_ENV }), original);
  }
});
test('Missing executable fails without falling back silently', () => {
  assert.throws(
    () =>
      select({
        ...development,
        OPENMTP_DEV_LEGACY_CLI: '/private/tmp/openmtp-missing-cli-fixture',
      }),
    /ENOENT/
  );
});
test('Relative path is rejected', () => {
  assert.throws(
    () => select({ ...development, OPENMTP_DEV_LEGACY_CLI: 'relative/cli' }),
    /Invalid/
  );
});
test('Directory is rejected as an executable', () => {
  assert.throws(
    () => select({ ...development, OPENMTP_DEV_LEGACY_CLI: '/private/tmp' }),
    /file/
  );
});
test('An unapproved executable hash is rejected', () => {
  assert.throws(
    () => select({ ...development, OPENMTP_DEV_LEGACY_CLI: original }),
    /checksum/
  );
});

test('Symlink selection is rejected', () => {
  assert.throws(
    () =>
      select({
        ...development,
        OPENMTP_DEV_LEGACY_CLI: '/private/tmp/symlink-cli',
      }),
    /Invalid/
  );
});
test('Non-executable file is rejected', () => {
  assert.throws(
    () =>
      select({
        ...development,
        OPENMTP_DEV_LEGACY_CLI: '/private/tmp/non-executable',
      }),
    /EACCES/
  );
});

function binariesFixture(type, environment, packaged = false, response) {
  const handlers = new Map();
  const env = { ...environment };
  const mocks = {
    path,
    'macos-version': { is: () => false },
    electron: {
      app: { isPackaged: packaged },
      ipcMain: { on: (channel, handler) => handlers.set(channel, handler) },
      ipcRenderer: {
        sendSync: (...args) => {
          assert.deepStrictEqual(args, ['OPENMTP_LEGACY_EXECUTABLE']);

          return response;
        },
      },
    },
    './legacyCliSelection': { selectLegacyCli },
    '../utils/getPlatform': {
      getPlatform: () => 'mac',
      getBinariesSupportedSystemArchitecture: () => 'arm64',
    },
    '../constants/env': { IS_PROD: environment.NODE_ENV === 'production' },
    '../constants/paths': { PATHS: { root: path.resolve(__dirname, '..') } },
    '../utils/isPackaged': { isPackaged: packaged },
    '../constants': {
      KALAM_HISTORIC_MACOS_VERSION_RANGE: {},
      OS_ARCH_TYPE: { arm64: 'arm64' },
    },
    '../utils/funcs': { undefinedOrNull: (v) => v == null },
  };
  const result = load('app/helpers/binaries.js', mocks, {
    process: { type, env },
  });

  return { result, handlers, env };
}

test('Actual binaries helper keeps main selection fixed despite renderer arguments or environment changes', () => {
  const f = binariesFixture('browser', development);

  assert.strictEqual(f.result.mtpCliPath, candidate);
  f.env.OPENMTP_DEV_LEGACY_CLI = '/untrusted';
  const event = {};

  f.handlers.get('OPENMTP_LEGACY_EXECUTABLE')(event, '/untrusted', {
    NODE_ENV: 'development',
  });
  assert.strictEqual(event.returnValue.path, candidate);
});
test('Actual renderer helper uses main selection and ignores renderer override input', () => {
  const f = binariesFixture(
    'renderer',
    { ...development, OPENMTP_DEV_LEGACY_CLI: '/untrusted' },
    false,
    { path: candidate }
  );

  assert.strictEqual(f.result.mtpCliPath, candidate);
});
test('Missing main acknowledgement cannot silently run another CLI', () => {
  assert.throws(
    () => binariesFixture('renderer', development),
    /Missing main-process/
  );
});
test('Actual packaged main helper ignores development override', () => {
  const f = binariesFixture('browser', development, true);

  assert.strictEqual(f.result.mtpCliPath, original);
});
test('Validation failure is propagated through the fixed main response', () => {
  assert.throws(
    () =>
      binariesFixture('browser', {
        ...development,
        OPENMTP_DEV_LEGACY_CLI: original,
      }),
    /checksum/
  );
});

function main() {
  for (const { name, run } of tests) {
    run();
    console.info(`PASS ${name}`);
  }

  console.info(
    `${tests.length}/${tests.length} Legacy executable-selection tests passed`
  );
}

if (require.main === module) main();
