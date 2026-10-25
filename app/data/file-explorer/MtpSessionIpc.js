import { v4 as uuidv4 } from 'uuid';
import { IpcEvents } from '../../services/ipc-events/IpcEventType';
import { MtpSessionOwner } from './MtpSessionOwner';
import mtpOperationQueue from './MtpOperationQueue';

// This module has no Electron/backend imports or module-level owner instance.
// Contract helpers are shared with the renderer client. Without an injected
// main-process service the endpoint remains passive for B2.1 regression tests.
// The application injects its sole owner and accepts only protocol v2.
export const MTP_SESSION_CHANNELS = Object.freeze({
  request: IpcEvents.MTP_SESSION_REQUEST,
  event: IpcEvents.MTP_SESSION_EVENT,
});
export const MTP_SESSION_OPERATIONS = Object.freeze([
  'initialize',
  'dispose',
  'fetchDeviceInfo',
  'listStorages',
  'listFiles',
  'filesExist',
  'renameFile',
  'makeDirectory',
  'deleteFiles',
  'transferFiles',
  'fetchDebugReport',
  'selectStorage',
  'selectBackend',
]);

export function mtpIpcError(code, message) {
  const error = new Error(message);

  error.code = code;

  return error;
}

function requireValue(condition, message) {
  if (!condition) throw mtpIpcError('MTP_IPC_INVALID', message);
}

export function isMtpIdentifier(value) {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  );
}

export function isAuthorizedMtpSender(event, mainWindow, expectedUrl) {
  const sender = mainWindow?.webContents;
  const frame = event?.senderFrame;

  return (
    !!sender &&
    event?.sender === sender &&
    !sender.isDestroyed() &&
    frame === sender.mainFrame &&
    typeof expectedUrl === 'string' &&
    typeof frame?.url === 'string' &&
    frame.url.split('#')[0] === expectedUrl.split('#')[0]
  );
}

export function validateMtpOwnerState(state) {
  exactKeys(state, [
    'state',
    'ownerEpoch',
    'generation',
    'clientEpoch',
    'backend',
    'storageId',
    'storageRevision',
    'identityEvidence',
    'reason',
    'activeOperationId',
    'queueFault',
    'executionEnabled',
  ]);
  requireValue(
    ['Disconnected', 'Connecting', 'Ready', 'Invalidated', 'Closing'].includes(
      state.state
    ) && typeof state.executionEnabled === 'boolean',
    'Invalid passive owner state.'
  );
  requireValue(
    isMtpIdentifier(state.ownerEpoch) &&
      (state.clientEpoch === null || isMtpIdentifier(state.clientEpoch)) &&
      (state.activeOperationId === null ||
        isMtpIdentifier(state.activeOperationId)),
    'Invalid owner-state identifiers.'
  );
  requireValue(
    Number.isSafeInteger(state.generation) &&
      state.generation >= 0 &&
      Number.isSafeInteger(state.storageRevision) &&
      state.storageRevision >= 0,
    'Invalid owner-state revision.'
  );
  requireValue(
    (state.backend === null || ['kalam', 'legacy'].includes(state.backend)) &&
      (state.storageId === null || storageId(state.storageId)),
    'Invalid owner-state backend/storage.'
  );
  requireValue(
    (state.reason === null || typeof state.reason === 'string') &&
      (state.queueFault === null || typeof state.queueFault === 'string') &&
      (state.identityEvidence === null ||
        (typeof state.identityEvidence === 'object' &&
          !Array.isArray(state.identityEvidence))),
    'Invalid owner-state evidence.'
  );
}

