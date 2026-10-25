import path from 'path';
import { FileExplorerRepository } from '../repositories/FileExplorerRepository';
import { checkIf } from '../../../utils/checkIf';
import { analyticsService } from '../../../services/analytics';
import { EVENT_TYPE } from '../../../enums/events';
import {
  processLocalBuffer,
  processMtpBuffer,
} from '../../../helpers/processBufferOutput';
import { getMtpModeSetting } from '../../../helpers/settings';
import { DEVICE_TYPE } from '../../../enums';
import { unixTimestampNow } from '../../../utils/date';
import { log } from '../../../utils/log';
import {
  createTransferFinalizer,
  createTransferResult,
} from '../transferResult';

class FileExplorerController {
  constructor() {
    this.repository = new FileExplorerRepository();
  }

  readThumbnail(args) {
    // Background previews do not enter transfer/clipboard or analytics flows.
    return this.repository.readThumbnail(args);
  }

  async _sentEvent({ result, deviceType, eventKey, attachData = false }) {
    checkIf(eventKey, 'string');
    checkIf(attachData, 'boolean');
    checkIf(deviceType, 'inObjectValues', DEVICE_TYPE);

    // events related to local disk actions
    if (deviceType === DEVICE_TYPE.local) {
      const { error: localError } = await processLocalBuffer({
        error: result?.error,
        stderr: result?.stderr,
      });

      if (localError) {
        const _eventKey = `${EVENT_TYPE[`LOCAL_${eventKey}_ERROR`]}`;

        // if the event key is not listed in the [EVENT_TYPE] object then don't proceed
        if (!_eventKey) {
          return;
        }

        // send out an error event
        await analyticsService.sendEvent(_eventKey, {
          time: unixTimestampNow(),
          stderr: result?.stderr,
          error: result?.error,
        });

        return;
      }

      const _eventKey = `${EVENT_TYPE[`LOCAL_${eventKey}_SUCCESS`]}`;

      // if the event key is not listed in the [EVENT_TYPE] object then don't proceed
      if (!_eventKey) {
        return;
      }

      // send a success event
      let data = {};

      if (attachData) {
        data = {
          data: result?.data,
        };
      }

      await analyticsService.sendEvent(_eventKey, {
        time: unixTimestampNow(),
        ...data,
      });

      return;
    }

    // events related to mtp actions
    const mtpMode = getMtpModeSetting();
    const { mtpStatus, error: mtpError } = await processMtpBuffer({
      error: result?.error,
      stderr: result?.stderr,
      mtpMode,
    });

    if (mtpError) {
      const _eventKey = `${EVENT_TYPE[`MTP_${eventKey}_ERROR`]}`;

      // if the event key is not listed in the [EVENT_TYPE] object then don't proceed
      if (!_eventKey) {
        return;
      }

      // send out an error event
      await analyticsService.sendEvent(_eventKey, {
        time: unixTimestampNow(),
        'MTP Status': mtpStatus,
        'MTP Mode': mtpMode,
        stderr: result?.stderr,
        error: result?.error,
      });

      return;
    }

    const _eventKey = `${EVENT_TYPE[`MTP_${eventKey}_SUCCESS`]}`;

    // if the event key is not listed in the [EVENT_TYPE] object then don't proceed
    if (!_eventKey) {
      return;
    }

    // send a success event
    let data = {};

    if (attachData) {
      data = {
        data: result?.data,
      };
    }

    await analyticsService.sendEvent(_eventKey, {
      time: unixTimestampNow(),
      'MTP Status': mtpStatus,
      'MTP Mode': mtpMode,
      ...data,
    });
  }

  /**
   * description - Initialize
   *
   * @return {Promise<{data: object, error: string|null, stderr: string|null}>}
   */
  selectStorage(storageId) {
    return this.repository.selectStorage(storageId);
  }

  selectBackend(backend) {
    return this.repository.selectBackend(backend);
  }

  async initialize({ deviceType }) {
    checkIf(deviceType, 'string');

    const result = await this.repository.initialize({ deviceType });

    this._sentEvent({ result, deviceType, eventKey: 'INITIALIZE' });

    return result;
  }

  /**
   * description - Dispose
   *
   * @return {Promise<{data: object, error: string|null, stderr: string|null}>}
   */
  async dispose({ deviceType }) {
    checkIf(deviceType, 'string');

    const result = await this.repository.dispose({ deviceType });

    this._sentEvent({ result, deviceType, eventKey: 'DISPOSE' });

    return result;
  }

  /**
   * description - Fetch storages
   *
   * @return {Promise<{data: object|boolean, error: string|null, stderr: string|null}>}
   */
  async listStorages({ deviceType }) {
    checkIf(deviceType, 'string');

    const result = await this.repository.listStorages({ deviceType });

    this._sentEvent({
      result,
      deviceType,
      eventKey: 'LIST_STORAGES',
      attachData: true,
    });

    return result;
  }

