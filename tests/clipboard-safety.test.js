/* Offline clipboard regression tests. Run with NODE_ENV=test and Node 16. */
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
  uiFixture,
  transferHelpers,
} = require('./transfer-reliability.test');

const root = path.resolve(__dirname, '..');
const tests = [];
const test = (name, run) => tests.push({ name, run });
const source = fs.readFileSync(
  path.join(root, 'app/containers/HomePage/components/FileExplorer.jsx'),
  'utf8'
);
const ast = babel.parseSync(source, {
  configFile: false,
  babelrc: false,
  parserOpts: { plugins: ['jsx', 'classProperties'] },
});
const map = ast.program.body
  .find(
    (node) =>
      node.type === 'VariableDeclaration' &&
      node.declarations.some((entry) => entry.id.name === 'mapDispatchToProps')
  )
  .declarations.find((entry) => entry.id.name === 'mapDispatchToProps').init;
const component = ast.program.body.find(
  (node) => node.type === 'ClassDeclaration' && node.id.name === 'FileExplorer'
);
const prefixer = load('app/helpers/reducerPrefixer.js', {}).default;

function fixture() {
  let scope = {
    generation: 1,
    backend: 'legacy',
    storageId: 1,
    storageRevision: 1,
  };
  let ready = true;
  const current = (value) =>
    ready &&
    !!value &&
    Object.keys(scope).every((key) => value[key] === scope[key]);
  const actions = load('app/containers/HomePage/actions.js', {
    '../../data/file-explorer/repositories/FileExplorerRepository': {
      captureMtpScope: () => ({ ...scope }),
      isCurrentMtpScope: current,
      isMatchingMtpScope: current,
    },
    '../../helpers/reducerPrefixer': { default: prefixer, __esModule: true },
    '../Alerts/actions': {
      throwAlert: (payload) => ({ type: 'alert', payload }),
    },
    '../../helpers/processBufferOutput': {
      processMtpBuffer: () => ({}),
      processLocalBuffer: () => ({}),
    },
    '../../utils/funcs': utils,
    '../../enums': enums,
    '../../utils/log': { log },
    '../../data/file-explorer/controllers/FileExplorerController': {
      listFiles: async ({ filePath }) => ({
        data: [{ path: `${filePath}/a.jpg`, name: 'a.jpg' }],
        error: null,
        stderr: null,
      }),
    },
    '../../utils/checkIf': { checkIf },
    '../../enums/mtpError': { MTP_ERROR: {} },
    '../../constants': { DEVICES_DEFAULT_PATH: { local: '/local', mtp: '/' } },
    '../../services/analytics': { analyticsService: { sendDeviceInfo() {} } },
  });
  const { default: reducer } = load('app/containers/HomePage/reducers.js', {
    '@fortawesome/free-regular-svg-icons': {},
    '@fortawesome/free-solid-svg-icons': {},
    '@fortawesome/free-brands-svg-icons': {},
    './actions': actions,
    '../../constants/paths': { PATHS: {} },
    '../../constants': {
      DEVICES_DEFAULT_PATH: { local: '/local', mtp: '/' },
      FILE_EXPLORER_DEFAULT_FOCUSSED_DEVICE_TYPE: 'local',
    },
    '../../enums': enums,
    '../../templates/fileExplorer': {},
    '../../helpers/binaries': { isKalamModeSupported: () => true },
  });
  const state = {
    Home: reducer(undefined, {}),
    Settings: { mtpMode: 'legacy' },
  };

  state.Home.mtpStoragesList = { 1: { selected: true } };
  const dispatched = [];
  const dispatch = (action) => {
    if (typeof action === 'function') return action(dispatch, () => state);
    dispatched.push(action);
    state.Home = reducer(state.Home, action);

    return action;
  };
  const globals = {
    bindActionCreators: (creators) => creators,
    DEVICE_TYPE: enums.DEVICE_TYPE,
    captureMtpScope: () => ({ ...scope }),
    isCurrentMtpScope: current,
    isArray: Array.isArray,
    removeArrayDuplicates: (values) => [...new Set(values)],
    setFileTransferClipboard: actions.setFileTransferClipboard,
    actionSetSelectedDirLists: actions.actionSetSelectedDirLists,
    log,
  };
  const creators = vm.runInNewContext(
    `(${source.slice(map.start, map.end)})`,
    globals
  )(dispatch);
  const copy = (deviceType, selected = ['/source/a.jpg'], toQueue = false) =>
    dispatch(creators.actionCreateCopy({ deviceType, selected, toQueue }));
  const navigate = (deviceType, filePath = '/other') =>
    dispatch(
      actions.listDirectory(
        { filePath, ignoreHidden: false },
        deviceType,
        () => state
      )
    );
  const clipboard = () => state.Home.fileTransfer.clipboard;
  const menu = (deviceType) => {
    const member = component.body.body.find(
      (node) => node.key.name === 'activeContextMenuList'
    );
    const instance = vm.runInNewContext(
      `(new (class { ${source.slice(member.start, member.end)} }))`
    );

    instance.props = {
      contextMenuList: { [deviceType]: { paste: { label: 'Paste' } } },
      fileTransferClipboard: clipboard(),
      directoryLists: state.Home.directoryLists,
    };

    return instance.activeContextMenuList(deviceType, {}, {})[0];
  };

  return {
    state,
    actions,
    dispatch,
    dispatched,
    copy,
    navigate,
    clipboard,
    menu,
    changeScope: (value) => {
      scope = { ...scope, ...value };
    },
    disconnect: () => {
      ready = false;
      dispatch(actions.disconnectRendererMtp());
    },
  };
}

