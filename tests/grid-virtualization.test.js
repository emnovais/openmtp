/* Pure geometry/lifecycle tests. No Electron or physical backend is loaded. */
require('./grid-scrolling-safety');
const assert = require('assert');
const { loadJsx, react } = require('./legacy-thumbnails.test');
const { directory } = require('./grid-scrolling.test');

const source =
  process.env.OPENMTP_GRID_WRAPPER ||
  'app/containers/HomePage/components/FileExplorerTableBodyGridWrapperRender.jsx';
const tests = [];
const test = (name, run) => tests.push({ name, run });

function fixture(count = 1000, deviceType = 'mtp') {
  const listeners = new Map();
  const frames = new Map();
  let frameId = 0;
  let width = 430;
  let observer;
  let updates = 0;
  const root = {
    scrollTop: 0,
    clientTop: 1,
    clientHeight: 520,
    getBoundingClientRect: () => ({ top: 10 }),
    addEventListener: (event, callback) =>
      listeners.set(`root:${event}`, callback),
    removeEventListener: (event, callback) => {
      assert.strictEqual(listeners.get(`root:${event}`), callback);
      listeners.delete(`root:${event}`);
    },
  };
  const document = { activeElement: null };
  const window = {
    addEventListener: (event, callback) => listeners.set(event, callback),
    removeEventListener: (event, callback) => {
      assert.strictEqual(listeners.get(event), callback);
      listeners.delete(event);
    },
  };

  class ResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.targets = new Set();
      observer = this;
    }

    observe(target) {
      this.targets.add(target);
    }

    disconnect() {
      this.targets.clear();
    }
  }
  const Wrapper = loadJsx(
    source,
    {
      react,
      '@material-ui/core/styles': { withStyles: () => (value) => value },
      '@material-ui/core/TableCell': 'cell',
      '@material-ui/core/TableRow': 'row',
      './FileExplorerTableBodyGridRender': 'tile',
      '../../app/containers/HomePage/components/FileExplorerTableBodyGridRender':
        'tile',
      '../../../utils/funcs': { quickHash: (value) => value },
      '../../app/utils/funcs': { quickHash: (value) => value },
      '../styles/FileExplorerTableBodyGridWrapperRender': { styles: {} },
      '../../app/containers/HomePage/styles/FileExplorerTableBodyGridWrapperRender':
        { styles: {} },
    },
    {
      document,
      window,
      ResizeObserver,
      requestAnimationFrame: (callback) => {
        frameId += 1;
        frames.set(frameId, callback);

        return frameId;
      },
      cancelAnimationFrame: (id) => frames.delete(id),
    }
  );
  const nodes = directory(count);
  const props = {
    deviceType,
    tableSort: nodes,
    classes: {},
    directoryGeneratedTime: 123,
    directoryLists: { [deviceType]: { queue: { selected: [] } } },
    currentBrowsePath: { [deviceType]: '/Images' },
    isSelected: (file) =>
      view.props.directoryLists[deviceType].queue.selected.includes(file),
    onTableClick() {},
    onTableDoubleClick() {},
    onContextMenuClick() {},
  };
  const view = new Wrapper(props);
  const baseSetState = view.setState;

  view.setState = (value) => {
    updates += 1;
    baseSetState(value);
  };

  view.wrapper.current = {
    closest: (selector) => {
      assert.strictEqual(selector, `#file-explorer-body-wrapper-${deviceType}`);

      return root;
    },
    getBoundingClientRect: () => ({ width, top: 27 - root.scrollTop }),
  };
  view.componentDidMount();
  const tree = () => view.render().props.children[0].props.children[0];
  const tiles = () => tree().props.children[0].props.children[0];
  const update = (next) => {
    const previous = view.props;

    view.props = { ...previous, ...next };
    view.componentDidUpdate(previous);
  };
  const frame = () => {
    const callbacks = [...frames.values()];

    frames.clear();
    callbacks.forEach((callback) => callback());
  };

  return {
    view,
    root,
    document,
    nodes,
    tiles,
    tree,
    update,
    frame,
    frames,
    listeners,
    get observer() {
      return observer;
    },
    get updates() {
      return updates;
    },
    resize(value) {
      width = value;
      observer.callback();
      frame();
    },
    scroll(value) {
      root.scrollTop = value;
      listeners.get('root:scroll')();
      frame();
    },
  };
}

for (const count of [0, 1, 5, 100, 500, 1000]) {
  test(`${count}: bounded rows, complete logical list and total height`, () => {
    const f = fixture(count);

    assert.strictEqual(f.view.props.tableSort.length, count);
    assert.strictEqual(f.tree().props.style.height, Math.ceil(count / 4) * 137);
    assert(f.tiles().length <= Math.min(count, 28));
    assert.deepStrictEqual(
      Array.from(f.tiles(), (tile) => tile.props.item.path),
      f.nodes.slice(0, f.tiles().length).map((item) => item.path)
    );
    f.view.componentWillUnmount();
  });
}

