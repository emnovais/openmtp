// One lane for supported MTP execution paths in this owner/module graph.
// This is not an inter-process or cross-isolate lock. It neither cancels native
// work nor treats a timeout as termination. Tasks must settle only after actual
// native return/process closure, and must not await another task on this lane.
export class MtpOperationQueue {
  constructor() {
    this.pending = [];
    this.active = false;
    this._fault = null;
    this._inHook = false;
    this._hookViolation = null;
    this._draining = false;
  }

  get fault() {
    return this._fault;
  }

  // Hooks are synchronous internal fences, not another scheduling layer.
  // beforeStart(context) may throw or return false to reject an unstarted task.
  // afterStop(outcome, context) runs only after operation settlement and before
  // successor admission. A failure quarantines this lane, rejecting pending and
  // future tasks. There is deliberately no reset that could bypass uncertainty.
  // Thenables are rejected as unsupported (their rejections are observed).
  run(operation, { context, beforeStart, afterStop } = {}) {
    if (this._inHook) {
      this._hookViolation = new Error(
        'MTP hooks must not acquire their queue.'
      );
      throw this._hookViolation;
    }

    return new Promise((resolve, reject) => {
      if (this._fault) {
        reject(this._fault);

        return;
      }

      if (
        typeof operation !== 'function' ||
        (beforeStart !== undefined && typeof beforeStart !== 'function') ||
        (afterStop !== undefined && typeof afterStop !== 'function') ||
        (context !== undefined && typeof beforeStart !== 'function')
      ) {
        reject(new TypeError('Invalid MTP operation execution hooks.'));

        return;
      }

      this.pending.push({
        operation,
        resolve,
        reject,
        context,
        beforeStart,
        afterStop,
      });
      this._drain();
    });
  }

  _callHook(hook, ...args) {
    this._inHook = true;
    this._hookViolation = null;

    try {
      const result = hook(...args);

      if (result && typeof result.then === 'function') {
        // An accidental async hook must neither strand the lane nor produce an
        // unhandled rejection. Its continuation must not be used for fencing.
        Promise.resolve(result).catch(() => {});
        throw new TypeError('MTP execution hooks must be synchronous.');
      }

      if (this._hookViolation) throw this._hookViolation;

      return result;
    } finally {
      this._inHook = false;
      this._hookViolation = null;
    }
  }

  _quarantine(cause) {
    const fault = new Error('MTP settlement hook failed; queue quarantined.');

    fault.code = 'MTP_QUEUE_QUARANTINED';
    fault.cause = cause;
    this._fault = fault;
    this.pending.splice(0).forEach(({ reject }) => reject(fault));

    return fault;
  }

  _drain() {
    if (this._draining) return;

    this._draining = true;

    try {
      // Stale batches and synchronous failures are drained iteratively, without
      // recursive admission that could overflow and strand the lane.
      while (!this.active && !this._fault && this.pending.length > 0) {
        this.active = true;
        this._start(this.pending.shift());
      }
    } finally {
      this._draining = false;
    }
  }

  _start({ operation, resolve, reject, context, beforeStart, afterStop }) {
    const settle = (outcome) => {
      try {
        if (afterStop)
          this._callHook(afterStop, Object.freeze(outcome), context);

        if (outcome.status === 'fulfilled') resolve(outcome.value);
        else reject(outcome.reason);
      } catch (error) {
        reject(this._quarantine(error));
      }

      this.active = false;
      this._drain();
    };
    let result;

    try {
      if (beforeStart && this._callHook(beforeStart, context) === false) {
        throw new Error('MTP operation rejected before execution.');
      }
    } catch (error) {
      // No operation started, so no afterStop hook or native cleanup is due.
      reject(error);
      this.active = false;
      this._drain();

      return;
    }

    try {
      // Start the first admitted task immediately; subsequent tasks stay FIFO.
      result = operation();
    } catch (error) {
      settle({ status: 'rejected', reason: error });

      return;
    }

    Promise.resolve(result)
      .then((value) => settle({ status: 'fulfilled', value }))
      .catch((error) => settle({ status: 'rejected', reason: error }));
  }
}

const mtpOperationQueue = new MtpOperationQueue();

export default mtpOperationQueue;
