// The AI assistant chat in Studio: it talks with the person AND changes the automation with small
// actions (add steps, change settings, connect...). Studio applies them, checks the result with the
// engine and lets the person undo. The model only sees the step types that matter for the
// conversation - with their settings in detail - instead of the whole catalog, so its answers fit
// in the context of a local model and pick the right steps.
import { normalizeCondition, type ActivityDef, type Catalog, type Flow, type Step } from '@autoflow/flow-types';
import catalogJson from '@autoflow/flow-types/activity-catalog.json';
import { z } from 'zod';
import { extractJson, sanitizeSteps, stripThinking } from './ai.js';

const catalog = catalogJson as unknown as Catalog;
const ACTIVITIES = new Map(catalog.activities.map((a) => [a.id, a]));
const OPERATORS = catalog.operators.map((o) => o.name).join(', ');
const IDENT = /^[A-Za-z_]\w{0,63}$/;

/** Always offered: the steps almost every automation needs. */
const CORE = [
  'control.log',
  'control.set_variable',
  'control.if',
  'control.for_each',
  'control.try',
  'control.get_credential',
  'control.wait',
  'control.run_process',
];

/** The steps most automations of a kind need: preferred when their category comes up. */
const EVERYDAY = new Set([
  'browser.open', 'browser.go_to', 'browser.click', 'browser.type', 'browser.select', 'browser.get_text', 'browser.extract_table', 'browser.wait_for', 'browser.download', 'browser.close',
  'excel.read', 'excel.read_cell', 'excel.write_cell', 'excel.write_table', 'excel.append_row', 'excel.update_row',
  'desktop.launch', 'desktop.activate_window', 'desktop.click', 'desktop.type', 'desktop.select', 'desktop.get_text', 'desktop.send_keys', 'desktop.wait_for', 'desktop.close_program',
  'files.list', 'files.copy', 'files.move', 'files.exists', 'files.wait_for_file', 'files.read_csv', 'files.write_csv', 'files.create_folder',
  'pdf.read_text', 'pdf.extract_tables', 'pdf.extract_fields',
  'email.send', 'email.read', 'email.save_attachments',
  'data.filter', 'data.sort', 'data.add_column', 'data.merge', 'data.group', 'data.add_row', 'data.create_table',
  'text.extract_between', 'text.replace', 'text.format_date', 'text.current_date',
  'screen.click_text', 'screen.read_text', 'word.replace_text', 'http.request',
]);

/** Words people use for a kind of step -> the catalog categories they mean. */
const TOPICS: [RegExp, string[]][] = [
  [/\b(web|website|site|portal|page|browser|url|link|login|log ?in|sign ?in|edge|chrome|form|click|button|field)/i, ['Browser']],
  [/\b(excel|xlsx?|sheet|spreadsheet|workbook|cell|column|row)/i, ['Excel', 'Data']],
  [/\b(csv|table|filter|sort|join|merge|dedup|duplicate|group|sum|total|lookup)/i, ['Data']],
  [/\b(file|folder|directory|copy|move|rename|delete|zip|unzip|download|attachment|path)/i, ['Files']],
  [/\b(pdf|invoice|receipt|scan|ocr)/i, ['PDF']],
  [/\b(e-?mail|mail|inbox|outlook|exchange|smtp|send|reply|forward)/i, ['Email']],
  [/\b(desktop|program|application|app|window|erp|legacy|notepad|calculator)/i, ['Desktop']],
  [/\b(screen|image|picture|citrix|remote desktop|rdp|text on screen)/i, ['Screen']],
  [/\b(word|docx|document|letter|template)/i, ['Word']],
  [/\b(powerpoint|pptx|slides?|presentation)/i, ['PowerPoint']],
  [/\b(api|http|rest|json|xml|webhook|request|teams|slack)/i, ['Web & APIs', 'Data']],
  [/\b(sql|database|db|query|oracle|postgres|mysql|sql server)/i, ['Database']],
  [/\b(sap|transaction|va01|me21n)/i, ['SAP']],
  [/\b(ftp|sftp|ssh|server)/i, ['FTP & SSH']],
  [/\b(ai|classify|summari[sz]e|translate|extract fields|categor)/i, ['AI']],
  [/\b(queue|work item|shared value|asset)/i, ['Orchestrator']],
  [/\b(command|powershell|script|python|clipboard|registry)/i, ['System']],
  [/\b(text|date|format|split|replace|upper|lower|number|regex|encrypt|base64)/i, ['Text']],
  [/\b(loop|each|every|repeat|while|if|condition|decide|decision|wait|retry|error|fail|stop|sub-?process)/i, ['Control']],
];