test('Android Copy retains listing scope, storage and multiple selected paths', async () => {
  const f = fixture();

  await f.navigate('mtp', '/images');
  const listingScope = f.state.Home.directoryLists.mtp.mtpScope;

  assert(listingScope, 'LIST_DIRECTORY discarded its MTP source scope');
  await f.copy('mtp', ['/images/a.jpg', '/images/b.png']);
  assert.strictEqual(f.clipboard().source, 'mtp');
  assert.strictEqual(f.clipboard().mtpScope.storageId, 1);
  assert.deepStrictEqual(Array.from(f.clipboard().queue), [
    '/images/a.jpg',
    '/images/b.png',
  ]);
  assert.strictEqual(
    f.clipboard().mtpScope.generation,
    listingScope.generation
  );
});

test('Android Copy uses the newly navigated listing and keeps previous clipboard stable', async () => {
  const f = fixture();

  await f.navigate('mtp', '/before');
  await f.copy('mtp', ['/before/a.jpg']);
  const before = f.clipboard();

  await f.navigate('mtp', '/after');
  assert.strictEqual(f.clipboard(), before);
  assert.strictEqual(f.clipboard().queue[0], '/before/a.jpg');
  await f.copy('mtp', ['/after/a.jpg']);
  assert.strictEqual(f.clipboard().queue[0], '/after/a.jpg');
});

for (const deviceType of ['local', 'mtp']) {
  test(`${deviceType} Copy survives navigation and panel focus change`, async () => {
    const f = fixture();

    await f.navigate(deviceType);
    await f.copy(deviceType);
    const before = f.clipboard();

    await f.navigate(deviceType, '/next');
    f.dispatch(f.actions.setFocussedFileExplorerDeviceType({ value: 'local' }));
    f.dispatch(f.actions.setFocussedFileExplorerDeviceType({ value: 'mtp' }));
    assert.strictEqual(f.clipboard(), before);
    assert.strictEqual(f.menu(deviceType).enabled, false);
    assert.strictEqual(
      f.menu(deviceType === 'mtp' ? 'local' : 'mtp').enabled,
      true
    );
  });

  test(`${deviceType} Copy-to-Queue seeds empty clipboard and deduplicates compatible paths`, async () => {
    const f = fixture();

    await f.navigate(deviceType);
    await f.copy(deviceType, ['/one/a'], true);
    await f.copy(deviceType, ['/one/a', '/two/b'], true);
    assert.deepStrictEqual(Array.from(f.clipboard().queue), [
      '/one/a',
      '/two/b',
    ]);
  });

  test(`${deviceType} Copy-to-Queue refuses another endpoint's clipboard`, async () => {
    const f = fixture();
    const other = deviceType === 'mtp' ? 'local' : 'mtp';

    await f.navigate('mtp');
    await f.copy(other, ['/original/a']);
    const before = f.clipboard();

    await f.copy(deviceType, ['/different/b'], true);
    assert.strictEqual(f.clipboard(), before);
    assert.strictEqual(f.clipboard().source, other);
  });
}

