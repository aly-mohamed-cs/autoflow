// Fixes the AI assistant made during robot runs, for a builder to approve (a new version) or dismiss.
import type { Flow, Selector } from '@autoflow/flow-types';
import { Button, Icon } from '@autoflow/ui';
import { useState } from 'react';
import { useMe } from '../App';
import { api, can, type AiFix } from '../lib/api';
import { dateTime } from '../lib/format';
import { href } from '../lib/router';
import { settingTitle, stepActivity, stepTitle } from './StepTree';

export function AiFixes({ fixes, flow, onDecided, showRunLink = true }: { fixes: AiFix[]; flow: Flow | null; onDecided: () => void; showRunLink?: boolean }) {
  const pending = fixes.filter((f) => f.status === 'pending');
  if (!pending.length) return null;
  return (
    <section className="mb-6 space-y-3" aria-label="Suggested fixes">
      {pending.map((fix) => (
        <FixCard key={fix.id} fix={fix} flow={flow} onDecided={onDecided} showRunLink={showRunLink} />
      ))}
    </section>
  );
}

function FixCard({ fix, flow, onDecided, showRunLink }: { fix: AiFix; flow: Flow | null; onDecided: () => void; showRunLink: boolean }) {
  const me = useMe();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const decide = async (action: 'approve' | 'dismiss') => {
    setBusy(true);
    setError('');
    try {
      await api(`/api/fixes/${fix.id}/${action}`, { method: 'POST', body: {} });
      onDecided();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-primary/30 bg-surface p-4 shadow-card">
      <p className="flex flex-wrap items-center gap-2 font-semibold">
        <Icon name="sparkles" size={16} className="text-primary" />
        The AI assistant fixed {fix.patches.length === 1 ? 'a step' : `${fix.patches.length} steps`} during a robot run
      </p>
      <p className="mt-0.5 text-xs text-subtle">
        {dateTime(fix.createdAt)} · version {fix.baseVersion}
        {showRunLink && (
          <>
            {' · '}
            <a className="text-primary hover:underline" href={href('runs', fix.jobId)}>
              see the run
            </a>
          </>
        )}
      </p>
      <ul className="mt-3 space-y-2">
        {fix.patches.map((p) => {
          const activity = flow ? stepActivity(flow, p.step_id) : undefined;
          return (
            <li key={p.step_id} className="rounded-md bg-surface-2 p-3 text-[13px]">
              <p className="font-medium">{flow ? stepTitle(flow, p.step_id) : p.step_id}</p>
              {p.explanation && <p className="mt-0.5">{p.explanation}</p>}
              <ul className="mt-1 list-disc pl-5 text-muted">
                {Object.entries(p.params)
                  .filter(([name]) => !(name === 'element' && p.new_element))
                  .map(([name, value]) => (
                    <li key={name}>
                      {settingTitle(activity, name)}: {typeof value === 'string' ? value : JSON.stringify(value)}
                    </li>
                  ))}
                {p.element && (
                  <li>
                    {p.new_element ? `Picked the element “${p.element.name}”` : `New way to find “${p.element.name}”`}: {describeSelector(p.element.selectors[0])}
                  </li>
                )}
              </ul>
            </li>
          );
        })}
      </ul>
      {can(me.role, 'builder') ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="primary" disabled={busy} icon={<Icon name="check" size={14} />} onClick={() => decide('approve')}>
            Keep fix (publish a new version)
          </Button>
          <Button disabled={busy} onClick={() => decide('dismiss')}>
            Dismiss
          </Button>
          {error && (
            <span className="text-[13px] text-danger" role="alert">
              {error}
            </span>
          )}
        </div>
      ) : (
        <p className="mt-3 text-xs text-subtle">A builder decides whether to keep this fix.</p>
      )}
    </div>
  );
}

function describeSelector(s: Selector | undefined): string {
  if (!s) return 'unknown';
  const name = typeof s.options?.name === 'string' ? s.options.name : '';
  if (s.strategy === 'role') return name ? `${s.value} “${name}”` : s.value;
  if (s.strategy === 'uia') return s.value;
  if (['label', 'placeholder', 'text', 'testid'].includes(s.strategy)) return `${s.strategy === 'testid' ? 'test id' : s.strategy} “${s.value}”`;
  return s.value;
}
