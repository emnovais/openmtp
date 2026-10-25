/* Offline real-DOM/native-IntersectionObserver scrolling and presentation checks. */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const babel = require('@babel/core');
const Module = require('module');
const { createRequire } = require('module');
const sortBy = require('lodash/sortBy');
const niceUtils = require('nice-utils');
const semver = require('semver');
const dayjs = require('dayjs');
const advancedFormat = require('dayjs/plugin/advancedFormat');
const React = require('react');
const ReactDOM = require('react-dom');
const { ipcRenderer, nativeImage } = require('electron');

require('./grid-scrolling-safety');

const repo = path.resolve(__dirname, '..');
const appRequire = createRequire(path.join(repo, 'package.json'));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const compiled = new Map();

function load(relative, mocks = {}) {
  if (!compiled.has(relative)) {
    compiled.set(
      relative,
      babel.transformSync(fs.readFileSync(path.join(repo, relative), 'utf8'), {
        filename: relative,
        configFile: false,
        babelrc: false,
        presets: [require.resolve('@babel/preset-react')],
        plugins: [
          require.resolve('@babel/plugin-proposal-class-properties'),
          require.resolve('@babel/plugin-transform-modules-commonjs'),
        ],
      }).code
    );
  }

  const subject = new Module(path.join(repo, relative), module);

  subject.require = (requested) => {
    const aliases = {
      '../../app/containers/HomePage/components/FileExplorerTableBodyGridRender':
        './FileExplorerTableBodyGridRender',
      '../../app/utils/funcs': '../../../utils/funcs',
      '../../app/containers/HomePage/styles/FileExplorerTableBodyGridWrapperRender':
        '../styles/FileExplorerTableBodyGridWrapperRender',
    };
    const name = aliases[requested] || requested;

    if (Object.prototype.hasOwnProperty.call(mocks, name)) return mocks[name];
    if (
      name === 'react' ||
      name === 'classnames' ||
      name.startsWith('@material-ui/') ||
      name.startsWith('@fortawesome/')
    )
      return appRequire(name);
    throw new Error(`Unmocked renderer dependency: ${name}`);
  };

  // Compile trusted repository JSX in the renderer's own realm. DOM/native
  // observer objects must not cross a vm context boundary on Electron 18.
  subject._compile(compiled.get(relative), path.join(repo, relative));

  return subject.exports;
}

function methods(relative, names, globals = {}) {
  const ast = babel.parseSync(
    fs.readFileSync(path.join(repo, relative), 'utf8'),
    {
      configFile: false,
      babelrc: false,
      parserOpts: { sourceType: 'module', plugins: ['jsx', 'classProperties'] },
    }
  );
  const source = ast.program.body.find(
    (node) => node.type === 'ClassDeclaration'
  );
  const members = source.body.body.filter((node) =>
    names.includes(node.key?.name)
  );

  assert.strictEqual(members.length, names.length);
  const tree = babel.types.file(
    babel.types.program([
      babel.types.classDeclaration(
        babel.types.identifier('Subject'),
        null,
        babel.types.classBody(members)
      ),
    ])
  );
  const { code } = babel.transformFromAstSync(tree, null, {
    configFile: false,
    babelrc: false,
    plugins: [require.resolve('@babel/plugin-proposal-class-properties')],
  });

  const subject = new Module(path.join(repo, relative), module);

  subject.require = (name) => {
    assert.strictEqual(name, 'test-globals');

    return globals;
  };

  subject._compile(
    `const {${Object.keys(globals).join(
      ','
    )}} = require('test-globals');\n${code};module.exports = new Subject();`,
    path.join(repo, relative)
  );

  return subject.exports;
}

