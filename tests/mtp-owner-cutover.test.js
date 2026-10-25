/* Mock-only owner, native barriers, IPC and renderer tests. */
/* eslint-disable max-classes-per-file -- The two injected constructors represent different backends. */
const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const vm = require('vm');
const baseline = require('./transfer-reliability.test');
const {
  load,
  queueModule,
  transferHelpers,
  uiFixture,
} = require('./transfer-reliability.test');

const transport = load('app/data/file-explorer/MtpSessionTransport.js', {});
const owner = load('app/data/file-explorer/MtpSessionOwner.js', {});
const { MtpSessionService } = load(
  'app/data/file-explorer/MtpSessionService.js',
  {
    './MtpSessionOwner': owner,
    './MtpSessionTransport': transport,
    './transferResult': transferHelpers,
  }
);
const tests = [];
const test = (name, run) => tests.push({ name, run });
const flush = () => new Promise((resolve) => setImmediate(resolve));
const observed = (promise) =>
  promise.then(
    (value) => ({ value }),
    (error) => ({ error })
  );
const ok = (data) => ({ data, error: null, stderr: null });

function fixture(backend = 'kalam') {
  const queue = new queueModule.MtpOperationQueue();
  const calls = [];
  const held = [];
  let hold = false;
  let initFailure = false;
  let initResult = ok(null);
  let initEvidence = [];
  let initReporter;
  let closeFailure = false;
  let hooks;
  let transferOutcome = null;
  const run = (name, args, result) => {
    const execution = hooks();
    const evidence = name === 'initialize' ? initEvidence : [];

    if (name === 'initialize') initReporter = execution.onLifecycleEvidence;
    const finish = () => {
      evidence
        .filter((value) => value?.terminal)
        .forEach(execution.onLifecycleEvidence);

      return result;
    };

    return queue.run(() => {
      calls.push({ name, args });
      evidence
        .filter((value) => !value?.terminal)
        .forEach(execution.onLifecycleEvidence);
      if (hold)
        return new Promise((resolve) => held.push(() => resolve(finish())));

      return finish();
    }, execution);
  };
  const adapter = {
    initialize: () =>
      run(
        'initialize',
        {},
        initFailure
          ? initResult
          : ok({
              mtpDeviceInfo: { SerialNumber: 'serial' },
              usbDeviceInfo: { SerialNumber: 'serial' },
            })
      ),
    dispose: () =>
      run(
        'dispose',
        {},
        closeFailure ? { error: 'uncertain', data: null } : ok(true)
      ),
    listStorages: () =>
      run(
        'listStorages',
        {},
        ok({
          1: { name: 'Internal', selected: true },
          2: { name: 'SD', selected: false },
        })
      ),
    listFiles: (args) =>
      run('listFiles', args, ok([{ name: 'a', path: '/a' }])),
    renameFile: (args) => run('renameFile', args, ok(true)),
    deleteFiles: (args) => run('deleteFiles', args, ok(true)),
    makeDirectory: (args) => run('makeDirectory', args, ok(true)),
    filesExist: (args) => run('filesExist', args, false),
    fetchDebugReport: () => run('diagnostic', {}, ok('report')),
    transferFiles: (args) =>
      run(
        'transfer',
        args,
        (() => {
          args.onPreprocess({ fullPath: '/a' });
          args.onProgress({ activeFileProgress: 100 });

          return (
            transferOutcome || {
              status: 'completed',
              backend,
              direction: 'upload',
              data: true,
              error: null,
              stderr: null,
              backendStopped: true,
              evidence:
                backend === 'kalam'
                  ? { nativeAcknowledged: true }
                  : { exitCode: 0, signal: null },
              files: { requested: ['/a'] },
            }
          );
        })()
      ),
  };
  const service = new MtpSessionService({
    queue,
    ownerEpoch: 'owner',
    initialBackend: backend,
    backendFactory(selected, supplied) {
      calls.push({ name: 'factory', selected });
      hooks = supplied;

      return adapter;
    },
  });

  return {
    service,
    queue,
    adapter,
    calls,
    held,
    getInitReporter: () => initReporter,
    setHold: (value) => {
      hold = value;
    },
    setTransferOutcome: (value) => {
      transferOutcome = value;
    },
    failInit: (result = ok(null), evidence = []) => {
      initFailure = true;
      initResult = result;
      initEvidence = evidence;
    },
    recoverInit: () => {
      initFailure = false;
      initEvidence = [];
    },
    failClose: () => {
      closeFailure = true;
    },
    async ready() {
      await service.request('client', 'initialize', {}, null);
      await service.request('client', 'listStorages', {}, service.scope());
      await flush();
    },
    request(operation, args = {}) {
      return service.request(
        'client',
        operation,
        { storageId: 1, ...args },
        service.scope()
      );
    },
  };
}

for (const backend of ['kalam', 'legacy']) {
  test(`${backend}: only selected adapter, one initialization, compatible browsing`, async () => {
    const f = fixture(backend);

    await Promise.all([
      f.service.request('client', 'initialize', {}, null),
      f.service.request('client', 'initialize', {}, null),
    ]);
    await f.ready();
    assert.strictEqual(f.calls.filter((c) => c.name === 'factory').length, 1);
    assert.strictEqual(
      f.calls.filter((c) => c.name === 'initialize').length,
      backend === 'kalam' ? 1 : 0
    );
    assert.strictEqual(
      (await f.request('listFiles', { filePath: '/', ignoreHidden: false }))
        .data[0].name,
      'a'
    );
  });
}