// Strict JSON-shaped data only: no accessors, custom instances, functions,
// symbols, undefined, non-finite numbers, sparse arrays, or cyclic references.
// Copying also prevents caller mutation after admission. These are transport
// limits, not a filesystem sandbox or physical-device authorization policy.
export function cloneMtpData(value) {
  const ancestors = new Set();
  let nodes = 0;
  const copy = (item, depth) => {
    nodes += 1;
    requireValue(
      depth <= 16 && nodes <= 20000,
      'IPC data exceeds structural limits.'
    );
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number') {
      requireValue(Number.isFinite(item), 'IPC numbers must be finite.');

      return item;
    }

    if (typeof item === 'string') {
      requireValue(item.length <= 65536, 'IPC string exceeds transport limit.');

      return item;
    }

    requireValue(typeof item === 'object', 'IPC values must be plain data.');
    requireValue(!ancestors.has(item), 'Cyclic IPC data is not allowed.');
    const prototype = Object.getPrototypeOf(item);

    requireValue(
      Array.isArray(item)
        ? prototype !== null &&
            Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value
              ?.name === 'Array'
        : prototype === null ||
            (Object.getPrototypeOf(prototype) === null &&
              Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value
                ?.name === 'Object'),
      'IPC objects must have plain prototypes.'
    );
    requireValue(
      Object.getOwnPropertySymbols(item).length === 0,
      'IPC symbols are not allowed.'
    );
    ancestors.add(item);
    const keys = Object.getOwnPropertyNames(item).filter(
      (key) => !(Array.isArray(item) && key === 'length')
    );

    requireValue(
      !Array.isArray(item) || keys.length === item.length,
      'IPC arrays must be dense.'
    );
    const result = Array.isArray(item) ? [] : {};

    keys.forEach((key, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);

      requireValue(
        descriptor.enumerable &&
          Object.prototype.hasOwnProperty.call(descriptor, 'value'),
        'IPC accessors and hidden properties are not allowed.'
      );
      requireValue(
        !['__proto__', 'constructor', 'prototype'].includes(key),
        'Unsafe IPC property.'
      );
      requireValue(
        !Array.isArray(item) || key === String(index),
        'IPC arrays cannot have custom properties.'
      );
      result[key] = copy(descriptor.value, depth + 1);
    });
    ancestors.delete(item);

    return result;
  };
  const result = copy(value, 0);

  requireValue(
    JSON.stringify(result).length <= 1048576,
    'IPC payload exceeds transport limit.'
  );

  return result;
}

function exactKeys(value, keys) {
  requireValue(
    value && typeof value === 'object' && !Array.isArray(value),
    'Expected an IPC object.'
  );
  requireValue(
    Object.keys(value).length === keys.length &&
      keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)),
    'Unexpected or missing IPC fields.'
  );
}

const storageId = (value) =>
  Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff;
const pathValue = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 8192 &&
  !value.includes('\0');

export function validateMtpOperation(operation, args, context) {
  requireValue(
    MTP_SESSION_OPERATIONS.includes(operation),
    'Unknown MTP IPC operation.'
  );
  const fields = {
    initialize: [],
    dispose: [],
    fetchDeviceInfo: [],
    listStorages: [],
    fetchDebugReport: [],
    listFiles: ['filePath', 'ignoreHidden', 'storageId'],
    filesExist: ['fileList', 'storageId'],
    deleteFiles: ['fileList', 'storageId'],
    renameFile: ['filePath', 'newFilename', 'storageId'],
    makeDirectory: ['filePath', 'storageId'],
    transferFiles: ['destination', 'fileList', 'direction', 'storageId'],
    selectStorage: ['storageId'],
    selectBackend: ['backend'],
  };

  exactKeys(args, fields[operation]);
  Object.keys(args).forEach((key) => {
    const value = args[key];

    if (key === 'storageId')
      requireValue(storageId(value), 'Invalid storage ID.');
    if (['filePath', 'newFilename', 'destination'].includes(key))
      requireValue(pathValue(value), 'Invalid path argument.');
    if (key === 'fileList')
      requireValue(
        Array.isArray(value) && value.length > 0 && value.every(pathValue),
        'Invalid file list.'
      );
    if (key === 'ignoreHidden')
      requireValue(typeof value === 'boolean', 'Invalid hidden-file setting.');
    if (key === 'direction')
      requireValue(
        ['upload', 'download'].includes(value),
        'Invalid transfer direction.'
      );
    if (key === 'backend')
      requireValue(['kalam', 'legacy'].includes(value), 'Invalid backend.');
  });
  if (context !== null) {
    // Context here is transport metadata, not a capability. B2.2 must resolve
    // the original server-issued B1 context; its WeakMap rejects IPC clones.
    exactKeys(context, [
      'ownerEpoch',
      'generation',
      'clientEpoch',
      'operationId',
      'backend',
      'storageId',
      'storageRevision',
      'operationKind',
    ]);
    requireValue(
      isMtpIdentifier(context.ownerEpoch) &&
        isMtpIdentifier(context.clientEpoch) &&
        isMtpIdentifier(context.operationId),
      'Invalid operation context identifiers.'
    );
    requireValue(
      Number.isSafeInteger(context.generation) &&
        context.generation >= 0 &&
        Number.isSafeInteger(context.storageRevision) &&
        context.storageRevision >= 0,
      'Invalid context revision.'
    );
    requireValue(
      ['kalam', 'legacy'].includes(context.backend) &&
        ['read', 'mutation', 'lifecycle'].includes(context.operationKind) &&
        (context.storageId === null || storageId(context.storageId)),
      'Invalid operation context.'
    );
  }
}

