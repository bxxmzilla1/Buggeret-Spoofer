import { app, BrowserWindow, ipcMain, dialog, shell, powerSaveBlocker } from 'electron'
import path from 'node:path'
import appIcon from '../../build/icon.png?asset'
import { IPC } from '@shared/types'
import type { ConfigPatch, DashboardData, LicenseView } from '@shared/types'
import {
  getConfig,
  saveConfig,
  toPublicConfig,
  allLicenses,
  toLicenseView,
  allPending,
  deleteLicense
} from './store'
import { getBotStatus, onBotStatus, restartBot, startBot } from './bot'
import { createAssignedLicense } from './license'
import { initSupabase, reinitSupabase } from './supabase'
import { startJobWorker } from './jobs'

// Bugrette Spoofer runs the Telegram bot 24/7 in the Electron main process. The
// window is a control dashboard (configure the bot token / NowPayments key,
// watch status, and manage licenses). Closing the window keeps the bot alive
// in the tray-less background; quitting is explicit via the app menu / Cmd+Q.

let mainWindow: BrowserWindow | null = null

function buildDashboard(): DashboardData {
  const cfg = getConfig()
  const licenses: LicenseView[] = allLicenses()
    .map(toLicenseView)
    .sort((a, b) => b.createdAt - a.createdAt)
  return {
    config: toPublicConfig(cfg),
    status: getBotStatus(),
    licenses,
    pending: allPending().sort((a, b) => b.createdAt - a.createdAt)
  }
}

function pushDashboard(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.evDashboard, buildDashboard())
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#08060d',
    title: 'Bugrette Spoofer',
    icon: appIcon,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function registerIpc(): void {
  ipcMain.handle(IPC.getConfig, () => toPublicConfig(getConfig()))

  ipcMain.handle(IPC.saveConfig, (_e, patch: ConfigPatch) => {
    const pub = saveConfig(patch)
    // A token/key change should re-validate the bot connection immediately.
    if (patch.botToken !== undefined) restartBot()
    // New/changed Supabase credentials → reconnect and reconcile.
    if (patch.supabaseUrl !== undefined || patch.supabaseKey !== undefined) {
      void reinitSupabase().then(pushDashboard)
    }
    pushDashboard()
    return pub
  })

  ipcMain.handle(IPC.getDashboard, () => buildDashboard())

  ipcMain.handle(IPC.pickFolder, async () => {
    if (!mainWindow) return null
    const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] })
    if (res.canceled || !res.filePaths.length) return null
    saveConfig({ outputFolder: res.filePaths[0] })
    pushDashboard()
    return res.filePaths[0]
  })

  ipcMain.handle(IPC.createLicense, (_e, username: string): LicenseView => {
    const license = createAssignedLicense(username)
    pushDashboard()
    return toLicenseView(license)
  })

  ipcMain.handle(IPC.revokeLicense, (_e, key: string) => {
    deleteLicense(key)
    pushDashboard()
  })

  ipcMain.handle(IPC.restartBot, () => {
    restartBot()
    pushDashboard()
  })

  ipcMain.handle(IPC.openExternal, (_e, url: string) => shell.openExternal(url))
}

// Keep the machine awake so the bot keeps polling 24/7 even when idle.
function keepAwake(): void {
  try {
    powerSaveBlocker.start('prevent-app-suspension')
  } catch {
    // Non-fatal; the bot still runs while the app is foregrounded.
  }
}

// Only one instance may poll a given bot token (Telegram allows a single
// getUpdates consumer), so enforce a single app instance.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    registerIpc()
    keepAwake()
    createWindow()

    // Push bot status changes to the dashboard live.
    onBotStatus(() => pushDashboard())

    // Connect Supabase (users/admins DB) and reconcile, then start the bot so
    // access checks see the loaded licenses. Registering the sync hooks happens
    // inside initSupabase regardless of whether credentials are set yet.
    void initSupabase().then(pushDashboard)

    startBot()

    // Web bulk-upload worker: claims queued jobs, spoofs, uploads results,
    // and auto-deletes storage. No-ops until web intake + Supabase are set.
    startJobWorker()

    // Periodic refresh so license countdowns / pending payments stay current.
    setInterval(pushDashboard, 15000)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  // The bot should keep running when the dashboard window is closed. Only quit
  // explicitly (Cmd+Q on macOS, or closing from the taskbar on Windows/Linux
  // via app.quit()). We intentionally do NOT quit on window-all-closed for win.
  app.on('window-all-closed', () => {
    if (process.platform === 'darwin') return
    // On Windows/Linux, keep the process alive so the bot stays online 24/7.
    // The user quits from the taskbar/Task Manager or the tray flow.
  })
}
