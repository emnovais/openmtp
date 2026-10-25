/* Run with Node 16: NODE_ENV=test node tests/mtp-session-ipc.test.js */
const assert = require('assert');
const { EventEmitter } = require('events');
const {
  load,
  queueModule,
  transferHelpers,
} = require('./transfer-reliability.test');

// No fallback require is available to evaluated app modules. A native, adapter,
// Electron, USB, or child-process import would fail instead of doing real I/O.
let ids = 0;
const uuid = {
  v4: () => {
    ids += 1;

    return `mock-uuid-${ids}`;
  },
};
const eventModule = load('app/services/ipc-events/IpcEventType.js', {});
const ownerModule = load('app/data/file-explorer/MtpSessionOwner.js', {});
const contract = load('app/data/file-explorer/MtpSessionIpc.js', {
  uuid,
  '../../services/ipc-events/IpcEventType': eventModule,
  './MtpSessionOwner': ownerModule,
  './MtpOperationQueue': queueModule,
});
const { MtpSessionClient } = load(
  'app/data/file-explorer/MtpSessionClient.js',
  {
    uuid,
    './MtpSessionIpc': contract,
    './MtpSessionTransport': load(
      'app/data/file-explorer/MtpSessionTransport.js',
      {}
    ),
  }
);
const {
  MtpSessionIpc,
  MTP_SESSION_CHANNELS,
  MTP_SESSION_OPERATIONS,
  cloneMtpData,
  isAuthorizedMtpSender,
} = contract;
const tests = [];
const test = (name, run) => tests.push({ name, run });
const flush = () => new Promise((resolve) => setImmediate(resolve));
const observe = (promise) =>
  promise.then(
    (value) => ({ value }),
    (error) => ({ error })
  );
const appUrl = 'file:///mock/app/app.html';

function fixture() {
  const handlers = new Map();
  const ipcMain = {
    handle(channel, handler) {
      assert(!handlers.has(channel));
      handlers.set(channel, handler);
    },
    removeHandler(channel) {
      handlers.delete(channel);
    },
    on() {},
  };
  const renderer = new EventEmitter();
  const sender = new EventEmitter();

  ids += 1;
  sender.id = ids;
  sender.mainFrame = { url: appUrl };
  sender.dead = false;
  sender.isDestroyed = () => sender.dead;
  sender.send = (channel, payload) =>
    renderer.emit(channel, {}, cloneMtpData(payload));
  const mainWindow = { webContents: sender };
  const calls = [];
  const held = [];
  let hold = false;
  let factoryCalls = 0;
  const service = new MtpSessionIpc({
    ipcMain,
    createId: uuid.v4,
    isAuthorizedSender: (event) =>
      isAuthorizedMtpSender(event, mainWindow, appUrl),
    backendFactory() {
      factoryCalls += 1;
      throw new Error('Backend construction forbidden');
    },
  });
  const event = () => ({ sender, senderFrame: sender.mainFrame });

  service.start();
  renderer.invoke = (channel, payload) => {
    const request = cloneMtpData(payload);

    calls.push(request);
    const result = handlers.get(channel)(event(), request);

    if (!hold) return Promise.resolve(result);

    return new Promise((resolve, reject) =>
      held.push({ request, result, resolve, reject })
    );
  };

  const lifecycle = new EventEmitter();

  lifecycle.addEventListener = lifecycle.on.bind(lifecycle);
  lifecycle.removeEventListener = lifecycle.removeListener.bind(lifecycle);
  const makeClient = (options = {}) =>
    new MtpSessionClient({
      ipcRenderer: renderer,
      createId: uuid.v4,
      lifecycleTarget: lifecycle,
      ...options,
    });
  const client = makeClient();
  const emit = (requestId, type, data, overrides = {}) => {
    const current = service.clients.get(sender.id);

    current.sequence += 1;
    const payload = {
      version: 1,
      type,
      requestId,
      rendererId: current.rendererId,
      clientEpoch: current.clientEpoch,
      ownerEpoch: service.ownerEpoch,
      sequence: current.sequence,
      data,
      ...overrides,
    };

    renderer.emit(MTP_SESSION_CHANNELS.event, {}, payload);

    return payload;
  };

  return {
    service,
    sender,
    client,
    renderer,
    lifecycle,
    calls,
    held,
    makeClient,
    event,
    emit,
    mainWindow,
    ipcMain,
    handlers,
    hold: () => {
      hold = true;
    },
    release: () => {
      hold = false;
    },
    factoryCalls: () => factoryCalls,
    request: () =>
      calls.filter((call) => call.action === 'request').slice(-1)[0],
  };
}

