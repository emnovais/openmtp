/* Run with Node 16: NODE_ENV=test node tests/image-thumbnails.test.js */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const babel = require('@babel/core');
const { load } = require('./transfer-reliability.test');

const tests = [];
const test = (name, run) => tests.push({ name, run });
const flush = () => new Promise((resolve) => setImmediate(resolve));
const providerPath = 'app/data/file-explorer/thumbnails/LocalThumbnailProvider';
const servicePath = 'app/data/file-explorer/thumbnails/ThumbnailService';
const providerModule = load(`${providerPath}.js`, {
  fs: { promises: {} },
  path,
  electron: { nativeImage: {} },
});
const { LocalThumbnailProvider, isLocalThumbnailItem, MAX_SOURCE_BYTES } =
  providerModule;
const { ThumbnailService } = load(`${servicePath}.js`, {});
const item = (name = 'image.jpg') => ({
  name,
  path: `/fixtures/${name}`,
  isFolder: false,
  size: 32,
  dateAdded: 'listing-date',
});
const png = () => {
  const bytes = Buffer.alloc(32);

  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
  bytes.write('IHDR', 12);
  bytes.writeUInt32BE(640, 16);
  bytes.writeUInt32BE(480, 20);

  return bytes;
};
const jpeg = () => {
  const bytes = Buffer.alloc(32);

  Buffer.from('ffd8ffc0001108', 'hex').copy(bytes);
  bytes.writeUInt16BE(480, 7);
  bytes.writeUInt16BE(640, 9);

  return bytes;
};
const image = () => ({ bytes: png(), width: 160, height: 120 });
const deferred = () => {
  let resolveResult;
  let rejectResult;
  const promise = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  return { promise, resolve: resolveResult, reject: rejectResult };
};

function providerFixture(options = {}) {
  const header = options.header || png();
  const stats = {
    size: options.size ?? header.length,
    mtimeMs: 100,
    ctimeMs: 100,
    ino: 1,
    isFile: () => true,
  };
  const calls = { native: 0, closed: 0, read: 0 };
  const files = {
    realpath: async () => '/canonical/image',
    open: async () => ({
      stat: async () => stats,
      read: async (buffer) => {
        calls.read += 1;

        return { bytesRead: header.copy(buffer) };
      },
      close: async () => {
        calls.closed += 1;
      },
    }),
    stat: async () => stats,
  };
  const output = {
    isEmpty: () => false,
    getSize: () => ({ width: 160, height: 120 }),
    toPNG: png,
  };
  const images = {
    createThumbnailFromPath: async (filePath, dimensions) => {
      calls.native += 1;
      assert.strictEqual(filePath, '/canonical/image');
      assert.strictEqual(dimensions.width, 160);

      return output;
    },
  };

  return {
    provider: new LocalThumbnailProvider({ files, images }),
    files,
    images,
    stats,
    output,
    calls,
  };
}

function serviceFixture(options = {}) {
  const generated = [];
  const revoked = [];
  let serial = 0;
  const provider = {
    inspect: async (value) => ({
      path: value.path,
      size: 32,
      mtimeMs: 100,
    }),
    generate: async () => {
      const gate = deferred();

      generated.push(gate);
      if (!options.hold) gate.resolve(image());

      return gate.promise;
    },
  };
  const service = new ThumbnailService({
    provider,
    createUrl: () => {
      serial += 1;

      return `blob:thumbnail-${serial}`;
    },
    revokeUrl: (url) => revoked.push(url),
    ...options,
  });
  const results = [];
  const request = (value = item(), extra = {}) =>
    service.request(value, {
      revision: 1,
      isCurrent: () => true,
      onResult: (url) => results.push(url),
      ...extra,
    });

  return { service, provider, generated, revoked, results, request };
}

for (const name of ['photo.jpg', 'photo.JPEG', 'photo.PNG']) {
  test(`Accept local ${name}`, () => {
    assert(isLocalThumbnailItem(item(name), 'local'));
  });
}

for (const name of ['photo.svg', 'photo.gif', 'video.mov', 'image.jpg.exe']) {
  test(`Exclude ${name}`, () => {
    assert(!isLocalThumbnailItem(item(name), 'local'));
  });
}

