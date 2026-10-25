/* Run with Node 16: NODE_ENV=test node tests/transfer-reliability.test.js */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { StringDecoder } = require('node:string_decoder');
const babel = require('@babel/core');

const root = path.resolve(__dirname, '..');
const tests = [];
const test = (name, run) => tests.push({ name, run });
const ticks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
const enums = {
  DEVICE_TYPE: { local: 'local', mtp: 'mtp' },
  FILE_TRANSFER_DIRECTION: { upload: 'upload', download: 'download' },
  MTP_MODE: { kalam: 'kalam', legacy: 'legacy' },
};
const utils = {
  undefinedOrNull: (value) => value == null,
  isArray: Array.isArray,
  isEmpty: (value) => value == null || value === '' || value.length === 0,
  percentage: (sent, total) => (total ? (sent / total) * 100 : 0),
  splitIntoLines: (value) =>
    value == null ? null : String(value).split(/(\r?\n)/g),
};
const checkIf = (value, type) => {
  if (type === 'array') assert(Array.isArray(value));
  else assert.strictEqual(typeof value, type);
};
const log = { error() {} };
const compiled = new Map();

// There is deliberately no fallback require: an unmocked native, process, or
// application dependency fails the suite instead of loading the real backend.
function evaluate(code, mocks, globals = {}) {
  const module = { exports: {} };

  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    Buffer,
    ...globals,
    require(name) {
      assert(
        Object.prototype.hasOwnProperty.call(mocks, name),
        `Unmocked import: ${name}`
      );

      return mocks[name];
    },
  });

  return module.exports;
}

function load(relative, mocks, globals) {
  if (!compiled.has(relative)) {
    compiled.set(
      relative,
      babel.transformSync(fs.readFileSync(path.join(root, relative), 'utf8'), {
        configFile: false,
        babelrc: false,
        plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')],
      }).code
    );
  }

  return evaluate(compiled.get(relative), mocks, globals);
}

const { createTransferResult, createTransferFinalizer } = load(
  'app/data/file-explorer/transferResult.js',
  { '../../enums/mtpError': { MTP_ERROR: { ErrorGeneral: 'ErrorGeneral' } } }
);
const transferHelpers = { createTransferResult, createTransferFinalizer };
const queueModule = load('app/data/file-explorer/MtpOperationQueue.js', {});
const success = (backend) =>
  createTransferResult({
    status: 'completed',
    backend,
    direction: 'upload',
    backendStopped: true,
    evidence:
      backend === 'kalam'
        ? { nativeAcknowledged: true }
        : { exitCode: 0, signal: null },
  });
const failure = (status = 'failed', backend = 'kalam') =>
  createTransferResult({
    status,
    backend,
    direction: 'upload',
    backendStopped: true,
    error: 'Transfer interrupted',
    files:
      status === 'partial' ? { confirmedCompleted: ['/destination/a'] } : {},
  });
const envelope = (data, error = '', errorType = '') =>
  JSON.stringify({ data, error, errorType });

function notifications() {
  const completed = [];
  const errors = [];
  const progress = [];
  const preprocess = [];

  return {
    completed,
    errors,
    progress,
    preprocess,
    onCompleted: (value) => completed.push(value),
    onError: (value) => errors.push(value),
    onProgress: (value) => progress.push(value),
    onPreprocess: (value) => preprocess.push(value),
  };
}

