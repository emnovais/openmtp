/* Run with Node 16: NODE_ENV=test node tests/legacy-thumbnails.test.js */
const assert = require('assert');
const path = require('path');
const { EventEmitter } = require('events');
const { StringDecoder } = require('node:string_decoder');
const fs = require('fs');
const vm = require('vm');
const babel = require('@babel/core');
const baseline = require('./transfer-reliability.test');

const { load } = baseline;
const tests = [];
const test = (name, run) => tests.push({ name, run });
const flush = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let settle;
  const promise = new Promise((resolve) => {
    settle = resolve;
  });

  return { promise, resolve: settle };
};
const args = (extra = {}) => ({
  filePath: '/TESTE OPEN MTP/ação com espaço.png',
  storageId: 65537,
  cacheDirectory: '/private/tmp/openmtp-legacy-thumb-opaque',
  destination:
    '/private/tmp/openmtp-legacy-thumb-opaque/0123456789abcdef0123456789abcdef.thumb',
  isCurrent: () => true,
  ...extra,
});
// Exact diagnostic captured during the single-request T2.1 physical test.
const usbDiagnostic =
  'Device::Find failed:(*_interface)->USBInterfaceOpen(_interface): error 0xe00002c5\n';
const thumbnailProcessResult = (extra = {}) => ({
  error: null,
  stderr: null,
  data: true,
  processClosed: true,
  exitCode: 0,
  signal: null,
  ...extra,
});

function legacyFixture(options = {}) {
  const queueModule = load('app/data/file-explorer/MtpOperationQueue.js', {});
  const queue = queueModule.default;
  const calls = [];
  const diagnostics = [];
  let leases = 0;
  const run = queue.run.bind(queue);

  queue.run = (...values) => {
    leases += 1;

    return run(...values);
  };

  const module = load(
    'app/data/file-explorer/data-sources/FileExplorerLegacyDataSource.js',
    {
      path,
      'lodash/find': () => {},
      child_process: {
        execFile: (binary, argv, settings, callback) => {
          assert.strictEqual(binary, '/mock/mtp-cli');
          assert.strictEqual(settings.shell, false);
          if (options.exec) return options.exec(argv, callback);

          throw new Error('Shell execution forbidden');
        },
        spawn(binary, argv, settings) {
          if (options.spawnThrows) throw new Error('Spawn failure');
          const child = new EventEmitter();

          child.stderr = new EventEmitter();
          calls.push({ binary, argv, settings, child });

          return child;
        },
      },
      'node:string_decoder': { StringDecoder },
      '../../../utils/log': {
        log: { error: (...values) => diagnostics.push(values) },
      },
      '../../../utils/funcs': baseline.utils,
      '../../../constants': {
        DEVICES_LABEL: { mtp: 'Phone', local: 'Computer' },
      },
      '../../../enums': baseline.enums,
      '../../../utils/files': {
        baseName: path.basename,
        getExtension: path.extname,
      },
      '../../../helpers/binaries': { mtpCliPath: '/mock/mtp-cli' },
      '../../../utils/date': { msToTime: String, unixTimestampNow: () => 0 },
      '../../../utils/checkIf': { checkIf: baseline.checkIf },
      '../MtpOperationQueue': queueModule,
      '../transferResult': baseline.transferHelpers,
    }
  );
  let admitted = 0;
  let stopped = 0;
  const source = new module.FileExplorerLegacyDataSource({
    executionHooks: () => ({
      beforeStart: () => {
        admitted += 1;

        return options.admit !== false;
      },
      afterStop: () => {
        stopped += 1;
      },
    }),
  });

  return {
    ...module,
    source,
    calls,
    diagnostics,
    queue,
    counts: () => ({ leases, admitted, stopped }),
  };
}

test('Command uses one argv entry per CLI command, explicit storage and opaque destination', async () => {
  const f = legacyFixture();
  const input = args();
  const promise = f.source.readThumbnail(input);

  assert.strictEqual(f.calls.length, 1);
  const call = f.calls[0];

  assert.strictEqual(call.binary, '/mock/mtp-cli');
  assert.strictEqual(call.argv.length, 2);
  assert.strictEqual(call.argv[0], 'storage 65537');
  assert.strictEqual(
    call.argv[1],
    `get-thumb "${input.filePath}" "${input.destination}"`
  );
  assert.strictEqual(call.settings.shell, false);
  assert.strictEqual(call.settings.cwd, input.cacheDirectory);
  call.child.emit('close', 0, null);
  assert.strictEqual((await promise).data, true);
  assert.strictEqual(f.counts().leases, 1);
  assert.strictEqual(f.counts().admitted, 1);
  assert.strictEqual(f.counts().stopped, 1);
});
for (const name of [
  'photo with spaces.jpg',
  'ação_日本語.PNG',
  "O'Brien.jpeg",
  'dollar$backtick`.png',
]) {
  test(`Safe quoted argument preserves ${name}`, () => {
    const f = legacyFixture();
    const cmd = f.legacyThumbnailArgs(args({ filePath: `/Images/${name}` }));

    assert(cmd[1].includes(`"/Images/${name}"`));
  });
}

for (const filePath of [
  'relative.jpg',
  '/a/../b.jpg',
  '/a/./b.jpg',
  '//b.jpg',
  '/bad".jpg',
  '/bad\\name.png',
  '/bad\nname.png',
  '/bad\0name.png',
  '/directory',
  '/a.svg',
]) {
  test(`Unsafe/unsupported source rejected: ${JSON.stringify(
    filePath
  )}`, () => {
    const f = legacyFixture();

    assert.throws(() => f.source.readThumbnail(args({ filePath })), /Unsafe/);
    assert.strictEqual(f.calls.length, 0);
  });
}

for (const extra of [
  { storageId: -1 },
  { storageId: 1.5 },
  { storageId: 4294967296 },
  { destination: '/Users/user/Pictures/a.jpg' },
  { cacheDirectory: '/Users/user/Pictures' },
  { destination: '/private/tmp/openmtp-legacy-thumb-opaque/../outside.thumb' },
]) {
  test(`Unsafe destination/storage rejected: ${JSON.stringify(extra)}`, () => {
    const f = legacyFixture();

    assert.throws(() => f.source.readThumbnail(args(extra)), /Unsafe/);
    assert.strictEqual(f.calls.length, 0);
  });
}

for (const [code, signal] of [
  [1, null],
  [null, 'SIGKILL'],
  [null, null],
]) {
  test(`Unsuccessful CLI termination ${code}/${signal} cannot succeed`, async () => {
    const f = legacyFixture();
    const promise = f.source.readThumbnail(args());

    f.calls[0].child.emit('close', code, signal);
    const result = await promise;

    assert(result.error);
    assert.strictEqual(result.data, null);
    assert(!f.queue.active);
  });
}

