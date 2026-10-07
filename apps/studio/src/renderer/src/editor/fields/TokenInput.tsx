// A text box where variables appear as chips. The stored value is plain text with
// {{expression}} parts; users never see or type that syntax unless they want to.
import { Button, cn, Icon, Tooltip } from '@autoflow/ui';
import { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { exprLabel, parseTemplate } from '../../lib/catalog';
import type { VariableInfo } from '../../lib/scope';
import { VariablePicker } from './VariablePicker';

export interface TokenInputHandle {
  insert(expr: string): void;
  focus(): void;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  variables: VariableInfo[];
  columnsFor: (name: string) => string[];
  placeholder?: string;
  multiline?: boolean;
  id?: string;
  ariaLabel?: string;
  invalid?: boolean;
  /** Extra button(s) shown at the right, e.g. "Browse…". */
  addon?: React.ReactNode;
  /** Open the variable list as soon as the field is empty and focused (for "pick a variable" settings). */
  preferVariables?: boolean;
  className?: string;
}

function chip(expr: string): HTMLSpanElement {
  const { label, formula } = exprLabel(expr);
  const span = document.createElement('span');
  span.dataset.expr = expr;
  span.dataset.formula = String(formula);
  span.contentEditable = 'false';
  span.title = formula ? `Formula: ${expr}` : label;
  span.textContent = formula ? `ƒ ${label.length > 28 ? `${label.slice(0, 27)}…` : label}` : label;
  return span;
}

function render(el: HTMLElement, value: string, multiline: boolean): void {
  const nodes: Node[] = [];
  for (const seg of parseTemplate(value)) {
    if (seg.kind === 'expr') {
      nodes.push(chip(seg.expr));
      continue;
    }
    const lines = multiline ? seg.text.split('\n') : [seg.text.replace(/\n/g, ' ')];
    lines.forEach((line, i) => {
      if (i > 0) nodes.push(document.createElement('br'));
      if (line) nodes.push(document.createTextNode(line));
    });
  }
  el.replaceChildren(...nodes);
}

function serialize(el: HTMLElement): string {
  let out = '';
  const walk = (node: Node, isFirstBlock: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += (node.nodeValue ?? '').replace(/ /g, ' ');
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.dataset.expr !== undefined) {
      out += `{{${node.dataset.expr}}}`;
      return;
    }
    if (node.tagName === 'BR') {
      out += '\n';
      return;
    }
    // Chromium wraps new lines in <div> when pressing Enter in contentEditable.
    if ((node.tagName === 'DIV' || node.tagName === 'P') && !isFirstBlock) out += '\n';
    node.childNodes.forEach((child, i) => walk(child, i === 0));
  };
  el.childNodes.forEach((child, i) => walk(child, i === 0));
  // A lone trailing <br> is how browsers keep an empty last line; drop it.
  return out.endsWith('\n') && !out.endsWith('\n\n') ? out.slice(0, -1) : out;
}

export const TokenInput = forwardRef<TokenInputHandle, Props>(function TokenInput(
  {
    value,
    onChange,
    variables,
    columnsFor,
    placeholder,
    multiline = false,
    id,
    ariaLabel,
    invalid,
    addon,
    preferVariables,
    className,
  },
  ref,
) {
  const el = useRef<HTMLDivElement>(null);
  const last = useRef<string | null>(null);
  const savedRange = useRef<Range | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  useLayoutEffect(() => {
    if (el.current && value !== last.current) {
      render(el.current, value, multiline);
      last.current = value;
    }
  }, [value, multiline]);

  const emit = useCallback(() => {
    if (!el.current) return;
    const next = serialize(el.current);
    last.current = next;
    onChange(next);
  }, [onChange]);

  const saveRange = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && el.current?.contains(sel.anchorNode)) savedRange.current = sel.getRangeAt(0).cloneRange();
  };

  const insert = useCallback(
    (expr: string) => {
      const box = el.current;
      if (!box) return;
      const node = chip(expr);
      const range = savedRange.current && box.contains(savedRange.current.startContainer) ? savedRange.current : null;
      if (range) {
        range.deleteContents();
        range.insertNode(node);
      } else {
        box.appendChild(node);
      }
      // Put the caret right after the chip.
      const after = document.createRange();
      after.setStartAfter(node);
      after.collapse(true);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(after);
      savedRange.current = after.cloneRange();
      box.focus();
      emit();
    },
    [emit],
  );

  useImperativeHandle(ref, () => ({ insert, focus: () => el.current?.focus() }), [insert]);

  return (
    <div
      className={cn(
        'flex items-start gap-1 rounded-md border border-border bg-surface pr-1 transition-colors',
        'focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20 hover:border-border-strong',
        invalid && 'border-danger',
        className,
      )}
    >
      <div
        ref={el}
        id={id}
        role="textbox"
        aria-label={ariaLabel}
        aria-multiline={multiline}
        aria-invalid={invalid || undefined}
        tabIndex={0}
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        data-placeholder={placeholder}
        className={cn(
          'af-token-input min-w-0 flex-1 px-2.5 py-[5px] text-sm leading-[20px] break-words outline-none',
          multiline ? 'min-h-[66px] whitespace-pre-wrap' : 'min-h-[30px] whitespace-nowrap overflow-x-auto [scrollbar-width:none]',
        )}
        onInput={emit}
        onKeyUp={saveRange}
        onMouseUp={saveRange}
        onBlur={() => {
          saveRange();
          // Typed "{{name}}" by hand? Show it as a chip once the user leaves the field.
          if (el.current && el.current.textContent?.includes('{{')) render(el.current, serialize(el.current), multiline);
        }}
        onFocus={() => {
          if (preferVariables && !value) setPickerOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !multiline) e.preventDefault();
          if (e.key === '{' || (e.key === ' ' && e.ctrlKey)) {
            // "{" or Ctrl+Space opens the variable list, like autocomplete.
            e.preventDefault();
            saveRange();
            setPickerOpen(true);
          }
        }}
        onPaste={(e) => {
          e.preventDefault();
          let text = e.clipboardData.getData('text/plain');
          if (!multiline) text = text.replace(/\r?\n/g, ' ');
          document.execCommand('insertText', false, text);
        }}
      />
      <div className="flex shrink-0 items-center gap-0.5 py-[3px]">
        {addon}
        <VariablePicker
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          variables={variables}
          columnsFor={columnsFor}
          onPick={(expr) => {
            setPickerOpen(false);
            // Let the popover close and focus return before inserting at the caret.
            requestAnimationFrame(() => insert(expr));
          }}
          trigger={
            <span>
              <Tooltip content="Insert a variable (or press { )">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Insert variable"
                  onMouseDown={saveRange}
                  className={cn(preferVariables && !value && 'text-primary')}
                >
                  <Icon name="braces" size={14} />
                </Button>
              </Tooltip>
            </span>
          }
        />
      </div>
    </div>
  );
});
