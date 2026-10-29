'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),
  refresh: () => ipcRenderer.invoke('usage:refresh'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  hooks: (tool, action) => ipcRenderer.invoke('hooks:set', { tool, action }),
  cli: (tool, action) => ipcRenderer.invoke('cli:run', { tool, action }),
  testAlert: () => ipcRenderer.invoke('alert:test'),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  showError: (message) => ipcRenderer.invoke('ui:error', message),
  openLogs: () => ipcRenderer.invoke('logs:open'),
  resize: (height) => ipcRenderer.send('window:resize', height),
  hide: () => ipcRenderer.send('window:hide'),
  resetPosition: () => ipcRenderer.send('window:reset-position'),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onAlert: (cb) => ipcRenderer.on('alert', (_e, info) => cb(info)),
});
