import { MTP_ERROR } from '../../enums/mtpError';

const statuses = ['completed', 'failed', 'partial', 'cancelled', 'unknown'];

export function createTransferResult(value = {}) {
  const {
    status = 'unknown',
    backend,
    direction,
    error = null,
    stderr = null,
    reason = null,
    backendStopped = null,
    evidence: suppliedEvidence,
    files: suppliedFiles,
    destinationMayContainPartialData = true,
  } = value || {};
  const evidence = suppliedEvidence || {};
  const files = suppliedFiles || {};
  let outcome = statuses.includes(status) ? status : 'unknown';
  const acknowledged =
    backend === 'kalam'
      ? evidence.nativeAcknowledged === true
      : backend === 'legacy' &&
        evidence.exitCode === 0 &&
        evidence.signal === null;

  // An acknowledgement describes backend execution, not destination integrity.
  if (
    outcome === 'completed' &&
    (!acknowledged || backendStopped !== true || error || stderr)
  ) {
    outcome = 'unknown';
  }

  if (
    outcome === 'partial' &&
    (!Array.isArray(files.confirmedCompleted) ||
      files.confirmedCompleted.length === 0)
  ) {
    outcome = 'unknown';
  }

  if (
    outcome === 'cancelled' &&
    (backendStopped !== true || evidence.cancellationAcknowledged !== true)
  ) {
    outcome = 'unknown';
  }

  const completed = outcome === 'completed';

  return {
    status: outcome,
    backend,
    direction,
    data: completed,
    error: completed
      ? null
      : String(error?.message || error || `Transfer ${outcome}.`),
    stderr: completed
      ? null
      : stderr || (backend === 'kalam' ? MTP_ERROR.ErrorGeneral : null),
    reason: reason || outcome,
    backendStopped,
    evidence: {
      nativeAcknowledged: null,
      exitCode: null,
      signal: null,
      ...evidence,
    },
    files: {
      requested: [],
      confirmedCompleted: null,
      confirmedFailed: null,
      ...files,
    },
    destinationMayContainPartialData,
  };
}

export function createTransferFinalizer({
  onCompleted,
  onError,
  onNotificationError,
}) {
  let finished = false;

  return (result) => {
    if (finished) {
      return false;
    }

    finished = true;

    try {
      const notify = result.status === 'completed' ? onCompleted : onError;

      if (typeof notify === 'function') {
        notify(result);
      }
    } catch (error) {
      // A consumer exception must not change or duplicate the backend outcome.
      if (typeof onNotificationError === 'function') {
        try {
          onNotificationError(error);
        } catch (_) {
          // Even a logging failure must not escape a native callback.
          return true;
        }
      }
    }

    return true;
  };
}
