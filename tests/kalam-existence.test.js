/* Offline Kalam destination-preflight regressions; no native or USB imports. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const babel = require('@babel/core');
const {
  load,
  enums,
  utils,
  log,
  transferHelpers,
  queueModule,
} = require('./transfer-reliability.test');

const root = path.resolve(__dirname, '..');
const tests = [];
const test = (name, run) => tests.push({ name, run });
const file = 'app/containers/HomePage/components/FileExplorer.jsx';
const text = fs.readFileSync(path.join(root, file), 'utf8');
const ast = babel.parseSync(text, {
  configFile: false,
  babelrc: false,
  parserOpts: { plugins: ['jsx', 'classProperties'] },
});
const component = ast.program.body.find(
  (node) => node.type === 'ClassDeclaration' && node.id.name === 'FileExplorer'
);
const names = [
  '_filesExist',
  '_handlePaste',
  '_handlePasteConfirm',
  '_handleRenameEditDialog',
  '_handleNewFolderEditDialog',
];
const methods = component.body.body
  .filter((node) => names.includes(node.key.name))
  .map((node) => text.slice(node.start, node.end))
  .join('\n');
const checkIf = (value, type, values) => {
  if (type === 'array') assert(Array.isArray(value));
  else if (type === 'inObjectValues')
    assert(Object.values(values).includes(value));
  else assert.strictEqual(typeof value, type);
};
const response = (paths, values) => ({
  error: null,
  stderr: null,
  data: paths.map((fullpath, index) => ({ fullpath, exists: values[index] })),
});
const one = ['/destination/a.jpg'];
const two = ['/destination/a.jpg', '/destination/b.png'];

// Strict loader: the real adapter, repository and controller run, while only
// the underlying FFI boundary, telemetry and local filesystem are mocked.
async function fixture({
  native = async () => response(one, [false]),
  deviceType = 'mtp',
  paths = one,
  localResult = false,
} = {}) {
  const calls = [];
  const events = [];
  const { FileExplorerKalamDataSource } = load(
    'app/data/file-explorer/data-sources/FileExplorerKalamDataSource.js',
    {
      child_process: {
        exec() {
          throw new Error('Forbidden process');
        },
      },
      '../../../utils/log': { log },
      '../../../../ffi/kalam/src/Kalam': {
        Kalam: class {
          async initialize() {
            return { error: null, stderr: null, data: { test: true } };
          }

          async fileExist(args) {
            calls.push(args);

            return native(args);
          }
        },
      },
      '../../../utils/checkIf': { checkIf },
      '../../../utils/funcs': utils,
      '../../../helpers/settings': {},
      '../../../utils/date': {},
      '../../../helpers/binaries': {},
      '../MtpOperationQueue': queueModule,
      '../transferResult': transferHelpers,
    }
  );
  const repository = load(
    'app/data/file-explorer/repositories/FileExplorerRepository.js',
    {
      '../data-sources/FileExplorerLocalDataSource': {
        FileExplorerLocalDataSource: function LocalDataSource() {
          this.filesExist = async (args) => {
            calls.push(args);

            return localResult;
          };
        },
      },
      '../../../enums': enums,
      '../../../helpers/settings': { getMtpModeSetting: () => 'kalam' },
      '../MtpOperationQueue': queueModule,
      '../data-sources/FileExplorerKalamDataSource': {
        FileExplorerKalamDataSource,
      },
    }
  );
  const controller = load(
    'app/data/file-explorer/controllers/FileExplorerController.js',
    {
      path,
      '../repositories/FileExplorerRepository': repository,
      '../../../utils/checkIf': { checkIf },
      '../../../services/analytics': { analyticsService: { sendEvent() {} } },
      '../../../enums/events': { EVENT_TYPE: {} },
      '../../../helpers/processBufferOutput': {
        processMtpBuffer: (value) => ({ error: value.error || value.stderr }),
        processLocalBuffer: (value) => ({ error: value.error || value.stderr }),
      },
      '../../../helpers/settings': { getMtpModeSetting: () => 'kalam' },
      '../../../enums': enums,
      '../../../utils/date': { unixTimestampNow: () => 1 },
      '../../../utils/log': { log },
      '../transferResult': transferHelpers,
    }
  ).default;

  await controller.initialize({ deviceType: 'mtp' });
  controller.selectStorage(1);
  const ui = vm.runInNewContext(`new (class { ${methods} })()`, {
    path,
    pathUp: path.dirname,
    sanitizePath: (value) => value.replace(/\/\/+/g, '/'),
    baseName: path.basename,
    DEVICE_TYPE: enums.DEVICE_TYPE,
    ...repository,
    fileExplorerController: controller,
    analyticsService: { sendEvent() {} },
    EVENT_TYPE: {},
  });
  const clipboard = {
    source: deviceType === 'mtp' ? 'local' : 'mtp',
    queue: paths.map((value) => `/source/${path.basename(value)}`),
    mtpScope: repository.captureMtpScope(),
  };

  ui.props = {
    deviceType,
    currentBrowsePath: { local: '/destination', mtp: '/destination' },
    storageId: 1,
    fileTransferClipboard: clipboard,
    hideHiddenFiles: { local: false, mtp: false },
    actionCreateThrowError: (value) => events.push({ type: 'alert', ...value }),
    actionCreatePaste: (...args) => events.push({ type: 'prepare', args }),
    actionCreateRenameFile: (...args) => events.push({ type: 'rename', args }),
    actionCreateNewFolder: (...args) =>
      events.push({ type: 'newFolder', args }),
  };
  ui._handleTogglePasteConfirmDialog = (open) =>
    events.push({ type: 'replace', open });
  ui._handleClearEditDialog = () => events.push({ type: 'clear-edit' });
  ui._handleErrorsEditDialog = (value) =>
    events.push({ type: 'edit-error', ...value });
  ui.dialogScope = repository.captureMtpScope();
  ui.state = {
    toggleDialog: {
      rename: { data: { path: '/source/a.jpg', name: 'a.jpg' } },
      newFolder: { data: { path: '/destination' } },
    },
  };

  return {
    ui,
    clipboard,
    events,
    calls,
    repository,
    Source: FileExplorerKalamDataSource,
  };
}

const successes = [
  ['single exists', one, [true]],
  ['single absent', one, [false]],
  ['all absent', two, [false, false]],
  ['one conflict', two, [false, true]],
];

for (const [name, paths, values] of successes) {
  test(`Adapter ${name} returns a validated boolean`, async () => {
    const f = await fixture({
      native: async () => response(paths, values),
      paths,
    });
    const adapter = new f.Source();

    assert.strictEqual(
      await adapter.filesExist({ fileList: paths, storageId: 1 }),
      values.some(Boolean)
    );
  });
  test(`Full Paste chain ${name} preserves existing conflict/no-conflict behavior`, async () => {
    const f = await fixture({
      native: async () => response(paths, values),
      paths,
    });

    await f.ui._handlePaste();
    const conflict = values.some(Boolean);

    assert.strictEqual(
      f.events.some((event) => event.type === 'replace' && event.open),
      conflict
    );
    assert.strictEqual(
      f.events.filter((event) => event.type === 'prepare').length,
      conflict ? 0 : 1
    );
    assert.strictEqual(f.ui.props.fileTransferClipboard, f.clipboard);
    assert.deepStrictEqual(Array.from(f.calls[0].files), paths);
    if (conflict) {
      f.ui._handlePasteConfirm(false);
      assert(!f.events.some((event) => event.type === 'prepare'));
      f.ui._handlePasteConfirm(true);
      assert(!f.events.some((event) => event.type === 'prepare'));
      await f.ui._handlePaste();
      f.ui._handlePasteConfirm(true);
    }

    const prepared = f.events.find((event) => event.type === 'prepare');

    assert(prepared);
    assert.strictEqual(prepared.args[0].fileTransferClipboard, f.clipboard);
    assert.strictEqual(prepared.args[0].storageId, 1);
    assert.strictEqual(prepared.args[2], 'mtp');
  });
}

const failures = [
  [
    'permission denied',
    async () => ({
      error: 'Permission denied',
      stderr: 'ErrorPermission',
      data: null,
    }),
  ],
  [
    'timeout envelope',
    async () => ({
      error: 'Session timeout',
      stderr: 'ErrorGeneral',
      data: null,
    }),
  ],
  [
    'disconnection',
    async () => ({
      error: 'Device disconnected',
      stderr: 'ErrorMtpDetectFailed',
      data: null,
    }),
  ],
  [
    'unexpected error with valid data',
    async () => ({
      ...response(two, [false, false]),
      error: 'Unexpected native failure',
    }),
  ],
  [
    'stderr only',
    async () => ({
      ...response(two, [false, false]),
      stderr: 'USB interface error',
    }),
  ],
  [
    'rejected call',
    async () => {
      throw new Error('FFI rejected lookup');
    },
  ],
  ['empty data', async () => ({ error: null, stderr: null, data: [] })],
  ['null response', async () => null],
  ['undefined response', async () => undefined],
  ['null data', async () => ({ error: null, stderr: null, data: null })],
  ['missing data', async () => ({ error: null, stderr: null })],
  [
    'missing envelope fields',
    async () => ({ data: response(two, [false, false]).data }),
  ],
  [
    'invalid envelope fields',
    async () => ({ ...response(two, [false, false]), error: false }),
  ],
  ['non-array data', async () => ({ error: null, stderr: null, data: {} })],
  ['missing record', async () => response(one, [false])],
  [
    'extra record',
    async () => response([...two, '/destination/c.jpg'], [false, false, false]),
  ],
  [
    'wrong path',
    async () => response(['/wrong/a.jpg', two[1]], [false, false]),
  ],
  ['duplicate record', async () => response([two[0], two[0]], [false, false])],
  ['non-boolean exists', async () => response(two, [false, 0])],
  [
    'missing exists',
    async () => ({
      error: null,
      stderr: null,
      data: [{ fullpath: two[0], exists: false }, { fullpath: two[1] }],
    }),
  ],
  [
    'null record',
    async () => ({
      error: null,
      stderr: null,
      data: [null, { fullpath: two[1], exists: false }],
    }),
  ],
  [
    'sparse records',
    async () => ({ error: null, stderr: null, data: new Array(2) }),
  ],
  [
    'conflict plus malformed second record',
    async () => response(two, [true, 'invalid']),
  ],
];

for (const [name, native] of failures) {
  test(`Adapter ${name} is unknown rather than an existence boolean`, async () => {
    const f = await fixture({ native, paths: two });
    const adapter = new f.Source();
    const result = await adapter.filesExist({ fileList: two, storageId: 1 });

    assert.notStrictEqual(typeof result, 'boolean');
    assert(result.error || result.stderr, 'Missing error evidence');
  });
  test(`Full Paste chain ${name} aborts without Replace, preparation or clipboard loss`, async () => {
    const f = await fixture({ native, paths: two });

    await f.ui._handlePaste();
    assert.strictEqual(f.calls.length, 1);
    assert(
      f.events.some((event) => event.type === 'alert'),
      'No visible lookup error'
    );
    assert(!f.events.some((event) => event.type === 'replace' && event.open));
    assert(!f.events.some((event) => event.type === 'prepare'));
    assert.strictEqual(f.ui.props.fileTransferClipboard, f.clipboard);
    assert.deepStrictEqual(Array.from(f.clipboard.queue), [
      '/source/a.jpg',
      '/source/b.png',
    ]);
    // A delayed confirmation must not revive the failed preflight.
    f.ui._handlePasteConfirm(true);
    assert(!f.events.some((event) => event.type === 'prepare'));
  });
}

test('Native error object and stderr are retained by the adapter', async () => {
  const error = new Error('Original native failure');
  const f = await fixture({
    native: async () => ({ error, stderr: 'Original stderr', data: null }),
  });
  const result = await new f.Source().filesExist({
    fileList: one,
    storageId: 1,
  });

  assert.strictEqual(result.error, error);
  assert.strictEqual(result.stderr, 'Original stderr');
});

test('Empty request is unknown, not proof of absence', async () => {
  const f = await fixture({
    native: async () => ({ error: null, stderr: null, data: [] }),
  });
  const result = await new f.Source().filesExist({
    fileList: [],
    storageId: 1,
  });

  assert.notStrictEqual(typeof result, 'boolean');
});

for (const [name, value] of [
  ['exists', true],
  ['absent', false],
  ['error', { error: 'Mock local error' }],
]) {
  test(`Android-to-Mac Paste ${name} retains current local preflight routing`, async () => {
    const f = await fixture({ deviceType: 'local', localResult: value });

    await f.ui._handlePaste();
    assert.strictEqual(f.calls[0].fileList[0], '/destination/a.jpg');
    assert.strictEqual(
      f.events.some((event) => event.type === 'replace' && event.open),
      value === true
    );
    assert.strictEqual(
      f.events.some((event) => event.type === 'prepare'),
      value === false
    );
    assert.strictEqual(f.ui.props.fileTransferClipboard, f.clipboard);
    if (typeof value !== 'boolean')
      assert(f.events.some((event) => event.type === 'alert'));
  });
}

for (const handler of [
  '_handleRenameEditDialog',
  '_handleNewFolderEditDialog',
]) {
  for (const state of ['exists', 'absent', 'error']) {
    test(`Unchanged ${handler} ${state} keeps its existing allow/block decision`, async () => {
      const f = await fixture({
        native: async ({ files }) =>
          state === 'error'
            ? {
                error: 'Mock lookup failure',
                stderr: 'ErrorGeneral',
                data: null,
              }
            : response(Array.from(files), [state === 'exists']),
      });

      await f.ui[handler]({ confirm: true, textFieldValue: 'new-name' });
      const mutation =
        handler === '_handleRenameEditDialog' ? 'rename' : 'newFolder';

      assert.strictEqual(
        f.events.some((event) => event.type === mutation),
        state === 'absent'
      );
      assert.strictEqual(
        f.events.some((event) => event.type === 'edit-error'),
        state !== 'absent'
      );
      assert.strictEqual(f.ui.props.fileTransferClipboard, f.clipboard);
    });
  }
}

test('Unknown helper result remains explicitly classified and truthy for existing guards', async () => {
  const f = await fixture({
    native: async () => {
      throw new Error('Mock failure');
    },
  });
  const result = await f.ui._filesExist({
    deviceType: 'mtp',
    fileList: one,
    storageId: 1,
  });

  assert.strictEqual(result.status, 'unknown');
  assert(result.error);
  assert(Boolean(result));
});

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

    console.info(`${passed}/${tests.length} Kalam existence tests passed.`);
  })();
