// An X, Y position ("120, 45"), typed or picked on screen.
import type { Element } from '@autoflow/flow-types';
import { Button, Icon } from '@autoflow/ui';
import { useState } from 'react';
import type { VariableInfo } from '../../lib/scope';
import { errorMessage, useApp } from '../../store/app';
import { PickingOverlay } from '../Recorder';
import { useElements } from '../hooks';
import { TokenInput } from './TokenInput';

interface Picked {
  screen: { x: number; y: number };
  window: { x: number; y: number; title: string; process: string } | null;
  element: { x: number; y: number } | null;
}

export type PointMode = 'window' | 'screen' | 'element';

/**
 * The point is measured from the top-left corner of a window, of the screen, or of the
 * step's element (a point inside it).
 */
export function PointInput({
  id,
  value,
  onChange,
  mode,
  params,
  onParams,
  canPick,
  ariaLabel,
  placeholder,
  variables,
  columnsFor,
  invalid,
}: {
  id: string;
  value: unknown;
  onChange: (v: string | undefined) => void;
  mode: PointMode;
  params: Record<string, unknown>;
  /** Fill in other settings too (the window a picked point is in). */
  onParams: (patch: Record<string, unknown>) => void;
  canPick: boolean;
  ariaLabel: string;
  placeholder?: string;
  variables: VariableInfo[];
  columnsFor: (name: string) => string[];
  invalid?: boolean;
}) {
  const elements = useElements();
  const toast = useApp((s) => s.toast);
  const [picking, setPicking] = useState(false);
  const element: Element | undefined =
    mode === 'element' && typeof params.element === 'string'
      ? elements.get(params.element)
      : undefined;

  const pick = async () => {
    setPicking(true);
    try {
      const picked = await window.autoflow.engine.call<Picked | null>(
        'picker.point',
        element ? { element } : {},
        15 * 60_000,
      );
      if (!picked) return;
      if (mode === 'screen') {
        onChange(`${picked.screen.x}, ${picked.screen.y}`);
      } else if (mode === 'element') {
        if (!picked.element) {
          toast(
            element
              ? 'The element was not on screen, so the point inside it is unknown. Show it and pick again.'
              : 'Pick the element first, then the point inside it.',
            'error',
          );
          return;
        }
        onChange(`${picked.element.x}, ${picked.element.y}`);
      } else {
        if (!picked.window) {
          toast('No window was under the mouse. Pick a point inside a program window.', 'error');
          return;
        }
        onChange(`${picked.window.x}, ${picked.window.y}`);
        // A point in a window only makes sense with that window: fill it in if it is not set.
        if (!params.window && !params.process && picked.window.title) {
          onParams({ window: picked.window.title, process: picked.window.process });
        }
      }
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setPicking(false);
    }
  };

  return (
    <>
      <TokenInput
        id={id}
        value={typeof value === 'string' ? value : value == null ? '' : String(value)}
        onChange={(v) => onChange(v || undefined)}
        placeholder={placeholder}
        ariaLabel={ariaLabel}
        invalid={invalid}
        variables={variables}
        columnsFor={columnsFor}
        addon={
          canPick ? (
            <Button
              size="sm"
              variant="ghost"
              loading={picking}
              icon={<Icon name="crosshair" size={14} />}
              onClick={() => void pick()}
              title="Point at the spot on screen and press Ctrl"
            >
              Pick position
            </Button>
          ) : undefined
        }
      />
      {picking && (
        <PickingOverlay
          kind="point"
          onCancel={() => void window.autoflow.engine.call('picker.cancel')}
        />
      )}
    </>
  );
}
