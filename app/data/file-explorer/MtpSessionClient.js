import { v4 as uuidv4 } from 'uuid';
import {
  MTP_LIMITS,
  encodePayload,
  decodePages,
  wireData,
} from './MtpSessionTransport';
import {
  MTP_SESSION_CHANNELS,
  cloneMtpData,
  isMtpIdentifier,
  mtpIpcError,
  validateMtpOperation,
  validateMtpOwnerState,
} from './MtpSessionIpc';

// Explicitly constructed by a future renderer integration; no singleton,
// automatic handshake, repository routing, backend imports, or device access.
export class MtpSessionClient {
  constructor({
    ipcRenderer,
    version = 1,
    createId = uuidv4,
    onCallbackError = () => {},
    lifecycleTarget = typeof window === 'undefined' ? null : window,
  }) {
    this.ipcRenderer = ipcRenderer;
    this.version = version;
    this.ordinal = 0;
    this.stateSequence = -1;
    this.activePending = 0;
    this.createId = createId;
    this.onCallbackError = onCallbackError;
    this.rendererId = createId();
    if (!isMtpIdentifier(this.rendererId))
      throw mtpIpcError('MTP_IPC_INVALID', 'Invalid renderer identifier.');

    this.clientEpoch = null;
    this.ownerEpoch = null;
    this.disposed = false;
    this._pending = new Map();
    this._usedIds = new Set();
    this._listeners = new Set();
    this._state = null;
    this._handshake = null;
    this._subscriptionId = null;
    this._sequence = 0;
    this._earlyState = null;
    this._earlyRevocations = new Map();
    this._onEvent = (_, payload) => this._handleEvent(payload);
    this._unload = () => this.dispose();
    this._lifecycleTarget = lifecycleTarget;
    ipcRenderer.on(MTP_SESSION_CHANNELS.event, this._onEvent);
    lifecycleTarget?.addEventListener('unload', this._unload);
  }

  _newId() {
    const requestId = this.createId();

    if (!isMtpIdentifier(requestId) || this._usedIds.has(requestId)) {
      throw mtpIpcError(
        'MTP_IPC_DUPLICATE',
        'Invalid or reused request identifier.'
      );
    }

    this._usedIds.add(requestId);

    return requestId;
  }

  _notify(callback, value) {
    if (!callback) return;

    try {
      callback(cloneMtpData(value));
    } catch (error) {
      try {
        this.onCallbackError(error);
      } catch (_) {
        /* Consumer errors cannot alter IPC settlement. */
      }
    }
  }

  _finish(requestId, result) {
    const pending = this._pending.get(requestId);

    if (!pending) return;

    this._pending.delete(requestId);
    if (pending.action === 'request') this._notify(pending.onTerminal, result);
    if (result.ok) pending.resolve(result.data);
    else pending.reject(mtpIpcError(result.error.code, result.error.message));
  }

  _validateResult(result) {
    if (
      !result ||
      typeof result.ok !== 'boolean' ||
      (result.ok && !Object.prototype.hasOwnProperty.call(result, 'data')) ||
      (!result.ok &&
        (!isMtpIdentifier(result.error?.code) ||
          typeof result.error?.message !== 'string'))
    ) {
      throw mtpIpcError('MTP_IPC_BAD_REPLY', 'Malformed MTP IPC outcome.');
    }
  }

  _handleReply(requestId, payload) {
    const pending = this._pending.get(requestId);

    // A reply to an abandoned handshake may still have created a main-process
    // subscription. Release that lifetime without resurrecting this client.
    if (!pending) {
      if (
        this.disposed &&
        payload?.ok &&
        payload.requestId === this._subscriptionId &&
        payload.rendererId === this.rendererId
      ) {
        this._release(payload.ownerEpoch, payload.clientEpoch);
      }

      return;
    }

    try {
      const reply = cloneMtpData(payload);

      if (
        reply.version !== 1 ||
        reply.type !== 'terminal' ||
        reply.requestId !== requestId ||
        reply.rendererId !== this.rendererId
      ) {
        throw mtpIpcError(
          'MTP_IPC_BAD_REPLY',
          'MTP IPC reply correlation mismatch.'
        );
      }

      this._validateResult(reply);
      if (pending.action === 'handshake') {
        if (reply.ok) {
          if (
            !isMtpIdentifier(reply.ownerEpoch) ||
            !isMtpIdentifier(reply.clientEpoch) ||
            reply.data?.ownerEpoch !== reply.ownerEpoch ||
            reply.data.executionEnabled !== false
          ) {
            throw mtpIpcError(
              'MTP_IPC_BAD_REPLY',
              'Invalid passive-owner handshake.'
            );
          }

          validateMtpOwnerState(reply.data);
          this.ownerEpoch = reply.ownerEpoch;
          this.clientEpoch = reply.clientEpoch;
          const revoked = this._earlyRevocations.get(
            JSON.stringify([reply.ownerEpoch, reply.clientEpoch])
          );

          this._earlyRevocations.clear();
          if (revoked) {
            this.dispose(false, revoked);

            return;
          }

          this._state = reply.data;
          if (this._earlyState) {
            const early = this._earlyState;

            this._earlyState = null;
            this._handleEvent(early);
          }
        }
      } else if (
        reply.ownerEpoch !== this.ownerEpoch ||
        reply.clientEpoch !== this.clientEpoch
      ) {
        throw mtpIpcError(
          'MTP_IPC_BAD_REPLY',
          'Obsolete MTP IPC reply lifetime.'
        );
      }

      this._finish(requestId, reply);
      if (pending.action === 'handshake' && reply.ok)
        this._listeners.forEach((callback) =>
          this._notify(callback, this._state)
        );
    } catch (error) {
      if (
        pending.action === 'handshake' &&
        payload?.requestId === requestId &&
        payload.rendererId === this.rendererId
      ) {
        this._release(payload.ownerEpoch, payload.clientEpoch);
      }

      this._finish(requestId, {
        ok: false,
        error: {
          code: error.code || 'MTP_IPC_BAD_REPLY',
          message: error.message,
        },
      });
    }
  }

