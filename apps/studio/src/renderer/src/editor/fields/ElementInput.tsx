import type { Element, Selector, SelectorStrategy } from '@autoflow/flow-types';
import { Badge, Button, Dialog, Field, Icon, Input, Menu, Select, Tooltip } from '@autoflow/ui';
import { useEffect, useState } from 'react';
import { newStepId } from '../../lib/flowOps';
import { errorMessage, useApp } from '../../store/app';
import { useEditor } from '../../store/editor';
import { firstBrowserUrl } from '../../lib/recording';
import { useElements } from '../hooks';
import { PickingOverlay } from '../Recorder';

export const STRATEGY_LABELS: Record<SelectorStrategy, string> = {
  role: 'Role and name (most reliable)',
  label: 'Field label',
  placeholder: 'Placeholder text',
  text: 'Visible text',
  testid: 'Test id',
  css: 'CSS selector',
  xpath: 'XPath',
  uia: 'Windows UI path',
  image: 'Image',
  ocr: 'Text on screen (OCR)',
};

const WEB_STRATEGIES: SelectorStrategy[] = ['role', 'label', 'placeholder', 'text', 'testid', 'css', 'xpath'];
const DESKTOP_STRATEGIES: SelectorStrategy[] = ['uia', 'image', 'ocr'];

function addOrReplaceElement(element: Element) {
  useEditor.getState().change((flow) => {
    const others = (flow.elements ?? []).filter((e) => e.id !== element.id);
    return { ...flow, elements: [...others, element] };
  });
}

/**
 * Pick a UI element: on screen (recorder), from the elements already captured in this
 * flow, or by typing selectors (advanced).
 */
export function ElementInput({
  value,
  onChange,
  kind,
}: {
  value: unknown;
  onChange: (id: string | undefined) => void;
  kind: 'web' | 'desktop';
}) {
  const elements = useElements();
  const toast = useApp((s) => s.toast);
  const [editing, setEditing] = useState<Element | null>(null);
  const [picking, setPicking] = useState(false);
  const element = typeof value === 'string' ? elements.get(value) : undefined;
  const sameKind = [...elements.values()].filter((e) => e.kind === kind);

  const pick = async () => {
    setPicking(true);
    try {
      const flow = useEditor.getState().flow;
      const picked = await window.autoflow.engine.call<Element | null>(
        kind === 'web' ? 'picker.web' : 'picker.desktop',
        { url: lastUrl(sameKind) ?? (flow ? firstBrowserUrl(flow) : undefined) },
        15 * 60_000,
      );
      if (picked) {
        const el = { ...picked, id: picked.id || `el_${newStepId()}` };
        addOrReplaceElement(el);
        onChange(el.id);
      }
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setPicking(false);
    }
  };

  return (
    <div className="space-y-1.5">
      {element ? (
        <div className="flex items-center gap-2 rounded-md border border-border bg-surface p-1.5">
          <Thumbnail element={element} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium">{element.name}</p>
            <p className="truncate text-[11px] text-subtle">
              {element.selectors.length} way{element.selectors.length === 1 ? '' : 's'} to find it ·{' '}
              {STRATEGY_LABELS[element.selectors[0]!.strategy].split(' (')[0]}
            </p>
          </div>
          <Menu
            trigger={
              <Button variant="ghost" size="icon-sm" aria-label="Element options">
                <Icon name="ellipsis" size={15} />
              </Button>
            }
            items={[
              { label: 'Pick again on screen', icon: <Icon name="crosshair" size={14} />, onSelect: () => void pick() },
              { label: 'Edit how it is found', icon: <Icon name="settings-2" size={14} />, onSelect: () => setEditing(element) },
              'separator',
              { label: 'Clear', icon: <Icon name="x" size={14} />, onSelect: () => onChange(undefined) },
            ]}
          />
        </div>
      ) : (
        <div className="flex gap-1">
          <Button variant="outline" className="flex-1" loading={picking} icon={<Icon name="crosshair" size={15} />} onClick={pick}>
            {picking ? 'Click the element on screen…' : 'Pick on screen'}
          </Button>
          <Menu
            trigger={
              <Button aria-label="Other ways to choose an element">
                <Icon name="chevron-down" size={15} />
              </Button>
            }
            items={[
              ...sameKind.map((e) => ({ label: e.name, icon: <Icon name="mouse-pointer-2" size={14} />, onSelect: () => onChange(e.id) })),
              ...(sameKind.length ? (['separator'] as const) : []),
              {
                label: 'Type selectors (advanced)',
                icon: <Icon name="code" size={14} />,
                onSelect: () =>
                  setEditing({
                    id: `el_${newStepId()}`,
                    name: '',
                    kind,
                    selectors: [{ strategy: kind === 'web' ? 'css' : 'uia', value: '' }],
                  }),
              },
            ]}
          />
        </div>
      )}
      {picking && <PickingOverlay onCancel={() => void window.autoflow.engine.call('picker.cancel')} />}
      <ElementDialog
        element={editing}
        onClose={() => setEditing(null)}
        onSave={(el) => {
          addOrReplaceElement(el);
          onChange(el.id);
          setEditing(null);
        }}
      />
    </div>
  );
}