  /**
   * description - Fetch files in the path
   *
   * @param {string} deviceType
   * @param {string} filePath
   * @param {string} ignoreHidden
   * @param {string} storageId
   * @return {Promise<{data: array|null, error: string|null, stderr: string|null}>}
   */
  async listFiles({ deviceType, filePath, ignoreHidden, storageId }) {
    checkIf(deviceType, 'string');
    checkIf(filePath, 'string');
    checkIf(ignoreHidden, 'boolean');

    const result = await this.repository.listFiles({
      deviceType,
      filePath,
      ignoreHidden,
      storageId,
    });

    this._sentEvent({ result, deviceType, eventKey: 'LIST_FILES' });

    return result;
  }

  /**
   * description - Rename a file
   *
   * @param {string} deviceType
   * @param {string} filePath
   * @param {string} newFilename
   * @param {string} storageId
   * @return {Promise<{data: null|boolean, error: string|null, stderr: string|null}>}
   */
  async renameFile({ deviceType, filePath, newFilename, storageId }) {
    checkIf(deviceType, 'string');
    checkIf(filePath, 'string');
    checkIf(newFilename, 'string');

    const result = await this.repository.renameFile({
      deviceType,
      filePath,
      newFilename,
      storageId,
    });

    this._sentEvent({ result, deviceType, eventKey: 'RENAME_FILE' });

    return result;
  }

  /**
   * description - Delete files
   *
   * @param {string} deviceType
   * @param {[string]} fileList
   * @param {string} storageId
   * @return {Promise<{data: null|boolean, error: string|null, stderr: string|null}>}
   */
  async deleteFiles({ deviceType, fileList, storageId }) {
    checkIf(deviceType, 'string');
    checkIf(fileList, 'array');

    const result = await this.repository.deleteFiles({
      deviceType,
      fileList,
      storageId,
    });

    this._sentEvent({ result, deviceType, eventKey: 'DELETE_FILE' });

    return result;
  }

  /**
   * description - Create a directory
   *
   * @param {string} deviceType
   * @param {string} filePath
   * @param {string} storageId
   * @return {Promise<{data: null|boolean, error: string|null, stderr: string|null}>}
   */
  async makeDirectory({ deviceType, filePath, storageId }) {
    checkIf(deviceType, 'string');
    checkIf(filePath, 'string');

    const result = await this.repository.makeDirectory({
      deviceType,
      filePath,
      storageId,
    });

    this._sentEvent({ result, deviceType, eventKey: 'NEW_FOLDER' });

    return result;
  }

  /**
   * description - Check if files exist
   *
   * @param {string} deviceType
   * @param {[string]} fileList
   * @param {string} storageId
   * @return {Promise<boolean>}
   */
  async filesExist({ deviceType, fileList, storageId }) {
    checkIf(deviceType, 'string');
    checkIf(fileList, 'array');

    const result = await this.repository.filesExist({
      deviceType,
      fileList,
      storageId,
    });

    this._sentEvent({ result, deviceType, eventKey: 'FILES_EXIST' });

    return result;
  }