  _send(action, fields = {}, callbacks = {}) {
    if (this.disposed)
      return Promise.reject(
        mtpIpcError('MTP_IPC_DISPOSED', 'MTP IPC client is disposed.')
      );

    let request;

    try {
      request = cloneMtpData({
        version: 1,
        action,
        requestId: this._newId(),
        rendererId: this.rendererId,
        ...(action === 'handshake'
          ? {}
          : { ownerEpoch: this.ownerEpoch, clientEpoch: this.clientEpoch }),
        ...fields,
      });
    } catch (error) {
      return Promise.reject(error);
    }

    if (action === 'handshake') this._subscriptionId = request.requestId;

    return new Promise((resolve, reject) => {
      this._pending.set(request.requestId, {
        action,
        resolve,
        reject,
        ...callbacks,
      });
      try {
        Promise.resolve(
          this.ipcRenderer.invoke(MTP_SESSION_CHANNELS.request, request)
        )
          .then((reply) => this._handleReply(request.requestId, reply))
          .catch(() =>
            this._finish(request.requestId, {
              ok: false,
              error: {
                code: 'MTP_IPC_TRANSPORT',
                message: 'MTP IPC transport failed.',
              },
            })
          );
      } catch (_) {
        this._finish(request.requestId, {
          ok: false,
          error: {
            code: 'MTP_IPC_TRANSPORT',
            message: 'MTP IPC transport failed.',
          },
        });
      }
    });
  }

  acceptActiveState(state, sequence) {
    validateMtpOwnerState(state);
    if (
      !Number.isSafeInteger(sequence) ||
      sequence < this.stateSequence ||
      state.ownerEpoch !== this.ownerEpoch
    )
      return;
    this.stateSequence = sequence;
    this._state = state;
    this._listeners.forEach((callback) => this._notify(callback, this._state));
  }

  async activeRpc(action, fields = {}) {
    if (this.disposed && action !== 'dispose')
      throw mtpIpcError('MTP_IPC_DISPOSED', 'Client disposed.');
    if (this.activePending >= 40)
      throw mtpIpcError('MTP_IPC_CAPACITY', 'Client admission limit exceeded.');
    this.ordinal += 1;
    const requestId = `${this.rendererId}:${this.ordinal}`;
    const request = wireData({
      version: 2,
      action,
      requestId,
      rendererId: this.rendererId,
      ordinal: this.ordinal,
      ownerEpoch: this.ownerEpoch,
      clientEpoch: this.clientEpoch,
      fields,
    });

    this.activePending += 1;
    try {
      const reply = wireData(
        await this.ipcRenderer.invoke(MTP_SESSION_CHANNELS.request, request)
      );

      if (
        reply.version !== 2 ||
        reply.type !== 'terminal' ||
        reply.requestId !== requestId ||
        reply.rendererId !== this.rendererId ||
        (action !== 'handshake' &&
          (reply.ownerEpoch !== this.ownerEpoch ||
            reply.clientEpoch !== this.clientEpoch))
      )
        throw mtpIpcError(
          'MTP_IPC_BAD_REPLY',
          'Active reply correlation mismatch.'
        );
      this._validateResult(reply);
      if (!reply.ok) throw mtpIpcError(reply.error.code, reply.error.message);
      if (action === 'handshake') {
        validateMtpOwnerState(reply.data);
        if (
          reply.data.executionEnabled !== true ||
          reply.data.ownerEpoch !== reply.ownerEpoch ||
          !isMtpIdentifier(reply.clientEpoch)
        )
          throw mtpIpcError('MTP_IPC_BAD_REPLY', 'Invalid active handshake.');
        this.ownerEpoch = reply.ownerEpoch;
        this.clientEpoch = reply.clientEpoch;
        this.acceptActiveState(reply.data, reply.stateSequence);
      }

      if (this.disposed && action === 'handshake')
        this._release(this.ownerEpoch, this.clientEpoch);
      if (this.disposed && action !== 'dispose')
        throw mtpIpcError('MTP_IPC_DISPOSED', 'Client lifetime ended.');

      return reply.data;
    } finally {
      this.activePending -= 1;
    }
  }