const STOP = new Set(
  'that this with from then also have into what when where your them they want need please make some just like after before there which will should could would every about'.split(' '),
);
const TITLES = new Map(catalog.activities.map((a) => [a.id, `${a.id.split('.').pop()!.replace(/_/g, ' ')} ${a.title}`.toLowerCase()]));
const SHORT = new Set(['csv', 'pdf', 'zip', 'ocr', 'sql', 'ftp', 'url', 'api', 'xml', 'ssh', 'sap', 'tab', 'key']);
const words = (text: string) => (text.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []).filter((w) => (w.length > 3 || SHORT.has(w)) && !STOP.has(w));

/**
 * The step types that matter for this conversation, most relevant first: what the person talks
 * about (the newest message counts most) ranked by the words of each step's title and kind. The
 * core steps and the steps the automation already uses are always included.
 */
export function relevantActivities(messages: { role: string; content: string }[], flow: Flow | null, limit = 32): ActivityDef[] {
  const scores = new Map<string, number>();
  const add = (id: string, n: number) => scores.set(id, (scores.get(id) ?? 0) + n);
  const usable = catalog.activities.filter((a) => !a.advanced);
  const recent = messages.slice(-6);
  recent.forEach((m, i) => {
    const weight = i === recent.length - 1 ? 3 : 1;
    const text = m.content;
    const terms = new Set(words(text));
    for (const [pattern, categories] of TOPICS) {
      if (!pattern.test(text)) continue;
      for (const a of usable) if (categories.includes(a.category)) add(a.id, (EVERYDAY.has(a.id) ? 2.5 : 1) * weight);
    }
    // A word in few step titles says more than one in many ("type" vs "excel").
    const inTitles = new Map([...terms].map((t) => [t, usable.filter((a) => TITLES.get(a.id)!.includes(t)).length]));
    for (const a of usable) {
      // A step named by its id (the model's own earlier answer, or the person).
      if (text.includes(a.id)) add(a.id, 8 * weight);
      const title = TITLES.get(a.id)!;
      const description = a.description.toLowerCase();
      for (const t of terms) {
        if (title.includes(t)) add(a.id, (3 / Math.sqrt(inTitles.get(t) || 1)) * weight);
        else if (description.includes(t)) add(a.id, 0.5 * weight);
      }
    }
  });
  const must = new Set(CORE);
  if (flow) {
    for (const step of walk([...(flow.steps ?? []), ...(flow.processes ?? []).flatMap((p) => p.steps ?? [])])) must.add(step.activity);
    if (flow.flowchart || flow.processes?.some((p) => p.flowchart)) must.add('control.decision');
  }
  const ok = (id: string) => ACTIVITIES.has(id) && !ACTIVITIES.get(id)!.advanced;
  const ranked = [...scores.entries()].filter(([id, score]) => score > 0 && ok(id) && !must.has(id)).sort((a, b) => b[1] - a[1]);
  const chosen = [...[...must].filter(ok), ...ranked.slice(0, Math.max(limit - must.size, 8)).map(([id]) => id)];
  return chosen.sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0)).map((id) => ACTIVITIES.get(id)!);
}

function* walk(steps: Step[]): Generator<Step> {
  for (const s of steps) {
    yield s;
    for (const list of Object.values(s.blocks ?? {})) yield* walk(list);
  }
}

type Prop = ActivityDef['params']['properties'][string];

