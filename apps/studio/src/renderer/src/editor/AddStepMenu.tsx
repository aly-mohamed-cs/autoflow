import type { ActivityDef } from '@autoflow/flow-types';
import { cn, IconTile, Input, Popover } from '@autoflow/ui';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useApp } from '../store/app';

/** Searchable list of every step type, grouped by category. */
export function AddStepMenu({
  trigger,
  onPick,
  open,
  onOpenChange,
}: {
  trigger: ReactNode;
  onPick: (def: ActivityDef) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const index = useApp((s) => s.index);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const results = useMemo(() => searchActivities(index.catalog.activities, query), [index, query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
    }
  }, [open]);
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  let running = -1;
  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      trigger={trigger}
      className="w-[360px] p-0"
      align="center"
    >
      <div className="border-b border-border p-2">
        <Input
          autoFocus
          value={query}
          aria-label="Search steps"
          placeholder="What should happen? e.g. click, excel, wait"
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            const flat = results.flatMap((g) => g.items);
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, flat.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === 'Enter' && flat[active]) {
              e.preventDefault();
              onPick(flat[active]!);
            }
          }}
        />
      </div>
      <div ref={listRef} className="max-h-96 overflow-y-auto p-1" role="listbox" aria-label="Steps">
        {results.length === 0 && (
          <p className="p-4 text-center text-[13px] text-subtle">No step matches “{query}”.</p>
        )}
        {results.map((group) => (
          <div key={group.category} className="mb-1">
            <p className="px-2 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-subtle uppercase">
              {group.category}
            </p>
            {group.items.map((def) => {
              running += 1;
              const i = running;
              return (
                <button
                  key={def.id}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  data-index={i}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => onPick(def)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-left',
                    i === active && 'bg-primary-soft',
                  )}
                >
                  <IconTile name={def.icon} category={def.category} size="sm" />
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium">{def.title}</span>
                    {def.description && (
                      <span className="block truncate text-[11px] text-subtle">
                        {def.description}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </Popover>
  );
}

const SYNONYMS: Record<string, string[]> = {
  'browser.click': ['press', 'button', 'link'],
  'browser.type': ['fill', 'enter', 'write', 'input', 'field'],
  'excel.read': ['open', 'spreadsheet', 'xlsx', 'sheet', 'load'],
  'control.if': ['condition', 'decide', 'check', 'when', 'else'],
  'control.for_each': ['loop', 'each row', 'every', 'iterate'],
  'control.wait': ['delay', 'sleep', 'pause'],
  'control.try': ['error', 'catch', 'fail', 'handle'],
  'data.filter': ['where', 'keep', 'remove rows'],
  'data.merge': ['vlookup', 'join', 'match'],
  'data.lookup': ['vlookup', 'find'],
  'browser.download': ['save', 'export'],
};

export function searchActivities(
  activities: ActivityDef[],
  query: string,
): { category: string; items: ActivityDef[] }[] {
  const q = query.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  const matches = activities.filter((a) => {
    if (!q) return !a.advanced;
    const hay = [a.title, a.description, a.category, a.id, ...(SYNONYMS[a.id] ?? [])]
      .join(' ')
      .toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const groups = new Map<string, ActivityDef[]>();
  for (const a of matches) groups.set(a.category, [...(groups.get(a.category) ?? []), a]);
  return [...groups.entries()].map(([category, items]) => ({ category, items }));
}