for (const [name, value] of [
  ['storage', { storageId: 2, storageRevision: 2 }],
  ['session or device', { generation: 2 }],
  ['backend', { backend: 'kalam' }],
]) {
  test(`Android Copy rejects old listing after ${name} identity changes`, async () => {
    const f = fixture();

    await f.navigate('mtp');
    await f.copy('mtp', ['/original/a']);
    const before = f.clipboard();

    f.changeScope(value);
    await f.copy('mtp', ['/stale/a']);
    assert.strictEqual(f.clipboard(), before);
    assert.strictEqual(f.clipboard().mtpScope.storageId, 1);
  });
}

test('A refreshed listing can replace, but cannot append to, an obsolete Android clipboard', async () => {
  const f = fixture();

  await f.navigate('mtp');
  await f.copy('mtp', ['/original/a']);
  const before = f.clipboard();

  f.changeScope({ generation: 2 });
  await f.navigate('mtp');
  await f.copy('mtp', ['/fresh/a'], true);
  assert.strictEqual(f.clipboard(), before);
  await f.copy('mtp', ['/fresh/a']);
  assert.strictEqual(f.clipboard().mtpScope.generation, 2);
  assert.deepStrictEqual(Array.from(f.clipboard().queue), ['/fresh/a']);
});

test('Disconnect preserves clipboard but blocks Android Copy from cleared listing', async () => {
  const f = fixture();

  await f.navigate('mtp');
  await f.copy('mtp');
  const before = f.clipboard();

  f.disconnect();
  await f.copy('mtp', ['/stale/a']);
  assert.strictEqual(f.clipboard(), before);
  assert.strictEqual(f.state.Home.mtpDevice.isAvailable, false);
});

test('Production List/Grid settings action preserves Home clipboard', async () => {
  const f = fixture();

  await f.copy('local');
  const before = f.clipboard();
  const settings = fs.readFileSync(
    path.join(root, 'app/containers/Settings/actions.js'),
    'utf8'
  );
  const parsed = babel.parseSync(settings, {
    configFile: false,
    babelrc: false,
  });
  const { declaration } = parsed.program.body.find(
    (node) => node.declaration?.id?.name === 'fileExplorerListingType'
  );
  let persisted = 0;
  const changeView = vm.runInNewContext(
    `(${settings.slice(declaration.start, declaration.end)})`,
    {
      actionTypes: {
        FILE_EXPLORER_LISTING_TYPE: '@@Settings/FILE_EXPLORER_LISTING_TYPE',
      },
      copySettingsToJsonFile: () => () => {
        persisted += 1;
      },
      analyticsService: { sendEvent() {} },
      EVENT_TYPE: { TOOLBAR_SETTINGS_CHANGE: 'settings' },
    }
  );

  for (const value of [true, false, true])
    f.dispatch(changeView({ value }, 'local', () => f.state));
  assert.strictEqual(persisted, 3);
  assert.strictEqual(f.clipboard(), before);
});

for (const status of ['completed', 'failed', 'partial', 'unknown']) {
  test(`Existing ${status} Paste terminal clipboard behavior remains unchanged`, async () => {
    const result = transferHelpers.createTransferResult({
      status,
      backend: 'kalam',
      direction: 'upload',
      backendStopped: true,
      evidence: { nativeAcknowledged: true },
      files: { confirmedCompleted: ['/destination/a'] },
    });
    const f = uiFixture(async (args) => {
      if (status === 'completed') args.onCompleted(result);
      else args.onError(result);

      return result;
    });

    await f.run();
    if (status === 'completed')
      assert.strictEqual(f.state.Home.fileTransfer.clipboard.queue.length, 0);
    else {
      assert.strictEqual(
        f.state.Home.fileTransfer.clipboard,
        f.originalClipboard
      );
      assert(!f.events.some((event) => event.name === 'completed'));
    }

    assert(
      f.actions.every((action) =>
        ['clear', 'refresh', 'progress', 'alert'].includes(action.type)
      )
    );
  });
}

if (require.main === module)
  (async () => {
    let passed = 0;

    for (const { name, run } of tests) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await run();
        passed += 1;
        console.info(`PASS ${name}`);
      } catch (error) {
        process.exitCode = 1;
        console.error(`FAIL ${name}`, error);
      }
    }

    console.info(`${passed}/${tests.length} clipboard safety tests passed.`);
  })();