function describeSetting(name: string, p: Prop, required: boolean): string {
  const ui = p['x-ui'] as string | undefined;
  const kinds: Record<string, string> = {
    element: 'screen element - leave out, the person picks it',
    credential: 'name of a saved credential',
    file: 'file path',
    folder: 'folder path',
    save_file: 'file path to save to',
    condition: 'condition object',
    variable: 'a {{variable}}',
    variable_name: 'name for a new variable',
    key_values: 'object of name: value',
    list: 'list',
    column: 'column name',
    url: 'web address',
    multiline: 'text',
    duration: 'seconds',
    process: 'sub-process id',
    point: '"x, y"',
    code: 'code',
  };
  const ref = String(p.$ref ?? '');
  let kind = (ui && kinds[ui]) || (ref.endsWith('/Condition') ? 'condition object' : '');
  if (!kind) {
    const options = (p.enum as unknown[] | undefined) ?? (p.anyOf as { enum?: unknown[] }[] | undefined)?.find((x) => x.enum)?.enum;
    if (options) kind = `one of ${options.map((o) => JSON.stringify(o)).join('|')}`;
    else kind = String(p.type ?? (p.anyOf as { type?: string }[] | undefined)?.map((x) => x.type).filter((t) => t && t !== 'null').join('/') ?? 'any');
  }
  const extra = [
    required ? 'required' : '',
    p.default !== undefined && p.default !== null && p.default !== '' ? `default ${JSON.stringify(p.default)}` : '',
  ].filter(Boolean);
  const help = typeof p.description === 'string' && p.description ? ` - ${p.description.slice(0, 110)}` : '';
  return `${name} (${kind}${extra.length ? `; ${extra.join('; ')}` : ''}): ${p.title ?? name}${help}`;
}

/** One step type, with its settings in detail (what a model needs to fill them in). */
export function describeActivity(a: ActivityDef): string {
  const props = a.params.properties ?? {};
  const required = new Set(a.params.required ?? []);
  const settings = Object.entries(props)
    .filter(([, p]) => !p['x-advanced'])
    .map(([name, p]) => `    ${describeSetting(name, p, required.has(name))}`);
  const blocks = a.blocks.length
    ? `\n    blocks: ${a.block_list ? `${a.block_list.prefix}1, ${a.block_list.prefix}2... (one per item of ${a.block_list.param}), ` : ''}${a.blocks.map((b) => `${b.name} ("${b.title}")`).join(', ')}`
    : '';
  const outputs = a.outputs.length ? `\n    results: ${a.outputs.map((o) => `${o.name} (${o.type}, default variable ${o.default_variable})`).join(', ')}` : '';
  const ports = a.ports?.length ? `\n    ways out (free connections): ${a.ports.map((p) => p.name).join(', ')}` : '';
  return `- ${a.id} - ${a.title}: ${a.description || a.title}\n${settings.join('\n') || '    (no settings)'}${blocks}${outputs}${ports}`;
}

/** The other step types, by category, so the model knows what exists (it can name them to get details). */
function catalogIndex(shown: Set<string>): string {
  const byCategory = new Map<string, string[]>();
  for (const a of catalog.activities) {
    if (a.advanced || shown.has(a.id)) continue;
    byCategory.set(a.category, [...(byCategory.get(a.category) ?? []), `${a.id} (${a.title})`]);
  }
  return [...byCategory.entries()].map(([c, list]) => `${c}: ${list.join(', ')}`).join('\n');
}

const short = (v: unknown) => {
  const text = typeof v === 'string' ? v : JSON.stringify(v);
  return text.length > 70 ? `${text.slice(0, 67)}...` : text;
};

// What is typed into screens stays on the PC (it can be personal data); a variable it types is shown.
const TYPED: Record<string, string[]> = {
  'browser.type': ['text'],
  'desktop.type': ['text'],
  'desktop.send_keys': ['keys'],
  'sap.set_text': ['text'],
  'sap.table_action': ['value'],
};
const SECRET_NAME = /password|secret|token/i;

function shownValue(activity: string, name: string, value: unknown, ui: unknown): string {
  if (ui === 'password' || SECRET_NAME.test(name)) return '(hidden)';
  if (TYPED[activity]?.includes(name) && typeof value === 'string' && !/^\{\{[^{}]+\}\}$/.test(value.trim())) {
    return '(typed text, not shown)';
  }
  return short(value);
}

