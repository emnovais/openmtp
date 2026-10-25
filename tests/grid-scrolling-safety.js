// Defense in depth for offline tests: never load USB/Kalam or execute MTP tools.
const fs = require('fs');
const path = require('path');
const Module = require('module');
const childProcess = require('child_process');

const artifacts = process.env.OPENMTP_T3_ARTIFACTS;
const privateArtifacts =
  artifacts &&
  path.dirname(artifacts) === '/private/tmp' &&
  path.basename(artifacts).startsWith('openmtp-t3-');
const reject = (kind, value) => {
  if (privateArtifacts) {
    fs.appendFileSync(
      path.join(artifacts, 'blocked-access.jsonl'),
      `${JSON.stringify({ kind, value: String(value) })}\n`
    );
  }

  throw new Error(`Offline scrolling tests prohibit ${kind}: ${value}`);
};
const originalLoad = Module._load;

Module._load = function (name, ...args) {
  if (
    /^(koffi|usb-detection|usb)$/.test(name) ||
    /ffi\/kalam\/src\/Kalam/.test(name)
  ) {
    return reject('native device module', name);
  }

  return originalLoad.call(this, name, ...args);
};

['exec', 'execFile', 'spawn', 'execSync', 'execFileSync', 'spawnSync'].forEach(
  (name) => {
    const original = childProcess[name];

    childProcess[name] = function (command, ...args) {
      if (
        /mtp-cli|kalam_debug_report|kalam\.dylib|system_profiler|ioreg|\badb\b/.test(
          `${String(command)} ${JSON.stringify(args)}`
        )
      ) {
        return reject('physical process', command);
      }

      return original.call(this, command, ...args);
    };
  }
);
