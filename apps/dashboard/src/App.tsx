import { Button, cn, Field, Icon, Input, Menu, TooltipProvider } from '@autoflow/ui';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, can, setUnauthorizedHandler, type Me, type Role } from './lib/api';
import { closeLive } from './lib/live';
import { href, useRoute } from './lib/router';
import { AuditPage } from './pages/AuditPage';
import { AutomationPage } from './pages/AutomationPage';
import { AutomationsPage } from './pages/AutomationsPage';
import { CredentialsPage } from './pages/CredentialsPage';
import { HomePage } from './pages/HomePage';
import { QueuePage, QueuesPage } from './pages/QueuesPage';
import { RobotsPage } from './pages/RobotsPage';
import { RunPage } from './pages/RunPage';
import { RunsPage } from './pages/RunsPage';
import { SettingsPage } from './pages/SettingsPage';
import { UsersPage } from './pages/UsersPage';

const MeContext = createContext<Me | null>(null);
export const useMe = () => useContext(MeContext)!;

export function App() {
  const [state, setState] = useState<{ me: Me | null; needsSetup: boolean; ldap: boolean } | null>(null);

  const load = useCallback(async () => {
    const status = await api<{ needsSetup: boolean; ldapEnabled: boolean }>('/api/setup/status');
    let me: Me | null = null;
    if (!status.needsSetup) me = await api<{ user: Me }>('/api/auth/me').then((r) => r.user).catch(() => null);
    setState({ me, needsSetup: status.needsSetup, ldap: status.ldapEnabled });
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => setState((s) => (s ? { ...s, me: null } : s)));
    load().catch(() => setState({ me: null, needsSetup: false, ldap: false }));
  }, [load]);

  useTheme();

  if (!state) return null;
  return (
    <TooltipProvider>
      {state.needsSetup ? (
        <SetupScreen onDone={load} />
      ) : !state.me ? (
        <LoginScreen ldap={state.ldap} onDone={load} />
      ) : (
        <MeContext.Provider value={state.me}>
          <Shell onSignOut={async () => {
            await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
            closeLive();
            setState({ ...state, me: null });
          }} />
        </MeContext.Provider>
      )}
    </TooltipProvider>
  );
}

function useTheme() {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const pref = localStorage.getItem('autoflow.theme') ?? 'system';
      document.documentElement.classList.toggle('dark', pref === 'dark' || (pref === 'system' && media.matches));
    };
    apply();
    media.addEventListener('change', apply);
    window.addEventListener('storage', apply);
    return () => {
      media.removeEventListener('change', apply);
      window.removeEventListener('storage', apply);
    };
  }, []);
}

const NAV: { path: string; label: string; icon: string; role: Role }[] = [
  { path: '', label: 'Overview', icon: 'layout-dashboard', role: 'viewer' },
  { path: 'automations', label: 'Automations', icon: 'workflow', role: 'viewer' },
  { path: 'runs', label: 'Runs', icon: 'list-video', role: 'viewer' },
  { path: 'queues', label: 'Queues', icon: 'inbox', role: 'viewer' },
  { path: 'robots', label: 'Robots', icon: 'bot', role: 'viewer' },
  { path: 'credentials', label: 'Credentials', icon: 'key-round', role: 'builder' },
  { path: 'users', label: 'Users', icon: 'users', role: 'admin' },
  { path: 'settings', label: 'Settings', icon: 'settings', role: 'viewer' },
  { path: 'audit', label: 'Audit log', icon: 'scroll-text', role: 'admin' },
];

function Shell({ onSignOut }: { onSignOut: () => void }) {
  const me = useMe();
  const route = useRoute();
  const section = route[0] ?? '';
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => setMenuOpen(false), [section, route[1]]);

  return (
    <div className="flex min-h-full">
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-30 flex w-60 flex-col border-r border-border bg-surface transition-transform lg:sticky lg:top-0 lg:h-screen lg:translate-x-0',
          menuOpen ? 'translate-x-0' : '-translate-x-full',
        )}
        aria-label="Main"
      >
        <div className="flex h-16 items-center gap-2.5 px-5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-on-primary">
            <Icon name="workflow" size={18} />
          </span>
          <span className="text-base font-semibold">Autoflow</span>
        </div>
        <nav className="flex-1 space-y-0.5 px-3">
          {NAV.filter((n) => can(me.role, n.role)).map((n) => {
            const active = section === n.path;
            return (
              <a
                key={n.path}
                href={href(...(n.path ? [n.path] : []))}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2.5 rounded-md px-3 py-2 text-[13px] font-medium transition-colors',
                  active ? 'bg-primary-soft text-primary' : 'text-muted hover:bg-surface-2 hover:text-fg',
                )}
              >
                <Icon name={n.icon} size={17} /> {n.label}
              </a>
            );
          })}
        </nav>
        <div className="border-t border-border p-3">
          <Menu
            align="start"
            trigger={
              <button type="button" className="flex w-full items-center gap-2.5 rounded-md p-2 text-left hover:bg-surface-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary-soft text-[13px] font-semibold text-primary">
                  {initials(me.displayName)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{me.displayName}</span>
                  <span className="block text-xs text-subtle">{me.roleLabel}</span>
                </span>
                <Icon name="chevrons-up-down" size={14} className="text-subtle" />
              </button>
            }
            items={[{ label: 'Sign out', icon: <Icon name="log-out" size={14} />, onSelect: onSignOut }]}
          />
        </div>
      </aside>
      {menuOpen && <div className="fixed inset-0 z-20 bg-black/30 lg:hidden" onClick={() => setMenuOpen(false)} />}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-14 items-center border-b border-border bg-surface px-4 lg:hidden">
          <Button variant="ghost" size="icon" aria-label="Open menu" onClick={() => setMenuOpen(true)}>
            <Icon name="menu" size={18} />
          </Button>
          <span className="ml-2 font-semibold">Autoflow</span>
        </div>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-8 sm:py-8">
          <Page route={route} />
        </main>
      </div>
    </div>
  );
}

