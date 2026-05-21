import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('chrodis', {
  version: '0.1.0',
  onMenuCommand(callback: (command: string) => void) {
    const listener = (_event: unknown, command: string) => callback(command);
    ipcRenderer.on('chrodis-menu-command', listener);
    return () => ipcRenderer.removeListener('chrodis-menu-command', listener);
  }
});
