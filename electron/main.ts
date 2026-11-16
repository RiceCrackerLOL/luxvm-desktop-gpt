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
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
        partition: 'persist:luxvm_persistent_storage',
      },
    })

    const indexPath = path.join(app.getAppPath(), 'dist', 'index.html')
    const hostedInterfaceUrl = 'https://ricecrackerlol.github.io/luxvm-releases/'
    const legacyStorageKeys = ['luxvm_or_sessions_v2', 'luxvm_or_active_v2', 'luxvm_or_settings_v2']
    const showWindow = () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show()
    }

    if (process.env.VITE_DEV_SERVER_URL) {
      mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL).then(showWindow).catch((err) => {
        console.error('Failed to load Vite dev server URL:', err)
        showWindow()
      })
    } else {
      const loadBundledFallback = async (reason?: unknown) => {
        if (!mainWindow || mainWindow.isDestroyed()) return
        if (existsSync(indexPath)) {
          try {
            await mainWindow.loadFile(indexPath)
            showWindow()
            return
          } catch (localError) {
            console.error('Failed to load bundled LuxVM interface:', localError)
          }
        }
        console.error('No usable LuxVM interface could be loaded:', reason)
        dialog.showErrorBox('Startup Error', 'LuxVM could not load its website or its bundled offline interface.')
        showWindow()
      }

      const loadHostedInterface = async () => {
        let legacyStorage: Record<string, string | null> = {}

        // Read data saved by older desktop versions under the file:// origin.
        // Keep it intact and copy it into the hosted origin only when that key is absent.
        if (existsSync(indexPath)) {
          try {
            await mainWindow!.loadFile(indexPath)
            legacyStorage = await mainWindow!.webContents.executeJavaScript(
              `(() => {
                const keys = ${JSON.stringify(legacyStorageKeys)}
                return Object.fromEntries(keys.map((key) => [key, localStorage.getItem(key)]))
              })()`
            )
          } catch (migrationReadError) {
            console.warn('Could not read previous local LuxVM settings before migration:', migrationReadError)
          }
        }

        try {
          await mainWindow!.loadURL(hostedInterfaceUrl)
          const hasLegacyData = Object.values(legacyStorage).some((value) => value !== null)
          if (hasLegacyData) {
            await mainWindow!.webContents.executeJavaScript(
              `(() => {
                const legacy = ${JSON.stringify(legacyStorage)}
                for (const [key, value] of Object.entries(legacy)) {
                  if (value !== null && localStorage.getItem(key) === null) {
                    localStorage.setItem(key, value)
                  }
                }
                return true
              })()`
            )
            await new Promise<void>((resolve) => {
              mainWindow!.webContents.once('did-finish-load', () => resolve())
              mainWindow!.webContents.reload()
            })
          }
          showWindow()
        } catch (remoteError) {
          console.error('Could not load hosted LuxVM interface; using bundled offline fallback:', remoteError)
          await loadBundledFallback(remoteError)
        }
      }

      void loadHostedInterface()
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
