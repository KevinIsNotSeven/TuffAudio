// TuffAudio – Electron main process.
// Serves the renderer over a private app:// scheme (so ES modules and the
// recorder AudioWorklet load cleanly), wires up desktop-audio loopback capture
// and native save dialogs.

const { app, BrowserWindow, protocol, net, session, desktopCapturer, ipcMain, dialog, shell, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');

const RENDERER_ROOT = path.join(__dirname, '..', 'renderer');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function serveApp() {
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    const file = path.normalize(path.join(RENDERER_ROOT, rel));
    if (!file.startsWith(RENDERER_ROOT + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(file).toString());
  });
}

function enableDesktopAudioCapture() {
  // getDisplayMedia() in the renderer lands here. We grab the primary screen as
  // the (discarded) video track and ask for system audio loopback.
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        if (!sources.length) return callback({});
        callback({ video: sources[0], audio: 'loopback' });
      } catch (err) {
        console.error('Desktop capture failed:', err);
        callback({});
      }
    },
    { useSystemPicker: false },
  );

  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['media', 'display-capture', 'clipboard-sanitized-write'].includes(permission));
  });
}

// Remember the window size/position between launches.
const boundsFile = () => path.join(app.getPath('userData'), 'window.json');
function loadBounds() {
  let b;
  try { b = JSON.parse(require('node:fs').readFileSync(boundsFile(), 'utf8')); } catch { return {}; }
  // Ignore a saved position that's no longer on any connected screen.
  const visible = screen.getAllDisplays().some(({ workArea: a }) =>
    b.x < a.x + a.width - 80 && b.x + b.width > a.x + 80 && b.y >= a.y - 20 && b.y < a.y + a.height - 80);
  if (!visible) { delete b.x; delete b.y; }
  return b;
}
function saveBounds(win) {
  const data = { ...win.getNormalBounds(), maximized: win.isMaximized() };
  try { require('node:fs').writeFileSync(boundsFile(), JSON.stringify(data)); } catch { /* not fatal */ }
}

function createWindow() {
  const isMac = process.platform === 'darwin';
  const saved = loadBounds();
  const win = new BrowserWindow({
    width: saved.width || 1440,
    height: saved.height || 900,
    x: saved.x,
    y: saved.y,
    minWidth: 760,
    minHeight: 480,
    resizable: true,
    maximizable: true,
    backgroundColor: '#0a0c11',
    title: 'TuffAudio',
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    titleBarOverlay: isMac ? undefined : { color: '#0a0c11', symbolColor: '#c9cfdc', height: 44 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (saved.maximized) win.maximize();
  let t;
  const persist = () => { clearTimeout(t); t = setTimeout(() => saveBounds(win), 400); };
  win.on('resize', persist);
  win.on('move', persist);
  win.on('close', () => saveBounds(win));

  win.loadURL('app://tuff/index.html');
}

ipcMain.handle('tuff:save-file', async (event, { defaultPath, filters, data }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath, filters });
  if (canceled || !filePath) return null;
  await fs.writeFile(filePath, Buffer.from(data));
  return filePath;
});

app.whenReady().then(() => {
  serveApp();
  enableDesktopAudioCapture();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
