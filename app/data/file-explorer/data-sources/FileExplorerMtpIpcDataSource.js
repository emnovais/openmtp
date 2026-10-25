import { ipcRenderer } from 'electron';
import { MtpSessionClient } from '../MtpSessionClient';
import {
  createTransferFinalizer,
  createTransferResult,
} from '../transferResult';

// Construction is inert: shared settings helpers can be imported in main.
// The first actual renderer MTP request creates exactly one transport client.
let client = null;

export function getMtpClient() {
  if (!ipcRenderer)
    throw new Error('Renderer MTP adapter cannot execute in main.');
  if (!client || client.disposed)
    client = new MtpSessionClient({ ipcRenderer, version: 2 });

  return client;
}

export function captureMtpScope() {
  const state = client?._state;

  return state
    ? {
        ownerEpoch: state.ownerEpoch,
        generation: state.generation,
        backend: state.backend,
        storageId: state.storageId,
        storageRevision: state.storageRevision,
      }
    : null;
}

export function isMatchingMtpScope(scope) {
  const current = captureMtpScope();

  return (
    !!scope &&
    !!current &&
    Object.keys(scope).every((key) => scope[key] === current[key])
  );
}

export function isCurrentMtpScope(scope) {
  return isMatchingMtpScope(scope) && client?._state?.state === 'Ready';
}

export class FileExplorerMtpIpcDataSource {
  async request(operation, args = {}) {
    const transport = getMtpClient();
    const origin = captureMtpScope();

    await transport.connect();
    const response = await transport.activeRequest(
      operation,
      args,
      origin || captureMtpScope()
    );

    if (
      ![
        'initialize',
        'dispose',
        'selectBackend',
        'selectStorage',
        'listStorages',
        'fetchDebugReport',
      ].includes(operation) &&
      !isCurrentMtpScope(response.scope)
    ) {
      const error = new Error('MTP result belongs to an obsolete session.');

      error.code = 'MTP_SESSION_STALE';
      throw error;
    }

    const { value } = response;

    if (
      value &&
      typeof value === 'object' &&
      value.error &&
      typeof value.error === 'object'
    )
      value.error = value.error.message || 'MTP backend error';

    return value;
  }

  initialize() {
    return this.request('initialize');
  }

  dispose() {
    return this.request('dispose');
  }

  listStorages() {
    return this.request('listStorages');
  }

  listFiles(args) {
    return this.request('listFiles', args);
  }

  renameFile(args) {
    return this.request('renameFile', args);
  }

  deleteFiles(args) {
    return this.request('deleteFiles', args);
  }

  makeDirectory(args) {
    return this.request('makeDirectory', args);
  }

  filesExist(args) {
    return this.request('filesExist', args);
  }

  fetchDebugReport() {
    return this.request('fetchDebugReport');
  }

  selectStorage(storageId) {
    return this.request('selectStorage', { storageId });
  }

  selectBackend(backend) {
    return this.request('selectBackend', { backend });
  }

  async transferFiles({
    onPreprocess,
    onProgress,
    onCompleted,
    onError,
    deviceType: _deviceType,
    ...args
  }) {
    const notify = createTransferFinalizer({ onCompleted, onError });
    const transport = getMtpClient();
    const origin = captureMtpScope();
    let result;

    try {
      await transport.connect();
      const response = await transport.activeRequest(
        'transferFiles',
        args,
        origin,
        {
          onPreprocess: (data) => {
            if (isCurrentMtpScope(origin)) onPreprocess(data);
          },
          onProgress: (data) => {
            if (isCurrentMtpScope(origin)) onProgress(data);
          },
        }
      );

      result = createTransferResult(response.value);
      if (!isCurrentMtpScope(origin))
        throw new Error('Transfer outcome belongs to an obsolete UI session.');
    } catch (error) {
      result = createTransferResult({
        status: 'unknown',
        backend: origin?.backend,
        direction: args.direction,
        error,
        reason: 'ipc-outcome-uncertain',
        files: { requested: args.fileList },
        backendStopped: null,
      });
    }

    notify(result);

    return result;
  }
}