test('Spawn error waits for close; duplicate terminal events settle once', async () => {
  const f = legacyFixture();
  let settled = 0;
  const promise = f.source.readThumbnail(args()).then((value) => {
    settled += 1;

    return value;
  });
  const { child } = f.calls[0];

  child.emit('error', new Error('Device disconnected'));
  child.emit('exit', 0, null);
  await flush();
  assert(f.queue.active);
  assert.strictEqual(settled, 0);
  child.emit('close', 0, null);
  child.emit('close', 0, null);
  assert((await promise).error);
  assert.strictEqual(settled, 1);
});
test('Nonempty thumbnail stderr is retained and logged once with the existing bound', async () => {
  const f = legacyFixture();
  const promise = f.source.readThumbnail(args());

  f.calls[0].child.stderr.emit('data', Buffer.alloc(100000, 65));
  f.calls[0].child.emit('close', 0, null);
  const result = await promise;

  assert.strictEqual(result.error, null);
  assert.strictEqual(result.data, true);
  assert.strictEqual(result.processClosed, true);
  assert.strictEqual(result.stderr.length, 65536);
  assert.strictEqual(f.diagnostics.length, 1);
  assert.strictEqual(f.diagnostics[0][0], result.stderr);
  assert.strictEqual(f.diagnostics[0][2], true); // Persist diagnostics.
  assert.strictEqual(f.diagnostics[0][3], true); // Visible in production too.
  assert.strictEqual(f.diagnostics[0][4], false); // No crash report.
});
test('Synchronous spawn failure releases a lane with no child', async () => {
  const f = legacyFixture({ spawnThrows: true });

  const result = await f.source.readThumbnail(args());

  assert(result.error);
  assert.strictEqual(result.processClosed, false);
  assert(!f.queue.active);
});
test('Queued thumbnail checks logical cancellation at admission', async () => {
  const f = legacyFixture();
  const blocker = deferred();
  const first = f.queue.run(() => blocker.promise);
  let current = true;
  const observed = f.source
    .readThumbnail(args({ isCurrent: () => current }))
    .catch((e) => e);

  current = false;
  blocker.resolve();
  await first;
  assert((await observed).message);
  assert.strictEqual(f.calls.length, 0);
});
test('A never-closing CLI retains queue ownership despite cancellation and exit', async () => {
  const f = legacyFixture();
  let current = true;
  let settled = false;

  const observed = f.source
    .readThumbnail(args({ isCurrent: () => current }))
    .then(() => {
      settled = true;

      return true;
    });
  let successor = false;

  f.queue.run(() => {
    successor = true;
  });
  current = false;
  f.calls[0].child.emit('exit', 0, null);
  await flush();
  await flush();
  assert(f.queue.active);
  assert(!settled);
  assert(!successor);
  assert(observed instanceof Promise || typeof observed.then === 'function');
});
test('Queued work starts only after preceding thumbnail child closes', async () => {
  const f = legacyFixture();
  const first = f.source.readThumbnail(args());
  const second = f.source.readThumbnail(args());

  assert.strictEqual(f.calls.length, 1);
  f.calls[0].child.emit('close', 0, null);
  await first;
  assert.strictEqual(f.calls.length, 2);
  f.calls[1].child.emit('close', 0, null);
  await second;
});

const localModule = load(
  'app/data/file-explorer/thumbnails/LocalThumbnailProvider.js',
  {
    fs: { promises: {} },
    path,
    electron: { nativeImage: {} },
  }
);
const serviceModule = load(
  'app/data/file-explorer/thumbnails/ThumbnailService.js',
  {}
);
const png = () => {
  const b = Buffer.alloc(32);

  Buffer.from('89504e470d0a1a0a', 'hex').copy(b);
  b.write('IHDR', 12);
  b.writeUInt32BE(160, 16);
  b.writeUInt32BE(100, 20);

  return b;
};

function providerFixture() {
  const fileItem = {
    name: 'ação.png',
    path: '/Images/ação.png',
    isFolder: false,
    size: null,
  };
  let selected = 'legacy';
  let ready = true;
  let scope = {
    generation: 1,
    backend: 'legacy',
    storageId: 65537,
    storageRevision: 1,
  };
  const state = {
    Settings: { mtpMode: 'legacy' },
    Home: {
      mtpDevice: { isAvailable: true },
      currentBrowsePath: { mtp: '/Images' },
      directoryLists: { mtp: { nodes: [fileItem] } },
    },
  };
  const listeners = new Set();
  const operations = [];
  let content = png();
  let serial = 0;
  let outputSize;
  let symlink = false;
  let rootReplaced = false;
  let readCalls = 0;
  let decoded = 0;
  const files = {
    mkdtemp: async (prefix) => {
      serial += 1;
      const dir = `${prefix}${serial}`;

      operations.push(['mkdtemp', dir]);

      return dir;
    },
    chmod: async (file, mode) => {
      operations.push(['chmod', file, mode]);
    },
    realpath: async (file) => (rootReplaced ? '/outside/service' : file),
    open: async (file, flags, mode) => {
      operations.push(['open', file, flags, mode]);

      return {
        close: async () => {
          operations.push(['close', file]);
        },
        stat: async () => ({
          isFile: () => true,
          ino: 1,
          size: outputSize ?? content.length,
          mtimeMs: 1,
        }),
        read: async (buffer) => {
          readCalls += 1;

          return { bytesRead: content.copy(buffer) };
        },
      };
    },
    lstat: async () => ({
      isFile: () => true,
      isSymbolicLink: () => symlink,
      ino: 1,
      size: outputSize ?? content.length,
    }),
    unlink: async (file) => {
      operations.push(['unlink', file]);
    },
    rmdir: async (dir) => {
      operations.push(['rmdir', dir]);
    },
  };
  const calls = [];
  const controller = {
    readThumbnail: async (value) => {
      calls.push(value);

      return thumbnailProcessResult();
    },
    transferFiles: () => {
      throw new Error('Transfers forbidden');
    },
  };
  const images = {
    createFromBuffer: () => {
      decoded += 1;

      return {
        isEmpty: () => false,
        getSize: () => ({ width: 160, height: 100 }),
        resize: () => ({
          toPNG: png,
          getSize: () => ({ width: 160, height: 100 }),
        }),
      };
    },
  };
  const module = load(
    'app/data/file-explorer/thumbnails/MtpThumbnailProvider.js',
    {
      fs: { promises: files, constants: fs.constants },
      path,
      os: { tmpdir: () => '/private/tmp' },
      crypto: { randomBytes: () => Buffer.alloc(16, 7) },
      electron: { nativeImage: images },
      '../../../store/configureStore': {
        store: {
          getState: () => state,
          subscribe: (fn) => {
            listeners.add(fn);

            return () => listeners.delete(fn);
          },
        },
      },
      '../../../helpers/settings': { getMtpModeSetting: () => selected },
      '../repositories/FileExplorerRepository': {
        captureMtpScope: () => ({ ...scope }),
        isCurrentMtpScope: (value) =>
          ready && Object.keys(scope).every((key) => scope[key] === value[key]),
      },
      '../controllers/FileExplorerController': controller,
      './LocalThumbnailProvider': localModule,
      './ThumbnailService': serviceModule,
    }
  );
  const provider = new module.MtpThumbnailProvider();
  const context = module.captureMtpThumbnailContext(fileItem);

  return {
    ...module,
    provider,
    context,
    fileItem,
    state,
    operations,
    files,
    images,
    calls,
    controller,
    emit: () => listeners.forEach((fn) => fn()),
    setMode: (mode) => {
      selected = mode;
      state.Settings.mtpMode = mode;
    },
    disconnect: () => {
      ready = false;
      state.Home.mtpDevice.isAvailable = false;
    },
    changeStorage: () => {
      scope = { ...scope, storageId: 131073, storageRevision: 2 };
    },
    reconnect: () => {
      scope = { ...scope, generation: 2 };
    },
    content: (value) => {
      content = value;
    },
    size: (value) => {
      outputSize = value;
    },
    symlink: () => {
      symlink = true;
    },
    replaceRoot: () => {
      rootReplaced = true;
    },
    counts: () => ({ decoded, readCalls }),
  };
}

const generate = async (f, isWanted) =>
  f.provider.generate(
    await f.provider.inspect(f.fileItem, f.context),
    { width: 160, height: 160 },
    isWanted
  );

function pipelineFixture() {
  const f = providerFixture();
  const legacy = legacyFixture();
  const results = [];
  const published = [];

  f.controller.readThumbnail = async (value) => {
    f.calls.push(value);
    const result = await legacy.source.readThumbnail(value);

    results.push(result);

    return result;
  };

  const service = new serviceModule.ThumbnailService({
    provider: f.provider,
    maxJobs: 1,
    createUrl: () => 'blob:validated-thumbnail',
    revokeUrl: () => {},
  });
  const request = () =>
    service.request(f.fileItem, {
      context: f.context,
      revision: f.context.key,
      isCurrent: () => f.isMtpThumbnailContextCurrent(f.context),
      onResult: (src) => published.push(src),
    });

  return { ...f, legacy, results, service, published, request };
}

