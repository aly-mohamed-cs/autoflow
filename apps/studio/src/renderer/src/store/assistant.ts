// The AI assistant chat: one conversation per automation while Studio is open (never saved: it
// holds what people wrote about their work). Each answer's changes are applied to the automation as
// one edit with its own Undo, then checked by the engine: problems the assistant can fix go back
// to it (twice at most), the rest - pick an element, enter a web address - are listed for the person.
import type { Flow, ValidationIssue } from '@autoflow/flow-types';
import { create } from 'zustand';
import type { AssistantMessage } from '../../../shared/api';
import { applyActions } from '../lib/assistant';
import { TEMPLATES } from '../lib/templates';
import { findStep } from '../lib/flowOps';
import { errorMessage, useApp } from './app';
import { useEditor } from './editor';

export interface ChatEntry {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Studio's own check of the assistant's steps, sent back to it (shown small). */
  check?: boolean;
  changes?: string[];
  skipped?: string[];
  /** What the person still has to do in the steps the assistant added or changed. */
  todo?: { stepId: string; text: string }[];
  /** The automation right after this answer's changes: Undo works while nothing changed since. */
  after?: Flow;
  undone?: boolean;
  error?: boolean;
  /** About the model server (e.g. it cut the request short). */
  warning?: string;
  /** The model's own answer when it could not be used. */
  raw?: string;
}

interface AssistantState {
  open: boolean;
  chats: Record<string, ChatEntry[]>;
  /** The automation an answer is being waited for. */
  busy: string | null;
  status: string;
  /** A first message to send once the editor has opened the new automation (from Home). */
  pending: { flowId: string; text: string } | null;
  setOpen(open: boolean): void;
  send(text: string): Promise<void>;
  undo(entryId: string): void;
  clear(): void;
  /** Home: create an empty automation and ask the assistant to build it there. */
  startNew(text: string): Promise<string>;
  takePending(flowId: string): string | null;
}

const MAX_FIX_ROUNDS = 2;
const entryId = () => crypto.randomUUID();

/** The conversation as the model reads it: what was said, and what Studio changed and found. */
function history(entries: ChatEntry[]): AssistantMessage[] {
  return entries
    .filter((e) => !e.error && !e.raw) // failures and answers that could not be used are not the model's words
    .slice(-16)
    .map((e) => ({
      role: e.role,
      content:
        e.role === 'assistant' && (e.changes?.length || e.skipped?.length || e.undone)
          ? [
              e.text,
              e.changes?.length ? `(Studio made these changes: ${e.changes.join('; ')})` : '',
              e.skipped?.length ? `(Studio could not do: ${e.skipped.join('; ')})` : '',
              e.undone ? '(The person undid these changes.)' : '',
            ]
              .filter(Boolean)
              .join('\n')
          : e.text,
    }));
}

/** Empty settings the assistant was told to leave for the person, and screen elements to pick. */
function forPerson(flow: Flow, issue: ValidationIssue): boolean {
  if (!issue.step_id || !issue.field) return false;
  const step = findStep(flow, issue.step_id);
  const def = step && useApp.getState().index.get(step.activity);
  if (!step || !def) return false;
  const kind = useApp.getState().index.fields(def).find((f) => f.name === issue.field)?.kind;
  const value = step.params?.[issue.field];
  return kind === 'element' || kind === 'credential' || value === undefined || value === null || value === '';
}

/** The engine's check of the automation (none if the engine can't answer; the editor checks again). */
async function check(flow: Flow): Promise<ValidationIssue[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return (await window.autoflow.engine.call<{ issues: ValidationIssue[] }>('flow.validate', { flow })).issues;
    } catch {
      await new Promise((r) => setTimeout(r, 800)); // e.g. still starting
    }
  }
  return [];
}