function lastUrl(elements: Element[]): string | undefined {
  const withUrl = elements.map((e) => e.context?.url).filter((u): u is string => typeof u === 'string');
  return withUrl[withUrl.length - 1];
}

export function Thumbnail({ element, size = 40 }: { element: Element; size?: number }) {
  if (element.screenshot) {
    return (
      <img
        src={element.screenshot}
        alt=""
        className="shrink-0 rounded border border-border bg-white object-contain"
        style={{ width: size * 1.6, height: size }}
      />
    );
  }
  return (
    <span className="flex shrink-0 items-center justify-center rounded border border-dashed border-border-strong text-subtle" style={{ width: size * 1.6, height: size }}>
      <Icon name="mouse-pointer-2" size={16} />
    </span>
  );
}

function ElementDialog({ element, onClose, onSave }: { element: Element | null; onClose: () => void; onSave: (el: Element) => void }) {
  const [draft, setDraft] = useState<Element | null>(element);
  useEffect(() => {
    setDraft(element);
  }, [element]);
  if (!draft) return null;
  const strategies = draft.kind === 'web' ? WEB_STRATEGIES : DESKTOP_STRATEGIES;
  const setSelector = (i: number, patch: Partial<Selector>) =>
    setDraft({ ...draft, selectors: draft.selectors.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const move = (i: number, d: number) => {
    const list = draft.selectors.slice();
    const [item] = list.splice(i, 1);
    list.splice(i + d, 0, item!);
    setDraft({ ...draft, selectors: list });
  };
  const valid = draft.name.trim() && draft.selectors.some((s) => s.value.trim());

  return (
    <Dialog
      open={!!element}
      onOpenChange={(o) => !o && onClose()}
      title={element?.name ? `Element “${element.name}”` : 'New element'}
      description="Autoflow tries these ways to find the element, top to bottom. Backups keep automations working when a page changes."
      width="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!valid}
            onClick={() => onSave({ ...draft, name: draft.name.trim(), selectors: draft.selectors.filter((s) => s.value.trim()) })}
          >
            Save element
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-end gap-3">
          {element?.screenshot && <Thumbnail element={draft} size={56} />}
          <Field label="Name" htmlFor="el-name" required className="flex-1" help="How it appears in steps, e.g. “Submit button”.">
            <Input id="el-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} autoFocus />
          </Field>
        </div>
        <div className="space-y-2">
          {draft.selectors.map((s, i) => (
            <div key={i} className="flex items-start gap-1.5 rounded-md border border-border bg-surface-2 p-2">
              <Badge tone={i === 0 ? 'primary' : 'neutral'} className="mt-1.5">{i === 0 ? 'First' : `Backup ${i}`}</Badge>
              <div className="grid flex-1 grid-cols-[200px_1fr] gap-1.5">
                <Select
                  value={s.strategy}
                  onChange={(strategy) => setSelector(i, { strategy: strategy as SelectorStrategy })}
                  options={strategies.map((st) => ({ value: st, label: STRATEGY_LABELS[st] }))}
                />
                <Input value={s.value} onChange={(e) => setSelector(i, { value: e.target.value })} placeholder={s.strategy === 'role' ? 'button' : 'value'} className="font-mono text-xs" />
                {s.strategy === 'role' && (
                  <Input
                    className="col-start-2"
                    value={String(s.options?.name ?? '')}
                    placeholder="Accessible name, e.g. Sign in"
                    onChange={(e) => setSelector(i, { options: { ...s.options, name: e.target.value } })}
                  />
                )}
              </div>
              <div className="flex">
                <Tooltip content="Try earlier">
                  <Button variant="ghost" size="icon-sm" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                    <Icon name="arrow-up" size={13} />
                  </Button>
                </Tooltip>
                <Button variant="ghost" size="icon-sm" aria-label="Remove" onClick={() => setDraft({ ...draft, selectors: draft.selectors.filter((_, j) => j !== i) })}>
                  <Icon name="x" size={13} />
                </Button>
              </div>
            </div>
          ))}
          <Button
            size="sm"
            icon={<Icon name="plus" size={14} />}
            onClick={() => setDraft({ ...draft, selectors: [...draft.selectors, { strategy: strategies[0]!, value: '' }] })}
          >
            Add backup
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
