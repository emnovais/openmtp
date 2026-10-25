/* Run with Node 16: NODE_ENV=test node tests/mtp-session-lifecycle.test.js */
const assert = require('assert');
const { load, queueModule } = require('./transfer-reliability.test');

// The strict VM loader has no fallback imports. This module and the coordinator
// cannot load native libraries, Electron, USB monitoring, or child processes.
const { MtpSessionOwner, getMtpOperationKind } = load(
  'app/data/file-explorer/MtpSessionOwner.js',
  {}
);
const tests = [];
const test = (name, run) => tests.push({ name, run });
const flush = () => new Promise((resolve) => setImmediate(resolve));
const observe = (promise) =>
  promise.then(
    (value) => ({ value }),
    (error) => ({ error })
  );
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((_resolve, _reject) => {
    resolve = _resolve;
    reject = _reject;
  });

  return { promise, resolve, reject };
};

async function settled(promise) {
  let done = false;
  const observed = observe(promise).then((value) => {
    done = true;

    return value;
  });

  await flush();
  assert(done, 'Operation did not settle; possible nested acquisition');

  return observed;
}

function fixture(options = {}) {
  const queue = new queueModule.MtpOperationQueue();
  const owner = new MtpSessionOwner({
    queue,
    ownerEpoch: 'owner-1',
    ...options,
  });
  const connect = (
    backend = 'kalam',
    identityEvidence = { serial: 'same' }
  ) => {
    const { generation } = owner.beginConnection({
      backend,
      clientEpoch: 'renderer-1',
    });

    owner.markReady({ generation, identityEvidence, storageId: 1 });

    return generation;
  };
  const close = () => {
    const { generation } = owner.beginClosing();

    return owner.completeClosing({ generation, resourcesClosed: true });
  };
  const context = (operation = 'listFiles', options = {}) =>
    owner.createContext({ operation, ...options });

  return { queue, owner, connect, close, context };
}

test('initial connection allocates generation one and records an explicit ready acknowledgement', () => {
  const f = fixture();

  assert.strictEqual(f.owner.getSnapshot().state, 'Disconnected');
  const attempt = f.owner.beginConnection({
    backend: 'kalam',
    clientEpoch: 'renderer-1',
  });

  assert.strictEqual(attempt.state, 'Connecting');
  assert.strictEqual(attempt.generation, 1);
  assert.throws(() => f.context(), /transition/);
  assert.strictEqual(
    f.owner.markReady({ generation: 1, storageId: 1 }).state,
    'Ready'
  );
});

test('same-device reconnection always creates a fresh generation and rejects original context', async () => {
  const f = fixture();
  const first = f.connect();
  const old = f.context();

  f.owner.invalidate();
  f.close();
  assert.strictEqual(f.connect(), first + 1);
  assert.strictEqual(
    (await settled(f.owner.run(old, () => assert.fail('stale')))).error.code,
    'MTP_SESSION_STALE'
  );
  assert.strictEqual(old.generation, first);
});

test('different-device evidence is copied without inferring a physical identity policy', () => {
  const f = fixture();
  const evidence = { serial: 'device-A', usb: { serial: 'usb-A' } };

  f.connect('kalam', evidence);
  evidence.usb.serial = 'changed outside owner';
  assert.strictEqual(
    f.owner.getSnapshot().identityEvidence.usb.serial,
    'usb-A'
  );
  assert(Object.isFrozen(f.owner.getSnapshot().identityEvidence.usb));
  f.close();
  f.connect('kalam', { serial: 'device-B' });
  assert.strictEqual(f.owner.getSnapshot().identityEvidence.serial, 'device-B');
  assert.strictEqual(f.owner.getSnapshot().generation, 2);
});

test('USB-only evidence is opaque data, not a verified-device assertion', () => {
  const f = fixture();

  f.connect('legacy', { usbEvent: { serialNumber: 'event-only' } });
  assert.strictEqual(
    f.owner.getSnapshot().identityEvidence.verified,
    undefined
  );
  assert.strictEqual(f.owner.getSnapshot().backend, 'legacy');
});

