import { exec } from 'child_process';
import { log } from '../../../utils/log';
import { Kalam } from '../../../../ffi/kalam/src/Kalam';
import { checkIf } from '../../../utils/checkIf';
import { isArray, isEmpty } from '../../../utils/funcs';
import { getFilesPreprocessingBeforeTransferSetting } from '../../../helpers/settings';
import { msToTime } from '../../../utils/date';
import { kalamDebugReportCli } from '../../../helpers/binaries';
import mtpOperationQueue from '../MtpOperationQueue';
import {
  createTransferFinalizer,
  createTransferResult,
} from '../transferResult';

export class FileExplorerKalamDataSource {
  constructor({ executionHooks = null } = {}) {
    if (
      (typeof process !== 'undefined' && process.type === 'browser') ||
      (typeof window !== 'undefined' &&
        window.location?.hash &&
        !['#', '#/'].includes(window.location.hash))
    ) {
      throw new Error('MTP execution is restricted to the explorer renderer.');
    }

    this.executionHooks = executionHooks;
    this.kalamFfi = new Kalam({ executionHooks });
  }

  /**
   * Execute a binary file
   * @param command
   * @return {Promise<unknown>}
   * @private
   */
  async _exec(command) {
    // Only the external diagnostic process acquires here. FFI methods already
    // acquire at Kalam's leaf invocation boundary, avoiding nested acquisition.
    return mtpOperationQueue.run(
      () =>
        new Promise((resolve) => {
          let child;
          let finished = false;
          let output;
          let spawnError;
          const finish = () => {
            if (finished) return;

            finished = true;
            const result = output || {
              error: new Error('Diagnostic process closed without a result.'),
              stderr: null,
              data: null,
            };

            resolve({ ...result, error: spawnError || result.error });
          };

          try {
            child = exec(command, (error, stdout, stderr) => {
              if (!finished) output = { error, stderr, data: stdout };
            });
            child.once('close', finish);
            child.on('error', (error) => {
              spawnError = error;
            });
          } catch (error) {
            spawnError = error;

            if (!child) finish();
          }
        }),
      this.executionHooks ? this.executionHooks() : undefined
    );
  }

  /**
   * description - Initialize Kalam MTP
   *
   * @return {Promise<{data: object, error: string|null, stderr: string|null}>}
   */
  async initialize() {
    try {
      return this.kalamFfi.initialize();
    } catch (e) {
      log.error(e);

      return {
        error: e,
        stderr: null,
        data: null,
      };
    }
  }

  /**
   * description - Dispose Kalam MTP
   *
   * @return {Promise<{data: object, error: string|null, stderr: string|null}>}
   */
  async dispose() {
    try {
      return this.kalamFfi.dispose();
    } catch (e) {
      log.error(e);

      return {
        error: e,
        stderr: null,
        data: null,
      };
    }
  }

  /**
   * description - Fetch Kalam MTP storages
   *
   * @return {Promise<{data: {}, error: string|null, stderr: string|null}>}
   */
  async listStorages() {
    try {
      const { error, stderr, data } = await this.kalamFfi.listStorages();

      if (error || stderr || !data) {
        return { error, stderr, data };
      }

      const storageList = {};

      data.forEach((a, index) => {
        storageList[a.Sid] = {
          name: a.Info.StorageDescription,
          selected: index === 0,
          info: a.Info,
        };
      });

      return { error, stderr, data: storageList };
    } catch (e) {
      log.error(e);

      return {
        error: e,
        stderr: null,
        data: null,
      };
    }
  }

  /**
   * description - Fetch device files in the path
   *
   * @param filePath
   * @param ignoreHidden
   * @param storageId
   * @return {Promise<{data: array|null, error: string|null, stderr: string|null}>}
   */
  async listFiles({ filePath, ignoreHidden, storageId }) {
    checkIf(filePath, 'string');
    checkIf(ignoreHidden, 'boolean');
    checkIf(storageId, 'number');

    try {
      return this.kalamFfi.walk({
        fullPath: filePath,
        storageId,
        skipHiddenFiles: ignoreHidden,
      });
    } catch (e) {
      log.error(e);

      return {
        error: e,
        stderr: null,
        data: null,
      };
    }
  }