test('FIFO transfer barrier blocks rename and shutdown until actual return', async () => {
  const f = fixture();

  await f.ready();
  f.setHold(true);
  const transfer = f.request('transferFiles', { direction: 'upload' });

  await flush();
  const rename = observed(
    f.request('renameFile', { filePath: '/a', newFilename: 'b' })
  );
  let stopped = false;
  const stop = f.service.shutdown().then(() => {
    stopped = true;

    return null;
  });

  await flush();
  assert.strictEqual(stopped, false);
  assert.strictEqual(f.queue.active, true);
  assert.strictEqual(f.calls.filter((c) => c.name === 'dispose').length, 0);
  f.setHold(false);
  f.held.shift()();
  await transfer;
  await stop;
  assert((await rename).error);
  assert.strictEqual(f.calls.filter((c) => c.name === 'renameFile').length, 0);
  assert.strictEqual(f.calls.filter((c) => c.name === 'dispose').length, 1);
});
test('Storage revision rejects queued mutations without reinitialization', async () => {
  const f = fixture();

  await f.ready();
  f.setHold(true);
  const list = f.request('listFiles');

  await flush();
  const stale = observed(f.request('deleteFiles', { fileList: ['/a'] }));

  await f.service.request(
    'client',
    'selectStorage',
    { storageId: 2 },
    f.service.scope()
  );
  f.setHold(false);
  f.held.shift()();
  await list;
  assert((await stale).error);
  assert.strictEqual(f.calls.filter((c) => c.name === 'deleteFiles').length, 0);
  assert.strictEqual(f.calls.filter((c) => c.name === 'initialize').length, 1);
});
test('USB invalidation rejects pending work and never replays mutations', async () => {
  const f = fixture();

  await f.ready();
  f.setHold(true);
  const list = f.request('listFiles');

  await flush();
  const stale = observed(f.request('makeDirectory', { filePath: '/a' }));

  f.service.invalidate('usb-detached');
  f.setHold(false);
  f.held.shift()();
  await list;
  assert((await stale).error);
  assert.strictEqual(
    f.calls.filter((c) => c.name === 'makeDirectory').length,
    0
  );
});
test('Renderer reload retains active lease and its authoritative transfer outcome', async () => {
  const f = fixture();

  await f.ready();
  f.setHold(true);
  const result = f.request('transferFiles', { direction: 'upload' });

  await flush();
  f.service.revoke('client');
  await flush();
  assert.strictEqual(f.queue.active, true);
  assert.strictEqual(f.service.snapshot().state, 'Invalidated');
  f.setHold(false);
  f.held.shift()();
  assert.strictEqual((await result).status, 'completed');
  await flush();
  assert(
    [...f.service.jobs.values()].some(
      (job) => job.outcome?.status === 'completed'
    )
  );
  assert.strictEqual(f.service.snapshot().state, 'Disconnected');
});
test('Backend switch waits for closure then creates a fresh generation', async () => {
  const f = fixture();

  await f.ready();
  const previous = f.service.scope();

  await f.service.request(
    'client',
    'selectBackend',
    { backend: 'legacy' },
    previous
  );
  await f.service.request('replacement', 'initialize', {}, f.service.scope());
  assert(f.service.snapshot().generation > previous.generation);
  assert.strictEqual(f.calls.filter((c) => c.name === 'factory').length, 2);
  assert.strictEqual(f.service.matches(previous), false);
});
test('Diagnostics disposes before process admission and ends disconnected', async () => {
  const f = fixture();

  await f.ready();
  await f.service.request('client', 'fetchDebugReport', {}, f.service.scope());
  const names = f.calls.map((c) => c.name);

  assert(names.indexOf('dispose') < names.indexOf('diagnostic'));
  assert.strictEqual(f.service.snapshot().state, 'Disconnected');
});
test('Uncertain cleanup quarantines and prevents diagnostics', async () => {
  const f = fixture();

  await f.ready();
  f.failClose();
  await assert.rejects(
    f.service.request('client', 'fetchDebugReport', {}, f.service.scope())
  );
  assert(f.service.quarantine);
  assert(!f.calls.some((c) => c.name === 'diagnostic'));
});
test('Unresolved execution never releases on invalidation or repeated quit', async () => {
  const f = fixture();

  await f.ready();
  f.setHold(true);
  const active = f.request('listFiles');

  await flush();
  const a = f.service.shutdown();
  const b = f.service.shutdown();

  assert.strictEqual(a, b);
  await flush();
  assert.strictEqual(f.queue.active, true);
  assert(!f.calls.some((c) => c.name === 'dispose'));
  f.setHold(false);
  f.held.shift()();
  await active;
  await a;
});
// Active application coverage below targets renderer restoration. The existing
// service/IPC tests continue to cover the preserved, inactive B2 modules.
function rendererRepositoryFixture({
  mode = 'kalam',
  processType = 'renderer',
  hash = '',
  hold = false,
  initFailure = false,
} = {}) {
  const calls = [];
  const constructed = [];
  const held = [];
  let selected = mode;
  let blocked = hold;
  const Source = (name) =>
    class {
      constructor({ executionHooks }) {
        constructed.push(name);
        this.hooks = executionHooks;
      }

      run(method, value) {
        return queueModule.default.run(() => {
          calls.push(`${name}:${method}`);

          return blocked
            ? new Promise((resolve) => held.push(() => resolve(value)))
            : value;
        }, this.hooks());
      }

      initialize() {
        return this.run(
          'initialize',
          initFailure
            ? { error: 'LIBUSB_ERROR_NOT_FOUND', data: null }
            : ok({ serial: 'mock' })
        );
      }

      listStorages() {
        return this.run('listStorages', ok({ 1: { selected: true } }));
      }

      listFiles() {
        return this.run('listFiles', ok([]));
      }

      dispose() {
        return this.run('dispose', ok(true));
      }

      transferFiles(args) {
        return this.run('transferFiles', args.deviceType);
      }
    };
  const module = load(
    'app/data/file-explorer/repositories/FileExplorerRepository.js',
    {
      '../data-sources/FileExplorerLocalDataSource': {
        FileExplorerLocalDataSource: class {
          listFiles() {
            return ok(['local']);
          }
        },
      },
      '../data-sources/FileExplorerKalamDataSource': {
        FileExplorerKalamDataSource: Source('kalam'),
      },
      '../data-sources/FileExplorerLegacyDataSource': {
        FileExplorerLegacyDataSource: Source('legacy'),
      },
      '../../../enums': baseline.enums,
      '../../../helpers/settings': { getMtpModeSetting: () => selected },
      '../MtpOperationQueue': queueModule,
    },
    { process: { type: processType }, window: { location: { hash } } }
  );

  return {
    ...module,
    repository: new module.FileExplorerRepository(),
    calls,
    constructed,
    held,
    setMode: (value) => {
      selected = value;
    },
    release: () => {
      blocked = false;
      held.splice(0).forEach((fn) => fn());
    },
  };
}