for (const stderr of ['', usbDiagnostic.repeat(7)]) {
  test(`Closed exit 0 and valid image becomes ready ${
    stderr ? 'with T2.1 USB diagnostics' : 'without stderr'
  }`, async () => {
    const f = pipelineFixture();

    if (stderr) {
      // JPEG header matching the captured 512 x 341 output; decoding is mocked.
      const jpeg = Buffer.alloc(32);

      Buffer.from('ffd8ffc0001108', 'hex').copy(jpeg);
      jpeg.writeUInt16BE(341, 7);
      jpeg.writeUInt16BE(512, 9);
      f.content(jpeg);
    }

    f.request();
    await flush();
    const { child } = f.legacy.calls[0];

    child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', 0, null);
    child.emit('close', 0, null);
    await flush();
    await flush();
    assert.deepStrictEqual(f.published, ['blob:validated-thumbnail']);
    assert.strictEqual(f.service.failures.size, 0);
    assert.strictEqual(f.results[0].stderr, stderr || null);
    assert.strictEqual(f.results[0].processClosed, true);
    assert.strictEqual(f.results[0].exitCode, 0);
    assert.strictEqual(f.results[0].signal, null);
    assert.strictEqual(f.results[0].error, null);
    assert.strictEqual(f.legacy.diagnostics.length, stderr ? 1 : 0);
    if (stderr) assert.strictEqual(f.legacy.diagnostics[0][0], stderr);
    assert.strictEqual(f.operations.filter((o) => o[0] === 'unlink').length, 1);
    assert.strictEqual(f.provider.ownedDirectories.size, 0);
    assert(!f.legacy.queue.active);
    // Repeated messages and another observer use cached output, never a retry.
    f.request();
    await flush();
    assert.strictEqual(f.legacy.calls.length, 1);
    assert.strictEqual(f.legacy.counts().leases, 1);
  });
}

for (const failure of [
  'corrupt',
  'decode',
  'missing',
  'oversized',
  'unsupported',
]) {
  test(`USB diagnostics do not bypass ${failure} output validation`, async () => {
    const f = pipelineFixture();

    if (failure === 'corrupt') f.content(Buffer.alloc(32));
    if (failure === 'unsupported') f.content(Buffer.from('GIF89a'));
    if (failure === 'decode')
      f.images.createFromBuffer = () => ({ isEmpty: () => true });
    if (failure === 'oversized') f.size(f.MAX_THUMBNAIL_BYTES + 1);
    if (failure === 'missing')
      f.files.lstat = async () => {
        throw new Error('ENOENT');
      };

    f.request();
    await flush();
    f.legacy.calls[0].child.stderr.emit('data', Buffer.from(usbDiagnostic));
    f.legacy.calls[0].child.emit('close', 0, null);
    await flush();
    await flush();
    assert.deepStrictEqual(f.published, [null]); // Existing fallback callback.
    assert.strictEqual(f.service.cache.size, 1);
    assert.strictEqual([...f.service.cache.values()][0].src, null);
    assert.strictEqual(f.results[0].stderr, usbDiagnostic);
    assert.strictEqual(f.legacy.diagnostics[0][0], usbDiagnostic);
    assert.strictEqual(f.operations.filter((o) => o[0] === 'unlink').length, 1);
    assert(!f.legacy.queue.active);
    f.request();
    await flush();
    assert.strictEqual(f.legacy.calls.length, 1);
  });
}

for (const [code, signal] of [
  [1, null],
  [0, 'SIGTERM'],
  [null, null],
]) {
  test(`Valid output cannot override unsuccessful CLI closure ${code}/${signal}`, async () => {
    const f = pipelineFixture();
    const promise = generate(f);

    await flush();
    f.legacy.calls[0].child.emit('close', code, signal);
    await assert.rejects(promise, /unavailable/);
    assert(f.results[0].error);
    assert.strictEqual(f.counts().readCalls, 0);
    assert.strictEqual(f.counts().decoded, 0);
    assert.strictEqual(f.operations.filter((o) => o[0] === 'unlink').length, 1);
    assert(!f.legacy.queue.active);
  });
}

test('Spawn error cannot be overridden by exit 0 and valid image output', async () => {
  const f = pipelineFixture();
  const promise = generate(f);

  await flush();
  const { child } = f.legacy.calls[0];

  child.emit('error', new Error('Device disconnected'));
  child.emit('close', 0, null);
  await assert.rejects(promise, /unavailable/);
  assert.strictEqual(f.results[0].error.message, 'Device disconnected');
  assert.strictEqual(f.counts().decoded, 0);
  assert(!f.legacy.queue.active);
});

test('Exit with valid output and diagnostics cannot publish or clean before close', async () => {
  const f = pipelineFixture();

  f.request();
  await flush();
  const { child } = f.legacy.calls[0];

  child.stderr.emit('data', Buffer.from(usbDiagnostic));
  child.emit('exit', 0, null);
  await flush();
  await flush();
  assert(f.legacy.queue.active);
  assert.strictEqual(f.results.length, 0);
  assert.strictEqual(f.published.length, 0);
  assert.strictEqual(f.operations.filter((o) => o[0] === 'unlink').length, 0);
  assert.strictEqual(f.counts().readCalls, 0);
  // Actual close is the only event that can release the lane and permit output.
  child.emit('close', 0, null);
  await flush();
  await flush();
  assert.strictEqual(f.published.length, 1);
  assert(!f.legacy.queue.active);
});

test('Stale context with valid output and diagnostics is cleaned and never displayed', async () => {
  const f = pipelineFixture();

  f.request();
  await flush();
  f.reconnect();
  f.legacy.calls[0].child.stderr.emit('data', Buffer.from(usbDiagnostic));
  f.legacy.calls[0].child.emit('close', 0, null);
  await flush();
  await flush();
  assert.strictEqual(f.published.length, 0);
  assert.strictEqual(f.counts().decoded, 0);
  assert.strictEqual(f.operations.filter((o) => o[0] === 'unlink').length, 1);
  assert.strictEqual(f.legacy.calls.length, 1);
  assert(!f.legacy.queue.active);
});

for (const extra of [
  { processClosed: undefined },
  { processClosed: false },
  { exitCode: undefined },
  { exitCode: '0' },
  { signal: undefined },
]) {
  test(`Provider rejects uncertain process evidence ${Object.entries(extra).map(
    ([key, value]) => `${key}=${value}`
  )}`, async () => {
    const f = providerFixture();

    f.controller.readThumbnail = async () => thumbnailProcessResult(extra);
    await assert.rejects(generate(f), /unavailable/);
    assert.strictEqual(f.counts().readCalls, 0);
    assert.strictEqual(f.operations.filter((o) => o[0] === 'unlink').length, 1);
  });
}

test('Other Legacy commands retain their existing stderr failure classification', async () => {
  const stderr = 'ErrorAccessDenied';
  const f = legacyFixture({
    exec: (_command, callback) => {
      const child = new EventEmitter();

      setImmediate(() => {
        callback(
          null,
          '65537 volume: , description: Internal storage\n',
          stderr
        );
        child.emit('close', 0, null);
      });

      return child;
    },
  });
  const result = await f.source.listStorages();

  assert.strictEqual(result.data, null);
  assert.strictEqual(result.stderr, stderr);
  assert.strictEqual(f.calls.length, 0);
  assert.strictEqual(f.counts().leases, 1);
});

test('Same-context replacement joins a successful in-flight Legacy thumbnail', async () => {
  const f = pipelineFixture();
  const oldConsumer = f.request();

  await flush();
  oldConsumer.cancel();
  assert.strictEqual(f.calls[0].isCurrent(), false);
  f.request();
  assert.strictEqual(f.calls[0].isCurrent(), true);
  assert.strictEqual(f.legacy.calls.length, 1);
  const { child } = f.legacy.calls[0];

  child.stderr.emit('data', Buffer.from(usbDiagnostic));
  child.emit('close', 0, null);
  await flush();
  await flush();
  assert.deepStrictEqual(f.published, ['blob:validated-thumbnail']);
  assert.strictEqual(f.counts().decoded, 1);
  assert.strictEqual(f.service.cache.size, 1);
  assert.strictEqual(f.legacy.calls.length, 1);
  assert.strictEqual(f.operations.filter((o) => o[0] === 'unlink').length, 1);
});

