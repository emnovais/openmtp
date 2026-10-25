/* Offline cross-endpoint reliability checks. No physical backend is loaded. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const babel = require('@babel/core');
const {
  load,
  enums,
  utils,
  checkIf,
  log,
  transferHelpers,
  legacyFixture,
  uiFixture,
} = require('./transfer-reliability.test');

const tests = [];
const test = (name, run) => tests.push({ name, run });
const defer = () => {
  let complete;
  const promise = new Promise((resolve) => {
    complete = resolve;
  });

  return { promise, resolve: complete };
};
const source = fs.readFileSync(
  path.join(
    __dirname,
    '../app/containers/HomePage/components/FileExplorer.jsx'
  ),
  'utf8'
);
const ast = babel.parseSync(source, {
  configFile: false,
  babelrc: false,
  parserOpts: { plugins: ['jsx', 'classProperties'] },
});
const component = ast.program.body.find(
  (n) => n.type === 'ClassDeclaration' && n.id.name === 'FileExplorer'
);
const methods = component.body.body
  .filter((n) => ['_handlePaste', '_handlePasteConfirm'].includes(n.key.name))
  .map((n) => source.slice(n.start, n.end))
  .join('\n');

function pasteFixture({
  destination = 'mtp',
  exists = false,
  queue = ['/source/a.jpg'],
  sourceType = destination === 'mtp' ? 'local' : 'mtp',
} = {}) {
  let scope = {
    generation: 1,
    backend: 'legacy',
    storageId: 1,
    storageRevision: 1,
  };
  const current = (v) =>
    !!v && Object.keys(scope).every((k) => scope[k] === v[k]);
  const calls = [];
  const prepared = [];
  const alerts = [];
  const dialogs = [];
  const ui = vm.runInNewContext(`new (class { ${methods} })()`, {
    path,
    baseName: path.posix.basename,
    DEVICE_TYPE: enums.DEVICE_TYPE,
    captureMtpScope: () => ({ ...scope }),
    isCurrentMtpScope: current,
    analyticsService: { sendEvent() {} },
    EVENT_TYPE: {},
  });

  ui.props = {
    deviceType: destination,
    currentBrowsePath: { mtp: '/destination', local: '/destination' },
    storageId: 1,
    hideHiddenFiles: { mtp: false, local: false },
    fileTransferClipboard: {
      source: sourceType,
      queue,
      mtpScope: { ...scope },
    },
    actionCreatePaste: (...args) => prepared.push(args),
    actionCreateThrowError: (v) => alerts.push(v),
    fileTransferProgess: { toggle: false },
  };
  ui._filesExist = async (args) => {
    calls.push(args);

    return typeof exists === 'function' ? exists(args) : exists;
  };

  ui._handleTogglePasteConfirmDialog = (v) => dialogs.push(v);

  return {
    ui,
    calls,
    prepared,
    alerts,
    dialogs,
    changeScope: (v) => {
      scope = { ...scope, ...v };
    },
  };
}

for (const destination of ['local', 'mtp']) {
  test(`${destination}: known absent is a cross-endpoint copy`, async () => {
    const f = pasteFixture({ destination });

    await f.ui._handlePaste();
    assert.strictEqual(f.prepared.length, 1);
    assert.strictEqual(f.prepared[0][2], destination);
  });
  test(`${destination}: same-endpoint Paste is denied at the handler`, async () => {
    const f = pasteFixture({ destination, sourceType: destination });

    await f.ui._handlePaste();
    assert.strictEqual(f.calls.length, 0);
    assert.strictEqual(f.prepared.length, 0);
  });
  test(`${destination}: confirmation cancellation cannot later authorize copy`, async () => {
    const f = pasteFixture({ destination, exists: true });

    await f.ui._handlePaste();
    f.ui._handlePasteConfirm(false);
    f.ui._handlePasteConfirm(true);
    assert.strictEqual(f.prepared.length, 0);
  });
  test(`${destination}: duplicate confirmation starts once`, async () => {
    const f = pasteFixture({ destination, exists: true });

    await f.ui._handlePaste();
    f.ui._handlePasteConfirm(true);
    f.ui._handlePasteConfirm(true);
    assert.strictEqual(f.prepared.length, 1);
  });
  for (const drift of [
    'directory',
    'clipboard',
    'queue',
    'storage',
    'generation',
    'backend',
  ]) {
    test(`${destination}: Replace cannot authorize ${drift} drift`, async () => {
      const f = pasteFixture({ destination, exists: true });

      await f.ui._handlePaste();
      if (drift === 'directory')
        f.ui.props.currentBrowsePath = {
          ...f.ui.props.currentBrowsePath,
          [destination]: '/other',
        };
      if (drift === 'clipboard')
        f.ui.props.fileTransferClipboard = {
          ...f.ui.props.fileTransferClipboard,
          queue: ['/source/b.jpg'],
        };
      if (drift === 'queue')
        f.ui.props.fileTransferClipboard.queue.push('/source/b.jpg');
      if (drift === 'storage') f.ui.props.storageId = 2;
      if (drift === 'generation') f.changeScope({ generation: 2 });
      if (drift === 'backend') f.changeScope({ backend: 'kalam' });
      f.ui._handlePasteConfirm(true);
      assert.strictEqual(f.prepared.length, 0);
    });
  }

  for (const queue of [
    ['/one/a.jpg', '/two/a.jpg'],
    ['/one/A.jpg', '/two/a.jpg'],
    [],
    ['relative'],
    ['/source/../a.jpg'],
  ]) {
    test(`${destination}: ambiguous or invalid source mapping ${JSON.stringify(
      queue
    )} is denied`, async () => {
      const f = pasteFixture({ destination, queue });

      await f.ui._handlePaste();
      assert.strictEqual(f.calls.length, 0);
      assert.strictEqual(f.prepared.length, 0);
    });
  }

  test(`${destination}: navigation during lookup cannot copy to the new path`, async () => {
    const d = defer();
    const f = pasteFixture({ destination, exists: () => d.promise });
    const running = f.ui._handlePaste();

    f.ui.props.currentBrowsePath = {
      ...f.ui.props.currentBrowsePath,
      [destination]: '/other',
    };
    d.resolve(false);
    await running;
    assert.strictEqual(f.prepared.length, 0);
  });
  test(`${destination}: stale preflight cannot reopen a newer cancelled dialog`, async () => {
    const a = defer();
    const b = defer();
    let count = 0;
    const f = pasteFixture({
      destination,
      exists: () => {
        count += 1;

        return count === 1 ? a.promise : b.promise;
      },
    });
    const first = f.ui._handlePaste();
    const second = f.ui._handlePaste();

    b.resolve(true);
    await second;
    f.ui._handlePasteConfirm(false);
    a.resolve(true);
    await first;
    assert.strictEqual(f.dialogs.filter(Boolean).length, 1);
    f.ui._handlePasteConfirm(true);
    assert.strictEqual(f.prepared.length, 0);
  });
  test(`${destination}: view and selection changes keep a valid confirmation`, async () => {
    const f = pasteFixture({ destination, exists: true });

    await f.ui._handlePaste();
    f.ui.props.view = 'grid';
    f.ui.props.selected = ['/another'];
    f.ui._handlePasteConfirm(true);
    assert.strictEqual(f.prepared.length, 1);
  });
}

for (const direction of ['upload', 'download']) {
  test(`Legacy ${direction}: shell substitutions stay literal argv`, async () => {
    const f = legacyFixture();
    const sourcePath = '/source/$(touch never)`id` a.jpg';
    const promise = f.source.transferFiles({
      destination: '/destination',
      fileList: [sourcePath],
      direction,
      storageId: 1,
      ...f.events,
    });

    f.child.emit('close', 0, null);
    const result = await promise;

    assert.strictEqual(f.calls.length, 1);
    assert.strictEqual(f.calls[0][0], '/mock/never-execute');
    assert.strictEqual(f.calls[0][2].shell, false);
    assert.deepStrictEqual(Array.from(f.calls[0][1]), [
      '-e',
      'storage 1',
      direction === 'upload'
        ? `put "${sourcePath}" "/destination"`
        : `get "${sourcePath}" "/destination/$(touch never)\`id\` a.jpg"`,
    ]);
    assert.strictEqual(result.status, 'completed');
  });
  for (const item of [
    '/source/a"b.jpg',
    '/source/a\\b.jpg',
    '/source/a\nb.jpg',
  ]) {
    test(`Legacy ${direction}: unsafe CLI grammar is refused before spawn ${JSON.stringify(
      item
    )}`, async () => {
      const f = legacyFixture();
      const pending = f.source.transferFiles({
        destination: '/destination',
        fileList: [item],
        direction,
        storageId: 1,
        ...f.events,
      });

      if (f.calls.length) f.child.emit('close', 0, null);
      const result = await pending;

      assert.strictEqual(f.calls.length, 0);
      assert.notStrictEqual(result.status, 'completed');
    });
  }
}

test('Legacy USB diagnostics remain unknown through actual close', async () => {
  const f = legacyFixture();
  const promise = f.start();
  const text =
    'Device::Find failed:(*_interface)->USBInterfaceOpen(_interface): error 0xe00002c5\n'.repeat(
      7
    );

  f.stderr(text);
  assert.strictEqual(f.events.completed.length, 0);
  f.child.emit('exit', 0, null);
  assert.strictEqual(f.events.errors.length, 0);
  f.child.emit('close', 0, null);
  const r = await promise;

  assert.strictEqual(r.status, 'unknown');
  assert.strictEqual(r.stderr, text.trimEnd());
  assert.strictEqual(f.events.completed.length, 0);
  assert.strictEqual(f.events.errors.length, 1);
});
function controllerFixture({
  direction = 'upload',
  lookup = async () => true,
  backend = 'legacy',
  status = 'completed',
  sources = ['/source/a.jpg', '/source/b.png'],
} = {}) {
  const checks = [];
  const payloads = [];
  const events = [];
  const stopped = defer();
  const terminal = transferHelpers.createTransferResult({
    status,
    backend,
    direction,
    backendStopped: true,
    evidence:
      backend === 'legacy'
        ? { exitCode: 0, signal: null }
        : { nativeAcknowledged: true },
  });
  const Controller = load(
    'app/data/file-explorer/controllers/FileExplorerController.js',
    {
      path,
      '../repositories/FileExplorerRepository': {
        FileExplorerRepository: class {
          async transferFiles(args) {
            payloads.push(args);

            return stopped.promise;
          }

          async filesExist(args) {
            checks.push(args);

            return lookup(args, checks.length);
          }
        },
      },
      '../../../utils/checkIf': { checkIf },
      '../../../services/analytics': { analyticsService: { sendEvent() {} } },
      '../../../enums/events': { EVENT_TYPE: {} },
      '../../../helpers/processBufferOutput': {},
      '../../../helpers/settings': { getMtpModeSetting: () => backend },
      '../../../enums': enums,
      '../../../utils/date': { unixTimestampNow: () => 1 },
      '../../../utils/log': { log },
      '../transferResult': transferHelpers,
    }
  ).default;
  const run = () =>
    Controller.transferFiles({
      deviceType: 'mtp',
      destination: '/destination',
      direction,
      storageId: 1,
      fileList: sources,
      onError: (r) => events.push({ type: 'error', result: r }),
      onCompleted: (r) => events.push({ type: 'completed', result: r }),
      onProgress() {},
      onPreprocess() {},
    });

  return { run, stopped, terminal, checks, payloads, events, sources };
}

for (const backend of ['legacy', 'kalam'])
  for (const direction of ['upload', 'download']) {
    test(`${backend} ${direction}: completion requires every destination after backend stop`, async () => {
      const f = controllerFixture({ backend, direction });
      const running = f.run();

      assert.strictEqual(f.checks.length, 0);
      f.stopped.resolve(f.terminal);
      const r = await running;

      assert.strictEqual(f.checks.length, 2);
      assert(
        f.checks.every(
          (c) =>
            c.deviceType === (direction === 'upload' ? 'mtp' : 'local') &&
            c.fileList.length === 1
        )
      );
      assert.strictEqual(r.status, 'completed');
      assert.strictEqual(r.evidence.destinationPresence, 'confirmed');
      assert.strictEqual(r.evidence.contentVerified, false);
      assert.strictEqual(f.events.length, 1);
    });
    for (const failure of [false, { error: 'EIO' }, null]) {
      test(`${backend} ${direction}: missing/unknown destination never reports success ${JSON.stringify(
        failure
      )}`, async () => {
        const f = controllerFixture({
          backend,
          direction,
          lookup: async (_, n) => (n === 1 ? true : failure),
        });
        const p = f.run();

        f.stopped.resolve(f.terminal);
        const r = await p;

        assert.notStrictEqual(r.status, 'completed');
        assert.strictEqual(f.events[0].type, 'error');
        assert.strictEqual(r.destinationMayContainPartialData, true);
      });
    }

    test(`${backend} ${direction}: failure performs no verification/retry`, async () => {
      const f = controllerFixture({ backend, direction, status: 'failed' });
      const p = f.run();

      f.stopped.resolve(f.terminal);
      const r = await p;

      assert.strictEqual(r.status, 'failed');
      assert.strictEqual(f.checks.length, 0);
      assert.strictEqual(f.payloads.length, 1);
    });
  }

test('Controller refuses a second transfer until backend and verification finish', async () => {
  const f = controllerFixture();
  const first = f.run();
  const second = f.run();

  f.stopped.resolve(f.terminal);
  const refused = await second;

  assert.strictEqual(refused.status, 'failed');
  assert.strictEqual(refused.reason, 'transfer-busy');
  assert.strictEqual(f.payloads.length, 1);
  f.stopped.resolve(f.terminal);
  assert.strictEqual((await first).status, 'completed');
});
test('Controller freezes sources before awaiting backend execution', async () => {
  const f = controllerFixture();
  const p = f.run();

  f.sources[0] = '/changed/else.jpg';
  assert.strictEqual(f.payloads[0].fileList[0], '/source/a.jpg');
  f.stopped.resolve(f.terminal);
  await p;
  assert.strictEqual(f.checks[0].fileList[0], '/destination/a.jpg');
});
for (const sources of [[], ['relative'], ['/one/a.jpg', '/two/a.jpg']])
  test(`Controller rejects invalid mapping before payload ${JSON.stringify(
    sources
  )}`, async () => {
    const f = controllerFixture({ sources });
    const p = f.run();

    f.stopped.resolve(f.terminal);
    await p;
    assert.strictEqual(f.payloads.length, 0);
  });

for (const sourceType of ['mtp', 'invalid'])
  test(`Transfer action refuses invalid source endpoint ${sourceType}`, async () => {
    let starts = 0;
    const f = uiFixture(async () => {
      starts += 1;
    });

    f.state.Home.fileTransfer.clipboard.source = sourceType;
    await f.run();
    assert.strictEqual(starts, 0);
    assert.strictEqual(
      f.state.Home.fileTransfer.clipboard,
      f.originalClipboard
    );
  });
test('Transfer action refuses a changed destination before entering controller', async () => {
  let starts = 0;
  const f = uiFixture(async () => {
    starts += 1;
  });

  f.state.Home.currentBrowsePath.mtp = '/changed';
  await f.run();
  assert.strictEqual(starts, 0);
});
// Deferred results exercise the actual local navigation action.
test('Local directory navigation commits only the latest result', async () => {
  const requests = [];
  const prefixer = load('app/helpers/reducerPrefixer.js', {}).default;
  const scope = { generation: 1 };
  const actions = load('app/containers/HomePage/actions.js', {
    '../../data/file-explorer/repositories/FileExplorerRepository': {
      captureMtpScope: () => scope,
      isCurrentMtpScope: () => true,
      isMatchingMtpScope: () => true,
    },
    '../../helpers/reducerPrefixer': { default: prefixer, __esModule: true },
    '../Alerts/actions': { throwAlert: () => ({ type: 'alert' }) },
    '../../helpers/processBufferOutput': {
      processMtpBuffer: () => ({}),
      processLocalBuffer: () => ({}),
    },
    '../../utils/funcs': utils,
    '../../enums': enums,
    '../../utils/log': { log },
    '../../data/file-explorer/controllers/FileExplorerController': {
      listFiles: () => {
        const d = defer();

        requests.push(d);

        return d.promise;
      },
    },
    '../../utils/checkIf': { checkIf },
    '../../enums/mtpError': { MTP_ERROR: {} },
    '../../constants': { DEVICES_DEFAULT_PATH: { local: '/local', mtp: '/' } },
    '../../services/analytics': { analyticsService: {} },
  });
  const emitted = [];
  const state = { Settings: { mtpMode: 'legacy' } };
  const dispatch = (a) => {
    emitted.push(a);
  };
  const first = actions.listDirectory(
    { filePath: '/old', ignoreHidden: false },
    'local',
    () => state
  )(dispatch);
  const second = actions.listDirectory(
    { filePath: '/new', ignoreHidden: false },
    'local',
    () => state
  )(dispatch);

  requests[1].resolve({ data: [], error: null });
  await second;
  const count = emitted.length;

  requests[0].resolve({ data: [], error: null });
  await first;
  assert.strictEqual(emitted.length, count);
});
for (const destination of ['local', 'mtp']) {
  test(`${destination}: late existing lookup cannot open Replace in another directory`, async () => {
    const d = defer();
    const f = pasteFixture({ destination, exists: () => d.promise });
    const p = f.ui._handlePaste();

    f.ui.props.currentBrowsePath = {
      ...f.ui.props.currentBrowsePath,
      [destination]: '/elsewhere',
    };
    d.resolve(true);
    await p;
    assert.strictEqual(f.dialogs.filter(Boolean).length, 0);
    assert.strictEqual(f.prepared.length, 0);
  });
  test(`${destination}: destroyed renderer consumer cannot revive a pending paste`, async () => {
    const d = defer();
    const f = pasteFixture({ destination, exists: () => d.promise });
    const p = f.ui._handlePaste();

    f.ui.pastePlan = null;
    d.resolve(true);
    await p;
    assert.strictEqual(f.prepared.length, 0);
    assert.strictEqual(f.dialogs.filter(Boolean).length, 0);
  });
}

test('Controller keeps transfer admission closed during an unresolved destination lookup', async () => {
  const d = defer();
  const f = controllerFixture({ lookup: () => d.promise });
  const first = f.run();

  f.stopped.resolve(f.terminal);
  await new Promise(setImmediate);
  assert.strictEqual(f.checks.length, 1);
  const busy = await f.run();

  assert.strictEqual(busy.reason, 'transfer-busy');
  assert.strictEqual(f.payloads.length, 1);
  d.resolve(true);
  assert.strictEqual((await first).status, 'completed');
});
test('Controller preserves stopped-backend evidence when destination verification throws', async () => {
  const f = controllerFixture({
    lookup: async () => {
      throw new Error('EIO');
    },
  });
  const p = f.run();

  f.stopped.resolve(f.terminal);
  const result = await p;

  assert.strictEqual(result.status, 'unknown');
  assert.strictEqual(result.backendStopped, true);
  assert.strictEqual(result.evidence.contentVerified, false);
  assert.strictEqual(f.events.filter((e) => e.type === 'completed').length, 0);
});
test('A refused second transfer cannot close the first operation progress', async () => {
  const f = uiFixture(async () => {
    throw new Error('Another transfer is still active.');
  });

  f.state.Home.fileTransfer.progress = {
    toggle: true,
    operationId: 'older-active-transfer',
  };
  await f.run();
  assert.strictEqual(f.state.Home.fileTransfer.progress.toggle, true);
  assert.strictEqual(
    f.state.Home.fileTransfer.progress.operationId,
    'older-active-transfer'
  );
  assert.strictEqual(f.windowProgress.length, 0);
});
test('Verification failure remains visible if readiness is lost in the same session', async () => {
  let ready = true;
  const failure = transferHelpers.createTransferResult({
    status: 'unknown',
    backend: 'kalam',
    backendStopped: true,
    error: 'Destination lookup failed',
  });
  const f = uiFixture(
    async (args) => {
      ready = false;
      args.onError(failure);

      return failure;
    },
    { scopeCurrent: () => ready }
  );

  await f.run();
  assert.strictEqual(f.actions.filter((a) => a.type === 'alert').length, 1);
  assert.strictEqual(f.state.Home.fileTransfer.clipboard, f.originalClipboard);
  assert(!f.actions.some((a) => a.type === 'clear' || a.type === 'refresh'));
});
test('A verification failure cannot update a different session UI', async () => {
  let generation = 1;
  const failure = transferHelpers.createTransferResult({
    status: 'unknown',
    backend: 'kalam',
    backendStopped: true,
    error: 'Old lookup failed',
  });
  const f = uiFixture(
    async (args) => {
      generation = 2;
      args.onError(failure);

      return failure;
    },
    {
      scopeCurrent: () => generation === 1,
      scopeCapture: () => ({ generation }),
    }
  );

  await f.run();
  assert.strictEqual(f.actions.filter((a) => a.type === 'alert').length, 0);
  assert.strictEqual(f.state.Home.fileTransfer.clipboard, f.originalClipboard);
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

  console.info(`${passed}/${tests.length} cross-endpoint safety tests passed.`);
})();