function kalamFixture({
  registerFailure = 0,
  invocationThrows = false,
  cleanupThrows = false,
} = {}) {
  const registered = [];
  const released = [];
  let active = false;
  let invocation;
  const koffi = {
    proto: (value) => value,
    pointer: (value) => value,
    register(callback) {
      if (registered.length + 1 === registerFailure)
        throw new Error('Mock registration failure');
      registered.push(callback);

      return callback;
    },
    unregister(callback) {
      assert.strictEqual(
        active,
        false,
        'Callback released during native execution'
      );
      assert(!released.includes(callback), 'Callback released twice');
      released.push(callback);
      if (cleanupThrows) throw new Error('Mock cleanup failure');
    },
    load() {
      return {
        func(signature) {
          assert(
            /^(void UploadFiles|void DownloadFiles)/.test(signature),
            'Unexpected native operation'
          );

          return {
            async(...args) {
              if (invocationThrows)
                throw new Error('Mock FFI submission failure');
              invocation = args;
              active = true;
            },
          };
        },
      };
    },
  };
  const { Kalam } = load('ffi/kalam/src/Kalam.js', {
    koffi,
    '../../../app/helpers/binaries': { kalamLibPath: '/mock/never-load.dylib' },
    '../../../app/utils/log': { log },
    '../../../app/utils/funcs': utils,
    '../../../app/utils/checkIf': { checkIf },
    '../../../app/enums': enums,
    '../../../app/enums/mtpError': {
      MTP_ERROR: { ErrorGeneral: 'ErrorGeneral' },
    },
    '../../../app/data/file-explorer/transferResult': transferHelpers,
    '../../../app/data/file-explorer/MtpOperationQueue': queueModule,
  });
  const events = notifications();
  const promise = new Kalam().transferFiles({
    direction: 'upload',
    storageId: 1,
    sources: ['/source/a'],
    destination: '/destination',
    preprocessFiles: true,
    ...events,
  });

  return {
    events,
    promise,
    registered,
    released,
    preprocess: (payload) => invocation[1](payload),
    progress: (payload) => invocation[2](payload),
    done: (payload) => invocation[3](payload),
    returned(error = null) {
      active = false;
      invocation[4](error);
    },
  };
}

test('Kalam waits for native return after valid acknowledgement', async () => {
  const f = kalamFixture();
  let settled = false;
  const observed = f.promise
    .then(() => {
      settled = true;

      return true;
    })
    .catch(() => false);

  f.done(envelope(true));
  await ticks();
  assert.strictEqual(settled, false);
  assert.strictEqual(f.events.completed.length, 0);
  assert.strictEqual(f.released.length, 0);
  f.returned();
  const result = await f.promise;

  await observed;
  assert.strictEqual(result.status, 'completed');
  assert.strictEqual(result.data, true);
  assert.strictEqual(result.files.confirmedCompleted, null);
  assert.strictEqual(f.events.completed.length, 1);
  assert.strictEqual(f.released.length, 3);
});

test('Kalam native failure never calls successful completion', async () => {
  const f = kalamFixture();

  f.done(envelope(null, 'Storage is full', 'ErrorStorageFull'));
  assert.strictEqual(f.events.errors.length, 0);
  f.returned();
  const result = await f.promise;

  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.stderr, 'ErrorStorageFull');
  assert.strictEqual(f.events.errors.length, 1);
  assert.strictEqual(f.events.completed.length, 0);
});

test('Kalam duplicate success and native-return callbacks finalize once', async () => {
  const f = kalamFixture();

  f.done(envelope(true));
  f.done(envelope(true));
  f.returned();
  f.returned();
  await f.promise;
  f.done(envelope(null, 'late error', 'ErrorGeneral'));
  assert.strictEqual(f.events.completed.length, 1);
  assert.strictEqual(f.events.errors.length, 0);
  assert.strictEqual(f.released.length, 3);
});

for (const order of ['error-first', 'success-first']) {
  test(`Kalam conflicting callbacks retain failure (${order})`, async () => {
    const f = kalamFixture();

    if (order === 'success-first') f.done(envelope(true));
    f.done(envelope(null, 'Failed object', 'ErrorFileTransfer'));
    f.done(envelope(true));
    f.returned();
    assert.strictEqual((await f.promise).status, 'failed');
    assert.strictEqual(f.events.errors.length, 1);
    assert.strictEqual(f.events.completed.length, 0);
  });
}

for (const channel of ['progress', 'preprocess']) {
  test(`Kalam ${channel} failure survives a later successful done callback`, async () => {
    const f = kalamFixture();

    f[channel](envelope(null, 'Read failure', 'ErrorFileTransfer'));
    f.done(envelope(true));
    f.returned();
    assert.strictEqual((await f.promise).status, 'failed');
    assert.strictEqual(f.events.completed.length, 0);
  });
}

