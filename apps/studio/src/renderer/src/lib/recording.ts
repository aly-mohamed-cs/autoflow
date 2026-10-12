// Turn what the recorder captured into ordinary steps and elements.
import type { Element, Flow, Step } from '@autoflow/flow-types';
import { walkFlow } from '@autoflow/flow-types';
import { newStepId } from './flowOps';

export interface RecordedAction {
  action:
    | 'click'
    | 'type'
    | 'select'
    | 'check'
    | 'upload'
    | 'goto'
    | 'switch_tab'
    | 'keys'
    | 'activate'
    | 'launch';
  element?: Element;
  value?: string | null;
  password?: boolean;
  press_enter?: boolean;
  option?: string;
  checked?: boolean;
  url?: string;
  /** Desktop recording: single / double / right click, keys like "Control+S", window title, program path. */
  click?: 'single' | 'double' | 'right';
  keys?: string;
  window?: string;
  program?: string;
  /** Live updates: this replaces the previous action (a click that became a double-click...). */
  replace_last?: boolean;
}

const selectorKey = (e: Element) => {
  const s = e.selectors[0]!;
  return `${e.kind}|${s.strategy}|${s.value}|${JSON.stringify(s.options ?? {})}|${JSON.stringify(e.context?.frames ?? [])}`;
};

export function stepsFromRecording(
  actions: RecordedAction[],
  options: { startUrl?: string; existingElements?: Element[]; addOpenBrowser: boolean },
): { steps: Step[]; elements: Element[] } {
  const known = new Map((options.existingElements ?? []).map((e) => [selectorKey(e), e]));
  const added: Element[] = [];
  const usedNames = new Set((options.existingElements ?? []).map((e) => e.name));

  const elementId = (el: Element | undefined): string => {
    if (!el) return '';
    const key = selectorKey(el);
    const existing = known.get(key);
    if (existing) return existing.id;
    let name = el.name;
    for (let i = 2; usedNames.has(name); i++) name = `${el.name} ${i}`;
    usedNames.add(name);
    const fresh = { ...el, name };
    known.set(key, fresh);
    added.push(fresh);
    return fresh.id;
  };

  const steps: Step[] = [];
  const step = (activity: string, params: Record<string, unknown>, label?: string): void => {
    steps.push({ id: newStepId(), activity, params, ...(label ? { label } : {}) });
  };

  if (options.addOpenBrowser && options.startUrl) step('browser.open', { url: options.startUrl });

  for (const a of actions) {
    // Elements say where they came from: web pages (browser steps) or Windows programs (desktop steps).
    const kind = a.element?.kind === 'desktop' ? 'desktop' : 'browser';
    switch (a.action) {
      case 'click':
        step(`${kind}.click`, {
          element: elementId(a.element),
          ...(a.click && a.click !== 'single' ? { click: a.click } : {}),
        });
        break;
      case 'type':
        if (a.password) {
          // Never store a password in a flow: leave it empty and ask for a credential.
          step(
            `${kind}.type`,
            { element: elementId(a.element), text: '', press_enter: !!a.press_enter },
            `Type the password into ${a.element?.name ?? 'the field'} (choose a credential)`,
          );
        } else {
          step(`${kind}.type`, {
            element: elementId(a.element),
            text: a.value ?? '',
            ...(a.press_enter ? { press_enter: true } : {}),
          });
        }
        break;
      case 'select':
        step(`${kind}.select`, { element: elementId(a.element), option: a.option ?? '' });
        break;
      case 'check':
        step(`${kind}.check`, { element: elementId(a.element), checked: a.checked ?? true });
        break;
      case 'keys':
        if (a.keys) step('desktop.send_keys', { keys: a.keys });
        break;
      case 'activate':
        if (a.window)
          step('desktop.activate_window', {
            window: a.window,
            ...(a.program ? { process: a.program } : {}),
          });
        break;
      case 'launch':
        if (a.program) step('desktop.launch', { program: a.program, window: a.window ?? '' });
        break;
      case 'upload':
        step('browser.upload', { element: elementId(a.element), file: '' });
        break;
      case 'goto':
        if (a.url && a.url !== 'about:blank') step('browser.go_to', { url: a.url });
        break;
      case 'switch_tab':
        step('browser.switch_tab', { match: 'newest' });
        break;
    }
  }
  return { steps, elements: added };
}

/** The address of the flow's first "Open browser" step, if it's plain text. */
export function firstBrowserUrl(flow: Flow): string | undefined {
  for (const { step } of walkFlow(flow)) {
    const url = step.params?.url;
    if (step.activity === 'browser.open' && typeof url === 'string' && url && !url.includes('{{'))
      return url;
  }
  return undefined;
}

export function hasBrowserOpen(flow: Flow): boolean {
  for (const { step } of walkFlow(flow)) if (step.activity === 'browser.open') return true;
  return false;
}
