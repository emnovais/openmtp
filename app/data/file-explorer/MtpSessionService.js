import { createTransferResult } from './transferResult';
import { MtpSessionOwner } from './MtpSessionOwner';
import {
  MTP_LIMITS,
  plainResult,
  transportError,
  wireData,
} from './MtpSessionTransport';

const failure = (value) => value?.error || value?.stderr;
const ok = (data) => ({ error: null, stderr: null, data });
const boundedText = (value, limit) =>
  typeof value === 'string' ? value.slice(0, limit) : null;
const selectedStorage = (storages) => {
  const keys = Object.keys(storages || {});
  const id = keys.find((key) => storages[key].selected) || keys[0];

  return id === undefined ? null : Number(id);
};

export class MtpSessionService {
  constructor({
    queue,
    ownerEpoch,
    backendFactory,
    initialBackend = 'kalam',
    onState = () => {},
  }) {
    if (!['kalam', 'legacy'].includes(initialBackend))
      throw new Error('Unsupported initial backend.');
    this.queue = queue;
    this.backendFactory = backendFactory;
    this.selectedBackend = initialBackend;
    this.onState = onState;
    this.owner = new MtpSessionOwner({ queue, ownerEpoch });
    this.backend = null;
    this.active = null;
    this.pending = [];
    this.counter = 0;
    this.stateSequence = 0;
    this.jobs = new Map();
    this.closing = null;
    this.blocked = false;
    this.quarantine = null;
    this.shutdownPromise = null;
    this.connection = null;
    this.storages = null;
    this.resources = 'none';
    this.initializationFailure = null;
  }

  snapshot() {
    return {
      ...this.owner.getSnapshot(),
      executionEnabled: true,
      reason: this.quarantine || this.owner.getSnapshot().reason,
    };
  }

  publish() {
    this.stateSequence += 1;
    try {
      this.onState(this.snapshot());
    } catch (_) {
      // Delivery failure cannot end native ownership or change its outcome.
    }
  }

  scope() {
    const { ownerEpoch, generation, backend, storageId, storageRevision } =
      this.snapshot();

    return { ownerEpoch, generation, backend, storageId, storageRevision };
  }

  matches(scope, storageBound = true) {
    const current = this.scope();

    return (
      scope &&
      scope.ownerEpoch === current.ownerEpoch &&
      scope.generation === current.generation &&
      scope.backend === current.backend &&
      (!storageBound ||
        (scope.storageId === current.storageId &&
          scope.storageRevision === current.storageRevision))
    );
  }

  recordLifecycleEvidence(job, value) {
    // Only the main-process adapter receives this closure. Native JSON and IPC
    // arguments cannot supply acknowledgements through it. Current Kalam only
    // reports execution; a future verified adapter may acknowledge cleanup.
    if (job !== this.active || job.nativeStopped) return;
    try {
      const previous = job.lifecycleEvidence;
      const evidence = {
        version: value?.version,
        terminal: value?.terminal,
        nativeStarted: value?.nativeStarted,
        nativeReturned: value?.nativeReturned,
        resources: value?.resources,
        cleanupAcknowledged: value?.cleanupAcknowledged,
      };
      const valid =
        value?.version === 1 &&
        typeof value.terminal === 'boolean' &&
        typeof value.nativeStarted === 'boolean' &&
        typeof value.nativeReturned === 'boolean' &&
        typeof value.cleanupAcknowledged === 'boolean' &&
        ['none', 'closed', 'unknown'].includes(value.resources) &&
        (!value.nativeReturned || value.nativeStarted) &&
        (!value.cleanupAcknowledged ||
          (value.nativeReturned && value.resources === 'closed')) &&
        (value.resources !== 'closed' || value.cleanupAcknowledged) &&
        (value.resources !== 'none' ||
          !value.nativeStarted ||
          value.nativeReturned) &&
        (value.terminal ||
          (value.nativeStarted &&
            !value.nativeReturned &&
            value.resources === 'unknown' &&
            !value.cleanupAcknowledged)) &&
        (!previous ||
          ((!previous.nativeStarted || value.nativeStarted) &&
            (!previous.nativeReturned || value.nativeReturned) &&
            (!previous.cleanupAcknowledged || value.cleanupAcknowledged) &&
            (!previous.terminal ||
              JSON.stringify(previous) === JSON.stringify(evidence))));

      if (!valid) {
        Object.assign(job, { invalidLifecycleEvidence: true });

        return;
      }

      Object.assign(job, { lifecycleEvidence: evidence });
    } catch (_) {
      Object.assign(job, { invalidLifecycleEvidence: true });
    }
  }