test('backend change revokes old context and requires closing before a new connection', async () => {
  const f = fixture();

  f.connect();
  const old = f.context('renameFile');

  f.owner.requestBackendChange('legacy');
  assert.strictEqual(f.owner.getSnapshot().state, 'Invalidated');
  assert.strictEqual(f.owner.getSnapshot().backend, 'kalam');
  assert.throws(() => f.connect('legacy'), /transition/);
  f.close();
  f.connect('legacy');
  assert.strictEqual(
    (await settled(f.owner.run(old, () => assert.fail('old mutation')))).error
      .code,
    'MTP_SESSION_STALE'
  );
  assert.strictEqual(f.context().backend, 'legacy');
});

test('selecting the same backend preserves the current generation', () => {
  const f = fixture();

  f.connect();
  f.owner.requestBackendChange('kalam');
  assert.strictEqual(f.owner.getSnapshot().state, 'Ready');
  assert.strictEqual(f.owner.getSnapshot().generation, 1);
});

test('storage revisions change independently without disposal or reconnection', () => {
  const f = fixture();

  f.connect();
  const old = f.context();
  const before = f.owner.getSnapshot();

  f.owner.selectStorage(2);
  f.owner.selectStorage(1);
  const after = f.owner.getSnapshot();

  assert.strictEqual(after.state, 'Ready');
  assert.strictEqual(after.generation, before.generation);
  assert.strictEqual(after.storageRevision, before.storageRevision + 2);
  assert.throws(() => f.owner.validateContext(old), /Obsolete/);
  f.owner.selectStorage(1);
  assert.strictEqual(
    f.owner.getSnapshot().storageRevision,
    after.storageRevision
  );
});

test('storage-independent reads remain eligible across storage selection changes', async () => {
  const f = fixture();

  f.connect();
  const context = f.context('listStorages');

  f.owner.selectStorage(2);
  assert.strictEqual(
    (await settled(f.owner.run(context, () => 'storages'))).value,
    'storages'
  );
  assert.strictEqual(context.storageId, null);
});

[
  'listFiles',
  'renameFile',
  'deleteFiles',
  'makeDirectory',
  'transferFiles',
].forEach((operation) => {
  test(`pending ${operation} is fenced after invalidation without changing its context`, async () => {
    const f = fixture();

    f.connect();
    const active = deferred();
    const first = f.owner.run(f.context(), () => active.promise);
    const context = f.context(operation, { direction: 'download' });
    const original = JSON.stringify(context);
    const pending = observe(
      f.owner.run(context, () => assert.fail('revoked execution'))
    );

    f.owner.invalidate();
    assert.strictEqual(f.queue.active, true);
    active.resolve('stopped');
    await settled(first);
    assert.strictEqual((await pending).error.code, 'MTP_SESSION_STALE');
    assert.strictEqual(JSON.stringify(context), original);
  });
});

test('both upload and download contexts are mutations', () => {
  const f = fixture();

  f.connect();
  ['upload', 'download'].forEach((direction) => {
    assert.strictEqual(
      getMtpOperationKind('transferFiles', direction),
      'mutation'
    );
    assert.strictEqual(
      f.context('transferFiles', { direction }).operationKind,
      'mutation'
    );
  });
  assert.throws(
    () => getMtpOperationKind('transferFiles', 'read'),
    /direction/
  );
  assert.throws(() => getMtpOperationKind('unknown'), /Unsupported/);
});

test('operation context is frozen, owner-issued, and contains all original scope fields', async () => {
  const f = fixture();

  f.connect();
  const context = f.context();

  assert(Object.isFrozen(context));
  assert.strictEqual(context.ownerEpoch, 'owner-1');
  assert.strictEqual(context.clientEpoch, 'renderer-1');
  assert.strictEqual(context.generation, 1);
  assert.strictEqual(context.backend, 'kalam');
  assert.strictEqual(context.storageId, 1);
  assert.strictEqual(context.storageRevision, 1);
  assert.strictEqual(context.operationKind, 'read');
  assert.notStrictEqual(f.context().operationId, context.operationId);
  assert.strictEqual(
    (await settled(f.owner.run({ ...context }, () => assert.fail('forged'))))
      .error.message,
    'MTP context must be submitted exactly once.'
  );
});