test('Exclude Android images and folders', () => {
  assert(!isLocalThumbnailItem(item(), 'mtp'));
  assert(!isLocalThumbnailItem({ ...item(), isFolder: true }, 'local'));
});
for (const name of ['image.png', 'image.jpg', 'image.jpeg']) {
  test(`Validate and generate ${name} from canonical path`, async () => {
    const f = providerFixture({
      header: name.endsWith('png') ? png() : jpeg(),
    });
    const source = await f.provider.inspect(item(name));
    const output = await f.provider.generate(source, {
      width: 160,
      height: 160,
    });

    assert.strictEqual(source.path, '/canonical/image');
    assert.strictEqual(source.mtimeMs, 100);
    assert.strictEqual(source.size, 32);
    assert.strictEqual(output.width, 160);
    assert.strictEqual(f.calls.closed, 1);
    assert.strictEqual(f.calls.native, 1);
  });
}

test('Reject unsupported files without opening them', async () => {
  const f = providerFixture();

  await assert.rejects(f.provider.inspect(item('file.svg')), /Unsupported/);
  assert.strictEqual(f.calls.read, 0);
  assert.strictEqual(f.calls.native, 0);
});
test('Reject oversized files before header read or generation', async () => {
  const f = providerFixture({ size: MAX_SOURCE_BYTES + 1 });

  await assert.rejects(f.provider.inspect(item('file.png')), /limits/);
  assert.strictEqual(f.calls.read, 0);
  assert.strictEqual(f.calls.closed, 1);
  assert.strictEqual(f.calls.native, 0);
});
test('Corrupt header falls back and closes its descriptor', async () => {
  const f = providerFixture({ header: Buffer.alloc(32) });

  await assert.rejects(f.provider.inspect(item('file.png')), /invalid/);
  assert.strictEqual(f.calls.closed, 1);
  assert.strictEqual(f.calls.native, 0);
});
test('Reject excessive image dimensions', async () => {
  const header = png();

  header.writeUInt32BE(100000, 16);
  const f = providerFixture({ header });

  await assert.rejects(f.provider.inspect(item('file.png')), /dimensions/);
  assert.strictEqual(f.calls.native, 0);
});
for (const code of ['ENOENT', 'EACCES']) {
  test(`Handle ${code} without native generation`, async () => {
    const f = providerFixture();

    f.files.open = async () => {
      throw new Error(code);
    };

    await assert.rejects(
      f.provider.inspect(item('file.png')),
      new RegExp(code)
    );
    assert.strictEqual(f.calls.native, 0);
  });
}

test('Native decode failure rejects without source writes', async () => {
  const f = providerFixture();
  const source = await f.provider.inspect(item('file.png'));

  f.output.isEmpty = () => true;
  await assert.rejects(
    f.provider.generate(source, { width: 160, height: 160 }),
    /failed/
  );
});
test('Reject changed or removed source during generation', async () => {
  const f = providerFixture();
  const source = await f.provider.inspect(item('file.png'));

  f.images.createThumbnailFromPath = async () => {
    f.stats.mtimeMs += 1;

    return f.output;
  };

  await assert.rejects(
    f.provider.generate(source, { width: 160, height: 160 }),
    /obsolete/
  );
  f.files.stat = async () => {
    throw new Error('ENOENT');
  };

  await assert.rejects(
    f.provider.generate(source, { width: 160, height: 160 }),
    /ENOENT/
  );
});
test('Reject a full-resolution native result', async () => {
  const f = providerFixture();
  const source = await f.provider.inspect(item('file.png'));

  f.output.getSize = () => ({ width: 640, height: 480 });
  await assert.rejects(
    f.provider.generate(source, { width: 160, height: 160 }),
    /Invalid/
  );
});
test('Duplicate canonical paths share one generation', async () => {
  const f = serviceFixture({ hold: true });

  f.provider.inspect = async () => ({
    path: '/canonical',
    mtimeMs: 1,
    size: 32,
  });
  f.request(item('a.jpg'));
  f.request(item('alias.jpg'));
  await flush();
  assert.strictEqual(f.generated.length, 1);
  f.generated[0].resolve(image());
  await flush();
  assert.strictEqual(f.results.length, 2);
  assert.strictEqual(f.results[0], f.results[1]);
});
test('At most two jobs; logical cancellation retains native slot', async () => {
  const f = serviceFixture({ hold: true });
  const first = f.request(item('a.jpg'));

  f.request(item('b.jpg'));
  f.request(item('c.jpg'));
  await flush();
  assert.strictEqual(f.generated.length, 2);
  first.cancel();
  await flush();
  assert.strictEqual(f.generated.length, 2);
  f.generated[0].resolve(image());
  await flush();
  assert.strictEqual(f.generated.length, 3);
  assert.strictEqual(f.results.length, 0);
  f.generated[1].resolve(image());
  f.generated[2].resolve(image());
  await flush();
  assert.strictEqual(f.service.active, 0);
});

