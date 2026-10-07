import type { Flow, Step } from '@autoflow/flow-types';
import { app, BrowserWindow, dialog, ipcMain, net, protocol, safeStorage, shell } from 'electron';
import { promises as fs } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FILE_PROTOCOL, IPC, type EngineStatus, type RunStartOptions } from '../shared/api';
import { EngineError, EngineProcess, findPython } from './engine';
import { FlowStore, newFlowId, Vault } from './storage';

// Tests point Studio at a throwaway folder so they never touch real automations.
if (process.env.AUTOFLOW_USER_DATA) app.setPath('userData', process.env.AUTOFLOW_USER_DATA);
const userData = app.getPath('userData');
const runsDir = join(userData, 'runs');
const flows = new FlowStore(userData);
const vault = new Vault(userData, safeStorage);
let mainWindow: BrowserWindow | null = null;

const broadcast = (channel: string, payload: unknown) => {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload);
};

const engine = new EngineProcess(
  findPython(app.getAppPath(), process.resourcesPath),
  (method, params) => {
    if (method === 'run.event') broadcast(IPC.runEvent, params);
  },
  (status: EngineStatus) => broadcast(IPC.engineStatusChanged, status),
);

protocol.registerSchemesAsPrivileged([
  { scheme: FILE_PROTOCOL, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: 'Autoflow Studio',
    backgroundColor: '#f5f6f8',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  // Links open in the user's browser, never inside Studio.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow?.webContents.getURL()) event.preventDefault();
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

/** Only files inside the runs folder (screenshots, downloads) may be shown in the UI. */
function registerFileProtocol(): void {
  protocol.handle(FILE_PROTOCOL, (request) => {
    const url = new URL(request.url);
    const target = resolve(decodeURIComponent(url.searchParams.get('path') ?? ''));
    if (!target.startsWith(resolve(runsDir) + sep)) {
      return new Response('Forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(target).toString());
  });
}

/** Names of credentials used by "Get credential" steps (and any other credential setting). */
function credentialNames(flow: Flow): string[] {
  const names = new Set<string>();
  const visit = (steps: Step[] = []) => {
    for (const s of steps) {
      const value = s.params?.credential;
      if (typeof value === 'string' && value && !value.includes('{{')) names.add(value);
      for (const block of Object.values(s.blocks ?? {})) visit(block);
    }
  };
  visit(flow.steps);
  return [...names];
}

function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R> | R): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await fn(...(args as A));
    } catch (err) {
      // Errors cross IPC as plain messages; keep them readable for users.
      const message = err instanceof Error ? err.message : String(err);
      const hint = err instanceof EngineError && err.data && typeof err.data === 'object' ? (err.data as { hint?: string }).hint : undefined;
      throw new Error(hint ? `${message}\n${hint}` : message);
    }
  });
}

function registerIpc(): void {
  handle(IPC.engineCall, (method: string, params?: Record<string, unknown>) => engine.call(method, params));
  handle(IPC.engineStatus, () => engine.status);
  handle(IPC.engineRestart, () => {
    engine.restart();
    return engine.status;
  });

  handle(IPC.runStart, async (flow: Flow, options: RunStartOptions) => {
    const names = [...new Set([...(options.credentials ?? []), ...credentialNames(flow)])];
    const workDir = join(runsDir, `${Date.now()}`);
    await fs.mkdir(workDir, { recursive: true });
    void pruneRuns();
    return engine.call<{ run_id: string; work_dir: string }>('run.start', {
      flow,
      work_dir: workDir,
      inputs: options.inputs ?? {},
      breakpoints: options.breakpoints ?? [],
      step_mode: options.stepMode ?? false,
      headless: options.headless ?? false,
      credentials: await vault.resolve(names),
    });
  });
  handle(IPC.runControl, (action: string) => engine.call(`run.${action}`));
  handle(IPC.runBreakpoints, (ids: string[]) => engine.call('run.set_breakpoints', { step_ids: ids }).catch(() => undefined));

  handle(IPC.flowsList, () => flows.list());
  handle(IPC.flowsGet, (id: string) => flows.get(id));
  handle(IPC.flowsSave, (flow: Flow) => flows.save(flow));
  handle(IPC.flowsRemove, (id: string) => flows.remove(id));
  handle(IPC.flowsDuplicate, (id: string) => flows.duplicate(id));
  handle(IPC.flowsRecordRun, (id: string, status: string) => flows.recordRun(id, status));
  handle(IPC.flowsImport, async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Import automation',
      filters: [{ name: 'Autoflow automation', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const flow = JSON.parse(await fs.readFile(result.filePaths[0], 'utf8')) as Flow;
    if (!flow || typeof flow !== 'object' || !Array.isArray(flow.steps)) {
      throw new Error('This file is not an Autoflow automation.');
    }
    const imported = { ...flow, id: newFlowId() };
    await flows.save(imported);
    return imported;
  });
  handle(IPC.flowsExport, async (flow: Flow) => {
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: 'Export automation',
      defaultPath: `${flow.name.replace(/[\\/:*?"<>|]/g, '_')}.json`,
      filters: [{ name: 'Autoflow automation', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return false;
    await fs.writeFile(result.filePath, JSON.stringify(flow, null, 2), 'utf8');
    return true;
  });

  handle(IPC.vaultList, () => vault.list());
  handle(IPC.vaultSave, (entry) => vault.save(entry as Parameters<Vault['save']>[0]));
  handle(IPC.vaultRemove, (name: string) => vault.remove(name));
  handle(IPC.vaultAvailable, () => vault.available());

  handle(IPC.dialogOpenFile, async (options?: { filters?: Electron.FileFilter[]; title?: string }) => {
    const r = await dialog.showOpenDialog(mainWindow!, { title: options?.title, filters: options?.filters, properties: ['openFile'] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  handle(IPC.dialogOpenFolder, async (options?: { title?: string }) => {
    const r = await dialog.showOpenDialog(mainWindow!, { title: options?.title, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  handle(IPC.dialogSaveFile, async (options?: { filters?: Electron.FileFilter[]; title?: string; defaultPath?: string }) => {
    const r = await dialog.showSaveDialog(mainWindow!, options ?? {});
    return r.canceled ? null : (r.filePath ?? null);
  });

  handle(IPC.appVersion, () => app.getVersion());
  handle(IPC.appOpenPath, async (path: string) => {
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
  });
}

/** Keep the 30 most recent run folders (screenshots and downloads). */
async function pruneRuns(): Promise<void> {
  try {
    const entries = (await fs.readdir(runsDir)).sort();
    for (const old of entries.slice(0, Math.max(0, entries.length - 30))) {
      await fs.rm(join(runsDir, old), { recursive: true, force: true });
    }
  } catch {
    /* nothing to prune */
  }
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });
  app.whenReady().then(() => {
    app.setAppUserModelId('com.autoflow.studio');
    registerFileProtocol();
    registerIpc();
    engine.start();
    createWindow();
  });
  app.on('window-all-closed', () => {
    engine.stop();
    app.quit();
  });
}
