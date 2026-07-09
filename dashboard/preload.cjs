const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jarvis', {
  onPTT: (cb) => ipcRenderer.on('ptt-toggle', cb),
  onPTTStart: (cb) => ipcRenderer.on('ptt-start', cb),
  onPTTStop: (cb) => ipcRenderer.on('ptt-stop', cb),
  onDictateToggle: (cb) => ipcRenderer.on('dictate-toggle', cb),
  onWinVisibility: (cb) => ipcRenderer.on('win-visibility', (_e, visible) => cb(visible)),
  restoreMain: () => ipcRenderer.send('restore-main'),
  // Mini widget: manual drag + click-to-talk
  miniDragStart: () => ipcRenderer.send('mini-drag-start'),
  miniDrag: (dx, dy) => ipcRenderer.send('mini-drag', { dx, dy }),
  miniDragEnd: () => ipcRenderer.send('mini-drag-end'),
  togglePTT: () => ipcRenderer.send('ptt-toggle-request'),
});