  /**
   * description - Rename a device file
   *
   * @param filePath
   * @param newFilename
   * @param storageId
   * @return {Promise<{data: null|boolean, error: string|null, stderr: string|null}>}
   */
  async renameFile({ filePath, newFilename, storageId }) {
    checkIf(filePath, 'string');
    checkIf(newFilename, 'string');
    checkIf(storageId, 'number');

    try {
      return this.kalamFfi.renameFile({
        fullPath: filePath,
        storageId,
        newFilename,
      });
    } catch (e) {
      log.error(e);

      return {
        error: e,
        stderr: null,
        data: null,
      };
    }
  }

  /**
   * description - Check if files exist in the device
   *
   * @param {[string]} fileList
   * @param {string} storageId
   * @return {Promise<boolean>}
   */
  async filesExist({ fileList, storageId }) {
    checkIf(fileList, 'array');
    checkIf(storageId, 'number');

    try {
      const { error, stderr, data } = await this.kalamFfi.fileExist({
        storageId,
        files: fileList,
      });

      if (error || stderr) {
        return { error: error || stderr, stderr: stderr ?? null, data: null };
      }

      if (
        error !== null ||
        stderr !== null ||
        fileList.length === 0 ||
        !Array.isArray(data) ||
        data.length !== fileList.length
      ) {
        throw new Error(
          'Unable to verify destination files: invalid Kalam result.'
        );
      }

      for (let i = 0; i < fileList.length; i += 1) {
        const item = data[i];

        if (
          typeof fileList[i] !== 'string' ||
          fileList[i].length === 0 ||
          !item ||
          Array.isArray(item) ||
          item.fullpath !== fileList[i] ||
          typeof item.exists !== 'boolean'
        ) {
          throw new Error(
            'Unable to verify destination files: invalid Kalam record.'
          );
        }
      }

      return data.some((item) => item.exists);
    } catch (e) {
      log.error(e);

      return {
        error: e,
        stderr: null,
        data: null,
      };
    }
  }

  /**
   * description - Create a device directory
   *
   * @param filePath
   * @param storageId
   * @return {Promise<{data: null|boolean, error: string|null, stderr: string|null}>}
   */
  async makeDirectory({ filePath, storageId }) {
    checkIf(filePath, 'string');
    checkIf(storageId, 'number');

    try {
      return this.kalamFfi.makeDirectory({
        storageId,
        fullPath: filePath,
      });
    } catch (e) {
      log.error(e);

      return { error: e, stderr: null, data: false };
    }
  }

  /**
   * description - Delete device files
   *
   * @param fileList [string]
   * @param storageId
   * @return {Promise<{data: null|boolean, error: string|null, stderr: string|null}>}
   */
  async deleteFiles({ fileList, storageId }) {
    checkIf(fileList, 'array');
    checkIf(storageId, 'number');

    return this.kalamFfi.deleteFile({
      storageId,
      files: fileList,
    });
  }

  /**
   * @typedef {function(errorCallbackInfo)} errorCallback
   * @callback errorCallback
   * @param {errorCallbackInfo} args - error object
   */

  /**
   * @typedef {Object} errorCallbackInfo
   * @property {string} error - error text
   * @property {string} stderr - std error text
   * @property {null} data - data
   */

  /**
   * @typedef {function(preprocessCallbackInfo)} preprocessCallback
   * @callback preprocessCallback
   * @param {preprocessCallbackInfo} args - preprocess object
   */

  /**
   * @typedef {Object} preprocessCallbackInfo
   * @property {string} fullPath - full file path
   * @property {number} name - file name
   */

  /**
   * @typedef {function(progressCallbackInfo)} progressCallback
   * @callback progressCallback
   * @param {progressCallbackInfo} args - progress object
   */

