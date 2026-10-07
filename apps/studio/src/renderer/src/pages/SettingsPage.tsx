import { Badge, Button, Field, Icon, Segmented } from '@autoflow/ui';
import { useEffect, useState } from 'react';
import { useApp, type Theme } from '../store/app';

export function SettingsPage() {
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  const engine = useApp((s) => s.engine);
  const index = useApp((s) => s.index);
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
            <Badge tone={engine.state === 'ready' ? 'success' : engine.state === 'starting' ? 'warning' : 'danger'}>
              {engine.state === 'ready' ? 'Ready' : engine.state === 'starting' ? 'Starting' : 'Not running'}
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
          <Button icon={<Icon name="rotate-ccw" size={14} />} onClick={() => void window.autoflow.engine.restart()}>
            Restart engine
          </Button>
        </section>

        <section className="space-y-2 rounded-lg border border-border bg-surface p-5 shadow-card">
          <h2 className="font-semibold">Orchestrator</h2>
          <p className="text-[13px] text-muted">
            Connecting Studio to your company's Orchestrator — to publish automations and run them on robots — arrives
            with the Orchestrator release.
          </p>
        </section>

        <p className="text-xs text-subtle">Autoflow Studio {version}</p>
      </div>
    </div>
  );
}
