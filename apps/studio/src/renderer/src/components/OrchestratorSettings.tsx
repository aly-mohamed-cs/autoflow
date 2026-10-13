import { Badge, Button, Dialog, Field, Icon, Input } from '@autoflow/ui';
import { useState } from 'react';
import type { OrchestratorInfo } from '../../../shared/api';
import { errorMessage, useApp } from '../store/app';
import { forgetAiStatus } from '../lib/ai';

/** Connect Studio to the company Orchestrator to publish automations. */
export function OrchestratorSettings() {
  const info = useApp((s) => s.orchestrator);
  const setInfo = useApp((s) => s.setOrchestrator);
  const toast = useApp((s) => s.toast);
  const [form, setForm] = useState({ url: info?.url ?? '', username: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [codeSentTo, setCodeSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');

  const connected = (result: OrchestratorInfo) => {
    forgetAiStatus();
    setInfo(result);
    setFingerprint(null);
    setCodeSentTo(null);
    setCode('');
    setForm({ ...form, password: '' });
    toast(`Connected to the Orchestrator as ${result.displayName}`, 'success');
  };

  const connect = async (trust?: string) => {
    setBusy(true);
    setError('');
    try {
      const result = await window.autoflow.orchestrator.connect(form.url, form.username, form.password, trust);
      setFingerprint(null);
      if ('codeSentTo' in result) {
        setCodeSentTo(result.codeSentTo);
        setCode('');
      } else connected(result);
    } catch (e) {
      const message = errorMessage(e);
      if (message.startsWith('UNTRUSTED_CERTIFICATE ')) setFingerprint(message.split(' ')[1]!);
      else setError(message);
    } finally {
      setBusy(false);
    }
  };

  const sendCode = async () => {
    setBusy(true);
    setError('');
    try {
      connected(await window.autoflow.orchestrator.connectCode(code));
    } catch (e) {
      const message = errorMessage(e);
      setError(message);
      if (/expired|Too many|Sign in again/.test(message)) setCodeSentTo(null);
    } finally {
      setBusy(false);
    }
  };

  if (codeSentTo && !info) {
    return (
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void sendCode();
        }}
      >
        <p className="text-[13px] text-muted">The Orchestrator sent a 6-digit code to {codeSentTo}. It works for 10 minutes.</p>
        <Field label="Code from the email" htmlFor="o-code">
          <Input
            id="o-code"
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            className="w-40 text-center font-mono tracking-[0.3em]"
          />
        </Field>
        {error && <p className="text-[13px] text-danger">{error}</p>}
        <div className="flex gap-2">
          <Button type="submit" variant="primary" loading={busy} disabled={code.length !== 6}>Connect</Button>
          <Button variant="ghost" onClick={() => { setCodeSentTo(null); setError(''); }}>Start again</Button>
        </div>
      </form>
    );
  }

  if (info) {
    return (
      <div className="space-y-3">
        <p className="flex flex-wrap items-center gap-2 text-[13px]">
          <Badge tone="success"><Icon name="circle-check" size={12} /> Connected</Badge>
          {info.url} as <strong>{info.displayName}</strong> ({info.role})
        </p>
        <div className="flex gap-2">
          <Button onClick={() => window.open(info.url, '_blank')} icon={<Icon name="external-link" size={14} />}>Open dashboard</Button>
          <Button variant="ghost" onClick={async () => { await window.autoflow.orchestrator.disconnect(); forgetAiStatus(); setInfo(null); }}>Disconnect</Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void connect();
      }}
    >
      <p className="text-[13px] text-muted">Connect to publish automations so robots can run them. Ask your administrator for the address.</p>
      <Field label="Orchestrator address" htmlFor="o-url">
        <Input id="o-url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://rpa.company.local:8443" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Username" htmlFor="o-user">
          <Input id="o-user" autoComplete="username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
        </Field>
        <Field label="Password" htmlFor="o-pass">
          <Input id="o-pass" type="password" autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </Field>
      </div>
      {error && <p className="text-[13px] text-danger">{error}</p>}
      <Button type="submit" variant="primary" loading={busy} disabled={!form.url || !form.username || !form.password}>Connect</Button>
      <Dialog
        open={!!fingerprint}
        onOpenChange={(o) => !o && setFingerprint(null)}
        title="Trust this server?"
        description="The Orchestrator uses its own certificate. Compare this fingerprint with the one your administrator gave you (Dashboard → Robots → Add robot)."
        footer={
          <>
            <Button onClick={() => setFingerprint(null)}>Cancel</Button>
            <Button variant="primary" onClick={() => void connect(fingerprint!)}>They match — trust it</Button>
          </>
        }
      >
        <code className="block rounded bg-surface-2 p-3 font-mono text-xs break-all">{fingerprint}</code>
      </Dialog>
    </form>
  );
}
