// Settings of the Screen steps: the picture to look for, and an area of the screen or a window.
import { Button, Icon } from '@autoflow/ui';
import { useState } from 'react';
import type { VariableInfo } from '../../lib/scope';
import { errorMessage, useApp } from '../../store/app';
import { TokenInput } from './TokenInput';

interface Snip {
  image: string;
  x: number;
  y: number;
  width: number;
  height: number;
  screen: { x: number; y: number };
  window: { title: string; process: string; x: number; y: number } | null;
}

/** Studio steps aside, the screen freezes and the person draws a box. */
async function snip(): Promise<Snip | null> {
  await window.autoflow.app.minimize();
  await new Promise((r) => setTimeout(r, 400)); // let the window animate away first
  try {
    return await window.autoflow.engine.call<Snip | null>('picker.snip', {}, 10 * 60_000);
  } finally {
    await window.autoflow.app.restore();
  }
}

export function ImageInput({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (v: string | undefined) => void;
}) {
  const toast = useApp((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const image = typeof value === 'string' && value ? value : null;

  const capture = async () => {
    setBusy(true);
    try {
      const shot = await snip();
      if (shot) onChange(shot.image);
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const fromFile = async () => {
    const path = await window.autoflow.dialog.openFile({
      title: 'Picture to look for',
      filters: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'bmp'] }],
    });
    if (!path) return;
    try {
      const r = await window.autoflow.engine.call<{ image: string }>('image.from_file', { path });
      onChange(r.image);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  return (
    <div className="space-y-1.5">
      {image ? (
        <div className="flex items-center gap-2 rounded-md border border-border bg-surface p-1.5">
          <img
            src={image.startsWith('data:') ? image : undefined}
            alt="The picture to look for"
            className="max-h-20 max-w-[220px] rounded border border-border bg-white object-contain"
          />
          <span className="min-w-0 flex-1 truncate text-[12px] text-subtle">
            {image.startsWith('data:') ? 'Captured picture' : image}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Remove the picture"
            onClick={() => onChange(undefined)}
          >
            <Icon name="x" size={14} />
          </Button>
        </div>
      ) : (
        <p className="rounded-md border border-dashed border-border-strong p-3 text-center text-[13px] text-subtle">
          No picture yet
        </p>
      )}
      <div className="flex gap-1">
        <Button
          variant="outline"
          className="flex-1"
          loading={busy}
          icon={<Icon name="scan" size={15} />}
          onClick={() => void capture()}
        >
          {image ? 'Capture again' : 'Capture'}
        </Button>
        <Button icon={<Icon name="folder-open" size={15} />} onClick={() => void fromFile()}>
          From file
        </Button>
      </div>
      <p className="text-[11px] text-subtle">
        Capture: Studio steps aside and the screen freezes - draw a box around the button, icon or
        text to find.
      </p>
    </div>
  );
}

/** "x, y, width, height" of part of a window (or of the screen), typed or drawn. */
export function RegionInput({
  id,
  value,
  onChange,
  params,
  onParams,
  ariaLabel,
  placeholder,
  variables,
  columnsFor,
}: {
  id: string;
  value: unknown;
  onChange: (v: string | undefined) => void;
  params: Record<string, unknown>;
  onParams: (patch: Record<string, unknown>) => void;
  ariaLabel: string;
  placeholder?: string;
  variables: VariableInfo[];
  columnsFor: (name: string) => string[];
}) {
  const toast = useApp((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const inWindow = params.look_in === 'window';

  const pick = async () => {
    setBusy(true);
    try {
      const shot = await snip();
      if (!shot) return;
      if (inWindow) {
        if (!shot.window) {
          toast('That area is not inside a program window. Draw it inside the window.', 'error');
          return;
        }
        onChange(
          `${shot.x - shot.window.x}, ${shot.y - shot.window.y}, ${shot.width}, ${shot.height}`,
        );
        if (!params.window && !params.process && shot.window.title) {
          onParams({ window: shot.window.title, process: shot.window.process });
        }
      } else {
        onChange(
          `${shot.x - shot.screen.x}, ${shot.y - shot.screen.y}, ${shot.width}, ${shot.height}`,
        );
      }
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <TokenInput
      id={id}
      value={typeof value === 'string' ? value : ''}
      onChange={(v) => onChange(v || undefined)}
      placeholder={placeholder}
      ariaLabel={ariaLabel}
      variables={variables}
      columnsFor={columnsFor}
      addon={
        <Button
          size="sm"
          variant="ghost"
          loading={busy}
          icon={<Icon name="scan" size={14} />}
          onClick={() => void pick()}
          title="Draw a box around the part to use"
        >
          Pick area
        </Button>
      }
    />
  );
}
