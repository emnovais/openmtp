/* Run with isolated Node 16: NODE_ENV=test node tests/grid-scrolling.test.js */
require('./grid-scrolling-safety');

const assert = require('assert');
const path = require('path');
const {
  pipelineFixture,
  loadJsx,
  react,
  flush,
} = require('./legacy-thumbnails.test');
const { load } = require('./transfer-reliability.test');

const serviceModule = load(
  'app/data/file-explorer/thumbnails/ThumbnailService.js',
  {}
);
const localModule = load(
  'app/data/file-explorer/thumbnails/LocalThumbnailProvider.js',
  {
    fs: { promises: {} },
    path,
    electron: { nativeImage: {} },
  }
);
const tests = [];
const test = (name, run) => tests.push({ name, run });
const serial = (values, run) =>
  values.reduce(async (previous, value) => {
    await previous;

    return run(value);
  }, Promise.resolve());
const supported = (item) => !item.isFolder && /\.(jpe?g|png)$/i.test(item.name);
const directory = (count, prefix = '/Images') =>
  Array.from({ length: count }, (_, index) => {
    const suffix = ['folder', 'jpg', 'PNG', 'txt', 'mov'][index % 5];
    const name = `${String(index).padStart(4, '0')}.${suffix}`;

    return {
      name,
      path: `${prefix}/${name}`,
      size: 1024 + index,
      dateAdded: '2026-10-23',
      isFolder: index % 5 === 0,
    };
  });

function scrollingFixture(count, deviceType = 'mtp') {
  const f = pipelineFixture();
  const items = directory(count);

  f.state.Home.directoryLists.mtp.nodes = items;
  const root = { id: `file-explorer-body-wrapper-${deviceType}` };
  const instances = new Map();
  const observers = new Set();
  const operations = [];
  const publications = [];
  let visible = new Set();
  let localId = 0;
  const localProvider = {
    inspect: async (item) => ({ path: item.path, size: item.size, mtimeMs: 1 }),
    generate: (source) =>
      new Promise((resolve) => {
        operations.push({ path: source.path, resolve, closed: false });
      }),
  };
  const localService = new serviceModule.ThumbnailService({
    provider: localProvider,
    maxJobs: 2,
    createUrl: () => {
      localId += 1;

      return `blob:local-${localId}`;
    },
    revokeUrl: () => {},
  });
  const service = deviceType === 'mtp' ? f.service : localService;

  if (deviceType === 'mtp') service.maxPending = 8;
  let maxActive = 0;
  let maxPending = 0;
  const sample = () => {
    maxActive = Math.max(maxActive, service.active);
    maxPending = Math.max(maxPending, service.pending.size);
  };
  const originalRequest = service.request;

  service.request = function (item, options) {
    const result = originalRequest.call(this, item, {
      ...options,
      onResult: (src) => {
        publications.push({ path: item.path, src });
        options.onResult(src);
      },
    });

    sample();

    return result;
  };

  function Observer(callback, options) {
    Object.assign(this, { callback, options });
    observers.add(this);
    this.observe = (target) => {
      this.target = target;
    };

    this.disconnect = () => {
      this.disconnected = true;
      observers.delete(this);
    };

    this.visible = (isIntersecting) => {
      this.callback([{ target: this.target, isIntersecting }]);
      sample();
    };
  }

  function ServiceStub() {
    return localService;
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
        captureMtpThumbnailContext: f.captureMtpThumbnailContext,
        subscribeMtpThumbnailContext: f.subscribeMtpThumbnailContext,
        getMtpThumbnailService: () => f.service,
      },
    },
    { IntersectionObserver: Observer }
  );
  const mount = (item) => {
    const instance = new Component({
      item,
      deviceType,
      revision: 1,
      mtpContext:
        deviceType === 'mtp' ? f.captureMtpThumbnailContext(item) : null,
      fallbackSrc: 'icon.svg',
      className: 'icon',
      thumbnailClassName: 'thumbnail',
    });

    instance.image.current = {
      closest: (selector) => {
        assert.strictEqual(selector, `#${root.id}`);

        return root;
      },
    };
    instance.componentDidMount();
    instances.set(item.path, instance);

    return instance;
  };
  const mountAll = () => items.filter(supported).forEach(mount);
  const setViewport = (start, end) => {
    visible = new Set(
      items
        .slice(start, end)
        .filter(supported)
        .map((item) => item.path)
    );
    instances.forEach((instance, filePath) =>
      instance.observer?.visible(visible.has(filePath))
    );
  };
  const unmountAll = () => {
    instances.forEach((instance) => instance.componentWillUnmount());
    instances.clear();
  };
  const drain = async () => {
    await serial(Array.from({ length: count + 30 }), async () => {
      await flush();
      if (!service.active && !service.pending.size) return;
      if (deviceType === 'mtp') {
        const call = f.legacy.calls.find((value) => !value.closed);

        assert(call, 'Active native work must have a mocked child');
        call.closed = true;
        call.child.emit('close', 0, null);
      } else {
        const operation = operations.find((value) => !value.closed);

        assert(operation);
        operation.closed = true;
        operation.resolve({ bytes: Buffer.alloc(32), width: 160, height: 100 });
      }

      sample();
    });
    await flush();
    assert.strictEqual(service.active, 0);
    assert.strictEqual(service.pending.size, 0);
  };

  return {
    ...f,
    items,
    root,
    instances,
    observers,
    mount,
    mountAll,
    setViewport,
    unmountAll,
    drain,
    service,
    publications,
    operations,
    visible: () => visible,
    counts: () => ({
      maxActive,
      maxPending,
      native: f.legacy.calls.length,
      local: operations.length,
    }),
  };
}

