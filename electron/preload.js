'use strict';
/**
 * The only bridge between the UI and the desktop app. The page gets a small,
 * fixed set of calls; no Node.js or Electron APIs leak into it.
 */
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set(['daddy:refresh', 'daddy:opened']);

contextBridge.exposeInMainWorld('daddyNative', {
  platform: process.platform,
  api: (method, path, body) => ipcRenderer.invoke('daddy:api', { method, path, body }),
  openMini: () => ipcRenderer.invoke('daddy:mini'),
  showMain: () => ipcRenderer.send('daddy:show-main'),
  setBadge: (count, png) => ipcRenderer.send('daddy:badge', { count, png }),
  setTitleBar: (colors) => ipcRenderer.send('daddy:titlebar', colors),
  on: (channel, cb) => {
    if (EVENTS.has(channel)) ipcRenderer.on(channel, (_e, data) => cb(data));
  },
});
