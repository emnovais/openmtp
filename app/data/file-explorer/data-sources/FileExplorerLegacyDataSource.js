import path from 'path';
import findLodash from 'lodash/find';
import { execFile, spawn } from 'child_process';
import { StringDecoder } from 'node:string_decoder';
import { log } from '../../../utils/log';
import {
  isArray,
  isEmpty,
  percentage,
  splitIntoLines,
  undefinedOrNull,
} from '../../../utils/funcs';
import { DEVICES_LABEL } from '../../../constants';
import { DEVICE_TYPE, FILE_TRANSFER_DIRECTION } from '../../../enums';
import { baseName, getExtension } from '../../../utils/files';
import { mtpCliPath } from '../../../helpers/binaries';
import { msToTime, unixTimestampNow } from '../../../utils/date';
import { checkIf } from '../../../utils/checkIf';
import mtpOperationQueue from '../MtpOperationQueue';
import {
  createTransferFinalizer,
  createTransferResult,
} from '../transferResult';

// Each argv entry is one CLI command, not an OS shell expression. Keep the
// internal CLI quoting deliberately narrow; unsupported paths retain icons.
export function legacyThumbnailArgs({
  filePath,
  storageId,
  destination,
  cacheDirectory,
}) {
  const unsafe = (value) =>
    /["\\]/.test(value) ||
    Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    );

  if (
    !Number.isInteger(storageId) ||
    storageId < 0 ||
    storageId > 0xffffffff ||
    typeof filePath !== 'string' ||
    !filePath.startsWith('/') ||
    path.posix.normalize(filePath) !== filePath ||
    filePath === '/' ||
    !/\.(jpe?g|png)$/i.test(filePath) ||
    unsafe(filePath) ||
    typeof cacheDirectory !== 'string' ||
    !path.isAbsolute(cacheDirectory) ||
    path.normalize(cacheDirectory) !== cacheDirectory ||
    !/^openmtp-legacy-thumb-[\w-]+$/.test(path.basename(cacheDirectory)) ||
    typeof destination !== 'string' ||
    path.dirname(destination) !== cacheDirectory ||
    !/^[a-f0-9]{32}\.thumb$/.test(path.basename(destination)) ||
    unsafe(destination)
  )
    throw new Error('Unsafe Legacy thumbnail request.');

  return [`storage ${storageId}`, `get-thumb "${filePath}" "${destination}"`];
}

