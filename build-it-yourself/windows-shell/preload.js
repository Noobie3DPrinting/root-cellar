// Only the built-in launcher and setup pages (file://) get these helpers; app pages never do.
const { contextBridge, ipcRenderer } = require('electron');
if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('RC', {
    info: () => ipcRenderer.invoke('rc:info'),
    open: id => ipcRenderer.invoke('rc:open', id),
    setServer: (id, url) => ipcRenderer.invoke('rc:setServer', id, url),
    clearServer: id => ipcRenderer.invoke('rc:clearServer', id)
  });
}