const operationArgs = {
  initialize: {},
  dispose: {},
  fetchDeviceInfo: {},
  listStorages: {},
  fetchDebugReport: {},
  listFiles: { filePath: '/', ignoreHidden: false, storageId: 1 },
  filesExist: { fileList: ['/mock/a'], storageId: 1 },
  deleteFiles: { fileList: ['/mock/a'], storageId: 1 },
  renameFile: { filePath: '/mock/a', newFilename: 'b', storageId: 1 },
  makeDirectory: { filePath: '/mock/new', storageId: 1 },
  transferFiles: {
    destination: '/mock/destination',
    fileList: ['/mock/a'],
    direction: 'download',
    storageId: 1,
  },
  selectStorage: { storageId: 2 },
  selectBackend: { backend: 'legacy' },
};

test('passive handshake exposes disconnected B1 state without backend construction', async () => {
  const f = fixture();
  const state = await f.client.connect();

  assert.strictEqual(state.state, 'Disconnected');
  assert.strictEqual(state.generation, 0);
  assert.strictEqual(state.executionEnabled, false);
  assert.strictEqual(f.factoryCalls(), 0);
  assert.strictEqual(queueModule.default.active, false);
  assert.notStrictEqual(f.client.clientEpoch, f.client.ownerEpoch);
  assert.strictEqual(f.calls.length, 1);
  await f.client.connect();
  assert.strictEqual(f.calls.length, 1);
});

MTP_SESSION_OPERATIONS.forEach((operation) => {
  test(`allowlisted ${operation} is validated but never executed in B2.1`, async () => {
    const f = fixture();

    await f.client.connect();
    await assert.rejects(
      f.client.request(operation, operationArgs[operation]),
      (error) => error.code === 'MTP_OWNER_INACTIVE'
    );
    assert.strictEqual(f.factoryCalls(), 0);
    assert.strictEqual(f.service.lifecycle.getSnapshot().state, 'Disconnected');
    assert.strictEqual(f.service.lifecycle.getSnapshot().generation, 0);
    assert.strictEqual(queueModule.default.active, false);
  });
});

test('sender authorization requires main window, live top frame and exact application URL', () => {
  const f = fixture();
  const valid = f.event();

  assert.strictEqual(isAuthorizedMtpSender(valid, f.mainWindow, appUrl), true);
  assert.strictEqual(
    isAuthorizedMtpSender(
      { ...valid, senderFrame: { url: appUrl } },
      f.mainWindow,
      appUrl
    ),
    false
  );
  assert.strictEqual(
    isAuthorizedMtpSender({ ...valid, sender: {} }, f.mainWindow, appUrl),
    false
  );
  f.sender.mainFrame.url = `${appUrl}#settings`;
  assert.strictEqual(isAuthorizedMtpSender(valid, f.mainWindow, appUrl), true);
  f.sender.mainFrame.url = `${appUrl}.evil`;
  assert.strictEqual(isAuthorizedMtpSender(valid, f.mainWindow, appUrl), false);
  assert.strictEqual(
    f.service.handle(valid, {}).error.code,
    'MTP_IPC_UNAUTHORIZED'
  );
  f.sender.mainFrame.url = appUrl;
  f.sender.dead = true;
  assert.strictEqual(isAuthorizedMtpSender(valid, f.mainWindow, appUrl), false);
});

test('unauthorized and default-deny services never establish clients', () => {
  const f = fixture();
  const request = {
    version: 1,
    action: 'handshake',
    requestId: 'request',
    rendererId: 'renderer',
  };
  const denied = new MtpSessionIpc({ ipcMain: f.ipcMain, createId: uuid.v4 });

  assert.strictEqual(
    denied.handle(f.event(), request).error.code,
    'MTP_IPC_UNAUTHORIZED'
  );
  assert.strictEqual(denied.clients.size, 0);
  assert.strictEqual(
    f.service.handle({ sender: {} }, request).error.code,
    'MTP_IPC_UNAUTHORIZED'
  );
  assert.strictEqual(f.service.clients.size, 0);
});

