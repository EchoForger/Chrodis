const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chrodis', {
  onMenuCommand(callback) {
    const listener = (_event, command) => callback(command);
    ipcRenderer.on('chrodis-menu-command', listener);
    return () => ipcRenderer.removeListener('chrodis-menu-command', listener);
  }
});