  async activeRequest(
    operation,
    args,
    scope,
    { onProgress, onPreprocess } = {}
  ) {
    const encoded = encodePayload(
      { operation, args, scope },
      MTP_LIMITS.manifestBytes
    );
    const streamId = `${this.rendererId}:stream:${this.ordinal + 1}`;

    await this.activeRpc('begin', {
      streamId,
      bytes: encoded.bytes,
      count: encoded.count,
    });
    for (let sequence = 0; sequence < encoded.count; sequence += 1) {
      // One acknowledged request/page at a time; no unbounded Electron backlog.
      // eslint-disable-next-line no-await-in-loop
      await this.activeRpc('chunk', {
        streamId,
        sequence,
        chunk: encoded.chunks[sequence],
        final: sequence === encoded.count - 1,
      });
    }

    const { operationId } = await this.activeRpc('commit', { streamId });
    let terminal;

    do {
      // eslint-disable-next-line no-await-in-loop
      terminal = await this.activeRpc('poll', { operationId });
      if (terminal.operationId !== operationId)
        throw mtpIpcError(
          'MTP_IPC_BAD_REPLY',
          'Operation correlation mismatch.'
        );
      validateMtpOwnerState(terminal.state);
      this.acceptActiveState(terminal.state, terminal.stateSequence);
      terminal.events.forEach(({ type, data }) =>
        this._notify(type === 'preprocess' ? onPreprocess : onProgress, data)
      );
      if (!terminal.done) {
        // Polling bounds callback delivery, without timing out native work.
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } while (!terminal.done);

    if (terminal.error)
      throw mtpIpcError(terminal.error.code, terminal.error.message);
    const descriptor = terminal.result;

    if (
      !descriptor ||
      descriptor.operationId !== operationId ||
      descriptor.bytes > MTP_LIMITS.resultBytes ||
      descriptor.count !== Math.ceil(descriptor.bytes / MTP_LIMITS.chunkBytes)
    )
      throw mtpIpcError(
        'MTP_IPC_BAD_REPLY',
        'Missing or invalid terminal result.'
      );
    const pages = [];

    for (let sequence = 0; sequence < descriptor.count; sequence += 1) {
      // eslint-disable-next-line no-await-in-loop
      pages.push(
        // eslint-disable-next-line no-await-in-loop
        await this.activeRpc('pull', {
          streamId: descriptor.streamId,
          operationId,
          sequence,
        })
      );
    }

    return decodePages(descriptor, pages);
  }

  connect() {
    if (this.version === 2) {
      if (!this._handshake) this._handshake = this.activeRpc('handshake');

      return this._handshake;
    }

    if (this.disposed)
      return Promise.reject(
        mtpIpcError('MTP_IPC_DISPOSED', 'MTP IPC client is disposed.')
      );
    if (!this._handshake) this._handshake = this._send('handshake');

    return this._handshake;
  }

  request(
    operation,
    args = {},
    context = null,
    { onProgress, onTerminal } = {}
  ) {
    if (this.disposed)
      return Promise.reject(
        mtpIpcError('MTP_IPC_DISPOSED', 'MTP IPC client is disposed.')
      );
    if (!this.clientEpoch)
      return Promise.reject(
        mtpIpcError(
          'MTP_IPC_NOT_CONNECTED',
          'Complete the MTP IPC handshake first.'
        )
      );

    try {
      const data = cloneMtpData({ args, context });

      validateMtpOperation(operation, data.args, data.context);
      if (
        (onProgress !== undefined && typeof onProgress !== 'function') ||
        (onTerminal !== undefined && typeof onTerminal !== 'function')
      ) {
        throw mtpIpcError(
          'MTP_IPC_INVALID',
          'IPC notification handlers must be functions.'
        );
      }

      return this._send(
        'request',
        { operation, ...data },
        { onProgress, onTerminal }
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }

  subscribeOwnerState(callback) {
    if (this.disposed || typeof callback !== 'function')
      throw mtpIpcError(
        'MTP_IPC_DISPOSED',
        'Owner-state subscription is unavailable.'
      );

    this._listeners.add(callback);
    if (this._state) this._notify(callback, this._state);

    return () => this._listeners.delete(callback);
  }

  _handleEvent(payload) {
    if (this.version === 2) {
      try {
        const event = wireData(payload);

        if (
          !this.disposed &&
          event.version === 2 &&
          event.type === 'owner-state' &&
          event.ownerEpoch === this.ownerEpoch &&
          event.clientEpoch === this.clientEpoch
        ) {
          validateMtpOwnerState(event.data);
          this.acceptActiveState(event.data, event.stateSequence);
        }
      } catch (_) {
        /* Invalid state events cannot authorize execution. */
      }

      return;
    }

    if (this.disposed) return;

    try {
      const event = cloneMtpData(payload);

      if (
        event.version !== 1 ||
        event.rendererId !== this.rendererId ||
        !isMtpIdentifier(event.ownerEpoch) ||
        !isMtpIdentifier(event.clientEpoch) ||
        !Number.isSafeInteger(event.sequence) ||
        event.sequence <= this._sequence
      )
        return;

      if (!this.clientEpoch) {
        if (
          event.requestId !== this._subscriptionId ||
          !this._pending.has(this._subscriptionId)
        )
          return;
        if (event.type === 'owner-state') {
          validateMtpOwnerState(event.data);
          if (!this._earlyState || event.sequence > this._earlyState.sequence)
            this._earlyState = event;
        } else if (
          event.type === 'client-disposed' &&
          isMtpIdentifier(event.data?.code) &&
          typeof event.data?.message === 'string'
        ) {
          this._earlyRevocations.set(
            JSON.stringify([event.ownerEpoch, event.clientEpoch]),
            event.data.code
          );
        }

        return;
      }

      if (
        event.ownerEpoch !== this.ownerEpoch ||
        event.clientEpoch !== this.clientEpoch
      )
        return;

      const pending = this._pending.get(event.requestId);

      if (['owner-state', 'client-disposed'].includes(event.type)) {
        if (event.requestId !== this._subscriptionId) return;

        if (event.type === 'client-disposed') {
          if (
            !isMtpIdentifier(event.data?.code) ||
            typeof event.data?.message !== 'string'
          )
            return;

          this._sequence = event.sequence;
          this.dispose(false, event.data.code);

          return;
        }

        if (
          event.data?.ownerEpoch !== this.ownerEpoch ||
          event.data.executionEnabled !== false
        )
          return;

        validateMtpOwnerState(event.data);
        this._sequence = event.sequence;
        this._state = event.data;
        this._listeners.forEach((callback) =>
          this._notify(callback, this._state)
        );

        return;
      }

      if (!pending || pending.action !== 'request') return;
      if (event.type === 'progress') {
        if (
          !event.data ||
          typeof event.data !== 'object' ||
          Array.isArray(event.data)
        )
          return;

        this._sequence = event.sequence;
        this._notify(pending.onProgress, event.data);
      } else if (event.type === 'terminal') {
        this._validateResult(event.data);
        this._sequence = event.sequence;
        this._finish(event.requestId, event.data);
      }
    } catch (_) {
      // Unsolicited malformed messages cannot settle a request or reach consumers.
    }
  }

  _release(ownerEpoch, clientEpoch) {
    if (this.version === 2) {
      if (ownerEpoch && clientEpoch) this.activeRpc('dispose').catch(() => {});

      return;
    }

    if (!isMtpIdentifier(ownerEpoch) || !isMtpIdentifier(clientEpoch)) return;

    try {
      Promise.resolve(
        this.ipcRenderer.invoke(MTP_SESSION_CHANNELS.request, {
          version: 1,
          action: 'dispose',
          requestId: this._newId(),
          rendererId: this.rendererId,
          ownerEpoch,
          clientEpoch,
        })
      ).catch(() => {});
    } catch (_) {
      /* Local cleanup cannot depend on a live main process. */
    }
  }

  dispose(notifyMain = true, code = 'MTP_IPC_DISPOSED') {
    if (this.disposed) return;

    this.disposed = true;
    this.ipcRenderer.removeListener(MTP_SESSION_CHANNELS.event, this._onEvent);
    this._lifecycleTarget?.removeEventListener('unload', this._unload);
    this._listeners.clear();
    this._earlyState = null;
    this._earlyRevocations.clear();
    Array.from(this._pending.keys()).forEach((requestId) =>
      this._finish(requestId, {
        ok: false,
        error: { code, message: 'MTP IPC client lifetime ended.' },
      })
    );
    if (notifyMain) this._release(this.ownerEpoch, this.clientEpoch);
  }
}

export default MtpSessionClient;