function Page({ route }: { route: string[] }) {
  const me = useMe();
  const [section, id] = route;
  const guard = (role: Role, page: ReactNode) => (can(me.role, role) ? page : <NoAccess />);
  switch (section) {
    case undefined:
      return <HomePage />;
    case 'automations':
      return id ? <AutomationPage id={id} /> : <AutomationsPage />;
    case 'runs':
      return id ? <RunPage id={id} /> : <RunsPage />;
    case 'queues':
      return id ? <QueuePage id={id} /> : <QueuesPage />;
    case 'robots':
      return <RobotsPage />;
    case 'credentials':
      return guard('builder', <CredentialsPage />);
    case 'users':
      return guard('admin', <UsersPage />);
    case 'settings':
      return <SettingsPage />;
    case 'audit':
      return guard('admin', <AuditPage />);
    default:
      return <NoAccess title="Page not found" />;
  }
}

function NoAccess({ title = "You don't have access to this page" }: { title?: string }) {
  return (
    <div className="py-24 text-center">
      <Icon name="lock" size={28} className="mx-auto text-subtle" />
      <p className="mt-3 font-semibold">{title}</p>
      <a className="mt-2 inline-block text-[13px] text-primary" href="#/">Back to overview</a>
    </div>
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');

// -- sign-in screens ------------------------------------------------------------------------

function AuthLayout({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-bg px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-on-primary">
            <Icon name="workflow" size={22} />
          </span>
          <span className="text-xl font-semibold">Autoflow</span>
        </div>
        <div className="rounded-xl border border-border bg-surface p-6 shadow-card">
          <h1 className="text-lg font-semibold">{title}</h1>
          <p className="mt-1 mb-5 text-[13px] text-muted">{subtitle}</p>
          {children}
        </div>
      </div>
    </div>
  );
}

function LoginScreen({ ldap, onDone }: { ldap: boolean; onDone: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <AuthLayout title="Sign in" subtitle={ldap ? 'Use your Windows username and password.' : 'Sign in with your Autoflow account.'}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await api('/api/auth/login', { body: { username, password } });
            onDone();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Username" htmlFor="u">
          <Input id="u" autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder={ldap ? 'e.g. mona.ali' : ''} />
        </Field>
        <Field label="Password" htmlFor="p" error={error || undefined}>
          <Input id="p" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" className="w-full justify-center" size="lg" loading={busy} disabled={!username || !password}>
          Sign in
        </Button>
      </form>
    </AuthLayout>
  );
}

function SetupScreen({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState({ username: 'admin', displayName: 'Administrator', password: '', confirm: '' });
  const [error, setError] = useState('');
  const mismatch = form.confirm && form.password !== form.confirm;
  return (
    <AuthLayout title="Welcome to Autoflow" subtitle="Create the first administrator account. Keep it as a backup way in — day-to-day, people sign in with Windows once directory sign-in is set up.">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api('/api/setup', { body: { username: form.username, displayName: form.displayName, password: form.password } });
            onDone();
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <Field label="Username" htmlFor="su">
          <Input id="su" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
        </Field>
        <Field label="Display name" htmlFor="sd">
          <Input id="sd" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
        </Field>
        <Field label="Password" htmlFor="sp" help="At least 10 characters.">
          <Input id="sp" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </Field>
        <Field label="Repeat password" htmlFor="sc" error={mismatch ? 'The passwords are different.' : error || undefined}>
          <Input id="sc" type="password" autoComplete="new-password" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} />
        </Field>
        <Button type="submit" variant="primary" size="lg" className="w-full justify-center" disabled={form.password.length < 10 || !!mismatch || !form.confirm}>
          Create administrator
        </Button>
      </form>
    </AuthLayout>
  );
}
