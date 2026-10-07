import type { Catalog } from '@autoflow/flow-types';
import bundledCatalog from '@autoflow/flow-types/activity-catalog.json';
import { create } from 'zustand';
import type { EngineStatus } from '../../../shared/api';
import { CatalogIndex } from '../lib/catalog';

export type Route =
  | { page: 'home' }
  | { page: 'editor'; flowId: string }
  | { page: 'credentials' }
  | { page: 'settings' };

export type Theme = 'light' | 'dark' | 'system';

interface Toast {
  id: number;
  tone: 'info' | 'success' | 'error';
  message: string;
}

interface AppState {
  route: Route;
  engine: EngineStatus;
  /** Catalog from the running engine; the bundled copy is used until it answers. */
  index: CatalogIndex;
  theme: Theme;
  toasts: Toast[];
  navigate(route: Route): void;
  setEngine(status: EngineStatus): void;
  setCatalog(catalog: Catalog): void;
  setTheme(theme: Theme): void;
  toast(message: string, tone?: Toast['tone']): void;
  dismissToast(id: number): void;
}

const storedTheme = (): Theme => {
  try {
    return (localStorage.getItem('autoflow.theme') as Theme) || 'system';
  } catch {
    return 'system';
  }
};

let toastId = 0;

export const useApp = create<AppState>((set, get) => ({
  route: { page: 'home' },
  engine: { state: 'starting' },
  index: new CatalogIndex(bundledCatalog as unknown as Catalog),
  theme: storedTheme(),
  toasts: [],
  navigate: (route) => set({ route }),
  setEngine: (engine) => set({ engine }),
  setCatalog: (catalog) => set({ index: new CatalogIndex(catalog) }),
  setTheme: (theme) => {
    try {
      localStorage.setItem('autoflow.theme', theme);
    } catch {
      /* preference just won't persist */
    }
    set({ theme });
  },
  toast: (message, tone = 'info') => {
    const id = ++toastId;
    set({ toasts: [...get().toasts, { id, tone, message }] });
    setTimeout(() => get().dismissToast(id), tone === 'error' ? 8000 : 4000);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

/** Readable message from an IPC error ("Error invoking remote method 'x': Error: ..."). */
export function errorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