function validateRequest(payload) {
  const request = cloneMtpData(payload);
  const identity = ['version', 'action', 'requestId', 'rendererId'];
  const client = [...identity, 'ownerEpoch', 'clientEpoch'];

  requireValue(
    request?.version === 1 &&
      isMtpIdentifier(request.requestId) &&
      isMtpIdentifier(request.rendererId),
    'Invalid IPC protocol or correlation identifiers.'
  );
  requireValue(
    ['handshake', 'request', 'dispose'].includes(request.action),
    'Unknown IPC action.'
  );
  exactKeys(
    request,
    request.action === 'handshake'
      ? identity
      : request.action === 'dispose'
      ? client
      : [...client, 'operation', 'args', 'context']
  );
  if (request.action !== 'handshake') {
    requireValue(
      isMtpIdentifier(request.ownerEpoch) &&
        isMtpIdentifier(request.clientEpoch),
      'Invalid client lifetime.'
    );
  }

  if (request.action === 'request')
    validateMtpOperation(request.operation, request.args, request.context);

  return request;
}

export class MtpSessionIpc {
  constructor({
    ipcMain,
    isAuthorizedSender = () => false,
    createId = uuidv4,
    lifecycle,
    backendFactory = null,
    service = null,
    transport = null,
    wire = null,
  }) {
    this.ipcMain = ipcMain;
    this.service = service;
    this.transport = transport;
    this.wire = wire;
    this.activeJobs = new Map();
    this.operationSequence = 0;
    this.isAuthorizedSender = isAuthorizedSender;
    this.createId = createId;
    this._epochs = new Set();
    const ownerEpoch = this._newEpoch();

    this.lifecycle =
      lifecycle ||
      service?.owner ||
      new MtpSessionOwner({ queue: mtpOperationQueue, ownerEpoch });
    this.ownerEpoch = this.lifecycle.getSnapshot().ownerEpoch;
    requireValue(isMtpIdentifier(this.ownerEpoch), 'Invalid owner epoch.');
    this._epochs.add(this.ownerEpoch);
    // Reserved dependency only. B2.1 never constructs or calls an adapter.
    this._backendFactory = backendFactory;
    this.clients = new Map();
    this.started = false;
  }

  _newEpoch() {
    if (this.service) {
      this._epochSequence = (this._epochSequence || 0) + 1;

      return `${this.createId()}:${this._epochSequence}`;
    }

    const epoch = this.createId();

    requireValue(
      isMtpIdentifier(epoch) && !this._epochs.has(epoch),
      'Owner/client epoch cannot be reused.'
    );
    this._epochs.add(epoch);

    return epoch;
  }

  start() {
    if (this.started) return;

    this.ipcMain.handle(MTP_SESSION_CHANNELS.request, (event, payload) =>
      this.handle(event, payload)
    );
    this.started = true;
  }

  stop() {
    if (!this.started) return;

    this.ipcMain.removeHandler(MTP_SESSION_CHANNELS.request);
    Array.from(this.clients.values()).forEach((client) =>
      this._revoke(client, 'MTP_IPC_STOPPED')
    );
    this.started = false;
  }

  _snapshot() {
    const state = cloneMtpData({
      ...this.lifecycle.getSnapshot(),
      executionEnabled: !!this.service,
    });

    validateMtpOwnerState(state);

    return state;
  }