test('A replacement arriving during private cleanup receives the same validated result', async () => {
  const f = pipelineFixture();
  const cleanup = deferred();
  const originalCleanup = f.provider.cleanup.bind(f.provider);

  f.provider.cleanup = async (...values) => {
    await cleanup.promise;

    return originalCleanup(...values);
  };

  const oldConsumer = f.request();

  await flush();
  oldConsumer.cancel();
  f.legacy.calls[0].child.emit('close', 0, null);
  await flush();
  assert(!f.legacy.queue.active);
  assert.strictEqual(f.service.active, 1);
  f.request();
  cleanup.resolve();
  await flush();
  await flush();
  assert.deepStrictEqual(f.published, ['blob:validated-thumbnail']);
  assert.strictEqual(f.legacy.calls.length, 1);
  assert.strictEqual(f.operations.filter((o) => o[0] === 'unlink').length, 1);
});

test('Unwanted admission is cancellation, while changed session identity is stale', async () => {
  const f = providerFixture();

  await assert.rejects(
    generate(f, () => false),
    {
      code: 'THUMBNAIL_CANCELLED',
    }
  );
  assert.strictEqual(f.calls.length, 0);
  assert.strictEqual(f.operations.length, 0);
  const source = await f.provider.inspect(f.fileItem, f.context);

  f.reconnect();
  await assert.rejects(
    f.provider.generate(source, { width: 160, height: 160 }),
    { code: 'THUMBNAIL_STALE' }
  );
  assert.strictEqual(f.calls.length, 0);
});

test('Context invalidation during cleanup remains stale after bounded validation', async () => {
  const f = providerFixture();
  const cleanup = f.provider.cleanup.bind(f.provider);

  f.provider.cleanup = async (...values) => {
    await cleanup(...values);
    f.reconnect();
  };

  await assert.rejects(generate(f), { code: 'THUMBNAIL_STALE' });
  assert.strictEqual(f.counts().decoded, 1);
  assert.strictEqual(f.provider.ownedDirectories.size, 0);
});

test('Private 0700 directory, opaque 0600 file, validated bytes and immediate cleanup', async () => {
  const f = providerFixture();
  const result = await generate(f);

  assert.strictEqual(result.width, 160);
  assert.strictEqual(f.calls.length, 1);
  assert(/\/[a-f0-9]{32}\.thumb$/.test(f.calls[0].destination));
  assert.strictEqual(f.operations.find((o) => o[0] === 'chmod')[2], 0o700);
  assert.strictEqual(f.operations.find((o) => o[0] === 'open')[3], 0o600);
  assert.strictEqual(f.operations.filter((o) => o[0] === 'unlink').length, 1);
  assert.strictEqual(f.operations.filter((o) => o[0] === 'rmdir').length, 1);
  assert(!f.operations.some((o) => String(o[1]).startsWith('/Images')));
});
for (const failure of [
  'missing',
  'corrupt',
  'oversized',
  'empty',
  'symlink',
  'native-decode',
  'failed-cli',
]) {
  test(`${failure} thumbnail retains fallback and cleans only its private output`, async () => {
    const f = providerFixture();

    if (failure === 'missing')
      f.files.lstat = async () => {
        const e = new Error('ENOENT');

        e.code = 'ENOENT';
        throw e;
      };

    if (failure === 'corrupt') f.content(Buffer.alloc(32));
    if (failure === 'oversized') f.size(f.MAX_THUMBNAIL_BYTES + 1);
    if (failure === 'empty') f.size(0);
    if (failure === 'symlink') f.symlink();
    if (failure === 'native-decode')
      f.images.createFromBuffer = () => ({ isEmpty: () => true });
    if (failure === 'failed-cli')
      f.controller.readThumbnail = async () => ({
        error: 'NoThumbnailPresent',
        data: null,
      });
    await assert.rejects(generate(f));
    assert.strictEqual(f.operations.filter((o) => o[0] === 'unlink').length, 1);
    assert.strictEqual(f.operations.filter((o) => o[0] === 'rmdir').length, 1);
    if (['oversized', 'empty', 'symlink'].includes(failure))
      assert.strictEqual(f.counts().readCalls, 0);
  });
}

test('Never delete through a replaced private-directory path', async () => {
  const f = providerFixture();

  f.controller.readThumbnail = async () => {
    f.replaceRoot();

    return thumbnailProcessResult();
  };

  await assert.rejects(generate(f), /cache path changed/);
  assert.strictEqual(
    f.operations.filter((o) => ['unlink', 'rmdir'].includes(o[0])).length,
    0
  );
  const count = f.operations.length;

  await assert.rejects(generate(f), /cache is unavailable/);
  assert.strictEqual(f.operations.length, count);
});

test('Cleanup rejects directories not allocated by this provider', async () => {
  const f = providerFixture();

  await assert.rejects(
    f.provider.cleanup(
      '/Users/personal',
      '/Users/personal/0123456789abcdef0123456789abcdef.thumb',
      true
    ),
    /not owned/
  );
  assert.strictEqual(f.operations.length, 0);
});

test('Provider retains temporary output and queue lease until the actual child closes', async () => {
  const f = providerFixture();
  const legacy = legacyFixture();
  let wanted = true;

  f.controller.readThumbnail = (value) => legacy.source.readThumbnail(value);
  const promise = generate(f, () => wanted).catch((error) => error);

  await flush();
  assert.strictEqual(legacy.calls.length, 1);
  assert(legacy.queue.active);
  wanted = false;
  await flush();
  assert.strictEqual(f.operations.filter((o) => o[0] === 'unlink').length, 0);
  assert(legacy.queue.active);
  legacy.calls[0].child.emit('close', 0, null);
  assert((await promise).bytes);
  assert.strictEqual(legacy.counts().leases, 1);
  assert.strictEqual(f.operations.filter((o) => o[0] === 'unlink').length, 1);
  assert(!legacy.queue.active);
});
test('Do not clean temporary output while a CLI result remains unresolved', async () => {
  const f = providerFixture();
  const gate = deferred();

  f.controller.readThumbnail = () => gate.promise;
  let wanted = true;
  const promise = generate(f, () => wanted).catch((e) => e);

  await flush();
  wanted = false;
  await flush();
  assert.strictEqual(f.operations.filter((o) => o[0] === 'unlink').length, 0);
  gate.resolve(thumbnailProcessResult());
  assert((await promise).bytes);
  assert.strictEqual(f.operations.filter((o) => o[0] === 'unlink').length, 1);
});
for (const change of [
  'directory',
  'listing',
  'storage',
  'backend',
  'disconnect',
  'generation',
]) {
  test(`Reject ${change} changes before and after asynchronous retrieval`, async () => {
    const f = providerFixture();
    const gate = deferred();

    f.controller.readThumbnail = (value) => {
      f.calls.push(value);

      return gate.promise;
    };

    const promise = generate(f).catch((e) => e);

    await flush();
    if (change === 'directory') f.state.Home.currentBrowsePath.mtp = '/Other';
    if (change === 'listing')
      f.state.Home.directoryLists.mtp.nodes = [...f.context.nodes];
    if (change === 'storage') f.changeStorage();
    if (change === 'backend') f.setMode('kalam');
    if (change === 'disconnect') f.disconnect();
    if (change === 'generation') f.reconnect();
    assert(!f.isMtpThumbnailContextCurrent(f.context));
    assert(!f.calls[0].isCurrent());
    gate.resolve(thumbnailProcessResult());
    assert((await promise).message);
    assert.strictEqual(f.counts().decoded, 0);
  });
}