for (const count of [100, 500, 1000]) {
  test(`${count}: down/bottom/up windows preserve ordering and partial rows`, () => {
    const f = fixture(count);
    const bottom = Math.ceil(count / 4) * 137 - 520 + 32;

    [bottom / 2, bottom, bottom * 0.8, 0].forEach((position) => {
      f.scroll(position);
      const start = f.view.state.firstRow * 4;

      assert.deepStrictEqual(
        Array.from(f.tiles(), (tile) => tile.props.item.path),
        f.nodes.slice(start, start + f.tiles().length).map((item) => item.path)
      );
      assert(f.tiles().length <= 36);
      assert.strictEqual(
        f.tree().props.children[0].props.style.top,
        f.view.state.firstRow * 137
      );
      if (position === bottom)
        assert.strictEqual(
          f.tiles().slice(-1)[0].props.item,
          f.nodes[count - 1]
        );
    });
    f.view.componentWillUnmount();
  });
}

test('Scroll updates coalesce in one frame and stable windows avoid setState', () => {
  const f = fixture();
  const previous = f.updates;

  for (let i = 0; i < 100; i += 1) f.listeners.get('root:scroll')();
  assert.strictEqual(f.frames.size, 1);
  f.frame();
  assert.strictEqual(f.updates, previous);
  f.scroll(5000);
  assert.strictEqual(f.updates, previous + 1);
});
test('Resize recomputes columns and total height without changing logical items', () => {
  const f = fixture();

  [330, 530, 99, 430].forEach((width) => {
    f.resize(width);
    const columns = Math.max(1, Math.floor(width / 100));

    assert.strictEqual(f.view.state.columns, columns);
    assert.strictEqual(
      f.tree().props.style.height,
      Math.ceil(1000 / columns) * 137
    );
    assert.strictEqual(f.view.props.tableSort, f.nodes);
  });
});
test('Directory change resets scroll; sort preserves offset and new logical order', () => {
  const f = fixture();

  f.scroll(12000);
  f.update({ tableSort: [...f.nodes].reverse(), directoryGeneratedTime: 124 });
  assert.strictEqual(f.root.scrollTop, 12000);
  assert.strictEqual(
    f.tiles()[0].props.item,
    f.view.props.tableSort[f.view.state.firstRow * 4]
  );
  f.update({
    tableSort: directory(1, '/Other'),
    currentBrowsePath: { mtp: '/Other' },
    directoryGeneratedTime: 125,
  });
  assert.strictEqual(f.root.scrollTop, 0);
  assert.strictEqual(f.tiles().length, 1);
});
test('Panel measurements, listeners and selection are independent', () => {
  const phone = fixture();
  const local = fixture(1000, 'local');

  phone.scroll(12000);
  local.resize(330);
  assert.strictEqual(local.root.scrollTop, 0);
  assert.strictEqual(phone.view.state.columns, 4);
  assert(phone.view.state.firstRow > 0);
  assert.strictEqual(local.view.state.firstRow, 0);
});
test('Selection uses current full-list props and keeps revision on every tile', () => {
  const f = fixture();
  const item = f.nodes[2];

  f.update({
    directoryLists: {
      mtp: { queue: { selected: [item.path, f.nodes[999].path] } },
    },
  });
  const tile = f.tiles()[2].props;

  assert(tile.isSelected);
  assert.strictEqual(tile.directoryGeneratedTime, 123);
  assert.strictEqual(tile.onTableClick, f.view.props.onTableClick);
  assert.strictEqual(tile.onTableDoubleClick, f.view.props.onTableDoubleClick);
  assert.strictEqual(tile.onContextMenuClick, f.view.props.onContextMenuClick);
  assert.strictEqual(f.view.props.directoryLists.mtp.queue.selected.length, 2);
});
test('Focused keyboard selection reveals an unmounted item without changing focus', () => {
  const f = fixture();

  f.document.activeElement = f.root;
  f.update({
    directoryLists: { mtp: { queue: { selected: [f.nodes[999].path] } } },
  });
  assert(f.tiles().some((tile) => tile.props.item.path === f.nodes[999].path));
  assert.strictEqual(f.document.activeElement, f.root);
  f.update({
    directoryLists: {
      mtp: { queue: { selected: [f.nodes[2].path, f.nodes[999].path] } },
    },
  });
  f.update({
    directoryLists: { mtp: { queue: { selected: [f.nodes[2].path] } } },
  });
  assert(f.tiles().some((tile) => tile.props.item.path === f.nodes[2].path));
});
test('Unmount removes both observer targets, listeners and outstanding animation', () => {
  const f = fixture();

  f.view.scheduleMeasure();
  assert.strictEqual(f.observer.targets.size, 2);
  assert.strictEqual(f.frames.size, 1);
  f.view.componentWillUnmount();
  assert.strictEqual(f.observer.targets.size, 0);
  assert.strictEqual(f.frames.size, 0);
  assert.strictEqual(f.listeners.size, 0);
});

if (require.main === module) {
  let passed = 0;

  for (const { name, run } of tests) {
    try {
      run();
      passed += 1;
      console.info(`PASS ${name}`);
    } catch (error) {
      console.error(`FAIL ${name}\n${error.stack}`);
      process.exitCode = 1;
      break;
    }
  }

  console.info(`${passed}/${tests.length} Grid virtualization tests passed`);
}

module.exports = { fixture };