  _reply(request, result, clientEpoch = request?.clientEpoch || null) {
    return {
      version: 1,
      type: 'terminal',
      requestId: isMtpIdentifier(request?.requestId) ? request.requestId : null,
      rendererId: isMtpIdentifier(request?.rendererId)
        ? request.rendererId
        : null,
      ownerEpoch: this.ownerEpoch,
      clientEpoch,
      ...result,
    };
  }

  _emit(client, type, requestId, data) {
    if (
      client.sender.isDestroyed() ||
      this.isAuthorizedSender({
        sender: client.sender,
        senderFrame: client.frame,
      }) !== true
    )
      return false;

    Object.assign(client, { sequence: client.sequence + 1 });
    try {
      client.sender.send(
        MTP_SESSION_CHANNELS.event,
        cloneMtpData({
          version: 1,
          type,
          requestId,
          rendererId: client.rendererId,
          ownerEpoch: this.ownerEpoch,
          clientEpoch: client.clientEpoch,
          sequence: client.sequence,
          data,
        })
      );

      return true;
    } catch (_) {
      return false;
    }
  }

  _revoke(client, code) {
    if (this.clients.get(client.sender.id) !== client) return;

    this.clients.delete(client.sender.id);
    if (this.service) {
      this.service.revoke(client.clientEpoch);
      this.transport.clear(client.clientEpoch);
      this.activeJobs.forEach((job, id) => {
        if (job.client === client.clientEpoch) {
          Object.assign(job, { detached: true });
          if (job.done) this.activeJobs.delete(id);
        }
      });
    }

    client.sender.removeListener('destroyed', client.destroyed);
    client.sender.removeListener('render-process-gone', client.destroyed);
    client.sender.removeListener('did-start-navigation', client.navigation);
    this._emit(client, 'client-disposed', client.subscriptionId, {
      code,
      message: 'MTP IPC client lifetime ended.',
    });
  }

  publishOwnerState() {
    if (this.service) {
      this.clients.forEach((client) => {
        if (
          !this.isAuthorizedSender({
            sender: client.sender,
            senderFrame: client.frame,
          })
        ) {
          this._revoke(client, 'MTP_IPC_RENDERER_GONE');

          return;
        }

        try {
          client.sender.send(
            MTP_SESSION_CHANNELS.event,
            this.wire({
              version: 2,
              type: 'owner-state',
              stateSequence: this.service.stateSequence,
              ownerEpoch: this.ownerEpoch,
              clientEpoch: client.clientEpoch,
              data: this.service.snapshot(),
            })
          );
        } catch (_) {
          this._revoke(client, 'MTP_IPC_RENDERER_GONE');
        }
      });

      return;
    }

    const state = this._snapshot();

    this.clients.forEach((client) => {
      if (!this._emit(client, 'owner-state', client.subscriptionId, state))
        this._revoke(client, 'MTP_IPC_RENDERER_GONE');
    });
  }