test('terminal session invalidation happens before successor admission and caller continuation', async () => {
  const f = fixture({
    isSessionInvalidating: (outcome) => outcome.value?.disconnect === true,
  });

  f.connect();
  const active = deferred();
  const first = f.owner.run(f.context(), () => active.promise);
  const next = observe(
    f.owner.run(f.context('renameFile'), () => assert.fail('unsafe successor'))
  );

  active.resolve({ disconnect: true });
  await settled(first);
  assert.strictEqual((await next).error.code, 'MTP_SESSION_STALE');
  assert.strictEqual(f.owner.getSnapshot().state, 'Invalidated');
});

test('a rejected native outcome can invalidate the session before a pending mutation', async () => {
  const f = fixture({
    isSessionInvalidating: (outcome) => outcome.status === 'rejected',
  });

  f.connect();
  const active = deferred();
  const first = observe(f.owner.run(f.context(), () => active.promise));
  const next = observe(
    f.owner.run(f.context('deleteFiles'), () => assert.fail('unsafe mutation'))
  );

  active.reject(new Error('device disconnected'));
  assert.match((await first).error.message, /disconnected/);
  assert.strictEqual((await next).error.code, 'MTP_SESSION_STALE');
});

test('ordinary failed execution recovers when the injected policy does not invalidate', async () => {
  const f = fixture();

  f.connect();
  const first = observe(
    f.owner.run(f.context(), () => {
      throw new Error('read failed');
    })
  );
  const next = f.owner.run(f.context(), () => 'recovered');

  assert.match((await first).error.message, /read failed/);
  assert.strictEqual((await settled(next)).value, 'recovered');
  assert.strictEqual(f.owner.getSnapshot().activeOperationId, null);
});

test('FIFO ordering skips obsolete storage work without overtaking eligible requests', async () => {
  const f = fixture();
  const order = [];

  f.connect();
  const active = deferred();
  const first = f.owner.run(f.context(), () => {
    order.push(1);

    return active.promise;
  });
  const stale = observe(
    f.owner.run(f.context(), () => assert.fail('old storage'))
  );

  f.owner.selectStorage(2);
  const second = f.owner.run(f.context('listStorages'), () => order.push(2));
  const third = f.owner.run(f.context(), () => order.push(3));

  active.resolve();
  await settled(first);
  assert((await stale).error);
  await settled(second);
  await settled(third);
  assert.deepStrictEqual(order, [1, 2, 3]);
});

test('an active mutation retains the lane and blocks reconnection until actual return', async () => {
  const f = fixture();

  f.connect();
  const context = f.context('transferFiles', { direction: 'download' });
  const active = deferred();
  const first = f.owner.run(context, () => active.promise);
  const calls = [];
  const next = f.queue.run(() => calls.push('unscoped successor'));

  f.owner.invalidate();
  f.owner.beginClosing();
  await flush();
  assert.strictEqual(f.queue.active, true);
  assert.strictEqual(
    f.owner.getSnapshot().activeOperationId,
    context.operationId
  );
  assert.throws(
    () => f.owner.completeClosing({ generation: 1, resourcesClosed: true }),
    /must be confirmed/
  );
  assert.throws(() => f.connect(), /transition/);
  assert.deepStrictEqual(calls, []);
  active.resolve({ status: 'completed', unchanged: true });
  assert.strictEqual((await settled(first)).value.status, 'completed');
  await settled(next);
  f.owner.completeClosing({ generation: 1, resourcesClosed: true });
  assert.strictEqual(f.connect(), 2);
});