  hooks() {
    const job = this.active;

    if (!job) throw new Error('Native operation outside an owner job.');
    const { lifecycle } = job;
    const context = lifecycle
      ? this.owner.createLifecycleContext(lifecycle)
      : this.owner.createContext({
          operation: job.operation,
          direction: job.args.direction,
          storageId: job.args.storageId,
        });
    const hooks = this.owner.executionHooks(context);

    return {
      ...hooks,
      onLifecycleEvidence: (value) => {
        if (lifecycle === 'initialize' || lifecycle === 'dispose')
          this.recordLifecycleEvidence(job, value);
      },
      beforeStart: () => {
        if (
          !lifecycle &&
          (!job.valid || !this.matches(job.scope, job.storageBound))
        )
          throw transportError(
            'Obsolete native admission.',
            'MTP_SESSION_STALE'
          );
        hooks.beforeStart();
      },
      afterStop: (outcome) => {
        hooks.afterStop(outcome);
        job.nativeStopped = true;
        if (outcome.status === 'rejected' || failure(outcome.value)) {
          this.invalidate('backend-error');
          // Initialization is classified after this queue slot has settled.
          // Other native failures may have disposed internally, so queued
          // cleanup must not assume that resource ownership is still known.
          if (
            lifecycle === 'dispose' ||
            (!lifecycle && this.selectedBackend === 'kalam')
          ) {
            this.resources = 'unknown';
            this.quarantine = 'Native lifecycle cleanup is uncertain.';
          }
        }
      },
    };
  }

  invalidate(reason) {
    const { state } = this.snapshot();

    if (state !== 'Disconnected') this.owner.invalidate({ reason });
    this.pending.forEach((job) => {
      if (!job.lifecycle || job.lifecycle === 'initialize')
        Object.assign(job, { valid: false });
    });
    this.publish();
  }

  revoke(client) {
    this.jobs.forEach((job) => {
      if (job.client === client)
        Object.assign(job, { deliveryLost: true, events: [] });
    });
    this.pending
      .filter((job) => job.client === client)
      .forEach((job) => {
        Object.assign(job, { valid: false });
      });
    if (
      this.active?.client === client ||
      this.snapshot().clientEpoch === client
    ) {
      this.invalidate('renderer-detached');
      // Detachment is not cancellation. Cleanup waits for the active job.
      this.close().catch(() => {});
    }
  }

  prunePending() {
    this.pending = this.pending.filter((job) => {
      if (job.valid) return true;
      const error = transportError(
        'Operation revoked before native admission.',
        'MTP_SESSION_STALE'
      );
      const { reject } = job;

      Object.assign(job, {
        done: true,
        finished: Date.now(),
        error: plainResult(error),
        outcome: { error: plainResult(error), unstarted: true },
        args: {},
        promise: null,
        resolve: null,
        reject: null,
        events: [],
      });
      reject(error);

      return false;
    });
  }

