import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/types'
import type { BugretteApi, ConfigPatch, DashboardData } from '@shared/types'

// Minimal, typed API surface. The renderer can ONLY do what is exposed here —
// it never touches the filesystem, child processes, secrets or the network.
const api: BugretteApi = {
  getConfig: () => ipcRenderer.invoke(IPC.getConfig),
  saveConfig: (patch: ConfigPatch) => ipcRenderer.invoke(IPC.saveConfig, patch),
  getDashboard: () => ipcRenderer.invoke(IPC.getDashboard),
  pickFolder: () => ipcRenderer.invoke(IPC.pickFolder),
  createLicense: (days?: number) => ipcRenderer.invoke(IPC.createLicense, days),
  revokeLicense: (key: string) => ipcRenderer.invoke(IPC.revokeLicense, key),
  restartBot: () => ipcRenderer.invoke(IPC.restartBot),
  openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url),
  onDashboard: (cb: (data: DashboardData) => void) => {
    const listener = (_e: unknown, data: DashboardData): void => cb(data)
    ipcRenderer.on(IPC.evDashboard, listener)
    return () => ipcRenderer.removeListener(IPC.evDashboard, listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
