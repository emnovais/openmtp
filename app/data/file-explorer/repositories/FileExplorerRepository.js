/* eslint-disable global-require */
import { FileExplorerLocalDataSource } from '../data-sources/FileExplorerLocalDataSource';
import { DEVICE_TYPE, MTP_MODE } from '../../../enums';
import { getMtpModeSetting } from '../../../helpers/settings';
import mtpOperationQueue from '../MtpOperationQueue';

// Renderer UI revisions only: these are not native session/cleanup evidence.
const scope = {
  generation: 0,
  backend: null,
  storageId: null,
  storageRevision: 0,
};
const backends = new Map();
let ready = false;
let restartRequired = false;
let initialization = null;
let initializedValue = null;

export const captureMtpScope = () => ({ ...scope });
export const isMatchingMtpScope = (value) =>
  !!value && Object.keys(scope).every((key) => value[key] === scope[key]);
export const isCurrentMtpScope = (value) => ready && isMatchingMtpScope(value);

export function invalidateRendererMtp() {
  scope.generation += 1;
  ready = false;
  initializedValue = null;
  // A USB event cannot prove device identity or acknowledge native cleanup.
  if (scope.backend === MTP_MODE.kalam && backends.has(scope.backend))
    restartRequired = true;
}

function requireRenderer() {
  if (
    (typeof process !== 'undefined' && process.type === 'browser') ||
    (typeof window !== 'undefined' &&
      window.location?.hash &&
      !['#', '#/'].includes(window.location.hash))
  )
    throw new Error('MTP execution is restricted to the explorer renderer.');
  if (restartRequired)
    throw new Error(
      'MTP state is uncertain. Quit and start a fresh development process.'
    );
}

function backend(mode) {
  requireRenderer();
  if (![MTP_MODE.kalam, MTP_MODE.legacy].includes(mode))
    throw new Error('Unsupported MTP backend.');
  if (scope.backend && scope.backend !== mode)
    throw new Error(
      'Change the MTP backend before requesting device operations.'
    );
  scope.backend = mode;
  if (!backends.has(mode)) {
    try {
      const Source =
        mode === MTP_MODE.kalam
          ? require('../data-sources/FileExplorerKalamDataSource')
              .FileExplorerKalamDataSource
          : require('../data-sources/FileExplorerLegacyDataSource')
              .FileExplorerLegacyDataSource;

      backends.set(
        mode,
        new Source({
          executionHooks: () => {
            const origin = captureMtpScope();

            return {
              beforeStart: () => {
                requireRenderer();
                if (!isMatchingMtpScope(origin))
                  throw new Error('Obsolete renderer MTP request.');
              },
              afterStop: (outcome) => {
                if (
                  mode === MTP_MODE.kalam &&
                  (outcome.status === 'rejected' ||
                    failed(outcome.value) ||
                    ['failed', 'partial', 'unknown', 'cancelled'].includes(
                      outcome.value?.status
                    ))
                ) {
                  restartRequired = true;
                  ready = false;
                }
              },
            };
          },
        })
      );
    } catch (error) {
      if (mode === MTP_MODE.kalam) restartRequired = true;
      throw error;
    }
  }

  return backends.get(mode);
}

const failed = (value) => value?.error || value?.stderr;

export class FileExplorerRepository {
  constructor() {
    // Local/report-window operations never construct a native backend.
    this.localDataSource = new FileExplorerLocalDataSource();
  }

  async call(method, args = {}, mode = getMtpModeSetting()) {
    const source = backend(mode);
    const origin = captureMtpScope();

    try {
      const value = await source[method](args);

      if (
        mode === MTP_MODE.kalam &&
        (failed(value) ||
          ['failed', 'partial', 'unknown', 'cancelled'].includes(value?.status))
      ) {
        restartRequired = true;
        ready = false;
      }

      if (!isMatchingMtpScope(origin))
        throw new Error('Obsolete renderer MTP result.');

      return value;
    } catch (error) {
      if (mode === MTP_MODE.kalam) {
        restartRequired = true;
        ready = false;
      }

      throw error;
    }
  }

