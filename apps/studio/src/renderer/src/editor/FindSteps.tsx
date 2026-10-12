// Find a step in the whole automation (all processes) by what it says (Ctrl+F).
import { walkFlow, type ActivityDef, type Step } from '@autoflow/flow-types';
import { Button, Dialog, Icon, IconTile, Input, Kbd } from '@autoflow/ui';
import { useMemo, useState } from 'react';
import { create } from 'zustand';
import { exprLabel, sentence } from '../lib/catalog';
import { useApp } from '../store/app';
import { useEditor } from '../store/editor';
import { useElements } from './hooks';

const useFind = create<{ open: boolean; set(open: boolean): void }>((set) => ({
  open: false,
  set: (open) => set({ open }),
}));

export const openFind = () => useFind.getState().set(true);

/** The "Find" button for the canvas toolbar, and the dialog it opens. */
export function FindSteps() {
  const open = useFind((s) => s.open);
  const setOpen = useFind((s) => s.set);
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        icon={<Icon name="search" size={14} />}
        onClick={() => setOpen(true)}
        title="Find a step (Ctrl+F)"
      >
        Find
      </Button>
      {open && <FindDialog onClose={() => setOpen(false)} />}
    </>
  );
}

interface Hit {
  step: Step;
  def: ActivityDef | undefined;
  text: string;
  where: string;
}

function FindDialog({ onClose }: { onClose: () => void }) {
  const flow = useEditor((s) => s.flow);
  const revealStep = useEditor((s) => s.revealStep);
  const index = useApp((s) => s.index);
  const elements = useElements();
  const [query, setQuery] = useState('');

  const all = useMemo<Hit[]>(() => {
    if (!flow) return [];
    const names = new Map((flow.processes ?? []).map((p) => [p.id, p.name]));
    return [...walkFlow(flow)].map(({ step, processId }) => {
      const def = index.get(step.activity);
      const said = def
        ? sentence(step, def, { index, elements, processes: names })
            .map((p) =>
              p.kind === 'text'
                ? p.text
                : p.element
                  ? p.element.name
                  : p.segments
                      .map((s) => (s.kind === 'text' ? s.text : exprLabel(s.expr).label))
                      .join(''),
            )
            .join('')
        : step.activity;
      return {
        step,
        def,
        text: [step.label, def?.title, said].filter(Boolean).join(' · '),
        where: processId ? (names.get(processId) ?? processId) : 'Main process',
      };
    });
  }, [flow, index, elements]);

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = words.length
    ? all.filter((h) => words.every((w) => h.text.toLowerCase().includes(w)))
    : all;
  const go = (hit: Hit | undefined) => {
    if (!hit) return;
    revealStep(hit.step.id);
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Find a step"
      description="Search every process of this automation by what its steps do."
      width="lg"
    >
      <Input
        autoFocus
        aria-label="Find a step"
        placeholder="e.g. click save, excel, invoice"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') go(hits[0]);
        }}
      />
      <ul className="mt-3 max-h-80 space-y-1 overflow-y-auto" aria-label="Steps found">
        {hits.slice(0, 100).map((hit) => (
          <li key={hit.step.id}>
            <button
              type="button"
              className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-surface-2"
              onClick={() => go(hit)}
            >
              <IconTile
                name={hit.def?.icon ?? 'circle-help'}
                category={hit.def?.category}
                size="sm"
              />
              <span className="min-w-0 flex-1 truncate text-[13px]">{hit.text}</span>
              <span className="shrink-0 text-[11px] text-subtle">{hit.where}</span>
            </button>
          </li>
        ))}
        {hits.length === 0 && (
          <li className="px-2 py-3 text-[13px] text-subtle">No step matches.</li>
        )}
      </ul>
      <p className="mt-2 text-[11px] text-subtle">
        <Kbd>Enter</Kbd> goes to the first match.
      </p>
    </Dialog>
  );
}
