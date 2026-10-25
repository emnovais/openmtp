/* Offline Legacy/local preflight tests. All MTP processes are mocked. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { StringDecoder } = require('node:string_decoder');
const { promisify } = require('node:util');
const babel = require('@babel/core');
const {
  load,
  enums,
  utils,
  log,
  transferHelpers,
} = require('./transfer-reliability.test');

const root = path.resolve(__dirname, '..');
const fixtureRoot = fs.mkdtempSync('/private/tmp/openmtp-t76-fixtures-');
const tests = [];
const test = (name, run) => tests.push({ name, run });
const checkIf = (value, type, values) => {
  if (type === 'array') assert(Array.isArray(value));
  else if (type === 'inObjectValues')
    assert(Object.values(values).includes(value));
  else assert.strictEqual(typeof value, type);
};
const source = fs.readFileSync(
  path.join(root, 'app/containers/HomePage/components/FileExplorer.jsx'),
  'utf8'
);
const ast = babel.parseSync(source, {
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
  .map((node) => source.slice(node.start, node.end))
  .join('\n');
const error = (code) => Object.assign(new Error(`Mock ${code}`), { code });
const row = (name, id = 42) => `${String(id).padEnd(10)} ${name}`;
const frame = (entries = [], parent = '/destination', storageId = 65537) => {
  const echo = parent === '/' ? '/' : `${parent}/`;

  return `selected storage ${storageId} Test Storage\n${echo}\n${entries
    .map((name, i) => row(name, i + 1))
    .join('\n')}${entries.length ? '\n' : ''}${echo}\n`;
};
let serial = 0;

async function fixture(options = {}) {
  serial += 1;
  const localDir = path.join(fixtureRoot, String(serial));

  fs.mkdirSync(localDir);
  const files = options.setup
    ? options.setup(localDir)
    : [path.join(localDir, 'a.jpg')];
  const calls = [];
  const metadata = [];
  const events = [];
  const queueModule = load('app/data/file-explorer/MtpOperationQueue.js', {});
  const queue = queueModule.default;
  const wires = options.wires ? [...options.wires] : [];
  const guard = (value) =>
    assert(
      path.resolve(value).startsWith(`${fixtureRoot}/`),
      `Unexpected filesystem path: ${value}`
    );
  const metadataCall = (kind, value) => {
    guard(value);
    metadata.push({ kind, path: value });
    const fault = options.fault?.(kind, value, localDir);

    if (fault) throw fault;

    return fs[kind](value);
  };
  const localModule = load(
    'app/data/file-explorer/data-sources/FileExplorerLocalDataSource.js',
    {
      path,
      'node:util': { promisify },
      junk: { not: () => true },
      rimraf() {
        throw new Error('No deletion permitted');
      },
      mkdirp() {
        throw new Error('No mkdir permitted');
      },
      'macos-version': { isGreaterThanOrEqualTo: () => false },
      fs: {
        readdir() {
          throw new Error('No browsing permitted');
        },
        existsSync(value) {
          guard(value);
          if (options.fault?.('lstatSync', value, localDir)) return false;

          return fs.existsSync(value);
        },
        lstatSync: (value) => metadataCall('lstatSync', value),
        statSync: (value) => metadataCall('statSync', value),
        rename() {
          throw new Error('No rename permitted');
        },
        readlink() {
          throw new Error('Unexpected readlink');
        },
        realpathSync() {
          throw new Error('Unexpected realpath');
        },
      },
      'lodash/find': () => {},
      '../../../utils/log': { log },
      '../../../utils/funcs': utils,
      '../../../utils/files': { pathUp: path.dirname },
      '../../../utils/date': { appDateFormat: String },
      '../../../utils/checkIf': { checkIf },
      '../../../constants/paths': { PATHS: {} },
      '../../../constants': { NODE_MAC_PERMISSIONS_MIN_OS: '0' },
    }
  );
  const legacyModule = load(
    'app/data/file-explorer/data-sources/FileExplorerLegacyDataSource.js',
    {
      path,
      'lodash/find': () => {},
      child_process: {
        spawn() {
          throw new Error('No transfer or thumbnail process permitted');
        },
        execFile(binary, command, settings, callback) {
          assert.strictEqual(binary, '/mock/never-execute-mtp-cli');
          assert.strictEqual(settings.shell, false);
          assert(Array.isArray(command));
          assert(
            calls.every((call) => call.closed),
            'Overlapping CLI process'
          );
          const child = new EventEmitter();

          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          const initialization = command.includes('storage-list');
          const wire = initialization
            ? { stdout: '65537 volume: Test, description: Internal Storage\n' }
            : wires.shift() || { stdout: frame(options.entries || []) };
          const call = { command, child, wire, initialization, closed: false };

          calls.push(call);
          call.close = () => {
            if (call.closed) return;
            call.closed = true;
            child.emit(
              'close',
              wire.code ?? (wire.error ? 1 : 0),
              wire.signal ?? null
            );
          };

          queueMicrotask(() => {
            // Model exec buffering interleaved child pipes before its callback.
            const buffered = { stdout: '', stderr: '' };

            call.streamEvents = [];
            for (const [stream, text] of wire.streamParts || []) {
              assert(['stdout', 'stderr'].includes(stream));
              call.streamEvents.push(stream);
              buffered[stream] += text;
              child[stream].emit('data', Buffer.from(text));
            }

            if (wire.processError) child.emit('error', wire.processError);
            if (!wire.noCallback)
              callback(
                wire.error || null,
                wire.streamParts ? buffered.stdout : wire.stdout ?? '',
                wire.streamParts ? buffered.stderr : wire.stderr ?? ''
              );
            child.emit(
              'exit',
              wire.code ?? (wire.error ? 1 : 0),
              wire.signal ?? null
            );
            if (!wire.holdClose) call.close();
          });

          return child;
        },
      },
      'node:string_decoder': { StringDecoder },
      '../../../utils/log': { log },
      '../../../utils/funcs': utils,
      '../../../constants': { DEVICES_LABEL: { mtp: 'Phone' } },
      '../../../enums': enums,
      '../../../utils/files': {
        baseName: path.basename,
        getExtension: path.extname,
      },
      '../../../helpers/binaries': {
        mtpCliPath: '/mock/never-execute-mtp-cli',
      },
      '../../../utils/date': { msToTime: String, unixTimestampNow: () => 1 },
      '../../../utils/checkIf': { checkIf },
      '../MtpOperationQueue': queueModule,
      '../transferResult': transferHelpers,
    }
  );
  const repository = load(
    'app/data/file-explorer/repositories/FileExplorerRepository.js',
    {
      '../data-sources/FileExplorerLocalDataSource': localModule,
      '../data-sources/FileExplorerLegacyDataSource': legacyModule,
      '../../../enums': enums,
      '../../../helpers/settings': { getMtpModeSetting: () => 'legacy' },
      '../MtpOperationQueue': queueModule,
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
        processMtpBuffer: (v) => ({ error: v.error || v.stderr }),
        processLocalBuffer: (v) => ({ error: v.error || v.stderr }),
      },
      '../../../helpers/settings': { getMtpModeSetting: () => 'legacy' },
      '../../../enums': enums,
      '../../../utils/date': { unixTimestampNow: () => 1 },
      '../../../utils/log': { log },
      '../transferResult': transferHelpers,
    }
  ).default;

  await controller.listStorages({ deviceType: 'mtp' });
  controller.selectStorage(65537);
  const deviceType = options.backend === 'local' ? 'local' : 'mtp';
  const ui = vm.runInNewContext(`new (class { ${methods} })()`, {
    path,
    pathUp: path.dirname,
    sanitizePath: (v) => v.replace(/\/\/+/g, '/'),
    baseName: path.basename,
    ...repository,
    DEVICE_TYPE: enums.DEVICE_TYPE,
    fileExplorerController: controller,
    analyticsService: { sendEvent() {} },
    EVENT_TYPE: {},
  });
  const clipboard = {
    source: deviceType === 'mtp' ? 'local' : 'mtp',
    queue: (options.targets || ['a.jpg']).map((name) => `/source/${name}`),
    mtpScope: repository.captureMtpScope(),
  };

  ui.props = {
    deviceType,
    currentBrowsePath: { local: localDir, mtp: '/destination' },
    storageId: 65537,
    fileTransferClipboard: clipboard,
    hideHiddenFiles: { local: false, mtp: false },
    actionCreateThrowError: (v) => events.push({ type: 'alert', ...v }),
    actionCreatePaste: (...args) => events.push({ type: 'prepare', args }),
    actionCreateRenameFile: () => events.push({ type: 'rename' }),
    actionCreateNewFolder: () => events.push({ type: 'newFolder' }),
  };
  ui._handleTogglePasteConfirmDialog = (open) =>
    events.push({ type: 'replace', open });
  ui._handleErrorsEditDialog = () => events.push({ type: 'edit-error' });
  ui._handleClearEditDialog = () => events.push({ type: 'clear-edit' });
  ui.dialogScope = repository.captureMtpScope();
  ui.state = {
    toggleDialog: {
      rename: {
        data: {
          path:
            deviceType === 'local'
              ? path.join(localDir, 'old.jpg')
              : '/destination/old.jpg',
          name: 'old.jpg',
        },
      },
      newFolder: { data: { path: ui.props.currentBrowsePath[deviceType] } },
    },
  };

  return {
    local: new localModule.FileExplorerLocalDataSource(),
    legacy: new legacyModule.FileExplorerLegacyDataSource(),
    controller,
    repository,
    ui,
    calls,
    metadata,
    events,
    clipboard,
    files,
    localDir,
    queue,
  };
}

function assertUnknown(value) {
  assert.notStrictEqual(
    typeof value,
    'boolean',
    'Failure flattened into a boolean'
  );
  assert(value?.error || value?.stderr, 'Unknown state lost error evidence');
}

async function assertPasteBlocked(f) {
  await f.ui._handlePaste();
  assert(
    f.events.some((e) => e.type === 'alert'),
    'Lookup failure has no error indication'
  );
  assert(!f.events.some((e) => e.type === 'replace' && e.open));
  assert(!f.events.some((e) => e.type === 'prepare'));
  assert.strictEqual(f.ui.props.fileTransferClipboard, f.clipboard);
  f.ui._handlePasteConfirm(true);
  assert(
    !f.events.some((e) => e.type === 'prepare'),
    'Delayed confirmation revived failed preflight'
  );
}

for (const [name, entries, expected] of [
  ['exists', ['a.jpg'], true],
  ['absent', [], false],
  ['missing target among siblings', ['other.jpg'], false],
  ['folder exists', ['folder'], true],
]) {
  test(`Legacy ${name} requires a complete framed response`, async () => {
    const target = name === 'folder exists' ? 'folder' : 'a.jpg';
    const f = await fixture({ entries });

    assert.strictEqual(
      await f.legacy.filesExist({
        fileList: [`/destination/${target}`],
        storageId: 65537,
      }),
      expected
    );
    assert(f.calls.every((c) => c.closed));
  });
}

const legacyFailures = [
  ['command failure', { error: error('EFAIL'), code: 1, stdout: frame() }],
  [
    'disconnection',
    { error: error('ENODEV'), code: 1, stderr: 'no mtp device found' },
  ],
  ['permission', { code: 1, stderr: 'Access denied' }],
  ['timeout', { error: error('ETIMEDOUT'), signal: 'SIGTERM' }],
  ['signal even with valid output', { signal: 'SIGTERM', stdout: frame() }],
  ['nonzero even with valid output', { code: 2, stdout: frame() }],
  ['malformed output', { stdout: 'garbage\n' }],
  ['empty output', { stdout: '' }],
  [
    'missing directory',
    { code: 1, stderr: 'error: could not find destination in path' },
  ],
  [
    'ambiguous not-found text',
    { code: 1, stderr: 'error: could not find a.jpg in path' },
  ],
  [
    'partial listing with stderr',
    { stdout: frame(['other.jpg']), stderr: 'error: GetObjectInfo failed' },
  ],
  [
    'truncated listing without footer',
    {
      stdout: `selected storage 65537 Test Storage\n/destination\n${row(
        'other.jpg'
      )}\n`,
    },
  ],
  ['truncated final line', { stdout: frame().slice(0, -1) }],
  [
    'invalid listing row',
    {
      stdout: frame().replace(
        '/destination/\n/destination/',
        '/destination/\ninvalid-row\n/destination/'
      ),
    },
  ],
  ['duplicate name', { stdout: frame(['other.jpg', 'other.jpg']) }],
  ['wrong storage', { stdout: frame([], '/destination', 99) }],
  ['wrong parent', { stdout: frame([], '/another') }],
  ['missing callback acknowledgement', { noCallback: true, stdout: frame() }],
  [
    'USB warning despite complete stdout',
    {
      stdout: frame(),
      stderr: 'Device::Find failed: USBInterfaceOpen 0xe00002c5\n',
    },
  ],
];

for (const [name, wire] of legacyFailures) {
  test(`Legacy ${name} remains unknown`, async () => {
    const f = await fixture({ wires: [wire] });

    assertUnknown(
      await f.legacy.filesExist({
        fileList: ['/destination/a.jpg'],
        storageId: 65537,
      })
    );
  });
  test(`Legacy ${name} is blocked through the full Paste chain`, async () => {
    const f = await fixture({ wires: [wire] });

    await assertPasteBlocked(f);
  });
}

test('Legacy processes the entire batch before reporting a conflict', async () => {
  const f = await fixture({
    wires: [{ stdout: frame(['a.jpg']) }, { error: error('ENODEV'), code: 1 }],
  });

  assertUnknown(
    await f.legacy.filesExist({
      fileList: ['/destination/a.jpg', '/destination/b.png'],
      storageId: 65537,
    })
  );
  assert.strictEqual(f.calls.filter((c) => !c.initialization).length, 2);
});
test('Legacy holds the same queue until actual process close, not exit/callback', async () => {
  const f = await fixture({
    wires: [{ stdout: frame(['a.jpg']), holdClose: true }],
  });
  let settled = false;
  const pending = f.legacy
    .filesExist({ fileList: ['/destination/a.jpg'], storageId: 65537 })
    .then((v) => {
      settled = true;

      return v;
    });

  await new Promise((resolve) => setImmediate(resolve));
  assert(!settled);
  assert(f.queue.active);
  f.calls[f.calls.length - 1].close();
  assert.strictEqual(await pending, true);
  assert(!f.queue.active);
});

const localCases = [
  [
    'regular file',
    (dir) => {
      const p = path.join(dir, 'a.jpg');

      fs.writeFileSync(p, 'synthetic');

      return [p];
    },
    true,
  ],
  [
    'directory',
    (dir) => {
      const p = path.join(dir, 'folder');

      fs.mkdirSync(p);

      return [p];
    },
    true,
  ],
  [
    'confirmed ENOENT in existing parent',
    (dir) => [path.join(dir, 'a.jpg')],
    false,
  ],
  [
    'broken terminal symlink',
    (dir) => {
      const p = path.join(dir, 'link');

      fs.symlinkSync(path.join(dir, 'absent'), p);

      return [p];
    },
    true,
  ],
  [
    'valid terminal symlink',
    (dir) => {
      fs.writeFileSync(path.join(dir, 'real'), 'synthetic');
      const p = path.join(dir, 'link');

      fs.symlinkSync('real', p);

      return [p];
    },
    true,
  ],
];

for (const [name, setup, expected] of localCases) {
  test(`Local ${name} has a reliable boolean result`, async () => {
    const f = await fixture({ backend: 'local', setup });

    assert.strictEqual(
      await f.local.filesExist({ fileList: f.files }),
      expected
    );
  });
}

const localFailures = [
  [
    'ENOTDIR',
    {
      setup: (dir) => {
        const p = path.join(dir, 'file');

        fs.writeFileSync(p, 'synthetic');

        return [path.join(p, 'a.jpg')];
      },
    },
  ],
  ['missing parent', { setup: (dir) => [path.join(dir, 'missing/a.jpg')] }],
  [
    'broken parent symlink',
    {
      setup: (dir) => {
        fs.symlinkSync('absent', path.join(dir, 'parent'));

        return [path.join(dir, 'parent/a.jpg')];
      },
    },
  ],
  [
    'EACCES',
    { fault: (kind) => (kind === 'lstatSync' ? error('EACCES') : null) },
  ],
  [
    'EPERM',
    { fault: (kind) => (kind === 'lstatSync' ? error('EPERM') : null) },
  ],
  ['EIO', { fault: (kind) => (kind === 'lstatSync' ? error('EIO') : null) }],
  [
    'unexpected EBOGUS',
    { fault: (kind) => (kind === 'lstatSync' ? error('EBOGUS') : null) },
  ],
  [
    'inaccessible parent',
    { fault: (kind) => (kind === 'statSync' ? error('EACCES') : null) },
  ],
  [
    'parent I/O failure',
    { fault: (kind) => (kind === 'statSync' ? error('EIO') : null) },
  ],
];

for (const [name, config] of localFailures) {
  test(`Local ${name} remains unknown`, async () => {
    const f = await fixture({ backend: 'local', ...config });

    assertUnknown(await f.local.filesExist({ fileList: f.files }));
  });
  test(`Local ${name} blocks the full Paste chain`, async () => {
    const f = await fixture({ backend: 'local', ...config });

    if (config.setup)
      f.ui.props.currentBrowsePath.local = path.dirname(f.files[0]);
    await assertPasteBlocked(f);
  });
}

for (const backend of ['local', 'legacy']) {
  for (const exists of [false, true]) {
    test(`${backend} valid Paste preserves the conflict/no-conflict path`, async () => {
      const f = await fixture({
        backend,
        entries: exists ? ['a.jpg'] : [],
        setup: exists
          ? (dir) => {
              const p = path.join(dir, 'a.jpg');

              fs.writeFileSync(p, 'synthetic');

              return [p];
            }
          : undefined,
      });

      await f.ui._handlePaste();
      assert.strictEqual(
        f.events.some((e) => e.type === 'replace' && e.open),
        exists
      );
      assert.strictEqual(
        f.events.some((e) => e.type === 'prepare'),
        !exists
      );
      assert.strictEqual(f.ui.props.fileTransferClipboard, f.clipboard);
      if (exists) {
        f.ui._handlePasteConfirm(false);
        assert(!f.events.some((e) => e.type === 'prepare'));
        f.ui._handlePasteConfirm(true);
        assert(!f.events.some((e) => e.type === 'prepare'));
        await f.ui._handlePaste();
        f.ui._handlePasteConfirm(true);
        assert.strictEqual(
          f.events.filter((e) => e.type === 'prepare').length,
          1
        );
      }
    });
  }

  test(`${backend} known conflict cannot hide a later unknown in a batch`, async () => {
    const f = await fixture({
      backend,
      targets: ['a.jpg', 'b.png'],
      wires: [
        { stdout: frame(['a.jpg']) },
        { stderr: 'disconnected', code: 1 },
      ],
      setup: (dir) => {
        fs.writeFileSync(path.join(dir, 'a.jpg'), 'synthetic');

        return [path.join(dir, 'a.jpg'), path.join(dir, 'b.png')];
      },
      fault: (kind, value) =>
        kind === 'lstatSync' && value.endsWith('/b.png')
          ? error('EACCES')
          : null,
    });

    await assertPasteBlocked(f);
  });
  for (const handler of [
    '_handleRenameEditDialog',
    '_handleNewFolderEditDialog',
  ]) {
    for (const state of ['exists', 'absent', 'unknown']) {
      test(`${backend} unchanged ${handler} retains ${state} allow/block behavior`, async () => {
        const f = await fixture({
          backend,
          entries: state === 'exists' ? ['new-name'] : [],
          wires:
            state === 'unknown'
              ? [{ stderr: 'query failed', code: 1 }]
              : undefined,
          setup: (dir) => {
            if (state === 'exists')
              fs.writeFileSync(path.join(dir, 'new-name'), 'synthetic');

            return [path.join(dir, 'new-name')];
          },
          fault: (kind) =>
            state === 'unknown' && kind === 'lstatSync' ? error('EIO') : null,
        });

        await f.ui[handler]({ confirm: true, textFieldValue: 'new-name' });
        const action =
          handler === '_handleRenameEditDialog' ? 'rename' : 'newFolder';

        assert.strictEqual(
          f.events.some((e) => e.type === action),
          state === 'absent'
        );
        assert.strictEqual(
          f.events.some((e) => e.type === 'edit-error'),
          state !== 'absent'
        );
      });
    }
  }
}

for (const backend of ['local', 'legacy']) {
  for (const invalid of [
    [],
    null,
    [''],
    [null],
    ['relative'],
    ['bad\u0000path'],
  ]) {
    test(`${backend} invalid request ${JSON.stringify(
      invalid
    )} is unknown`, async () => {
      const f = await fixture({ backend });

      assertUnknown(
        await f[backend === 'local' ? 'local' : 'legacy'].filesExist({
          fileList: invalid,
          storageId: 65537,
        })
      );
    });
  }
}

test('Legacy root-parent lookup accepts normalized root paths without guessing from empty stdout', async () => {
  const f = await fixture({ wires: [{ stdout: frame([], '/') }] });

  assert.strictEqual(
    await f.legacy.filesExist({ fileList: ['//a.jpg'], storageId: 65537 }),
    false
  );
});
test('Legacy accepts the initial storage header only when final selected storage matches', async () => {
  const f = await fixture({
    wires: [
      {
        stdout: `selected storage 131073 Initial Storage\n${frame(['a.jpg'])}`,
      },
    ],
  });

  assert.strictEqual(
    await f.legacy.filesExist({
      fileList: ['/destination/a.jpg'],
      storageId: 65537,
    }),
    true
  );
});
test('Legacy preserves leading/trailing spaces in metadata names', async () => {
  const f = await fixture({ wires: [{ stdout: frame([' a.jpg ']) }] });

  assert.strictEqual(
    await f.legacy.filesExist({
      fileList: ['/destination/ a.jpg '],
      storageId: 65537,
    }),
    true
  );
});
test('Legacy accepts complete non-root path echoes with or without the CLI trailing slash', async () => {
  const f = await fixture({
    wires: [
      { stdout: frame(['a.jpg']).replace(/\/destination\//g, '/destination') },
    ],
  });

  assert.strictEqual(
    await f.legacy.filesExist({
      fileList: ['/destination/a.jpg'],
      storageId: 65537,
    }),
    true
  );
});
test('Legacy keeps original command error and unfiltered diagnostic stderr', async () => {
  const original = error('EIO');
  const f = await fixture({
    wires: [
      {
        error: original,
        stderr: 'Device::Find failed: original diagnostic\n',
        code: 1,
      },
    ],
  });
  const result = await f.legacy.filesExist({
    fileList: ['/destination/a.jpg'],
    storageId: 65537,
  });

  assert.strictEqual(result.error, original);
  assert.strictEqual(
    result.stderr,
    'Device::Find failed: original diagnostic\n'
  );
});
test('Local symlink loop remains unknown', async () => {
  const f = await fixture({
    backend: 'local',
    setup: (dir) => {
      fs.symlinkSync('loop', path.join(dir, 'loop'));

      return [path.join(dir, 'loop/a.jpg')];
    },
  });

  assertUnknown(await f.local.filesExist({ fileList: f.files }));
});

// T11: generic discovery messages are evidence, never permission to transfer.
const usbDiagnostic =
  'Device::Find failed:(*_interface)->USBInterfaceOpen(_interface): error 0xe00002c5\n';
const flush = () => new Promise((resolve) => setImmediate(resolve));
const lookup = (f, target = 'a.jpg') =>
  f.controller.filesExist({
    deviceType: 'mtp',
    fileList: [`/destination/${target}`],
    storageId: 65537,
  });
const observed = (promise) =>
  promise.then(
    (value) => ({ value }),
    (error) => ({ error })
  );
const assertIdle = (f) => {
  assert.strictEqual(f.queue.active, false);
  assert.strictEqual(f.queue.pending.length, 0);
  assert.strictEqual(f.queue.fault, null);
  assert(f.calls.every((call) => call.closed));
};

for (const count of [1, 7, 64]) {
  test(`T11 ${count} repeated exclusive-access messages remain unknown and retained`, async () => {
    const stderr = usbDiagnostic.repeat(count);
    const f = await fixture({ wires: [{ stdout: frame(['a.jpg']), stderr }] });
    const result = await lookup(f);

    assertUnknown(result);
    assert.strictEqual(result.stderr, stderr);
    assert.strictEqual(f.calls.length, 2, 'Unexpected automatic retry');
    assertIdle(f);
  });
  test(`T11 ${count} repeated diagnostics preserve clipboard and block transfer`, async () => {
    const f = await fixture({
      wires: [{ stdout: frame(), stderr: usbDiagnostic.repeat(count) }],
    });
    const paths = [...f.clipboard.queue];

    await assertPasteBlocked(f);
    assert.deepStrictEqual(f.clipboard.queue, paths);
    assert.strictEqual(f.calls.length, 2, 'Unexpected automatic retry');
    assertIdle(f);
  });
}

for (const diagnostic of [
  'USB interface failure with unrecognized code 0xe000ffff\n',
  'Device::Find failed: unrelated interface (unverified claim)\n',
  'IOCreatePlugInInterfaceForService failed\n',
]) {
  test(`T11 unverified diagnostic is not whitelisted: ${diagnostic.trim()}`, async () => {
    const f = await fixture({
      wires: [{ stdout: frame(['a.jpg']), stderr: diagnostic }],
    });
    const result = await lookup(f);

    assertUnknown(result);
    assert.strictEqual(result.stderr, diagnostic);
    assertIdle(f);
  });
}

test('T11 interleaved stdout/stderr retains split diagnostics after clean exit', async () => {
  const stdout = frame(['a.jpg']);
  const f = await fixture({
    wires: [
      {
        streamParts: [
          ['stdout', stdout.slice(0, 20)],
          ['stderr', usbDiagnostic.slice(0, 28)],
          ['stdout', stdout.slice(20)],
          ['stderr', usbDiagnostic.slice(28)],
          ['stderr', usbDiagnostic],
        ],
      },
    ],
  });
  const result = await lookup(f);

  assertUnknown(result);
  assert.strictEqual(result.stderr, usbDiagnostic.repeat(2));
  assert.deepStrictEqual(f.calls[1].streamEvents, [
    'stdout',
    'stderr',
    'stdout',
    'stderr',
    'stderr',
  ]);
  assertIdle(f);
});

test('T11 concurrent metadata stays FIFO across callback/exit and delayed close', async () => {
  const f = await fixture({
    wires: [{ stdout: frame(['a.jpg']), holdClose: true }, { stdout: frame() }],
  });
  let completed = false;
  const first = lookup(f).then((result) => {
    completed = true;

    return result;
  });
  const second = lookup(f, 'missing.jpg');

  await flush();
  assert.strictEqual(completed, false);
  assert.strictEqual(f.calls.length, 2, 'Second process started before close');
  assert.strictEqual(f.queue.pending.length, 1);
  f.calls[1].close();
  assert.strictEqual(await first, true);
  assert.strictEqual(await second, false);
  assert.strictEqual(f.calls.length, 3);
  assertIdle(f);
});

test('T11 close after child error releases lane only after actual termination', async () => {
  const failure = error('EIO');
  const f = await fixture({
    wires: [
      { stdout: frame(), processError: failure, holdClose: true, code: 1 },
      { stdout: frame(['a.jpg']) },
    ],
  });
  const first = lookup(f);
  const second = lookup(f);

  await flush();
  assert.strictEqual(f.calls.length, 2);
  assert.strictEqual(f.queue.active, true);
  assert.strictEqual(f.queue.pending.length, 1);
  f.calls[1].close();
  const result = await first;

  assertUnknown(result);
  assert.strictEqual(result.error, failure);
  assert.strictEqual(await second, true);
  assertIdle(f);
});

for (const change of ['session', 'storage']) {
  test(`T11 ${change} change fences in-flight results and queued metadata before exec`, async () => {
    const f = await fixture({
      wires: [{ stdout: frame(['a.jpg']), holdClose: true }],
    });
    const first = observed(lookup(f));
    const second = observed(lookup(f, 'missing.jpg'));

    await flush();
    assert.strictEqual(f.queue.pending.length, 1);
    if (change === 'session') f.repository.invalidateRendererMtp();
    else f.controller.selectStorage(131073);
    f.calls[1].close();
    assert.match(String((await first).error), /Obsolete/);
    assert.match(String((await second).error), /Obsolete/);
    assert.strictEqual(f.calls.length, 2, 'Obsolete queued lookup executed');
    assertIdle(f);
  });
  test(`T11 ${change} change during Paste never prepares transfer or consumes clipboard`, async () => {
    const f = await fixture({
      wires: [{ stdout: frame(), holdClose: true }],
    });
    const pending = f.ui._handlePaste();

    await flush();
    if (change === 'session') f.repository.invalidateRendererMtp();
    else f.controller.selectStorage(131073);
    f.calls[1].close();
    await pending;
    f.ui._handlePasteConfirm(true);
    assert(!f.events.some((event) => event.type === 'prepare'));
    assert(!f.events.some((event) => event.type === 'replace' && event.open));
    assert.strictEqual(f.ui.props.fileTransferClipboard, f.clipboard);
    assertIdle(f);
  });
}

for (const [name, stdout] of [
  [
    'malformed object row',
    frame(['a.jpg']).replace(row('a.jpg', 1), 'invalid'),
  ],
  ['partial listing', frame(['a.jpg']).slice(0, -15)],
  ['wrong final storage', frame([], '/destination', 131073)],
]) {
  test(`T11 ${name} cannot establish absence or allow Paste`, async () => {
    const f = await fixture({ wires: [{ stdout }] });

    await assertPasteBlocked(f);
    assert.strictEqual(f.calls.length, 2);
    assertIdle(f);
  });
}

for (const [target, expected] of [
  ['a.jpg', true],
  ['missing.jpg', false],
]) {
  test(`T11 complete clean 916-row metadata reliably classifies ${target}`, async () => {
    const entries = [
      'a.jpg',
      ...Array.from({ length: 915 }, (_, i) => `item-${i}.png`),
    ];
    const f = await fixture({
      wires: [{ stdout: frame(entries) }, { stdout: frame(entries) }],
    });

    assert.strictEqual(await lookup(f, target), expected);
    assert.strictEqual(await lookup(f, target), expected);
    assert.strictEqual(
      f.calls.length,
      3,
      'Each explicit lookup owns one process'
    );
    assertIdle(f);
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
      } catch (e) {
        process.exitCode = 1;
        console.error(`FAIL ${name}`, e);
      }
    }

    console.info(
      `${passed}/${tests.length} Legacy/local destination existence tests passed.`
    );
    console.info(`Synthetic fixture root: ${fixtureRoot}`);
  })();