for (const payload of [
  '{',
  'null',
  '[]',
  '{}',
  envelope(false),
  envelope(null),
  JSON.stringify({ data: true }),
]) {
  test(`Kalam rejects malformed or unacknowledged result: ${payload}`, async () => {
    const f = kalamFixture();

    assert.doesNotThrow(() => f.done(payload));
    f.done(envelope(true));
    f.returned();
    assert.strictEqual((await f.promise).status, 'unknown');
    assert.strictEqual(f.events.errors.length, 1);
    assert.strictEqual(f.events.completed.length, 0);
  });
}

test('Kalam FFI return without native acknowledgement remains unknown', async () => {
  const f = kalamFixture();

  f.returned();
  assert.strictEqual((await f.promise).status, 'unknown');
  assert.strictEqual(f.events.completed.length, 0);
});

test('Kalam FFI error overrides native success and reaches error callback', async () => {
  const f = kalamFixture();

  f.done(envelope(true));
  f.returned(new Error('Mock FFI failure'));
  const result = await f.promise;

  assert.strictEqual(result.status, 'unknown');
  assert.strictEqual(result.stderr, 'ErrorGeneral');
  assert.strictEqual(f.events.errors.length, 1);
  assert.strictEqual(f.events.completed.length, 0);
});

for (const options of [
  { registerFailure: 2 },
  { invocationThrows: true },
  { cleanupThrows: true },
]) {
  test(`Kalam callback resource safety: ${JSON.stringify(
    options
  )}`, async () => {
    const f = kalamFixture(options);

    if (options.cleanupThrows) {
      f.done(envelope(true));
      f.returned();
    }

    const result = await f.promise;

    assert.notStrictEqual(result.status, 'completed');
    assert.strictEqual(f.released.length, f.registered.length);
    assert.strictEqual(f.events.errors.length, 1);
  });
}

test('Kalam repeated progress does not prove individual-file success', async () => {
  const f = kalamFixture();

  f.progress(
    envelope({ fullPath: '/source/a', filesSent: 1, filesSentProgress: 100 })
  );
  f.progress(
    envelope({ fullPath: '/source/a', filesSent: 1, filesSentProgress: 100 })
  );
  f.returned();
  const result = await f.promise;

  assert.strictEqual(f.events.progress.length, 2);
  assert.strictEqual(result.status, 'unknown');
  assert.strictEqual(result.files.confirmedCompleted, null);
});

function legacyFixture({ spawnThrows = false } = {}) {
  const child = new EventEmitter();

  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const timers = new Map();
  const calls = [];
  const events = notifications();
  const { FileExplorerLegacyDataSource } = load(
    'app/data/file-explorer/data-sources/FileExplorerLegacyDataSource.js',
    {
      path,
      'node:util': {
        promisify: () => () => {
          throw new Error('Unexpected exec');
        },
      },
      'node:string_decoder': { StringDecoder },
      'lodash/find': () => {},
      child_process: {
        exec() {
          throw new Error('Unexpected exec');
        },
        spawn(...args) {
          calls.push(args);
          if (spawnThrows) throw new Error('Mock spawn failure');

          return child;
        },
      },
      '../../../utils/log': { log },
      '../../../utils/funcs': utils,
      '../../../constants': {
        DEVICES_LABEL: { mtp: 'Phone', local: 'Computer' },
      },
      '../../../enums': enums,
      '../../../utils/files': {
        baseName: path.basename,
        getExtension: () => '',
      },
      '../../../helpers/binaries': { mtpCliPath: '/mock/never-execute' },
      '../../../utils/date': {
        msToTime: (value) => String(value),
        unixTimestampNow: () => 1000,
      },
      '../../../utils/checkIf': { checkIf },
      '../transferResult': transferHelpers,
      '../MtpOperationQueue': queueModule,
    },
    {
      setInterval(fn) {
        const id = timers.size + 1;

        timers.set(id, fn);

        return id;
      },
      clearInterval(id) {
        timers.delete(id);
      },
    }
  );
  const source = new FileExplorerLegacyDataSource();

  return {
    child,
    events,
    timers,
    calls,
    source,
    start: () =>
      source._transferFiles({
        cmdArgs: ['unchanged'],
        direction: 'upload',
        fileList: ['/source/a'],
        ...events,
      }),
    tick: () => timers.forEach((fn) => fn()),
    stdout: (value) => child.stdout.emit('data', Buffer.from(value)),
    stderr: (value) => child.stderr.emit('data', Buffer.from(value)),
  };
}

