import type { RunEvent } from '@autoflow/flow-types';
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { FILE_PROTOCOL, IPC, type EngineStatus, type StudioApi } from '../shared/api';

const invoke = <T>(channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args) as Promise<T>;

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api: StudioApi = {
  engine: {
    call: (method, params, timeoutMs) => invoke(IPC.engineCall, method, params, timeoutMs),
    onNotification: (method, listener) =>
      subscribe<{ method: string; params: unknown }>(IPC.engineNotification, (n) => {
        if (n.method === method) listener(n.params);
      }),
    status: () => invoke(IPC.engineStatus),
    restart: () => invoke(IPC.engineRestart),
    onStatus: (listener) => subscribe<EngineStatus>(IPC.engineStatusChanged, listener),
  },
  run: {
    start: (flow, options) => invoke(IPC.runStart, flow, options),
    control: (action) => invoke(IPC.runControl, action),
    setBreakpoints: (ids) => invoke(IPC.runBreakpoints, ids),
    onEvent: (listener) => subscribe<RunEvent>(IPC.runEvent, listener),
  },
  flows: {
    list: () => invoke(IPC.flowsList),
    get: (id) => invoke(IPC.flowsGet, id),
    save: (flow) => invoke(IPC.flowsSave, flow),
    remove: (id) => invoke(IPC.flowsRemove, id),
    duplicate: (id) => invoke(IPC.flowsDuplicate, id),
    recordRun: (id, status) => invoke(IPC.flowsRecordRun, id, status),
    importFile: () => invoke(IPC.flowsImport),
    exportFile: (flow) => invoke(IPC.flowsExport, flow),
  },
  vault: {
    list: () => invoke(IPC.vaultList),
    save: (entry) => invoke(IPC.vaultSave, entry),
    remove: (name) => invoke(IPC.vaultRemove, name),
    available: () => invoke(IPC.vaultAvailable),
  },
  dialog: {
    openFile: (options) => invoke(IPC.dialogOpenFile, options),
    openFolder: (options) => invoke(IPC.dialogOpenFolder, options),
    saveFile: (options) => invoke(IPC.dialogSaveFile, options),
  },
  orchestrator: {
    info: () => invoke(IPC.orchInfo),
    connect: (url, username, password, trustFingerprint) => invoke(IPC.orchConnect, url, username, password, trustFingerprint),
    disconnect: () => invoke(IPC.orchDisconnect),
    publish: (flow, notes) => invoke(IPC.orchPublish, flow, notes),
  },
  app: {
    version: () => invoke(IPC.appVersion),
    openPath: (path) => invoke(IPC.appOpenPath, path),
    fileUrl: (path) => `${FILE_PROTOCOL}://run/?path=${encodeURIComponent(path)}`,
  },
};

contextBridge.exposeInMainWorld('autoflow', api);