export const useAssistant = create<AssistantState>((set, get) => {
  const push = (flowId: string, entry: ChatEntry) => set({ chats: { ...get().chats, [flowId]: [...(get().chats[flowId] ?? []), entry] } });
  const patch = (flowId: string, id: string, fn: (e: ChatEntry) => ChatEntry) =>
    set({ chats: { ...get().chats, [flowId]: (get().chats[flowId] ?? []).map((e) => (e.id === id ? fn(e) : e)) } });

  return {
    open: false,
    chats: {},
    busy: null,
    status: '',
    pending: null,

    setOpen: (open) => set({ open }),

    send: async (text) => {
      const flowId = useEditor.getState().flow?.id;
      if (!flowId || get().busy || !text.trim()) return;
      push(flowId, { id: entryId(), role: 'user', text: text.trim() });
      set({ busy: flowId, status: 'The assistant is thinking…' });
      try {
        let lastProblems = '';
        for (let round = 0; ; round++) {
          const editor = useEditor.getState();
          if (editor.flow?.id !== flowId) return; // the automation was closed meanwhile
          const reply = await window.autoflow.ai.assistant({ messages: history(get().chats[flowId] ?? []), flow: editor.flow, processId: editor.processId });
          const now = useEditor.getState();
          if (now.flow?.id !== flowId) return;
          const index = useApp.getState().index;
          const applied = applyActions(now.flow, now.processId, reply.actions, index);
          if (applied.flow !== now.flow) now.change(() => applied.flow);
          const after = useEditor.getState().flow!;
          const skipped = [...applied.skipped];
          if (reply.dropped.length) skipped.push(`Use steps Autoflow doesn't have (${reply.dropped.join(', ')})`);

          const touched = new Set(applied.touched);
          // Warnings too: a variable that is never set is usually the assistant's own slip.
          const issues = touched.size ? (await check(after)).filter((i) => i.step_id && touched.has(i.step_id)) : [];
          const todo = issues.filter((i) => i.severity === 'error' && forPerson(after, i));
          const fixable = issues.filter((i) => !forPerson(after, i));
          const title = (id: string) => {
            const step = findStep(after, id);
            return step ? step.label || index.get(step.activity)?.title || step.activity : id;
          };
          push(flowId, {
            id: entryId(),
            role: 'assistant',
            text: reply.message,
            changes: applied.changes,
            skipped,
            todo: todo.map((i) => ({ stepId: i.step_id!, text: `${title(i.step_id!)}: ${i.message}` })),
            ...(reply.warning ? { warning: reply.warning } : {}),
            ...(reply.raw ? { raw: reply.raw } : {}),
            ...(applied.flow !== now.flow ? { after } : {}),
          });
          // Problems the assistant can fix itself (a wrong formula, an unknown variable...): ask it,
          // unless it had its tries or reports the same problems again (asking once more won't help).
          const problems = fixable.map((i) => `- [${i.step_id}]${i.field ? ` ${i.field}` : ''}: ${i.message}`).join('\n');
          if (!fixable.length || round >= MAX_FIX_ROUNDS || problems === lastProblems) break;
          lastProblems = problems;
          push(flowId, {
            id: entryId(),
            role: 'user',
            check: true,
            text: `Studio checked the steps and found problems. Fix them with actions (or ask me what you cannot know):\n${problems}`,
          });
          set({ status: 'Fixing what the check found…' });
        }
      } catch (e) {
        push(flowId, { id: entryId(), role: 'assistant', text: errorMessage(e), error: true });
      } finally {
        if (get().busy === flowId) set({ busy: null, status: '' });
      }
    },

    undo: (id) => {
      const { flow, undo } = useEditor.getState();
      if (!flow) return;
      const entry = (get().chats[flow.id] ?? []).find((e) => e.id === id);
      if (!entry?.after || entry.undone || flow !== entry.after) return;
      undo();
      patch(flow.id, id, (e) => ({ ...e, undone: true }));
    },

    clear: () => {
      const flowId = useEditor.getState().flow?.id;
      if (flowId && !get().busy) set({ chats: { ...get().chats, [flowId]: [] } });
    },

    startNew: async (text) => {
      const id = `flow_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
      await window.autoflow.flows.save({ id, name: 'New automation', description: '', ...TEMPLATES[0]!.build() });
      set({ pending: { flowId: id, text }, open: true });
      return id;
    },

    takePending: (flowId) => {
      const pending = get().pending;
      if (pending?.flowId !== flowId) return null;
      set({ pending: null });
      return pending.text;
    },
  };
});