  /**
   * @typedef {Object} progressCallbackInfo
   * @property {number} totalFiles - [count] total number of files to transfer. note: this value will be 0 if pre-processing is false
   * @property {number} filesSent - [count] total number of files sent
   * @property {number} filesSentProgress - [count] total number of files sent (in percentage)
   *
   * @property {number} totalFileSize - [size] total size to transfer. note: this value will be 0 if pre-processing was false
   * @property {number} totalFileSizeSent - [size] total size sent
   * @property {number} totalFileProgress - [size] total size sent (in percentage)
   *
   * @property {number} activeFileSize - [size] total size of the current file
   * @property {number} activeFileSizeSent - [size] total size of the current file sent
   * @property {number} activeFileProgress - [size] total size of the current file sent (in percentage)
   *
   * @property {string} currentFile - current file (full path)
   * @property {int} speed - speed in MBs
   * @property {string} elapsedTime - elapsed time
   *
   * @property {'upload'|'download'} direction - direction of file transfer
   */

  /**
   * @typedef {function()} completedCallback
   * @callback completedCallback
   */

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
  async transferFiles({
    deviceType,
    destination,
    fileList,
    direction,
    storageId,
    onError,
    onPreprocess,
    onProgress,
    onCompleted,
  }) {
    let invoked = false;
    const notify = createTransferFinalizer({
      onCompleted,
      onError,
      onNotificationError: (error) => log.error(error),
    });

    try {
      checkIf(deviceType, 'string');
      checkIf(direction, 'string');
      checkIf(fileList, 'array');
      checkIf(storageId, 'number');
      checkIf(onError, 'function');
      checkIf(onPreprocess, 'function');
      checkIf(onProgress, 'function');
      checkIf(onCompleted, 'function');

      if (isEmpty(destination)) {
        throw new Error('Invalid path');
      }

      if (isEmpty(fileList) || !isArray(fileList)) {
        throw new Error('No files selected');
      }

      invoked = true;

      return await this.kalamFfi.transferFiles({
        direction,
        storageId,
        destination,
        preprocessFiles: getFilesPreprocessingBeforeTransferSetting({
          direction,
        }),
        sources: fileList,
        onPreprocess,
        onProgress: ({
          fullPath,
          elapsedTime,
          speed,
          totalFiles,
          filesSent,
          filesSentProgress,
          activeFileSize,
          bulkFileSize,
        }) => {
          onProgress({
            currentFile: fullPath,
            elapsedTime: msToTime(elapsedTime),
            speed,
            totalFiles,
            filesSent,
            filesSentProgress,
            totalFileSize: bulkFileSize.total,
            totalFileSizeSent: bulkFileSize.sent,
            totalFileProgress: bulkFileSize.progress,
            activeFileSize: activeFileSize.total,
            activeFileSizeSent: activeFileSize.sent,
            activeFileProgress: activeFileSize.progress,
            direction,
          });
        },
        onError: notify,
        onCompleted: notify,
      });
    } catch (e) {
      const result = createTransferResult({
        status: invoked ? 'unknown' : 'failed',
        backend: 'kalam',
        direction,
        error: e,
        reason: 'adapter-error',
        backendStopped: invoked ? null : true,
        files: { requested: fileList },
      });

      notify(result);

      return result;
    }
  }

  /**
   * description: fetch the required data for generating bug/error reports
   *
   * @return {Promise<{data: string|null, error: string|null, stderr: string|null}>}
   */
  async fetchDebugReport() {
    try {
      const { data, error, stderr } = await this._exec(kalamDebugReportCli);

      if (error) {
        log.doLog(error, `FileExplorerKalamDataSource.fetchDebugReport.error`);

        return { error, stderr, data: null };
      }

      if (stderr) {
        log.doLog(
          stderr,
          `FileExplorerKalamDataSource.fetchDebugReport.stderr`
        );

        return { error, stderr, data: null };
      }

      return { error: null, stderr: null, data };
    } catch (e) {
      log.error(e);

      return { error: e, stderr: null, data: null };
    }
  }
}