/** The automation as the model reads it: steps with ids, settings, results, connectors. */
export function describeFlow(flow: Flow, processId: string | null): string {
  const process = processId ? flow.processes?.find((p) => p.id === processId) : null;
  const steps = (process ? process.steps : flow.steps) ?? [];
  const chart = process ? process.flowchart : flow.flowchart;
  const elements = new Map((flow.elements ?? []).map((e) => [e.id, e.name]));
  const lines: string[] = [];
  lines.push(`Automation "${flow.name}"${flow.description ? ` - ${flow.description}` : ''}`);
  if (process) lines.push(`You are working in its sub-process "${process.name}" (id ${process.id}).`);
  if (flow.processes?.length) lines.push(`Sub-processes: ${flow.processes.map((p) => `${p.name} (id ${p.id})`).join(', ')}`);
  lines.push(
    chart
      ? 'Free connections: steps run along the connectors from Start; steps nothing leads to do not run.'
      : 'Steps run one after the other.',
  );
  const vars = flow.variables ?? [];
  lines.push(
    vars.length
      ? `Variables: ${vars.map((v) => `${v.name} (${v.type ?? 'any'}${v.is_input ? ', start value' : ''}${v.is_output ? ', result' : ''})`).join(', ')}`
      : 'Variables: none yet',
  );
  const render = (list: Step[], indent: string) => {
    for (const s of list) {
      const def = ACTIVITIES.get(s.activity);
      const params = Object.entries(s.params ?? {})
        .filter(([, v]) => v !== '' && v !== null && v !== undefined)
        .map(([k, v]) => {
          const ui = def?.params.properties?.[k]?.['x-ui'];
          if (ui === 'element') return `${k}=(picked: ${elements.get(String(v)) ?? 'element'})`;
          return `${k}=${shownValue(s.activity, k, v, ui)}`;
        });
      const outs = Object.entries(s.outputs ?? {}).map(([k, v]) => `${k}->${v}`);
      lines.push(
        `${indent}[${s.id}] ${s.activity}${s.label ? ` "${s.label}"` : ''}${s.disabled ? ' (skipped)' : ''}${params.length ? ` ${params.join(' ')}` : ''}${outs.length ? ` => ${outs.join(', ')}` : ''}`,
      );
      for (const [block, inner] of Object.entries(s.blocks ?? {})) {
        lines.push(`${indent}  ${block}:`);
        render(inner, `${indent}    `);
      }
    }
  };
  lines.push('Steps:');
  if (steps.length) render(steps, '  ');
  else lines.push('  (none yet)');
  if (chart) {
    const links = (chart.links ?? []).map((l) => `${l.source}->${l.target}${l.port && l.port !== 'next' ? ` (${l.port})` : ''}`);
    lines.push(`Connectors: ${links.join(', ') || 'none'}`);
  }
  return lines.join('\n');
}

