/* eslint-disable global-require */
// This module is imported only by the main-process composition root. Requiring
// the selected adapter lazily prevents loading Koffi when Legacy is selected.
export function createMtpBackend(backend, executionHooks) {
  if (process.type !== 'browser')
    throw new Error('MTP factory requires the main process.');
  if (backend === 'kalam') {
    const {
      FileExplorerKalamDataSource,
    } = require('./data-sources/FileExplorerKalamDataSource');

    return new FileExplorerKalamDataSource({ executionHooks });
  }

  if (backend === 'legacy') {
    const {
      FileExplorerLegacyDataSource,
    } = require('./data-sources/FileExplorerLegacyDataSource');

    return new FileExplorerLegacyDataSource({ executionHooks });
  }

  throw new Error('Unsupported MTP backend.');
}
