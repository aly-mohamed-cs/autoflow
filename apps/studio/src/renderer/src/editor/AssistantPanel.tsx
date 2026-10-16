import { Button, Icon, Spinner, Textarea, Tooltip, cn } from '@autoflow/ui';
import { useEffect, useRef, useState } from 'react';
import { useAssistant, type ChatEntry } from '../store/assistant';
import { useEditor } from '../store/editor';

const NO_ENTRIES: ChatEntry[] = [];

const FIRST_IDEAS = [
  'Open the invoices Excel file and type each row into the vendor portal, then write the reference number back',
  'Every morning download the sales report from the portal, save it in the reports folder and email it to my manager',
  'Read the PDF invoices in a folder and put the invoice number, total and due date of each in an Excel sheet',
];
const MORE_IDEAS = [
  'Explain what this automation does, step by step',
  'If one row fails, log it and continue with the next row',
  'Write a summary to the log at the end',
];

/** The AI assistant chat: talk about the automation and let the assistant change it. */
export function AssistantPanel() {
  const flowId = useEditor((s) => s.flow?.id ?? '');
  const empty = useEditor((s) => !(s.flow?.steps ?? []).length);
  const current = useEditor((s) => s.flow);
  const revealStep = useEditor((s) => s.revealStep);
  const entries = useAssistant((s) => s.chats[flowId] ?? NO_ENTRIES);
  const busy = useAssistant((s) => s.busy === flowId);
  const otherBusy = useAssistant((s) => s.busy !== null && s.busy !== flowId);
  const status = useAssistant((s) => s.status);
  const { send, undo, clear, setOpen } = useAssistant.getState();
  const [text, setText] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);

  // A conversation started on Home: send its first message now that the automation is open.
  useEffect(() => {
    const first = useAssistant.getState().takePending(flowId);
    if (first) void send(first);
  }, [flowId, send]);

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' });
  }, [entries.length, busy]);

  const submit = () => {
    if (!text.trim() || busy || otherBusy) return;
    void send(text);
    setText('');
  };

  return (
    <aside className="flex h-full w-[360px] shrink-0 flex-col border-r border-border bg-surface" aria-label="AI assistant">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <Icon name="sparkles" size={16} className="text-primary" />
        <h2 className="flex-1 text-[13px] font-semibold">AI assistant</h2>
        <Tooltip content="Start a new conversation">
          <Button variant="ghost" size="icon" aria-label="New conversation" disabled={busy || !entries.length} onClick={clear}>
            <Icon name="message-square-plus" size={16} />
          </Button>
        </Tooltip>
        <Tooltip content="Close (back to the step library)">
          <Button variant="ghost" size="icon" aria-label="Close the AI assistant" onClick={() => setOpen(false)}>
            <Icon name="x" size={16} />
          </Button>
        </Tooltip>
      </div>

      <div ref={list} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3" role="log" aria-label="Conversation" aria-live="polite">
        {!entries.length && (
          <div className="space-y-3 text-[13px]">
            <p className="text-muted">
              {empty
                ? 'Tell me what this automation should do, the way you would explain it to a new colleague. I add the steps; you pick the screen elements and test it.'
                : 'Ask me to add or change steps, connect them, explain the automation or fix a problem. Every change can be undone.'}
            </p>
            <div className="space-y-1.5">
              {(empty ? FIRST_IDEAS : MORE_IDEAS).map((idea) => (
                <button
                  key={idea}
                  type="button"
                  onClick={() => {
                    setText(idea);
                    input.current?.focus();
                  }}
                  className="block w-full rounded-md border border-border px-2.5 py-2 text-left text-[12.5px] leading-snug text-muted hover:border-primary/50 hover:text-fg"
                >
                  {idea}
                </button>
              ))}
            </div>
          </div>
        )}
        {entries.map((e) =>
          e.check ? (
            <p key={e.id} className="flex items-center gap-1.5 text-[12px] text-subtle">
              <Icon name="list-checks" size={13} /> Studio checked the new steps and asked the assistant to fix what it found.
            </p>
          ) : e.role === 'user' ? (
            <p key={e.id} className="ml-8 rounded-lg bg-primary-soft px-3 py-2 text-[13px] whitespace-pre-line">
              {e.text}
            </p>
          ) : (
            <div key={e.id} className="mr-4 space-y-2 rounded-lg border border-border px-3 py-2 text-[13px]" role="group" aria-label="Assistant answer">
              <p className={cn('whitespace-pre-line', e.error && 'text-danger')}>{e.text}</p>
              {!!e.changes?.length && (
                <div className="space-y-1">
                  <ul className={cn('space-y-0.5 text-[12.5px]', e.undone && 'line-through opacity-60')} aria-label="Changes">
                    {e.changes.map((c, i) => (
                      <li key={i} className="flex items-start gap-1.5">
                        <Icon name="check" size={13} className="mt-0.5 shrink-0 text-success" /> {c}
                      </li>
                    ))}
                  </ul>
                  {e.after &&
                    (e.undone ? (
                      <p className="text-[12px] text-subtle">Undone</p>
                    ) : (
                      <Tooltip content={current === e.after ? 'Take these changes back' : 'The automation changed since; use Undo in the toolbar'}>
                        <span className="inline-block">
                          <Button size="sm" variant="ghost" icon={<Icon name="undo-2" size={13} />} disabled={current !== e.after} onClick={() => undo(e.id)}>
                            Undo
                          </Button>
                        </span>
                      </Tooltip>
                    ))}
                </div>
              )}
              {!!e.todo?.length && !e.undone && (
                <div>
                  <p className="text-[12px] font-semibold text-warning">Still to do</p>
                  <ul className="space-y-0.5" aria-label="Still to do">
                    {e.todo.map((t, i) => (
                      <li key={i}>
                        <button type="button" onClick={() => revealStep(t.stepId)} className="text-left text-[12.5px] text-primary hover:underline">
                          {t.text}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {!!e.skipped?.length && (
                <ul className="space-y-0.5 text-[12px] text-subtle" aria-label="Not done">
                  {e.skipped.map((s, i) => (
                    <li key={i}>Not done: {s}</li>
                  ))}
                </ul>
              )}
            </div>
          ),
        )}
        {busy && (
          <p className="flex items-start gap-2 text-[12.5px] text-muted" role="status">
            <Spinner className="mt-0.5 h-3.5 w-3.5" />
            <span>
              {status} <span className="text-subtle">Without a graphics card this can take a minute or two.</span>
            </span>
          </p>
        )}
      </div>

      <form
        className="shrink-0 space-y-2 border-t border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Textarea
          ref={input}
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          aria-label="Message to the AI assistant"
          placeholder={empty ? 'What should this automation do?' : 'Ask for a change, or ask a question'}
        />
        <div className="flex items-center gap-2">
          <span className="flex-1 text-[11.5px] text-subtle">Enter to send, Shift+Enter for a new line</span>
          <Button type="submit" size="sm" variant="primary" icon={<Icon name="send" size={13} />} disabled={!text.trim() || busy || otherBusy}>
            Send
          </Button>
        </div>
      </form>
    </aside>
  );
}