test('Replacement joins the active job without using a pending slot', async () => {
  const f = serviceFixture({ hold: true, maxJobs: 1, maxPending: 1 });
  const oldResults = [];
  const currentResults = [];
  const first = f.request(item(), { onResult: (src) => oldResults.push(src) });

  await flush();
  first.cancel();
  const replacement = f.request(item(), {
    onResult: (src) => currentResults.push(src),
  });

  assert(!replacement.deferred);
  assert.strictEqual(f.service.pending.size, 0);
  assert.strictEqual(f.service.active, 1);
  f.generated[0].resolve(image());
  await flush();
  assert.strictEqual(f.generated.length, 1);
  assert.deepStrictEqual(oldResults, []);
  assert.deepStrictEqual(currentResults, ['blob:thumbnail-1']);
  assert.strictEqual(f.service.running.size, 0);
});

test('Replacement can join an active job while the pending set is full', async () => {
  const f = serviceFixture({ hold: true, maxJobs: 1, maxPending: 1 });
  const first = f.request(item('a.jpg'));
  const queued = f.request(item('b.jpg'));

  await flush();
  first.cancel();
  assert(!f.request(item('a.jpg')).deferred);
  assert.strictEqual(f.service.pending.size, 1);
  queued.cancel();
  f.generated[0].resolve(image());
  await flush();
  assert.strictEqual(f.generated.length, 1);
  assert.deepStrictEqual(f.results, ['blob:thumbnail-1']);
});

for (const change of ['revision', 'context', 'size', 'date']) {
  test(`Changed ${change} cannot join the active request identity`, async () => {
    const f = serviceFixture({ hold: true, maxJobs: 1 });
    const first = f.request(item(), { context: { key: 'original' } });

    await flush();
    first.cancel();
    const value = item();
    const options = { context: { key: 'original' } };

    if (change === 'revision') options.revision = 2;
    if (change === 'context') options.context = { key: 'new-session' };
    if (change === 'size') value.size += 1;
    if (change === 'date') value.dateAdded = 'new-date';
    f.request(value, options);
    assert.strictEqual(f.service.pending.size, 1);
    f.generated[0].resolve(image());
    await flush();
    assert.strictEqual(f.results.length, 0);
    assert.strictEqual(f.generated.length, 2);
    f.generated[1].resolve(image());
    await flush();
    assert.deepStrictEqual(f.results, ['blob:thumbnail-1']);
  });
}

test('Repeated cancellation of an old queued handle cannot delete its replacement', async () => {
  const f = serviceFixture({ hold: true, maxJobs: 1 });

  f.request(item('blocker.jpg'));
  const old = f.request(item('queued.jpg'));

  old.cancel();
  f.request(item('queued.jpg'));
  old.cancel();
  assert.strictEqual(f.service.pending.size, 1);
  await flush();
  f.generated[0].resolve(image());
  await flush();
  assert.strictEqual(f.generated.length, 2);
  f.generated[1].resolve(image());
  await flush();
  assert.strictEqual(f.results.length, 2);
});

test('An abandoned failed job does not create a negative cache entry', async () => {
  const f = serviceFixture({ hold: true, maxJobs: 1 });
  const handle = f.request();

  await flush();
  handle.cancel();
  f.generated[0].reject(new Error('No consumer remains'));
  await flush();
  assert.strictEqual(f.service.cache.size, 0);
  assert.strictEqual(f.service.running.size, 0);
  assert.strictEqual(f.results.length, 0);
  assert.strictEqual(f.service.active, 0);
});

test('Cancelling one of two interested consumers preserves the shared result', async () => {
  const f = serviceFixture({ hold: true, maxJobs: 1 });
  const first = f.request();

  await flush();
  f.request();
  first.cancel();
  f.generated[0].resolve(image());
  await flush();
  assert.strictEqual(f.generated.length, 1);
  assert.deepStrictEqual(f.results, ['blob:thumbnail-1']);
});

