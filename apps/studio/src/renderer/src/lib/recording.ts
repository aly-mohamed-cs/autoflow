// Turn what the recorder captured into ordinary steps and elements.
import type { Element, Flow, Step } from '@autoflow/flow-types';
import { newStepId } from './flowOps';

export interface RecordedAction {
  action: 'click' | 'type' | 'select' | 'check' | 'upload' | 'goto' | 'switch_tab';
  element?: Element;
  value?: string | null;
  password?: boolean;
  press_enter?: boolean;
  option?: string;
  checked?: boolean;
  url?: string;
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
    switch (a.action) {
      case 'click':
        step('browser.click', { element: elementId(a.element) });
        break;
      case 'type':
        if (a.password) {
          // Never store a password in a flow: leave it empty and ask for a credential.
          step('browser.type', { element: elementId(a.element), text: '', press_enter: !!a.press_enter }, `Type the password into ${a.element?.name ?? 'the field'} (choose a credential)`);
        } else {
          step('browser.type', { element: elementId(a.element), text: a.value ?? '', ...(a.press_enter ? { press_enter: true } : {}) });
        }
        break;
      case 'select':
        step('browser.select', { element: elementId(a.element), option: a.option ?? '' });
        break;
      case 'check':
        step('browser.check', { element: elementId(a.element), checked: a.checked ?? true });
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
  const visit = (steps: Step[] = []): string | undefined => {
    for (const s of steps) {
      if (s.activity === 'browser.open' && typeof s.params?.url === 'string' && s.params.url && !s.params.url.includes('{{')) {
        return s.params.url;
      }
      for (const block of Object.values(s.blocks ?? {})) {
        const found = visit(block);
        if (found) return found;
      }
    }
    return undefined;
  };
  return visit(flow.steps);
}

export function hasBrowserOpen(flow: Flow): boolean {
  const visit = (steps: Step[] = []): boolean =>
    steps.some((s) => s.activity === 'browser.open' || Object.values(s.blocks ?? {}).some(visit));
  return visit(flow.steps);
}