test('Context subscription clears displayed previews on invalidation', () => {
  const f = providerFixture();
  let invalidated = 0;
  const unsubscribe = f.subscribeMtpThumbnailContext(f.context, () => {
    invalidated += 1;
  });

  f.emit();
  assert.strictEqual(invalidated, 0);
  f.disconnect();
  f.emit();
  assert.strictEqual(invalidated, 1);
  unsubscribe();
  f.emit();
  assert.strictEqual(invalidated, 1);
});
test('Kalam and unsupported items never acquire a thumbnail provider path', async () => {
  const f = providerFixture();

  f.setMode('kalam');
  assert.strictEqual(f.captureMtpThumbnailContext(f.fileItem), null);
  await assert.rejects(f.provider.inspect(f.fileItem, f.context));
  assert.strictEqual(f.calls.length, 0);
  assert.strictEqual(f.operations.length, 0);
});
test('One active Android job and eight pending requests; no bulk admission', async () => {
  const f = providerFixture();
  const gate = deferred();

  f.controller.readThumbnail = (value) => {
    f.calls.push(value);

    return gate.promise;
  };

  const items = Array.from({ length: 20 }, (_, i) => ({
    ...f.fileItem,
    name: `${i}.jpg`,
    path: `/Images/${i}.jpg`,
  }));

  f.state.Home.directoryLists.mtp.nodes = items;
  const context = f.captureMtpThumbnailContext(items[0]);
  const service = f.getMtpThumbnailService();

  items.forEach((value) =>
    service.request(value, {
      context,
      revision: 1,
      isCurrent: () => true,
      onResult: () => {},
    })
  );
  await flush();
  assert.strictEqual(f.calls.length, 1);
  assert.strictEqual(service.active, 1);
  assert.strictEqual(service.pending.size, 8);
  assert.strictEqual(service.maxJobs, 1);
});
test('Cached missing thumbnail does not retry; new listing has distinct identity', async () => {
  const f = providerFixture();

  f.controller.readThumbnail = async (value) => {
    f.calls.push(value);

    return { error: 'NoThumbnail', data: null };
  };

  const service = new serviceModule.ThumbnailService({
    provider: f.provider,
    maxJobs: 1,
    createUrl: () => 'blob:mock',
    revokeUrl: () => {},
  });
  const request = (context) =>
    service.request(f.fileItem, {
      context,
      revision: context.key,
      isCurrent: () => true,
      onResult: () => {},
    });

  request(f.context);
  await flush();
  request(f.context);
  await flush();
  assert.strictEqual(f.calls.length, 1);
  f.state.Home.directoryLists.mtp.nodes = [f.fileItem];
  const next = f.captureMtpThumbnailContext(f.fileItem);

  assert.notStrictEqual(next.key, f.context.key);
  request(next);
  await flush();
  assert.strictEqual(f.calls.length, 2);
});
test('Cache eviction revokes blobs; downloaded temporary files were already removed', async () => {
  const f = providerFixture();
  const revoked = [];
  const service = new serviceModule.ThumbnailService({
    provider: f.provider,
    maxJobs: 1,
    maxEntries: 1,
    createUrl: () => 'blob:mock',
    revokeUrl: (value) => revoked.push(value),
  });
  const request = (context) =>
    service.request(f.fileItem, {
      context,
      revision: context.key,
      isCurrent: () => true,
      onResult: () => {},
    });

  request(f.context);
  await flush();
  f.state.Home.directoryLists.mtp.nodes = [f.fileItem];
  request(f.captureMtpThumbnailContext(f.fileItem));
  await flush();
  assert.strictEqual(service.cache.size, 1);
  assert.strictEqual(revoked.length, 1);
  assert.strictEqual(f.operations.filter((o) => o[0] === 'unlink').length, 2);
});

function repositoryFixture() {
  let mode = 'legacy';
  const calls = [];

  function LocalSourceStub() {}

  function LegacySourceStub() {
    this.listStorages = async () => ({ data: { 65537: {} } });
    this.readThumbnail = async (value) => {
      calls.push(value);

      return thumbnailProcessResult();
    };
  }

  function ForbiddenKalamSource() {
    throw new Error('Kalam construction forbidden');
  }

  const scopeModule = load(
    'app/data/file-explorer/repositories/FileExplorerRepository.js',
    {
      '../data-sources/FileExplorerLocalDataSource': {
        FileExplorerLocalDataSource: LocalSourceStub,
      },
      '../../../enums': baseline.enums,
      '../../../helpers/settings': { getMtpModeSetting: () => mode },
      '../MtpOperationQueue': baseline.queueModule,
      '../data-sources/FileExplorerLegacyDataSource': {
        FileExplorerLegacyDataSource: LegacySourceStub,
      },
      '../data-sources/FileExplorerKalamDataSource': {
        FileExplorerKalamDataSource: ForbiddenKalamSource,
      },
    }
  );
  const repository = new scopeModule.FileExplorerRepository();

  return {
    ...scopeModule,
    repository,
    calls,
    setMode: (value) => {
      mode = value;
    },
  };
}

test('Repository uses the established Legacy backend and rejects Kalam before construction', async () => {
  const f = repositoryFixture();

  await f.repository.listStorages();
  f.repository.selectStorage(65537);
  const value = { ...args(), scope: f.captureMtpScope() };

  assert.strictEqual((await f.repository.readThumbnail(value)).data, true);
  assert.strictEqual(f.calls.length, 1);
  f.setMode('kalam');
  await assert.rejects(f.repository.readThumbnail(value), /unsupported/);
  assert.strictEqual(f.calls.length, 1);
});
test('Repository rejects obsolete session and storage evidence', async () => {
  const f = repositoryFixture();

  await f.repository.listStorages();
  f.repository.selectStorage(65537);
  const value = { ...args(), scope: f.captureMtpScope() };

  f.repository.selectStorage(131073);
  await assert.rejects(f.repository.readThumbnail(value));
  f.invalidateRendererMtp();
  await assert.rejects(f.repository.readThumbnail(value));
  assert.strictEqual(f.calls.length, 0);
});

function loadJsx(relative, mocks, globals = {}) {
  const module = { exports: {} };
  const { code } = babel.transformSync(
    fs.readFileSync(path.join(__dirname, '..', relative), 'utf8'),
    {
      configFile: false,
      babelrc: false,
      presets: [require.resolve('@babel/preset-react')],
      plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')],
    }
  );

  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    ...globals,
    require: (name) => {
      assert(
        Object.prototype.hasOwnProperty.call(mocks, name),
        `Unmocked import ${name}`
      );

      return mocks[name];
    },
  });

  return module.exports.default;
}

function ComponentStub(props) {
  this.props = props;
  this.setState = (update) => {
    this.state = { ...this.state, ...update };
  };
}

const react = {
  PureComponent: ComponentStub,
  createRef: () => ({ current: null }),
  createElement: (type, props, ...children) => ({
    type,
    props: { ...props, children },
  }),
};

function componentFixture(deferAdmission = false) {
  const f = providerFixture();
  const requests = [];
  const observers = [];
  let invalidate;
  let subscribed = false;
  let blocked = deferAdmission;
  let capacityCallback;

  function ServiceStub() {
    this.request = () => {
      throw new Error('Local provider not used for MTP');
    };
  }

  class Observer {
    constructor(callback, options) {
      Object.assign(this, { callback, options });
      observers.push(this);
    }

    observe(target) {
      this.target = target;
    }

    disconnect() {
      this.disconnected = true;
    }

    visible(value) {
      this.callback([{ target: this.target, isIntersecting: value }]);
    }
  }
  const Component = loadJsx(
    'app/containers/HomePage/components/FileExplorerThumbnail.jsx',
    {
      react,
      '../../../data/file-explorer/thumbnails/LocalThumbnailProvider':
        localModule,
      '../../../data/file-explorer/thumbnails/ThumbnailService': {
        ThumbnailService: ServiceStub,
      },
      '../../../data/file-explorer/thumbnails/MtpThumbnailProvider': {
        isMtpThumbnailContextCurrent: f.isMtpThumbnailContextCurrent,
        getMtpThumbnailService: () => ({
          request: (value, options) => {
            const r = { value, options };

            requests.push(r);

            return {
              deferred: blocked,
              cancel: () => {
                r.cancelled = true;
              },
              fail: () => {},
            };
          },
          subscribeCapacity: (callback) => {
            capacityCallback = callback;

            return () => {
              capacityCallback = null;
            };
          },
        }),
        subscribeMtpThumbnailContext: (_, callback) => {
          subscribed = true;
          invalidate = callback;

          return () => {
            subscribed = false;
          };
        },
      },
    },
    { IntersectionObserver: Observer }
  );
  const view = new Component({
    item: f.fileItem,
    deviceType: 'mtp',
    mtpContext: f.context,
    revision: 1,
    fallbackSrc: 'icon.svg',
  });
  const root = {};

  view.image.current = {
    closest: (selector) => {
      assert.strictEqual(selector, '#file-explorer-body-wrapper-mtp');

      return root;
    },
  };
  view.componentDidMount();

  return {
    ...f,
    view,
    requests,
    observers,
    invalidate: () => invalidate(),
    subscribed: () => subscribed,
    admit: () => {
      blocked = false;
      capacityCallback?.();
    },
    waitingForCapacity: () => !!capacityCallback,
  };
}

