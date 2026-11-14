import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import path from 'path'
import { existsSync } from 'fs'
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception in Main Process:', error)
  dialog.showErrorBox('Critical Error', `An unexpected error occurred:\n\n${error.message}`)
})

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Promise Rejection:', reason)
})

let mainWindow: BrowserWindow | null = null

function sendUpdateStatus(status: string, data?: unknown) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('luxvm:update-status', { status, data })
  }
}

autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = true
autoUpdater.on('checking-for-update', () => sendUpdateStatus('checking'))
autoUpdater.on('update-available', (info) => sendUpdateStatus('available', { version: info.version }))
autoUpdater.on('update-not-available', (info) => sendUpdateStatus('up-to-date', { version: info.version }))
autoUpdater.on('download-progress', (progress) => sendUpdateStatus('downloading', { percent: Math.round(progress.percent) }))
autoUpdater.on('update-downloaded', (info) => sendUpdateStatus('downloaded', { version: info.version }))
autoUpdater.on('error', (error) => sendUpdateStatus('error', { message: error.message }))

ipcMain.handle('luxvm:update-check', async () => {
  if (!app.isPackaged) return { ok: false, message: 'Updates are available in installed builds only.' }
  try {
    await autoUpdater.checkForUpdates()
    return { ok: true }
  } catch (error: any) {
    return { ok: false, message: error?.message || 'Update check failed.' }
  }
})

ipcMain.handle('luxvm:update-download', async () => {
  try {
    await autoUpdater.downloadUpdate()
    return { ok: true }
  } catch (error: any) {
    return { ok: false, message: error?.message || 'Update download failed.' }
  }
})

ipcMain.handle('luxvm:update-install', () => {
  autoUpdater.quitAndInstall()
  return { ok: true }
})

function createWindow() {
  try {
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 820,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
        partition: 'persist:luxvm_persistent_storage',
      },
    })

    if (process.env.VITE_DEV_SERVER_URL) {
      mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL).catch((err) => {
        console.error('Failed to load Vite dev server URL:', err)
      })
    } else {
      const indexPath = path.join(app.getAppPath(), 'dist', 'index.html')
      if (!existsSync(indexPath)) {
        const message = `The packaged interface file is missing. Expected: ${indexPath}`
        console.error(message)
        dialog.showErrorBox('Startup Error', message)
        return
      }
      mainWindow.loadFile(indexPath).catch((err) => {
        console.error('Failed to load production index.html:', indexPath, err)
        dialog.showErrorBox('Startup Error', `Could not load application interface from:\n${indexPath}`)
      })
    }

    mainWindow.on('closed', () => {
      mainWindow = null
    })
  } catch (err) {
    console.error('Failed to create browser window:', err)
    dialog.showErrorBox('Window Creation Error', String(err))
  }
}

app.whenReady().then(() => {
  createWindow()

  if (app.isPackaged) {
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((error) => {
        console.error('Automatic update check failed:', error)
      })
    }, 12000)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
}).catch((err) => {
  console.error('App initialization failed:', err)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