test('Legacy resolves only after close, including drained stderr', async () => {
  const f = legacyFixture();
  let settled = false;
  const promise = f.start();
  const observed = promise
    .then(() => {
      settled = true;

      return true;
    })
    .catch(() => false);

  f.child.emit('exit', 0, null);
  await ticks();
  assert.strictEqual(settled, false);
  f.stderr('late transfer failure');
  f.child.emit('close', 0, null);
  assert.strictEqual((await promise).status, 'failed');
  await observed;
  assert.strictEqual(f.events.completed.length, 0);
  assert.strictEqual(f.events.errors.length, 1);
  assert.strictEqual(f.timers.size, 0);
});

test('Legacy success is emitted exactly once after clean close', async () => {
  const f = legacyFixture();
  const promise = f.start();

  f.child.emit('exit', 0, null);
  assert.strictEqual(f.events.completed.length, 0);
  f.child.emit('close', 0, null);
  f.child.emit('close', 0, null);
  const result = await promise;

  assert.strictEqual(result.status, 'completed');
  assert.strictEqual(result.files.confirmedCompleted, null);
  assert.strictEqual(f.events.completed.length, 1);
  assert.strictEqual(f.timers.size, 0);
});

for (const [code, signal, expected] of [
  [7, null, 'failed'],
  [null, 'SIGTERM', 'unknown'],
  [null, null, 'unknown'],
]) {
  test(`Legacy exit ${code}/${signal} cannot report success`, async () => {
    const f = legacyFixture();
    const promise = f.start();

    f.stdout(':progress /source/a 100 100\n');
    f.tick();
    f.child.emit('exit', code, signal);
    f.child.emit('close', code, signal);
    const result = await promise;

    assert.strictEqual(result.status, expected);
    assert.strictEqual(result.data, false);
    assert.strictEqual(f.events.completed.length, 0);
    assert.strictEqual(f.events.errors.length, 1);
    assert.strictEqual(result.files.confirmedCompleted, null);
  });
}

test('Legacy zero close cannot overwrite a recorded nonzero exit', async () => {
  const f = legacyFixture();
  const promise = f.start();

  f.child.emit('exit', 4, null);
  f.child.emit('close', 0, null);
  assert.strictEqual((await promise).status, 'failed');
});

test('Legacy asynchronous spawn errors wait for close and notify once', async () => {
  const f = legacyFixture();
  const promise = f.start();

  assert.doesNotThrow(() => f.child.emit('error', new Error('ENOENT')));
  assert.strictEqual(f.events.errors.length, 0);
  f.child.emit('close', -2, null);
  assert.strictEqual((await promise).status, 'failed');
  assert.strictEqual(f.events.errors.length, 1);
});

test('Legacy synchronous spawn failure cleans up and reports an error', async () => {
  const f = legacyFixture({ spawnThrows: true });

  assert.strictEqual((await f.start()).status, 'failed');
  assert.strictEqual(f.events.errors.length, 1);
  assert.strictEqual(f.timers.size, 0);
});

test('Legacy preserves split UTF-8 stderr and does not filter partial lines', async () => {
  const f = legacyFixture();
  const promise = f.start();
  const text = Buffer.from('permission denied: café\n');
  const split = text.indexOf(0xc3) + 1;

  f.child.stderr.emit('data', text.subarray(0, split));
  f.child.stderr.emit('data', text.subarray(split));
  f.child.emit('close', 0, null);
  const result = await promise;

  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.error, 'permission denied: café');
});