for (const count of [100, 500, 1000]) {
  test(`${count}: mount alone suppresses offscreen work and uses the panel/nearby margin`, async () => {
    const f = scrollingFixture(count);

    f.mountAll();
    await flush();
    assert.strictEqual(f.observers.size, count * 0.4);
    assert.strictEqual(f.legacy.calls.length, 0);
    f.observers.forEach((observer) => {
      assert.strictEqual(observer.options.root, f.root);
      assert.strictEqual(observer.options.rootMargin, '120px 0px');
    });
    f.unmountAll();
    assert.strictEqual(f.observers.size, 0);
  });
  test(`${count}: scroll down/up requests only visible images and reuses cache`, async () => {
    const f = scrollingFixture(count);

    f.mountAll();
    f.setViewport(0, 12);
    await f.drain();
    assert.strictEqual(
      f.legacy.calls.length,
      f.items.slice(0, 12).filter(supported).length
    );
    const previews = new Map(
      [...f.instances]
        .filter(([, view]) => view.state.src)
        .map(([p, view]) => [p, view.state.src])
    );

    f.setViewport(Math.floor(count / 2), Math.floor(count / 2) + 12);
    await f.drain();
    const beforeReturn = f.legacy.calls.length;

    f.setViewport(0, 12);
    await f.drain();
    assert.strictEqual(f.legacy.calls.length, beforeReturn);
    previews.forEach((src, p) =>
      assert.strictEqual(f.instances.get(p).state.src, src)
    );
    assert.strictEqual(f.counts().maxActive, 1);
    assert(f.counts().maxPending <= 8);
    f.unmountAll();
  });
  test(`${count}: rapid scrolling cancels pending work without releasing the active child`, async () => {
    const f = scrollingFixture(count);

    f.mountAll();
    f.setViewport(0, 30);
    await flush();
    assert.strictEqual(f.legacy.calls.length, 1);
    assert.strictEqual(f.service.pending.size, 8);
    f.setViewport(Math.floor(count / 2), Math.floor(count / 2) + 30);
    f.setViewport(count - 30, count);
    await flush();
    assert.strictEqual(f.legacy.calls.length, 1);
    assert(f.legacy.queue.active);
    f.legacy.calls[0].child.emit('exit', 0, null);
    await flush();
    assert.strictEqual(f.legacy.calls.length, 1);
    assert(f.legacy.queue.active);
    await f.drain();
    const paths = f.calls.map((call) => call.filePath);

    assert.strictEqual(new Set(paths).size, paths.length);
    assert(paths.slice(1).every((p) => f.visible().has(p)));
    f.instances.forEach((view, p) => {
      if (!f.visible().has(p)) assert.strictEqual(view.state.src, null);
    });
    assert(f.counts().maxPending <= 8);
    f.unmountAll();
  });
  test(`${count}: replacement joins the active identity without obsolete publication`, async () => {
    const f = scrollingFixture(count);

    f.mountAll();
    f.setViewport(1, 2);
    await flush();
    const old = f.instances.get(f.items[1].path);

    old.componentWillUnmount();
    const next = f.mount(f.items[1]);

    next.observer.visible(true);
    assert.strictEqual(f.service.pending.size, 0);
    assert.strictEqual(f.legacy.calls.length, 1);
    await f.drain();
    assert.strictEqual(old.state.src, null);
    assert(next.state.src);
    assert.strictEqual(f.legacy.calls.length, 1);
    f.unmountAll();
  });
  test(`${count}: stale directory fences active results and removes waiting consumers`, async () => {
    const f = scrollingFixture(count);

    f.mountAll();
    f.setViewport(0, 30);
    await flush();
    f.state.Home.currentBrowsePath.mtp = '/Other';
    f.state.Home.directoryLists.mtp.nodes = [];
    f.emit();
    assert(f.legacy.queue.active);
    await f.drain();
    assert.strictEqual(f.legacy.calls.length, 1);
    assert.strictEqual(f.service.cache.size, 0);
    assert(f.publications.every((p) => !p.src));
    f.unmountAll();
  });
  test(`${count}: repeated Grid/List/Grid cycles use cache and create no List requests`, async () => {
    const f = scrollingFixture(count);

    f.mountAll();
    f.setViewport(0, 12);
    await f.drain();
    const calls = f.legacy.calls.length;

    await serial([1, 2, 3], async () => {
      f.unmountAll();
      await flush();
      assert.strictEqual(f.legacy.calls.length, calls);
      assert.strictEqual(f.service.capacityListeners.size, 0);
      f.mountAll();
      f.setViewport(0, 12);
      await f.drain();
      assert.strictEqual(f.legacy.calls.length, calls);
    });
    f.unmountAll();
  });
  test(`${count}: Grid/List/Grid while work is pending retains one shared child`, async () => {
    const f = scrollingFixture(count);

    f.mountAll();
    f.setViewport(0, 12);
    await flush();
    f.unmountAll();
    assert(f.legacy.queue.active);
    f.mountAll();
    f.setViewport(0, 12);
    assert.strictEqual(f.legacy.calls.length, 1);
    await f.drain();
    assert.strictEqual(
      new Set(f.calls.map((c) => c.filePath)).size,
      f.calls.length
    );
    f.unmountAll();
  });
  test(`${count}: local scrolling uses its separate two-job service and returns cached images`, async () => {
    const f = scrollingFixture(count, 'local');

    f.mountAll();
    assert.strictEqual(f.operations.length, 0);
    f.setViewport(0, 12);
    await f.drain();
    const calls = f.operations.length;

    f.setViewport(count - 12, count);
    await f.drain();
    const beforeReturn = f.operations.length;

    f.setViewport(0, 12);
    await f.drain();
    assert.strictEqual(f.operations.length, beforeReturn);
    assert(beforeReturn > calls);
    assert.strictEqual(f.counts().maxActive, 2);
    assert.strictEqual(f.legacy.calls.length, 0);
    f.unmountAll();
  });
}

test('Computer and Phone visibility, caches and running lanes are independent', async () => {
  const phone = scrollingFixture(100);
  const computer = scrollingFixture(100, 'local');

  phone.mountAll();
  computer.mountAll();
  phone.setViewport(0, 12);
  await flush();
  assert.strictEqual(phone.legacy.calls.length, 1);
  assert.strictEqual(computer.operations.length, 0);
  computer.setViewport(50, 62);
  await computer.drain();
  assert.strictEqual(phone.legacy.calls.length, 1);
  assert(phone.legacy.queue.active);
  phone.unmountAll();
  await phone.drain();
  assert.strictEqual(computer.service.active, 0);
  assert(computer.service.cache.size > 0);
  computer.unmountAll();
});

async function run() {
  let passed = 0;

  await serial(tests, async ({ name, run: execute }) => {
    try {
      await execute();
      passed += 1;
      console.info(`PASS ${name}`);
    } catch (error) {
      process.exitCode = 1;
      console.error(`FAIL ${name}`, error);
    }
  });
  console.info(`${passed}/${tests.length} Grid scrolling tests passed.`);
}

if (require.main === module)
  run().catch((error) => {
    process.exitCode = 1;
    console.error(error);
  });
module.exports = { directory, supported, scrollingFixture };