test('Renderer repository constructs no backend for local operations and lazily shares only Kalam', async () => {
  const f = rendererRepositoryFixture();

  assert.deepStrictEqual(
    Array.from(f.repository.listFiles({ deviceType: 'local' }).data),
    ['local']
  );
  assert.strictEqual(f.constructed.length, 0);
  await f.repository.initialize({ deviceType: 'mtp' });
  const second = new f.FileExplorerRepository();

  await second.initialize({ deviceType: 'mtp' });
  assert.deepStrictEqual(f.constructed, ['kalam']);
  assert.deepStrictEqual(f.calls, ['kalam:initialize']);
});
test('Renderer Legacy routing never constructs or initializes Kalam', async () => {
  const f = rendererRepositoryFixture({ mode: 'legacy' });

  await f.repository.listStorages();
  await f.repository.listFiles({
    deviceType: 'mtp',
    storageId: 1,
    filePath: '/',
  });
  assert.deepStrictEqual(f.constructed, ['legacy']);
  assert.deepStrictEqual(f.calls, ['legacy:listStorages', 'legacy:listFiles']);
});
for (const context of [
  { processType: 'browser' },
  { hash: '#reportBugsPage' },
]) {
  test(`Repository refuses MTP construction outside explorer: ${JSON.stringify(
    context
  )}`, async () => {
    const f = rendererRepositoryFixture(context);
    const result = await f.repository.initialize({ deviceType: 'mtp' });

    assert.match(result.error, /explorer renderer/);
    assert.strictEqual(f.constructed.length, 0);
    assert.strictEqual(
      f.repository.listFiles({ deviceType: 'local' }).data[0],
      'local'
    );
  });
}

test('Uncertain Kalam initialization cannot retry, dispose, or fall back in the same renderer', async () => {
  const f = rendererRepositoryFixture({ initFailure: true });
  const first = await f.repository.initialize({ deviceType: 'mtp' });

  assert.match(first.error, /LIBUSB_ERROR/);
  const again = await f.repository.initialize({ deviceType: 'mtp' });

  assert.match(again.error, /fresh development process/);
  await assert.rejects(
    f.repository.selectBackend('legacy'),
    /fresh development process/
  );
  await assert.rejects(
    f.repository.dispose({ deviceType: 'mtp' }),
    /fresh development process/
  );
  assert.deepStrictEqual(f.calls, ['kalam:initialize']);
  assert.deepStrictEqual(f.constructed, ['kalam']);
});
test('Renderer initialization is coalesced until backend return; disposal cannot overlap', async () => {
  const f = rendererRepositoryFixture({ hold: true });
  const one = f.repository.initialize({ deviceType: 'mtp' });
  const two = f.repository.initialize({ deviceType: 'mtp' });

  assert.deepStrictEqual(f.calls, ['kalam:initialize']);
  await assert.rejects(
    f.repository.dispose({ deviceType: 'mtp' }),
    /execution to return/
  );
  f.release();
  assert.strictEqual((await one).data.serial, 'mock');
  assert.strictEqual((await two).data.serial, 'mock');
});
test('Renderer storage revision invalidates old UI scope without a native operation', async () => {
  const f = rendererRepositoryFixture();

  await f.repository.initialize({ deviceType: 'mtp' });
  const old = f.captureMtpScope();

  f.repository.selectStorage(2);
  assert.strictEqual(f.isCurrentMtpScope(old), false);
  assert.strictEqual(f.isCurrentMtpScope(f.captureMtpScope()), true);
  assert.deepStrictEqual(f.calls, ['kalam:initialize']);
});
test('Renderer backend change disposes the old source before lazily constructing Legacy', async () => {
  const f = rendererRepositoryFixture();

  await f.repository.initialize({ deviceType: 'mtp' });
  await f.repository.selectBackend('legacy');
  assert.deepStrictEqual(f.constructed, ['kalam']);
  f.setMode('legacy');
  await f.repository.listStorages();
  assert.deepStrictEqual(f.calls, [
    'kalam:initialize',
    'kalam:dispose',
    'legacy:listStorages',
  ]);
});
test('USB invalidation fences pending native work and stale initialization results without retry', async () => {
  const f = rendererRepositoryFixture({ hold: true });
  const first = f.repository.initialize({ deviceType: 'mtp' });

  f.invalidateRendererMtp();
  f.release();
  assert.match((await first).error, /Obsolete/);
  assert.strictEqual(f.isCurrentMtpScope(f.captureMtpScope()), false);
  assert.match(
    (await f.repository.initialize({ deviceType: 'mtp' })).error,
    /fresh development process/
  );
  assert.deepStrictEqual(f.calls, ['kalam:initialize']);
});
test('Renderer invalidation fences an already queued request before native admission', async () => {
  const f = rendererRepositoryFixture({ hold: true });

  await (async () => {
    const init = f.repository.initialize({ deviceType: 'mtp' });

    f.release();
    await init;
  })();
  // Register an active failing operation on the shared lane, then enqueue a
  // repository request while it is still waiting for its real return.
  let stop;
  const active = queueModule.default.run(
    () =>
      new Promise((resolve) => {
        stop = resolve;
      })
  );
  const request = observed(
    f.repository.listFiles({ deviceType: 'mtp', storageId: 1, filePath: '/' })
  );

  f.invalidateRendererMtp();
  stop();
  await active;
  assert.match((await request).error.message, /fresh development process/);
  assert.deepStrictEqual(f.calls, ['kalam:initialize']);
});