test('Legacy preserves split stdout records and keeps the last unterminated line', async () => {
  const f = legacyFixture();
  const promise = f.start();

  f.stdout(':progr');
  f.tick();
  assert.strictEqual(f.events.progress.length, 0);
  f.stdout('ess /source/a file 25 100\r\n:progress /source/b 50 100\n');
  f.tick();
  assert.strictEqual(f.events.progress[0].currentFile, '/source/b');
  assert.strictEqual(f.events.progress[0].activeFileProgress, 50);
  f.stdout(':progress /source/b 100 100');
  f.child.emit('close', 7, null);
  assert.strictEqual((await promise).status, 'failed');
});

test('Legacy discovery diagnostics remain unknown across chunk boundaries', async () => {
  const f = legacyFixture();
  const promise = f.start();

  f.stderr('Device::Fi');
  f.stderr('nd failed\n');
  f.child.emit('close', 0, null);
  const result = await promise;

  assert.strictEqual(result.status, 'unknown');
  assert.strictEqual(result.stderr, 'Device::Find failed');
});

for (const direction of ['upload', 'download']) {
  test(`Legacy ${direction} uses literal CLI arguments without a shell`, async () => {
    const f = legacyFixture();
    const promise = f.source.transferFiles({
      destination: '/destination',
      fileList: ['/source/a'],
      direction,
      storageId: 1,
      ...f.events,
    });
    const expected =
      direction === 'upload'
        ? 'put "/source/a" "/destination"'
        : 'get "/source/a" "/destination/a"';

    assert.strictEqual(f.calls[0][0], '/mock/never-execute');
    assert.deepStrictEqual(Array.from(f.calls[0][1]), [
      '-e',
      'storage 1',
      expected,
    ]);
    assert.strictEqual(f.calls[0][2].shell, false);
    f.child.emit('close', 0, null);
    assert.strictEqual((await promise).status, 'completed');
  });
}

test('Result contract requires acknowledgement and confirmed partial evidence', () => {
  for (const status of [
    'failed',
    'partial',
    'cancelled',
    'unknown',
    'invalid',
  ]) {
    assert.strictEqual(createTransferResult({ status }).data, false);
  }

  assert.strictEqual(
    createTransferResult({ status: 'completed', backend: 'kalam' }).status,
    'unknown'
  );
  assert.strictEqual(failure('partial').status, 'partial');
  assert.strictEqual(
    createTransferResult({ status: 'cancelled', backendStopped: true }).status,
    'unknown'
  );
  assert.strictEqual(
    createTransferResult({
      status: 'cancelled',
      backendStopped: true,
      evidence: { cancellationAcknowledged: true },
    }).status,
    'cancelled'
  );
  assert.strictEqual(success('kalam').destinationMayContainPartialData, true);
});

test('Malformed result metadata remains uncertain without throwing', () => {
  assert.strictEqual(createTransferResult(null).status, 'unknown');
  assert.strictEqual(
    createTransferResult({
      status: 'completed',
      backend: 'kalam',
      evidence: null,
      files: null,
    }).status,
    'unknown'
  );
});