// Real thumbnail component/service/provider and mocked CLI/filesystem. A mock
// parent can replace a selected tile without changing its file/session identity.
function lifecycleFixture() {
  const f = pipelineFixture();
  const observers = [];
  let url = 0;

  f.service.createUrl = () => {
    url += 1;

    return `blob:lifecycle-${url}`;
  };

  function Observer(callback) {
    this.callback = callback;
    observers.push(this);
    this.observe = (target) => {
      this.target = target;
    };

    this.disconnect = () => {
      this.disconnected = true;
    };

    this.visible = (value) => {
      this.callback([{ target: this.target, isIntersecting: value }]);
    };
  }

  const Component = loadJsx(
    'app/containers/HomePage/components/FileExplorerThumbnail.jsx',
    {
      react,
      '../../../data/file-explorer/thumbnails/LocalThumbnailProvider':
        localModule,
      '../../../data/file-explorer/thumbnails/ThumbnailService': {
        ThumbnailService: function LocalServiceStub() {},
      },
      '../../../data/file-explorer/thumbnails/MtpThumbnailProvider': {
        isMtpThumbnailContextCurrent: f.isMtpThumbnailContextCurrent,
        getMtpThumbnailService: () => f.service,
        subscribeMtpThumbnailContext: f.subscribeMtpThumbnailContext,
      },
    },
    { IntersectionObserver: Observer }
  );
  const mount = (item = f.fileItem, overrides = {}) => {
    const view = new Component({
      item,
      deviceType: 'mtp',
      mtpContext: f.captureMtpThumbnailContext(item),
      revision: 1,
      fallbackSrc: 'icon.svg',
      className: 'icon',
      thumbnailClassName: 'thumbnail',
      ...overrides,
    });

    view.image.current = { closest: () => ({}) };
    view.componentDidMount();

    return view;
  };

  return { ...f, mount, observers };
}

test('Selection/focus props alone preserve the mounted consumer and request', async () => {
  const f = lifecycleFixture();
  const view = f.mount();

  assert.strictEqual(f.legacy.calls.length, 0);
  view.observer.visible(true);
  await flush();
  const { observer } = view;
  const previous = view.props;

  view.props = { ...previous, className: 'selected-icon', focused: true };
  view.componentDidUpdate(previous);
  assert.strictEqual(view.observer, observer);
  assert(!observer.disconnected);
  f.legacy.calls[0].child.emit('close', 0, null);
  await flush();
  assert.strictEqual(view.state.src, 'blob:lifecycle-1');
  assert.strictEqual(f.legacy.calls.length, 1);
});

test('Pre-T4 Grid selection revision omission reproduces replacement and preserves the active thumbnail', async () => {
  const f = lifecycleFixture();
  const timers = [];
  let selected = false;

  function WrapperComponent(props) {
    this.props = props;
    this.setState = (update) => {
      this.state = {
        ...this.state,
        ...(typeof update === 'function' ? update(this.state) : update),
      };
    };
  }

  const Wrapper = loadJsx(
    'tests/fixtures/grid-batched-wrapper.jsx',
    {
      react: { ...react, PureComponent: WrapperComponent },
      '@material-ui/core/styles': { withStyles: () => (value) => value },
      '@material-ui/core/TableCell': 'TableCell',
      '@material-ui/core/TableRow': 'TableRow',
      '../../app/containers/HomePage/components/FileExplorerTableBodyGridRender':
        function Tile() {},
      '../../app/utils/funcs': { quickHash: (value) => value },
      '../../app/containers/HomePage/styles/FileExplorerTableBodyGridWrapperRender':
        { styles: {} },
    },
    {
      setTimeout: (callback) => timers.push(callback),
      clearTimeout: () => {},
    }
  );
  const props = {
    classes: {},
    tableSort: [f.fileItem],
    directoryGeneratedTime: 123,
    directoryLists: { mtp: { queue: { selected: [] } } },
    deviceType: 'mtp',
    isSelected: () => selected,
  };
  const wrapper = new Wrapper(props);

  wrapper.componentDidMount();
  timers[0]();
  assert.strictEqual(wrapper.state.items[0].props.directoryGeneratedTime, 123);
  const view = f.mount(f.fileItem, { revision: 123 });

  view.observer.visible(true);
  await flush();
  selected = true;
  wrapper.componentWillReceiveProps({
    ...props,
    directoryLists: { mtp: { queue: { selected: [f.fileItem.path] } } },
  });
  const nextTile = wrapper.state.items[0].props;

  assert.strictEqual(nextTile.item, f.fileItem);
  assert.strictEqual(nextTile.directoryGeneratedTime, undefined);
  const oldObserver = view.observer;
  const previous = view.props;

  view.props = { ...previous, revision: nextTile.directoryGeneratedTime };
  view.componentDidUpdate(previous);
  assert(oldObserver.disconnected);
  assert.notStrictEqual(view.observer, oldObserver);
  assert.strictEqual(f.calls[0].isCurrent(), false);
  view.observer.visible(true);
  assert.strictEqual(f.calls[0].isCurrent(), true);
  assert.strictEqual(f.service.pending.size, 0);
  assert.strictEqual(f.legacy.calls.length, 1);
  f.legacy.calls[0].child.emit('close', 0, null);
  await flush();
  assert.strictEqual(view.state.src, 'blob:lifecycle-1');
  assert.strictEqual(f.legacy.calls.length, 1);
});

test('Selection rerender replacing the consumer hands the in-flight preview to the current tile', async () => {
  const f = lifecycleFixture();
  const original = f.mount();

  original.observer.visible(true);
  await flush();
  original.componentWillUnmount();
  const selectedTile = f.mount();

  selectedTile.observer.visible(true);
  assert.strictEqual(f.service.pending.size, 0);
  assert.strictEqual(f.legacy.calls.length, 1);
  const { child } = f.legacy.calls[0];

  child.stderr.emit('data', Buffer.from(usbDiagnostic));
  child.emit('exit', 0, null);
  await flush();
  assert(f.legacy.queue.active);
  assert.strictEqual(selectedTile.state.src, null);
  assert.strictEqual(f.operations.filter((o) => o[0] === 'unlink').length, 0);
  child.emit('close', 0, null);
  child.emit('close', 0, null);
  await flush();
  assert.strictEqual(original.state.src, null);
  assert.strictEqual(selectedTile.state.src, 'blob:lifecycle-1');
  assert.strictEqual(f.counts().decoded, 1);
  assert.strictEqual(f.legacy.calls.length, 1);
  assert.strictEqual(f.legacy.diagnostics[0][0], usbDiagnostic);
  assert.strictEqual(f.operations.filter((o) => o[0] === 'unlink').length, 1);
  assert(!f.legacy.queue.active);
});

test('Unmount without replacement discards output without negative caching or early queue release', async () => {
  const f = lifecycleFixture();
  const view = f.mount();

  view.observer.visible(true);
  await flush();
  view.componentWillUnmount();
  f.legacy.calls[0].child.emit('exit', 0, null);
  await flush();
  assert(f.legacy.queue.active);
  assert.strictEqual(f.operations.filter((o) => o[0] === 'unlink').length, 0);
  f.legacy.calls[0].child.emit('close', 0, null);
  await flush();
  assert.strictEqual(view.state.src, null);
  assert.strictEqual(f.service.cache.size, 0);
  assert.strictEqual(f.service.running.size, 0);
  assert.strictEqual(f.legacy.calls.length, 1);
  assert.strictEqual(f.operations.filter((o) => o[0] === 'unlink').length, 1);
  assert(!f.legacy.queue.active);
});

