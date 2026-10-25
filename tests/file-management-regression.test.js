/* Mocked existing Rename/Delete/New Folder regression matrix; no device writes. */
const assert = require('assert');
const path = require('path');
const { promisify } = require('node:util');
const { StringDecoder } = require('node:string_decoder');
const { EventEmitter } = require('events');
const {
  load,
  enums,
  utils,
  checkIf,
  log,
  transferHelpers,
} = require('./transfer-reliability.test');

const tests = [];
const test = (name, run) => tests.push({ name, run });

function fixture(backend, fail = false) {
  const calls = [];
  const failure = fail
    ? Object.assign(new Error('Mock permission denied'), { code: 'EACCES' })
    : null;
  const queueModule = load('app/data/file-explorer/MtpOperationQueue.js', {});
  const common = {
    '../../../utils/log': { log },
    '../../../utils/funcs': utils,
    '../../../utils/checkIf': { checkIf },
    '../../../enums': enums,
    '../MtpOperationQueue': queueModule,
    '../transferResult': transferHelpers,
  };
  let source;

  if (backend === 'local') {
    const mod = load(
      'app/data/file-explorer/data-sources/FileExplorerLocalDataSource.js',
      {
        ...common,
        path,
        'node:util': { promisify },
        junk: { not: () => true },
        rimraf: (...args) => {
          calls.push({ operation: 'delete', args: args.slice(0, -1) });
          args[args.length - 1](failure);
        },
        mkdirp: async (file) => {
          calls.push({ operation: 'mkdir', file });
          if (failure) throw failure;
        },
        'macos-version': { isGreaterThanOrEqualTo: () => false },
        fs: {
          readdir() {
            throw Error('Unexpected listing');
          },
          existsSync() {
            throw Error('Unexpected exists');
          },
          statSync() {
            throw Error('Unexpected stat');
          },
          lstatSync() {
            throw Error('Unexpected lstat');
          },
          rename: (...args) => {
            calls.push({ operation: 'rename', args: args.slice(0, -1) });
            args[args.length - 1](failure);
          },
          readlink() {
            throw Error('Unexpected readlink');
          },
          realpathSync() {
            throw Error('Unexpected realpath');
          },
        },
        'lodash/find': () => {},
        '../../../utils/files': { pathUp: path.dirname },
        '../../../utils/date': { appDateFormat: String },
        '../../../constants/paths': { PATHS: {} },
        '../../../constants': { NODE_MAC_PERMISSIONS_MIN_OS: '0' },
      }
    );

    source = new mod.FileExplorerLocalDataSource();
  } else if (backend === 'legacy') {
    const mod = load(
      'app/data/file-explorer/data-sources/FileExplorerLegacyDataSource.js',
      {
        ...common,
        path,
        'lodash/find': () => {},
        child_process: {
          spawn() {
            throw Error('Transfer/content spawning forbidden');
          },
          execFile: (binary, command, settings, callback) => {
            assert.strictEqual(binary, '/mock/never-run-cli');
            assert.strictEqual(settings.shell, false);
            const child = new EventEmitter();

            calls.push({ operation: 'metadata mutation mock only', command });
            queueMicrotask(() => {
              callback(failure, '', failure ? 'permission denied' : '');
              child.emit('close', failure ? 1 : 0, null);
            });

            return child;
          },
        },
        'node:string_decoder': { StringDecoder },
        '../../../constants': { DEVICES_LABEL: { mtp: 'Phone' } },
        '../../../utils/files': {
          baseName: path.basename,
          getExtension: path.extname,
        },
        '../../../helpers/binaries': { mtpCliPath: '/mock/never-run-cli' },
        '../../../utils/date': { msToTime: String, unixTimestampNow: () => 1 },
      }
    );

    source = new mod.FileExplorerLegacyDataSource();
  } else {
    const fake = (operation, args) => {
      calls.push({ operation, args });

      return failure
        ? { data: null, error: failure, stderr: 'ErrorPermission' }
        : { data: true, error: null, stderr: null };
    };
    const mod = load(
      'app/data/file-explorer/data-sources/FileExplorerKalamDataSource.js',
      {
        ...common,
        child_process: {
          exec() {
            throw Error('Diagnostics forbidden');
          },
        },
        '../../../../ffi/kalam/src/Kalam': {
          Kalam: class {
            renameFile(args) {
              return fake('rename', args);
            }

            deleteFile(args) {
              return fake('delete', args);
            }

            makeDirectory(args) {
              return fake('mkdir', args);
            }
          },
        },
        '../../../helpers/settings': {
          getFilesPreprocessingBeforeTransferSetting: () => false,
        },
        '../../../utils/date': { msToTime: String },
        '../../../helpers/binaries': { kalamDebugReportCli: '/mock/never-run' },
      }
    );

    source = new mod.FileExplorerKalamDataSource();
  }

  return { source, calls, queue: queueModule.default };
}

for (const backend of ['local', 'legacy', 'kalam'])
  for (const fail of [false, true])
    for (const operation of ['renameFile', 'deleteFiles', 'makeDirectory']) {
      test(`${backend} existing ${operation} preserves ${
        fail ? 'error' : 'success'
      } handling`, async () => {
        const f = fixture(backend, fail);
        const args =
          operation === 'renameFile'
            ? { filePath: '/mock/old', newFilename: 'new', storageId: 1 }
            : operation === 'deleteFiles'
            ? { fileList: ['/mock/a'], storageId: 1 }
            : { filePath: '/mock/new-folder', storageId: 1 };
        const result = await f.source[operation](args);

        assert.strictEqual(
          result.data,
          fail ? (backend === 'kalam' ? null : false) : true
        );
        assert.strictEqual(Boolean(result.error || result.stderr), fail);
        assert.strictEqual(f.calls.length, 1);
        assert(!f.queue.active && f.queue.pending.length === 0);
        if (backend === 'local' && operation === 'renameFile')
          assert.deepStrictEqual(f.calls[0].args, ['/mock/old', '/mock/new']);
        if (backend === 'kalam')
          assert.strictEqual(f.calls[0].args.storageId, 1);
        if (backend === 'legacy')
          assert(f.calls[0].command.includes('storage 1'));
      });
    }

for (const backend of ['local', 'legacy'])
  test(`${backend} empty Delete performs no mutation`, async () => {
    const f = fixture(backend);
    const result = await f.source.deleteFiles({ fileList: [], storageId: 1 });

    assert(result.error);
    assert.strictEqual(f.calls.length, 0);
  });
(async () => {
  let passed = 0;

  await tests.reduce(async (previous, { name, run }) => {
    await previous;
    try {
      await run();
      passed += 1;
      console.info(`PASS ${name}`);
    } catch (e) {
      console.error(`FAIL ${name}`, e);
      process.exitCode = 1;
    }
  }, Promise.resolve());
  console.info(
    `${passed}/${tests.length} file management regression tests passed.`
  );
})();