for (const scenario of [
  'success',
  'invalid-destination',
  'empty-source',
  'rejection',
]) {
  test(`Kalam data-source adapter normalizes ${scenario}`, async () => {
    let invoked = false;
    const events = notifications();
    const { FileExplorerKalamDataSource } = load(
      'app/data/file-explorer/data-sources/FileExplorerKalamDataSource.js',
      {
        child_process: {
          exec() {
            throw new Error('Unexpected exec');
          },
        },
        'node:util': { promisify: () => () => {} },
        '../../../utils/log': { log },
        '../../../../ffi/kalam/src/Kalam': {
          Kalam: function MockKalam() {
            return {
              async transferFiles(args) {
                invoked = true;
                if (scenario === 'rejection')
                  throw new Error('Mock bridge rejection');
                const result = success('kalam');

                args.onCompleted(result);

                return result;
              },
            };
          },
        },
        '../../../utils/checkIf': { checkIf },
        '../../../utils/funcs': utils,
        '../../../helpers/settings': {
          getFilesPreprocessingBeforeTransferSetting: () => true,
        },
        '../../../utils/date': { msToTime: () => '' },
        '../../../helpers/binaries': {
          kalamDebugReportCli: '/mock/never-execute',
        },
        '../transferResult': transferHelpers,
        '../MtpOperationQueue': queueModule,
      }
    );
    const result = await new FileExplorerKalamDataSource().transferFiles({
      deviceType: 'mtp',
      destination: scenario === 'invalid-destination' ? '' : '/destination',
      fileList: scenario === 'empty-source' ? [] : ['/source/a'],
      direction: 'upload',
      storageId: 1,
      ...events,
    });

    assert.strictEqual(
      result.status,
      scenario === 'success'
        ? 'completed'
        : scenario === 'rejection'
        ? 'unknown'
        : 'failed'
    );
    assert.strictEqual(events.completed.length, scenario === 'success' ? 1 : 0);
    assert.strictEqual(events.errors.length, scenario === 'success' ? 0 : 1);
    assert.strictEqual(invoked, ['success', 'rejection'].includes(scenario));
  });
}

test('Consumer exceptions cannot duplicate finalization or change backend success', () => {
  let notificationsCount = 0;
  const finalize = createTransferFinalizer({
    onCompleted() {
      notificationsCount += 1;
      throw new Error('UI exception');
    },
    onError() {
      throw new Error('Unexpected failure');
    },
  });

  assert.strictEqual(finalize(success('kalam')), true);
  assert.strictEqual(finalize(failure()), false);
  assert.strictEqual(notificationsCount, 1);
});

function controllerFixture(returned, callbacks = () => {}) {
  const events = [];
  const notices = notifications();
  const controller = load(
    'app/data/file-explorer/controllers/FileExplorerController.js',
    {
      path,
      '../repositories/FileExplorerRepository': {
        FileExplorerRepository: class {
          async filesExist() {
            return true;
          }

          async transferFiles(args) {
            callbacks(args);

            return returned;
          }
        },
      },
      '../../../utils/checkIf': { checkIf },
      '../../../services/analytics': {
        analyticsService: {
          sendEvent: (name, data) => {
            events.push({ name, data });
          },
        },
      },
      '../../../enums/events': {
        EVENT_TYPE: {
          MTP_TRANSFER_FILES_SUCCESS: 'success',
          MTP_TRANSFER_FILES_ERROR: 'error',
        },
      },
      '../../../helpers/processBufferOutput': {},
      '../../../helpers/settings': { getMtpModeSetting: () => 'kalam' },
      '../../../enums': enums,
      '../../../utils/date': { unixTimestampNow: () => 1 },
      '../../../utils/log': { log },
      '../transferResult': transferHelpers,
    }
  ).default;

  return {
    events,
    notices,
    run: () =>
      controller.transferFiles({
        deviceType: 'mtp',
        destination: '/destination',
        direction: 'upload',
        storageId: 1,
        fileList: ['/source/a'],
        ...notices,
      }),
  };
}

for (const result of [
  success('kalam'),
  failure(),
  failure('partial'),
  failure('unknown'),
  createTransferResult({
    status: 'cancelled',
    backend: 'kalam',
    backendStopped: true,
    evidence: { cancellationAcknowledged: true },
  }),
  undefined,
]) {
  test(`Controller telemetry reflects only normalized terminal status: ${result?.status}`, async () => {
    const f = controllerFixture(result);
    const value = await f.run();

    assert.strictEqual(f.events.length, 1);
    assert.strictEqual(
      f.events[0].name,
      value.status === 'completed' ? 'success' : 'error'
    );
    assert.strictEqual(
      f.notices.completed.length,
      value.status === 'completed' ? 1 : 0
    );
    assert.strictEqual(
      f.notices.errors.length,
      value.status === 'completed' ? 0 : 1
    );
  });
}

