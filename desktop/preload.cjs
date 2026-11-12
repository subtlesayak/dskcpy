const { contextBridge, ipcRenderer } = require('electron');
// No general IPC, filesystem, shell or URL-opening primitive enters the page.
contextBridge.exposeInMainWorld('dskcpyHost', Object.freeze({
  snapshot: () => ipcRenderer.invoke('host:snapshot'),
  start: () => ipcRenderer.invoke('host:start'),
  stop: () => ipcRenderer.invoke('host:stop'),
  refresh: () => ipcRenderer.invoke('host:refresh'),
  screenPermission: () => ipcRenderer.invoke('host:screen-permission'),
  controlPermission: () => ipcRenderer.invoke('host:control-permission'),
  privateSetup: () => ipcRenderer.invoke('host:private-setup'),
  tailscale: () => ipcRenderer.invoke('host:tailscale'),
  copyInvitation: () => ipcRenderer.invoke('host:copy-invitation'),
  setOpenAtLogin: enabled => ipcRenderer.invoke('host:set-open-at-login', enabled),
  onChange: callback => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('host:changed', listener);
    return () => ipcRenderer.removeListener('host:changed', listener);
  },
}));
