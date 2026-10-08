// Drag & drop state shared by the step library and the canvas.
import type { CollisionDetection } from '@dnd-kit/core';
import { pointerWithin } from '@dnd-kit/core';
import { create } from 'zustand';

export type DragItem = { kind: 'new'; activity: string } | { kind: 'step'; stepId: string };
export type DropData =
  | { kind: 'step'; stepId: string }
  | { kind: 'end'; listKey: string }
  /** A connector or empty lane in the Flow view: an exact place in a list. */
  | { kind: 'slot'; listKey: string; index: number };

export interface DropTarget {
  listKey: string;
  index: number;
  /** Step the indicator line is drawn on, and on which side. */
  stepId?: string;
  side?: 'before' | 'after';
}

interface DndState {
  dragging: DragItem | null;
  target: DropTarget | null;
  setDragging(item: DragItem | null): void;
  setTarget(target: DropTarget | null): void;
}

export const useDnd = create<DndState>((set) => ({
  dragging: null,
  target: null,
  setDragging: (dragging) => set({ dragging }),
  setTarget: (target) => set({ target }),
}));

/** Of all drop zones under the pointer, pick the innermost (smallest) one. */
export const innermostUnderPointer: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits
    .map((hit) => {
      const rect = args.droppableRects.get(hit.id);
      return { hit, area: rect ? rect.width * rect.height : Number.MAX_SAFE_INTEGER };
    })
    .sort((a, b) => a.area - b.area)
    .map((x) => x.hit);
};