test('Controller preserves callback failure over a conflicting returned success', async () => {
  const f = controllerFixture(success('kalam'), (args) => {
    args.onError(failure());
    args.onCompleted(success('kalam'));
    args.onError(failure());
  });

  assert.strictEqual((await f.run()).status, 'failed');
  assert.strictEqual(f.notices.errors.length, 1);
  assert.strictEqual(f.notices.completed.length, 0);
  assert.strictEqual(f.events[0].name, 'error');
});

const uiSource = fs.readFileSync(
  path.join(root, 'app/containers/HomePage/components/FileExplorer.jsx'),
  'utf8'
);
const uiAst = babel.parseSync(uiSource, {
  configFile: false,
  babelrc: false,
  parserOpts: { plugins: ['jsx', 'classProperties'] },
});
const mapDeclaration = uiAst.program.body
  .find(
    (node) =>
      node.type === 'VariableDeclaration' &&
      node.declarations.some(
        (declaration) => declaration.id.name === 'mapDispatchToProps'
      )
  )
  .declarations.find((node) => node.id.name === 'mapDispatchToProps');
const uiMapCode = `module.exports = (${uiSource.slice(
  mapDeclaration.init.start,
  mapDeclaration.init.end
)});`;

function uiFixture(
  behavior,
  {
    windowThrows = false,
    scopeCurrent = () => true,
    scopeCapture = () => ({ generation: 1 }),
  } = {}
) {
  const originalClipboard = { queue: ['/source/a'], source: 'local' };
  const state = {
    Settings: {
      mtpMode: 'kalam',
      filesPreprocessingBeforeTransfer: { upload: true },
    },
    Home: {
      currentBrowsePath: { mtp: '/destination', local: '/destination' },
      fileTransfer: {
        clipboard: originalClipboard,
        progress: { toggle: true },
      },
    },
  };
  const actions = [];
  const events = [];
  const windowProgress = [];
  const dispatch = (action) => {
    actions.push(action);
    if (action.type === 'clear')
      state.Home.fileTransfer = {
        clipboard: { queue: [] },
        progress: { toggle: false },
      };
    if (action.type === 'progress')
      state.Home.fileTransfer.progress = action.payload;
  };
  const map = evaluate(
    uiMapCode,
    {},
    {
      bindActionCreators: (creators) => creators,
      createTransferResult,
      // Mock the renderer UI revision, not IPC/native cleanup evidence.
      captureMtpScope: scopeCapture,
      isCurrentMtpScope: scopeCurrent,
      DEVICE_TYPE: enums.DEVICE_TYPE,
      FILE_TRANSFER_DIRECTION: enums.FILE_TRANSFER_DIRECTION,
      MTP_MODE: enums.MTP_MODE,
      EVENT_TYPE: {
        FILE_TRANSFER_STARTED: 'started',
        FILE_TRANSFER_ERROR: 'error',
        FILE_TRANSFER_COMPLETED: 'completed',
      },
      analyticsService: {
        sendEvent: (name, data) => events.push({ name, data }),
      },
      fileExplorerController: { transferFiles: (args) => behavior(args) },
      getCurrentWindow: () => ({
        setProgressBar(value) {
          if (windowThrows) throw new Error('Window unavailable');
          windowProgress.push(value);
        },
      }),
      setFileTransferProgress: (payload) => ({ type: 'progress', payload }),
      clearFileTransfer: () => ({ type: 'clear' }),
      listDirectory: () => ({ type: 'refresh' }),
      throwAlert: (payload) => ({ type: 'alert', payload }),
      log,
      arrayAverage: () => 0,
    }
  );
  const run = () =>
    map(dispatch).actionCreatePaste(
      {
        destinationFolder: '/destination',
        storageId: 1,
        fileTransferClipboard: originalClipboard,
      },
      { filePath: '/destination', ignoreHidden: false },
      'mtp'
    )(dispatch, () => state);

  return { state, actions, events, originalClipboard, windowProgress, run };
}

