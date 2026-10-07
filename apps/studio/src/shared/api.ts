// The bridge between the renderer (UI) and the main process, exposed as window.autoflow.
// The renderer never touches Node, the file system or the engine directly.
import type { Flow, RunEvent } from '@autoflow/flow-types';

export interface FlowSummary {
  id: string;
  name: string;
  description: string;
  modified: number;
  stepCount: number;
  lastRun?: { status: string; at: number };
}

export interface CredentialSummary {
  name: string;
  username: string;
  updated: number;
}

export interface CredentialInput {
  name: string;
  username: string;
  /** Omit to keep the stored password. */
  password?: string;
}

export type EngineState = 'starting' | 'ready' | 'crashed' | 'missing';

export interface EngineStatus {
  state: EngineState;
  message?: string;
  version?: string;
  python?: string;
}

export interface RunStartOptions {
  inputs?: Record<string, unknown>;
  breakpoints?: string[];
  stepMode?: boolean;
  headless?: boolean;
  /** Names of credentials the flow uses; the main process decrypts only these. */
  credentials?: string[];
}

export type RunControlAction = 'pause' | 'resume' | 'step' | 'stop';

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface StudioApi {
  engine: {
    /** timeoutMs: how long to wait for the answer (picking waits for the user; default 60 s). */
    call<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
    onNotification(method: string, listener: (params: unknown) => void): () => void;
    status(): Promise<EngineStatus>;
    restart(): Promise<EngineStatus>;
    onStatus(listener: (status: EngineStatus) => void): () => void;
  };
  run: {
    start(flow: Flow, options: RunStartOptions): Promise<{ run_id: string; work_dir: string }>;
    control(action: RunControlAction): Promise<void>;
    setBreakpoints(stepIds: string[]): Promise<void>;
    onEvent(listener: (event: RunEvent) => void): () => void;
  };
  flows: {
    list(): Promise<FlowSummary[]>;
    get(id: string): Promise<Flow>;
    save(flow: Flow): Promise<FlowSummary>;
    remove(id: string): Promise<void>;
    duplicate(id: string): Promise<FlowSummary>;
    recordRun(id: string, status: string): Promise<void>;
    importFile(): Promise<Flow | null>;
    exportFile(flow: Flow): Promise<boolean>;
  };
  vault: {
    list(): Promise<CredentialSummary[]>;
    save(entry: CredentialInput): Promise<void>;
    remove(name: string): Promise<void>;
    available(): Promise<boolean>;
  };
  dialog: {
    openFile(options?: { filters?: FileFilter[]; title?: string }): Promise<string | null>;
    openFolder(options?: { title?: string }): Promise<string | null>;
    saveFile(options?: { filters?: FileFilter[]; title?: string; defaultPath?: string }): Promise<string | null>;
  };
  app: {
    version(): Promise<string>;
    openPath(path: string): Promise<void>;
    /** URL the renderer can use to show a run screenshot. */
    fileUrl(path: string): string;
  };
}

/** IPC channel names, shared so main and preload can't drift apart. */
export const IPC = {
  engineCall: 'engine:call',
  engineStatus: 'engine:status',
  engineRestart: 'engine:restart',
  engineStatusChanged: 'engine:status-changed',
  engineNotification: 'engine:notification',
  runStart: 'run:start',
  runControl: 'run:control',
  runBreakpoints: 'run:breakpoints',
  runEvent: 'run:event',
  flowsList: 'flows:list',
  flowsGet: 'flows:get',
  flowsSave: 'flows:save',
  flowsRemove: 'flows:remove',
  flowsDuplicate: 'flows:duplicate',
  flowsRecordRun: 'flows:record-run',
  flowsImport: 'flows:import',
  flowsExport: 'flows:export',
  vaultList: 'vault:list',
  vaultSave: 'vault:save',
  vaultRemove: 'vault:remove',
  vaultAvailable: 'vault:available',
  dialogOpenFile: 'dialog:open-file',
  dialogOpenFolder: 'dialog:open-folder',
  dialogSaveFile: 'dialog:save-file',
  appVersion: 'app:version',
  appOpenPath: 'app:open-path',
} as const;

/** Custom protocol that serves run screenshots (only from the runs folder). */
export const FILE_PROTOCOL = 'autoflow-file';
