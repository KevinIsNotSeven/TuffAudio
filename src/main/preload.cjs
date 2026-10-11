const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tuffNative', {
  isElectron: true,
  platform: process.platform,
  /** Shows a native save dialog and writes `data` (ArrayBuffer). Resolves to the path or null. */
  saveFile: (opts) => ipcRenderer.invoke('tuff:save-file', opts),
});