[
  null,
  [],
  {},
  { version: 2 },
  { version: 1, action: 'exec', requestId: 'id', rendererId: 'renderer' },
  {
    version: 1,
    action: 'handshake',
    requestId: '../invalid',
    rendererId: 'renderer',
  },
  {
    version: 1,
    action: 'handshake',
    requestId: 'id',
    rendererId: 'renderer',
    shell: 'anything',
  },
].forEach((payload, index) => {
  test(`malformed request ${
    index + 1
  } produces a serializable structured error`, () => {
    const f = fixture();
    const result = f.service.handle(f.event(), payload);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'MTP_IPC_INVALID');
    assert.doesNotThrow(() => JSON.stringify(cloneMtpData(result)));
    assert.strictEqual(f.service.clients.size, 0);
  });
});

test('unknown operations, arbitrary commands and malformed arguments are rejected at both boundaries', async () => {
  const f = fixture();

  await f.client.connect();
  const count = f.calls.length;

  await assert.rejects(f.client.request('Walk', {}), /Unknown/);
  await assert.rejects(
    f.client.request('exec', { command: 'not executed' }),
    /Unknown/
  );
  await assert.rejects(
    f.client.request('listStorages', { command: 'not executed' }),
    /fields/
  );
  await assert.rejects(
    f.client.request('listFiles', {
      filePath: '/',
      storageId: 1,
      ignoreHidden: 'false',
    })
  );
  assert.strictEqual(f.calls.length, count);
  const raw = {
    version: 1,
    action: 'request',
    requestId: 'raw',
    rendererId: f.client.rendererId,
    ownerEpoch: f.client.ownerEpoch,
    clientEpoch: f.client.clientEpoch,
    operation: 'exec',
    args: {},
    context: null,
  };

  assert.strictEqual(
    f.service.handle(f.event(), raw).error.code,
    'MTP_IPC_INVALID'
  );
  assert.strictEqual(f.factoryCalls(), 0);
});

test('duplicate server correlation IDs and duplicate handshakes cannot replay requests', async () => {
  const f = fixture();

  await f.client.connect();
  const handshake = f.calls[0];

  assert.strictEqual(
    f.service.handle(f.event(), handshake).error.code,
    'MTP_IPC_DUPLICATE'
  );
  await assert.rejects(f.client.request('listStorages'));
  const original = f.request();

  assert.strictEqual(
    f.service.handle(f.event(), original).error.code,
    'MTP_IPC_DUPLICATE'
  );
  assert.strictEqual(f.factoryCalls(), 0);
});

test('client rejects reused request IDs before transport', async () => {
  const f = fixture();
  let sequence = 0;
  const client = f.makeClient({
    createId: () => {
      sequence += 1;

      return sequence === 1 ? 'renderer-fixed' : 'request-fixed';
    },
  });

  await client.connect();
  const count = f.calls.length;

  await assert.rejects(
    client.request('listStorages'),
    (error) => error.code === 'MTP_IPC_DUPLICATE'
  );
  assert.strictEqual(f.calls.length, count);
});

test('concurrent requests retain independent progress and terminal correlation', async () => {
  const f = fixture();

  await f.client.connect();
  f.hold();
  const progressA = [];
  const progressB = [];
  const terminals = [];
  const first = f.client.request('listStorages', {}, null, {
    onProgress: (value) => progressA.push(value),
    onTerminal: (value) => terminals.push(value),
  });
  const idA = f.request().requestId;
  const second = f.client.request('fetchDeviceInfo', {}, null, {
    onProgress: (value) => progressB.push(value),
    onTerminal: (value) => terminals.push(value),
  });
  const idB = f.request().requestId;

  f.emit(idB, 'progress', { percentage: 20 });
  f.emit(idA, 'progress', { percentage: 100 });
  assert.strictEqual(progressA[0].percentage, 100);
  assert.strictEqual(progressB[0].percentage, 20);
  assert.strictEqual(terminals.length, 0);
  f.emit(idB, 'terminal', { ok: true, data: 'second' });
  f.emit(idA, 'terminal', { ok: true, data: 'first' });
  assert.strictEqual(await first, 'first');
  assert.strictEqual(await second, 'second');
  f.emit(idA, 'terminal', { ok: true, data: 'duplicate' });
  f.held.forEach(({ resolve, result }) => resolve(result));
  await flush();
  assert.strictEqual(terminals.length, 2);
  assert.strictEqual(f.factoryCalls(), 0);
});

