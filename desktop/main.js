// desktop/main.js
// ============================================================================
// Processo Principal do Aplicativo Desktop Shove.io (Electron + Steam Ready).
// - Carrega a plataforma unificada conectada à API na Discloud
// - Integra o `electron-updater` (GitHub Releases) para buscar, baixar e aplicar
//   atualizações automaticamente no Loading Inicial (estilo Clash Royale / Brawl Stars)
//   ou quando o servidor dispara um aviso de atualização ao vivo!
// ============================================================================

const path = require('path');
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const pkg = require('../package.json');

// Flags de aceleração de hardware WebGL / GPU para máximo FPS no jogo 3D
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

const SERVER_URL = process.env.SHOVE_SERVER_URL || 'https://shove.discloud.dev';

let mainWindow = null;
let updateDownloaded = false;

// Configuração do Auto-Updater (GitHub Releases)
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

function sendUpdaterEvent(status, extra = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater:status', {
      status,
      appVersion: app.getVersion() || pkg.version,
      ...extra
    });
  }
}

function setupAutoUpdaterEvents() {
  autoUpdater.on('checking-for-update', () => {
    sendUpdaterEvent('checking');
  });

  autoUpdater.on('update-available', (info) => {
    sendUpdaterEvent('available', {
      version: info?.version,
      releaseNotes: info?.releaseNotes || ''
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    sendUpdaterEvent('not-available', {
      version: info?.version || app.getVersion()
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    sendUpdaterEvent('downloading', {
      percent: Math.round(progress?.percent || 0),
      bytesPerSecond: progress?.bytesPerSecond || 0,
      transferred: progress?.transferred || 0,
      total: progress?.total || 0
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    updateDownloaded = true;
    sendUpdaterEvent('downloaded', {
      version: info?.version
    });
  });

  autoUpdater.on('error', (err) => {
    sendUpdaterEvent('error', {
      message: err?.message || 'Erro ao verificar atualização no GitHub Releases.'
    });
  });
}

function createGameWindow() {
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 768,
    minWidth: 960,
    minHeight: 600,
    title: `Shove.io Arena 3D (v${app.getVersion() || pkg.version})`,
    backgroundColor: '#070812',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.setMenuBarVisibility(false);

  // Conecta na API/Portal principal na Discloud informando a versão do App Desktop
  const appVer = encodeURIComponent(app.getVersion() || pkg.version || '1.1.0');
  const targetUrl = `${SERVER_URL}/?desktop=1&appVersion=${appVer}`;

  mainWindow.loadURL(targetUrl).catch(() => {
    // Fallback para os arquivos locais caso o desenvolvedor esteja testando offline
    mainWindow.loadFile(path.join(__dirname, '../client/index.html'));
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Handlers IPC chamados pelo Loading Inicial ou pelo Modal de Atualização ao Vivo
ipcMain.handle('desktop:get-info', () => ({
  isDesktopApp: true,
  appVersion: app.getVersion() || pkg.version || '1.1.0',
  platform: process.platform,
  updateDownloaded
}));

ipcMain.handle('desktop:check-update', async () => {
  if (!app.isPackaged) {
    return {
      isPackaged: false,
      appVersion: app.getVersion() || pkg.version || '1.1.0'
    };
  }
  try {
    const res = await autoUpdater.checkForUpdates();
    return {
      isPackaged: true,
      appVersion: app.getVersion(),
      updateInfo: res?.updateInfo || null
    };
  } catch (err) {
    return {
      isPackaged: true,
      appVersion: app.getVersion(),
      error: err.message
    };
  }
});

ipcMain.handle('desktop:start-update', async () => {
  if (updateDownloaded) {
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return { installing: true };
  }
  if (!app.isPackaged) {
    app.relaunch();
    app.exit(0);
    return { restartingDev: true };
  }
  try {
    await autoUpdater.downloadUpdate();
    return { downloading: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('desktop:quit-and-install', () => {
  if (updateDownloaded && app.isPackaged) {
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return { ok: true };
  }
  app.relaunch();
  app.exit(0);
  return { ok: true };
});

ipcMain.handle('desktop:open-external', async (_e, url) => {
  if (url && /^https?:\/\//i.test(String(url))) {
    await shell.openExternal(String(url));
    return { ok: true };
  }
  return { ok: false };
});

app.whenReady().then(() => {
  setupAutoUpdaterEvents();
  createGameWindow();

  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