const enumValues = {
  DEVICE_TYPE: { local: 'local', mtp: 'mtp' },
  MTP_MODE: { legacy: 'legacy', kalam: 'kalam' },
  FILE_EXPLORER_VIEW_TYPE: { list: 'list', grid: 'grid' },
};
const utils = load('app/utils/funcs.js', {
  'nice-utils': niceUtils,
  semver,
  '../constants/dom': { APP_TITLEBAR_DOM_ID: 'title' },
  '../constants/meta': { APP_VERSION: '3.3.0' },
});
const mixins = load('app/styles/js/mixins.js', {
  '../../utils/checkIf': { checkIf() {} },
});
const commonStyles = { '../../../styles/js': { mixins: mixins.default } };
const fallback = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="150" height="150"><rect x="25" y="8" width="100" height="130" fill="#999"/></svg>'
)}`;
const constants = {
  FILE_EXPLORER_GRID_TRUNCATE_MAX_CHARS: 20,
  FILE_EXPLORER_TABLE_TRUNCATE_MAX_CHARS: 37,
  DEVICES_LABEL: { local: 'Computer', mtp: 'Phone' },
};
const shared = {
  '../../../utils/funcs': utils,
  '../../../constants': constants,
  '../../../vendors/pretty-file-icons': { getIcon: () => '' },
  '../../../utils/imgsrc': { imgsrc: () => fallback },
  '../../../enums': enumValues,
};
const Table = require('@material-ui/core/Table').default;
const TableBody = require('@material-ui/core/TableBody').default;
const { createMuiTheme, ThemeProvider } = require('@material-ui/core/styles');
const { directory, supported } = require('./grid-scrolling.test');
const { pipelineFixture } = require('./legacy-thumbnails.test');

const theme = createMuiTheme({
  palette: { fileExplorerThinLineDividerColor: '#ddd', fileDrop: '#eee' },
});
const serial = (values, run) =>
  values.reduce(async (previous, value) => {
    await previous;

    return run(value);
  }, Promise.resolve());

async function wait(predicate, label) {
  // Observation limit, not a native timeout or cancellation mechanism.
  const deadline = performance.now() + 30000;

  async function poll() {
    if (predicate()) return;
    if (performance.now() > deadline)
      throw new Error(`Timed out observing ${label}`);
    await pause(20);

    return poll();
  }

  return poll();
}

const wrapperSource =
  process.env.OPENMTP_GRID_WRAPPER ||
  'app/containers/HomePage/components/FileExplorerTableBodyGridWrapperRender.jsx';

assert(
  [
    'tests/fixtures/grid-windowed-prototype.jsx',
    'tests/fixtures/grid-batched-wrapper.jsx',
    'app/containers/HomePage/components/FileExplorerTableBodyGridWrapperRender.jsx',
  ].includes(wrapperSource)
);
const virtual = fs
  .readFileSync(path.join(repo, wrapperSource), 'utf8')
  .includes('OVERSCAN_ROWS');
const extended = process.env.OPENMTP_T4_EXTENDED === '1';

async function scenario(count) {
  const f = pipelineFixture();

  f.service.maxPending = 8;
  const nodes = directory(count);

  nodes[2] = {
    ...nodes[2],
    name: '0002_a_long_filename_that_must_keep_the_existing_truncation.PNG',
    path: '/Images/0002_a_long_filename_that_must_keep_the_existing_truncation.PNG',
  };
  nodes[1].size = 0;
  f.state.Home.directoryLists.mtp.nodes = nodes;
  const localNodes = nodes.map((item) => ({
    ...item,
    path: item.path.replace('/Images/', '/Computer/'),
  }));
  const canvas = document.createElement('canvas');

  canvas.width = 160;
  canvas.height = 100;
  const paint = canvas.getContext('2d');

  paint.fillStyle = '#346ddd';
  paint.fillRect(0, 0, 160, 100);
  const png = Buffer.from(
    canvas.toDataURL('image/png').split(',')[1],
    'base64'
  );
  const native = nativeImage.createFromBuffer(png);
  const jpeg = native.toJPEG(80);

  f.content(png);
  f.images.createFromBuffer = (bytes) => nativeImage.createFromBuffer(bytes);
  const url = (bytes) =>
    URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));

  f.service.createUrl = url;
  f.service.revokeUrl = (value) => URL.revokeObjectURL(value);
  const metrics = {
    count,
    providerRequests: { mtp: 0, local: 0 },
    cacheHits: { mtp: 0, local: 0 },
    maxActive: { mtp: 0, local: 0 },
    peakPending: { mtp: 0, local: 0 },
    providerPaths: [],
    frames: [],
    stages: [],
  };
  let localService;
  const services = () => ({ mtp: f.service, local: localService });
  const panel = (type) =>
    document.getElementById(`file-explorer-body-wrapper-${type}`);
  const target = (item) =>
    [...panel('mtp').querySelectorAll('img')].find(
      (element) => element.alt === item.name
    );
  const sourceBytes = (file) => (/\.png$/i.test(file) ? png : jpeg);
  const stats = (file) => ({
    isFile: () => true,
    size: sourceBytes(file).length,
    mtimeMs: 1,
    ctimeMs: 1,
    ino: file,
  });
  const localProvider = load(
    'app/data/file-explorer/thumbnails/LocalThumbnailProvider.js',
    {
      path,
      fs: {
        promises: {
          realpath: async (file) => file,
          open: async (file) => ({
            stat: async () => stats(file),
            read: async (buffer) => ({
              bytesRead: sourceBytes(file).copy(buffer),
            }),
            close: async () => {},
          }),
          stat: async (file) => stats(file),
        },
      },
      electron: {
        nativeImage: {
          createThumbnailFromPath: async () => {
            await pause(8);

            return native;
          },
        },
      },
    }
  );
  const serviceModule = load(
    'app/data/file-explorer/thumbnails/ThumbnailService.js'
  );

  function ServiceSpy(options) {
    localService = new serviceModule.ThumbnailService({
      ...options,
      createUrl: url,
      revokeUrl: (value) => URL.revokeObjectURL(value),
    });

    return localService;
  }

  const mtp = {
    captureMtpThumbnailContext: f.captureMtpThumbnailContext,
    isMtpThumbnailContextCurrent: f.isMtpThumbnailContextCurrent,
    subscribeMtpThumbnailContext: f.subscribeMtpThumbnailContext,
    getMtpThumbnailService: () => f.service,
  };
  const Thumbnail = load(
    'app/containers/HomePage/components/FileExplorerThumbnail.jsx',
    {
      '../../../data/file-explorer/thumbnails/LocalThumbnailProvider':
        localProvider,
      '../../../data/file-explorer/thumbnails/ThumbnailService': {
        ThumbnailService: ServiceSpy,
      },
      '../../../data/file-explorer/thumbnails/MtpThumbnailProvider': mtp,
    }
  ).default;
  const Grid = load(
    'app/containers/HomePage/components/FileExplorerTableBodyGridRender.jsx',
    {
      ...shared,
      '../styles/FileExplorerTableBodyGridRender': load(
        'app/containers/HomePage/styles/FileExplorerTableBodyGridRender.js',
        commonStyles
      ),
      './FileExplorerThumbnail': Thumbnail,
      '../../../data/file-explorer/thumbnails/LocalThumbnailProvider':
        localProvider,
      '../../../data/file-explorer/thumbnails/MtpThumbnailProvider': mtp,
    }
  ).default;
  const GridWrapper = load(wrapperSource, {
    ...shared,
    './FileExplorerTableBodyGridRender': Grid,
    '../styles/FileExplorerTableBodyGridWrapperRender': load(
      'app/containers/HomePage/styles/FileExplorerTableBodyGridWrapperRender.js'
    ),
  }).default;
  const date = load('app/utils/date.js', {
    dayjs,
    'dayjs/plugin/advancedFormat': advancedFormat,
  });
  const List = load(
    'app/containers/HomePage/components/FileExplorerTableBodyListRender.jsx',
    {
      ...shared,
      '../styles/FileExplorerTableBodyListRender': load(
        'app/containers/HomePage/styles/FileExplorerTableBodyListRender.js'
      ),
      '../../../utils/date': date,
    }
  ).default;
  const ListWrapper = load(
    'app/containers/HomePage/components/FileExplorerTableBodyListWrapperRender.jsx',
    { ...shared, './FileExplorerTableBodyListRender': List }
  ).default;
  const Toolbar = load('app/containers/HomePage/components/ToolbarBody.jsx', {
    ...shared,
    './SidebarAreaPaneLists': () => null,
    '../styles/ToolbarAreaPane': { LazyLoaderOverlay: () => () => null },
    '../../../components/DialogBox': {
      Confirm: () => null,
      Selection: () => null,
    },
    '../../../helpers/binaries': { isKalamModeSupported: () => false },
  }).default;
  const bodyStyles = load(
    'app/containers/HomePage/styles/FileExplorerBodyRender.js',
    commonStyles
  ).styles(theme);
  const select = methods(
    'app/containers/HomePage/components/FileExplorer.jsx',
    [
      '_handleTableClick',
      '_handleAccelerator',
      'lastSelectedNode',
      'lastSelectedNodeOfTableSort',
      '_handleAcceleratorActivation',
    ],
    {
      undefinedOrNull: utils.undefinedOrNull,
      isArray: Array.isArray,
      DEVICE_TYPE: enumValues.DEVICE_TYPE,
      FILE_EXPLORER_VIEW_TYPE: enumValues.FILE_EXPLORER_VIEW_TYPE,
    }
  );

  select.keyedAcceleratorList = { shift: false };
  const keyDown = select._handleAccelerator.bind(select, true);
  const keyUp = select._handleAccelerator.bind(select, false);

  document.addEventListener('keydown', keyDown);
  document.addEventListener('keyup', keyUp);
  const sorter = methods(
    'app/containers/HomePage/components/FileExplorer.jsx',
    ['tableSort', '_lodashSortConstraints'],
    {
      lodashSortBy: sortBy,
      isNumber: utils.isNumber,
      isInt: utils.isInt,
      isFloat: utils.isFloat,
      pathInfo: (value) => ({ name: path.parse(String(value)).name }),
    }
  );

  sorter.props = { showDirectoriesFirst: false };
  const focusModels = {};

  ['mtp', 'local'].forEach((type) => {
    focusModels[type] = methods(
      'app/containers/HomePage/components/ToolbarAreaPane.jsx',
      ['_handleViewModeChange', '_handleViewModeFocus'],
      { document, FILE_EXPLORER_BODY_WRAPPER_ID: 'file-explorer-body-wrapper' }
    );
  });
  let app;
  const events = [];

  select.tableSort = sorter.tableSort;
  select._lodashSortConstraints = sorter._lodashSortConstraints;

  class TestApp extends React.Component {
    constructor(props) {
      super(props);
      this.state = {
        views: { local: 'list', mtp: 'grid' },
        selected: [],
        revision: 1,
        order: 'asc',
        width: 440,
        paths: { local: '/Computer', mtp: '/Images' },
      };
      app = this;
    }

    render() {
      const { views, selected, revision, order, width, paths } = this.state;
      const lists = {
        mtp: {
          queue: { selected },
          nodes: f.state.Home.directoryLists.mtp.nodes,
          order,
          orderBy: 'name',
        },
        local: { queue: { selected: [] } },
      };

      select.props = {
        directoryLists: lists,
        focussedFileExplorerDeviceType: { value: 'mtp' },
        currentBrowsePath: paths,
        fileExplorerListingType: views,
        mtpDevice: { isAvailable: true },
        showDirectoriesFirst: false,
        actionCreateTableClick: ({ selected }) => this.setState({ selected }),
      };
      const children = ['local', 'mtp'].map((type) => {
        const items =
          type === 'mtp' ? f.state.Home.directoryLists.mtp.nodes : localNodes;
        const sorted = sorter.tableSort({
          nodes: items,
          order,
          orderBy: 'name',
        });
        const model = focusModels[type];

        model.props = {
          deviceType: type,
          fileExplorerListingType: views,
          focussedFileExplorerDeviceType: { value: type },
          actionCreateFocusView: () => {},
          actionCreateFileExplorerListingType: ({ value }, device) =>
            this.setState(({ views: previousViews }) => ({
              views: { ...previousViews, [device]: value },
            })),
        };
        const props = {
          tableSort: sorted,
          directoryGeneratedTime: revision,
          directoryLists: lists,
          deviceType: type,
          mtpDevice: { isAvailable: true },
          isSelected: (file) => selected.includes(file),
          onTableClick: (...args) => select._handleTableClick(...args),
          currentBrowsePath: paths,
          tableData: { path: paths[type] },
          _eventTarget: 'table',
          onContextMenuClick: (event, item, data, target) =>
            events.push({ kind: 'context', item, data, target }),
          onTableDoubleClick: (item, device) =>
            events.push({ kind: 'open', item, device }),
          hideColList: [],
        };

        return React.createElement(
          'section',
          { key: type, style: { width } },
          React.createElement(Toolbar, {
            deviceType: type,
            styles: {},
            toolbarList: { local: {}, mtp: {} },
            directoryLists: lists,
            currentBrowsePath: { local: '/Computer', mtp: '/Images' },
            mtpStoragesList: {},
            mtpDevice: { isAvailable: true },
            mtpMode: 'legacy',
            sidebarFavouriteList: [],
            showMenu: false,
            toggleDrawer: false,
            showLocalPaneOnLeftSide: true,
            isLoadedDirectoryLists: true,
            fileExplorerListingType: views,
            onViewModeChange: model._handleViewModeChange,
            onViewModeFocus: model._handleViewModeFocus,
            onToggleDrawer: () => () => {},
            onDoubleClickToolBar: () => {},
          }),
          React.createElement(
            'div',
            {
              id: `file-explorer-body-wrapper-${type}`,
              tabIndex: 0,
              style: bodyStyles.tableWrapper,
              onDragStart: (event) =>
                events.push({
                  kind: 'drag',
                  device: type,
                  target: event.target.tagName,
                }),
              onDragOver: (event) => {
                event.preventDefault();
                events.push({ kind: 'over', device: type });
              },
              onDrop: (event) => {
                event.preventDefault();
                events.push({ kind: 'drop', device: type });
              },
            },
            React.createElement(
              Table,
              null,
              React.createElement(
                TableBody,
                null,
                React.createElement(
                  views[type] === 'grid' ? GridWrapper : ListWrapper,
                  props
                )
              )
            )
          )
        );
      });

      return React.createElement(
        'div',
        { style: { display: 'flex', width: width * 2 } },
        ...children
      );
    }
  }
  const check = (name, value) => {
    assert(value, `${count}: ${name}`);
    metrics.stages.push(name);
  };
  const track = (type, service) => {
    const { generate } = service.provider;

    const activePaths = new Set();

    Object.assign(service.provider, {
      async generate(...args) {
        metrics.providerRequests[type] += 1;
        metrics.providerPaths.push({ type, path: args[0].path });

        assert(
          !activePaths.has(args[0].path),
          'No simultaneous duplicate generation'
        );
        activePaths.add(args[0].path);
        try {
          return await generate.apply(this, args);
        } finally {
          activePaths.delete(args[0].path);
        }
      },
    });

    const { inspect } = service.provider;

    Object.assign(service.provider, {
      async inspect(...args) {
        const value = await inspect.apply(this, args);
        const key = JSON.stringify([
          value.path,
          value.mtimeMs,
          value.size,
          value.ctimeMs,
          value.ino,
          service.dimensions.width,
          service.dimensions.height,
          value.identity,
        ]);

        if (service.cache.has(key)) metrics.cacheHits[type] += 1;

        return value;
      },
    });
  };

  track('mtp', f.service);
  track('local', localService);
  const nativeObserver = window.IntersectionObserver;
  const mockedCalls = [];
  let stopPump = false;

  async function pump() {
    if (stopPump) return;
    f.legacy.calls.forEach((call) => {
      if (call.scheduled) return;
      Object.assign(call, { scheduled: true });
      const command = call.argv[1];

      mockedCalls.push(command);
      setTimeout(() => {
        call.child.emit('exit', 0, null);
        call.child.emit('close', 0, null);
      }, 8);
    });
    await pause(1);

    return pump();
  }

  const pumping = pump();
  let recording = true;
  let last;
  const frames = (now) => {
    if (!recording) return;
    if (last !== undefined) metrics.frames.push(now - last);
    last = now;
    Object.entries(services()).forEach(([type, service]) => {
      metrics.maxActive[type] = Math.max(
        metrics.maxActive[type],
        service.active
      );
      metrics.peakPending[type] = Math.max(
        metrics.peakPending[type],
        service.pending.size
      );
    });
    requestAnimationFrame(frames);
  };

  requestAnimationFrame(frames);
  const started = performance.now();
  const firstTileObserver = new MutationObserver(() => {
    if (
      panel('mtp')?.querySelector('[draggable="true"]') &&
      metrics.initialFirstBatchMs === undefined
    )
      metrics.initialFirstBatchMs = performance.now() - started;
  });

  firstTileObserver.observe(document.getElementById('root'), {
    childList: true,
    subtree: true,
  });

  ReactDOM.render(
    React.createElement(ThemeProvider, { theme }, React.createElement(TestApp)),
    document.getElementById('root')
  );
  const mounted = (type) =>
    panel(type)?.querySelectorAll('[draggable="true"]').length;
  const gridReady = (type) =>
    virtual
      ? mounted(type) > 1 && mounted(type) < count
      : mounted(type) === count;

  await wait(() => gridReady('mtp'), 'initial Grid window');
  metrics.initialFullGridMs = performance.now() - started;
  firstTileObserver.disconnect();
  if (virtual) {
    await pause(40);
    const cols = Math.floor((panel('mtp').clientWidth - 10) / 100);
    const height = Math.ceil(count / cols) * 137;

    check(
      'Virtual height preserves every logical row',
      Math.abs(panel('mtp').scrollHeight - height - 32) <= 2
    );
    check(
      'Mounted window is bounded independently of directory length',
      mounted('mtp') <= cols * (Math.ceil(panel('mtp').clientHeight / 137) + 5)
    );
  }

  metrics.mountedTiles =
    panel('mtp').querySelectorAll('[draggable="true"]').length;
  metrics.initialDomNodes = panel('mtp').querySelectorAll('*').length;
  metrics.mountedThumbnailComponents = [
    ...panel('mtp').querySelectorAll('img'),
  ].filter((img) => /\.(png|jpg)$/i.test(img.alt)).length;
  const idle = () =>
    !f.service.active && !f.service.pending.size && !f.legacy.queue.active;

  await wait(idle, 'initial viewport thumbnails');
  await pause(40);
  const initialCalls = f.legacy.calls.length;
  const inNearby = (img) => {
    const root = panel('mtp').getBoundingClientRect();
    const b = img.getBoundingClientRect();

    return b.bottom > root.top - 120 && b.top < root.bottom + 120;
  };
  const initialVisible = [...panel('mtp').querySelectorAll('img')].filter(
    (img) => inNearby(img) && /\.(png|jpg)$/i.test(img.alt)
  ).length;

  check(
    'Real native observer suppresses offscreen initial requests',
    initialCalls > 0 &&
      initialCalls === initialVisible &&
      initialCalls < nodes.filter(supported).length
  );
  const visiblePreviews = [...panel('mtp').querySelectorAll('img')].filter(
    (img) => inNearby(img) && /\.(png|jpg)$/i.test(img.alt)
  );

  check(
    'All initially nearby image tiles render decoded previews',
    visiblePreviews.every(
      (img) =>
        img.src.startsWith('blob:') && img.complete && img.naturalWidth > 0
    )
  );
  check(
    'Initial local List performs no provider work',
    metrics.providerRequests.local === 0
  );
  metrics.initialProviderRequests = initialCalls;
  metrics.initialGeometry = [
    ...panel('mtp').querySelectorAll('[draggable="true"]'),
  ]
    .slice(0, 24)
    .map((tile) => {
      const box = tile.getBoundingClientRect();
      const image = tile.querySelector('img');
      const icon = image.getBoundingClientRect();

      return {
        name: image.alt,
        text: tile.textContent,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        icon: {
          x: icon.x,
          y: icon.y,
          width: icon.width,
          height: icon.height,
          fit: getComputedStyle(image).objectFit,
        },
      };
    });
  if (process.env.OPENMTP_T4_CAPTURE === '1') {
    ipcRenderer.send('t4-capture', `${count}-initial`);
    await new Promise((resolve) => ipcRenderer.once('t4-captured', resolve));
  }

  const topUrls = new Map(
    [...panel('mtp').querySelectorAll('img')]
      .filter((img) => img.src.startsWith('blob:'))
      .map((img) => [img.alt, img.src])
  );
  const scroll = async (position) => {
    const begin = performance.now();

    panel('mtp').scrollTop = position;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    metrics.maxScrollRafMs = Math.max(
      metrics.maxScrollRafMs || 0,
      performance.now() - begin
    );
    await pause(35);
    if (virtual) {
      const root = panel('mtp').getBoundingClientRect();
      const boxes = [
        ...panel('mtp').querySelectorAll('[draggable="true"]'),
      ].map((tile) => tile.getBoundingClientRect());
      const top = Math.min(...boxes.map((box) => box.top));
      const bottom = Math.max(...boxes.map((box) => box.bottom));
      const contentTop = Math.min(...boxes.map((box) => box.top));

      assert(
        boxes.length && top <= root.top + 18 && bottom >= root.bottom - 18,
        `${count}: scroll viewport is covered by contiguous mounted rows`
      );
      assert(Number.isFinite(contentTop));
    }
  };
  const range = panel('mtp').scrollHeight - panel('mtp').clientHeight;

  check('Actual scroll container has overflow for large directory', range > 0);
  await scroll(range / 2);
  await wait(idle, 'downward thumbnails');
  const downCalls = f.legacy.calls.length;

  check(
    'Scrolling downward admits new nearby images',
    downCalls > initialCalls
  );
  await scroll(0);
  await wait(idle, 'return cache');
  check(
    'Scrolling upward reuses top cache without native work',
    f.legacy.calls.length === downCalls &&
      [...topUrls].every(
        ([name, src]) =>
          [...panel('mtp').querySelectorAll('img')].find(
            (img) => img.alt === name
          )?.src === src
      )
  );
  await serial([0.2, 0.8, 0.1, 1], (fraction) => scroll(range * fraction));
  await wait(idle, 'rapid scrolling settlement');
  if (virtual) {
    check(
      'Bottom scrolling includes the last logical item',
      !!target(nodes[count - 1])
    );
    const visible = [...panel('mtp').querySelectorAll('img')].filter((img) => {
      const b = img.closest('[draggable="true"]').getBoundingClientRect();
      const root = panel('mtp').getBoundingClientRect();

      return b.bottom > root.top && b.top < root.bottom;
    });

    check('Bottom viewport has tiles without gaps', visible.length > 0);
  }

  check(
    'Real observer remains unchanged',
    window.IntersectionObserver === nativeObserver
  );
  check(
    'One Android active job and bounded waiting set',
    metrics.maxActive.mtp <= 1 && metrics.peakPending.mtp <= 8
  );
  await scroll(0);
  await wait(idle, 'top after rapid scroll');
  const top = nodes.find(supported);

  target(top).click();
  await pause(40);
  check('Normal selection still works', app.state.selected.includes(top.path));
  const second = nodes.find((item) => supported(item) && item !== top);

  document.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Shift',
      code: 'ShiftLeft',
      shiftKey: true,
      bubbles: true,
    })
  );
  target(second).dispatchEvent(
    new MouseEvent('click', { bubbles: true, shiftKey: true })
  );
  document.dispatchEvent(
    new KeyboardEvent('keyup', {
      key: 'Shift',
      code: 'ShiftLeft',
      bubbles: true,
    })
  );
  await pause(40);
  check(
    'Shift-click adds second image',
    app.state.selected.includes(top.path) &&
      app.state.selected.includes(second.path)
  );
  const initialName = target(second).closest('[draggable="true"]').textContent;

  check(
    'Existing Grid filename truncation remains exact',
    initialName.includes(
      utils.springTruncate(
        second.name,
        constants.FILE_EXPLORER_GRID_TRUNCATE_MAX_CHARS
      ).truncatedText
    )
  );
  const imageBox = target(top).getBoundingClientRect();
  const tileBox = target(top)
    .closest('[draggable="true"]')
    .getBoundingClientRect();

  check(
    'Existing tile and image dimensions are unchanged',
    imageBox.width === 80 &&
      imageBox.height === 80 &&
      tileBox.width === 100 &&
      tileBox.height === 137
  );
  const view = async (type, value) => {
    document.getElementById(`file-explorer-view-button-${type}`).click();
    await pause(25);
    const menu = document.getElementById(`file-explorer-view-menu-${type}`);

    [...menu.querySelectorAll('[role="menuitemradio"]')]
      .find(
        (item) =>
          item.textContent.trim() ===
          (value === 'grid' ? 'Grid View' : 'List View')
      )
      .click();
    await wait(
      () =>
        app.state.views[type] === value &&
        document.activeElement.id === `file-explorer-body-wrapper-${type}`,
      'view/focus'
    );
    await wait(
      () => (value === 'grid' ? gridReady(type) : mounted(type) === count),
      'view fully mounted'
    );
  };
  const listCycles = [];

  await serial([0, 1, 2], async () => {
    const before = metrics.providerRequests.mtp;
    const cycleStart = performance.now();

    await view('mtp', 'list');
    await wait(idle, 'List settlement');
    check(
      'No new thumbnail provider requests from List',
      metrics.providerRequests.mtp === before
    );
    const firstRow = panel('mtp').querySelector('tr[role="checkbox"]');
    const cells = [...panel('mtp').querySelectorAll('tr[role="checkbox"]')];

    check(
      'File-size and folder formatting unchanged',
      cells.every(
        (row, index) =>
          row.querySelector('.sizeCell').textContent.trim() ===
          (nodes[index].isFolder ? '--' : utils.niceBytes(nodes[index].size))
      )
    );
    check(
      'Existing List filename truncation remains exact',
      cells.every((row, index) => {
        const text = utils.springTruncate(
          nodes[index].name,
          constants.FILE_EXPLORER_TABLE_TRUNCATE_MAX_CHARS
        );

        return row
          .querySelector('.nameCell')
          .textContent.trim()
          .includes(text.isTruncated ? text.truncatedText : text.text);
      })
    );
    check(
      'Existing List icon dimensions unchanged',
      firstRow.querySelector('img').getBoundingClientRect().height === 20
    );
    await view('mtp', 'grid');
    await wait(idle, 'Grid cache');
    check(
      'Repeated List/Grid returns preserve cached previews',
      metrics.providerRequests.mtp === before
    );
    listCycles.push(performance.now() - cycleStart);
  });
  metrics.viewCycleMs = listCycles;
  await view('local', 'grid');
  await wait(
    () => !localService.active && !localService.pending.size,
    'local thumbnails'
  );
  check(
    'Computer Grid works without changing Phone view',
    app.state.views.mtp === 'grid' && metrics.providerRequests.local > 0
  );
  const phoneCount = metrics.providerRequests.mtp;

  panel('local').scrollTop = panel('local').scrollHeight;
  await pause(50);
  await wait(
    () => !localService.active && !localService.pending.size,
    'local scroll'
  );
  check(
    'Local scrolling cannot trigger Android work',
    metrics.providerRequests.mtp === phoneCount
  );
  check('Independent local job limit preserved', metrics.maxActive.local <= 2);
  const beforeSort = metrics.providerRequests.mtp;

  app.setState({ order: 'desc', revision: 2 });
  await wait(() => gridReady('mtp'), 'sorted Grid');
  await pause(80);
  await wait(idle, 'sorting thumbnails');
  const expectedOrder = sorter
    .tableSort({ nodes, order: 'desc', orderBy: 'name' })
    .map((item) => item.name);

  check(
    'Existing descending sorting order preserved',
    [...panel('mtp').querySelectorAll('img')]
      .map((img) => img.alt)
      .join('|') ===
      (virtual ? expectedOrder.slice(0, mounted('mtp')) : expectedOrder).join(
        '|'
      )
  );
  metrics.sortProviderDelta = metrics.providerRequests.mtp - beforeSort;
  check(
    'Cache remains within existing entry and byte limits',
    f.service.cache.size <= 64 &&
      f.service.bytes <= 16 * 1024 * 1024 &&
      localService.cache.size <= 64 &&
      localService.bytes <= 16 * 1024 * 1024
  );
  check(
    'Every mocked Android command is thumbnail-only',
    mockedCalls.every((command) => command.startsWith('get-thumb '))
  );
  if (extended)
    await extraChecks({
      count,
      nodes,
      f,
      panel,
      app,
      check,
      metrics,
      events,
      target,
      select,
      scroll,
      idle,
      view,
    });
  metrics.physicalMtpOperations = 0;
  metrics.mockedCliCalls = f.legacy.calls.length;
  metrics.domNodes = panel('mtp').querySelectorAll('*').length;
  metrics.frameP95Ms = [...metrics.frames].sort((a, b) => a - b)[
    Math.floor(metrics.frames.length * 0.95)
  ];
  metrics.maxFrameMs = Math.max(...metrics.frames);
  delete metrics.frames;
  document.removeEventListener('keydown', keyDown);
  document.removeEventListener('keyup', keyUp);
  ReactDOM.unmountComponentAtNode(document.getElementById('root'));
  await wait(
    () => !f.service.active && !f.legacy.queue.active && !localService.active,
    'unmount native settlement'
  );
  check(
    'Unmount leaves no pending, running or capacity subscriptions',
    !f.service.pending.size &&
      !f.service.running.size &&
      !f.service.capacityListeners.size &&
      !localService.pending.size &&
      !localService.running.size
  );
  stopPump = true;
  recording = false;
  await pumping;

  return metrics;
}

async function extraChecks({
  count,
  nodes,
  f,
  panel,
  app,
  check,
  metrics,
  events,
  target,
  select,
  scroll,
  idle,
}) {
  // Mutate only this isolated React fixture and mocked metadata. Never a device.
  app.setState({ order: 'asc', revision: 3 });
  await pause(80);
  await scroll(0);
  await wait(idle, 'T4 initial state');
  const mountedNames = () =>
    [...panel('mtp').querySelectorAll('img')].map((img) => img.alt);
  const tile = (item) => target(item)?.closest('[draggable="true"]');
  const root = panel('mtp');
  const before = metrics.providerRequests.mtp;

  // A modifier selection across distant, unmounted items still belongs to the parent.
  target(nodes[1]).click();
  await pause(20);
  await scroll(root.scrollHeight);
  document.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Meta',
      code: 'MetaLeft',
      bubbles: true,
    })
  );
  target(nodes[count - 1]).click();
  document.dispatchEvent(
    new KeyboardEvent('keyup', { key: 'Meta', code: 'MetaLeft', bubbles: true })
  );
  await pause(30);
  check(
    'Command-click preserves distant logical selection across unmounted tiles',
    app.state.selected.includes(nodes[1].path) &&
      app.state.selected.includes(nodes[count - 1].path)
  );
  document.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Shift',
      code: 'ShiftLeft',
      bubbles: true,
    })
  );
  target(nodes[count - 2]).click();
  document.dispatchEvent(
    new KeyboardEvent('keyup', {
      key: 'Shift',
      code: 'ShiftLeft',
      bubbles: true,
    })
  );
  await pause(30);
  check(
    'Existing Shift append semantics preserve unmounted selections',
    app.state.selected.length === 3
  );
  root.focus();
  app.setState({ selected: [nodes[1].path] });
  await pause(40);
  check(
    'Offscreen logical selection is revealed without stealing panel focus',
    !!target(nodes[1]) && document.activeElement === root
  );
  const cols = Math.floor((root.clientWidth - 10) / 100);
  const edge = (Math.ceil(root.clientHeight / 137) + 1) * cols - 1;

  app.setState({ selected: [nodes[edge].path] });
  await pause(40);
  select._handleAcceleratorActivation({
    type: 'navigationRight',
    data: { deviceType: 'mtp', event: {}, tableData: {} },
  });
  await pause(40);
  check(
    'Actual keyboard right uses full logical order and reveals the next tile',
    app.state.selected[0] === nodes[edge + 1].path && !!target(nodes[edge + 1])
  );
  select._handleAcceleratorActivation({
    type: 'navigationLeft',
    data: { deviceType: 'mtp', event: {}, tableData: {} },
  });
  await pause(30);
  check(
    'Actual keyboard left preserves ordering',
    app.state.selected[0] === nodes[edge].path
  );
  const selected = app.state.selected.slice();

  select._handleAcceleratorActivation({
    type: 'navigationDown',
    data: { deviceType: 'mtp', event: {}, tableData: {} },
  });
  check(
    'Existing Grid up/down no-op is preserved',
    JSON.stringify(selected) === JSON.stringify(app.state.selected)
  );
  await scroll(0);
  const folder = nodes.find((item) => item.isFolder);

  tile(folder).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  tile(folder).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
  check(
    'Folder double-click and context arguments retain original data',
    events.some(
      (event) =>
        event.kind === 'open' && event.item === folder && event.device === 'mtp'
    ) &&
      events.some(
        (event) =>
          event.kind === 'context' &&
          event.item.path === folder.path &&
          event.data.path === '/Images' &&
          event.target === 'table'
      )
  );
  tile(folder).dispatchEvent(new Event('dragstart', { bubbles: true }));
  tile(folder).dispatchEvent(
    new Event('dragover', { bubbles: true, cancelable: true })
  );
  tile(folder).dispatchEvent(
    new Event('drop', { bubbles: true, cancelable: true })
  );
  root.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
  check(
    'Tile drag selection and folder/background drop bubbling remain intact',
    app.state.selected.includes(folder.path) &&
      events.some((event) => event.kind === 'drag') &&
      events.filter((event) => event.kind === 'drop').length === 2
  );
  // No actual FileExplorer mutation/drop callback is invoked by the fixture.
  await wait(idle, 'interaction thumbnails');
  const phoneTop = root.scrollTop;

  app.setState({ width: 350 });
  await pause(100);
  check(
    'Resize recalculates three-column geometry at a narrower viewport',
    Math.abs(
      tile(nodes[3]).getBoundingClientRect().top -
        tile(nodes[0]).getBoundingClientRect().top -
        137
    ) < 1 && root.scrollTop === phoneTop
  );
  app.setState({ width: 440 });
  await pause(80);
  await scroll(root.scrollHeight / 2);
  const sortTop = root.scrollTop;

  app.setState({ order: 'desc', revision: 4 });
  await pause(80);
  const descending = [...nodes].reverse().map((item) => item.name);
  const names = mountedNames();
  const first = descending.indexOf(names[0]);

  check(
    'Sorting while scrolled preserves offset and a contiguous logical slice',
    root.scrollTop === sortTop &&
      first >= 0 &&
      names.join('|') ===
        descending.slice(first, first + names.length).join('|')
  );
  await scroll(root.scrollHeight);
  // New directory/identity: old consumers must disappear, old preview cannot leak.
  Object.assign(f.state.Home.directoryLists.mtp, { nodes: [] });
  app.setState({
    paths: { local: '/Computer', mtp: '/Empty' },
    revision: 5,
    selected: [],
  });
  await pause(80);
  check(
    'Empty directory resets scroll and renders no tiles',
    root.scrollTop === 0 &&
      mountedNames().length === 0 &&
      root.scrollHeight === root.clientHeight
  );
  await serial([1, 5], async (size) => {
    const tiny = directory(size, '/Tiny');

    Object.assign(f.state.Home.directoryLists.mtp, { nodes: tiny });
    app.setState({
      paths: { local: '/Computer', mtp: '/Tiny' },
      order: 'asc',
      revision: 6 + size,
    });
    await pause(80);
    check(
      `${size}-item directory preserves order and partial final row`,
      mountedNames().join('|') === tiny.map((item) => item.name).join('|')
    );
  });
  await wait(idle, 'T4 final settlement');
  check(
    'Native observer and existing job bounds survive interaction checks',
    metrics.maxActive.mtp <= 1 && metrics.peakPending.mtp <= 8
  );
  Object.assign(metrics, {
    extraProviderRequests: metrics.providerRequests.mtp - before,
  });
}

(async () => {
  const cases = [];

  try {
    await serial(
      process.env.OPENMTP_T4_COUNTS
        ? JSON.parse(process.env.OPENMTP_T4_COUNTS)
        : [100, 500, 1000],
      async (count) => {
        const result = await scenario(count);

        cases.push(result);
        ipcRenderer.send('t3-case', result);
      }
    );
    ipcRenderer.send('t3-result', {
      passed: true,
      cases,
      physicalMtpOperations: 0,
      wrapperSource,
      virtual,
      extended,
    });
  } catch (error) {
    ipcRenderer.send('t3-result', { passed: false, error: error.stack, cases });
  }
})();