test('stale, malformed and unknown events do not reach pending consumers', async () => {
  const f = fixture();

  await f.client.connect();
  f.hold();
  const progress = [];
  const promise = f.client.request('listStorages', {}, null, {
    onProgress: (value) => progress.push(value),
  });
  const id = f.request().requestId;

  f.emit(id, 'progress', { valid: false }, { clientEpoch: 'old-client' });
  f.emit(id, 'progress', { valid: false }, { ownerEpoch: 'old-owner' });
  f.emit(id, 'progress', { valid: false }, { rendererId: 'other-renderer' });
  f.emit('unknown-request', 'progress', { valid: false });
  f.emit(id, 'unknown-event', {});
  f.emit(id, 'progress', () => {});
  f.emit(id, 'terminal', { ok: 'yes', data: 'invalid' });
  assert.strictEqual(progress.length, 0);
  const valid = f.emit(id, 'progress', { valid: true });

  f.renderer.emit(MTP_SESSION_CHANNELS.event, {}, valid);
  assert.strictEqual(progress.length, 1);
  f.emit(id, 'terminal', { ok: true, data: 'done' });
  assert.strictEqual(await promise, 'done');
  f.held[0].resolve(f.held[0].result);
});

test('owner-state subscription supports initial snapshots, updates, unsubscribe and consumer errors', async () => {
  const f = fixture();
  const states = [];
  const errors = [];
  const client = f.makeClient({
    onCallbackError: (error) => errors.push(error),
  });
  const unsubscribe = client.subscribeOwnerState((state) => states.push(state));

  client.subscribeOwnerState(() => {
    throw new Error('consumer failed');
  });
  await client.connect();
  f.service.publishOwnerState();
  assert.strictEqual(states.length, 2);
  assert.strictEqual(errors.length, 2);
  states[0].state = 'outside mutation';
  assert.strictEqual(states[1].state, 'Disconnected');
  unsubscribe();
  f.service.publishOwnerState();
  assert.strictEqual(states.length, 2);
});

test('renderer unload disposes listeners and rejects pending requests exactly once', async () => {
  const f = fixture();

  await f.client.connect();
  f.hold();
  const terminals = [];
  const pending = observe(
    f.client.request('listStorages', {}, null, {
      onTerminal: (value) => terminals.push(value),
    })
  );

  f.lifecycle.emit('unload');
  assert.strictEqual((await pending).error.code, 'MTP_IPC_DISPOSED');
  assert.strictEqual(terminals.length, 1);
  assert.strictEqual(f.renderer.listenerCount(MTP_SESSION_CHANNELS.event), 0);
  assert.strictEqual(f.lifecycle.listenerCount('unload'), 0);
  assert.strictEqual(f.service.clients.size, 0);
  f.client.dispose();
  f.held.forEach(({ resolve, result }) => resolve(result));
  await flush();
  assert.strictEqual(terminals.length, 1);
});

test('renderer destruction removes main-side client records and lifecycle listeners', async () => {
  const f = fixture();

  await f.client.connect();
  f.sender.dead = true;
  f.sender.emit('destroyed');
  assert.strictEqual(f.service.clients.size, 0);
  assert.strictEqual(f.sender.listenerCount('did-start-navigation'), 0);
  assert.strictEqual(f.sender.listenerCount('render-process-gone'), 0);
  f.lifecycle.emit('unload');
});

test('renderer process failure rejects pending work without invoking a backend', async () => {
  const f = fixture();

  await f.client.connect();
  f.hold();
  const pending = observe(f.client.request('listStorages'));

  f.sender.emit('render-process-gone');
  assert.strictEqual((await pending).error.code, 'MTP_IPC_RENDERER_GONE');
  assert.strictEqual(f.service.clients.size, 0);
  assert.strictEqual(f.factoryCalls(), 0);
});

