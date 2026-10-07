import type { Catalog } from '@autoflow/flow-types';
import { cn, Icon, Tooltip } from '@autoflow/ui';
import { useEffect } from 'react';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Toasts } from './components/Toasts';
import { UpdateBanner } from './components/UpdateBanner';
import { CredentialsPage } from './pages/CredentialsPage';
import { EditorPage } from './pages/EditorPage';
import { HomePage } from './pages/HomePage';
import { SettingsPage } from './pages/SettingsPage';
import { useApp, type Route } from './store/app';
import { useRun } from './store/run';

export function App() {
  const route = useApp((s) => s.route);
  useEngineConnection();
  useTheme();

  return (
    <div className="flex h-full">
      <NavRail />
      <main className="flex min-w-0 flex-1 flex-col">
        <UpdateBanner />
        <div className="min-h-0 flex-1">
        <ErrorBoundary area="this page" resetKey={route}>
          {route.page === 'home' && <HomePage />}
          {route.page === 'editor' && <EditorPage key={route.flowId} flowId={route.flowId} />}
          {route.page === 'credentials' && <CredentialsPage />}
          {route.page === 'settings' && <SettingsPage />}
        </ErrorBoundary>
        </div>
      </main>
      <Toasts />
    </div>
  );
}

/** Track engine status, load the live catalog, and route run events to the run store. */
function useEngineConnection() {
  const setEngine = useApp((s) => s.setEngine);
  const setCatalog = useApp((s) => s.setCatalog);
  useEffect(() => {
    const api = window.autoflow;
    const onStatus = (status: Awaited<ReturnType<typeof api.engine.status>>) => {
      setEngine(status);
      if (status.state === 'ready') {
        api.engine.call<Catalog>('catalog.get').then(setCatalog).catch(() => undefined);
      }
    };
    void api.engine.status().then(onStatus);
    void api.orchestrator.info().then((info) => useApp.getState().setOrchestrator(info));
    const offStatus = api.engine.onStatus(onStatus);
    const offEvents = api.run.onEvent((event) => useRun.getState().handle(event));
    return () => {
      offStatus();
      offEvents();
    };
  }, [setEngine, setCatalog]);
}

function useTheme() {
  const theme = useApp((s) => s.theme);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches);
      document.documentElement.classList.toggle('dark', dark);
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
}

const NAV: { route: Route; icon: string; label: string; match: Route['page'][] }[] = [
  { route: { page: 'home' }, icon: 'layout-grid', label: 'Automations', match: ['home', 'editor'] },
  { route: { page: 'credentials' }, icon: 'key-round', label: 'Credentials', match: ['credentials'] },
  { route: { page: 'settings' }, icon: 'settings', label: 'Settings', match: ['settings'] },
];

function NavRail() {
  const route = useApp((s) => s.route);
  const navigate = useApp((s) => s.navigate);
  const engine = useApp((s) => s.engine);
  const engineTone =
    engine.state === 'ready' ? 'bg-success' : engine.state === 'starting' ? 'bg-warning animate-pulse' : 'bg-danger';
  const engineText =
    engine.state === 'ready'
      ? `Automation engine ready (v${engine.version})`
      : engine.state === 'starting'
        ? 'Automation engine is starting…'
        : (engine.message ?? 'Automation engine is not available');

  return (
    <nav className="flex w-16 shrink-0 flex-col items-center gap-1 border-r border-border bg-surface py-3" aria-label="Main">
      <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-on-primary shadow-sm" aria-hidden>
        <Icon name="workflow" size={20} />
      </div>
      {NAV.map((item) => {
        const active = item.match.includes(route.page);
        return (
          <Tooltip key={item.label} content={item.label} side="right">
            <button
              type="button"
              aria-label={item.label}
              aria-current={active ? 'page' : undefined}
              onClick={() => navigate(item.route)}
              className={cn(
                'flex h-10 w-10 items-center justify-center rounded-lg transition-colors',
                active ? 'bg-primary-soft text-primary' : 'text-subtle hover:bg-surface-2 hover:text-fg',
              )}
            >
              <Icon name={item.icon} size={20} />
            </button>
          </Tooltip>
        );
      })}
      <div className="flex-1" />
      <Tooltip content={engineText} side="right">
        <button
          type="button"
          aria-label={engineText}
          onClick={() => navigate({ page: 'settings' })}
          className="flex h-10 w-10 items-center justify-center rounded-lg text-subtle hover:bg-surface-2"
        >
          <span className="relative">
            <Icon name="cpu" size={18} />
            <span className={cn('absolute -right-1 -bottom-1 h-2.5 w-2.5 rounded-full ring-2 ring-surface', engineTone)} />
          </span>
        </button>
      </Tooltip>
    </nav>
  );
}
