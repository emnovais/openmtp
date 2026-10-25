// Plain-data transport shared by both processes. No native or Electron imports.
export const MTP_LIMITS = Object.freeze({
  wireBytes: 256 * 1024,
  wireNodes: 4000,
  chunkBytes: 48000,
  manifestBytes: 8 * 1024 * 1024,
  resultBytes: 32 * 1024 * 1024,
  paths: 50000,
  records: 100000,
  pending: 32,
  streams: 2,
  ttl: 60000,
});

export function transportError(message, code = 'MTP_IPC_INVALID') {
  const error = new Error(message);

  error.code = code;

  return error;
}

function requireData(condition, message) {
  if (!condition) throw transportError(message);
}

export function wireData(value) {
  let nodes = 0;
  const visit = (item, depth) => {
    nodes += 1;
    requireData(
      nodes <= MTP_LIMITS.wireNodes && depth <= 16,
      'Wire structure exceeds limit.'
    );
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number') {
      requireData(Number.isFinite(item), 'Non-finite wire number.');

      return;
    }

    if (typeof item === 'string') {
      requireData(item.length <= 65536, 'Wire string exceeds limit.');

      return;
    }

    requireData(
      item && typeof item === 'object',
      'Wire values must be plain data.'
    );
    const prototype = Object.getPrototypeOf(item);
    const constructorName =
      prototype &&
      Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value?.name;

    requireData(
      Array.isArray(item)
        ? constructorName === 'Array'
        : prototype === null ||
            (Object.getPrototypeOf(prototype) === null &&
              constructorName === 'Object'),
      'Invalid wire object.'
    );
    requireData(
      Object.getOwnPropertySymbols(item).length === 0,
      'Wire symbols rejected.'
    );
    const properties = Object.getOwnPropertyNames(item).filter(
      (key) => !(Array.isArray(item) && key === 'length')
    );

    requireData(
      !Array.isArray(item) || properties.length === item.length,
      'Sparse wire arrays rejected.'
    );
    properties.forEach((key) => {
      requireData(
        !['__proto__', 'constructor', 'prototype'].includes(key),
        'Unsafe wire property.'
      );
      const descriptor = Object.getOwnPropertyDescriptor(item, key);

      requireData(
        descriptor.enumerable &&
          Object.prototype.hasOwnProperty.call(descriptor, 'value'),
        'Wire accessor rejected.'
      );
      visit(descriptor.value, depth + 1);
    });
  };

  visit(value, 0);
  const json = JSON.stringify(value);

  requireData(
    Buffer.byteLength(json, 'utf8') <= MTP_LIMITS.wireBytes,
    'Wire message exceeds limit.'
  );

  return JSON.parse(json);
}

// Errors and missing optional values are encoded explicitly, never passed as
// Error instances through Electron's lossy exception serialization.
export function plainResult(value) {
  if (
    value instanceof Error ||
    (value &&
      typeof value.message === 'string' &&
      Object.prototype.toString.call(value) === '[object Error]')
  ) {
    return {
      code: String(value.code || 'MTP_BACKEND_ERROR'),
      message: value.message,
    };
  }

  if (value === undefined) return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  if (Array.isArray(value)) return value.map(plainResult);
  if (value && typeof value === 'object') {
    const result = {};

    Object.keys(value).forEach((key) => {
      requireData(
        !['__proto__', 'constructor', 'prototype'].includes(key),
        'Unsafe result property.'
      );
      result[key] = plainResult(value[key]);
    });

    return result;
  }

  return value;
}

export function encodePayload(value, limit) {
  const plain = plainResult(value);
  const listing = plain?.value?.data;

  if (Array.isArray(listing)) {
    requireData(
      listing.length <= MTP_LIMITS.records,
      'Directory record count exceeds limit.'
    );
    listing.forEach((record) => wireData(record));
  }

  const bytes = Buffer.from(JSON.stringify(plain), 'utf8');

  requireData(bytes.length <= limit, 'Payload exceeds retained-data limit.');
  const chunks = [];

  for (let offset = 0; offset < bytes.length; offset += MTP_LIMITS.chunkBytes) {
    chunks.push(
      bytes.subarray(offset, offset + MTP_LIMITS.chunkBytes).toString('base64')
    );
  }

  return { chunks, bytes: bytes.length, count: chunks.length };
}