test('An obsolete consumer cannot invalidate a newer consumers cached preview', async () => {
  const f = serviceFixture();
  const old = f.request();

  await flush();
  old.cancel();
  const current = f.request();

  await flush();
  old.fail();
  assert.strictEqual(f.revoked.length, 0);
  assert(!f.results.includes(null));
  assert.strictEqual(f.generated.length, 1);
  current.fail();
  assert.deepStrictEqual(f.revoked, ['blob:thumbnail-1']);
  assert(f.results.includes(null));
});
test('Cancelled queued job never generates', async () => {
  const f = serviceFixture({ hold: true });

  f.request(item('a.jpg'));
  f.request(item('b.jpg'));
  const third = f.request(item('c.jpg'));

  third.cancel();
  await flush();
  f.generated.forEach((gate) => gate.resolve(image()));
  await flush();
  assert.strictEqual(f.generated.length, 2);
});
test('Stale in-flight result cannot publish or allocate an URL', async () => {
  const f = serviceFixture({ hold: true });
  let current = true;

  f.request(item(), { isCurrent: () => current });
  await flush();
  current = false;
  f.generated[0].resolve(image());
  await flush();
  assert.strictEqual(f.results.length, 0);
  assert.strictEqual(f.service.cache.size, 0);
});
test('Cache hit avoids generation; modification changes cache identity', async () => {
  const f = serviceFixture();
  let mtimeMs = 1;

  f.provider.inspect = async () => ({ path: '/canonical', mtimeMs, size: 32 });
  f.request();
  await flush();
  f.request();
  await flush();
  assert.strictEqual(f.generated.length, 1);
  mtimeMs += 1;
  f.request();
  await flush();
  assert.strictEqual(f.generated.length, 2);
  assert.notStrictEqual(f.results[0], f.results[2]);
});
test('LRU eviction revokes URLs and removes visible references', async () => {
  const f = serviceFixture({ maxEntries: 1 });

  f.request(item('a.jpg'));
  await flush();
  const first = f.results[0];

  f.request(item('b.jpg'));
  await flush();
  assert.strictEqual(f.service.cache.size, 1);
  assert(f.revoked.includes(first));
  assert(f.results.includes(null));
});
test('Cache byte limit rejects oversized output without URL allocation', async () => {
  const f = serviceFixture({ maxBytes: 1 });

  f.request();
  await flush();
  assert.strictEqual(f.service.bytes, 0);
  assert.strictEqual(f.results[0], null);
});
test('Default cache holds at most 64 thumbnails', async () => {
  const f = serviceFixture();

  await Array.from({ length: 66 }).reduce(async (previous, _, i) => {
    await previous;
    f.request(item(`${i}.jpg`));
    await flush();

    return true;
  }, Promise.resolve());

  assert.strictEqual(f.service.cache.size, 64);
  assert.strictEqual(f.revoked.length, 2);
  assert(f.service.bytes <= f.service.maxBytes);
});
test('Decode failure is cached without a retry loop', async () => {
  const f = serviceFixture();
  let count = 0;

  f.provider.generate = async () => {
    count += 1;
    throw new Error('Corrupt');
  };

  f.request();
  await flush();
  f.request();
  await flush();
  assert.strictEqual(count, 1);
  assert.strictEqual(f.results[0], null);
});
test('Missing source is suppressed until the listing revision changes', async () => {
  const f = serviceFixture();
  let count = 0;

  f.provider.inspect = async () => {
    count += 1;
    throw new Error('ENOENT');
  };

  f.request();
  await flush();
  f.request();
  await flush();
  assert.strictEqual(count, 1);
  f.request(item(), { revision: 2 });
  await flush();
  assert.strictEqual(count, 2);
});
test('Image loading failure releases its URL and caches fallback', async () => {
  const f = serviceFixture();
  const request = f.request();

  await flush();
  request.fail();
  assert.strictEqual(f.revoked.length, 1);
  f.request();
  await flush();
  assert.strictEqual(f.generated.length, 1);
  assert.strictEqual(f.results[f.results.length - 1], null);
});

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
    require(name) {
      assert(
        Object.prototype.hasOwnProperty.call(mocks, name),
        `Unmocked import: ${name}`
      );

      return mocks[name];
    },
  });

  return module.exports.default;
}

