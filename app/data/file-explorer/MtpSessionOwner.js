// B1 infrastructure only: no singleton, Electron, USB, FFI, CLI, or UI imports.
// B2 must supply the real owner epoch, execution queue, and terminal classifier.
export const MTP_SESSION_STATE = Object.freeze({
  Disconnected: 'Disconnected',
  Connecting: 'Connecting',
  Ready: 'Ready',
  Invalidated: 'Invalidated',
  Closing: 'Closing',
});

const reads = new Set([
  'fetchDeviceInfo',
  'listStorages',
  'listFiles',
  'filesExist',
]);
const mutations = new Set(['makeDirectory', 'renameFile', 'deleteFiles']);

export function getMtpOperationKind(operation, direction) {
  if (operation === 'transferFiles') {
    if (direction !== 'upload' && direction !== 'download') {
      throw new TypeError(
        'An MTP transfer requires upload or download direction.'
      );
    }

    // Downloads write to the local filesystem and cannot be replayed either.
    return 'mutation';
  }

  if (reads.has(operation)) return 'read';
  if (mutations.has(operation)) return 'mutation';

  throw new TypeError(`Unsupported MTP session operation: ${operation}`);
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a nonempty string.`);
  }
}

function requireStorageId(value) {
  if (
    value !== null &&
    (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff)
  ) {
    throw new TypeError(
      'storageId must be null or an unsigned 32-bit integer.'
    );
  }
}

function freezeEvidence(evidence) {
  if (evidence && typeof evidence === 'object') {
    Object.values(evidence).forEach(freezeEvidence);
    Object.freeze(evidence);
  }

  return evidence;
}

export class MtpSessionOwner {
  constructor({ queue, ownerEpoch, isSessionInvalidating = () => false }) {
    requireString(ownerEpoch, 'ownerEpoch');
    if (!queue || typeof queue.run !== 'function') {
      throw new TypeError('An MTP operation queue is required.');
    }

    if (typeof isSessionInvalidating !== 'function') {
      throw new TypeError('A synchronous terminal classifier is required.');
    }

    this._queue = queue;
    this._ownerEpoch = ownerEpoch;
    this._isSessionInvalidating = isSessionInvalidating;
    this._state = MTP_SESSION_STATE.Disconnected;
    this._generation = 0;
    this._sequence = 0;
    this._backend = null;
    this._clientEpoch = null;
    this._storageId = null;
    this._storageRevision = 0;
    this._identityEvidence = null;
    this._reason = null;
    this._activeContext = null;
    this._contexts = new WeakMap();
  }

  getSnapshot() {
    return Object.freeze({
      state: this._state,
      ownerEpoch: this._ownerEpoch,
      generation: this._generation,
      clientEpoch: this._clientEpoch,
      backend: this._backend,
      storageId: this._storageId,
      storageRevision: this._storageRevision,
      identityEvidence: this._identityEvidence,
      reason: this._reason,
      activeOperationId: this._activeContext?.operationId || null,
      queueFault: this._queue.fault?.code || null,
    });
  }

  _requireState(...states) {
    if (!states.includes(this._state)) {
      throw new Error(`Invalid MTP lifecycle transition from ${this._state}.`);
    }
  }

  _requireGeneration(generation) {
    if (generation !== this._generation) {
      throw new Error('Obsolete MTP lifecycle generation.');
    }
  }

  beginConnection({ backend, clientEpoch }) {
    this._requireState(MTP_SESSION_STATE.Disconnected);
    requireString(clientEpoch, 'clientEpoch');
    if (backend !== 'kalam' && backend !== 'legacy') {
      throw new TypeError('An MTP backend must be kalam or legacy.');
    }

    if (this._activeContext || this._queue.fault) {
      throw new Error('MTP execution has not safely ended.');
    }

    if (this._generation === Number.MAX_SAFE_INTEGER) {
      throw new Error('MTP generation space exhausted.');
    }

    // Allocate only here; invalidation never makes this generation usable again.
    this._generation += 1;
    this._backend = backend;
    this._clientEpoch = clientEpoch;
    this._reason = null;
    this._state = MTP_SESSION_STATE.Connecting;

    return this.getSnapshot();
  }

  // These transitions record acknowledgements supplied by a future adapter;
  // B1 itself performs no connection, disposal, or physical identity verification.
  markReady({ generation, identityEvidence = null, storageId = null }) {
    this._requireState(MTP_SESSION_STATE.Connecting);
    this._requireGeneration(generation);
    requireStorageId(storageId);
    if (this._queue.fault)
      throw new Error('MTP execution queue is quarantined.');
    if (
      identityEvidence !== null &&
      (typeof identityEvidence !== 'object' || Array.isArray(identityEvidence))
    ) {
      throw new TypeError('Identity evidence must be an object or null.');
    }

    const evidence =
      identityEvidence === null
        ? null
        : freezeEvidence(JSON.parse(JSON.stringify(identityEvidence)));

    this._setStorage(storageId);
    this._identityEvidence = evidence;
    this._state = MTP_SESSION_STATE.Ready;

    return this.getSnapshot();
  }

  selectStorage(storageId) {
    this._requireState(MTP_SESSION_STATE.Ready);
    requireStorageId(storageId);
    this._setStorage(storageId);

    return this.getSnapshot();
  }

  _setStorage(storageId) {
    if (storageId !== this._storageId) {
      if (this._storageRevision === Number.MAX_SAFE_INTEGER) {
        throw new Error('MTP storage revision space exhausted.');
      }

      this._storageRevision += 1;
      this._storageId = storageId;
    }
  }

  invalidate({
    generation = this._generation,
    reason = 'session-invalidated',
  } = {}) {
    this._requireGeneration(generation);
    this._requireState(
      MTP_SESSION_STATE.Connecting,
      MTP_SESSION_STATE.Ready,
      MTP_SESSION_STATE.Invalidated,
      MTP_SESSION_STATE.Closing
    );
    requireString(reason, 'reason');
    this._state = MTP_SESSION_STATE.Invalidated;
    this._reason = reason;

    // Keep the active context and its queue slot until actual execution ends.
    return this.getSnapshot();
  }

  requestBackendChange(backend) {
    this._requireState(MTP_SESSION_STATE.Ready, MTP_SESSION_STATE.Connecting);
    if (backend !== 'kalam' && backend !== 'legacy') {
      throw new TypeError('An MTP backend must be kalam or legacy.');
    }

    if (backend !== this._backend) {
      this.invalidate({ reason: 'backend-change' });
    }

    // The old backend stays pinned. Closing and a fresh connection are required
    // before the caller can select the requested backend; nothing is replayed.
    return this.getSnapshot();
  }

  beginClosing({ generation = this._generation } = {}) {
    this._requireGeneration(generation);
    this._requireState(
      MTP_SESSION_STATE.Ready,
      MTP_SESSION_STATE.Connecting,
      MTP_SESSION_STATE.Invalidated
    );
    this._state = MTP_SESSION_STATE.Closing;

    return this.getSnapshot();
  }

  completeClosing({ generation, resourcesClosed }) {
    this._requireState(MTP_SESSION_STATE.Closing);
    this._requireGeneration(generation);
    if (this._activeContext || resourcesClosed !== true) {
      throw new Error('MTP execution and resource closure must be confirmed.');
    }

    this._state = MTP_SESSION_STATE.Disconnected;
    this._backend = null;
    this._clientEpoch = null;
    this._storageId = null;
    this._identityEvidence = null;

    return this.getSnapshot();
  }

  createContext({ operation, direction, storageId = this._storageId }) {
    this._requireState(MTP_SESSION_STATE.Ready);
    const operationKind = getMtpOperationKind(operation, direction);
    const storageBound =
      operation !== 'fetchDeviceInfo' && operation !== 'listStorages';

    requireStorageId(storageId);
    if (storageBound && (storageId === null || storageId !== this._storageId)) {
      throw new Error('MTP operation requires the selected storage.');
    }

    if (this._sequence === Number.MAX_SAFE_INTEGER) {
      throw new Error('MTP operation identifier space exhausted.');
    }

    this._sequence += 1;
    const context = Object.freeze({
      ownerEpoch: this._ownerEpoch,
      generation: this._generation,
      clientEpoch: this._clientEpoch,
      operationId: `${this._ownerEpoch}:${this._sequence}`,
      backend: this._backend,
      storageId: storageBound ? storageId : null,
      storageRevision: this._storageRevision,
      operationKind,
    });

    this._contexts.set(context, { storageBound, submitted: false });

    return context;
  }

  // Main-only coordinator supplies lifecycle work; transport metadata never
  // enters this WeakMap. These leases still use the existing leaf queue.
  createLifecycleContext(operation) {
    if (!['initialize', 'dispose', 'fetchDebugReport'].includes(operation)) {
      throw new Error('Invalid lifecycle operation.');
    }

    const states =
      operation === 'initialize'
        ? [MTP_SESSION_STATE.Connecting]
        : [MTP_SESSION_STATE.Closing];

    this._requireState(...states);
    this._sequence += 1;
    const context = Object.freeze({
      ownerEpoch: this._ownerEpoch,
      generation: this._generation,
      clientEpoch: this._clientEpoch,
      operationId: `${this._ownerEpoch}:${this._sequence}`,
      backend: this._backend,
      storageId: null,
      storageRevision: this._storageRevision,
      operationKind: 'lifecycle',
    });

    this._contexts.set(context, {
      storageBound: false,
      submitted: false,
      states,
    });

    return context;
  }

  validateContext(context) {
    const record = this._contexts.get(context);

    if (
      !record ||
      record.stopped ||
      !(record.states || [MTP_SESSION_STATE.Ready]).includes(this._state) ||
      this._queue.fault ||
      context.ownerEpoch !== this._ownerEpoch ||
      context.generation !== this._generation ||
      context.clientEpoch !== this._clientEpoch ||
      context.backend !== this._backend ||
      (record.storageBound &&
        (context.storageId !== this._storageId ||
          context.storageRevision !== this._storageRevision))
    ) {
      const error = new Error('Obsolete or invalid MTP operation context.');

      error.code = 'MTP_SESSION_STALE';
      throw error;
    }

    return true;
  }

  _afterStop(outcome, context) {
    try {
      const invalidating = this._isSessionInvalidating(outcome, context);

      if (invalidating && typeof invalidating.then === 'function') {
        Promise.resolve(invalidating).catch(() => {});
        throw new TypeError('MTP terminal classification must be synchronous.');
      }

      if (typeof invalidating !== 'boolean') {
        throw new TypeError(
          'MTP terminal classification must return a boolean.'
        );
      }

      if (invalidating)
        this.invalidate({
          generation: context.generation,
          reason: 'terminal-outcome',
        });
    } catch (error) {
      this.invalidate({
        generation: context.generation,
        reason: 'settlement-hook-failure',
      });
      throw error;
    } finally {
      this._activeContext = null;
      this._contexts.get(context).stopped = true;
    }
  }

  // B2 can pass these hooks directly to the existing leaf queue.run call.
  // Creating hooks never acquires the lane; the context is single-use.
  executionHooks(context) {
    const record = this._contexts.get(context);

    if (!record || record.submitted) {
      throw new Error('MTP context must be submitted exactly once.');
    }

    record.submitted = true;

    return Object.freeze({
      context,
      beforeStart: () => {
        this.validateContext(context);
        if (this._activeContext)
          throw new Error('An MTP operation is already active.');

        this._activeContext = context;
      },
      afterStop: (outcome) => this._afterStop(outcome, context),
    });
  }

  // Convenience for raw, unqueued injected work only. Never wrap Kalam or
  // Legacy methods that already acquire this queue; use executionHooks there.
  run(context, operation) {
    if (typeof operation !== 'function') {
      return Promise.reject(
        new TypeError('An MTP operation function is required.')
      );
    }

    let hooks;

    try {
      hooks = this.executionHooks(context);
    } catch (error) {
      return Promise.reject(error);
    }

    return this._queue.run(operation, hooks);
  }
}

export default MtpSessionOwner;
