// desktop/preload.js
// ============================================================================
// Ponte segura (ContextBridge) entre o App Desktop (Electron + electron-updater)
// e a Interface do Jogo/Portal. Permite que a tela de Loading (estilo Clash Royale)
// e o modal em tempo real verifiquem, baixem e instalem atualizações reiniciando o App.
// ============================================================================

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shoveDesktop', {
  isDesktopApp: true,
  getInfo: () => ipcRenderer.invoke('desktop:get-info'),
  checkForUpdate: () => ipcRenderer.invoke('desktop:check-update'),
  startUpdate: () => ipcRenderer.invoke('desktop:start-update'),
  quitAndInstall: () => ipcRenderer.invoke('desktop:quit-and-install'),
  openExternal: (url) => ipcRenderer.invoke('desktop:open-external', url),
  onUpdaterStatus: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('updater:status', (_event, payload) => callback(payload));
  }
});