test('renderer recreation revokes the old epoch and ignores stale events in its replacement', async () => {
  const f = fixture();

  await f.client.connect();
  const oldEpoch = f.client.clientEpoch;
  const oldRenderer = f.client.rendererId;

  f.hold();
  const pending = observe(f.client.request('listStorages'));
  const oldRequest = f.request().requestId;

  f.sender.emit('did-start-navigation', {}, appUrl, false, true);
  assert.strictEqual((await pending).error.code, 'MTP_IPC_NAVIGATED');
  f.sender.mainFrame = { url: appUrl };
  f.release();
  const replacement = f.makeClient();

  await replacement.connect();
  assert.notStrictEqual(replacement.clientEpoch, oldEpoch);
  const states = [];

  replacement.subscribeOwnerState((state) => states.push(state));
  f.emit(
    oldRequest,
    'terminal',
    { ok: true, data: 'old result' },
    { clientEpoch: oldEpoch, rendererId: oldRenderer }
  );
  assert.strictEqual(states.length, 1);
  f.service.publishOwnerState();
  assert.strictEqual(states.length, 2);
  const staleRequest = {
    ...f.calls.find((call) => call.requestId === oldRequest),
    requestId: 'stale-retry',
  };

  assert.strictEqual(f.service.handle(f.event(), staleRequest).ok, false);
});

test('replacement handshake revokes the earlier client before its handshake reply arrives', async () => {
  const f = fixture();

  f.hold();
  const old = observe(f.client.connect());
  const replacement = f.makeClient();
  const connected = replacement.connect();

  f.held[0].resolve(f.held[0].result);
  assert.strictEqual((await old).error.code, 'MTP_IPC_REPLACED');
  f.held[1].resolve(f.held[1].result);
  await connected;
  f.held[0].resolve(f.held[0].result);
  await flush();
  assert.strictEqual(f.service.clients.size, 1);
  assert.strictEqual(
    f.service.clients.get(f.sender.id).clientEpoch,
    replacement.clientEpoch
  );
  assert.strictEqual(f.client.disposed, true);
});

test('disposing during handshake releases the abandoned main subscription on late reply', async () => {
  const f = fixture();

  f.hold();
  const pending = observe(f.client.connect());

  f.client.dispose();
  assert.strictEqual((await pending).error.code, 'MTP_IPC_DISPOSED');
  f.held[0].resolve(f.held[0].result);
  await flush();
  assert.strictEqual(f.service.clients.size, 0);
});

test('owner-state updates arriving before handshake reply are retained for the client', async () => {
  const f = fixture();
  const states = [];

  f.client.subscribeOwnerState((state) => states.push(state));
  f.hold();
  const connected = f.client.connect();

  f.service.publishOwnerState();
  f.held[0].resolve(f.held[0].result);
  await connected;
  assert(states.length >= 1);
  assert(states.every((state) => state.executionEnabled === false));
});

test('transport rejection, synchronous failure and malformed replies reject without backend execution', async () => {
  const f = fixture();

  await f.client.connect();
  f.renderer.invoke = () => Promise.reject(new Error('transport down'));
  await assert.rejects(
    f.client.request('listStorages'),
    (error) => error.code === 'MTP_IPC_TRANSPORT'
  );
  f.renderer.invoke = () => {
    throw new Error('transport threw');
  };

  await assert.rejects(
    f.client.request('listStorages'),
    (error) => error.code === 'MTP_IPC_TRANSPORT'
  );
  f.renderer.invoke = async () => ({ version: 1 });
  await assert.rejects(
    f.client.request('listStorages'),
    (error) => error.code === 'MTP_IPC_BAD_REPLY'
  );
  assert.strictEqual(f.factoryCalls(), 0);
});

test('structured terminal errors notify and reject only their correlated request', async () => {
  const f = fixture();

  await f.client.connect();
  f.hold();
  const terminals = [];
  const pending = observe(
    f.client.request('listStorages', {}, null, {
      onTerminal: (result) => terminals.push(result),
    })
  );

  f.emit(f.request().requestId, 'terminal', {
    ok: false,
    error: { code: 'MOCK_FAILURE', message: 'mock request failed' },
  });
  const result = await pending;

  assert.strictEqual(result.error.code, 'MOCK_FAILURE');
  assert.strictEqual(terminals.length, 1);
  f.held[0].resolve(f.held[0].result);
});