const RULES = `You are the assistant inside Autoflow Studio, a no-code RPA tool. You help a non-technical person build and change automations: you talk with them AND change the automation directly with actions.

Reply with ONE JSON object only, no other text:
{"message": "1-4 short, plain sentences: what you changed, what the person still has to do, or ONE question",
 "actions": [ACTION, ...]}

ACTION is one of:
{"type":"add_steps","after":"<step id>"|"start"|"end","steps":[STEP,...]}   steps after a step ("end": at the end)
{"type":"add_steps","inside":{"step":"<step id>","block":"<block name>"},"steps":[STEP,...]}   steps inside a loop / If / Try section, at its end
{"type":"update_step","step":"<step id>","params":{"<setting>":value},"label":"optional new name"}   change only the settings given
{"type":"remove_steps","steps":["<step id>",...]}
{"type":"connect","from":"<step id>"|"start","to":"<step id>","port":"next"|"yes"|"no"}   only with free connections; "yes"/"no" only out of a control.decision
{"type":"add_variable","name":"<identifier>","variable_type":"text"|"number"|"table"|"list"|"file"|"boolean"|"date"|"any","is_input":true|false,"default":value,"description":"..."}
{"type":"rename","name":"...","description":"..."}
{"type":"new_automation","name":"...","description":"..."}   only when no automation is open; then add its steps with "after":"start"
STEP is {"id":"optional name of your own","activity":"<step type id>","label":"optional short name","params":{"<setting>":value},"outputs":{"<result>":"<variable>"},"blocks":{"<block>":[STEP,...]}}
Give a new step an "id" of your own (e.g. "check_total") to use it in later actions of the same reply: "after", "inside", "connect", "update_step".

How Autoflow works:
- Steps run in order (or along their connectors with free connections). Steps added together with one add_steps run one after the other.
- A step's results go into variables (its "outputs"); later settings use them as {{name}}. A column of a table row: {{row["Column"]}}. Formulas work inside {{ }}: {{UPPER(name)}}, {{amount * 1.2}}, {{TODAY()}}, {{CONCAT(a, " ", b)}}.
- Excel, CSV, database or web tables are read into a table variable, then control.for_each with params {"items":"{{table}}","item_variable":"row"} runs its "body" block once per row.
- Websites: browser.open first. Desktop programs: desktop.launch or desktop.attach first. Screen elements (buttons, fields) cannot be known: leave "element" settings out - the person picks them with "Pick on screen" - and say so.
- Passwords never go in steps: control.get_credential with the credential's name gives {{login.username}} / {{login.password}}.
- Conditions (control.if, control.while, control.decision, data.filter) are objects, never text: {"match":"all","rules":[{"left":"{{row[\\"Amount\\"]}}","op":"greater","right":"100"}]}. "match" is "all" or "any". Operators: ${OPERATORS}.
- Use ONLY step types listed in this prompt, with their exact setting names. Leave settings you cannot know (web addresses, file paths, names) as "" and ask for them, or use what the person told you.
- With free connections, a control.decision has two ways out: steps added right after it in the same add_steps go on its "yes" side; a second add_steps with "after" set to the decision goes on its "no" side.
- Recipes (use the real settings listed below):
  Excel rows into a website: control.get_credential -> browser.open (url) -> browser.type / browser.click to log in with {{login.username}} / {{login.password}} -> excel.read (file, sheet) -> control.for_each {"items":"{{excel_data}}","item_variable":"row","index_variable":"row_number"} with body: browser.type text {{row["Column"]}} ..., browser.click, browser.get_text, excel.update_row {"row_number":"{{row_number}}","values":{"Result":"{{page_text}}"}}.
  One failing item must not stop the rest: put the body's steps in control.try (blocks "try" / "catch"; the catch gets {{error}}) and log the error in "catch".
  Downloading from a website (an export, a report): browser.download on the link or button - not browser.click - waits until the file is downloaded and keeps its own name; leave "folder" empty for the Downloads folder; "open_file": true opens it when done. Its output {{downloaded_file}} is the file for later steps (excel.read file {{downloaded_file}}).
  Files of a folder: files.list (folder, pattern "*.pdf") -> control.for_each over {{files}}; PDF values: pdf.extract_fields, or pdf.read_text and text.extract_between.
  Email with a file: email.send (to, subject, body, attachments as a {{variable}}).
  Sending email is most reliable with email.send ("via": "exchange", or "smtp" with the mail server's address) instead of typing into a webmail site: Gmail, Outlook.com and the like often refuse sign-in from automated browsers. Build what the person asks, and mention this in one sentence when they ask for webmail.
  Websites the person signs in to: browser.open with a "profile" name (e.g. "gmail") keeps the login between runs; type the login with control.get_credential, never the password itself. Write a results table: excel.append_row per row, or excel.write_table.
- Change only what was asked; keep the person's work. Refer to existing steps by their [id]. Values shown as (hidden) or (typed text, not shown) stay private: leave them as they are.
- If the request is unclear, ask ONE short question and send no actions.`;

export interface AssistantInput {
  messages: { role: 'user' | 'assistant'; content: string }[];
  flow: Flow | null;
  processId: string | null;
}

export const AssistantBody = z.object({
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(20_000) })).min(1).max(40),
  flow: z.record(z.string(), z.unknown()).nullable().default(null),
  processId: z.string().max(64).nullable().default(null),
});