  enqueue(
    client,
    operation,
    args,
    scope,
    lifecycle = null,
    correlation = null
  ) {
    if (this.quarantine)
      return Promise.reject(
        transportError(this.quarantine, 'MTP_SESSION_QUARANTINED')
      );
    if (!lifecycle && this.blocked)
      return Promise.reject(
        transportError('MTP admissions are closed.', 'MTP_SESSION_CLOSING')
      );
    this.prunePending();
    if (this.pending.length >= MTP_LIMITS.pending)
      return Promise.reject(
        transportError('MTP queue capacity exhausted.', 'MTP_QUEUE_FULL')
      );
    this.counter += 1;
    const job = {
      id: `${this.owner.getSnapshot().ownerEpoch}:${this.counter}`,
      client,
      operation,
      args,
      scope,
      lifecycle,
      correlation,
      storageBound: !['listStorages', 'fetchDeviceInfo'].includes(operation),
      valid: true,
      events: [],
      deliveryError: null,
      done: false,
    };

    this.jobs.set(job.id, job);
    const promise = new Promise((resolve, reject) => {
      Object.assign(job, { resolve, reject });
    });

    job.promise = promise;
    this.pending.push(job);
    this.drain();

    return Object.assign(promise, { operationId: job.id });
  }

  drain() {
    if (this.active || this.pending.length === 0) return;
    const job = this.pending.shift();

    this.active = job;
    Promise.resolve()
      .then(async () => {
        if (
          !job.valid ||
          (!job.lifecycle &&
            (!this.matches(job.scope, job.storageBound) ||
              this.snapshot().state !== 'Ready'))
        )
          throw transportError('Obsolete MTP job.', 'MTP_SESSION_STALE');
        if (job.operation === '__connect') return this.connectJob(job);
        if (job.operation === '__close') return this.closeJob();
        if (job.operation === '__diagnostic') return this.diagnosticJob();
        const notify = (type, data) => {
          if (!job.valid || job.deliveryLost) return;
          try {
            const value = wireData({ type, data: plainResult(data) });

            // These callbacks describe UI progress, not per-file outcomes.
            // Retain the latest update of each kind until the next poll.
            if (type === 'progress' || type === 'preprocess') {
              const index = job.events.findIndex(
                (event) => event.type === type
              );

              if (index >= 0) job.events.splice(index, 1);
            }

            if (
              job.events.reduce(
                (bytes, event) =>
                  bytes + Buffer.byteLength(JSON.stringify(event), 'utf8'),
                0
              ) +
                Buffer.byteLength(JSON.stringify(value), 'utf8') >
              512 * 1024
            )
              throw new Error('Notification byte capacity exceeded.');
            if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 64 * 1024)
              throw new Error('Notification exceeds delivery limit.');
            if (job.events.length >= 128)
              throw new Error('Notification delivery capacity exceeded.');
            job.events.push(value);
          } catch (error) {
            job.deliveryError = error.message;
          }
        };
        const value = await this.backend[job.operation]({
          ...job.args,
          deviceType: 'mtp',
          onPreprocess: (data) => notify('preprocess', data),
          onProgress: (data) => notify('progress', data),
          onCompleted: () => {},
          onError: () => {},
        });

        if (job.operation === 'listStorages' && !failure(value)) {
          this.storages = value.data;
          if (
            this.snapshot().storageId === null &&
            Object.keys(this.storages || {}).length
          )
            this.owner.selectStorage(selectedStorage(this.storages));
        }

        if (
          job.operation === 'listFiles' &&
          Array.isArray(value?.data) &&
          value.data.length > MTP_LIMITS.records
        )
          throw transportError('Directory record limit exceeded.');
        if (
          ['renameFile', 'deleteFiles', 'makeDirectory'].includes(
            job.operation
          ) &&
          !failure(value) &&
          value?.data !== true
        ) {
          throw transportError(
            'Mutation returned without an acknowledgement.',
            'MTP_OUTCOME_UNKNOWN'
          );
        }

        if (job.operation === 'filesExist' && typeof value !== 'boolean')
          throw transportError(
            value?.error?.message ||
              value?.error ||
              'Existence check is uncertain.',
            'MTP_EXISTENCE_UNKNOWN'
          );

        return job.operation === 'transferFiles'
          ? createTransferResult(value)
          : value;
      })
      .then(
        (value) => {
          job.value = plainResult(value);
          job.resolve(job.value);

          return null;
        },
        (error) => {
          job.error = plainResult(error);
          job.reject(error);

          return null;
        }
      )
      .finally(() => {
        job.outcome = job.value?.status
          ? {
              status: job.value.status,
              backend: job.value.backend,
              direction: job.value.direction,
              backendStopped: job.value.backendStopped,
              evidence: {
                nativeAcknowledged:
                  job.value.evidence?.nativeAcknowledged ?? null,
                exitCode: job.value.evidence?.exitCode ?? null,
                signal: job.value.evidence?.signal ?? null,
                cancellationAcknowledged:
                  job.value.evidence?.cancellationAcknowledged ?? null,
              },
              error: job.value.error
                ? String(job.value.error).slice(0, 2048)
                : null,
              reason: job.value.reason
                ? String(job.value.reason).slice(0, 2048)
                : null,
              requestedCount: job.value.files?.requested?.length || 0,
            }
          : {
              error: job.error || null,
              ...(job.initializationFailure
                ? { initializationFailure: job.initializationFailure }
                : {}),
            };
        job.value = null;
        job.promise = null;
        job.resolve = null;
        job.reject = null;
        job.args = {};
        job.done = true;
        job.finished = Date.now();
        this.active = null;
        this.publish();
        this.drain();
        // Retain only a bounded terminal ledger; active jobs are never evicted.
        const completed = [...this.jobs.values()].filter(
          (item) =>
            item.done &&
            (!item.correlation || item.deliveryFinished || item.deliveryLost)
        );

        completed
          .slice(0, Math.max(0, completed.length - 32))
          .forEach((item) => this.jobs.delete(item.id));
      })
      .catch((error) => {
        this.quarantine = `Owner settlement failure: ${error.message}`;
        this.blocked = true;
      });
  }

  async connectJob(job) {
    if (this.quarantine || !['none', 'closed'].includes(this.resources)) {
      this.quarantine ||= 'Earlier native resource ownership is unresolved.';
      throw transportError(this.quarantine, 'MTP_SESSION_QUARANTINED');
    }

    Object.assign(job, { priorResources: this.resources });
    this.owner.beginConnection({
      backend: this.selectedBackend,
      clientEpoch: job.client,
    });
    this.publish();
    this.resources = 'unknown';
    let value;

    try {
      if (!this.backend)
        this.backend = this.backendFactory(this.selectedBackend, () =>
          this.hooks()
        );
      value =
        this.selectedBackend === 'kalam'
          ? await this.backend.initialize()
          : await this.backend.listStorages();
    } catch (error) {
      throw this.connectionFailure(job, value, error);
    }

    if (
      !failure(value) &&
      value?.data &&
      job.lifecycleEvidence &&
      (!job.lifecycleEvidence.terminal ||
        !job.lifecycleEvidence.nativeReturned ||
        job.lifecycleEvidence.resources !== 'unknown')
    )
      Object.assign(job, { invalidLifecycleEvidence: true });
    if (failure(value) || !value?.data || job.invalidLifecycleEvidence)
      throw this.connectionFailure(job, value);

    this.resources = 'owned';
    if (this.snapshot().state !== 'Connecting')
      throw transportError(
        'Connection acknowledgement is stale; cleanup remains queued.',
        'MTP_SESSION_STALE'
      );
    if (this.selectedBackend === 'legacy') this.storages = value.data;
    this.owner.markReady({
      generation: this.snapshot().generation,
      identityEvidence: this.selectedBackend === 'kalam' ? value.data : null,
      storageId:
        this.selectedBackend === 'legacy' ? selectedStorage(value.data) : null,
    });
    this.publish();

    return this.selectedBackend === 'kalam' ? value : ok(null);
  }

  connectionFailure(job, value, error) {
    // A constructor may itself load native code. Absence of an initialize()
    // call is insufficient; require evidence from the adapter boundary.
    const evidence = job.lifecycleEvidence;
    const safe =
      !this.quarantine &&
      !this.queue.active &&
      !this.queue.fault &&
      !this.snapshot().activeOperationId &&
      ['none', 'closed'].includes(job.priorResources) &&
      !job.invalidLifecycleEvidence &&
      evidence?.terminal === true &&
      (evidence.resources === 'none' ||
        (evidence.resources === 'closed' &&
          evidence.cleanupAcknowledged === true &&
          evidence.nativeReturned === true));
    const details = {
      errorType:
        boundedText(value?.stderr, 128) ||
        boundedText(error?.code, 128) ||
        'MTP_BACKEND_ERROR',
      message:
        boundedText(value?.error, 2048) ||
        boundedText(value?.error?.message, 2048) ||
        boundedText(error?.message, 2048) ||
        'Initialization returned without a valid device result.',
      nativeStarted: evidence?.nativeStarted ?? null,
      nativeReturned: evidence?.nativeReturned ?? null,
      cleanupAcknowledged:
        !job.invalidLifecycleEvidence && evidence?.cleanupAcknowledged === true,
      resources: safe ? evidence.resources : 'unknown',
      evidenceValid: !!evidence && !job.invalidLifecycleEvidence,
    };

    this.initializationFailure = details;
    Object.assign(job, { initializationFailure: details });
    if (!safe)
      this.quarantine = 'Connection did not establish a safe native lifecycle.';
    this.invalidate('connection-failed');
    if (safe) {
      this.resources = evidence.resources;
      this.owner.beginClosing();
      this.owner.completeClosing({
        generation: this.snapshot().generation,
        resourcesClosed: true,
      });
      this.storages = null;
      this.publish();
    }

    // Keep the existing code/message error contract. IPC currently transmits
    // only those fields, so the bounded plain evidence travels in the message.
    return transportError(
      `MTP connection failed; ${
        safe
          ? 'no unresolved native resources.'
          : 'restart required before reconnecting.'
      } Initialization evidence: ${JSON.stringify(details)}`,
      'MTP_CONNECT_FAILED'
    );
  }

  async ensureConnected(client) {
    if (this.closing) await this.closing;
    if (this.snapshot().state === 'Ready')
      return ok(this.snapshot().identityEvidence);
    if (this.connection) return this.connection;
    if (this.snapshot().state !== 'Disconnected')
      throw transportError('MTP session is not ready.', 'MTP_SESSION_INVALID');
    this.connection = this.enqueue(client, '__connect', {}, null, 'initialize');
    try {
      return await this.connection;
    } finally {
      this.connection = null;
    }
  }

  async closeJob() {
    const state = this.snapshot();

    this.assertCleanupSafe();
    if (state.state === 'Disconnected') return ok(true);
    this.owner.beginClosing();
    if (
      this.selectedBackend === 'kalam' &&
      this.backend &&
      this.resources === 'owned'
    ) {
      // Admission may predate an initialization failure or invalidation.
      // Recheck immediately before touching the native instance.
      this.assertCleanupSafe();
      const value = await this.backend.dispose();

      if (
        failure(value) ||
        value?.data !== true ||
        this.quarantine ||
        this.active.invalidLifecycleEvidence ||
        (this.active.lifecycleEvidence &&
          !this.active.lifecycleEvidence.nativeReturned)
      ) {
        this.resources = 'unknown';
        this.quarantine = 'Native cleanup was not acknowledged.';
        throw transportError(this.quarantine, 'MTP_SESSION_QUARANTINED');
      }
    }

    this.owner.completeClosing({
      generation: state.generation,
      resourcesClosed: true,
    });
    this.storages = null;
    this.resources = 'closed';

    return ok(true);
  }

  assertCleanupSafe() {
    if (
      this.queue.active ||
      this.queue.fault ||
      this.snapshot().activeOperationId ||
      this.resources === 'unknown'
    )
      this.quarantine ||=
        'Native execution or resource ownership is unresolved.';
    if (this.quarantine)
      throw transportError(this.quarantine, 'MTP_SESSION_QUARANTINED');
  }

  close() {
    if (this.closing) return this.closing;
    this.blocked = true;
    if (this.snapshot().state !== 'Disconnected') this.invalidate('closing');
    this.closing = this.enqueue('owner', '__close', {}, null, 'dispose');
    this.closing = this.closing.finally(() => {
      this.closing = null;
      if (!this.shutdownPromise) this.blocked = false;
    });

    return this.closing;
  }

  async diagnosticJob() {
    // Keep one logical job across cleanup and diagnostic process closure.
    await this.closeJob();
    this.owner.beginConnection({
      backend: this.selectedBackend,
      clientEpoch: 'diagnostic',
    });
    this.owner.beginClosing();
    this.active.lifecycle = 'fetchDebugReport';
    if (!this.backend)
      this.backend = this.backendFactory(this.selectedBackend, () =>
        this.hooks()
      );
    try {
      return await this.backend.fetchDebugReport();
    } finally {
      if (this.snapshot().state === 'Invalidated') this.owner.beginClosing();
      this.owner.completeClosing({
        generation: this.snapshot().generation,
        resourcesClosed: true,
      });
    }
  }

  async request(client, operation, args, expected, correlation = null) {
    if (this.blocked && operation !== 'dispose')
      throw transportError(
        'Owner transition already in progress.',
        'MTP_SESSION_CLOSING'
      );
    if (
      expected &&
      !this.matches(expected, false) &&
      !(operation === 'initialize' && this.connection)
    ) {
      throw transportError('Obsolete lifecycle request.', 'MTP_SESSION_STALE');
    }

    if (operation === 'selectBackend') {
      if (args.backend === this.selectedBackend) return ok(true);
      await this.close();
      this.selectedBackend = args.backend;
      this.backend = null;
      this.publish();

      return ok(true);
    }

    if (operation === 'dispose') return this.close();
    if (operation === 'fetchDebugReport') {
      this.blocked = true;
      this.invalidate('diagnostic');
      try {
        return await this.enqueue(client, '__diagnostic', {}, null, 'dispose');
      } finally {
        if (!this.shutdownPromise) this.blocked = false;
      }
    }

    if (operation === 'initialize') return this.ensureConnected(client);
    if (
      operation === 'listStorages' &&
      this.snapshot().state === 'Disconnected'
    ) {
      await this.ensureConnected(client);

      return this.request(client, operation, args, this.scope(), correlation);
    }

    if (operation === 'selectStorage') {
      if (
        !this.matches(expected, false) ||
        !this.storages ||
        !Object.prototype.hasOwnProperty.call(this.storages, args.storageId)
      )
        throw transportError(
          'Obsolete or unknown storage.',
          'MTP_SESSION_STALE'
        );
      this.owner.selectStorage(args.storageId);
      this.publish();

      return ok(true);
    }

    if (
      !this.matches(
        expected,
        !['listStorages', 'fetchDeviceInfo'].includes(operation)
      )
    )
      throw transportError('Obsolete request scope.', 'MTP_SESSION_STALE');

    return this.enqueue(
      client,
      operation,
      args,
      this.scope(),
      null,
      correlation
    );
  }

  releaseDelivery(correlation) {
    this.jobs.forEach((job) => {
      if (job.correlation === correlation)
        Object.assign(job, { deliveryFinished: true, events: [] });
    });
  }

  sweep() {
    this.jobs.forEach((job, id) => {
      if (job.done && Date.now() - job.finished >= 60000) this.jobs.delete(id);
    });
  }

  shutdown() {
    if (!this.shutdownPromise) this.shutdownPromise = this.close();

    return this.shutdownPromise;
  }
}
