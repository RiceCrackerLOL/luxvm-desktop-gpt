import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('luxvmUpdater', {
  checkForUpdates: () => ipcRenderer.invoke('luxvm:update-check'),
  downloadUpdate: () => ipcRenderer.invoke('luxvm:update-download'),
  installUpdate: () => ipcRenderer.invoke('luxvm:update-install'),
  onStatus: (callback: (payload: { status: string; data?: any }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { status: string; data?: any }) => callback(payload)
    ipcRenderer.on('luxvm:update-status', listener)
    return () => ipcRenderer.removeListener('luxvm:update-status', listener)
  },
})

