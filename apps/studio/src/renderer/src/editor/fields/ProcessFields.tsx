// Settings of a "Run sub-process" step: which sub-process, and the values for its inputs.
import { Button, Icon, Select } from '@autoflow/ui';
import { addProcess, NO_PROCESSES } from '../../lib/flowOps';
import { TYPE_LABELS, type VariableInfo } from '../../lib/scope';
import { useEditor } from '../../store/editor';
import { TokenInput } from './TokenInput';

export function ProcessSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: unknown;
  onChange: (v: string) => void;
}) {
  const processes = useEditor((s) => s.flow?.processes ?? NO_PROCESSES);
  const change = useEditor((s) => s.change);
  const showProcess = useEditor((s) => s.showProcess);
  const current = typeof value === 'string' ? value : '';

  const create = () => {
    let created = '';
    change((f) => {
      const r = addProcess(f, `Sub-process ${(f.processes?.length ?? 0) + 1}`);
      created = r.id;
      return r.flow;
    });
    if (created) onChange(created);
  };

  if (processes.length === 0) {
    return (
      <div className="space-y-1.5">
        <p className="text-[13px] text-muted">This automation has no sub-processes yet.</p>
        <Button icon={<Icon name="plus" size={14} />} onClick={create}>
          Create a sub-process
        </Button>
      </div>
    );
  }
  return (
    <div className="flex gap-1">
      <div className="min-w-0 flex-1">
        <Select
          id={id}
          value={current}
          onChange={onChange}
          placeholder="Choose a sub-process"
          options={processes.map((p) => ({ value: p.id, label: p.name }))}
        />
      </div>
      <Button
        aria-label="Open the sub-process"
        title="Open the sub-process"
        disabled={!processes.some((p) => p.id === current)}
        onClick={() => showProcess(current)}
      >
        <Icon name="square-arrow-out-up-right" size={15} />
      </Button>
      <Button aria-label="New sub-process" title="New sub-process" onClick={create}>
        <Icon name="plus" size={15} />
      </Button>
    </div>
  );
}

/** One box per input of the chosen sub-process. */
export function ProcessInputsInput({
  value,
  onChange,
  processId,
  variables,
  columnsFor,
}: {
  value: unknown;
  onChange: (v: Record<string, unknown>) => void;
  processId: unknown;
  variables: VariableInfo[];
  columnsFor: (name: string) => string[];
}) {
  const process = useEditor((s) => s.flow?.processes?.find((p) => p.id === processId));
  const values = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  if (!process) return <p className="text-[13px] text-subtle">Choose a sub-process first.</p>;
  const inputs = process.inputs ?? [];
  if (inputs.length === 0) {
    return (
      <p className="text-[13px] text-subtle">
        “{process.name}” has no inputs. Add them in its settings (open its tab and click an empty
        spot).
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {inputs.map((input) => {
        const current = values[input.name];
        return (
          <div key={input.name} className="space-y-1">
            <p className="flex items-baseline gap-1.5 text-[13px] font-medium">
              <span className="font-mono">{input.name}</span>
              <span className="text-[11px] font-normal text-subtle">
                {TYPE_LABELS[input.type ?? 'any']}
              </span>
            </p>
            <TokenInput
              value={typeof current === 'string' ? current : current == null ? '' : String(current)}
              placeholder={
                input.default != null && input.default !== ''
                  ? `Default: ${String(input.default)}`
                  : 'Empty'
              }
              onChange={(v) => {
                const next = { ...values, [input.name]: v };
                if (v === '') delete next[input.name];
                onChange(next);
              }}
              ariaLabel={`Input ${input.name}`}
              variables={variables}
              columnsFor={columnsFor}
            />
          </div>
        );
      })}
    </div>
  );
}
