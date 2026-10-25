/* Run with Node 16: NODE_ENV=test node tests/mtp-serialization.test.js */
const assert = require('assert');
const path = require('path');
const { EventEmitter } = require('events');
const { StringDecoder } = require('node:string_decoder');
const {
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
} = require('./transfer-reliability.test');

const tests = [];
const test = (name, run) => tests.push({ name, run });
// Drain microtasks without clocks, device I/O, or a production timeout policy.
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function settled(promise) {
  let done = false;
  const observed = promise.then((value) => {
    done = true;

    return value;
  });

  await flush();
  assert(done, 'Expected operation to settle; possible nested acquisition');

  return observed;
}

function nativeFixture({
  submissionThrows = false,
  lookupThrows = false,
  registrationThrows = false,
} = {}) {
  const calls = [];
  const registered = new Set();
  const released = new Set();
  const evidence = [];
  let lookupFailure = lookupThrows;
  const koffi = {
    proto: (value) => value,
    pointer: (value) => value,
    register(callback) {
      if (registrationThrows) throw new Error('Mock callback setup failed');
      registered.add(callback);

      return callback;
    },
    unregister(callback) {
      assert(!released.has(callback), 'Callback released twice');
      assert(
        calls.every((call) => call.ended || !call.args.includes(callback)),
        'Callback released before native return'
      );
      released.add(callback);
    },
    load() {
      return {
        func(signature) {
          if (lookupFailure) throw new Error('Mock lookup failed');

          return {
            async(...args) {
              if (submissionThrows) throw new Error('Mock submission failed');
              assert(
                calls.every((call) => call.ended),
                'Native overlap'
              );
              calls.push({
                name: signature.split(/[ (]/)[1],
                args,
                ended: false,
              });
            },
          };
        },
      };
    },
  };
  const { Kalam } = load('ffi/kalam/src/Kalam.js', {
    koffi,
    '../../../app/helpers/binaries': { kalamLibPath: '/mock/never-load' },
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
  const result = (call, payload = envelope(true)) =>
    call.args[call.args.length - 2](payload);
  const returned = (call, error = null) => {
    Object.assign(call, { ended: true });
    call.args[call.args.length - 1](error);
  };

  return {
    Kalam,
    source: new Kalam({
      executionHooks: () => ({
        onLifecycleEvidence: (value) => evidence.push(value),
      }),
    }),
    calls,
    registered,
    released,
    evidence,
    allowLookup: () => {
      lookupFailure = false;
    },
    result,
    returned,
  };
}

const listing = (source) =>
  source.walk({ storageId: 1, fullPath: '/', skipHiddenFiles: false });
const transfer = (source, events = notifications(), direction = 'upload') =>
  source.transferFiles({
    direction,
    storageId: 1,
    sources: ['/mock/a'],
    destination: '/mock/destination',
    preprocessFiles: true,
    ...events,
  });

async function complete(f, call = f.calls[f.calls.length - 1]) {
  f.result(call);
  f.returned(call);
  await flush();
}

function processFixture(Kalam = class {}) {
  const calls = [];
  const exec = (command, callback) => {
    assert(
      calls.every((call) => call.closed),
      'Process overlap'
    );
    const child = new EventEmitter();
    const call = { command, callback, child, closed: false };

    calls.push(call);

    return child;
  };
  const shared = {
    child_process: {
      exec,
      execFile(binary, argv, settings, callback) {
        assert.strictEqual(binary, '/mock/never-execute');
        assert.strictEqual(settings.shell, false);
        assert(Array.isArray(argv));

        return exec(argv, callback);
      },
    },
    '../../../utils/log': { log },
    '../../../utils/checkIf': { checkIf },
    '../../../utils/funcs': utils,
    '../../../helpers/binaries': {
      mtpCliPath: '/mock/never-execute',
      kalamDebugReportCli: '/mock/never-execute-debug',
    },
    '../../../utils/date': { msToTime: String, unixTimestampNow: () => 1000 },
    '../transferResult': transferHelpers,
    '../MtpOperationQueue': queueModule,
  };
  const { FileExplorerKalamDataSource } = load(
    'app/data/file-explorer/data-sources/FileExplorerKalamDataSource.js',
    {
      ...shared,
      '../../../../ffi/kalam/src/Kalam': { Kalam },
      '../../../helpers/settings': {
        getFilesPreprocessingBeforeTransferSetting: () => true,
      },
    }
  );
  const { FileExplorerLegacyDataSource } = load(
    'app/data/file-explorer/data-sources/FileExplorerLegacyDataSource.js',
    {
      ...shared,
      path,
      'node:string_decoder': { StringDecoder },
      'lodash/find': () => {},
      '../../../constants': { DEVICES_LABEL: { mtp: 'Phone' } },
      '../../../enums': enums,
      '../../../utils/files': {
        baseName: path.basename,
        getExtension: () => '',
      },
    }
  );
  const close = (call, error = null, stdout = 'mock output', stderr = '') => {
    call.callback(error, stdout, stderr);
    Object.assign(call, { closed: true });
    call.child.emit('close', error ? 1 : 0, null);
  };

  return {
    calls,
    close,
    diagnostic: new FileExplorerKalamDataSource(),
    legacy: new FileExplorerLegacyDataSource(),
    FileExplorerLegacyDataSource,
  };
}

test('FIFO queue recovers after synchronous throw and rejected promise', async () => {
  const queue = new queueModule.MtpOperationQueue();
  const order = [];
  const first = queue.run(() => {
    order.push(1);
    throw new Error('sync failure');
  });
  const second = queue.run(() => {
    order.push(2);

    return Promise.reject(new Error('async failure'));
  });
  const third = queue.run(() => {
    order.push(3);

    return 'recovered';
  });

  await Promise.all([
    assert.rejects(first, /sync failure/),
    assert.rejects(second, /async failure/),
    settled(third),
  ]);
  assert.deepStrictEqual(order, [1, 2, 3]);
});

test('concurrent directory listings retain callbacks and lane until native return', async () => {
  const f = nativeFixture();
  const first = listing(f.source);
  const second = listing(new f.Kalam());

  f.result(f.calls[0], envelope(['first']));
  await flush();
  assert.strictEqual(f.calls.length, 1);
  assert.strictEqual(f.released.size, 0);
  f.returned(f.calls[0]);
  assert.deepStrictEqual(Array.from((await settled(first)).data), ['first']);
  assert.strictEqual(f.calls.length, 2);
  await complete(f);
  await settled(second);
  assert.strictEqual(f.released.size, 2);
});

test('native return without result fails conservatively; late callback is ignored', async () => {
  const f = nativeFixture();
  const first = listing(f.source);
  const second = listing(f.source);

  f.returned(f.calls[0]);
  assert((await settled(first)).error);
  f.result(f.calls[0]);
  assert.strictEqual(f.calls.length, 2);
  await complete(f);
  assert.strictEqual((await settled(second)).error, null);
});

const operations = {
  Initialize: (source) => source.initialize(),
  FetchDeviceInfo: (source) => source.fetchDeviceInfo(),
  FetchStorages: (source) => source.listStorages(),
  FileExists: (source) =>
    source.fileExist({ storageId: 1, files: ['/mock/a'] }),
  DeleteFile: (source) =>
    source.deleteFile({ storageId: 1, files: ['/mock/a'] }),
  MakeDirectory: (source) =>
    source.makeDirectory({ storageId: 1, fullPath: '/mock' }),
  RenameFile: (source) =>
    source.renameFile({ storageId: 1, fullPath: '/mock/a', newFilename: 'b' }),
  Walk: listing,
  Dispose: (source) => source.dispose(),
  UploadFiles: (source) => transfer(source),
  DownloadFiles: (source) => transfer(source, notifications(), 'download'),
};

Object.entries(operations).forEach(([name, invoke]) => {
  test(`${name} holds the shared lane without nested acquisition`, async () => {
    const f = nativeFixture();
    const first = invoke(f.source);
    const next = listing(new f.Kalam());

    assert.strictEqual(f.calls[0].name, name);
    f.result(f.calls[0]);
    await flush();
    assert.strictEqual(f.calls.length, 1);
    f.returned(f.calls[0]);
    await settled(first);
    assert.strictEqual(f.calls.length, 2);
    await complete(f);
    await settled(next);
  });
});

['RenameFile', 'DeleteFile', 'Initialize', 'Dispose'].forEach((name) => {
  test(`transfer followed by ${name} waits for native return`, async () => {
    const f = nativeFixture();
    const events = notifications();
    const first = transfer(f.source, events);
    const next = operations[name](f.source);

    f.result(f.calls[0]);
    await flush();
    assert.strictEqual(events.completed.length, 0);
    assert.strictEqual(f.calls.length, 1);
    f.returned(f.calls[0]);
    assert.strictEqual((await settled(first)).status, 'completed');
    assert.strictEqual(f.calls[1].name, name);
    await complete(f);
    await settled(next);
  });
});

test('native error is sticky, holds lane until return, then permits recovery', async () => {
  const f = nativeFixture();
  const first = listing(f.source);
  const next = listing(f.source);

  f.result(f.calls[0], envelope(null, 'Disconnected', 'ErrorGeneral'));
  f.result(f.calls[0]);
  await flush();
  assert.strictEqual(f.calls.length, 1);
  f.returned(f.calls[0]);
  assert.strictEqual((await settled(first)).error, 'Disconnected');
  await complete(f);
  assert.strictEqual((await settled(next)).error, null);
});

test('FFI return error overrides a successful non-transfer callback', async () => {
  const f = nativeFixture();
  const first = listing(f.source);

  f.result(f.calls[0]);
  f.returned(f.calls[0], new Error('Mock FFI error'));
  assert.match((await settled(first)).error.message, /Mock FFI error/);
});

test('duplicate callbacks and duplicate native returns cannot release an active successor', async () => {
  const f = nativeFixture();
  const first = listing(f.source);
  const second = listing(f.source);
  const third = listing(f.source);

  f.result(f.calls[0]);
  f.result(f.calls[0]);
  f.returned(f.calls[0]);
  await settled(first);
  f.returned(f.calls[0]);
  f.result(f.calls[0], envelope(null, 'late error', 'ErrorGeneral'));
  await flush();
  assert.strictEqual(f.calls.length, 2);
  await complete(f);
  await settled(second);
  await complete(f);
  await settled(third);
});

['{', 'null', '[]', '{}', '{"data":true}'].forEach((payload) => {
  test(`malformed listing callback cannot escape or release lane: ${payload}`, async () => {
    const f = nativeFixture();
    const first = listing(f.source);
    const next = listing(f.source);

    assert.doesNotThrow(() => f.result(f.calls[0], payload));
    await flush();
    assert.strictEqual(f.calls.length, 1);
    f.returned(f.calls[0]);
    assert((await settled(first)).error);
    await complete(f);
    await settled(next);
  });
});

test('conflicting listing results fail conservatively', async () => {
  const f = nativeFixture();
  const first = listing(f.source);

  f.result(f.calls[0], envelope(['a']));
  f.result(f.calls[0], envelope(['b']));
  f.returned(f.calls[0]);
  assert.match((await settled(first)).error.message, /Conflicting/);
});

test('an unresolved native operation retains lane and callbacks indefinitely', async () => {
  const f = nativeFixture();
  const first = listing(f.source);
  const next = listing(f.source);

  f.result(f.calls[0]);
  await flush();
  await flush();
  assert.strictEqual(f.calls.length, 1);
  assert.strictEqual(f.released.size, 0);
  // Explicitly simulate eventual native return for cleanup, never force release.
  f.returned(f.calls[0]);
  await settled(first);
  await complete(f);
  await settled(next);
});

test('progress can enqueue work without overtaking earlier admissions', async () => {
  const f = nativeFixture();
  const events = notifications();
  let reentrant;
  const first = transfer(f.source, {
    ...events,
    onProgress(value) {
      events.onProgress(value);
      reentrant = f.source.dispose();
    },
  });
  const second = listing(f.source);

  f.calls[0].args[2](envelope({ activeFileProgress: 50 }));
  assert.strictEqual(events.progress.length, 1);
  assert.strictEqual(f.calls.length, 1);
  await complete(f, f.calls[0]);
  await settled(first);
  assert.strictEqual(f.calls[1].name, 'Walk');
  await complete(f, f.calls[1]);
  await settled(second);
  assert.strictEqual(f.calls[2].name, 'Dispose');
  await complete(f);
  await settled(reentrant);
});

test('synchronous native submission failure releases only the unstarted task', async () => {
  const bad = nativeFixture({ submissionThrows: true });
  const first = listing(bad.source);
  const good = nativeFixture();
  const second = listing(good.source);

  assert((await settled(first)).error);
  assert.strictEqual(bad.registered.size, bad.released.size);
  await complete(good);
  await settled(second);
});

test('Legacy exit waits for stream closure and includes late stderr before native refresh', async () => {
  const legacy = legacyFixture();
  const first = legacy.start();
  const f = nativeFixture();
  const next = listing(f.source);

  legacy.child.emit('exit', 0, null);
  await flush();
  assert.strictEqual(f.calls.length, 0);
  legacy.stderr('Storage full');
  legacy.child.emit('close', 0, null);
  assert.strictEqual((await settled(first)).status, 'failed');
  await complete(f);
  await settled(next);
});

test('Legacy asynchronous spawn failure retains lane until close', async () => {
  const legacy = legacyFixture();
  const first = legacy.start();
  const f = nativeFixture();
  const next = listing(f.source);

  legacy.child.emit('error', new Error('spawn failed'));
  await flush();
  assert.strictEqual(f.calls.length, 0);
  legacy.child.emit('close', -2, null);
  assert.strictEqual((await settled(first)).status, 'failed');
  await complete(f);
  await settled(next);
});

test('Legacy synchronous spawn failure permits the next task', async () => {
  const legacy = legacyFixture({ spawnThrows: true });
  const first = legacy.start();
  const f = nativeFixture();
  const next = listing(f.source);

  assert.strictEqual((await settled(first)).status, 'failed');
  await complete(f);
  await settled(next);
});

test('Legacy signal termination remains uncertain and holds lane until close', async () => {
  const legacy = legacyFixture();
  const first = legacy.start();
  const f = nativeFixture();
  const next = listing(f.source);

  legacy.child.emit('exit', null, 'SIGTERM');
  await flush();
  assert.strictEqual(f.calls.length, 0);
  legacy.child.emit('close', null, 'SIGTERM');
  assert.strictEqual((await settled(first)).status, 'unknown');
  await complete(f);
  await settled(next);
});

test('Legacy setup exception after spawn cannot release an active child', async () => {
  const legacy = legacyFixture();

  legacy.child.stdout.on = () => {
    throw new Error('mock stream setup failure');
  };

  const first = legacy.start();
  const f = nativeFixture();
  const next = listing(f.source);

  await flush();
  assert.strictEqual(f.calls.length, 0);
  legacy.child.emit('close', 0, null);
  assert.strictEqual((await settled(first)).status, 'unknown');
  await complete(f);
  await settled(next);
});

test('two Legacy instances share the same lane', async () => {
  const firstBackend = legacyFixture();
  const secondBackend = legacyFixture();
  const first = firstBackend.start();
  const second = secondBackend.start();

  assert.strictEqual(secondBackend.calls.length, 0);
  firstBackend.child.emit('close', 0, null);
  await settled(first);
  assert.strictEqual(secondBackend.calls.length, 1);
  secondBackend.child.emit('close', 0, null);
  await settled(second);
});

test('Kalam data source delegates without nested acquisition; diagnostic waits for return', async () => {
  const f = nativeFixture();
  const p = processFixture(f.Kalam);
  const first = p.diagnostic.initialize();
  const diagnostic = p.diagnostic.fetchDebugReport();

  assert.strictEqual(f.calls.length, 1);
  assert.strictEqual(p.calls.length, 0);
  await complete(f);
  await settled(first);
  assert.strictEqual(p.calls.length, 1);
  p.close(p.calls[0]);
  assert.strictEqual((await settled(diagnostic)).data, 'mock output');
});

test('diagnostic callback and exit cannot release lane before closure', async () => {
  const p = processFixture();
  const diagnostic = p.diagnostic._exec('/mock/diagnostic');
  const f = nativeFixture();
  const next = listing(f.source);

  p.calls[0].callback(null, 'report', '');
  p.calls[0].child.emit('exit', 0, null);
  await flush();
  assert.strictEqual(f.calls.length, 0);
  p.close(p.calls[0], null, 'report');
  assert.strictEqual((await settled(diagnostic)).data, 'report');
  await complete(f);
  await settled(next);
});

test('Legacy command helper and diagnostic process share FIFO admission order', async () => {
  const p = processFixture();
  const first = p.legacy._exec(['mock list']);
  const second = p.diagnostic._exec('mock diagnostic');
  const third = new p.FileExplorerLegacyDataSource()._execNoCatch([
    'mock properties',
  ]);

  p.calls[0].callback(null, 'files', '');
  await flush();
  assert.strictEqual(p.calls.length, 1);
  p.close(p.calls[0], null, 'files');
  assert.strictEqual((await settled(first)).data, 'files');
  assert.strictEqual(p.calls[1].command, 'mock diagnostic');
  p.close(p.calls[1]);
  await settled(second);
  assert.deepStrictEqual(Array.from(p.calls[2].command), ['mock properties']);
  p.close(p.calls[2]);
  await settled(third);
});

test('Legacy existence helper acquires only at its execution leaf', async () => {
  const p = processFixture();
  const first = p.legacy._checkMtpFileExists('/mock/a', 1);

  assert.strictEqual(p.calls.length, 1);
  p.close(
    p.calls[0],
    null,
    'selected storage 1 Test Storage\n/mock\n42         a\n/mock\n'
  );
  assert.strictEqual(await settled(first), true);
});

test('Legacy command error formatting preserves real line breaks', async () => {
  const p = processFixture();
  const first = p.legacy._exec(['mock command']);

  p.close(p.calls[0], null, '', 'first error\nsecond error');
  assert.strictEqual(
    (await settled(first)).stderr,
    'first error\nsecond error'
  );
});

test('Legacy uncleaned helper preserves its original error and output contract', async () => {
  const p = processFixture();
  const first = p.legacy._execNoCatch(['mock command']);
  const error = new Error('mock command failed');

  p.close(p.calls[0], error, 'partial output', 'raw stderr');
  const result = await settled(first);

  assert.strictEqual(result.error, error);
  assert.strictEqual(result.data, 'partial output');
  assert.strictEqual(result.stderr, 'raw stderr');
});

['diagnostic', 'legacy'].forEach((backend) => {
  test(`${backend} missing process result fails and allows recovery after close`, async () => {
    const p = processFixture();
    const first = p[backend]._exec(
      backend === 'legacy' ? ['mock command'] : 'mock command'
    );
    const f = nativeFixture();
    const next = listing(f.source);

    p.calls[0].closed = true;
    p.calls[0].child.emit('close', 0, null);
    assert((await settled(first)).error);
    await complete(f);
    await settled(next);
  });

  test(`${backend} process error remains sticky until close`, async () => {
    const p = processFixture();
    const first = p[backend]._exec(
      backend === 'legacy' ? ['mock command'] : 'mock command'
    );
    const f = nativeFixture();
    const next = listing(f.source);

    p.calls[0].callback(null, 'apparently successful', '');
    p.calls[0].child.emit('error', new Error('mock process failure'));
    await flush();
    assert.strictEqual(f.calls.length, 0);
    p.close(p.calls[0]);
    assert((await settled(first)).error);
    await complete(f);
    await settled(next);
  });
});

test('execution hooks run synchronously before work and before successor admission', async () => {
  const queue = new queueModule.MtpOperationQueue();
  const order = [];
  const context = Object.freeze({ generation: 1 });
  const first = queue.run(
    () => {
      order.push('work');

      return 'result';
    },
    {
      context,
      beforeStart(value) {
        assert.strictEqual(value, context);
        order.push('validate');
      },
      afterStop(outcome, value) {
        assert.strictEqual(value, context);
        assert(Object.isFrozen(outcome));
        assert.strictEqual(outcome.status, 'fulfilled');
        assert.strictEqual(outcome.value, 'result');
        order.push('settle');
      },
    }
  );
  const second = queue.run(() => order.push('next'));

  assert.deepStrictEqual(order, ['validate', 'work']);
  assert.strictEqual(await settled(first), 'result');
  await settled(second);
  assert.deepStrictEqual(order, ['validate', 'work', 'settle', 'next']);
});

[
  [
    'throw',
    () => {
      throw new Error('denied');
    },
  ],
  ['false', () => false],
  ['rejected promise', () => Promise.reject(new Error('async denial'))],
  ['fulfilled promise', () => Promise.resolve(true)],
].forEach(([name, beforeStart]) => {
  test(`start hook ${name} never executes work and permits eligible successors`, async () => {
    const queue = new queueModule.MtpOperationQueue();
    let calls = 0;
    const first = assert.rejects(
      queue.run(
        () => {
          calls += 1;
        },
        {
          beforeStart,
          afterStop() {
            throw new Error('Unstarted work has no settlement hook');
          },
        }
      )
    );
    const next = queue.run(() => 'eligible');

    await first;
    assert.strictEqual(await settled(next), 'eligible');
    assert.strictEqual(calls, 0);
    assert.strictEqual(queue.fault, null);
  });
});

[
  [
    'throw',
    () => {
      throw new Error('fence failed');
    },
  ],
  ['rejected promise', () => Promise.reject(new Error('async fence failed'))],
  ['fulfilled promise', () => Promise.resolve()],
].forEach(([name, afterStop]) => {
  test(`settlement hook ${name} quarantines the lane before any successor`, async () => {
    const queue = new queueModule.MtpOperationQueue();
    const executed = [];
    const quarantined = (error) => error.code === 'MTP_QUEUE_QUARANTINED';
    const first = assert.rejects(
      queue.run(
        () => {
          executed.push('first');

          return 'native result';
        },
        { afterStop }
      ),
      quarantined
    );
    const next = assert.rejects(
      queue.run(() => executed.push('next')),
      quarantined
    );

    await Promise.all([first, next]);
    await assert.rejects(
      queue.run(() => executed.push('future')),
      quarantined
    );
    assert.deepStrictEqual(executed, ['first']);
    assert(queue.fault.cause);
    assert.strictEqual(queue.active, false);
  });
});

test('settlement hook sees a rejected execution before recovery', async () => {
  const queue = new queueModule.MtpOperationQueue();
  const error = new Error('operation failed');
  let observed;
  const first = assert.rejects(
    queue.run(() => Promise.reject(error), {
      afterStop(outcome) {
        observed = outcome;
      },
    }),
    /operation failed/
  );
  const next = queue.run(() => {
    assert.strictEqual(observed.status, 'rejected');
    assert.strictEqual(observed.reason, error);

    return true;
  });

  await first;
  await settled(next);
});

test('context without a validator and malformed hook options fail before execution', async () => {
  const queue = new queueModule.MtpOperationQueue();

  await assert.rejects(
    queue.run(() => assert.fail('unguarded'), { context: {} })
  );
  await assert.rejects(
    queue.run(() => assert.fail('bad hook'), { afterStop: true })
  );
  assert.strictEqual(await settled(queue.run(() => 'unchanged')), 'unchanged');
});

['beforeStart', 'afterStop'].forEach((hook) => {
  test(`${hook} cannot acquire its own lane even if it catches the violation`, async () => {
    const queue = new queueModule.MtpOperationQueue();
    const first = queue.run(() => 'work', {
      [hook]() {
        assert.throws(
          () => queue.run(() => assert.fail('nested execution')),
          /must not acquire/
        );
      },
    });

    await assert.rejects(first);
    assert.strictEqual(queue.pending.length, 0);
    assert.strictEqual(!!queue.fault, hook === 'afterStop');
  });
});

test('large obsolete batches drain without recursion and preserve eligible FIFO order', async () => {
  const queue = new queueModule.MtpOperationQueue();
  let release;
  const first = queue.run(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  const rejected = Array.from({ length: 10000 }, () =>
    assert.rejects(
      queue.run(() => assert.fail('obsolete operation executed'), {
        beforeStart: () => false,
      })
    )
  );
  const order = [];
  const next = queue.run(() => order.push(1));
  const last = queue.run(() => order.push(2));

  release();
  await settled(first);
  await Promise.all(rejected);
  await settled(next);
  await settled(last);
  assert.deepStrictEqual(order, [1, 2]);
  assert.strictEqual(queue.active, false);
});

for (const option of ['lookupThrows', 'registrationThrows']) {
  test(`Initialize ${option} proves non-invocation without claiming cleanup`, async () => {
    const f = nativeFixture({ [option]: true });
    const result = await settled(f.source.initialize());

    assert(result.error);
    assert.strictEqual(f.calls.length, 0);
    assert.strictEqual(f.evidence.length, 1);
    assert.strictEqual(f.evidence[0].terminal, true);
    assert.strictEqual(f.evidence[0].nativeStarted, false);
    assert.strictEqual(f.evidence[0].nativeReturned, false);
    assert.strictEqual(f.evidence[0].resources, 'none');
    assert.strictEqual(f.evidence[0].cleanupAcknowledged, false);
    assert.strictEqual(f.registered.size, f.released.size);
  });
}

test('Initialize submission throw after invocation boundary remains resource-uncertain', async () => {
  const f = nativeFixture({ submissionThrows: true });

  assert((await settled(f.source.initialize())).error);
  assert.strictEqual(f.evidence.length, 2);
  assert.strictEqual(f.evidence[1].nativeStarted, true);
  assert.strictEqual(f.evidence[1].nativeReturned, false);
  assert.strictEqual(f.evidence[1].resources, 'unknown');
  assert.strictEqual(f.evidence[1].cleanupAcknowledged, false);
});

test('Initialize callback cannot report return, cleanup or release before the native barrier', async () => {
  const f = nativeFixture();
  let settledCount = 0;
  const result = f.source.initialize().then((value) => {
    settledCount += 1;

    return value;
  });
  const next = listing(f.source);

  f.result(f.calls[0], envelope(null, 'original error', 'ErrorDeviceSetup'));
  f.result(f.calls[0], envelope(null, 'original error', 'ErrorDeviceSetup'));
  await flush();
  assert.strictEqual(settledCount, 0);
  assert.strictEqual(f.evidence.length, 1);
  assert.strictEqual(f.evidence[0].terminal, false);
  assert.strictEqual(f.evidence[0].nativeReturned, false);
  assert.strictEqual(f.released.size, 0);
  assert.strictEqual(f.calls.length, 1);
  f.returned(f.calls[0]);
  const value = await settled(result);

  assert.strictEqual(value.error, 'original error');
  assert.strictEqual(value.stderr, 'ErrorDeviceSetup');
  assert.strictEqual(f.evidence[1].nativeReturned, true);
  assert.strictEqual(f.evidence[1].resources, 'unknown');
  assert.strictEqual(f.evidence[1].cleanupAcknowledged, false);
  f.returned(f.calls[0]);
  f.result(f.calls[0], envelope(true));
  assert.strictEqual(f.evidence.length, 2);
  assert.strictEqual(settledCount, 1);
  await complete(f);
  await settled(next);
});

test('Native JSON lifecycle claims cannot forge a cleanup acknowledgement', async () => {
  const f = nativeFixture();
  const result = f.source.initialize();

  f.result(
    f.calls[0],
    JSON.stringify({
      error: 'no device',
      errorType: 'ErrorMtpDetectFailed',
      data: null,
      cleanupAcknowledged: true,
      lifecycleEvidence: { resources: 'closed', nativeStarted: false },
    })
  );
  f.returned(f.calls[0]);
  const value = await settled(result);

  assert.strictEqual(value.error, 'no device');
  assert.strictEqual(value.cleanupAcknowledged, undefined);
  assert.strictEqual(f.evidence[1].cleanupAcknowledged, false);
  assert.strictEqual(f.evidence[1].resources, 'unknown');
});

test('Conflicting Initialize callbacks preserve failure and unknown cleanup after return', async () => {
  const f = nativeFixture();
  const result = f.source.initialize();

  f.result(f.calls[0], envelope({ serial: 'first' }));
  f.result(f.calls[0], envelope({ serial: 'different' }));
  f.returned(f.calls[0]);
  assert.match((await settled(result)).error.message, /Conflicting/);
  assert.strictEqual(f.evidence[1].nativeReturned, true);
  assert.strictEqual(f.evidence[1].cleanupAcknowledged, false);
});

function nativeOwnerFixture(options = {}) {
  const f = nativeFixture(options);
  const owner = load('app/data/file-explorer/MtpSessionOwner.js', {});
  const transport = load('app/data/file-explorer/MtpSessionTransport.js', {});
  const { MtpSessionService } = load(
    'app/data/file-explorer/MtpSessionService.js',
    {
      './MtpSessionOwner': owner,
      './MtpSessionTransport': transport,
      './transferResult': transferHelpers,
    }
  );
  let constructions = 0;
  const service = new MtpSessionService({
    queue: queueModule.default,
    ownerEpoch: 'mock-native-owner',
    backendFactory(_, executionHooks) {
      constructions += 1;

      return new f.Kalam({ executionHooks });
    },
  });

  return { ...f, service, constructions: () => constructions };
}

test('Actual bridge pre-invocation failure permits explicit retry on the same adapter', async () => {
  const f = nativeOwnerFixture({ lookupThrows: true });

  await assert.rejects(f.service.request('client', 'initialize', {}, null));
  await flush();
  assert.strictEqual(f.service.snapshot().state, 'Disconnected');
  assert.strictEqual(f.service.initializationFailure.nativeStarted, false);
  f.allowLookup();
  const retry = f.service.request(
    'client',
    'initialize',
    {},
    f.service.scope()
  );

  await flush();
  f.result(
    f.calls[0],
    envelope({
      mtpDeviceInfo: { SerialNumber: 'mock' },
      usbDeviceInfo: { SerialNumber: 'mock' },
    })
  );
  f.returned(f.calls[0]);
  await retry;
  assert.strictEqual(f.service.snapshot().generation, 2);
  assert.strictEqual(f.service.snapshot().state, 'Ready');
  assert.strictEqual(f.constructions(), 1);
  const close = f.service.close();

  await flush();
  await complete(f);
  await close;
});

test('Actual bridge error holds ownership until return and fences already queued disposal', async () => {
  const f = nativeOwnerFixture();
  const init = assert.rejects(
    f.service.request('client', 'initialize', {}, null),
    /LIBUSB_ERROR_NOT_FOUND/
  );

  await flush();
  f.result(
    f.calls[0],
    envelope(null, 'LIBUSB_ERROR_NOT_FOUND', 'ErrorMtpDetectFailed')
  );
  const shutdown = assert.rejects(f.service.shutdown());

  await flush();
  assert.strictEqual(f.calls.length, 1);
  assert.strictEqual(f.released.size, 0);
  assert(f.service.snapshot().activeOperationId);
  assert.strictEqual(queueModule.default.active, true);
  f.returned(f.calls[0]);
  await init;
  await shutdown;
  assert.strictEqual(f.calls.length, 1);
  assert(f.service.quarantine);
  assert.strictEqual(f.service.initializationFailure.nativeReturned, true);
  assert.strictEqual(
    f.service.initializationFailure.cleanupAcknowledged,
    false
  );
});

async function runTests() {
  let passed = 0;

  await tests.reduce(async (previous, { name, run }) => {
    await previous;
    await run();
    passed += 1;
    console.info(`PASS ${name}`);

    return true;
  }, Promise.resolve());
  console.info(`${passed}/${tests.length} MTP serialization tests passed.`);
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
