// Quick launch: keyboard shortcuts that start published automations on a robot,
// from anywhere in Windows, plus a tray menu with the same automations.
import { app, globalShortcut, Menu, nativeImage, Notification, Tray } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { QuickLaunchEntry } from '../shared/api';
import type { Orchestrator } from './orchestrator';

export class QuickLaunch {
  private readonly file: string;
  private entries: QuickLaunchEntry[] = [];
  private tray: Tray | null = null;
  private failed: string[] = [];

  constructor(
    userData: string,
    private readonly orchestrator: Orchestrator,
    private readonly showWindow: () => void,
    private readonly iconPath: string,
  ) {
    this.file = join(userData, 'quicklaunch.json');
  }

  async load(): Promise<void> {
    try {
      this.entries = JSON.parse(await fs.readFile(this.file, 'utf8')) as QuickLaunchEntry[];
    } catch {
      this.entries = [];
    }
    this.apply();
  }

  list(): { entries: QuickLaunchEntry[]; unavailable: string[] } {
    return { entries: this.entries, unavailable: this.failed };
  }

  async save(entries: QuickLaunchEntry[]): Promise<{ entries: QuickLaunchEntry[]; unavailable: string[] }> {
    this.entries = entries.filter((e) => e.flowId && e.accelerator);
    await fs.writeFile(this.file, JSON.stringify(this.entries, null, 2), 'utf8');
    this.apply();
    return this.list();
  }

  get active(): boolean {
    return this.entries.length > 0;
  }

  /** Register the shortcuts and rebuild the tray menu. */
  private apply(): void {
    globalShortcut.unregisterAll();
    this.failed = [];
    for (const entry of this.entries) {
      try {
        const ok = globalShortcut.register(entry.accelerator, () => void this.run(entry));
        if (!ok) this.failed.push(entry.accelerator);
      } catch {
        this.failed.push(entry.accelerator);
      }
    }
    this.updateTray();
  }

  private updateTray(): void {
    if (!this.tray) {
      const icon = nativeImage.createFromPath(this.iconPath).resize({ width: 16, height: 16 });
      this.tray = new Tray(icon);
      this.tray.setToolTip('Autoflow Studio');
      this.tray.on('click', () => this.showWindow());
    }
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Autoflow Studio', click: () => this.showWindow() },
        { type: 'separator' },
        ...(this.entries.length
          ? this.entries.map((e) => ({ label: `Run “${e.flowName}”`, accelerator: e.accelerator, click: () => void this.run(e) }))
          : [{ label: 'No quick-launch automations yet', enabled: false }]),
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() },
      ]),
    );
  }

  async run(entry: QuickLaunchEntry): Promise<void> {
    try {
      await this.orchestrator.request('POST', `/api/flows/${encodeURIComponent(entry.flowId)}/run`, { trigger: 'hotkey' });
      notify(`Started “${entry.flowName}”`, 'A robot will run it now. You can follow it in the dashboard.');
    } catch (err) {
      notify(`Could not start “${entry.flowName}”`, err instanceof Error ? err.message : String(err));
    }
  }

  dispose(): void {
    globalShortcut.unregisterAll();
    this.tray?.destroy();
    this.tray = null;
  }
}

function notify(title: string, body: string): void {
  if (Notification.isSupported()) new Notification({ title, body, silent: false }).show();
}
