/* Offline Electron entry; OPENMTP_T3_ARTIFACTS must name a private temp directory. */
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

const artifactRoot = process.env.OPENMTP_T3_ARTIFACTS;

if (!artifactRoot || !/^\/private\/tmp\/openmtp-t3-/.test(artifactRoot)) {
  throw new Error('A private T3 artifacts directory is required');
}

require('./grid-scrolling-safety');

['profile', 'cache', 'temp', 'home'].forEach((directory) => {
  fs.mkdirSync(path.join(artifactRoot, directory), { recursive: true });
});
app.setPath('userData', path.join(artifactRoot, 'profile'));
app.setPath('cache', path.join(artifactRoot, 'cache'));
app.setPath('temp', path.join(artifactRoot, 'temp'));
require('os').homedir = () => path.join(artifactRoot, 'home');
require('os').tmpdir = () => path.join(artifactRoot, 'temp');

app.commandLine.appendSwitch('disable-background-networking');
const html = path.join(artifactRoot, 'grid-scrolling.html');
const renderer = path.join(__dirname, 'grid-scrolling-renderer.js');

fs.writeFileSync(
  html,
  `<!doctype html><html><head><meta charset="utf-8"><title>Offline T3 Grid tests</title></head><body style="margin:0"><div id="root"></div><script>require(${JSON.stringify(
    renderer
  )})</script></body></html>`
);
ipcMain.on('t4-capture', async (event, label) => {
  if (!/^(100|500|1000)-initial$/.test(label))
    throw new Error('Invalid capture label');
  const image = await event.sender.capturePage();

  fs.writeFileSync(path.join(artifactRoot, `${label}.png`), image.toPNG());
  event.sender.send('t4-captured');
});
ipcMain.on('t3-case', (_, result) => {
  fs.appendFileSync(
    path.join(artifactRoot, 'electron-cases.jsonl'),
    `${JSON.stringify(result)}\n`
  );
});
ipcMain.on('t3-result', (_, result) => {
  fs.writeFileSync(
    path.join(artifactRoot, 'electron-results.json'),
    JSON.stringify(result, null, 2)
  );
  console.info(
    JSON.stringify({
      passed: result.passed,
      error: result.error,
      cases: result.cases?.map((value) => ({
        count: value.count,
        checks: value.stages.length,
        fullGridMs: value.initialFullGridMs,
      })),
    })
  );
  app.quit();
});
app.on('quit', (_, code) => {
  fs.writeFileSync(
    path.join(artifactRoot, 'electron-quit.json'),
    JSON.stringify({ code })
  );
});
app
  .whenReady()
  .then(() => {
    const window = new BrowserWindow({
      width: 880,
      height: 640,
      show: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        backgroundThrottling: false,
      },
    });

    window.setAlwaysOnTop(true);
    window.webContents.session.webRequest.onBeforeRequest(
      (details, callback) => {
        callback({ cancel: /^https?:/.test(details.url) });
      }
    );
    window.webContents.on('console-message', (_, level, message) => {
      fs.appendFileSync(
        path.join(artifactRoot, 'electron-console.jsonl'),
        `${JSON.stringify({ level, message })}\n`
      );
    });
    window.webContents.on('render-process-gone', (_, details) => {
      fs.writeFileSync(
        path.join(artifactRoot, 'electron-renderer-gone.json'),
        JSON.stringify(details)
      );
    });
    const loaded = window.loadFile(html);

    window.focus();
    app.focus({ steal: true });

    return loaded;
  })
  .catch((error) => {
    fs.writeFileSync(
      path.join(artifactRoot, 'electron-startup-error.log'),
      error.stack
    );
    app.exit(1);
  });