  /**
   * description - Upload or download files from MTP device to local or vice versa
   *
   * @param {string} deviceType
   * @param {string} destination
   * @param {'upload'|'download'} direction
   * @param {[string]} fileList
   * @param {string} storageId
   * @param {errorCallback} onError
   * @param {preprocessCallback} onPreprocess
   * @param {progressCallback} onProgress
   * @param {completedCallback} onCompleted
   *
   * @return
   */
  transferFiles = async ({
    deviceType,
    destination,
    fileList,
    direction,
    storageId,
    onError,
    onPreprocess,
    onProgress,
    onCompleted,
  }) => {
    const backend = getMtpModeSetting();
    const notify = createTransferFinalizer({
      onError,
      onCompleted,
      onNotificationError: (error) => log.error(error),
    });
    const sources = Array.isArray(fileList) ? [...fileList] : [];
    let callbackFailure;
    let result;

    if (this.transferActive) {
      const refused = createTransferResult({
        status: 'failed',
        backend,
        direction,
        backendStopped: true,
        error: 'Another transfer is still active.',
        reason: 'transfer-busy',
        destinationMayContainPartialData: false,
      });

      notify(refused);

      return refused;
    }

    this.transferActive = true;

    try {
      checkIf(deviceType, 'string');
      checkIf(destination, 'string');
      checkIf(direction, 'string');
      checkIf(fileList, 'array');
      checkIf(onError, 'function');
      checkIf(onPreprocess, 'function');
      checkIf(onProgress, 'function');
      checkIf(onCompleted, 'function');
      if (
        deviceType !== DEVICE_TYPE.mtp ||
        !['upload', 'download'].includes(direction) ||
        !Number.isInteger(storageId) ||
        storageId <= 0 ||
        storageId >= 0xffffffff ||
        !path.posix.isAbsolute(destination) ||
        destination.includes('\0') ||
        !fileList.length
      )
        throw new Error('Invalid cross-endpoint transfer request.');
      // Keep queued backend work and verification independent of clipboard edits.
      const destinations = [];
      const names = new Set();

      for (const source of sources) {
        if (
          typeof source !== 'string' ||
          !path.posix.isAbsolute(source) ||
          path.posix.normalize(source) !== source ||
          source === '/' ||
          source.includes('\0')
        )
          throw new Error('Invalid transfer source path.');
        const name = path.posix.basename(source);
        const identity = name.normalize('NFC').toLowerCase();

        if (names.has(identity))
          throw new Error('Selected files map to the same destination name.');
        names.add(identity);
        destinations.push(path.posix.join(destination, name));
      }

      const recordFailure = (value) => {
        if (!callbackFailure) {
          callbackFailure = createTransferResult({
            ...value,
            status: value?.status === 'completed' ? 'unknown' : value?.status,
            backend,
            direction,
          });
        }
      };
      const returned = await this.repository.transferFiles({
        deviceType,
        destination,
        fileList: sources,
        direction,
        storageId,
        onError: recordFailure,
        onProgress: (value) => {
          if (!callbackFailure && !result) onProgress(value);
        },
        onCompleted: (value) => {
          if (value?.status !== 'completed') recordFailure(value);
        },
        onPreprocess: (value) => {
          if (!callbackFailure && !result) onPreprocess(value);
        },
      });

      result = createTransferResult({
        ...(callbackFailure || returned),
        backend,
        direction,
        files: { ...returned?.files, requested: sources },
      });
      if (result.status === 'completed') {
        const evidence = {
          ...result.evidence,
          destinationPresence: 'unknown',
          contentVerified: false,
        };

        try {
          for (const destinationPath of destinations) {
            // Each lookup owns its existing leaf; never hold a surrounding MTP lease.
            // eslint-disable-next-line no-await-in-loop
            const exists = await this.repository.filesExist({
              deviceType:
                direction === 'upload' ? DEVICE_TYPE.mtp : DEVICE_TYPE.local,
              storageId,
              fileList: [destinationPath],
            });

            if (exists !== true) {
              result = createTransferResult({
                ...result,
                status: exists === false ? 'failed' : 'unknown',
                error:
                  exists === false
                    ? 'A transferred destination is missing.'
                    : exists?.error ||
                      exists?.stderr ||
                      'Destination verification is uncertain.',
                reason: 'destination-presence-check',
                evidence,
              });
              break;
            }
          }

          if (result.status === 'completed')
            result = createTransferResult({
              ...result,
              evidence: { ...evidence, destinationPresence: 'confirmed' },
            });
        } catch (error) {
          result = createTransferResult({
            ...result,
            status: 'unknown',
            error,
            reason: 'destination-presence-error',
            evidence,
          });
        }
      }
    } catch (error) {
      result = createTransferResult({
        status: 'unknown',
        backend,
        direction,
        error,
        reason: 'controller-error',
        files: { requested: sources },
      });
    } finally {
      // This gate spans backend termination and destination checks, without
      // acquiring a second lease on the native MTP queue.
      this.transferActive = false;
    }

    notify(result);

    // Transfer telemetry uses terminal status, not the generic error formatter.
    try {
      Promise.resolve(
        analyticsService.sendEvent(
          result.status === 'completed'
            ? EVENT_TYPE.MTP_TRANSFER_FILES_SUCCESS
            : EVENT_TYPE.MTP_TRANSFER_FILES_ERROR,
          {
            time: unixTimestampNow(),
            'MTP Mode': backend,
            status: result.status,
            error: result.error,
            stderr: result.stderr,
          }
        )
      ).catch((error) => log.error(error));
    } catch (error) {
      log.error(error);
    }

    return result;
  };

  /**
   * description: fetch the data for generating bug/error reports
   *
   * @param {string} deviceType
   * @return {Promise<{data: string|null, error: string|null, stderr: string|null}>}
   */
  async fetchDebugReport({ deviceType }) {
    checkIf(deviceType, 'string');

    const result = await this.repository.fetchDebugReport({ deviceType });

    this._sentEvent({ result, deviceType, eventKey: 'FETCH_DEBUG_REPORT' });

    return result;
  }
}

// Main imports shared settings modules that transitively reference this module.
// Keep that graph inert: no renderer controller/repository is constructed there.
let rendererController;
const fileExplorerController = {};

[
  'initialize',
  'dispose',
  'listStorages',
  'listFiles',
  'readThumbnail',
  'renameFile',
  'deleteFiles',
  'makeDirectory',
  'filesExist',
  'transferFiles',
  'fetchDebugReport',
  'selectStorage',
  'selectBackend',
].forEach((method) => {
  fileExplorerController[method] = (...args) => {
    if (typeof process !== 'undefined' && process.type === 'browser') {
      throw new Error(
        'Renderer file explorer controller cannot execute in main.'
      );
    }

    if (!rendererController) rendererController = new FileExplorerController();

    return rendererController[method](...args);
  };
});

export default fileExplorerController;