  handle(event, payload) {
    if (this.service) return this.handleActive(event, payload);

    let request;

    try {
      if (this.isAuthorizedSender(event) !== true)
        throw mtpIpcError(
          'MTP_IPC_UNAUTHORIZED',
          'Unauthorized MTP IPC sender.'
        );
      request = validateRequest(payload);
      const previous = this.clients.get(event.sender.id);

      if (request.action === 'handshake') {
        if (previous?.rendererId === request.rendererId) {
          throw mtpIpcError(
            'MTP_IPC_DUPLICATE',
            'Renderer already completed its handshake.'
          );
        }

        const clientEpoch = this._newEpoch();

        if (previous) this._revoke(previous, 'MTP_IPC_REPLACED');
        const client = {
          sender: event.sender,
          frame: event.senderFrame,
          rendererId: request.rendererId,
          clientEpoch,
          seen: new Set([request.requestId]),
          subscriptionId: request.requestId,
          sequence: 0,
        };

        client.destroyed = () => this._revoke(client, 'MTP_IPC_RENDERER_GONE');
        client.navigation = (_, _url, inPlace, mainFrame) => {
          if (mainFrame && !inPlace) this._revoke(client, 'MTP_IPC_NAVIGATED');
        };

        event.sender.once('destroyed', client.destroyed);
        event.sender.once('render-process-gone', client.destroyed);
        event.sender.on('did-start-navigation', client.navigation);
        this.clients.set(event.sender.id, client);

        return this._reply(
          request,
          { ok: true, data: this._snapshot() },
          clientEpoch
        );
      }

      requireValue(
        previous &&
          previous.sender === event.sender &&
          previous.frame === event.senderFrame &&
          previous.rendererId === request.rendererId &&
          previous.clientEpoch === request.clientEpoch &&
          this.ownerEpoch === request.ownerEpoch,
        'Obsolete or unknown MTP IPC client.'
      );
      if (previous.seen.has(request.requestId))
        throw mtpIpcError(
          'MTP_IPC_DUPLICATE',
          'Correlation identifier already used.'
        );
      previous.seen.add(request.requestId);
      if (request.action === 'dispose') {
        this._revoke(previous, 'MTP_IPC_DISPOSED');

        return this._reply(request, { ok: true, data: null });
      }

      if (request.context) {
        requireValue(
          request.context.ownerEpoch === this.ownerEpoch &&
            request.context.clientEpoch === previous.clientEpoch,
          'Operation context belongs to another client lifetime.'
        );
      }

      // Never dispatch, initialize, dispose, run diagnostics, or invoke a factory.
      throw mtpIpcError(
        'MTP_OWNER_INACTIVE',
        'MTP IPC execution is inactive until the ownership cutover.'
      );
    } catch (error) {
      const knownError =
        isMtpIdentifier(error?.code) && typeof error?.message === 'string';

      return this._reply(request, {
        ok: false,
        error: {
          code: knownError ? error.code : 'MTP_IPC_INTERNAL',
          message: knownError ? error.message : 'MTP IPC request failed.',
        },
      });
    }
  }

  sweep() {
    if (!this.service) return;
    this.transport.sweep();
    this.service.sweep();
    this.activeJobs.forEach((job, id) => {
      if (job.done && job.expires <= Date.now()) this.activeJobs.delete(id);
    });
  }

