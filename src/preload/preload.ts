import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type AuthStatus, type DesktopApi } from '../shared/ipc';

// Each method maps to one fixed channel. No generic invoke, no raw ipcRenderer, no token access.
const api: DesktopApi = {
  platform: process.platform as DesktopApi['platform'],
  app: {
    getInfo: () => ipcRenderer.invoke(IPC.appGetInfo),
  },
  auth: {
    getStatus: () => ipcRenderer.invoke(IPC.authGetStatus),
    retry: () => ipcRenderer.invoke(IPC.authRetry),
    signIn: () => ipcRenderer.invoke(IPC.authSignIn),
    cancelSignIn: () => ipcRenderer.invoke(IPC.authCancelSignIn),
    reopenBrowser: () => ipcRenderer.invoke(IPC.authReopenBrowser),
    signOut: () => ipcRenderer.invoke(IPC.authSignOut),
    listSessions: () => ipcRenderer.invoke(IPC.authListSessions),
    revokeSession: (id) => ipcRenderer.invoke(IPC.authRevokeSession, id),
    onStatusChanged(callback) {
      const listener = (_event: IpcRendererEvent, status: AuthStatus) =>
        callback(status);
      ipcRenderer.on(IPC.authStatusChanged, listener);
      return () => ipcRenderer.removeListener(IPC.authStatusChanged, listener);
    },
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    update: (patch) => ipcRenderer.invoke(IPC.settingsUpdate, patch),
  },
  git: {
    getIdentity: () => ipcRenderer.invoke(IPC.gitGetIdentity),
    setIdentity: (input) => ipcRenderer.invoke(IPC.gitSetIdentity, input),
    openInstallPage: () => ipcRenderer.invoke(IPC.gitOpenInstallPage),
  },
};

contextBridge.exposeInMainWorld('desktop', api);
