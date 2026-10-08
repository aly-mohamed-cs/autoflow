// Pause and Stop during a test run while another program is in front. Desktop steps take
// over the mouse and keyboard, so Studio's own buttons are hard to reach: a small bar stays on
// top of every window (without taking the keyboard away from the program being automated),
// and two shortcut keys work from anywhere.
import { BrowserWindow, globalShortcut, screen } from 'electron';

export const PAUSE_KEY = 'Control+Shift+F11';
export const STOP_KEY = 'Control+Shift+F12';

type Action = 'pause' | 'resume' | 'stop';

export class RunGuard {
  private bar: BrowserWindow | null = null;
  private running = false;
  private paused = false;

  constructor(
    private readonly mainWindow: () => BrowserWindow | null,
    private readonly control: (action: Action) => void,
    private readonly createBar: () => BrowserWindow,
  ) {}

  /** Every engine run event passes through here. */
  onEvent(event: { event?: string }): void {
    switch (event.event) {
      case 'run_started':
        this.start();
        break;
      case 'paused':
        this.paused = true;
        break;
      case 'resumed':
      case 'step_started':
        this.paused = false;
        break;
      case 'run_finished':
        this.finish();
        break;
    }
  }

  /** The bar shows only while Studio itself isn't the window in front. */
  sync(): void {
    if (!this.bar || this.bar.isDestroyed()) return;
    const main = this.mainWindow();
    const studioInFront = !!main && main.isVisible() && !main.isMinimized() && main.isFocused();
    if (this.running && !studioInFront) this.bar.showInactive();
    else this.bar.hide();
  }

  private start(): void {
    if (this.running) return;
    this.running = true;
    this.paused = false;
    globalShortcut.register(PAUSE_KEY, () => this.control(this.paused ? 'resume' : 'pause'));
    globalShortcut.register(STOP_KEY, () => this.control('stop'));
    this.bar = this.createBar();
    const { workArea } = screen.getPrimaryDisplay();
    const [width] = this.bar.getSize();
    this.bar.setPosition(Math.round(workArea.x + (workArea.width - width!) / 2), workArea.y + 8);
    this.bar.setAlwaysOnTop(true, 'screen-saver');
    this.bar.once('ready-to-show', () => this.sync());
  }

  private finish(): void {
    if (!this.running) return;
    this.running = false;
    globalShortcut.unregister(PAUSE_KEY);
    globalShortcut.unregister(STOP_KEY);
    if (this.bar && !this.bar.isDestroyed()) this.bar.destroy();
    this.bar = null;
  }
}