test('Replacing with a different file cannot display the old image or overlap CLI operations', async () => {
  const f = lifecycleFixture();
  const other = { ...f.fileItem, name: 'other.png', path: '/Images/other.png' };

  f.context.nodes.push(other);
  const original = f.mount();

  original.observer.visible(true);
  await flush();
  original.componentWillUnmount();
  const next = f.mount(other);

  next.observer.visible(true);
  assert.strictEqual(f.legacy.calls.length, 1);
  assert.strictEqual(f.service.pending.size, 1);
  f.legacy.calls[0].child.emit('close', 0, null);
  await flush();
  assert.strictEqual(next.state.src, null);
  assert.strictEqual(f.legacy.calls.length, 2);
  assert(f.legacy.calls[1].argv[1].includes('"/Images/other.png"'));
  f.legacy.calls[1].child.emit('close', 0, null);
  await flush();
  assert.strictEqual(next.state.src, 'blob:lifecycle-1');
  assert.strictEqual(original.state.src, null);
});

test('Replacing with a different directory waits for old close and never publishes its result', async () => {
  const f = lifecycleFixture();
  const original = f.mount();

  original.observer.visible(true);
  await flush();
  const other = { ...f.fileItem, path: '/Other/ação.png' };

  f.state.Home.currentBrowsePath.mtp = '/Other';
  f.state.Home.directoryLists.mtp.nodes = [other];
  f.emit();
  const next = f.mount(other);

  next.observer.visible(true);
  assert.strictEqual(f.legacy.calls.length, 1);
  f.legacy.calls[0].child.emit('close', 0, null);
  await flush();
  assert.strictEqual(next.state.src, null);
  assert.strictEqual(f.counts().decoded, 0);
  assert.strictEqual(f.legacy.calls.length, 2);
  f.legacy.calls[1].child.emit('close', 0, null);
  await flush();
  assert.strictEqual(next.state.src, 'blob:lifecycle-1');
  assert.strictEqual(original.state.src, null);
});

test('Rapid Grid/List/Grid/List/Grid replacement shares one CLI and only the last tile receives output', async () => {
  const f = lifecycleFixture();
  const first = f.mount();

  first.observer.visible(true);
  await flush();
  first.componentWillUnmount();
  const second = f.mount();

  second.observer.visible(true);
  second.componentWillUnmount();
  const third = f.mount();

  third.observer.visible(true);
  assert.strictEqual(f.service.pending.size, 0);
  assert.strictEqual(f.legacy.calls.length, 1);
  f.legacy.calls[0].child.emit('close', 0, null);
  await flush();
  assert.strictEqual(first.state.src, null);
  assert.strictEqual(second.state.src, null);
  assert.strictEqual(third.state.src, 'blob:lifecycle-1');
  assert.strictEqual(f.legacy.calls.length, 1);
});

for (const change of ['generation', 'storage', 'backend', 'disconnect']) {
  test(`Active CLI with stale ${change} cannot publish into any tile`, async () => {
    const f = lifecycleFixture();
    const view = f.mount();

    view.observer.visible(true);
    await flush();
    if (change === 'generation') f.reconnect();
    if (change === 'storage') f.changeStorage();
    if (change === 'backend') f.setMode('kalam');
    if (change === 'disconnect') f.disconnect();
    f.emit();
    assert(f.legacy.queue.active);
    f.legacy.calls[0].child.emit('close', 0, null);
    await flush();
    assert.strictEqual(view.state.src, null);
    assert.strictEqual(f.counts().decoded, 0);
    assert.strictEqual(f.service.cache.size, 0);
    assert.strictEqual(f.legacy.calls.length, 1);
    assert.strictEqual(f.operations.filter((o) => o[0] === 'unlink').length, 1);
    assert(!f.legacy.queue.active);
  });
}

test('Genuine CLI failure stays a cached failure for an interested replacement without retry', async () => {
  const f = lifecycleFixture();
  const old = f.mount();

  old.observer.visible(true);
  await flush();
  old.componentWillUnmount();
  const current = f.mount();

  current.observer.visible(true);
  f.legacy.calls[0].child.emit('close', 1, null);
  await flush();
  assert.strictEqual(current.state.src, null);
  assert.strictEqual(f.service.cache.size, 1);
  assert.strictEqual([...f.service.cache.values()][0].src, null);
  current.componentWillUnmount();
  const later = f.mount();

  later.observer.visible(true);
  await flush();
  assert.strictEqual(later.state.src, null);
  assert.strictEqual(f.legacy.calls.length, 1);
});

test('Cached Grid/List/Grid remounts retain the preview without provider work', async () => {
  const f = lifecycleFixture();
  const first = f.mount();

  first.observer.visible(true);
  await flush();
  f.legacy.calls[0].child.emit('close', 0, null);
  await flush();
  const preview = first.state.src;

  assert(preview);
  assert.strictEqual(f.service.cache.size, 1);
  first.componentWillUnmount();
  await [0, 1, 2].reduce(async (previous) => {
    await previous;
    const next = f.mount();

    assert.strictEqual(next.render().props.src, 'icon.svg');
    next.observer.visible(true);
    await flush();
    assert.strictEqual(next.render().props.src, preview);
    assert.strictEqual(f.legacy.calls.length, 1);
    assert.strictEqual(f.counts().decoded, 1);
    next.componentWillUnmount();

    return true;
  }, Promise.resolve());
});

for (const change of [
  'generation',
  'storage',
  'backend',
  'directory',
  'listing',
]) {
  test(`Cached preview cannot publish after stale ${change}`, async () => {
    const f = lifecycleFixture();
    const view = f.mount();

    view.observer.visible(true);
    await flush();
    f.legacy.calls[0].child.emit('close', 0, null);
    await flush();
    assert(view.state.src);
    if (change === 'generation') f.reconnect();
    if (change === 'storage') f.changeStorage();
    if (change === 'backend') f.setMode('kalam');
    if (change === 'directory') f.state.Home.currentBrowsePath.mtp = '/Other';
    if (change === 'listing')
      f.state.Home.directoryLists.mtp.nodes = [f.fileItem];
    f.emit();
    assert.strictEqual(view.render().props.src, 'icon.svg');
    assert(!f.isMtpThumbnailContextCurrent(f.context));
    const published = [];

    f.service.request(f.fileItem, {
      context: f.context,
      revision: f.context.key,
      isCurrent: () => f.isMtpThumbnailContextCurrent(f.context),
      onResult: (src) => published.push(src),
    });
    await flush();
    assert.deepStrictEqual(published, []);
    assert.strictEqual(f.legacy.calls.length, 1);
    view.componentWillUnmount();
  });
}

test('A fresh renderer service cannot reuse another renderer blob cache', async () => {
  const first = lifecycleFixture();
  const original = first.mount();

  original.observer.visible(true);
  await flush();
  first.legacy.calls[0].child.emit('close', 0, null);
  await flush();
  assert(original.state.src);
  const second = lifecycleFixture();
  const fresh = second.mount();

  assert.notStrictEqual(second.service, first.service);
  assert.strictEqual(second.service.cache.size, 0);
  assert.strictEqual(fresh.render().props.src, 'icon.svg');
  fresh.observer.visible(true);
  await flush();
  assert.strictEqual(second.legacy.calls.length, 1);
  assert.strictEqual(fresh.state.src, null);
  second.legacy.calls[0].child.emit('close', 0, null);
  await flush();
  assert(fresh.state.src);
  original.componentWillUnmount();
  fresh.componentWillUnmount();
});

