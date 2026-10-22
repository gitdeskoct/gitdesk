import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IPC,
  type AppNotice,
  type AuthStatus,
  type DesktopApi,
} from '../shared/ipc';
import {
  REPOS_IPC as R,
  type ProgressEvent,
  type RepositorySummary,
} from '../shared/repos';

// Each method maps to one fixed channel. No generic invoke, no raw ipcRenderer, no token access.
const api: DesktopApi = {
  platform: process.platform as DesktopApi['platform'],
  app: {
    getInfo: () => ipcRenderer.invoke(IPC.appGetInfo),
    setOpenAtLogin: (enabled) =>
      ipcRenderer.invoke(IPC.appSetOpenAtLogin, enabled),
    openLogs: () => ipcRenderer.invoke(IPC.appOpenLogs),
    copyDiagnostics: () => ipcRenderer.invoke(IPC.appCopyDiagnostics),
    testNotification: () => ipcRenderer.invoke(IPC.appTestNotification),
    onNotice(callback) {
      const listener = (_event: IpcRendererEvent, notice: AppNotice) =>
        callback(notice);
      ipcRenderer.on(IPC.appNotice, listener);
      return () => ipcRenderer.removeListener(IPC.appNotice, listener);
    },
    onOpenRepository(callback) {
      const listener = (_event: IpcRendererEvent, id: string) => callback(id);
      ipcRenderer.on(IPC.appOpenRepository, listener);
      return () => ipcRenderer.removeListener(IPC.appOpenRepository, listener);
    },
  },
  window: {
    command: (command) => ipcRenderer.invoke(IPC.windowCommand, command),
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
    setDefaults: (input) => ipcRenderer.invoke(IPC.gitSetDefaults, input),
    openInstallPage: () => ipcRenderer.invoke(IPC.gitOpenInstallPage),
  },
  repos: {
    list: () => ipcRenderer.invoke(R.list),
    add: () => ipcRenderer.invoke(R.add),
    initialize: (token) => ipcRenderer.invoke(R.initialize, { token }),
    locate: (id) => ipcRenderer.invoke(R.locate, id),
    refresh: (id) => ipcRenderer.invoke(R.refresh, id),
    open: (id) => ipcRenderer.invoke(R.open, id),
    pin: (id, pinned) => ipcRenderer.invoke(R.pin, { id, pinned }),
    remove: (id) => ipcRenderer.invoke(R.remove, id),
    forgetAll: () => ipcRenderer.invoke(R.forgetAll),
    reveal: (id) => ipcRenderer.invoke(R.reveal, id),
    copyPath: (id) => ipcRenderer.invoke(R.copyPath, id),
    changes: (id) => ipcRenderer.invoke(R.changes, id),
    chooseLocation: () => ipcRenderer.invoke(R.chooseLocation),
    create: (input) => ipcRenderer.invoke(R.create, input),
    linkRemote: (id) => ipcRenderer.invoke(R.linkRemote, id),
    activity: () => ipcRenderer.invoke(R.activity),
    clearActivity: () => ipcRenderer.invoke(R.clearActivity),
    remoteOverview: (force) => ipcRenderer.invoke(R.remoteOverview, { force }),
    remoteList: (input) => ipcRenderer.invoke(R.remoteList, input),
    remoteUpdate: (input) => ipcRenderer.invoke(R.remoteUpdate, input),
    remoteDelete: (id) => ipcRenderer.invoke(R.remoteDelete, id),
    clone: (input) => ipcRenderer.invoke(R.clone, input),
    cancelClone: (jobId) => ipcRenderer.invoke(R.cloneCancel, jobId),
    onProgress(callback) {
      const listener = (_event: IpcRendererEvent, event: ProgressEvent) =>
        callback(event);
      ipcRenderer.on(R.progress, listener);
      return () => ipcRenderer.removeListener(R.progress, listener);
    },
    onChanged(callback) {
      const listener = (
        _event: IpcRendererEvent,
        repositories: RepositorySummary[],
      ) => callback(repositories);
      ipcRenderer.on(R.changed, listener);
      return () => ipcRenderer.removeListener(R.changed, listener);
    },
  },
};

contextBridge.exposeInMainWorld('desktop', api);