test('session context is transported as plain data and cannot claim another client lifetime', async () => {
  const f = fixture();

  await f.client.connect();
  const context = {
    ownerEpoch: f.client.ownerEpoch,
    generation: 1,
    clientEpoch: f.client.clientEpoch,
    operationId: 'operation-1',
    backend: 'kalam',
    storageId: 1,
    storageRevision: 1,
    operationKind: 'read',
  };

  await assert.rejects(
    f.client.request('listStorages', {}, context),
    (error) => error.code === 'MTP_OWNER_INACTIVE'
  );
  assert.strictEqual(f.request().context.operationId, 'operation-1');
  await assert.rejects(
    f.client.request(
      'listStorages',
      {},
      { ...context, clientEpoch: 'foreign-client' }
    ),
    (error) => error.code === 'MTP_IPC_INVALID'
  );
});

const invalidData = [
  undefined,
  () => {},
  Symbol('pointer'),
  1n,
  NaN,
  Infinity,
  new Date(),
  new Map(),
  new Error('native'),
  Buffer.from('pointer'),
  {
    get callback() {
      throw new Error('must not evaluate accessor');
    },
  },
  [undefined],
  new Array(1),
];

invalidData.forEach((value, index) => {
  test(`non-plain IPC data ${index + 1} is rejected without coercion`, () => {
    assert.throws(() => cloneMtpData(value));
  });
});

test('cyclic, excessive, prototype-shaped and symbolic data are rejected', () => {
  const cyclic = {};

  cyclic.self = cyclic;
  assert.throws(() => cloneMtpData(cyclic));
  assert.throws(() =>
    cloneMtpData(JSON.parse('{"__proto__":{"polluted":true}}'))
  );
  assert.throws(() => cloneMtpData({ [Symbol('hidden')]: true }));
  assert.throws(() => cloneMtpData({ oversized: 'a'.repeat(65537) }));
  assert.throws(() => cloneMtpData(Array.from({ length: 20001 }, () => 1)));
  assert.throws(() =>
    cloneMtpData(Array.from({ length: 20 }).reduce((value) => ({ value }), {}))
  );
});

test('plain payload cloning prevents sender mutation and preserves JSON values', () => {
  const original = {
    values: [null, true, false, 1, 'name'],
    nested: { path: '/mock' },
  };
  const copy = cloneMtpData(original);

  original.nested.path = 'changed';
  assert.strictEqual(copy.nested.path, '/mock');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(copy.values)), [
    null,
    true,
    false,
    1,
    'name',
  ]);
});

test('IPC service registration is idempotent and stop revokes its clients', async () => {
  const f = fixture();

  f.service.start();
  await f.client.connect();
  assert.strictEqual(f.handlers.size, 1);
  f.service.stop();
  assert.strictEqual(f.handlers.size, 0);
  assert.strictEqual(f.service.clients.size, 0);
  assert.strictEqual(f.client.disposed, true);
});

test('stale revocation before a new handshake reply cannot dispose the replacement lifetime', async () => {
  const f = fixture();

  f.hold();
  const connected = f.client.connect();
  const id = f.calls[0].requestId;

  f.emit(
    id,
    'client-disposed',
    { code: 'OLD_LIFETIME', message: 'stale' },
    { ownerEpoch: 'old-owner', clientEpoch: 'old-client' }
  );
  f.held[0].resolve(f.held[0].result);
  await connected;
  assert.strictEqual(f.client.disposed, false);
});

test('requests require a live handshake and cannot run after disposal', async () => {
  const f = fixture();

  await assert.rejects(
    f.client.request('listStorages'),
    (error) => error.code === 'MTP_IPC_NOT_CONNECTED'
  );
  assert.strictEqual(f.calls.length, 0);
  await f.client.connect();
  f.client.dispose();
  const count = f.calls.length;

  await assert.rejects(
    f.client.request('initialize'),
    (error) => error.code === 'MTP_IPC_DISPOSED'
  );
  await assert.rejects(
    f.client.connect(),
    (error) => error.code === 'MTP_IPC_DISPOSED'
  );
  assert.strictEqual(f.calls.length, count);
});