for (const status of ['failed', 'partial', 'unknown', 'cancelled']) {
  test(`UI ${status} closes progress once, preserves clipboard, and never refreshes/deletes`, async () => {
    const result =
      status === 'cancelled'
        ? createTransferResult({
            status,
            backend: 'kalam',
            backendStopped: true,
            evidence: { cancellationAcknowledged: true },
          })
        : failure(status);
    const f = uiFixture(async (args) => {
      args.onError(result);
      args.onError(result);
      args.onCompleted(success('kalam'));
      args.onProgress({});
      args.onPreprocess({});

      return result;
    });

    await f.run();
    assert.strictEqual(f.state.Home.fileTransfer.progress.toggle, false);
    assert.strictEqual(
      f.state.Home.fileTransfer.clipboard,
      f.originalClipboard
    );
    assert.strictEqual(
      f.actions.filter((action) => action.type === 'progress').length,
      1
    );
    assert.strictEqual(
      f.actions.filter((action) => action.type === 'alert').length,
      1
    );
    assert.strictEqual(
      f.events.filter((event) => event.name === 'completed').length,
      0
    );
    assert.strictEqual(
      f.events.filter((event) => event.name === 'error').length,
      1
    );
    assert(
      f.actions.every((action) => ['progress', 'alert'].includes(action.type)),
      'Unexpected refresh, deletion, or state clearing'
    );
  });
}

test('UI success retains clipboard clearing and one destination refresh', async () => {
  const f = uiFixture(async (args) => {
    args.onCompleted(success('kalam'));
    args.onCompleted(success('kalam'));
    args.onError(failure());
    args.onProgress({});

    return success('kalam');
  });

  await f.run();
  assert.strictEqual(
    f.actions.filter((action) => action.type === 'clear').length,
    1
  );
  assert.strictEqual(
    f.actions.filter((action) => action.type === 'refresh').length,
    1
  );
  assert.strictEqual(
    f.events.filter((event) => event.name === 'completed').length,
    1
  );
  assert.strictEqual(f.state.Home.fileTransfer.clipboard.queue.length, 0);
});

test('UI rejects completion without a normalized successful result', async () => {
  const f = uiFixture(async (args) => {
    args.onCompleted();
  });

  await f.run();
  assert.strictEqual(f.state.Home.fileTransfer.progress.toggle, false);
  assert.strictEqual(f.state.Home.fileTransfer.clipboard, f.originalClipboard);
  assert.strictEqual(
    f.events.filter((event) => event.name === 'completed').length,
    0
  );
});

test('UI rejects a null completion result and closes progress', async () => {
  const f = uiFixture(async (args) => {
    args.onCompleted(null);
  });

  await f.run();
  assert.strictEqual(f.state.Home.fileTransfer.progress.toggle, false);
  assert.strictEqual(f.state.Home.fileTransfer.clipboard, f.originalClipboard);
});

test('UI handles a rejected transfer promise and unavailable window without losing clipboard', async () => {
  const f = uiFixture(
    async () => {
      throw new Error('Disconnected');
    },
    { windowThrows: true }
  );

  await f.run();
  assert.strictEqual(f.state.Home.fileTransfer.progress.toggle, false);
  assert.strictEqual(f.state.Home.fileTransfer.clipboard, f.originalClipboard);
  assert.strictEqual(
    f.actions.filter((action) => action.type === 'alert').length,
    1
  );
});

async function runRegressionTests() {
  let passed = 0;

  await tests.reduce(async (previous, { name, run }) => {
    await previous;

    try {
      await run();
      passed += 1;
      console.info(`PASS ${name}`);
    } catch (error) {
      console.error(`FAIL ${name}`, error);
      process.exitCode = 1;
    }

    return true;
  }, Promise.resolve());

  console.info(`${passed}/${tests.length} transfer reliability tests passed.`);
}

if (require.main === module) {
  runRegressionTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

// Shared mock-only loader/fixtures for the serialization suite. Importing this
// module registers the baseline cases but does not run them or load a backend.
module.exports = {
  load,
  enums,
  utils,
  checkIf,
  log,
  transferHelpers,
  queueModule,
  envelope,
  notifications,
  legacyFixture,
  uiFixture,
};
