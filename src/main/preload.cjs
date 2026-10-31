const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('tuffNative', {
  isElectron: true,
  platform: process.platform,
  /** Shows a native save dialog and writes `data` (ArrayBuffer). Resolves to the path or null. */
  saveFile: (opts) => ipcRenderer.invoke('tuff:save-file', opts),
  /** Absolute path of a File picked in the renderer (so "Save" can write back to it). */
  pathForFile: (file) => { try { return webUtils.getPathForFile(file) || null; } catch { return null; } },
});
