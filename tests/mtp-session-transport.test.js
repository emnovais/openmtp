/* All inputs are synthetic. No application/native/Electron imports. */
const assert = require('assert');
const { load } = require('./transfer-reliability.test');

const t = load('app/data/file-explorer/MtpSessionTransport.js', {});
const tests = [];
const test = (name, run) => tests.push({ name, run });
const encoded = (value) => t.encodePayload(value, t.MTP_LIMITS.manifestBytes);

function stage(store, value, id = 'manifest') {
  const data = encoded(value);

  store.begin('client', id, data);
  data.chunks.forEach((chunk, sequence) =>
    store.append('client', id, {
      sequence,
      chunk,
      final: sequence === data.count - 1,
    })
  );

  return store.commit('client', id);
}

test('Unicode and 50,000 paths survive complete manifest staging', () => {
  const value = Array.from({ length: 50000 }, (_, i) => `/目录/🙂/${i}`);

  assert.strictEqual(
    JSON.stringify(stage(new t.MtpSessionTransport(), value)),
    JSON.stringify(value)
  );
});
test('Large directory is returned only after all correlated result pages', () => {
  const store = new t.MtpSessionTransport();
  const records = Array.from({ length: 10000 }, (_, id) => ({
    name: `文件${id}`,
    path: `/目录/${id}`,
    size: id,
    dateAdded: '2026-10-22',
    isFolder: false,
  }));
  const descriptor = store.result('client', 'listing', 'op', records);
  const pages = Array.from({ length: descriptor.count }, (_, index) =>
    store.pull('client', 'listing', 'op', index)
  );

  assert.strictEqual(
    JSON.stringify(t.decodePages(descriptor, pages)),
    JSON.stringify(records)
  );
  assert.strictEqual(store.streams.size, 0);
});
for (const kind of [
  'missing',
  'duplicate',
  'reordered',
  'wrong-operation',
  'wrong-stream',
  'wrong-count',
  'wrong-bytes',
  'wrong-final',
]) {
  test(`Result rejects ${kind} pages`, () => {
    const store = new t.MtpSessionTransport();
    const descriptor = store.result(
      'client',
      'listing',
      'op',
      'x'.repeat(100000)
    );
    const pages = Array.from({ length: descriptor.count }, (_, index) =>
      store.pull('client', 'listing', 'op', index)
    );

    if (kind === 'missing') pages.pop();
    if (kind === 'duplicate') [pages[1]] = pages;
    if (kind === 'reordered') pages.reverse();
    if (kind === 'wrong-operation') pages[0].operationId = 'other';
    if (kind === 'wrong-stream') pages[0].streamId = 'other';
    if (kind === 'wrong-count') pages[0].count += 1;
    if (kind === 'wrong-bytes') pages[0].bytes += 1;
    if (kind === 'wrong-final') pages[0].final = true;
    assert.throws(() => t.decodePages(descriptor, pages));
  });
}

test('Incomplete mutation manifest never commits', () => {
  const store = new t.MtpSessionTransport();

  store.begin('client', 'manifest', encoded('a'.repeat(100000)));
  assert.throws(() => store.commit('client', 'manifest'));
});
test('Duplicate and reordered upload chunks are rejected', () => {
  const store = new t.MtpSessionTransport();
  const data = encoded('a'.repeat(100000));

  store.begin('client', 'manifest', data);
  assert.throws(() =>
    store.append('client', 'manifest', {
      sequence: 1,
      chunk: data.chunks[1],
      final: false,
    })
  );
  store.append('client', 'manifest', {
    sequence: 0,
    chunk: data.chunks[0],
    final: false,
  });
  assert.throws(() =>
    store.append('client', 'manifest', {
      sequence: 0,
      chunk: data.chunks[0],
      final: false,
    })
  );
});
test('Expired streams cannot be committed or pulled', () => {
  let now = 0;
  const store = new t.MtpSessionTransport({ now: () => now });

  store.begin('client', 'manifest', encoded('x'));
  now = t.MTP_LIMITS.ttl + 1;
  assert.throws(() => store.commit('client', 'manifest'));
  assert.strictEqual(store.streams.size, 0);
});
test('Client revocation releases staging and snapshots', () => {
  const store = new t.MtpSessionTransport();

  store.begin('client', 'manifest', encoded('x'));
  store.result('client', 'result', 'op', []);
  store.clear('client');
  assert.strictEqual(store.streams.size, 0);
});
test('Staging capacity and byte caps are enforced', () => {
  const store = new t.MtpSessionTransport();

  store.begin('client', 'a', encoded('x'));
  store.begin('client', 'b', encoded('x'));
  assert.throws(() => store.begin('client', 'c', encoded('x')));
  assert.throws(() =>
    t.encodePayload(
      'x'.repeat(t.MTP_LIMITS.manifestBytes),
      t.MTP_LIMITS.manifestBytes
    )
  );
  assert.throws(() =>
    t.encodePayload(
      'x'.repeat(t.MTP_LIMITS.resultBytes),
      t.MTP_LIMITS.resultBytes
    )
  );
});
test('Full wire envelopes enforce byte, node, string and nesting limits', () => {
  const local = load('app/data/file-explorer/MtpSessionTransport.js', {});

  assert.throws(() => local.wireData(Array(4000).fill(null)));
  assert.throws(() => local.wireData('x'.repeat(65537)));
  assert.throws(() => local.wireData(Array(10).fill('界'.repeat(20000))));
  let value = null;

  for (let i = 0; i < 18; i += 1) value = [value];
  assert.throws(() => local.wireData(value));
});
test('Malformed base64, wrong final marker and byte totals fail closed', () => {
  const store = new t.MtpSessionTransport();
  const data = encoded('x');

  store.begin('client', 'manifest', data);
  assert.throws(() =>
    store.append('client', 'manifest', {
      sequence: 0,
      chunk: '???',
      final: true,
    })
  );
  assert.throws(() =>
    store.append('client', 'manifest', {
      sequence: 0,
      chunk: data.chunks[0],
      final: false,
    })
  );
});
test('Oversized individual directory records fail explicitly', () => {
  assert.throws(() =>
    t.encodePayload(
      { value: { data: [{ name: 'x'.repeat(65537) }] } },
      t.MTP_LIMITS.resultBytes
    )
  );
});
test('Directory record count limit rejects excess records', () => {
  assert.throws(() =>
    t.encodePayload(
      { value: { data: Array(100001).fill({ name: 'a' }) } },
      t.MTP_LIMITS.resultBytes
    )
  );
});
test('Non-plain types, accessors, symbols and sparse arrays are rejected', () => {
  assert.throws(() => t.wireData(new Date()));
  assert.throws(() =>
    t.wireData({
      get data() {
        throw new Error('must not execute');
      },
    })
  );
  assert.throws(() => t.wireData({ value: Symbol('unsafe') }));
  assert.throws(() => t.wireData(Array(2)));
});
(async () => {
  let passed = 0;

  for (const { name, run } of tests) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await run();
      passed += 1;
      console.info(`PASS ${name}`);
    } catch (error) {
      console.error(`FAIL ${name}`, error);
      process.exitCode = 1;
    }
  }

  console.info(`${passed}/${tests.length} MTP transport tests passed.`);
})();
