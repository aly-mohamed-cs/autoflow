import type { Flow, Step } from '@autoflow/flow-types';
import { walkFlow } from '@autoflow/flow-types';
import { app, BrowserWindow, dialog, ipcMain, net, protocol, safeStorage, shell } from 'electron';
import { promises as fs } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FILE_PROTOCOL, IPC, type AiDraft, type EngineStatus, type PublishedFlow, type QuickLaunchEntry, type RunStartOptions } from '../shared/api';
import { EngineError, EngineProcess, findPython } from './engine';
import { Orchestrator, UntrustedCertificateError } from './orchestrator';
import { RunGuard } from './runguard';
import { QuickLaunch } from './quicklaunch';
import { Updates } from './updates';
import { FlowStore, newFlowId, Vault } from './storage';

// Tests point Studio at a throwaway folder so they never touch real automations.
if (process.env.AUTOFLOW_USER_DATA) app.setPath('userData', process.env.AUTOFLOW_USER_DATA);
const userData = app.getPath('userData');
const runsDir = join(userData, 'runs');
const flows = new FlowStore(userData);
const vault = new Vault(userData, safeStorage);
const orchestrator = new Orchestrator(userData, safeStorage);
let mainWindow: BrowserWindow | null = null;
let quitting = false;
const iconPath = app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(app.getAppPath(), 'build', 'icon.png');
const quickLaunch = new QuickLaunch(userData, orchestrator, () => showWindow(), iconPath);
const updates = new Updates(orchestrator, (state) => broadcast(IPC.updateChanged, state));

function showWindow(): void {
  if (!mainWindow) createWindow();
  else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

const broadcast = (channel: string, payload: unknown) => {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload);
};

/** A test run took queue items ("Get next queue item"); unfinished ones are given back when it ends. */
let tookQueueItems = false;

const engine = new EngineProcess(
  findPython(app.getAppPath(), process.resourcesPath),
  (method, params) => {
    if (method === 'run.event') {
      broadcast(IPC.runEvent, params);
      runGuard.onEvent(params as { event?: string });
      if ((params as { event?: string }).event === 'run_finished' && tookQueueItems) {
        // Queue items the test run took but didn't finish go back to the queue.
        tookQueueItems = false;
        void orchestrator.request('POST', '/api/run/orchestrator', { op: 'queue.release' }).catch(() => undefined);
      }
    } else {
      broadcast(IPC.engineNotification, { method, params });
    }
  },
  (status: EngineStatus) => broadcast(IPC.engineStatusChanged, status),
  // The engine asks the company's AI model (via the Orchestrator) during test runs: for a fix when a
  // step fails with repair on, or for the answer of an "Ask the AI assistant" step.
  async (method, params) => {
    if (method === 'host.repair') return orchestrator.request('POST', '/api/ai/repair-step', params, 620_000);
    if (method === 'host.ai') {
      if (!(await orchestrator.info())) {
        throw new Error('Connect Studio to the Orchestrator (Settings) to use the AI assistant.');
      }
      return orchestrator.request('POST', '/api/ai/complete', params, 620_000);
    }
    if (method === 'host.orchestrator') {
      if (!(await orchestrator.info())) {
        throw new Error('Connect Studio to the Orchestrator (Settings) to use shared values and queues in test runs.');
      }
      if ((params as { op?: string }).op === 'queue.next') tookQueueItems = true;
      return orchestrator.request('POST', '/api/run/orchestrator', params, 110_000);
    }
    throw new Error(`Unknown request ${method}`);
  },
);

const WEB_PREFERENCES = {
  preload: join(__dirname, '../preload/index.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
};

function loadRenderer(win: BrowserWindow, view?: string): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(view ? `${process.env.ELECTRON_RENDERER_URL}?view=${view}` : process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), view ? { query: { view } } : undefined);
  }
}

