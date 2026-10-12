// What can be done with the selected steps: copy / cut / paste (also between automations),
// group, delete, select all. Shared by keyboard shortcuts, menus and the settings panel.
import { createStep } from '../lib/catalog';
import {
  copySteps,
  flatIds,
  locate,
  pasteSteps,
  processSteps,
  readClipboard,
  removeSteps,
  rootRef,
  topLevelSteps,
  wrapSteps,
  type StepClipboard,
} from '../lib/flowOps';
import { useApp } from '../store/app';
import { useEditor } from '../store/editor';

/** Used when the system clipboard can't be read (it is also written, so other apps see the text). */
let fallback: StepClipboard | null = null;

function selection(): string[] {
  const { flow, selectedIds } = useEditor.getState();
  if (!flow) return [];
  return topLevelSteps(flow, selectedIds).map((s) => s.id);
}

export async function copySelection(): Promise<number> {
  const { flow } = useEditor.getState();
  const clip = flow ? copySteps(flow, selection()) : null;
  if (!clip) return 0;
  fallback = clip;
  try {
    await navigator.clipboard.writeText(JSON.stringify(clip, null, 2));
  } catch {
    /* the in-app copy still works for pasting here */
  }
  useApp
    .getState()
    .toast(`Copied ${clip.steps.length} step${clip.steps.length === 1 ? '' : 's'}.`, 'success');
  return clip.steps.length;
}

export async function cutSelection(): Promise<void> {
  const ids = selection();
  if (!ids.length) return;
  await copySelection();
  deleteSelection();
}

export async function pasteClipboard(): Promise<void> {
  let clip: StepClipboard | null = null;
  try {
    clip = readClipboard(await navigator.clipboard.readText());
  } catch {
    /* fall back to what was copied in this window */
  }
  clip ??= fallback;
  if (!clip) {
    useApp.getState().toast('Nothing to paste: copy steps first (Ctrl+C).', 'info');
    return;
  }
  const { flow, selectedId, processId, change, selectMany } = useEditor.getState();
  if (!flow) return;
  const where = selectedId ? locate(flow, selectedId) : null;
  const ref = where?.ref ?? rootRef(processId);
  const index = where ? where.index + 1 : processSteps(flow, processId).length;
  let ids: string[] = [];
  const copied = clip;
  change((f) => {
    const r = pasteSteps(f, ref, index, copied);
    ids = r.ids;
    return r.flow;
  });
  selectMany(ids);
}

export function deleteSelection(): void {
  const ids = selection();
  if (!ids.length) return;
  const { change, select } = useEditor.getState();
  change((f) => removeSteps(f, ids));
  select(null);
}

/** Put the selected steps (of one list) into a Group box. */
export function groupSelection(): boolean {
  const { flow, change, select } = useEditor.getState();
  const index = useApp.getState().index;
  const def = index.get('control.group');
  const ids = selection();
  if (!flow || !def || !ids.length) return false;
  const box = createStep(def, index);
  const wrapped = wrapSteps(flow, ids, box, 'body');
  if (!wrapped) {
    useApp
      .getState()
      .toast('Only steps that are next to each other in the same list can be grouped.', 'error');
    return false;
  }
  change(() => wrapped);
  select(box.id);
  return true;
}

export function canGroup(): boolean {
  const { flow } = useEditor.getState();
  const ids = selection();
  return (
    !!flow &&
    ids.length > 0 &&
    wrapSteps(flow, ids, { id: 'x', activity: 'control.group' }, 'body') !== null
  );
}

export function selectAll(): void {
  const { flow, processId, selectMany } = useEditor.getState();
  if (flow) selectMany(flatIds(flow, processId));
}