export class MtpSessionTransport {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.streams = new Map();
  }

  sweep() {
    this.streams.forEach((stream, id) => {
      if (stream.expires <= this.now()) this.streams.delete(id);
    });
  }

  clear(client) {
    this.streams.forEach((stream, id) => {
      if (stream.client === client) this.streams.delete(id);
    });
  }

  begin(client, id, { bytes, count }, kind = 'manifest') {
    this.sweep();
    const limit =
      kind === 'manifest' ? MTP_LIMITS.manifestBytes : MTP_LIMITS.resultBytes;

    requireData(
      typeof id === 'string' && id.length <= 128 && !this.streams.has(id),
      'Duplicate stream.'
    );
    requireData(
      this.streams.size < MTP_LIMITS.streams,
      'Stream capacity exhausted.'
    );
    requireData(
      Number.isSafeInteger(bytes) &&
        bytes > 0 &&
        bytes <= limit &&
        Number.isSafeInteger(count) &&
        count === Math.ceil(bytes / MTP_LIMITS.chunkBytes),
      'Invalid stream totals.'
    );
    this.streams.set(id, {
      client,
      kind,
      bytes,
      count,
      next: 0,
      received: 0,
      chunks: [],
      expires: this.now() + MTP_LIMITS.ttl,
    });
  }

  get(client, id) {
    this.sweep();
    const stream = this.streams.get(id);

    requireData(
      stream && stream.client === client,
      'Missing or expired stream.'
    );
    stream.expires = this.now() + MTP_LIMITS.ttl;

    return stream;
  }

  append(client, id, { sequence, chunk, final }) {
    const stream = this.get(client, id);

    requireData(
      stream.kind === 'manifest' &&
        sequence === stream.next &&
        typeof chunk === 'string' &&
        /^[A-Za-z0-9+/]*={0,2}$/.test(chunk),
      'Non-contiguous manifest chunk.'
    );
    const bytes = Buffer.from(chunk, 'base64');

    requireData(
      bytes.toString('base64') === chunk &&
        bytes.length > 0 &&
        bytes.length <= MTP_LIMITS.chunkBytes,
      'Malformed chunk.'
    );
    requireData(
      final === (sequence === stream.count - 1),
      'Invalid final marker.'
    );
    requireData(
      stream.received + bytes.length <= stream.bytes,
      'Stream byte total exceeded.'
    );
    stream.next += 1;
    stream.received += bytes.length;
    stream.chunks.push(bytes);
  }

  commit(client, id) {
    const stream = this.get(client, id);

    requireData(
      stream.kind === 'manifest' &&
        stream.next === stream.count &&
        stream.received === stream.bytes,
      'Incomplete manifest.'
    );
    this.streams.delete(id);
    const json = Buffer.concat(stream.chunks).toString('utf8');

    requireData(
      Buffer.byteLength(json, 'utf8') === stream.bytes,
      'Invalid UTF-8 manifest.'
    );

    return JSON.parse(json);
  }

  result(client, id, operationId, value) {
    const encoded = encodePayload(value, MTP_LIMITS.resultBytes);

    this.begin(client, id, encoded, 'result');
    Object.assign(this.streams.get(id), {
      chunks: encoded.chunks,
      operationId,
    });

    return {
      streamId: id,
      operationId,
      bytes: encoded.bytes,
      count: encoded.count,
    };
  }

  pull(client, id, operationId, sequence) {
    const stream = this.get(client, id);

    requireData(
      stream.kind === 'result' &&
        stream.operationId === operationId &&
        sequence === stream.next &&
        sequence < stream.count,
      'Non-contiguous result page.'
    );
    const page = {
      streamId: id,
      operationId,
      sequence,
      chunk: stream.chunks[sequence],
      final: sequence === stream.count - 1,
      bytes: stream.bytes,
      count: stream.count,
    };

    stream.next += 1;
    if (page.final) this.streams.delete(id);

    return page;
  }
}

export function decodePages(descriptor, pages) {
  requireData(pages.length === descriptor.count, 'Missing result pages.');
  const bytes = pages.map((page, sequence) => {
    requireData(
      page.sequence === sequence &&
        page.streamId === descriptor.streamId &&
        page.operationId === descriptor.operationId &&
        page.bytes === descriptor.bytes &&
        page.count === descriptor.count &&
        page.final === (sequence === descriptor.count - 1),
      'Result page correlation mismatch.'
    );
    const data = Buffer.from(page.chunk, 'base64');

    requireData(
      data.toString('base64') === page.chunk &&
        data.length <= MTP_LIMITS.chunkBytes,
      'Invalid result encoding.'
    );

    return data;
  });
  const buffer = Buffer.concat(bytes);

  requireData(
    buffer.length === descriptor.bytes &&
      buffer.length <= MTP_LIMITS.resultBytes,
    'Result byte total mismatch.'
  );
  const json = buffer.toString('utf8');

  requireData(
    Buffer.byteLength(json, 'utf8') === buffer.length,
    'Invalid UTF-8 result.'
  );

  return JSON.parse(json);
}