test('consumer progress and terminal exceptions cannot alter request settlement', async () => {
  const f = fixture();
  const callbackErrors = [];
  const client = f.makeClient({
    onCallbackError: (error) => callbackErrors.push(error),
  });

  await client.connect();
  f.hold();
  const pending = client.request('listStorages', {}, null, {
    onProgress() {
      throw new Error('progress consumer failed');
    },
    onTerminal() {
      throw new Error('terminal consumer failed');
    },
  });
  const id = f.request().requestId;

  f.emit(id, 'progress', { percentage: 30 });
  f.emit(id, 'terminal', { ok: true, data: 'unchanged' });
  assert.strictEqual(await pending, 'unchanged');
  assert.strictEqual(callbackErrors.length, 2);
  f.held[0].resolve(f.held[0].result);
});

test('malformed owner states and malformed handshake replies cannot authorize requests', async () => {
  const f = fixture();

  f.hold();
  const connected = observe(f.client.connect());
  const reply = cloneMtpData(f.held[0].result);

  delete reply.data.state;
  f.held[0].resolve(reply);
  assert((await connected).error);
  await assert.rejects(
    f.client.request('listStorages'),
    (error) => error.code === 'MTP_IPC_NOT_CONNECTED'
  );
  f.client.dispose();
});

test('send failure while publishing state safely revokes an unreachable renderer', async () => {
  const f = fixture();

  await f.client.connect();
  f.sender.send = () => {
    throw new Error('renderer disappeared');
  };

  assert.doesNotThrow(() => f.service.publishOwnerState());
  assert.strictEqual(f.service.clients.size, 0);
  f.client.dispose();
});

test('custom array instances are not accepted as plain transport data', () => {
  class NativeLookingArray extends Array {}

  assert.throws(() => cloneMtpData(new NativeLookingArray()));
});

test('internal sender-validation failures produce structured errors without leaking exceptions', () => {
  const f = fixture();
  const service = new MtpSessionIpc({
    ipcMain: f.ipcMain,
    createId: uuid.v4,
    isAuthorizedSender() {
      throw null;
    },
  });
  const result = service.handle(f.event(), {});

  assert.strictEqual(result.error.code, 'MTP_IPC_INTERNAL');
  assert.strictEqual(result.error.message, 'MTP IPC request failed.');
});

test('existing IPC service installs the passive endpoint without creating backend dependencies', async () => {
  const f = fixture();

  f.service.stop();
  const { default: IpcEventService } = load(
    'app/services/ipc-events/IpcEventHandler.js',
    {
      electron: { ipcMain: f.ipcMain },
      './IpcEventType': eventModule,
      '../../data/file-explorer/MtpSessionIpc': contract,
      '../../helpers/createWindows': {
        faqsWindow() {},
        helpPhoneNotConnectingWindow() {},
        privacyPolicyWindow() {},
        reportBugsWindow() {},
      },
    }
  );

  IpcEventService.shared.start({
    getMainWindow: () => f.mainWindow,
    expectedUrl: appUrl,
  });
  const state = await f.client.connect();

  assert.strictEqual(state.state, 'Disconnected');
  assert.strictEqual(state.executionEnabled, false);
  assert.strictEqual(f.factoryCalls(), 0);
  IpcEventService.shared.mtpSessionIpc.stop();
});

