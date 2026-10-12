import type { ActivityDef } from '@autoflow/flow-types';
import { cn, Icon, IconTile, Input, Tooltip } from '@autoflow/ui';
import { useDraggable } from '@dnd-kit/core';
import { useMemo, useState } from 'react';
import { locate, processSteps, rootRef } from '../lib/flowOps';
import { useApp } from '../store/app';
import { useEditor } from '../store/editor';
import { searchActivities } from './AddStepMenu';
import { useAddStep } from './Canvas';

export function StepLibrary() {
  const index = useApp((s) => s.index);
  const [query, setQuery] = useState('');
  const [closed, setClosed] = useState<Set<string>>(new Set(['Text', 'Data']));
  const [showAdvanced, setShowAdvanced] = useState(false);
  const add = useAddStep();

  const groups = useMemo(() => {
    const categories = index.catalog.categories.map((c) => c.id);
    const found = query.trim()
      ? searchActivities(index.catalog.activities, query)
      : categories
          .map((category) => ({
            category,
            items: (index.byCategory.get(category) ?? []).filter((a) => showAdvanced || !a.advanced),
          }))
          .filter((g) => g.items.length);
    return found;
  }, [index, query, showAdvanced]);

  /** Click = add after the selected step (or at the end). */
  const addByClick = (def: ActivityDef) => {
    const { flow, selectedId, processId } = useEditor.getState();
    if (!flow) return;
    const where = selectedId ? locate(flow, selectedId) : null;
    if (where) add(def, where.ref, where.index + 1);
    else add(def, rootRef(processId), processSteps(flow, processId).length);
  };

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-border bg-surface" aria-label="Step library">
      <div className="space-y-2 border-b border-border p-3">
        <div className="relative">
          <Icon name="search" size={15} className="absolute top-2 left-2.5 text-subtle" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a step" aria-label="Find a step" className="pl-8" />
        </div>
        <p className="text-[11px] text-subtle">Drag steps into the automation, or click to add.</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {groups.map(({ category, items }) => {
          const meta = index.catalog.categories.find((c) => c.id === category);
          const isClosed = !query && closed.has(category);
          return (
            <section key={category} className="mb-1">
              <button
                type="button"
                aria-expanded={!isClosed}
                onClick={() =>
                  setClosed((prev) => {
                    const next = new Set(prev);
                    if (next.has(category)) next.delete(category);
                    else next.add(category);
                    return next;
                  })
                }
                className="flex w-full items-center gap-2 rounded px-1.5 py-1.5 text-left hover:bg-surface-2"
              >
                <IconTile name={meta?.icon ?? 'box'} category={category} size="sm" />
                <span className="flex-1 text-[13px] font-semibold">{category}</span>
                <span className="text-[11px] text-subtle">{items.length}</span>
                <Icon name={isClosed ? 'chevron-right' : 'chevron-down'} size={14} className="text-subtle" />
              </button>
              {!isClosed && (
                <ul className="mt-0.5 mb-2 space-y-px pl-2">
                  {items.map((def) => (
                    <LibraryItem key={def.id} def={def} onAdd={() => addByClick(def)} />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
        {groups.length === 0 && <p className="p-4 text-center text-[13px] text-subtle">No step matches “{query}”.</p>}
      </div>
      {!query && (
        <label className="flex items-center gap-2 border-t border-border px-3 py-2 text-xs text-muted">
          <input type="checkbox" checked={showAdvanced} onChange={(e) => setShowAdvanced(e.target.checked)} />
          Show advanced steps
        </label>
      )}
    </aside>
  );
}

function LibraryItem({ def, onAdd }: { def: ActivityDef; onAdd: () => void }) {
  const drag = useDraggable({ id: `new:${def.id}`, data: { kind: 'new', activity: def.id } });
  return (
    <li>
      <Tooltip content={def.description || def.title} side="right">
        <button
          ref={drag.setNodeRef}
          type="button"
          onClick={onAdd}
          {...drag.listeners}
          {...drag.attributes}
          className={cn(
            'flex w-full cursor-grab items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-fg hover:bg-primary-soft active:cursor-grabbing',
            drag.isDragging && 'opacity-40',
          )}
        >
          <Icon name={def.icon} size={15} className="shrink-0 text-subtle" />
          <span className="truncate">{def.title}</span>
          {def.advanced && <span className="ml-auto text-[10px] text-subtle">advanced</span>}
        </button>
      </Tooltip>
    </li>
  );
}
