import * as RadixSelect from '@radix-ui/react-select';
import * as RadixSwitch from '@radix-ui/react-switch';
import { Check, ChevronDown, CircleHelp } from 'lucide-react';
import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from '../utils';
import { Tooltip } from './overlay';

const FIELD =
  'w-full rounded-md border border-border bg-surface px-2.5 text-sm text-fg placeholder:text-subtle ' +
  'transition-colors hover:border-border-strong focus:border-primary focus:outline-none ' +
  'focus:ring-2 focus:ring-primary/20 disabled:opacity-60 aria-[invalid=true]:border-danger';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} className={cn(FIELD, 'h-8', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={cn(FIELD, 'min-h-20 py-1.5 leading-relaxed', className)} {...rest} />;
  },
);

/** Label + control + help text + error, the standard layout of every setting. */
export function Field({
  label,
  help,
  error,
  warning,
  required,
  htmlFor,
  children,
  inline,
  className,
}: {
  label: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  warning?: ReactNode;
  required?: boolean;
  htmlFor?: string;
  children: ReactNode;
  inline?: boolean;
  className?: string;
}) {
  return (
    <div className={cn(inline ? 'flex items-center justify-between gap-3' : 'space-y-1', className)}>
      <label htmlFor={htmlFor} className="flex items-center gap-1 text-[13px] font-medium text-fg">
        {label}
        {required && <span className="text-danger" aria-label="required">*</span>}
        {help && inline && (
          <Tooltip content={help}>
            <CircleHelp size={13} className="text-subtle" />
          </Tooltip>
        )}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-danger">{error}</p>
      ) : warning ? (
        <p className="text-xs text-warning">{warning}</p>
      ) : (
        help && !inline && <p className="text-xs text-subtle">{help}</p>
      )}
    </div>
  );
}

export interface SelectOption {
  value: string;
  label: ReactNode;
  description?: ReactNode;
}

const EMPTY = '__empty__'; // Radix Select does not allow '' as an item value

export function Select({
  value,
  onChange,
  options,
  placeholder = 'Choose…',
  id,
  className,
  disabled,
}: {
  value: string | undefined;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  id?: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <RadixSelect.Root
      value={value === '' ? EMPTY : value}
      onValueChange={(v) => onChange(v === EMPTY ? '' : v)}
      disabled={disabled}
    >
      <RadixSelect.Trigger
        id={id}
        className={cn(FIELD, 'flex h-8 items-center justify-between gap-2 text-left', className)}
      >
        <RadixSelect.Value placeholder={<span className="text-subtle">{placeholder}</span>} />
        <RadixSelect.Icon>
          <ChevronDown size={14} className="text-subtle" />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={4}
          className="z-50 max-h-80 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border border-border bg-surface shadow-pop animate-fade-in"
        >
          <RadixSelect.Viewport className="p-1">
            {options.map((o) => (
              <RadixSelect.Item
                key={o.value || EMPTY}
                value={o.value === '' ? EMPTY : o.value}
                className="relative flex cursor-default items-start gap-2 rounded px-2 py-1.5 pr-7 text-sm outline-none select-none data-[highlighted]:bg-primary-soft data-[highlighted]:text-fg"
              >
                <div>
                  <RadixSelect.ItemText>{o.label}</RadixSelect.ItemText>
                  {o.description && <div className="text-xs text-subtle">{o.description}</div>}
                </div>
                <RadixSelect.ItemIndicator className="absolute top-2 right-2 text-primary">
                  <Check size={14} />
                </RadixSelect.ItemIndicator>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}

export function Switch({
  checked,
  onChange,
  id,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  id?: string;
  label?: string;
  disabled?: boolean;
}) {
  const auto = useId();
  return (
    <RadixSwitch.Root
      id={id ?? auto}
      checked={checked}
      onCheckedChange={onChange}
      disabled={disabled}
      aria-label={label}
      className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-border-strong transition-colors data-[state=checked]:bg-primary disabled:opacity-50"
    >
      <RadixSwitch.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[18px]" />
    </RadixSwitch.Root>
  );
}

/** Segmented control for 2-4 short choices (e.g. "All" / "Any"). */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = 'md',
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: ReactNode }[];
  size?: 'sm' | 'md';
}) {
  return (
    <div role="radiogroup" className="inline-flex rounded-md border border-border bg-surface-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded px-2.5 font-medium transition-colors',
            size === 'sm' ? 'h-6 text-xs' : 'h-7 text-[13px]',
            value === o.value ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