function activeFailureFixture(result, { preflight = false } = {}) {
  const codec = load('app/data/file-explorer/MtpSessionTransport.js', {});
  const { MtpSessionService } = load(
    'app/data/file-explorer/MtpSessionService.js',
    {
      './MtpSessionOwner': ownerModule,
      './MtpSessionTransport': codec,
      './transferResult': transferHelpers,
    }
  );
  const { MtpSessionClient: ActiveClient } = load(
    'app/data/file-explorer/MtpSessionClient.js',
    {
      uuid,
      './MtpSessionIpc': contract,
      './MtpSessionTransport': codec,
    },
    { setTimeout: (callback) => setImmediate(callback) }
  );
  const queue = new queueModule.MtpOperationQueue();
  const sender = new EventEmitter();
  const renderer = new EventEmitter();
  const replies = [];
  let dispatcher;
  const owner = new MtpSessionService({
    queue,
    ownerEpoch: 'failure-owner',
    onState: () => dispatcher?.publishOwnerState(),
    backendFactory(_, hooks) {
      return {
        initialize() {
          const execution = hooks();

          return queue.run(() => {
            execution.onLifecycleEvidence({
              version: 1,
              terminal: true,
              nativeStarted: !preflight,
              nativeReturned: !preflight,
              cleanupAcknowledged: false,
              resources: preflight ? 'none' : 'unknown',
            });

            return preflight
              ? {
                  error: new Error('Original callback setup failure'),
                  data: null,
                }
              : result;
          }, execution);
        },
        dispose: () => assert.fail('Uncertain native disposal forbidden'),
      };
    },
  });

  sender.id = 999;
  sender.mainFrame = {};
  sender.isDestroyed = () => false;
  sender.send = (channel, data) =>
    renderer.emit(channel, {}, codec.wireData(data));
  dispatcher = new MtpSessionIpc({
    ipcMain: {},
    service: owner,
    transport: new codec.MtpSessionTransport(),
    wire: codec.wireData,
    createId: uuid.v4,
    isAuthorizedSender: (event) => event.sender === sender,
  });
  renderer.invoke = async (_, data) => {
    const reply = await dispatcher.handle(
      { sender, senderFrame: sender.mainFrame },
      codec.wireData(data)
    );
    const plain = codec.wireData(reply);

    replies.push(plain);

    return plain;
  };

  const client = new ActiveClient({
    ipcRenderer: renderer,
    version: 2,
    lifecycleTarget: null,
  });

  return { owner, client, replies };
}

test('Active IPC preserves original initialization classification and execution evidence', async () => {
  const f = activeFailureFixture({
    error: 'Original LIBUSB_ERROR_NOT_FOUND message',
    stderr: 'ErrorDeviceSetup',
    data: null,
  });

  await f.client.connect();
  const { error } = await observe(
    f.client.activeRequest('initialize', {}, f.owner.scope())
  );
  const evidence = JSON.parse(
    error.message.split('Initialization evidence: ')[1]
  );

  assert.strictEqual(error.code, 'MTP_CONNECT_FAILED');
  assert.strictEqual(evidence.errorType, 'ErrorDeviceSetup');
  assert.strictEqual(
    evidence.message,
    'Original LIBUSB_ERROR_NOT_FOUND message'
  );
  assert.strictEqual(evidence.nativeStarted, true);
  assert.strictEqual(evidence.nativeReturned, true);
  assert.strictEqual(evidence.cleanupAcknowledged, false);
  assert.strictEqual(evidence.resources, 'unknown');
  assert.strictEqual(f.client._state.state, 'Invalidated');
  assert(f.owner.quarantine);
  f.client.dispose();
});

test('Active IPC bounds initialization diagnostics and excludes raw objects', async () => {
  const f = activeFailureFixture({
    error: new Error(`native: ${'x'.repeat(100000)}`),
    stderr: 'ErrorNative'.repeat(10000),
    data: null,
    pointer: { hiddenNativePointer: 'must not cross IPC' },
    diagnosticOutput: 'unbounded diagnostic output'.repeat(10000),
  });

  await f.client.connect();
  const { error } = await observe(
    f.client.activeRequest('initialize', {}, f.owner.scope())
  );
  const evidence = JSON.parse(
    error.message.split('Initialization evidence: ')[1]
  );

  assert.strictEqual(evidence.message.length, 2048);
  assert.strictEqual(evidence.errorType.length, 128);
  assert(error.message.length < 4000);
  const wire = JSON.stringify(f.replies);

  assert(!wire.includes('hiddenNativePointer'));
  assert(!wire.includes('unbounded diagnostic output'));
  f.client.dispose();
});

test('Active IPC pre-invocation failure delivers disconnected state and permits logical shutdown', async () => {
  const f = activeFailureFixture(null, { preflight: true });

  await f.client.connect();
  const { error } = await observe(
    f.client.activeRequest('initialize', {}, f.owner.scope())
  );
  const evidence = JSON.parse(
    error.message.split('Initialization evidence: ')[1]
  );

  assert.strictEqual(evidence.nativeStarted, false);
  assert.strictEqual(evidence.nativeReturned, false);
  assert.strictEqual(evidence.resources, 'none');
  assert.strictEqual(evidence.message, 'Original callback setup failure');
  assert.strictEqual(f.client._state.state, 'Disconnected');
  await f.owner.shutdown();
  f.client.dispose();
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
  console.info(`${passed}/${tests.length} MTP session IPC tests passed.`);
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