test('Restored application leaves IPC passive and has no main native owner or disposal path', () => {
  const source = fs.readFileSync('app/main.dev.js', 'utf8');

  assert(
    !/new MtpSessionService|createMtpBackend|transportSweep|mtpOwner|fileExplorerController/.test(
      source
    )
  );
  assert(/IpcEventService.shared.start\(\{\s*getMainWindow:/.test(source));
  assert(source.includes('async function installExtensions()'));
  assert(source.includes('usbDetect.stopMonitoring()'));
  const controller = fs.readFileSync(
    'app/data/file-explorer/controllers/FileExplorerController.js',
    'utf8'
  );

  assert(controller.includes("process.type === 'browser'"));
});
test('Factory cannot construct adapters in the renderer', () => {
  const { createMtpBackend } = load(
    'app/data/file-explorer/MtpMainBackendFactory.js',
    {},
    { process: { type: 'renderer' } }
  );

  assert.throws(() => createMtpBackend('kalam'));
  assert.throws(() => createMtpBackend('legacy'));
});
test('Toolbar View implementation remains independent of MTP ownership', () => {
  const source = fs.readFileSync(
    'app/containers/HomePage/components/ToolbarAreaPane.jsx',
    'utf8'
  );
  const body = source.slice(
    source.indexOf('_handleViewModeChange ='),
    source.indexOf('_handleViewModeFocus =')
  );

  assert(body.includes('actionCreateFileExplorerListingType'));
  assert(!/initialize|dispose|selectBackend|selectStorage/.test(body));
});

for (const status of [
  'completed',
  'failed',
  'partial',
  'cancelled',
  'unknown',
]) {
  test(`Owner preserves normalized transfer outcome: ${status}`, async () => {
    const f = fixture();

    await f.ready();
    const value = transferHelpers.createTransferResult({
      status,
      backend: 'kalam',
      direction: 'upload',
      backendStopped: true,
      evidence: {
        nativeAcknowledged: status === 'completed',
        cancellationAcknowledged: status === 'cancelled',
      },
      files: {
        requested: ['/a'],
        confirmedCompleted: status === 'partial' ? ['/a'] : null,
      },
    });

    f.setTransferOutcome(value);
    assert.strictEqual(
      (await f.request('transferFiles', { direction: 'upload' })).status,
      status
    );
  });
}

test('Queued admission capacity is bounded while native operation never returns', async () => {
  const f = fixture();

  await f.ready();
  f.setHold(true);
  const first = f.request('listFiles');

  await flush();
  const queued = Array.from({ length: 32 }, () =>
    observed(f.request('listFiles'))
  );

  await assert.rejects(f.request('listFiles'), /capacity/);
  assert.strictEqual(f.service.pending.length, 32);
  f.setHold(false);
  f.held.shift()();
  await first;
  await Promise.all(queued);
});
test('Old generation and clone contexts cannot authorize a native mutation', async () => {
  const f = fixture();

  await f.ready();
  const old = f.service.scope();

  await f.service.close();
  await f.service.request('client', 'initialize', {}, f.service.scope());
  await assert.rejects(
    f.service.request(
      'client',
      'renameFile',
      { storageId: 1, filePath: '/a', newFilename: 'b' },
      old
    ),
    /Obsolete/
  );
  assert(!f.calls.some((call) => call.name === 'renameFile'));
});
test('Stale renderer revision completion preserves clipboard and never refreshes the new view', async () => {
  let current = true;
  const f = uiFixture(
    async (args) => {
      current = false;
      const result = transferHelpers.createTransferResult({
        status: 'completed',
        backend: 'kalam',
        backendStopped: true,
        evidence: { nativeAcknowledged: true },
      });

      args.onCompleted(result);

      return result;
    },
    { scopeCurrent: () => current }
  );

  await f.run();
  assert.strictEqual(f.state.Home.fileTransfer.clipboard, f.originalClipboard);
  assert(
    !f.actions.some(
      (action) => action.type === 'clear' || action.type === 'refresh'
    )
  );
});
test('A new clipboard cannot be cleared by an earlier successful transfer', async () => {
  const replacement = { queue: ['/different'], source: 'local' };
  const f = uiFixture(async (args) => {
    f.state.Home.fileTransfer.clipboard = replacement;
    args.onCompleted(
      transferHelpers.createTransferResult({
        status: 'completed',
        backend: 'kalam',
        backendStopped: true,
        evidence: { nativeAcknowledged: true },
      })
    );
  });

  await f.run();
  assert.strictEqual(f.state.Home.fileTransfer.clipboard, replacement);
  assert(
    !f.actions.some(
      (action) => action.type === 'clear' || action.type === 'refresh'
    )
  );
});
test('Uncertain initialization cannot be replayed or launch diagnostics', async () => {
  const f = fixture();

  f.failInit();
  await assert.rejects(f.service.request('client', 'initialize', {}, null));
  await assert.rejects(
    f.service.request('client', 'fetchDebugReport', {}, f.service.scope())
  );
  assert(!f.calls.some((call) => call.name === 'diagnostic'));
});
test('Unknown file existence cannot become a negative result', async () => {
  const f = fixture();

  await f.ready();
  f.adapter.filesExist = async () => ({
    error: 'transport unknown',
    data: null,
  });
  await assert.rejects(
    f.request('filesExist', { fileList: ['/a'] }),
    /unknown/
  );
});
test('Stale owner snapshots cannot roll back a newer renderer generation', () => {
  const events = load('app/services/ipc-events/IpcEventType.js', {});
  const contract = load('app/data/file-explorer/MtpSessionIpc.js', {
    uuid: { v4: () => 'uuid' },
    '../../services/ipc-events/IpcEventType': events,
    './MtpSessionOwner': owner,
    './MtpOperationQueue': queueModule,
  });
  const { MtpSessionClient } = load(
    'app/data/file-explorer/MtpSessionClient.js',
    {
      uuid: { v4: () => 'renderer' },
      './MtpSessionIpc': contract,
      './MtpSessionTransport': transport,
    },
    { setTimeout }
  );
  const client = new MtpSessionClient({
    ipcRenderer: new EventEmitter(),
    version: 2,
    lifecycleTarget: null,
  });
  const f = fixture();

  client.ownerEpoch = 'owner';
  client.acceptActiveState({ ...f.service.snapshot(), generation: 2 }, 10);
  client.acceptActiveState({ ...f.service.snapshot(), generation: 1 }, 9);
  assert.strictEqual(client._state.generation, 2);
  client.dispose(false);
});

test('Development DLL registration does not eagerly require Koffi or USB', () => {
  const requests = [];
  const context = {
    require: (name) => {
      requests.push(name);

      return {};
    },
  };

  vm.runInNewContext(
    fs.readFileSync('dll/renderer.dev.dll.js', 'utf8'),
    context
  );
  assert.strictEqual(typeof context.renderer, 'function');
  assert.deepStrictEqual(requests, []);
});
test('Kalam constructor permits explorer execution but rejects main and report contexts before loading', () => {
  let loaded = 0;
  const makeKalam = (globals) =>
    load(
      'ffi/kalam/src/Kalam.js',
      {
        koffi: {
          proto: (value) => value,
          load: () => {
            loaded += 1;

            return {};
          },
        },
        '../../../app/data/file-explorer/MtpOperationQueue': queueModule,
        '../../../app/enums/mtpError': {
          MTP_ERROR: { ErrorGeneral: 'ErrorGeneral' },
        },
        '../../../app/helpers/binaries': {
          kalamLibPath: '/mock/never-load.dylib',
        },
        '../../../app/utils/log': { log: baseline.log },
        '../../../app/utils/funcs': baseline.utils,
        '../../../app/utils/checkIf': { checkIf: baseline.checkIf },
        '../../../app/enums': baseline.enums,
        '../../../app/data/file-explorer/transferResult': transferHelpers,
      },
      globals
    ).Kalam;
  const Kalam = makeKalam({ process: { type: 'browser' } });

  assert.throws(() => new Kalam(), /explorer renderer/);
  assert.strictEqual(loaded, 0);
  const ReportKalam = makeKalam({
    process: { type: 'renderer' },
    window: { location: { hash: '#reportBugsPage' } },
  });

  assert.throws(() => new ReportKalam(), /explorer renderer/);
  assert.strictEqual(loaded, 0);
  const ExplorerKalam = makeKalam({
    process: { type: 'renderer' },
    window: { location: { hash: '' } },
  });

  assert(new ExplorerKalam());
  assert.strictEqual(loaded, 1);
});
test('Completed ledger releases promises and large operation arguments', async () => {
  const f = fixture();

  await f.ready();
  await f.request('listFiles');
  await flush();
  for (const job of f.service.jobs.values()) {
    assert.strictEqual(job.promise, null);
    assert.strictEqual(job.resolve, null);
    assert.strictEqual(job.reject, null);
    assert.strictEqual(Object.keys(job.args).length, 0);
  }
});

test('High-rate preprocessing is coalesced without changing terminal success', async () => {
  const f = fixture();

  await f.ready();
  f.adapter.transferFiles = async (args) => {
    for (let i = 0; i < 10000; i += 1)
      args.onPreprocess({ fullPath: `/file-${i}` });
    args.onProgress({ activeFileProgress: 100 });

    return transferHelpers.createTransferResult({
      status: 'completed',
      backend: 'kalam',
      backendStopped: true,
      evidence: { nativeAcknowledged: true },
    });
  };

  const result = await f.request('transferFiles', { direction: 'upload' });

  await flush();
  const job = [...f.service.jobs.values()].find(
    (item) => item.operation === 'transferFiles'
  );

  assert.strictEqual(result.status, 'completed');
  assert.strictEqual(job.deliveryError, null);
  assert.strictEqual(job.events.length, 2);
  assert.strictEqual(job.events[0].data.fullPath, '/file-9999');
});

test('Shutdown can enqueue cleanup when 32 revoked mutations filled the pending queue', async () => {
  const f = fixture();

  await f.ready();
  f.setHold(true);
  const active = f.request('listFiles');

  await flush();
  const queued = Array.from({ length: 32 }, () =>
    observed(f.request('deleteFiles', { fileList: ['/a'] }))
  );
  const shutdown = f.service.shutdown();

  assert.strictEqual(f.service.pending.length, 1);
  assert.strictEqual(f.service.pending[0].operation, '__close');
  f.setHold(false);
  f.held.shift()();
  await active;
  await shutdown;
  assert((await Promise.all(queued)).every((result) => result.error));
  assert.strictEqual(
    f.calls.filter((call) => call.name === 'dispose').length,
    1
  );
  assert(!f.calls.some((call) => call.name === 'deleteFiles'));
});
test('Repeated invalidation cannot revoke already queued owner cleanup', async () => {
  const f = fixture();

  await f.ready();
  f.setHold(true);
  const active = f.request('listFiles');

  await flush();
  const close = f.service.close();

  f.service.invalidate('usb-detached-again');
  f.setHold(false);
  f.held.shift()();
  await active;
  await close;
  assert.strictEqual(f.service.snapshot().state, 'Disconnected');
});

// End-to-end active IPC uses an in-memory sender and the actual client/codec.
test('Active IPC round trip, preprocessing, progress, invalid sender and protocol rejection', async () => {
  const f = fixture();
  const events = load('app/services/ipc-events/IpcEventType.js', {});
  const contract = load('app/data/file-explorer/MtpSessionIpc.js', {
    uuid: { v4: () => 'uuid' },
    '../../services/ipc-events/IpcEventType': events,
    './MtpSessionOwner': owner,
    './MtpOperationQueue': queueModule,
  });
  const { MtpSessionClient } = load(
    'app/data/file-explorer/MtpSessionClient.js',
    {
      uuid: { v4: () => 'renderer' },
      './MtpSessionIpc': contract,
      './MtpSessionTransport': transport,
      './transferResult': transferHelpers,
    },
    { setTimeout }
  );
  const sender = new EventEmitter();

  sender.id = 1;
  sender.mainFrame = {};
  sender.isDestroyed = () => false;
  const renderer = new EventEmitter();

  sender.send = (channel, data) => renderer.emit(channel, {}, data);
  const dispatcher = new contract.MtpSessionIpc({
    ipcMain: {},
    service: f.service,
    transport: new transport.MtpSessionTransport(),
    wire: transport.wireData,
    isAuthorizedSender: (event) => event.sender === sender,
    createId: () => 'epoch',
  });

  renderer.invoke = (_, data) =>
    dispatcher.handle({ sender, senderFrame: sender.mainFrame }, data);
  const client = new MtpSessionClient({
    ipcRenderer: renderer,
    version: 2,
    lifecycleTarget: null,
  });

  await client.connect();
  const init = await client.activeRequest('initialize', {}, f.service.scope());

  assert(init.value.data.mtpDeviceInfo);
  await client.activeRequest('listStorages', {}, f.service.scope());
  const received = [];
  const result = await client.activeRequest(
    'transferFiles',
    { fileList: ['/a'], destination: '/b', storageId: 1, direction: 'upload' },
    f.service.scope(),
    {
      onPreprocess: () => received.push('preprocess'),
      onProgress: () => received.push('progress'),
    }
  );

  assert.strictEqual(result.value.status, 'completed');
  assert(received.includes('preprocess'));
  assert(received.includes('progress'));
  const denied = await dispatcher.handle({ sender: {}, senderFrame: {} }, {});

  assert.strictEqual(denied.ok, false);
  const old = await dispatcher.handle(
    { sender, senderFrame: sender.mainFrame },
    { version: 1, requestId: 'old', rendererId: 'old', ordinal: 1 }
  );

  assert.strictEqual(old.ok, false);
  client.dispose();
  await flush();
});
const initializationError = {
  error: 'LIBUSB_ERROR_NOT_FOUND',
  stderr: 'ErrorMtpDetectFailed',
  data: null,
};
const lifecycleEvidence = (overrides = {}) => ({
  version: 1,
  terminal: true,
  nativeStarted: false,
  nativeReturned: false,
  resources: 'none',
  cleanupAcknowledged: false,
  ...overrides,
});
const invoking = lifecycleEvidence({
  terminal: false,
  nativeStarted: true,
  resources: 'unknown',
});
const returnedUnknown = lifecycleEvidence({
  nativeStarted: true,
  nativeReturned: true,
  resources: 'unknown',
});
const acknowledgedCleanup = lifecycleEvidence({
  nativeStarted: true,
  nativeReturned: true,
  resources: 'closed',
  cleanupAcknowledged: true,
});
const failedInitialization = async (evidence, result = initializationError) => {
  const f = fixture();

  f.failInit(result, evidence);
  const outcome = await observed(
    f.service.request('client', 'initialize', {}, null)
  );

  assert.strictEqual(outcome.error.code, 'MTP_CONNECT_FAILED');
  await flush();

  return { ...f, outcome };
};

test('Pre-invocation failure completes logical closure without disposal', async () => {
  const f = await failedInitialization([lifecycleEvidence()]);

  assert.strictEqual(f.service.snapshot().state, 'Disconnected');
  assert.strictEqual(f.service.quarantine, null);
  assert.strictEqual(f.service.initializationFailure.nativeStarted, false);
  assert.strictEqual(f.service.initializationFailure.nativeReturned, false);
  await f.service.close();
  assert(!f.calls.some((call) => call.name === 'dispose'));
});

test('Returned native initialization failure retains unknown resource quarantine', async () => {
  const f = await failedInitialization([invoking, returnedUnknown]);

  assert.strictEqual(f.queue.active, false);
  assert.strictEqual(f.service.snapshot().activeOperationId, null);
  assert.strictEqual(f.service.snapshot().state, 'Invalidated');
  assert.strictEqual(f.service.initializationFailure.nativeStarted, true);
  assert.strictEqual(f.service.initializationFailure.nativeReturned, true);
  assert.strictEqual(
    f.service.initializationFailure.cleanupAcknowledged,
    false
  );
  assert.strictEqual(f.service.initializationFailure.resources, 'unknown');
  assert(f.service.quarantine);
});

test('Confirmed no-resource native result permits closure only after native return', async () => {
  const f = await failedInitialization([
    invoking,
    lifecycleEvidence({ nativeStarted: true, nativeReturned: true }),
  ]);

  assert.strictEqual(f.service.snapshot().state, 'Disconnected');
  assert.strictEqual(f.service.initializationFailure.resources, 'none');
  assert.strictEqual(
    f.service.initializationFailure.cleanupAcknowledged,
    false
  );
});

test('Trusted adapter cleanup acknowledgement avoids repeated disposal', async () => {
  const f = await failedInitialization([invoking, acknowledgedCleanup]);

  assert.strictEqual(f.service.snapshot().state, 'Disconnected');
  assert.strictEqual(f.service.initializationFailure.cleanupAcknowledged, true);
  await f.service.shutdown();
  assert(!f.calls.some((call) => call.name === 'dispose'));
});

test('Missing lifecycle evidence and native JSON cleanup claims remain uncertain', async () => {
  const f = await failedInitialization([], {
    ...initializationError,
    lifecycleEvidence: acknowledgedCleanup,
    cleanupAcknowledged: true,
  });

  assert(f.service.quarantine);
  assert.strictEqual(f.service.initializationFailure.evidenceValid, false);
  assert.strictEqual(f.service.initializationFailure.nativeStarted, null);
  assert.strictEqual(
    f.service.initializationFailure.cleanupAcknowledged,
    false
  );
});

[
  null,
  {},
  lifecycleEvidence({ nativeReturned: 'yes' }),
  lifecycleEvidence({ cleanupAcknowledged: true }),
  lifecycleEvidence({ nativeStarted: true }),
].forEach((evidence, index) => {
  test(`Malformed lifecycle evidence ${index} cannot authorize cleanup`, async () => {
    const f = await failedInitialization([evidence, lifecycleEvidence()]);

    assert(f.service.quarantine);
    assert.strictEqual(f.service.initializationFailure.evidenceValid, false);
    await assert.rejects(f.service.close());
    assert(!f.calls.some((call) => call.name === 'dispose'));
  });
});

test('Conflicting terminal lifecycle evidence is sticky and prevents recovery', async () => {
  const f = await failedInitialization([
    invoking,
    acknowledgedCleanup,
    returnedUnknown,
    acknowledgedCleanup,
  ]);

  assert(f.service.quarantine);
  assert.strictEqual(f.service.initializationFailure.evidenceValid, false);
});

test('Identical duplicate lifecycle acknowledgements settle safely once', async () => {
  const f = await failedInitialization([
    invoking,
    acknowledgedCleanup,
    { ...acknowledgedCleanup },
  ]);

  assert.strictEqual(f.service.snapshot().state, 'Disconnected');
  assert.strictEqual(f.service.initializationFailure.evidenceValid, true);
});

test('Never-returning initialization retains ownership and blocks retry and shutdown', async () => {
  const f = fixture();

  f.failInit(initializationError, [invoking, returnedUnknown]);
  f.setHold(true);
  const init = observed(f.service.request('client', 'initialize', {}, null));

  await flush();
  const retry = observed(
    f.service.request('client', 'initialize', {}, f.service.scope())
  );
  const shutdown = observed(f.service.shutdown());

  await flush();
  assert.strictEqual(f.queue.active, true);
  assert(f.service.snapshot().activeOperationId);
  assert.strictEqual(
    f.calls.filter((call) => call.name === 'initialize').length,
    1
  );
  assert(!f.calls.some((call) => call.name === 'dispose'));
  // Simulate eventual return to settle mock promises; never force release.
  f.held.shift()();
  assert((await init).error);
  assert((await retry).error);
  assert((await shutdown).error);
  assert(!f.calls.some((call) => call.name === 'dispose'));
});

test('Safe explicit retry creates a new generation and never replays mutations', async () => {
  const f = await failedInitialization([lifecycleEvidence()]);
  const oldScope = f.service.scope();

  f.recoverInit();
  await f.service.request('client', 'initialize', {}, oldScope);
  assert.strictEqual(f.service.snapshot().generation, oldScope.generation + 1);
  await assert.rejects(
    f.service.request('client', 'deleteFiles', { fileList: ['/a'] }, oldScope)
  );
  assert(!f.calls.some((call) => call.name === 'deleteFiles'));
  assert.strictEqual(
    f.calls.filter((call) => call.name === 'factory').length,
    1
  );
});

test('Duplicate explicit retries share one fresh initialization', async () => {
  const f = await failedInitialization([lifecycleEvidence()]);

  f.recoverInit();
  f.setHold(true);
  const scope = f.service.scope();
  const first = f.service.request('client', 'initialize', {}, scope);
  const second = f.service.request('client', 'initialize', {}, scope);

  await flush();
  assert.strictEqual(
    f.calls.filter((call) => call.name === 'initialize').length,
    2
  );
  assert.strictEqual(f.service.snapshot().generation, 2);
  f.held.shift()();
  await Promise.all([first, second]);
});

test('Cleanup admitted before initialization failure is denied at execution', async () => {
  const f = fixture();

  f.failInit(initializationError, [invoking, returnedUnknown]);
  f.setHold(true);
  const init = observed(f.service.request('client', 'initialize', {}, null));

  await flush();
  const cleanup = observed(f.service.close());

  assert.strictEqual(f.service.pending[0].operation, '__close');
  f.held.shift()();
  assert((await init).error);
  assert.strictEqual((await cleanup).error.code, 'MTP_SESSION_QUARANTINED');
  assert(!f.calls.some((call) => call.name === 'dispose'));
  assert(f.service.quarantine);
});

test('Shutdown queued during a proven no-resource failure needs no disposal', async () => {
  const f = fixture();

  f.failInit(initializationError, [lifecycleEvidence()]);
  f.setHold(true);
  const init = observed(f.service.request('client', 'initialize', {}, null));

  await flush();
  const shutdown = f.service.shutdown();

  f.held.shift()();
  assert((await init).error);
  await shutdown;
  assert.strictEqual(f.service.snapshot().state, 'Disconnected');
  assert(!f.calls.some((call) => call.name === 'dispose'));
});

test('Repeated shutdown after uncertain initialization never repeats disposal', async () => {
  const f = await failedInitialization([invoking, returnedUnknown]);
  const first = f.service.shutdown();
  const second = f.service.shutdown();

  assert.strictEqual(first, second);
  await assert.rejects(first);
  await assert.rejects(f.service.shutdown());
  assert(!f.calls.some((call) => call.name === 'dispose'));
});

for (const safe of [false, true]) {
  test(`Backend switching after initialization failure: safe=${safe}`, async () => {
    const f = await failedInitialization([
      safe ? lifecycleEvidence() : returnedUnknown,
    ]);
    const change = f.service.request(
      'client',
      'selectBackend',
      { backend: 'legacy' },
      f.service.scope()
    );

    if (safe) {
      await change;
      assert.strictEqual(f.service.selectedBackend, 'legacy');
    } else {
      await assert.rejects(change);
      assert.strictEqual(f.service.selectedBackend, 'kalam');
    }

    assert(!f.calls.some((call) => call.name === 'dispose'));
    assert.strictEqual(
      f.calls.filter((call) => call.name === 'factory').length,
      1
    );
  });
}

test('Renderer reload cannot reset main-owner quarantine', async () => {
  const f = await failedInitialization([returnedUnknown]);

  f.service.revoke('client');
  await flush();
  await assert.rejects(
    f.service.request('replacement', 'initialize', {}, f.service.scope())
  );
  assert(f.service.quarantine);
  assert.strictEqual(f.service.snapshot().generation, 1);
  assert(!f.calls.some((call) => call.name === 'dispose'));
});

test('Quarantined initialization denies diagnostics and USB reconnect retry', async () => {
  const f = await failedInitialization([returnedUnknown]);

  await assert.rejects(
    f.service.request('client', 'fetchDebugReport', {}, f.service.scope())
  );
  f.service.invalidate('usb-detached');
  await assert.rejects(
    f.service.request('client', 'initialize', {}, f.service.scope())
  );
  assert(
    !f.calls.some((call) => ['diagnostic', 'dispose'].includes(call.name))
  );
  assert.strictEqual(
    f.calls.filter((call) => call.name === 'initialize').length,
    1
  );
});

test('Pre-invocation evidence cannot erase earlier uncertain resource ownership', async () => {
  const f = fixture();

  f.service.resources = 'unknown';
  f.failInit(initializationError, [lifecycleEvidence()]);
  await assert.rejects(f.service.request('client', 'initialize', {}, null));
  assert(f.service.quarantine);
  assert.strictEqual(f.service.resources, 'unknown');
  assert.strictEqual(f.calls.length, 0);
});

test('Initialization evidence and retained failure messages are bounded plain data', async () => {
  const f = await failedInitialization([returnedUnknown], {
    error: new Error(`native failure ${'x'.repeat(100000)}`),
    stderr: 'ErrorNative'.repeat(10000),
    data: null,
    pointer: { native: true },
  });
  const details = f.service.initializationFailure;

  assert.strictEqual(details.message.length, 2048);
  assert.strictEqual(details.errorType.length, 128);
  assert(f.outcome.error.message.length < 4000);
  assert.strictEqual(
    JSON.stringify(transport.wireData(details)),
    JSON.stringify(details)
  );
  assert(!Object.prototype.hasOwnProperty.call(details, 'pointer'));
});

for (const operation of ['fetchDebugReport', 'selectBackend']) {
  test(`Previously admitted ${operation} cannot bypass later initialization quarantine`, async () => {
    const f = fixture();

    f.failInit(initializationError, [invoking, returnedUnknown]);
    f.setHold(true);
    const init = observed(f.service.request('client', 'initialize', {}, null));

    await flush();
    const transition = observed(
      f.service.request(
        'client',
        operation,
        { backend: 'legacy' },
        f.service.scope()
      )
    );

    await flush();
    assert.strictEqual(f.service.pending.length, 1);
    f.held.shift()();
    assert((await init).error);
    assert((await transition).error);
    assert.strictEqual(f.service.selectedBackend, 'kalam');
    assert(
      !f.calls.some((call) => ['diagnostic', 'dispose'].includes(call.name))
    );
    assert.strictEqual(
      f.calls.filter((call) => call.name === 'factory').length,
      1
    );
  });
}

test('Factory exception without boundary evidence cannot prove resource absence', async () => {
  const f = fixture();

  f.service.backendFactory = () => {
    throw new Error('Native loader setup failed');
  };

  await assert.rejects(f.service.request('client', 'initialize', {}, null));
  assert(f.service.quarantine);
  assert.strictEqual(f.service.initializationFailure.nativeStarted, null);
  await assert.rejects(f.service.shutdown());
  assert(!f.calls.some((call) => call.name === 'dispose'));
});

test('A settled submission error without native return cannot authorize recovery', async () => {
  const f = await failedInitialization([
    invoking,
    { ...invoking, terminal: true },
  ]);

  assert.strictEqual(f.service.initializationFailure.nativeStarted, true);
  assert.strictEqual(f.service.initializationFailure.nativeReturned, false);
  await assert.rejects(
    f.service.request('client', 'initialize', {}, f.service.scope())
  );
  await assert.rejects(f.service.shutdown());
  assert(!f.calls.some((call) => call.name === 'dispose'));
});

test('Stale lifecycle acknowledgement cannot change a newer active generation', async () => {
  const f = await failedInitialization([lifecycleEvidence()]);
  const oldReporter = f.getInitReporter();

  f.recoverInit();
  f.setHold(true);
  const retry = f.service.request(
    'client',
    'initialize',
    {},
    f.service.scope()
  );

  await flush();
  oldReporter(acknowledgedCleanup);
  assert.strictEqual(f.service.snapshot().generation, 2);
  assert.strictEqual(f.service.resources, 'unknown');
  assert(f.service.snapshot().activeOperationId);
  f.held.shift()();
  await retry;
  assert.strictEqual(f.service.snapshot().state, 'Ready');
});

test('Legacy operation failure preserves process-close cleanup compatibility', async () => {
  const f = fixture('legacy');

  await f.ready();
  f.setTransferOutcome(
    transferHelpers.createTransferResult({
      status: 'failed',
      backend: 'legacy',
      direction: 'upload',
      backendStopped: true,
      error: 'Original CLI failure',
      evidence: { exitCode: 1, signal: null },
    })
  );
  const result = await f.request('transferFiles', { direction: 'upload' });

  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(f.service.quarantine, null);
  await f.service.close();
  assert.strictEqual(f.service.snapshot().state, 'Disconnected');
  assert(!f.calls.some((call) => call.name === 'dispose'));
});

(async () => {
  let passed = 0;

  for (const { name, run } of tests) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await run();
      passed += 1;
      console.info(`PASS ${name}`);
    } catch (error) {
      console.error(`FAIL ${name}`, error);
      process.exitCode = 1;
    }
  }

  console.info(`${passed}/${tests.length} MTP ownership-cutover tests passed.`);
})();
