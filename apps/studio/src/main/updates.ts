// In-app updates from the company Orchestrator (its /downloads/ folder holds the
// installer and latest.yml, copied there by update-server.ps1 -Installers).
import { app, session, type Session } from 'electron';
import { autoUpdater } from 'electron-updater';
import { chromiumFingerprint } from './fingerprint';
import type { Orchestrator } from './orchestrator';

export type UpdateState =
  | { state: 'idle' | 'checking' | 'none' }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string };

const CHECK_EVERY_MS = 6 * 3_600_000;
/** The session partition electron-updater downloads through (its NET_SESSION_NAME). */
const UPDATER_SESSION = 'electron-updater';

export class Updates {
  private timer: NodeJS.Timeout | null = null;
  state: UpdateState = { state: 'idle' };

  constructor(
    private readonly orchestrator: Orchestrator,
    private readonly onChange: (state: UpdateState) => void,
  ) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null;
    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking' }));
    autoUpdater.on('update-not-available', () => this.set({ state: 'none' }));
    autoUpdater.on('download-progress', (p) =>
      this.set({
        state: 'downloading',
        version: this.pendingVersion,
        percent: Math.round(p.percent),
      }),
    );
    autoUpdater.on('update-available', (info) => {
      this.pendingVersion = info.version;
      this.set({ state: 'downloading', version: info.version, percent: 0 });
    });
    autoUpdater.on('update-downloaded', (info) =>
      this.set({ state: 'ready', version: info.version }),
    );
    autoUpdater.on('error', (err) => this.set({ state: 'error', message: err.message }));
  }

  private pendingVersion = '';
  private started = false;

  /** Start checking (only for installed builds connected to an Orchestrator). */
  async start(): Promise<void> {
    if (!app.isPackaged) return;
    const target = await this.orchestrator.connection();
    if (!target) return;
    const url = new URL('/downloads/', target.url).toString();
    if (target.fingerprint) {
      // Trust the pinned self-signed certificate for the Orchestrator host only. electron-updater
      // downloads through its own session, which needs the same rule before its first request.
      const host = new URL(target.url).hostname;
      const pinned = chromiumFingerprint(target.fingerprint);
      const verify: Parameters<Session['setCertificateVerifyProc']>[0] = (request, callback) => {
        if (request.hostname === host)
          callback(request.certificate.fingerprint === pinned ? 0 : -2);
        else callback(-3); // Chromium's normal checks for everything else
      };
      session.defaultSession.setCertificateVerifyProc(verify);
      session.fromPartition(UPDATER_SESSION, { cache: false }).setCertificateVerifyProc(verify);
    }
    autoUpdater.setFeedURL({ provider: 'generic', url });
    this.started = true;
    this.check();
    this.timer ??= setInterval(() => this.check(), CHECK_EVERY_MS);
  }

  /** "Check for updates" in Settings. */
  async checkNow(): Promise<void> {
    if (
      this.state.state === 'checking' ||
      this.state.state === 'downloading' ||
      this.state.state === 'ready'
    )
      return;
    if (this.started) this.check();
    else await this.start();
  }

  check(): void {
    autoUpdater
      .checkForUpdates()
      .catch((err: Error) => this.set({ state: 'error', message: err.message }));
  }

  install(): void {
    if (this.state.state === 'ready') autoUpdater.quitAndInstall(false, true);
  }

  private set(state: UpdateState): void {
    this.state = state;
    this.onChange(state);
  }
}
