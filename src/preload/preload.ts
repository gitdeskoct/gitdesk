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
import { PULLS_IPC as P } from '../shared/pulls';
import { SYNC_IPC as S } from '../shared/sync';
import { WORKSPACE_IPC as W } from '../shared/workspace';

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
    locateConfirm: (input) => ipcRenderer.invoke(R.locateConfirm, input),
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
    remoteCreate: (input) => ipcRenderer.invoke(R.remoteCreate, input),
    remoteGet: (id) => ipcRenderer.invoke(R.remoteGet, id),
    remoteProvision: (id) => ipcRenderer.invoke(R.remoteProvision, id),
    remoteActivity: (id) => ipcRenderer.invoke(R.remoteActivity, id),
    addHostedRemote: (id) => ipcRenderer.invoke(R.addHostedRemote, id),
    copyGitCommand: (id) => ipcRenderer.invoke(R.copyGitCommand, id),
    revokeGitTokens: (id) => ipcRenderer.invoke(R.revokeGitTokens, id),
    linkNamed: (input) => ipcRenderer.invoke(R.linkNamed, input),
    movePreview: (id) => ipcRenderer.invoke(R.movePreview, id),
    move: (input) => ipcRenderer.invoke(R.move, input),
    moveCancel: (jobId) => ipcRenderer.invoke(R.moveCancel, jobId),
    moveUndoState: (id) => ipcRenderer.invoke(R.moveUndoState, id),
    undoMove: (id) => ipcRenderer.invoke(R.undoMove, id),
    history: (id) => ipcRenderer.invoke(R.history, id),
    update: (input) => ipcRenderer.invoke(R.update, input),
    unlink: (id) => ipcRenderer.invoke(R.unlink, id),
    trash: (input) => ipcRenderer.invoke(R.trash, input),
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
  workspace: {
    diff: (input) => ipcRenderer.invoke(W.diff, input),
    stage: (input) => ipcRenderer.invoke(W.stage, input),
    stageAll: (id) => ipcRenderer.invoke(W.stageAll, id),
    unstage: (input) => ipcRenderer.invoke(W.unstage, input),
    discard: (input) => ipcRenderer.invoke(W.discard, input),
    commit: (input) => ipcRenderer.invoke(W.commit, input),
    branches: (id) => ipcRenderer.invoke(W.branches, id),
    switchBranch: (input) => ipcRenderer.invoke(W.switchBranch, input),
    createBranch: (input) => ipcRenderer.invoke(W.createBranch, input),
    fetch: (input) => ipcRenderer.invoke(W.fetch, input),
    cancelFetch: (jobId) => ipcRenderer.invoke(W.cancelFetch, jobId),
    push: (input) => ipcRenderer.invoke(W.push, input),
    cancelPush: (jobId) => ipcRenderer.invoke(W.cancelPush, jobId),
    remotes: (id) => ipcRenderer.invoke(W.remotes, id),
    log: (input) => ipcRenderer.invoke(W.log, input),
    commitDetail: (input) => ipcRenderer.invoke(W.commitDetail, input),
    analytics: (input) => ipcRenderer.invoke(W.analytics, input),
    revealFile: (input) => ipcRenderer.invoke(W.revealFile, input),
    copyFilePath: (input) => ipcRenderer.invoke(W.copyFilePath, input),
    watch: (id) => ipcRenderer.invoke(W.watch, id),
    unwatch: (id) => ipcRenderer.invoke(W.unwatch, id),
    editors: (refresh) => ipcRenderer.invoke(W.editors, refresh),
    openInEditor: (input) => ipcRenderer.invoke(W.openInEditor, input),
    gitConfig: (id) => ipcRenderer.invoke(W.gitConfig, id),
    setGitConfig: (input) => ipcRenderer.invoke(W.setGitConfig, input),
    preferences: (id) => ipcRenderer.invoke(W.preferences, id),
    setPreferences: (input) => ipcRenderer.invoke(W.setPreferences, input),
    gitInstall: () => ipcRenderer.invoke(W.gitInstall),
    chooseGit: () => ipcRenderer.invoke(W.chooseGit),
    usePathGit: () => ipcRenderer.invoke(W.usePathGit),
    setGlobalPrune: (enabled) => ipcRenderer.invoke(W.setGlobalPrune, enabled),
    size: (input) => ipcRenderer.invoke(W.size, input),
  },
  pulls: {
    list: (input) => ipcRenderer.invoke(P.list, input),
    overview: () => ipcRenderer.invoke(P.overview),
    compare: (input) => ipcRenderer.invoke(P.compare, input),
    create: (input) => ipcRenderer.invoke(P.create, input),
    get: (input) => ipcRenderer.invoke(P.get, input),
    update: (input) => ipcRenderer.invoke(P.update, input),
    setStatus: (input) => ipcRenderer.invoke(P.setStatus, input),
    fileDiff: (input) => ipcRenderer.invoke(P.fileDiff, input),
    checkMergeability: (input) =>
      ipcRenderer.invoke(P.checkMergeability, input),
    comments: (input) => ipcRenderer.invoke(P.comments, input),
    addComment: (input) => ipcRenderer.invoke(P.addComment, input),
    editComment: (input) => ipcRenderer.invoke(P.editComment, input),
    deleteComment: (input) => ipcRenderer.invoke(P.deleteComment, input),
    reviews: (input) => ipcRenderer.invoke(P.reviews, input),
    submitReview: (input) => ipcRenderer.invoke(P.submitReview, input),
    activity: (input) => ipcRenderer.invoke(P.activity, input),
    viewed: (input) => ipcRenderer.invoke(P.viewed, input),
    setViewed: (input) => ipcRenderer.invoke(P.setViewed, input),
    merge: (input) => ipcRenderer.invoke(P.merge, input),
    conflicts: (repoId) => ipcRenderer.invoke(P.conflicts, repoId),
    conflictSides: (input) => ipcRenderer.invoke(P.conflictSides, input),
    resolveConflict: (input) => ipcRenderer.invoke(P.resolveConflict, input),
    continueMerge: (repoId) => ipcRenderer.invoke(P.continueMerge, repoId),
    abortMerge: (repoId) => ipcRenderer.invoke(P.abortMerge, repoId),
    revertInfo: (input) => ipcRenderer.invoke(P.revertInfo, input),
    revert: (input) => ipcRenderer.invoke(P.revert, input),
    deleteBranch: (input) => ipcRenderer.invoke(P.deleteBranch, input),
    stats: (input) => ipcRenderer.invoke(P.stats, input),
  },
  sync: {
    overview: (id) => ipcRenderer.invoke(S.overview, id),
    compare: (id) => ipcRenderer.invoke(S.compare, id),
    check: (id) => ipcRenderer.invoke(S.check, id),
    pull: (input) => ipcRenderer.invoke(S.pull, input),
    cancel: (jobId) => ipcRenderer.invoke(S.cancel, jobId),
    publish: (input) => ipcRenderer.invoke(S.publish, input),
    setUpstream: (input) => ipcRenderer.invoke(S.setUpstream, input),
    checkPush: (input) => ipcRenderer.invoke(S.checkPush, input),
    activity: (input) => ipcRenderer.invoke(S.activity, input),
    fileDiff: (input) => ipcRenderer.invoke(S.fileDiff, input),
  },
};

contextBridge.exposeInMainWorld('desktop', api);