// Pause / Stop for test runs while another program is in front (floating bar + shortcut keys).
const runGuard = new RunGuard(
  () => mainWindow,
  (action) => void engine.call(`run.${action}`).catch(() => undefined),
  () => {
    const bar = new BrowserWindow({
      width: 460,
      height: 58,
      frame: false,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false, // clicking it must not take the keyboard away from the program being automated
      show: false,
      title: 'Autoflow test run',
      backgroundColor: '#1f2430',
      webPreferences: WEB_PREFERENCES,
    });
    bar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    bar.webContents.on('will-navigate', (event) => event.preventDefault());
    loadRenderer(bar, 'runbar');
    return bar;
  },
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
    webPreferences: WEB_PREFERENCES,
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  for (const change of ['focus', 'blur', 'minimize', 'restore', 'show', 'hide'] as const) {
    mainWindow.on(change as 'focus', () => runGuard.sync());
  }
  // With quick-launch hotkeys set up, closing the window keeps Studio in the tray so they keep working.
  mainWindow.on('close', (event) => {
    if (!quitting && quickLaunch.active) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  // Links open in the user's browser, never inside Studio.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow?.webContents.getURL()) event.preventDefault();
  });
  loadRenderer(mainWindow);
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
  for (const { step } of walkFlow(flow)) {
    const value = step.params?.credential;
    if (typeof value === 'string' && value && !value.includes('{{')) names.add(value);
  }
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
  handle(IPC.engineCall, (method: string, params?: Record<string, unknown>, timeoutMs?: number) =>
    engine.call(method, params, Math.min(Math.max(timeoutMs ?? 60_000, 1_000), 3_600_000)),
  );
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
      repair: !!options.repair,
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

  handle(IPC.orchInfo, () => orchestrator.info());
  handle(IPC.orchConnect, async (url: string, username: string, password: string, fingerprint?: string) => {
    try {
      const info = await orchestrator.connect(url, username, password, fingerprint);
      void updates.start();
      return info;
    } catch (err) {
      if (err instanceof UntrustedCertificateError) throw new Error(`UNTRUSTED_CERTIFICATE ${err.fingerprint}`);
      throw err;
    }
  });
  handle(IPC.orchDisconnect, () => orchestrator.disconnect());
  handle(IPC.orchPublish, async (flow: Flow, notes: string) => {
    const result = await orchestrator.request<{ version: number }>('POST', `/api/flows/${encodeURIComponent(flow.id)}/versions`, { flow, notes });
    const info = await orchestrator.info();
    return { version: result.version, url: `${info?.url}/#/automations/${encodeURIComponent(flow.id)}` };
  });

  handle(IPC.orchNames, async () => {
    if (!(await orchestrator.info())) return { assets: [], queues: [] };
    return orchestrator.request<{ assets: string[]; queues: string[] }>('GET', '/api/run/names').catch(() => ({ assets: [], queues: [] }));
  });
  handle(IPC.orchNotices, async () => {
    if (!(await orchestrator.info())) return [];
    return orchestrator
      .request<{ notices: { id: string; message: string; tone: 'info' | 'warning' }[] }>('GET', '/api/notices')
      .then((r) => r.notices)
      .catch(() => []);
  });
  handle(IPC.orchFlows, async () => {
    const res = await orchestrator.request<{ flows: PublishedFlow[] }>('GET', '/api/flows');
    return res.flows.map((f) => ({ id: f.id, name: f.name, latestVersion: f.latestVersion }));
  });
  // AI calls wait on a local model that can be slow without a GPU (the server caps it at 10 minutes).
  handle(IPC.aiStatus, async () => {
    if (!(await orchestrator.info())) return { enabled: false, model: null };
    return orchestrator.request<{ enabled: boolean; model: string | null }>('GET', '/api/ai/status').catch(() => ({ enabled: false, model: null }));
  });
  handle(IPC.aiDraft, (description: string) => orchestrator.request<AiDraft>('POST', '/api/ai/draft-flow', { description }, 620_000));
  handle(IPC.aiExplain, async (input: Record<string, unknown>) => {
    const res = await orchestrator.request<{ explanation: string }>('POST', '/api/ai/explain-error', input, 620_000);
    return res.explanation;
  });
  handle(IPC.quickList, () => quickLaunch.list());
  handle(IPC.quickSave, (entries: QuickLaunchEntry[]) => quickLaunch.save(entries));
  handle(IPC.quickRun, (entry: QuickLaunchEntry) => quickLaunch.run(entry));

  handle(IPC.updateStatus, () => updates.state);
  handle(IPC.updateCheck, () => updates.checkNow());
  handle(IPC.updateInstall, () => {
    quitting = true;
    updates.install();
  });

  handle(IPC.appVersion, () => app.getVersion());
  handle(IPC.appMinimize, () => mainWindow?.minimize());
  handle(IPC.appRestore, () => showWindow());
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
  app.on('second-instance', () => showWindow());
  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('will-quit', () => quickLaunch.dispose());
  app.whenReady().then(() => {
    app.setAppUserModelId('com.autoflow.studio');
    registerFileProtocol();
    registerIpc();
    engine.start();
    createWindow();
    void quickLaunch.load();
    void updates.start();
  });
  app.on('window-all-closed', () => {
    engine.stop();
    app.quit();
  });
}