export function assistantPrompt(input: AssistantInput): { system: string; considered: string[] } {
  const relevant = relevantActivities(input.messages, input.flow);
  const shown = new Set(relevant.map((a) => a.id));
  const system = [
    RULES,
    input.flow ? `\nThe automation that is open:\n${describeFlow(input.flow, input.processId)}` : '\nNo automation is open yet: start with new_automation.',
    `\nStep types you can use (most relevant first), with their settings:\n${relevant.map(describeActivity).join('\n')}`,
    `\nOther step types (name one in your message to get its settings next time):\n${catalogIndex(shown)}`,
  ].join('\n');
  return { system, considered: [...shown] };
}

// -- what comes back -----------------------------------------------------------------------------

export type AssistantAction =
  | { type: 'add_steps'; after?: string; inside?: { step: string; block: string }; steps: Step[] }
  | { type: 'update_step'; step: string; params?: Record<string, unknown>; label?: string }
  | { type: 'remove_steps'; steps: string[] }
  | { type: 'connect'; from: string; to: string; port: 'next' | 'yes' | 'no' }
  | { type: 'add_variable'; name: string; variableType: string; is_input: boolean; default?: unknown; description: string }
  | { type: 'rename'; name: string; description?: string }
  | { type: 'new_automation'; name: string; description: string };

export interface AssistantReply {
  message: string;
  actions: AssistantAction[];
  /** Step types the model used that don't exist (or can't be added by the assistant). */
  dropped: string[];
  /** The model's own answer when it could not be used (shown to help find out why). */
  raw?: string;
  /** Something about the model server the person should know (e.g. it cut the request short). */
  warning?: string;
}

const ACTION_TYPES = new Set(['add_steps', 'update_step', 'remove_steps', 'connect', 'add_variable', 'rename', 'new_automation']);
/** Names small models use for the actions. */
const ACTION_ALIASES: Record<string, string> = {
  add_step: 'add_steps',
  insert_steps: 'add_steps',
  remove_step: 'remove_steps',
  delete_step: 'remove_steps',
  delete_steps: 'remove_steps',
  update_steps: 'update_step',
  change_step: 'update_step',
  create_automation: 'new_automation',
  create_variable: 'add_variable',
};
const MESSAGE_KEYS = ['message', 'reply', 'response', 'answer', 'text', 'explanation'];

const actionKind = (x: Record<string, unknown>) => {
  for (const v of [x.type, x.action]) {
    const k = typeof v === 'string' ? (ACTION_ALIASES[v] ?? v) : '';
    if (ACTION_TYPES.has(k)) return k;
  }
  return '';
};

/** What small models write instead of the asked-for shape: a bare action, a list of steps, other key names. */
function normalizeReply(raw: Record<string, unknown>, flow: Flow | null): { message: string; actions: Record<string, unknown>[] } {
  const message = MESSAGE_KEYS.map((k) => raw[k]).find((v): v is string => typeof v === 'string' && !!v.trim()) ?? '';
  const list = [raw.actions, raw.changes].find(Array.isArray) as unknown[] | undefined;
  let actions = (list ?? []).filter((a): a is Record<string, unknown> => !!a && typeof a === 'object');
  if (!actions.length && actionKind(raw)) actions = [raw];
  if (!actions.length && Array.isArray(raw.steps)) {
    // A whole automation, the way drafts used to be written.
    if (typeof raw.name === 'string' && raw.name.trim() && !(flow?.steps ?? []).length) actions.push({ type: 'rename', name: raw.name, description: raw.description });
    actions.push({ type: 'add_steps', after: 'end', steps: raw.steps });
  }
  return { message, actions };
}

