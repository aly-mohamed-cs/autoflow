import { Badge, Button, Field, Icon, Segmented, Switch } from '@autoflow/ui';
import { useEffect, useState } from 'react';
import { OrchestratorSettings } from '../components/OrchestratorSettings';
import { QuickLaunchSettings } from '../components/QuickLaunchSettings';
import { aiRepairWanted, setAiRepairWanted, useAiEnabled } from '../lib/ai';
import { useApp, type Theme } from '../store/app';
import type { UpdateStatus } from '../../../shared/api';

export function SettingsPage() {
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  const engine = useApp((s) => s.engine);
  const index = useApp((s) => s.index);
  const orchestrator = useApp((s) => s.orchestrator);
  const [version, setVersion] = useState('');
  useEffect(() => {
    void window.autoflow.app.version().then(setVersion);
  }, []);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 px-8 py-8">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

        <section className="space-y-4 rounded-lg border border-border bg-surface p-5 shadow-card">
          <h2 className="font-semibold">Appearance</h2>
          <Field label="Theme" inline>
            <Segmented<Theme>
              value={theme}
              onChange={setTheme}
              options={[
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
                { value: 'system', label: 'Same as Windows' },
              ]}
            />
          </Field>
        </section>

        <section className="space-y-3 rounded-lg border border-border bg-surface p-5 shadow-card">
          <div className="flex items-center gap-2">
            <h2 className="flex-1 font-semibold">Automation engine</h2>
            <Badge
              tone={
                engine.state === 'ready'
                  ? 'success'
                  : engine.state === 'starting'
                    ? 'warning'
                    : 'danger'
              }
            >
              {engine.state === 'ready'
                ? 'Ready'
                : engine.state === 'starting'
                  ? 'Starting'
                  : 'Not running'}
            </Badge>
          </div>
          <dl className="grid grid-cols-[160px_1fr] gap-y-1.5 text-[13px]">
            <dt className="text-muted">Engine version</dt>
            <dd>{engine.version ?? '—'}</dd>
            <dt className="text-muted">Available steps</dt>
            <dd>{index.catalog.activities.length}</dd>
            <dt className="text-muted">Python</dt>
            <dd className="truncate font-mono text-xs">{engine.python ?? '—'}</dd>
          </dl>
          {engine.message && engine.state !== 'ready' && (
            <pre className="max-h-40 overflow-auto rounded bg-danger-soft p-3 text-xs whitespace-pre-wrap text-danger">
              {engine.message}
            </pre>
          )}
          <Button
            icon={<Icon name="rotate-ccw" size={14} />}
            onClick={() => void window.autoflow.engine.restart()}
          >
            Restart engine
          </Button>
        </section>

        <section className="space-y-2 rounded-lg border border-border bg-surface p-5 shadow-card">
          <h2 className="font-semibold">Orchestrator</h2>
          <OrchestratorSettings />
        </section>

        {orchestrator && (
          <section className="space-y-2 rounded-lg border border-border bg-surface p-5 shadow-card">
            <h2 className="font-semibold">Quick launch (keyboard shortcuts)</h2>
            <QuickLaunchSettings />
          </section>
        )}

        <AiSettings />

        <UpdateSettings version={version} connected={Boolean(orchestrator)} />
      </div>
    </div>
  );
}

/** Studio's version and its updates from the Orchestrator (they download by themselves). */
function UpdateSettings({ version, connected }: { version: string; connected: boolean }) {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' });
  useEffect(() => {
    void window.autoflow.updates.status().then(setStatus);
    return window.autoflow.updates.onChange(setStatus);
  }, []);
  const busy = status.state === 'checking' || status.state === 'downloading';
  const text = (() => {
    switch (status.state) {
      case 'checking':
        return 'Checking for updates…';
      case 'none':
        return 'You have the latest version.';
      case 'downloading':
        return `Downloading version ${status.version}… ${status.percent}%`;
      case 'ready':
        return `Version ${status.version} is ready. Restart Studio to start using it.`;
      case 'error':
        return "Couldn't check for updates.";
      default:
        return connected
          ? 'Studio updates itself from the Orchestrator.'
          : 'Studio updates itself once it is connected to the Orchestrator.';
    }
  })();
  return (
    <section className="space-y-3 rounded-lg border border-border bg-surface p-5 shadow-card">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 font-semibold">Updates</h2>
        {status.state === 'ready' ? (
          <Button
            size="sm"
            variant="primary"
            onClick={() => void window.autoflow.updates.install()}
          >
            Restart to update
          </Button>
        ) : (
          <Button
            size="sm"
            icon={<Icon name="refresh-cw" size={14} />}
            disabled={busy || !connected}
            onClick={() => void window.autoflow.updates.check()}
          >
            Check for updates
          </Button>
        )}
      </div>
      <p className="text-[13px]" role="status">
        Autoflow Studio {version} ·{' '}
        <span className={status.state === 'error' ? 'text-danger' : 'text-muted'}>{text}</span>
      </p>
      {status.state === 'error' && (
        <pre className="max-h-32 overflow-auto rounded bg-danger-soft p-3 text-xs whitespace-pre-wrap text-danger">
          {status.message}
        </pre>
      )}
    </section>
  );
}

/** Shown once an administrator turned on the company's AI assistant. */
function AiSettings() {
  const enabled = useAiEnabled();
  const [repair, setRepair] = useState(aiRepairWanted);
  if (!enabled) return null;
  return (
    <section className="space-y-2 rounded-lg border border-border bg-surface p-5 shadow-card">
      <h2 className="flex items-center gap-2 font-semibold">
        <Icon name="sparkles" size={16} className="text-primary" /> AI assistant
      </h2>
      <Field
        label="Let the AI fix failed steps during test runs"
        inline
        help="When a step fails, the assistant looks at the screen, adjusts that step and tries it again (up to 3 times). You decide whether to keep each fix."
      >
        <Switch
          checked={repair}
          onChange={(on) => {
            setRepair(on);
            setAiRepairWanted(on);
          }}
        />
      </Field>
    </section>
  );
}