test('an operation that never returns has no timeout or invalidation release', async () => {
  const f = fixture();

  f.connect();
  const active = deferred();
  const first = f.owner.run(f.context(), () => active.promise);
  let nextStarted = false;
  const next = observe(
    f.owner.run(f.context(), () => {
      nextStarted = true;
    })
  );

  f.owner.invalidate();
  await flush();
  await flush();
  assert.strictEqual(f.queue.active, true);
  assert.strictEqual(nextStarted, false);
  assert(f.owner.getSnapshot().activeOperationId);
  // Simulate eventual termination only to clean up the fixture, never force release.
  active.resolve();
  await settled(first);
  assert((await next).error);
});

test('invalid lifecycle transitions and unconfirmed closure leave state unchanged', () => {
  const f = fixture();

  assert.throws(() => f.owner.markReady({ generation: 0 }), /transition/);
  assert.throws(() => f.owner.invalidate(), /transition/);
  assert.throws(() => f.owner.selectStorage(1), /transition/);
  assert.throws(() => f.owner.beginClosing(), /transition/);
  f.connect();
  assert.throws(() => f.connect(), /transition/);
  assert.throws(() => f.owner.markReady({ generation: 1 }), /transition/);
  f.owner.beginClosing();
  assert.throws(
    () => f.owner.completeClosing({ generation: 1, resourcesClosed: false }),
    /confirmed/
  );
  assert.strictEqual(f.owner.getSnapshot().state, 'Closing');
});

test('failed connection attempts consume generations; late acknowledgements are rejected', () => {
  const f = fixture();

  f.owner.beginConnection({ backend: 'kalam', clientEpoch: 'renderer-1' });
  f.owner.invalidate();
  f.close();
  f.owner.beginConnection({ backend: 'kalam', clientEpoch: 'renderer-2' });
  assert.throws(() => f.owner.markReady({ generation: 1 }), /Obsolete/);
  assert.strictEqual(f.owner.getSnapshot().state, 'Connecting');
  f.owner.markReady({ generation: 2, storageId: 1 });
  assert.throws(() => f.owner.invalidate({ generation: 1 }), /Obsolete/);
  assert.strictEqual(f.owner.getSnapshot().clientEpoch, 'renderer-2');
});

test('many close and reconnect cycles never reuse generation or operation identifiers', () => {
  const f = fixture();
  const generations = new Set();
  const operations = new Set();

  Array.from({ length: 30 }).forEach(() => {
    generations.add(f.connect());
    operations.add(f.context().operationId);
    f.close();
  });
  assert.strictEqual(generations.size, 30);
  assert.strictEqual(operations.size, 30);
});

test('mutations are not replayed or resubmitted after reconnection', async () => {
  const f = fixture();

  f.connect();
  const context = f.context('renameFile');
  let calls = 0;

  f.owner.invalidate();
  assert(
    (
      await settled(
        f.owner.run(context, () => {
          calls += 1;
        })
      )
    ).error
  );
  f.close();
  f.connect();
  assert(
    (
      await settled(
        f.owner.run(context, () => {
          calls += 1;
        })
      )
    ).error
  );
  await flush();
  assert.strictEqual(calls, 0);
});

test('an executed operation cannot be submitted again with the same context', async () => {
  const f = fixture();

  f.connect();
  const context = f.context();

  await settled(f.owner.run(context, () => true));
  assert.throws(() => f.owner.validateContext(context), /Obsolete/);
  assert(
    (await settled(f.owner.run(context, () => assert.fail('duplicate')))).error
  );
});

[
  [
    'throw',
    () => {
      throw new Error('classifier failed');
    },
  ],
  ['rejected promise', () => Promise.reject(new Error('classifier rejected'))],
  ['invalid return', () => undefined],
].forEach(([name, isSessionInvalidating]) => {
  test(`terminal classifier ${name} invalidates the owner and quarantines its queue`, async () => {
    const f = fixture({ isSessionInvalidating });

    f.connect();
    const first = observe(f.owner.run(f.context(), () => true));
    const next = observe(
      f.owner.run(f.context(), () => assert.fail('successor'))
    );

    assert.strictEqual((await first).error.code, 'MTP_QUEUE_QUARANTINED');
    assert.strictEqual((await next).error.code, 'MTP_QUEUE_QUARANTINED');
    assert.strictEqual(f.owner.getSnapshot().state, 'Invalidated');
    assert.strictEqual(f.owner.getSnapshot().activeOperationId, null);
    f.close();
    assert.throws(() => f.connect(), /not safely ended/);
  });
});