  initialize({ deviceType }) {
    if (deviceType !== DEVICE_TYPE.mtp)
      throw new Error('Local initialization is unsupported.');
    try {
      requireRenderer();
    } catch (error) {
      return Promise.resolve({
        error: error.message,
        stderr: 'ErrorGeneral',
        data: null,
      });
    }

    if (initialization) return initialization;
    if (ready && scope.backend === getMtpModeSetting())
      return Promise.resolve(initializedValue);
    scope.generation += 1;
    ready = false;
    initialization = this.call('initialize')
      .then((value) => {
        if (!failed(value) && value?.data) {
          ready = true;
          initializedValue = value;
        } else {
          restartRequired = true;

          return {
            error:
              value?.error ||
              'Native initialization returned no device metadata.',
            stderr: value?.stderr || 'ErrorGeneral',
            data: null,
          };
        }

        return value;
      })
      .catch((error) => ({
        error: error.message,
        stderr: 'ErrorGeneral',
        data: null,
      }))
      .finally(() => {
        initialization = null;
      });

    return initialization;
  }

  async dispose({ deviceType }) {
    if (deviceType !== DEVICE_TYPE.mtp)
      throw new Error('Local disposal is unsupported.');
    requireRenderer();
    if (mtpOperationQueue.active || initialization)
      throw new Error('Wait for MTP execution to return before disposal.');
    scope.generation += 1;
    ready = false;
    initializedValue = null;
    if (!backends.has(scope.backend) || scope.backend === MTP_MODE.legacy)
      return { error: null, stderr: null, data: true };
    // This preserves the historical Dispose command contract, not proof of
    // complete USB/resource cleanup. Failures require a fresh process.
    const value = await this.call('dispose', {}, scope.backend);

    if (failed(value) || value?.data !== true) {
      restartRequired = true;
      throw new Error(
        value?.error ||
          'MTP disposal was not acknowledged. Start a fresh development process.'
      );
    }

    return value;
  }

  async listStorages() {
    const mode = getMtpModeSetting();

    if (mode === MTP_MODE.legacy && !ready) scope.generation += 1;
    const value = await this.call('listStorages', {}, mode);

    if (!failed(value) && value?.data) ready = true;

    return value;
  }

  selectStorage(storageId) {
    requireRenderer();
    if (!ready) throw new Error('MTP is not ready.');
    if (!Number.isInteger(storageId) || storageId < 0 || storageId > 0xffffffff)
      throw new Error('Invalid MTP storage.');
    if (scope.storageId !== storageId) {
      scope.storageId = storageId;
      scope.storageRevision += 1;
    }
  }

  async selectBackend(mode) {
    requireRenderer();
    if (![MTP_MODE.kalam, MTP_MODE.legacy].includes(mode))
      throw new Error('Unsupported MTP backend.');
    if (mode === scope.backend) return;
    await this.dispose({ deviceType: DEVICE_TYPE.mtp });
    requireRenderer();
    scope.backend = mode;
    scope.storageId = null;
    scope.storageRevision += 1;
  }

  route(method, { deviceType, ...args }) {
    if (deviceType !== DEVICE_TYPE.mtp)
      return this.localDataSource[method](args);
    if (!ready) throw new Error('MTP is not ready.');

    return this.call(method, args);
  }

  listFiles(args) {
    return this.route('listFiles', args);
  }

  renameFile(args) {
    return this.route('renameFile', args);
  }

  deleteFiles(args) {
    return this.route('deleteFiles', args);
  }

  makeDirectory(args) {
    return this.route('makeDirectory', args);
  }

  filesExist(args) {
    return this.route('filesExist', args);
  }

  async readThumbnail(args) {
    requireRenderer();
    if (
      getMtpModeSetting() !== MTP_MODE.legacy ||
      scope.backend !== MTP_MODE.legacy ||
      !isCurrentMtpScope(args.scope) ||
      args.storageId !== scope.storageId ||
      typeof args.isCurrent !== 'function' ||
      !args.isCurrent()
    )
      throw new Error('Obsolete or unsupported MTP thumbnail request.');

    return this.call('readThumbnail', args, MTP_MODE.legacy);
  }

  transferFiles(args) {
    if (args.deviceType !== DEVICE_TYPE.mtp)
      throw new Error('Transfer requires an MTP endpoint.');
    if (!ready) throw new Error('MTP is not ready.');

    return this.call('transferFiles', args);
  }

  async fetchDebugReport() {
    // Diagnostics run only after renderer disposal and never after uncertainty.
    await this.dispose({ deviceType: DEVICE_TYPE.mtp });

    return this.call('fetchDebugReport');
  }
}