export class FileExplorerLegacyDataSource {
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
  }

  // Escape for the CLI tokenizer only. No OS shell parses these arguments.
  _escapeShellMtp(value) {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  _filterOutMtpLines(string, index) {
    return (
      this._filterJunkMtpErrors(string) ||
      (index < 2 && string.toLowerCase().indexOf(`selected storage`) !== -1)
    );
  }

  _filterJunkMtpErrors(string) {
    return (
      string === '\n' ||
      string === '\r\n' ||
      string === '' ||
      string.toLowerCase().indexOf(`device::find failed`) !== -1 ||
      string.toLowerCase().indexOf(`iocreateplugininterfaceforservice`) !==
        -1 ||
      string.toLowerCase().indexOf(`Device::Find failed`) !== -1
    );
  }

  _cleanJunkMtpError({ error = null, stdout = null, stderr = null }) {
    const splittedError = splitIntoLines(error);
    const filteredError = splittedError
      ? splittedError.filter((a) => !this._filterJunkMtpErrors(a))
      : [];

    const splittedStderr = splitIntoLines(stderr);
    const filteredStderr = splittedStderr
      ? splittedStderr.filter((a) => !this._filterJunkMtpErrors(a))
      : [];

    return {
      filteredError,
      filteredStderr,
      filteredStdout: stdout,
    };
  }

  // Leaf execution boundary: callers such as filesExist() may invoke this
  // helper repeatedly, but must not hold another lease on the same lane.
  _runCommand(command, cleanErrors, withExecution = false) {
    return mtpOperationQueue.run(
      () =>
        new Promise((resolve) => {
          let child;
          let finished = false;
          let output;
          let spawnError;
          const finish = (
            exitCode = null,
            signal = null,
            processClosed = false
          ) => {
            if (finished) {
              return;
            }

            finished = true;

            try {
              const {
                error: callbackError,
                stdout = null,
                stderr = null,
              } = output || {
                error:
                  spawnError ||
                  new Error('Legacy command closed without a result.'),
              };
              const error = spawnError || callbackError;

              if (withExecution) {
                resolve({
                  data: stdout,
                  stderr,
                  error: error ?? null,
                  exitCode,
                  signal,
                  processClosed,
                });

                return;
              }

              const { filteredStderr, filteredError, filteredStdout } =
                this._cleanJunkMtpError({ error, stdout, stderr });

              if (filteredStderr.length === 0 && filteredError.length === 0) {
                resolve({ data: filteredStdout, stderr: null, error: null });
              } else if (cleanErrors) {
                resolve({
                  data: filteredStdout,
                  stderr: filteredStderr.join('\n'),
                  error: filteredError.join('\n'),
                });
              } else {
                resolve({ data: stdout, stderr, error });
              }
            } catch (error) {
              resolve({ error, stderr: null, data: null });
            }
          };

          try {
            if (
              !Array.isArray(command) ||
              command.some((value) => typeof value !== 'string')
            ) {
              throw new Error('Legacy commands require literal argv.');
            }

            child = execFile(
              mtpCliPath,
              command,
              { shell: false },
              (error, stdout, stderr) => {
                if (!finished) output = { error, stdout, stderr };
              }
            );
            child.once('close', (code, signal) => finish(code, signal, true));
            child.on('error', (error) => {
              spawnError = error;
            });
          } catch (error) {
            spawnError = error;

            if (!child) finish();
            // If a child exists, retain ownership until its close notification.
          }
        }),
      this.executionHooks ? this.executionHooks() : undefined
    );
  }

  async _exec(command) {
    return this._runCommand(command, true);
  }

  async _execNoCatch(command) {
    return this._runCommand(command, false);
  }

  readThumbnail(args) {
    const argv = legacyThumbnailArgs(args);
    const hooks = this.executionHooks ? this.executionHooks() : {};

    if (typeof args.isCurrent !== 'function')
      throw new Error('Missing thumbnail fence.');

    return mtpOperationQueue.run(
      () =>
        new Promise((resolve) => {
          let child;
          let spawnError;
          let stderr = '';
          let closed = false;
          const finish = (code, signal, processClosed = false) => {
            if (closed) return;
            closed = true;
            const error =
              spawnError ||
              (!processClosed || code !== 0 || signal !== null
                ? new Error('Legacy thumbnail command failed.')
                : null);

            // Preserve diagnostics without equating thumbnail output with USB
            // session health. Only this operation validates its output separately.
            if (stderr)
              log.error(
                stderr,
                'Legacy thumbnail CLI diagnostics',
                true,
                true,
                false
              );

            resolve({
              error,
              stderr: stderr || null,
              data: error ? null : true,
              exitCode: code,
              signal,
              processClosed,
            });
          };

          try {
            child = spawn(mtpCliPath, argv, {
              shell: false,
              cwd: args.cacheDirectory,
              stdio: ['ignore', 'ignore', 'pipe'],
            });
            child.on('error', (error) => {
              spawnError = spawnError || error;
            });
            child.once('close', (code, signal) => finish(code, signal, true));
            child.stderr.on('data', (chunk) => {
              if (stderr.length < 65536)
                stderr += String(chunk).slice(0, 65536 - stderr.length);
            });
          } catch (error) {
            spawnError = error;
            // A returned child retains the lane until close, even after errors.
            if (!child) finish(null, null);
          }
        }),
      {
        ...hooks,
        beforeStart: (context) => {
          if (hooks.beforeStart?.(context) === false) return false;

          return args.isCurrent();
        },
      }
    );
  }

  async _checkMtpFileExists(filePath, storageId) {
    const hasControl = (value) =>
      Array.from(value).some((character) => {
        const code = character.charCodeAt(0);

        return code < 32 || code === 127;
      });
    const unknown = (message, result = {}) => ({
      error: result.error || new Error(result.stderr || message),
      stderr: result.stderr ?? null,
      data: null,
    });

    if (
      typeof filePath !== 'string' ||
      !path.posix.isAbsolute(filePath) ||
      path.posix.normalize(filePath) !== filePath ||
      filePath === '/' ||
      /["\\]/.test(filePath) ||
      hasControl(filePath) ||
      !Number.isInteger(storageId) ||
      storageId <= 0 ||
      storageId >= 0xffffffff
    )
      return unknown('Unable to verify destination: invalid Legacy lookup.');

    const parent = path.posix.dirname(filePath);
    const filename = path.posix.basename(filePath);
    const commands = [
      `storage ${storageId}`,
      `cd "${parent}"`,
      'pwd',
      'ls',
      'pwd',
    ];
    const result = await this._runCommand(commands, false, true);

    if (
      result.processClosed !== true ||
      result.exitCode !== 0 ||
      result.signal !== null ||
      result.error ||
      result.stderr ||
      typeof result.data !== 'string' ||
      !result.data.endsWith('\n')
    )
      return unknown(
        'Unable to verify destination: Legacy lookup failed.',
        result
      );

    const lines = result.data.replace(/\r\n/g, '\n').split('\n');

    lines.pop();
    let headers = 0;
    let selectedStorage;

    while (lines[0]?.startsWith('selected storage ')) {
      const header = /^selected storage (\d+)(?: .*)?$/.exec(lines.shift());

      if (!header || headers >= 2)
        return unknown(
          'Unable to verify destination: invalid storage response.'
        );
      selectedStorage = Number(header[1]);
      headers += 1;
    }

    const matchesParent = (value) =>
      value === parent || (parent !== '/' && value === `${parent}/`);

    // Both path echoes are required: an empty or unfinished listing alone
    // cannot establish absence. Unexpected stdout is never silently skipped.
    if (
      headers === 0 ||
      selectedStorage !== storageId ||
      lines.length < 2 ||
      !matchesParent(lines.shift()) ||
      !matchesParent(lines.pop())
    )
      return unknown(
        'Unable to verify destination: incomplete Legacy listing.'
      );

    const identifiers = new Set();
    const names = new Set();

    for (const line of lines) {
      const identifier = line.slice(0, 10).trim();
      const name = line.slice(11);
      const number = Number(identifier);

      if (
        !/^(?:\d+|0x[0-9a-f]+)$/i.test(identifier) ||
        !Number.isInteger(number) ||
        number <= 0 ||
        number >= 0xffffffff ||
        line[10] !== ' ' ||
        name.length === 0 ||
        name === '.' ||
        name === '..' ||
        name.includes('/') ||
        hasControl(name) ||
        identifiers.has(number) ||
        names.has(name)
      )
        return unknown('Unable to verify destination: invalid Legacy listing.');
      identifiers.add(number);
      names.add(name);
    }

    return names.has(filename);
  }

  /**
   * description - file transfer helper
   *
   * @param {[string]} cmdArgs - command line strings in an array
   * @param {errorCallback} onError
   * @param {progressCallback} onProgress
   * @param {completedCallback} onCompleted
   * @return {Promise<{data: boolean, error: string|null, stderr: string|null}>}
   * @private
   */
  async _transferFiles({
    cmdArgs,
    direction,
    fileList,
    onError,
    onProgress,
    onCompleted,
  }) {
    return mtpOperationQueue.run(
      () =>
        new Promise((resolve) => {
          let transferList = null;
          let interval;
          let finished = false;
          let failure = null;
          let diagnosticText = '';
          let diagnosticsTruncated = false;
          let cmd;
          let prevCopiedBlockSize = 0;
          let currentCopiedBlockSize = 0;
          let startTime = 0;
          let prevCopiedTime = 0;
          let currentCopiedTime = 0;
          const notify = createTransferFinalizer({
            onCompleted,
            onError,
            onNotificationError: (error) => log.error(error),
          });
          const recordFailure = (status, error, reason) => {
            if (!failure) {
              failure = { status, error, reason };
            }
          };
          const parseStdout = (line) => {
            if (line.startsWith(':done')) {
              prevCopiedBlockSize = 0;
              currentCopiedBlockSize = 0;
              prevCopiedTime = 0;
              currentCopiedTime = 0;

              return;
            }

            const match = line.match(/^:progress\s+(.+)\s+(\d+)\s+(\d+)\s*$/);

            if (!match) {
              return;
            }

            const currentProgressSize = Number(match[2]);
            const totalFileSize = Number(match[3]);

            if (startTime === 0) {
              startTime = unixTimestampNow();
            }

            currentCopiedBlockSize = totalFileSize - currentProgressSize;
            currentCopiedTime = unixTimestampNow();
            transferList = {
              currentFile: match[1],
              activeFileSize: totalFileSize,
              activeFileSizeSent: currentProgressSize,
              percentage: percentage(currentProgressSize, totalFileSize),
            };
          };
          const parseStderr = (line) => {
            if (!line.trim()) return;
            const text = diagnosticText ? `\n${line}` : line;

            if (diagnosticText.length + text.length > 65536)
              diagnosticsTruncated = true;
            diagnosticText = (diagnosticText + text).slice(0, 65536);
            // Discovery diagnostics lack interface identity. Do not assume they
            // are harmless to this transfer, even after a zero process exit.
            const uncertain = this._filterJunkMtpErrors(line);

            recordFailure(
              uncertain ? 'unknown' : 'failed',
              line,
              uncertain ? 'cli-diagnostic' : 'cli-stderr'
            );
          };
          const streamReader = (consumeLine) => {
            const decoder = new StringDecoder('utf8');
            let buffered = '';

            return (chunk, end = false) => {
              buffered += end ? decoder.end() : decoder.write(chunk);

              const lines = buffered.split(/\r\n|\r|\n/);

              buffered = end ? '' : lines.pop();
              lines.forEach(consumeLine);
            };
          };
          const readStdout = streamReader(parseStdout);
          const readStderr = streamReader(parseStderr);
          const recordExit = (code, signal) => {
            if (signal) {
              recordFailure(
                'unknown',
                `Transfer process terminated by ${signal}.`,
                'process-signal'
              );
            } else if (code !== 0) {
              recordFailure(
                code === null ? 'unknown' : 'failed',
                `Transfer process exited with code ${code}.`,
                'process-exit'
              );
            }
          };
          const finish = (code, signal, backendStopped = true) => {
            if (finished) {
              return;
            }

            finished = true;
            clearInterval(interval);
            try {
              readStdout(null, true);
              readStderr(null, true);
            } catch (error) {
              recordFailure('unknown', error, 'stream-error');
            }

            recordExit(code, signal);

            const result = createTransferResult({
              backend: 'legacy',
              direction,
              backendStopped,
              files: { requested: fileList },
              evidence: { exitCode: code, signal, diagnosticsTruncated },
              stderr: diagnosticText || null,
              ...(failure || { status: 'completed', reason: 'cli-success' }),
            });

            try {
              notify(result);
            } finally {
              resolve(result);
            }
          };

          try {
            checkIf(cmdArgs, 'array');
            checkIf(onError, 'function');
            checkIf(onProgress, 'function');
            checkIf(onCompleted, 'function');

            cmd = spawn(mtpCliPath, [...cmdArgs], { shell: false });
            // Observe closure before setting up streams/timers. Setup errors after
            // spawn must not release the lane while this child is still active.
            cmd.on('close', (code, signal) => finish(code, signal));
            cmd.on('error', (error) => {
              recordFailure('failed', error, 'spawn-error');
            });
            cmd.stdout.on('data', (chunk) => {
              if (!finished) readStdout(chunk);
            });
            cmd.stderr.on('data', (chunk) => {
              if (!finished) readStderr(chunk);
            });
            cmd.stdout.on('error', (error) => {
              recordFailure('unknown', error, 'stdout-error');
            });
            cmd.stderr.on('error', (error) => {
              recordFailure('unknown', error, 'stderr-error');
            });
            cmd.on('exit', recordExit);

            interval = setInterval(() => {
              if (finished || failure || !transferList) {
                return;
              }

              const copiedTimeDiff = currentCopiedTime - prevCopiedTime;
              const speed =
                prevCopiedBlockSize &&
                prevCopiedBlockSize - currentCopiedBlockSize > 0 &&
                copiedTimeDiff > 0
                  ? (prevCopiedBlockSize - currentCopiedBlockSize) *
                    (1000 / copiedTimeDiff)
                  : 0;

              prevCopiedTime = currentCopiedTime;
              prevCopiedBlockSize = currentCopiedBlockSize;

              try {
                onProgress({
                  elapsedTime: msToTime(currentCopiedTime - startTime),
                  speed,
                  activeFileProgress: transferList.percentage,
                  currentFile: transferList.currentFile,
                  activeFileSize: transferList.activeFileSize,
                  activeFileSizeSent: transferList.activeFileSizeSent,
                });
              } catch (error) {
                log.error(error);
              }
            }, 1000);
          } catch (error) {
            recordFailure(
              cmd ? 'unknown' : 'failed',
              error,
              'spawn-setup-error'
            );
            if (!cmd) finish(null, null, true);
          }
        }),
      this.executionHooks ? this.executionHooks() : undefined
    );
  }

  /**
   * description - Fetch MTP storages
   *
   * @return {Promise<{data: object|boolean, error: string|null, stderr: string|null}>}
   */
  async listStorages() {
    try {
      const { data, error, stderr } = await this._exec(['storage-list']);

      if (error || stderr) {
        log.error(
          `${error} : ${stderr}`,
          `FileExplorerLegacyDataSource.listStorages -> storage-list error`,
          false
        );

        return { error, stderr, data: null };
      }

      const _storageList = splitIntoLines(data);

      const descMatchPattern = /description:(.*)/i;
      const storageIdMatchPattern = /([^\D]+)/;

      let storageList = {};

      _storageList
        .filter((a, index) => !this._filterOutMtpLines(a, index))
        .map((a, index) => {
          if (!a) {
            return null;
          }

          const _matchDesc = descMatchPattern.exec(a);
          const _matchedStorageIds = storageIdMatchPattern.exec(a);

          if (
            undefinedOrNull(_matchDesc) ||
            undefinedOrNull(_matchDesc[1]) ||
            undefinedOrNull(_matchedStorageIds) ||
            undefinedOrNull(_matchedStorageIds[1])
          ) {
            return null;
          }

          const matchDesc = _matchDesc[1].trim();
          const matchedStorageId = parseInt(_matchedStorageIds[1].trim(), 10);

          storageList = {
            ...storageList,
            [matchedStorageId]: {
              name: matchDesc,
              selected: index === 0,
            },
          };

          return storageList;
        });

      if (undefinedOrNull(storageList) || storageList.length < 1) {
        return {
          error: `${DEVICES_LABEL[DEVICE_TYPE.mtp]} storage not accessible`,
          stderr: null,
          data: null,
        };
      }

      return { error: null, stderr: null, data: storageList };
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
    try {
      const mtpCmdChopIndex = {
        type: 2,
        dateAdded: 4,
        timeAdded: 5,
      };
      const response = [];
      const storageSelectCmd = `storage ${storageId}`;

      const {
        data: filePropsData,
        error: filePropsError,
        stderr: filePropsStderr,
      } = await this._exec([
        storageSelectCmd,
        `lsext "${this._escapeShellMtp(filePath)}"`,
      ]);

      if (filePropsError || filePropsStderr) {
        log.error(
          `${filePropsError} : ${filePropsStderr}`,
          `listFiles -> lsext error`
        );

        return { error: filePropsError, stderr: filePropsStderr, data: null };
      }

      let fileProps = splitIntoLines(filePropsData);

      fileProps = fileProps.filter(
        (a, index) => !this._filterOutMtpLines(a, index)
      );

      for (let i = 0; i < fileProps.length; i += 1) {
        const item = fileProps[i];
        const matchedProps = item.match(
          /^(.*?)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/g
        );

        if (matchedProps === null || matchedProps.length < 1) {
          continue; // eslint-disable-line no-continue
        }

        const _matchedProps = matchedProps[0];
        const itemSplit = item.split(_matchedProps);

        if (itemSplit === null || itemSplit.length < 2 || itemSplit[1] === '') {
          continue; // eslint-disable-line no-continue
        }

        const matchedFileName = itemSplit[1].replace(/^\s{2}|\s$/g, '');
        const filePropsList = _matchedProps.replace(/\s\s+/g, ' ').split(' ');

        // eslint-disable-next-line no-useless-escape
        if (ignoreHidden && /(^|\/)\.[^\/\.]/g.test(matchedFileName)) {
          continue; // eslint-disable-line no-continue
        }

        const fullPath = path.resolve(filePath, matchedFileName);
        const isFolder = filePropsList[mtpCmdChopIndex.type] === '3001';
        const dateTime = `${filePropsList[mtpCmdChopIndex.dateAdded]} ${
          filePropsList[mtpCmdChopIndex.timeAdded]
        }`;
        const extension = getExtension(fullPath, isFolder);

        // avoid duplicate values
        if (findLodash(response, { path: fullPath })) {
          continue; // eslint-disable-line no-continue
        }

        response.push({
          name: matchedFileName,
          path: fullPath,
          extension,
          size: null,
          isFolder,
          dateAdded: dateTime,
        });
      }

      return { error: null, stderr: null, data: response };
    } catch (e) {
      log.error(e);

      return { error: e, stderr: null, data: null };
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
    try {
      if (undefinedOrNull(filePath) || undefinedOrNull(newFilename)) {
        return { error: `No files selected.`, stderr: null, data: null };
      }

      const storageSelectCmd = `storage ${storageId}`;
      const escapedFilePath = `${this._escapeShellMtp(filePath)}`;
      const escapedNewFilename = `${this._escapeShellMtp(newFilename)}`;

      const { error, stderr } = await this._exec([
        storageSelectCmd,
        `rename "${escapedFilePath}" "${escapedNewFilename}"`,
      ]);

      if (error || stderr) {
        log.error(
          `${error} : ${stderr}`,
          `FileExplorerLegacyDataSource.renameFile -> rename error`
        );

        return { error, stderr, data: false };
      }

      return { error: null, stderr: null, data: true };
    } catch (e) {
      log.error(e);

      return { error: e, stderr: null, data: false };
    }
  }

  /**
   * description - Delete device files
   *
   * @param fileList
   * @param storageId
   * @return {Promise<{data: null|boolean, error: string|null, stderr: string|null}>}
   */
  async deleteFiles({ fileList, storageId }) {
    try {
      if (!fileList || fileList.length < 1) {
        return { error: `No files selected.`, stderr: null, data: null };
      }

      const storageSelectCmd = `storage ${storageId}`;

      for (let i = 0; i < fileList.length; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const { error, stderr } = await this._exec([
          storageSelectCmd,
          `rm "${this._escapeShellMtp(fileList[i])}"`,
        ]);

        if (error || stderr) {
          log.error(
            `${error} : ${stderr}`,
            `FileExplorerLegacyDataSource.deleteFiles -> rm error`
          );

          return { error, stderr, data: false };
        }
      }

      return { error: null, stderr: null, data: true };
    } catch (e) {
      log.error(e);

      return { error: e, stderr: null, data: false };
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
    try {
      if (undefinedOrNull(filePath)) {
        return { error: `Invalid path.`, stderr: null, data: null };
      }

      const storageSelectCmd = `storage ${storageId}`;
      const escapedFilePath = `${this._escapeShellMtp(filePath)}`;
      const { error, stderr } = await this._exec([
        storageSelectCmd,
        `mkpath "${escapedFilePath}"`,
      ]);

      if (error || stderr) {
        log.error(
          `${error} : ${stderr}`,
          `FileExplorerLegacyDataSource.makeDirectory -> mkpath error`
        );

        return { error, stderr, data: false };
      }

      return { error: null, stderr: null, data: true };
    } catch (e) {
      log.error(e);

      return { error: e, stderr: null, data: false };
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
    try {
      if (!isArray(fileList) || isEmpty(fileList))
        throw new Error('Invalid destination lookup paths.');

      let exists = false;

      for (let i = 0; i < fileList.length; i += 1) {
        const item = fileList[i];

        if (typeof item !== 'string' || !path.posix.isAbsolute(item))
          throw new Error('Invalid destination lookup path.');
        const fullPath = path.posix.normalize(item);
        // Each helper owns only its existing execution leaf, never this batch.
        // eslint-disable-next-line no-await-in-loop
        const result = await this._checkMtpFileExists(fullPath, storageId);

        if (typeof result !== 'boolean') {
          return result?.error || result?.stderr
            ? result
            : {
                error: new Error('Unknown Legacy destination state.'),
                data: null,
              };
        }

        exists = exists || result;
      }

      return exists;
    } catch (e) {
      log.error(e);

      return { error: e, stderr: null, data: null };
    }
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
   * @typedef {function(progressCallbackInfo)} progressCallback
   * @callback progressCallback
   * @param {progressCallbackInfo} args - progress object
   */

  /**
   * @typedef {Object} progressCallbackInfo
   * @property {number} activeFileSize - total size of the current file
   * @property {number} activeFileSizeSent - total bytes of the current file transferred
   * @property {number} activeFileProgress - progress of the current file
   * @property {string} currentFile - current file
   * @property {int} speed - speed in bytes
   * @property {string} elapsedTime - elapsed time
   */

  /**
   * @typedef {function()} completedCallback
   * @callback completedCallback
   */

  /**
   * description - Upload or download files from MTP device to local or vice versa
   *
   * @param {string} destination
   * @param {'upload'|'download'} direction
   * @param {[string]} fileList
   * @param {string} storageId
   * @param {errorCallback} onError
   * @param {progressCallback} onProgress
   * @param {completedCallback} onCompleted
   *
   * @return
   */
  async transferFiles({
    destination,
    fileList,
    direction,
    storageId,
    onError,
    onProgress,
    onCompleted,
  }) {
    const notify = createTransferFinalizer({
      onCompleted,
      onError,
      onNotificationError: (error) => log.error(error),
    });

    try {
      checkIf(onError, 'function');
      checkIf(onProgress, 'function');
      checkIf(onCompleted, 'function');

      if (undefinedOrNull(destination)) {
        throw new Error('Invalid path');
      }

      if (
        !Number.isInteger(storageId) ||
        storageId <= 0 ||
        storageId >= 0xffffffff ||
        ![
          FILE_TRANSFER_DIRECTION.upload,
          FILE_TRANSFER_DIRECTION.download,
        ].includes(direction) ||
        !Array.isArray(fileList) ||
        fileList.length === 0
      )
        throw new Error('Invalid transfer request.');
      const safePath = (value) =>
        typeof value === 'string' &&
        path.posix.isAbsolute(value) &&
        path.posix.normalize(value) === value &&
        !/["\\]/.test(value) &&
        !Array.from(value).some(
          (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127
        );

      if (
        !safePath(destination) ||
        fileList.some((item) => !safePath(item) || item === '/')
      )
        throw new Error('Unsupported transfer path quoting.');
      const sources = [...fileList];
      const cmdArgs = [
        '-e',
        `storage ${storageId}`,
        ...sources.map((sourcePath) => {
          const target =
            direction === FILE_TRANSFER_DIRECTION.download
              ? path.posix.join(destination, baseName(sourcePath))
              : destination;

          return `${
            direction === FILE_TRANSFER_DIRECTION.download ? 'get' : 'put'
          } "${sourcePath}" "${target}"`;
        }),
      ];

      return await this._transferFiles({
        cmdArgs,
        direction,
        fileList: sources,
        onError: notify,
        onProgress,
        onCompleted: notify,
      });
    } catch (e) {
      const result = createTransferResult({
        status: 'failed',
        backend: 'legacy',
        direction,
        error: e,
        reason: 'adapter-error',
        backendStopped: true,
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
      const { data, error, stderr } = await this._exec(['pwd', '-v']);

      if (error) {
        log.doLog(error, `FileExplorerLegacyDataSource.fetchDebugReport.error`);

        return { error, stderr, data: null };
      }

      if (stderr) {
        log.doLog(
          stderr,
          `FileExplorerLegacyDataSource.fetchDebugReport.stderr`
        );

        return { error, stderr, data: null };
      }

      return { error: null, stderr: null, data };
    } catch (e) {
      log.error(e);

      return { error: null, stderr: null, data: null };
    }
  }
}
