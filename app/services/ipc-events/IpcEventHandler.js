import { ipcMain } from 'electron';
import {
  MtpSessionIpc,
  isAuthorizedMtpSender,
} from '../../data/file-explorer/MtpSessionIpc';
import { IpcEvents } from './IpcEventType';
import {
  faqsWindow,
  helpPhoneNotConnectingWindow,
  privacyPolicyWindow,
  reportBugsWindow,
} from '../../helpers/createWindows';

export default class IpcEventService {
  static shared = new IpcEventService();

  start({
    getMainWindow = () => null,
    getDiagnosticSender = () => null,
    expectedUrl,
    service = null,
    transport = null,
    wire = null,
  } = {}) {
    this.#init();
    if (!this.mtpSessionIpc) {
      this.mtpSessionIpc = new MtpSessionIpc({
        ipcMain,
        service,
        transport,
        wire,
        isAuthorizedSender: (event) =>
          isAuthorizedMtpSender(event, getMainWindow(), expectedUrl),
      });
      this.mtpSessionIpc.start();
      if (service) {
        ipcMain.handle(IpcEvents.MTP_DIAGNOSTIC_REQUEST, async (event) => {
          const main = getMainWindow();
          const report = getDiagnosticSender();
          const allowedMain = isAuthorizedMtpSender(event, main, expectedUrl);
          const allowedReport =
            report &&
            event.sender === report &&
            !report.isDestroyed() &&
            event.senderFrame === report.mainFrame &&
            event.senderFrame.url === `${expectedUrl}#reportBugsPage`;

          if (!allowedMain && !allowedReport)
            return { error: 'Unauthorized diagnostic sender.' };
          try {
            const value = await service.request(
              'diagnostic',
              'fetchDebugReport',
              {},
              null
            );

            return {
              error: value?.error
                ? String(value.error.message || value.error)
                : value?.stderr || null,
            };
          } catch (error) {
            return { error: String(error.message).slice(0, 2048) };
          }
        });
      }
    }
  }

  #init = () => {
    // todo move all create window methods to IpcEventService and all window create methods from renderer should be event-driven (aka via IpcEventService). The main process windows could be directly invoked.
    //  This is done to avoid issues with 'electron/remote' (in the packaged builds the electron/remote enable doesn't work)

    ipcMain.on(IpcEvents.OPEN_FAQS_WINDOW, (_, __) => {
      faqsWindow(false);
    });
    ipcMain.on(IpcEvents.OPEN_HELP_PHONE_NOT_CONNECTING_WINDOW, (_, __) => {
      helpPhoneNotConnectingWindow(false);
    });
    ipcMain.on(IpcEvents.OPEN_HELP_PRIVACY_POLICY_WINDOW, (_, __) => {
      privacyPolicyWindow(false);
    });

    ipcMain.on(IpcEvents.REPORT_BUGS_DISPOSE_MTP_REPLY, (_, args) => {
      reportBugsWindow(false, false)?.send(
        IpcEvents.REPORT_BUGS_DISPOSE_MTP_REPLY_FROM_MAIN,
        args
      );
    });
  };
}
