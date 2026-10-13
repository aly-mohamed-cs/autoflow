// Element inspector (Brity "Inspector"): browse a program window's controls as a tree and use one
// as an element - for controls that are hard to point at (hidden, tiny, deep in lists).
import type { Element } from '@autoflow/flow-types';
import { Badge, Button, cn, Dialog, Icon, Select, Spinner } from '@autoflow/ui';
import { useEffect, useState } from 'react';
import { errorMessage, useApp } from '../../store/app';

interface WindowInfo {
  handle: number;
  title: string;
  process: string;
}

interface Node {
  index: number;
  name: string;
  type: string;
  automation_id: string;
  label: string;
  has_children: boolean;
}

const call = <T,>(method: string, params: Record<string, unknown> = {}) =>
  window.autoflow.engine.call<T>(method, params);

export function InspectorDialog({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (element: Element) => void;
}) {
  const toast = useApp((s) => s.toast);
  const [windows, setWindows] = useState<WindowInfo[] | null>(null);
  const [handle, setHandle] = useState<number | null>(null);
  const [selected, setSelected] = useState<number[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setWindows(null);
    call<{ windows: WindowInfo[] }>('inspector.windows')
      .then((r) => setWindows(r.windows))
      .catch((e) => toast(errorMessage(e), 'error'));
  };
  useEffect(() => {
    if (open) {
      setSelected(null);
      load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on opening only
  }, [open]);

  const use = async () => {
    if (handle === null || !selected) return;
    setBusy(true);
    try {
      onPick(await call<Element>('inspector.element', { handle, path: selected }));
      onClose();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Browse a program's controls"
      description="Choose the window, open the controls inside it and pick one. Clicking a control outlines it on the screen."
      width="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!selected} onClick={() => void use()}>
            Use this element
          </Button>
        </>
      }
    >
      <div className="flex gap-1">
        <div className="min-w-0 flex-1">
          <Select
            aria-label="Window"
            value={handle === null ? '' : String(handle)}
            onChange={(v) => {
              setHandle(Number(v));
              setSelected(null);
            }}
            placeholder={windows ? 'Choose a window' : 'Looking for windows…'}
            options={(windows ?? []).map((w) => ({
              value: String(w.handle),
              label: w.title,
              description: w.process,
            }))}
          />
        </div>
        <Button aria-label="Look for windows again" title="Look for windows again" onClick={load}>
          <Icon name="refresh-cw" size={15} />
        </Button>
      </div>
      <div
        className="mt-3 h-80 overflow-auto rounded-md border border-border p-1"
        role="tree"
        aria-label="Controls"
      >
        {handle === null ? (
          <p className="p-3 text-[13px] text-subtle">Choose a window first.</p>
        ) : (
          <Branch
            key={handle}
            handle={handle}
            path={[]}
            selected={selected}
            onSelect={setSelected}
          />
        )}
      </div>
    </Dialog>
  );
}

function Branch({
  handle,
  path,
  selected,
  onSelect,
}: {
  handle: number;
  path: number[];
  selected: number[] | null;
  onSelect: (path: number[]) => void;
}) {
  const [nodes, setNodes] = useState<Node[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    call<{ children: Node[] }>('inspector.children', { handle, path })
      .then((r) => setNodes(r.children))
      .catch((e) => setError(errorMessage(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a branch loads once
  }, []);
  if (error) return <p className="px-2 py-1 text-[12px] text-danger">{error}</p>;
  if (!nodes) return <Spinner className="m-2 text-primary" />;
  if (!nodes.length) return <p className="px-2 py-1 text-[12px] text-subtle">Nothing inside.</p>;
  return (
    <ul role="group">
      {nodes.map((node) => (
        <TreeNode
          key={node.index}
          handle={handle}
          node={node}
          path={[...path, node.index]}
          selected={selected}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}

function TreeNode({
  handle,
  node,
  path,
  selected,
  onSelect,
}: {
  handle: number;
  node: Node;
  path: number[];
  selected: number[] | null;
  onSelect: (path: number[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const isSelected = !!selected && selected.join('.') === path.join('.');
  return (
    <li
      role="treeitem"
      aria-selected={isSelected}
      aria-expanded={node.has_children ? open : undefined}
    >
      <div
        className={cn(
          'flex items-center gap-1 rounded px-1 py-0.5 text-[13px]',
          isSelected ? 'bg-primary-soft' : 'hover:bg-surface-2',
        )}
      >
        <button
          type="button"
          aria-label={open ? 'Close' : 'Open'}
          className={cn('rounded p-0.5 text-subtle', !node.has_children && 'invisible')}
          onClick={() => setOpen((o) => !o)}
        >
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} />
        </button>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => {
            onSelect(path);
            void call('inspector.highlight', { handle, path }).catch(() => undefined);
          }}
          onDoubleClick={() => node.has_children && setOpen((o) => !o)}
        >
          <Badge>{node.type}</Badge>
          <span className="truncate">{node.label || node.name || '(no name)'}</span>
          {node.automation_id && (
            <span className="truncate text-[11px] text-subtle">#{node.automation_id}</span>
          )}
        </button>
      </div>
      {open && (
        <div className="ml-4">
          <Branch handle={handle} path={path} selected={selected} onSelect={onSelect} />
        </div>
      )}
    </li>
  );
}