function componentFixture(withObserver = true) {
  const requests = [];
  const observers = [];

  function ServiceStub() {
    this.request = (value, options) => {
      const request = { value, options, cancelled: false };

      requests.push(request);

      return {
        cancel: () => {
          request.cancelled = true;
        },
        fail: () => options.onResult(null),
      };
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

    intersect(visible) {
      this.callback([{ target: this.target, isIntersecting: visible }]);
    }
  }
  const Component = loadJsx(
    'app/containers/HomePage/components/FileExplorerThumbnail.jsx',
    {
      react,
      '../../../data/file-explorer/thumbnails/LocalThumbnailProvider':
        providerModule,
      '../../../data/file-explorer/thumbnails/ThumbnailService': {
        ThumbnailService: ServiceStub,
      },
    },
    withObserver ? { IntersectionObserver: Observer } : {}
  );
  const root = {};
  const view = new Component({
    item: item(),
    revision: 1,
    deviceType: 'local',
    fallbackSrc: 'icon.svg',
    className: 'icon',
    thumbnailClassName: 'thumbnail',
  });

  view.image.current = {
    closest: (selector) => {
      assert.strictEqual(selector, '#file-explorer-body-wrapper-local');

      return root;
    },
  };
  view.componentDidMount();

  return { view, requests, observers, root };
}

test('Visible-item admission uses local scroll root, not mount', () => {
  const f = componentFixture();

  assert.strictEqual(f.requests.length, 0);
  assert.strictEqual(f.observers[0].options.root, f.root);
  f.observers[0].intersect(false);
  assert.strictEqual(f.requests.length, 0);
  f.observers[0].intersect(true);
  f.observers[0].intersect(true);
  assert.strictEqual(f.requests.length, 1);
});
test('Without IntersectionObserver keep icon and request nothing', () => {
  const f = componentFixture(false);

  assert.strictEqual(f.requests.length, 0);
  assert.strictEqual(f.view.render().props.src, 'icon.svg');
});
test('Leaving viewport logically cancels and releases displayed preview', () => {
  const f = componentFixture();

  f.observers[0].intersect(true);
  f.requests[0].options.onResult('blob:preview');
  assert.strictEqual(f.view.render().props.src, 'blob:preview');
  f.observers[0].intersect(false);
  assert(f.requests[0].cancelled);
  assert(!f.requests[0].options.isCurrent());
  assert.strictEqual(f.view.render().props.src, 'icon.svg');
});
test('Grid-to-List unmount invalidates requests and disconnects observer', () => {
  const f = componentFixture();

  f.observers[0].intersect(true);
  f.view.componentWillUnmount();
  assert(f.requests[0].cancelled);
  assert(!f.requests[0].options.isCurrent());
  f.observers[0].intersect(true);
  assert.strictEqual(f.requests.length, 1);
});
test('Navigation rejects stale results and old observer callbacks', () => {
  const f = componentFixture();

  f.observers[0].intersect(true);
  const prev = f.view.props;

  f.view.props = { ...prev, item: item('next.png'), revision: 2 };
  f.view.componentDidUpdate(prev);
  assert(!f.requests[0].options.isCurrent());
  f.observers[0].intersect(true);
  assert.strictEqual(f.requests.length, 1);
  f.observers[1].intersect(true);
  assert.strictEqual(f.requests[1].value.name, 'next.png');
});
test('Preview preserves image context handler and adds only thumbnail class', () => {
  const f = componentFixture();
  const handler = () => {};

  f.view.props.onContextMenu = handler;
  f.observers[0].intersect(true);
  f.requests[0].options.onResult('blob:preview');
  const imageNode = f.view.render();

  assert.strictEqual(imageNode.props.onContextMenu, handler);
  assert.strictEqual(imageNode.props.className, 'icon thumbnail');
  assert.strictEqual(imageNode.props.alt, 'image.jpg');
});
test('Grid integration preserves selection, double-click, drag and context menu', () => {
  const calls = [];
  const Thumbnail = () => {};
  const mocks = {
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
      providerModule,
  };
  const Grid = loadJsx(
    'app/containers/HomePage/components/FileExplorerTableBodyGridRender.jsx',
    mocks
  );
  const props = {
    classes: {},
    item: item(),
    deviceType: 'local',
    directoryGeneratedTime: 5,
    tableData: {},
    onTableClick: (...args) => calls.push(['selection', ...args]),
    onTableDoubleClick: (...args) => calls.push(['open', ...args]),
    onContextMenuClick: (...args) => calls.push(['context', ...args]),
  };
  const grid = new Grid(props);
  const tree = grid.render();

  tree.props.onDoubleClick({});
  tree.props.onDragStart({});
  tree.props.onContextMenu({});
  tree.props.children[0].props.children[0].props.onClick({});
  assert.strictEqual(
    calls.map((c) => c[0]).join(','),
    'open,selection,context,selection'
  );
  assert.strictEqual(calls[0][1], props.item);
  assert.strictEqual(calls[1][1], props.item.path);
  assert.strictEqual(tree.props.draggable, 'true');
  assert.strictEqual(grid.RenderFileIcon().props.children[0].type, Thumbnail);
  grid.props = { ...props, deviceType: 'mtp' };
  assert.strictEqual(grid.RenderFileIcon().props.children[0].type, 'img');
  grid.props = { ...props, item: item('unsupported.svg') };
  assert.strictEqual(grid.RenderFileIcon().props.children[0].type, 'img');
  assert.strictEqual(grid.RenderFolderIcon().props.children[0].type, 'img');
});

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

  console.info(`${passed}/${tests.length} image thumbnail tests passed.`);
})().catch((error) => {
  process.exitCode = 1;
  console.error(error);
});