test('owner does not acquire a second lane around already admitted work', async () => {
  const f = fixture();
  const run = f.queue.run.bind(f.queue);
  let acquisitions = 0;

  f.queue.run = (...args) => {
    acquisitions += 1;

    return run(...args);
  };

  f.connect();
  assert.strictEqual(
    (await settled(f.owner.run(f.context(), () => 'one leaf'))).value,
    'one leaf'
  );
  assert.strictEqual(acquisitions, 1);
});

test('owner hooks attach directly at an existing execution boundary without acquisition', async () => {
  const f = fixture({ isSessionInvalidating: () => true });

  f.connect();
  const context = f.context();
  const hooks = f.owner.executionHooks(context);

  assert(Object.isFrozen(hooks));
  assert.strictEqual(f.queue.active, false);
  assert.strictEqual(f.queue.pending.length, 0);
  assert.throws(() => f.owner.executionHooks(context), /exactly once/);
  const result = f.queue.run(() => 'native returned', hooks);

  assert.strictEqual((await settled(result)).value, 'native returned');
  assert.strictEqual(f.owner.getSnapshot().state, 'Invalidated');
});

test('storage switching preserves an active operation and its original result', async () => {
  const f = fixture();

  f.connect();
  const context = f.context('transferFiles', { direction: 'upload' });
  const active = deferred();
  const first = f.owner.run(context, () => active.promise);

  f.owner.selectStorage(2);
  assert.strictEqual(
    f.owner.getSnapshot().activeOperationId,
    context.operationId
  );
  assert.strictEqual(context.storageId, 1);
  active.resolve('old-storage outcome');
  assert.strictEqual((await settled(first)).value, 'old-storage outcome');
  assert.strictEqual(f.owner.getSnapshot().state, 'Ready');
  assert.strictEqual(f.owner.getSnapshot().generation, 1);
});

test('invalid ready acknowledgements preserve Connecting state', () => {
  const f = fixture();

  f.owner.beginConnection({ backend: 'kalam', clientEpoch: 'renderer-1' });
  assert.throws(() => f.owner.markReady({ generation: 1, storageId: -1 }));
  assert.throws(() =>
    f.owner.markReady({ generation: 1, identityEvidence: [] })
  );
  const cyclic = {};

  cyclic.self = cyclic;
  assert.throws(() =>
    f.owner.markReady({ generation: 1, identityEvidence: cyclic })
  );
  assert.strictEqual(f.owner.getSnapshot().state, 'Connecting');
  assert.strictEqual(f.owner.getSnapshot().identityEvidence, null);
});

test('unscoped operations keep their Phase A behavior alongside opt-in fenced calls', async () => {
  const f = fixture();

  f.connect();
  f.owner.invalidate();
  assert.strictEqual(
    (await settled(f.queue.run(() => 'legacy path'))).value,
    'legacy path'
  );
  assert.strictEqual(f.queue.fault, null);
});

test('malformed inputs cannot partially begin a connection or select storage', () => {
  const f = fixture();

  assert.throws(() =>
    f.owner.beginConnection({ backend: 'unknown', clientEpoch: 'renderer-1' })
  );
  assert.strictEqual(f.owner.getSnapshot().generation, 0);
  assert.strictEqual(f.owner.getSnapshot().state, 'Disconnected');
  f.connect();
  const original = f.owner.getSnapshot();

  assert.throws(() => f.owner.selectStorage(-1));
  assert.throws(() => f.owner.selectStorage('2'));
  assert.strictEqual(
    f.owner.getSnapshot().storageRevision,
    original.storageRevision
  );
  assert.throws(
    () => f.context('listFiles', { storageId: 9 }),
    /selected storage/
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
  console.info(`${passed}/${tests.length} MTP session lifecycle tests passed.`);
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