  async handleActive(event, payload) {
    let request;
    const reply = (result) =>
      this.wire({
        version: 2,
        type: 'terminal',
        requestId: request?.requestId || null,
        rendererId: request?.rendererId || null,
        ownerEpoch: this.ownerEpoch,
        clientEpoch:
          this.clients.get(event.sender?.id)?.clientEpoch ||
          request?.clientEpoch ||
          null,
        ...result,
      });

    try {
      if (this.isAuthorizedSender(event) !== true)
        throw mtpIpcError('MTP_IPC_UNAUTHORIZED', 'Unauthorized MTP sender.');
      request = this.wire(payload);
      requireValue(
        request.version === 2 &&
          isMtpIdentifier(request.requestId) &&
          isMtpIdentifier(request.rendererId) &&
          Number.isSafeInteger(request.ordinal) &&
          request.ordinal > 0,
        'Unsupported or malformed active protocol.'
      );
      let client = this.clients.get(event.sender.id);

      if (request.action === 'handshake') {
        requireValue(
          !client || client.rendererId !== request.rendererId,
          'Duplicate handshake.'
        );
        if (client) this._revoke(client, 'MTP_IPC_REPLACED');
        client = {
          sender: event.sender,
          frame: event.senderFrame,
          rendererId: request.rendererId,
          clientEpoch: this._newEpoch(),
          subscriptionId: request.requestId,
          ordinal: request.ordinal,
          sequence: 0,
        };
        client.destroyed = () => this._revoke(client, 'MTP_IPC_RENDERER_GONE');
        client.navigation = (_, _url, inPlace, mainFrame) => {
          if (mainFrame && !inPlace) client.destroyed();
        };

        event.sender.once('destroyed', client.destroyed);
        event.sender.once('render-process-gone', client.destroyed);
        event.sender.on('did-start-navigation', client.navigation);
        this.clients.set(event.sender.id, client);

        return reply({ ok: true, data: this.service.snapshot() });
      }

      requireValue(
        client &&
          client.frame === event.senderFrame &&
          client.rendererId === request.rendererId &&
          client.clientEpoch === request.clientEpoch &&
          request.ownerEpoch === this.ownerEpoch &&
          request.ordinal > client.ordinal,
        'Obsolete or duplicate request.'
      );
      client.ordinal = request.ordinal;
      const key = client.clientEpoch;
      const fields = request.fields || {};
      let data;

      if (request.action === 'dispose') {
        this._revoke(client, 'MTP_IPC_DISPOSED');
        data = null;
      } else if (request.action === 'begin') {
        this.transport.begin(key, fields.streamId, fields);
        data = null;
      } else if (request.action === 'chunk') {
        this.transport.append(key, fields.streamId, fields);
        data = null;
      } else if (request.action === 'commit') {
        requireValue(this.activeJobs.size < 33, 'IPC job capacity exhausted.');
        const manifest = this.transport.commit(key, fields.streamId);

        requireValue(
          manifest && typeof manifest.operation === 'string',
          'Malformed operation manifest.'
        );
        validateMtpOperation(manifest.operation, manifest.args, null);
        requireValue(
          !manifest.args.fileList || manifest.args.fileList.length <= 50000,
          'Manifest path limit exceeded.'
        );
        this.operationSequence += 1;
        const id = `${this.ownerEpoch}:job:${this.operationSequence}`;
        const job = {
          client: key,
          done: false,
          scope: manifest.scope,
          operation: manifest.operation,
          id,
          detached: false,
        };

        this.activeJobs.set(id, job);
        this.service
          .request(key, manifest.operation, manifest.args, manifest.scope, id)
          .then((value) => {
            if (!job.detached) {
              const scope = [
                'initialize',
                'dispose',
                'selectBackend',
                'selectStorage',
                'listStorages',
                'fetchDebugReport',
              ].includes(manifest.operation)
                ? this.service.scope()
                : job.scope;

              job.result = this.transport.result(key, `${id}:result`, id, {
                value,
                scope,
              });
            }

            return null;
          })
          .catch((error) => {
            job.error = {
              code: error.code || 'MTP_BACKEND_ERROR',
              message: error.message || String(error),
            };
          })
          .finally(() => {
            job.done = true;
            job.expires = Date.now() + 60000;
            if (job.detached) this.activeJobs.delete(id);
          })
          .catch((error) => {
            job.error = { code: 'MTP_IPC_DELIVERY', message: error.message };
            job.done = true;
          });
        data = { operationId: id };
      } else if (request.action === 'poll') {
        const job = this.activeJobs.get(fields.operationId);

        requireValue(job && job.client === key, 'Unknown operation.');
        const nativeJob = [...this.service.jobs.values()].find(
          (item) => item.correlation === job.id
        );
        const events = nativeJob ? nativeJob.events.splice(0, 1) : [];

        if (job.operation === 'transferFiles' && job.done && !nativeJob) {
          job.error = {
            code: 'MTP_IPC_EXPIRED',
            message: 'Transfer notification state expired before delivery.',
          };
        }

        if (nativeJob?.deliveryError)
          job.error = {
            code: 'MTP_IPC_DELIVERY',
            message: nativeJob.deliveryError,
          };
        data = {
          operationId: job.id,
          events,
          done: job.done && (!nativeJob || nativeJob.events.length === 0),
          result: job.result || null,
          error: job.error || null,
          state: this.service.snapshot(),
          stateSequence: this.service.stateSequence,
        };
        if (data.done) {
          this.service.releaseDelivery(job.id);
          this.activeJobs.delete(job.id);
        }
      } else if (request.action === 'pull') {
        data = this.transport.pull(
          key,
          fields.streamId,
          fields.operationId,
          fields.sequence
        );
      } else if (request.action === 'state') {
        data = this.service.snapshot();
      } else {
        throw mtpIpcError('MTP_IPC_INVALID', 'Unknown active protocol action.');
      }

      this.activeJobs.forEach((job, id) => {
        if (job.done && job.expires <= Date.now()) this.activeJobs.delete(id);
      });

      return reply({ ok: true, data });
    } catch (error) {
      return reply({
        ok: false,
        error: {
          code: error.code || 'MTP_IPC_INVALID',
          message: String(error.message || error).slice(0, 2048),
        },
      });
    }
  }
}

export default MtpSessionIpc;
