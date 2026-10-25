import koffi from 'koffi';
import mtpOperationQueue from '../../../app/data/file-explorer/MtpOperationQueue';
import { MTP_ERROR } from '../../../app/enums/mtpError';
import { kalamLibPath } from '../../../app/helpers/binaries';
import { log } from '../../../app/utils/log';
import { undefinedOrNull } from '../../../app/utils/funcs';
import { checkIf } from '../../../app/utils/checkIf';
import { FILE_TRANSFER_DIRECTION } from '../../../app/enums';
import {
  createTransferFinalizer,
  createTransferResult,
} from '../../../app/data/file-explorer/transferResult';

export class Kalam {
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
    this.libPath = kalamLibPath;
    this.lib = koffi.load(this.libPath);

    this.callbackDictionary = Object.freeze({
      onCbResult: koffi.proto('void on_cb_result_t(char*)'),
    });

    this.fnDictionary = Object.freeze({
      Initialize: 'void Initialize(on_cb_result_t* onDonePtr)',
      FetchDeviceInfo: 'void FetchDeviceInfo(on_cb_result_t* onDonePtr)',
      FetchStorages: 'void FetchStorages(on_cb_result_t* onDonePtr)',
      FileExists:
        'void FileExists(char* fileExistsInputJson, on_cb_result_t* onDonePtr)',
      DeleteFile:
        'void DeleteFile(char* deleteFileInputJson, on_cb_result_t* onDonePtr)',
      MakeDirectory:
        'void MakeDirectory(char* makeDirectoryInputJson, on_cb_result_t* onDonePtr)',
      RenameFile:
        'void RenameFile(char* renameFileInputJson, on_cb_result_t* onDonePtr)',
      Walk: 'void Walk(char* walkInputJson, on_cb_result_t* onDonePtr)',
      DownloadFiles:
        'void DownloadFiles(char* downloadFilesInputJson, on_cb_result_t* onPreprocessPtr, on_cb_result_t* onProgressPtr, on_cb_result_t* onDonePtr)',
      UploadFiles:
        'void UploadFiles(char* uploadFilesInputJson, on_cb_result_t* onPreprocessPtr, on_cb_result_t* onProgressPtr, on_cb_result_t* onDonePtr)',
      Dispose: 'void Dispose(on_cb_result_t* onDonePtr)',
    });
  }

  _getNapiError(error) {
    return {
      error,
      stderr: null,
      data: null,
    };
  }

  _getData(value) {
    return {
      error: value?.error === '' ? null : value?.error,
      stderr: value?.errorType === '' ? null : value?.errorType,
      data: value?.data,
    };
  }

  // Result delivery and execution termination are separate events. Only the
  // Koffi return callback (or failed submission) settles this queued task.
  _invoke(name, args = []) {
    const hooks = this.executionHooks ? this.executionHooks() : undefined;
    const lifecycle = name === 'Initialize' || name === 'Dispose';

    return mtpOperationQueue.run(
      () =>
        new Promise((resolve) => {
          let callback;
          let finished = false;
          let result;
          let failure;
          let nativeStarted = false;
          let nativeReturned = false;
          const recordFailure = (error) => {
            if (!failure) {
              failure = {
                ...this._getNapiError(error),
                stderr: MTP_ERROR.ErrorGeneral,
              };
            }
          };
          // This is a main-process adapter hook, never data supplied by native
          // JSON. The current ABI cannot acknowledge USB/session cleanup.
          const reportExecution = (terminal) => {
            if (!lifecycle || !hooks?.onLifecycleEvidence) return;
            try {
              hooks.onLifecycleEvidence(
                Object.freeze({
                  version: 1,
                  terminal,
                  nativeStarted,
                  nativeReturned,
                  resources: nativeStarted ? 'unknown' : 'none',
                  cleanupAcknowledged: false,
                })
              );
            } catch (error) {
              recordFailure(error);
            }
          };
          const finish = (error) => {
            if (finished) {
              return;
            }

            finished = true;

            if (!undefinedOrNull(error)) {
              recordFailure(error);
            }

            if (callback) {
              try {
                koffi.unregister(callback);
              } catch (cleanupError) {
                recordFailure(cleanupError);
              }
            }

            if (!result && !failure) {
              recordFailure(
                new Error(`Native ${name} returned without a result.`)
              );
            }

            reportExecution(true);
            resolve(failure || result);
          };

          try {
            const fn = this.lib.func(this.fnDictionary[name]);

            callback = koffi.register((payload) => {
              if (finished) {
                return;
              }

              try {
                const envelope = JSON.parse(payload);

                if (
                  !envelope ||
                  Array.isArray(envelope) ||
                  typeof envelope.error !== 'string' ||
                  typeof envelope.errorType !== 'string' ||
                  !Object.prototype.hasOwnProperty.call(envelope, 'data')
                ) {
                  throw new Error(`Invalid native ${name} result.`);
                }

                const value = this._getData(envelope);

                if (value.error || value.stderr) {
                  if (!failure) {
                    failure = {
                      ...value,
                      stderr: value.stderr || MTP_ERROR.ErrorGeneral,
                    };
                  }
                } else if (
                  result &&
                  JSON.stringify(result) !== JSON.stringify(value)
                ) {
                  recordFailure(
                    new Error(`Conflicting native ${name} results.`)
                  );
                } else {
                  result = value;
                }
              } catch (parseError) {
                recordFailure(parseError);
              }
            }, koffi.pointer(this.callbackDictionary.onCbResult));

            // A throw from inside async submission is treated conservatively:
            // only setup failures before this boundary prove non-invocation.
            nativeStarted = true;
            reportExecution(false);
            fn.async(...args, callback, (error) => {
              if (finished) return;
              nativeReturned = true;
              finish(error);
            });
          } catch (error) {
            // Preserve failed-submission settlement, without using it as proof
            // that native resources were never acquired.
            finish(error);
          }
        }),
      hooks
    );
  }

  async initialize() {
    return this._invoke('Initialize');
  }

  async fetchDeviceInfo() {
    return this._invoke('FetchDeviceInfo');
  }

  async listStorages() {
    return this._invoke('FetchStorages');
  }

  async makeDirectory({ storageId, fullPath }) {
    checkIf(storageId, 'number');
    checkIf(fullPath, 'string');

    return this._invoke('MakeDirectory', [
      JSON.stringify({ storageId: parseInt(storageId, 10), fullPath }),
    ]);
  }

  async fileExist({ storageId, files }) {
    checkIf(storageId, 'number');
    checkIf(files, 'array');

    return this._invoke('FileExists', [
      JSON.stringify({ storageId: parseInt(storageId, 10), files }),
    ]);
  }

  async deleteFile({ storageId, files }) {
    checkIf(storageId, 'number');
    checkIf(files, 'array');

    return this._invoke('DeleteFile', [
      JSON.stringify({ storageId: parseInt(storageId, 10), files }),
    ]);
  }

  async renameFile({ storageId, fullPath, newFilename }) {
    checkIf(storageId, 'number');
    checkIf(fullPath, 'string');
    checkIf(newFilename, 'string');

    return this._invoke('RenameFile', [
      JSON.stringify({
        storageId: parseInt(storageId, 10),
        fullPath,
        newFileName: newFilename,
      }),
    ]);
  }

  async walk({ storageId, fullPath, skipHiddenFiles }) {
    checkIf(storageId, 'number');
    checkIf(fullPath, 'string');
    checkIf(skipHiddenFiles, 'boolean');

    return this._invoke('Walk', [
      JSON.stringify({
        storageId: parseInt(storageId, 10),
        fullPath,
        recursive: false,
        skipDisallowedFiles: false,
        skipHiddenFiles,
      }),
    ]);
  }

  async transferFiles({
    direction,
    storageId,
    sources,
    destination,
    preprocessFiles,
    onError,
    onPreprocess,
    onProgress,
    onCompleted,
  }) {
    return mtpOperationQueue.run(
      () =>
        new Promise((resolve) => {
          const callbacks = [];
          let finished = false;
          let failure = null;
          let acknowledged = false;
          const notify = createTransferFinalizer({
            onCompleted,
            onError,
            onNotificationError: (error) => log.error(error),
          });
          const recordFailure = (status, error, reason, stderr = null) => {
            if (!failure) {
              failure = { status, error, reason, stderr };
            }
          };
          const finish = () => {
            if (finished) {
              return;
            }

            finished = true;

            // Only called after native return, or when invocation setup failed.
            callbacks.forEach((callback) => {
              try {
                koffi.unregister(callback);
              } catch (error) {
                recordFailure('unknown', error, 'callback-cleanup-error');
              }
            });

            const result = createTransferResult({
              backend: 'kalam',
              direction,
              files: { requested: sources },
              backendStopped: true,
              evidence: { nativeAcknowledged: acknowledged },
              ...(failure || {
                status: acknowledged ? 'completed' : 'unknown',
                reason: acknowledged
                  ? 'native-success'
                  : 'missing-native-result',
              }),
            });

            try {
              notify(result);
            } finally {
              resolve(result);
            }
          };
          const register = (handler) => {
            const callback = koffi.register((payload) => {
              if (finished) {
                return;
              }

              try {
                const envelope = JSON.parse(payload);

                if (
                  !envelope ||
                  Array.isArray(envelope) ||
                  typeof envelope.error !== 'string' ||
                  typeof envelope.errorType !== 'string' ||
                  !Object.prototype.hasOwnProperty.call(envelope, 'data')
                ) {
                  throw new Error('Invalid native transfer result.');
                }

                if (envelope.error || envelope.errorType) {
                  recordFailure(
                    'failed',
                    envelope.error || envelope.errorType,
                    'native-error',
                    envelope.errorType
                  );

                  return;
                }

                handler(envelope.data);
              } catch (error) {
                recordFailure('unknown', error, 'malformed-native-result');
              }
            }, koffi.pointer(this.callbackDictionary.onCbResult));

            callbacks.push(callback);

            return callback;
          };

          try {
            checkIf(direction, 'string');
            checkIf(storageId, 'number');
            checkIf(sources, 'array');
            checkIf(destination, 'string');
            checkIf(preprocessFiles, 'boolean');
            checkIf(onError, 'function');
            checkIf(onPreprocess, 'function');
            checkIf(onProgress, 'function');
            checkIf(onCompleted, 'function');

            let TransferFiles;

            switch (direction) {
              case FILE_TRANSFER_DIRECTION.download:
                TransferFiles = this.lib.func(this.fnDictionary.DownloadFiles);

                break;
              case FILE_TRANSFER_DIRECTION.upload:
                TransferFiles = this.lib.func(this.fnDictionary.UploadFiles);

                break;

              default:
                throw new Error(
                  "Unsupported 'direction' in Kalam.transferFiles."
                );
            }

            const json = JSON.stringify({
              storageId: parseInt(storageId, 10),
              sources,
              destination,
              preprocessFiles,
            });
            const progress = (callback) => (data) => {
              if (!data || typeof data !== 'object' || Array.isArray(data)) {
                throw new Error('Invalid native transfer progress.');
              }

              if (!failure && !acknowledged) {
                callback({ ...data });
              }
            };
            const rawOnFfiPreprocessPtr = register(progress(onPreprocess));
            const rawOnFfiProgressPtr = register(progress(onProgress));
            const rawOnDonePtr = register((data) => {
              if (data !== true) {
                throw new Error('Native transfer did not acknowledge success.');
              }

              acknowledged = true;
            });

            TransferFiles.async(
              json,
              rawOnFfiPreprocessPtr,
              rawOnFfiProgressPtr,
              rawOnDonePtr,
              (err, _) => {
                if (!undefinedOrNull(err)) {
                  recordFailure('unknown', err, 'ffi-error');
                }

                finish();
              }
            );
          } catch (err) {
            recordFailure('failed', err, 'ffi-setup-error');
            finish();
          }
        }),
      this.executionHooks ? this.executionHooks() : undefined
    );
  }

  async dispose() {
    return this._invoke('Dispose');
  }
}