test('T2.6 GeneralError retains fallback and cached peers; queue resumes only after close', async () => {
  const f = lifecycleFixture();
  const cached = f.mount();

  cached.observer.visible(true);
  await flush();
  f.legacy.calls[0].child.emit('close', 0, null);
  await flush();
  const preview = cached.state.src;
  const badItem = {
    ...f.fileItem,
    name: 'unavailable-fixture.png',
    path: '/Images/unavailable-fixture.png',
  };
  const laterItem = {
    ...f.fileItem,
    name: 'later.jpg',
    path: '/Images/later.jpg',
  };

  f.context.nodes.push(badItem, laterItem);
  const bad = f.mount(badItem);

  bad.observer.visible(true);
  await flush();
  const { child } = f.legacy.calls[1];
  const stderr = `${usbDiagnostic.repeat(
    7
  )}error: GetThumb: invalid response code GeneralError (0x2002)\n`;

  f.content(Buffer.alloc(0));
  child.stderr.emit('data', Buffer.from(stderr));
  const later = f.mount(laterItem);

  later.observer.visible(true);
  child.emit('exit', 1, null);
  await flush();
  assert(f.legacy.queue.active);
  assert.strictEqual(f.legacy.calls.length, 2);
  assert.strictEqual(bad.render().props.src, 'icon.svg');
  child.emit('close', 1, null);
  await flush();
  assert.strictEqual(f.results[1].processClosed, true);
  assert.strictEqual(f.results[1].exitCode, 1);
  assert.strictEqual(f.results[1].signal, null);
  assert.strictEqual(f.results[1].stderr, stderr);
  assert(f.results[1].error);
  assert.strictEqual(f.legacy.diagnostics[0][0], stderr);
  assert.strictEqual(f.legacy.calls.length, 3);
  assert.strictEqual(bad.render().props.src, 'icon.svg');
  assert.strictEqual(cached.render().props.src, preview);
  assert.strictEqual(f.counts().decoded, 1);
  f.content(png());
  f.legacy.calls[2].child.emit('close', 0, null);
  await flush();
  assert(later.state.src);
  assert(!f.legacy.queue.active);
  assert.strictEqual(f.legacy.queue.fault, null);
  bad.componentWillUnmount();
  const remounted = f.mount(badItem);

  remounted.observer.visible(true);
  cached.componentWillUnmount();
  const cachedAgain = f.mount();

  cachedAgain.observer.visible(true);
  await flush();
  await flush();
  assert.strictEqual(remounted.render().props.src, 'icon.svg');
  assert.strictEqual(cachedAgain.render().props.src, preview);
  assert.strictEqual(f.legacy.calls.length, 3);
  assert.strictEqual(f.calls.length, 3);
  assert(f.legacy.calls.every((call) => call.argv[1].startsWith('get-thumb ')));
  remounted.componentWillUnmount();
  cachedAgain.componentWillUnmount();
  later.componentWillUnmount();
});

test('Visible deferred item reattempts admission when capacity becomes available', () => {
  const f = componentFixture(true);

  f.observers[0].visible(true);
  assert(f.waitingForCapacity());
  assert.strictEqual(f.requests.length, 1);
  f.admit();
  assert.strictEqual(f.requests.length, 2);
  assert(f.requests[0].cancelled);
  assert(!f.waitingForCapacity());
  f.admit();
  assert.strictEqual(f.requests.length, 2);
});

test('Unmount removes capacity subscription without starting deferred work', () => {
  const f = componentFixture(true);

  f.observers[0].visible(true);
  f.view.componentWillUnmount();
  assert(!f.waitingForCapacity());
  f.admit();
  assert.strictEqual(f.requests.length, 1);
});

test('Capacity notification preserves the bounded pending set and FIFO admission', async () => {
  const gates = [];
  const provider = {
    inspect: async (item) => ({ path: item.path, mtimeMs: 1, size: 1 }),
    generate: async () => {
      const gate = deferred();

      gates.push(gate);

      return gate.promise;
    },
  };
  const service = new serviceModule.ThumbnailService({
    provider,
    maxJobs: 1,
    maxPending: 1,
    createUrl: () => 'blob:mock',
    revokeUrl: () => {},
  });
  const request = (name) =>
    service.request(
      { path: name },
      {
        revision: 1,
        isCurrent: () => true,
        onResult: () => {},
      }
    );

  request('a');
  request('b');
  assert(request('c').deferred);
  const unsubscribe = service.subscribeCapacity(() => {
    const handle = request('c');

    if (!handle.deferred) unsubscribe();
  });

  await flush();
  gates[0].resolve({ bytes: png(), width: 160, height: 100 });
  await flush();
  assert.strictEqual(service.pending.size, 1);
  assert.strictEqual(service.active, 1);
  assert.strictEqual(service.capacityListeners.size, 0);
  gates[1].resolve({ bytes: png(), width: 160, height: 100 });
  await flush();
  assert.strictEqual(gates.length, 3);
  gates[2].resolve({ bytes: png(), width: 160, height: 100 });
  await flush();
  assert.strictEqual(service.active, 0);
});

test('Phone uses its own viewport; no request is made merely on mount', () => {
  const f = componentFixture();

  assert.strictEqual(f.requests.length, 0);
  f.observers[0].visible(true);
  assert.strictEqual(f.requests.length, 1);
  assert.strictEqual(f.requests[0].options.context.key, f.context.key);
});
test('List unmount and stale directory changes prevent obsolete publication', () => {
  const f = componentFixture();

  f.observers[0].visible(true);
  f.requests[0].options.onResult('blob:preview');
  assert(f.subscribed());
  f.disconnect();
  f.invalidate();
  assert.strictEqual(f.view.state.src, null);
  assert(f.requests[0].cancelled);
  assert(!f.subscribed());
  assert(!f.requests[0].options.isCurrent());
  f.view.componentWillUnmount();
  f.observers[0].visible(true);
  assert.strictEqual(f.requests.length, 1);
});
test('Grid gates Legacy thumbnails; Kalam and unsupported files keep icons', () => {
  const calls = [];
  let legacy = true;
  const Thumbnail = () => {};
  const Grid = loadJsx(
    'app/containers/HomePage/components/FileExplorerTableBodyGridRender.jsx',
    {
      react,
      classnames: () => 'class',
      '@material-ui/core/styles': { withStyles: () => (value) => value },
      '@material-ui/core/Checkbox': 'Checkbox',
      '@material-ui/core/Typography': 'Typography',
      '@material-ui/core/Tooltip': 'Tooltip',
      '../../../vendors/pretty-file-icons': { getIcon: () => 'image.svg' },
      '../../../utils/funcs': { springTruncate: (name) => ({ text: name }) },
      '../../../constants': { FILE_EXPLORER_GRID_TRUNCATE_MAX_CHARS: 30 },
      '../styles/FileExplorerTableBodyGridRender': { styles: {} },
      '../../../utils/imgsrc': { imgsrc: (value) => value },
      './FileExplorerThumbnail': Thumbnail,
      '../../../data/file-explorer/thumbnails/LocalThumbnailProvider':
        localModule,
      '../../../data/file-explorer/thumbnails/MtpThumbnailProvider': {
        captureMtpThumbnailContext: () => (legacy ? { key: 'legacy' } : null),
      },
    }
  );
  const grid = new Grid({
    classes: {},
    item: { name: 'image.jpg', path: '/image.jpg' },
    deviceType: 'mtp',
    mtpDevice: { isAvailable: true },
    onTableClick: (...values) => calls.push(values),
  });

  assert.strictEqual(grid.RenderFileIcon().props.children[0].type, Thumbnail);
  legacy = false;
  assert.strictEqual(grid.RenderFileIcon().props.children[0].type, 'img');
  grid.props.item = { name: 'file.svg', path: '/file.svg' };
  assert.strictEqual(grid.RenderFileIcon().props.children[0].type, 'img');
  assert.strictEqual(calls.length, 0);
});

if (require.main === module) {
  (async () => {
    let passed = 0;

    await tests.reduce(async (previous, { name, run }) => {
      await previous;
      try {
        await run();
        passed += 1;
        console.info(`PASS ${name}`);
      } catch (error) {
        process.exitCode = 1;
        console.error(`FAIL ${name}`, error);
      }

      return true;
    }, Promise.resolve());
    console.info(`${passed}/${tests.length} Legacy thumbnail tests passed.`);
  })().catch((error) => {
    process.exitCode = 1;
    console.error(error);
  });
}

// Shared mock-only pipeline and JSX loader for focused scrolling tests.
module.exports = { pipelineFixture, loadJsx, react, flush };