const VARIABLE_TYPES = new Set(['text', 'number', 'table', 'list', 'file', 'boolean', 'date', 'any']);
const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Keep only well-formed actions with known step types and settings; new steps get fresh ids. */
export function parseAssistantReply(answer: string, flow: Flow | null): AssistantReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(stripThinking(answer)));
  } catch {
    // Not JSON: take it as a plain answer without changes.
    return { message: stripThinking(answer).trim().slice(0, 3000) || 'The AI model gave no answer.', actions: [], dropped: [] };
  }
  const raw = normalizeReply(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { actions: parsed }, flow);
  const dropped: string[] = [];
  const actions: AssistantAction[] = [];
  const stepById = new Map([...walk([...(flow?.steps ?? []), ...(flow?.processes ?? []).flatMap((p) => p.steps ?? [])])].map((s) => [s.id, s]));
  // The model's own ids for steps it adds in this reply -> their real ids.
  const aliases = new Map<string, string>();
  const ref = (v: unknown) => {
    const id = str(v, 64);
    return aliases.get(id) ?? id;
  };
  for (const x of raw.actions.slice(0, 30)) {
    switch (actionKind(x)) {
      case 'add_steps': {
        const inside = x.inside && typeof x.inside === 'object' ? (x.inside as Record<string, unknown>) : null;
        const parent = inside ? ref(inside.step) : '';
        const after = ref(x.after);
        const given = Array.isArray(x.steps) ? x.steps : x.step && typeof x.step === 'object' ? [x.step] : [];
        const steps = sanitizeSteps(given, dropped, 0, aliases);
        if (!steps.length) break;
        for (const s of walk(steps)) stepById.set(s.id, s);
        if (inside && stepById.has(parent)) {
          actions.push({ type: 'add_steps', inside: { step: parent, block: str(inside.block, 64) || 'body' }, steps });
        } else {
          actions.push({ type: 'add_steps', after: after === 'start' || after === 'end' || stepById.has(after) ? after : 'end', steps });
        }
        break;
      }
      case 'update_step': {
        const id = ref(x.step);
        const step = stepById.get(id);
        const def = step ? ACTIVITIES.get(step.activity) : undefined;
        if (!step || !def) break;
        const known = new Set(Object.keys(def.params.properties ?? {}));
        const params = Object.fromEntries(
          Object.entries(x.params && typeof x.params === 'object' ? (x.params as Record<string, unknown>) : {})
            .filter(([k]) => known.has(k) && def.params.properties[k]?.['x-ui'] !== 'password')
            .map(([k, v]) => [k, String(def.params.properties[k]?.$ref ?? '').endsWith('/Condition') ? normalizeCondition(v) : v]),
        );
        const label = str(x.label, 120);
        if (Object.keys(params).length || label) actions.push({ type: 'update_step', step: id, ...(Object.keys(params).length ? { params } : {}), ...(label ? { label } : {}) });
        break;
      }
      case 'remove_steps': {
        const ids = (Array.isArray(x.steps) ? x.steps : [x.step]).map(ref).filter((s) => stepById.has(s));
        if (ids.length) actions.push({ type: 'remove_steps', steps: ids });
        break;
      }
      case 'connect': {
        const from = ref(x.from);
        const to = ref(x.to);
        const port = x.port === 'yes' || x.port === 'no' ? x.port : 'next';
        if ((from === 'start' || stepById.has(from)) && stepById.has(to)) actions.push({ type: 'connect', from, to, port });
        break;
      }
      case 'add_variable': {
        const name = str(x.name, 64);
        if (!IDENT.test(name)) break;
        const given = String(x.variable_type ?? x.var_type ?? (x.type !== 'add_variable' && !ACTION_TYPES.has(String(x.type)) ? x.type : ''));
        const type = VARIABLE_TYPES.has(given) ? given : 'any';
        actions.push({ type: 'add_variable', name, variableType: type, is_input: x.is_input === true, ...(x.default !== undefined ? { default: x.default } : {}), description: str(x.description, 300) });
        break;
      }
      case 'rename': {
        const name = str(x.name, 120);
        if (name) actions.push({ type: 'rename', name, ...(typeof x.description === 'string' ? { description: str(x.description, 1000) } : {}) });
        break;
      }
      case 'new_automation': {
        const name = str(x.name, 120) || 'New automation';
        actions.push({ type: 'new_automation', name, description: str(x.description, 1000) });
        break;
      }
    }
  }
  const message = str(raw.message, 3000);
  if (!actions.length && !message) {
    // Nothing usable: say so (instead of "no changes") and show what came back.
    return {
      message: "The AI model's answer didn't fit what Autoflow expects, so nothing was changed. Try asking again in other words; if it keeps happening, an administrator can check the model under Settings → AI assistant → Save and test.",
      actions: [],
      dropped: [...new Set(dropped)],
      raw: stripThinking(answer).trim().slice(0, 1500),
    };
  }
  return { message: message || 'Done.', actions, dropped: [...new Set(dropped)] };
}

