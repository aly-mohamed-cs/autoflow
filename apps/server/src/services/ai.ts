// Optional AI assistant backed by a self-hosted, OpenAI-compatible model server
// (Ollama, LM Studio, vLLM...). Nothing leaves the company network; it is off until
// an administrator configures it. Model output is never trusted: drafts are checked
// against the activity catalog and reviewed by a person before anything runs.
import { blocksOf, normalizeCondition, type ActivityDef, type Catalog, type Flow, type Step } from '@autoflow/flow-types';
import catalogJson from '@autoflow/flow-types/activity-catalog.json';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { assistantPrompt, parseAssistantReply, type AssistantInput, type AssistantReply } from './assistant.js';
import { HttpError, type Settings } from './core.js';

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/** Qwen3 and other "thinking" models may write <think>...</think> before the answer. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '');
}

export interface AiSettings {
  enabled: boolean;
  /** e.g. http://gpu-server:11434/v1 (Ollama) or http://localhost:1234/v1 (LM Studio) */
  baseUrl: string;
  model: string;
  /** Optional; stored encrypted. */
  apiKey: string;
  timeoutS: number;
}

export const DEFAULT_AI: AiSettings = { enabled: false, baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b-instruct', apiKey: '', timeoutS: 120 };

const catalog = catalogJson as unknown as Catalog;
const OPERATORS = catalog.operators.map((o) => o.name).join(', ');
const ACTIVITIES = new Map(catalog.activities.map((a) => [a.id, a]));

/** A compact description of every step type for the model (id, purpose, settings). */
function catalogForPrompt(): string {
  return catalog.activities
    .filter((a) => !a.advanced)
    .map((a) => {
      const params = Object.keys(a.params.properties ?? {}).filter((p) => !a.params.properties[p]?.['x-advanced']);
      const cases = a.block_list ? `${a.block_list.prefix}1/${a.block_list.prefix}2/... (one per item of ${a.block_list.param})/` : '';
      const blocks = a.blocks.length ? ` blocks: ${cases}${a.blocks.map((b) => b.name).join('/')}` : '';
      const outputs = a.outputs.length ? ` outputs: ${a.outputs.map((o) => o.name).join(',')}` : '';
      return `- ${a.id}: ${a.title}. settings: ${params.join(', ') || 'none'}.${blocks}${outputs}`;
    })
    .join('\n');
}

const DRAFT_RULES = `You design automations for Autoflow, a no-code RPA tool. Reply with JSON only:
{"name": string, "description": string,
 "variables": [{"name": identifier, "type": "text"|"number"|"file"|"table"|"list"|"any", "is_input": boolean, "description": string}],
 "steps": [{"activity": id, "label": optional short text, "params": {...}, "outputs": {"<output>": "<variable>"}, "blocks": {"<block>": [steps]}}]}
Rules:
- Use ONLY the step ids listed below, with their setting names.
- Refer to variables in settings as {{name}}; a column of the current row as {{row["Column"]}}.
- Loops: control.for_each with params {"items": "{{table}}", "item_variable": "row"} and the loop steps in blocks.body.
- Conditions (control.if / control.while "condition", data.filter "condition") are objects, never text:
  {"match": "all", "rules": [{"left": "{{row[\"Amount\"]}}", "op": "greater", "right": "100"}]}
  "match" is "all" or "any". Operators: ${OPERATORS}.
- Leave settings you cannot know (web addresses, screen elements, file paths) as "" - the user fills them in.
- Never put passwords in steps; use control.get_credential.
Available steps:
`;

const REPAIR_RULES = `You repair failed steps in Autoflow, a no-code RPA tool. A step failed while an automation ran.
Using the error and what is on the screen right now, propose new settings for THIS step only. Reply with JSON only:
{"fixable": true|false, "explanation": "1-2 plain sentences a non-technical person understands",
 "params": {"<setting>": <new value>}, "selectors": [<selector>], "element_name": "short name of the element"}
Rules:
- "params" holds only the settings you change, using the setting names given. Keep {{variable}} references where values come from data.
- When an element can't be found or matches several things, give 1-3 "selectors" (best first) that match exactly ONE item in the screen list.
  Web: {"strategy":"role","value":"button","options":{"name":"Save","exact":true}}, {"strategy":"label","value":"Customer"},
  {"strategy":"placeholder","value":"..."}, {"strategy":"text","value":"...","options":{"exact":true}}, {"strategy":"testid","value":"..."}, {"strategy":"css","value":"#id"}.
  Desktop: {"strategy":"uia","value":"Edit #txtName","options":{"automation_id":"txtName","control_type":"Edit"}} or with "name" instead of "automation_id".
- For a missing file, sheet or column, pick the closest real one from the screen information.
- If changing this step cannot fix it (wrong page, missing data, app not open, server down), reply {"fixable": false, "explanation": "..."}.
- Earlier attempts that did not work are listed under "attempts"; do not repeat them.
- Never invent passwords or change credentials.`;

const WEB_STRATEGIES = new Set(['role', 'text', 'label', 'placeholder', 'testid', 'css', 'xpath']);
const SELECTOR_OPTIONS = new Set(['name', 'exact', 'automation_id', 'control_type', 'class_name', 'index']);
const PROTECTED_UI = new Set(['credential', 'password']);
// The assistant may change how a step *finds* things, never what it does with the data: which
// element, how long to wait, which sheet or column, and which file to *read*. Never web addresses,
// typed values, output files or credentials (robots use a fix before anyone reviews it, and page
// text could try to steer the model). Keep in sync with engine/src/autoflow_engine/runtime/repair.py.
const REPAIRABLE_CATEGORIES = new Set(['Browser', 'Desktop', 'Excel', 'Files', 'Data', 'Text', 'PDF']);
const LOCATOR_PARAMS = new Set(['element', 'selector', 'timeout', 'sheet', 'range', 'column', 'columns', 'has_header', 'encoding', 'window', 'process']);
const READ_ONLY = new Set([
  'browser.get_text', 'browser.extract_table', 'browser.wait_for', 'browser.element_exists', 'browser.page_info',
  'desktop.get_text', 'desktop.wait_for', 'desktop.read_table',
  'excel.read', 'excel.read_cell', 'excel.list_sheets',
  'files.list', 'files.exists', 'files.wait_for_file', 'files.info', 'files.read_text', 'files.read_csv',
  'pdf.read_text', 'pdf.extract_tables', 'pdf.extract_fields', 'pdf.page_count', 'pdf.read_image',
]);
const READ_PATH_UI = new Set(['file', 'folder']);

/** Settings of a step type the AI assistant may change when repairing it (empty: never repaired). */
export function changeableParams(activity: string): Set<string> {
  const def = ACTIVITIES.get(activity);
  if (!def || def.advanced || def.blocks.length || !REPAIRABLE_CATEGORIES.has(def.category)) return new Set();
  return new Set(
    Object.entries(def.params.properties ?? {})
      .filter(([name, p]) => {
        const ui = String(p['x-ui']);
        return !PROTECTED_UI.has(ui) && (LOCATOR_PARAMS.has(name) || (READ_ONLY.has(def.id) && READ_PATH_UI.has(ui)));
      })
      .map(([name]) => name),
  );
}

export interface RepairRequest {
  activity: string;
  step: { id: string; label?: string | null; params: Record<string, unknown> };
  element?: Record<string, unknown> | null;
  error: { message: string; hint?: string | null };
  screen?: unknown;
  variables?: unknown[];
  attempts?: unknown[];
  flow_name?: string;
}

export interface RepairReply {
  fixable: boolean;
  explanation: string;
  params?: Record<string, unknown>;
  selectors?: { strategy: string; value: string; options?: Record<string, unknown> }[];
  element_name?: string;
}

/** The model server cut a request to a smaller context than it needs: what to tell people. */
export function contextWarning(read: number, sent: number): string {
  return (
    `The AI model server only read ${read} of about ${sent} tokens of this request, so the model missed part of its instructions. ` +
    'An administrator needs to give the model a larger context: at least 16,384 tokens (LM Studio: Context Length; llama.cpp: -c 32768; Ollama is set by Autoflow), then restart the model server.'
  );
}

/** The address without its OpenAI-style /v1 ending (Ollama's own API lives at the root). */
const serverRoot = (baseUrl: string) => baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');

/**
 * The context Ollama is asked for. Unless told per request, Ollama cuts every prompt to a few
 * thousand tokens and the model never sees the start (the rules) - and its OpenAI-style address
 * can't be told. A fixed size keeps Ollama from reloading the model between requests.
 */
export function ollamaContext(messages: ChatMessage[]): number {
  const tokens = messages.reduce((n, m) => n + m.content.length, 0) / 3.2; // generous
  return tokens + 3072 <= 16_384 ? 16_384 : 32_768;
}

export class AiService {
  /** Model servers that refuse the JSON answer mode (some only take a JSON schema): asked without it. */
  private readonly noJsonMode = new Set<string>();
  /** Whether an address is Ollama (asked once per address). */
  private readonly ollama = new Map<string, boolean>();

  constructor(
    private readonly settings: Settings,
    private readonly decrypt: (sealed: string) => string,
  ) {}

  config(): AiSettings {
    return this.settings.get<AiSettings>('ai', DEFAULT_AI);
  }

  private async chat(messages: ChatMessage[], json: boolean): Promise<string> {
    return (await this.call(messages, json)).content;
  }

  /** Ollama answers /api/version; anything else is spoken to the OpenAI way. */
  private async isOllama(baseUrl: string, headers: Record<string, string>): Promise<boolean> {
    const known = this.ollama.get(baseUrl);
    if (known !== undefined) return known;
    try {
      const res = await fetch(`${serverRoot(baseUrl)}/api/version`, { headers, signal: AbortSignal.timeout(5000) });
      const body = res.ok ? ((await res.json().catch(() => ({}))) as { version?: unknown }) : {};
      const yes = typeof body.version === 'string';
      this.ollama.set(baseUrl, yes);
      return yes;
    } catch {
      return false; // not reachable now: the request itself reports it (and it is asked again next time)
    }
  }

  /** One request to the model server; also how much of the prompt it read (if it says). */
  private async call(messages: ChatMessage[], json: boolean): Promise<{ content: string; promptTokens: number | null }> {
    const cfg = this.config();
    if (!cfg.enabled) throw new HttpError(404, 'The AI assistant is not set up. An administrator can enable it under Settings.');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(cfg.apiKey ? { Authorization: `Bearer ${this.decrypt(cfg.apiKey)}` } : {}),
    };
    if (await this.isOllama(cfg.baseUrl, headers)) return this.callOllama(cfg, headers, messages, json);
    const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutS * 1000);
    const post = (jsonMode: boolean) =>
      fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers,
        body: JSON.stringify({
          model: cfg.model,
          messages,
          temperature: 0.2,
          ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        }),
      });
    try {
      const jsonMode = json && !this.noJsonMode.has(url);
      let res = await post(jsonMode);
      if (jsonMode && res.status === 400) {
        // The prompts ask for JSON anyway, and answers are read leniently.
        this.noJsonMode.add(url);
        res = await post(false);
      }
      if (!res.ok) {
        const detail = await errorDetail(res);
        throw new HttpError(502, `The AI model server answered ${res.status}${detail ? `: ${detail}` : ''}. Check Settings → AI assistant.`);
      }
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number } };
      const content = stripThinking(data.choices?.[0]?.message?.content ?? '').trim();
      if (!content) throw new HttpError(502, 'The AI model returned an empty answer.');
      return { content, promptTokens: typeof data.usage?.prompt_tokens === 'number' ? data.usage.prompt_tokens : null };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if ((err as Error).name === 'AbortError') throw new HttpError(504, 'The AI model took too long to answer.');
      throw new HttpError(502, unreachable(url, err));
    } finally {
      clearTimeout(timer);
    }
  }

  /** Ollama's own API, which takes the context size per request (it reports no reliable prompt size then). */
  private async callOllama(
    cfg: AiSettings,
    headers: Record<string, string>,
    messages: ChatMessage[],
    json: boolean,
  ): Promise<{ content: string; promptTokens: number | null }> {
    const url = `${serverRoot(cfg.baseUrl)}/api/chat`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutS * 1000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers,
        body: JSON.stringify({
          model: cfg.model,
          messages,
          stream: false,
          ...(json ? { format: 'json' } : {}),
          options: { temperature: 0.2, num_ctx: ollamaContext(messages) },
        }),
      });
      if (!res.ok) {
        const detail = await errorDetail(res);
        throw new HttpError(502, `The AI model server answered ${res.status}${detail ? `: ${detail}` : ''}. Check Settings → AI assistant.`);
      }
      const data = (await res.json()) as { message?: { content?: string } };
      const content = stripThinking(data.message?.content ?? '').trim();
      if (!content) throw new HttpError(502, 'The AI model returned an empty answer.');
      return { content, promptTokens: null };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if ((err as Error).name === 'AbortError') throw new HttpError(504, 'The AI model took too long to answer.');
      throw new HttpError(502, unreachable(url, err));
    } finally {
      clearTimeout(timer);
    }
  }

  /** The assistant chat in Studio: an answer plus actions that change the open automation. */
  async assistant(input: AssistantInput): Promise<AssistantReply & { considered: string[] }> {
    const { system, considered } = assistantPrompt(input);
    // The newest messages; long ones shortened so the step details always fit.
    const history = input.messages.slice(-12).map((m) => ({ role: m.role, content: m.content.slice(0, 6000) }));
    const { content, promptTokens } = await this.call([{ role: 'system', content: system }, ...history], true);
    const sent = Math.round((system.length + history.reduce((n, m) => n + m.content.length, 0)) / 3.6);
    const reply = parseAssistantReply(content, input.flow);
    if (promptTokens !== null && promptTokens < sent * 0.7) reply.warning = contextWarning(promptTokens, sent);
    return { ...reply, considered };
  }

  /**
   * Whether the model server reads a whole assistant request: some cut every prompt to a small
   * context (Ollama: 2,048-4,096 tokens unless told otherwise) and the model then misses most of it.
   */
  async contextCheck(): Promise<{ sent: number; read: number | null; enough: boolean }> {
    const { system } = assistantPrompt({
      messages: [{ role: 'user', content: 'Read the invoices from Excel and type each row into the vendor web portal, then email a summary.' }],
      flow: null,
      processId: null,
    });
    const sent = Math.round(system.length / 3.6); // a rough count of tokens
    const { promptTokens } = await this.call(
      [
        { role: 'system', content: system },
        { role: 'user', content: 'This is a connection test. Reply {"message":"OK","actions":[]}' },
      ],
      true,
    );
    return { sent, read: promptTokens, enough: promptTokens === null || promptTokens >= sent * 0.7 };
  }

  /** Describe a task in plain words -> a draft automation built only from known steps. */
  async draftFlow(description: string): Promise<{ flow: Omit<Flow, 'id'>; dropped: string[] }> {
    const answer = await this.chat(
      [
        { role: 'system', content: DRAFT_RULES + catalogForPrompt() },
        { role: 'user', content: description },
      ],
      true,
    );
    let raw: { name?: unknown; description?: unknown; variables?: unknown; steps?: unknown };
    try {
      raw = JSON.parse(extractJson(answer));
    } catch {
      throw new HttpError(502, 'The AI model did not return a usable draft. Try describing the task again in more detail.');
    }
    const dropped: string[] = [];
    const steps = sanitizeSteps(raw.steps, dropped);
    if (!steps.length) throw new HttpError(422, 'The AI model could not turn this description into steps. Try being more specific.');
    const variables = Array.isArray(raw.variables)
      ? raw.variables
          .filter((v): v is { name: string } => !!v && typeof v === 'object' && /^[A-Za-z_]\w{0,63}$/.test(String((v as { name?: unknown }).name)))
          .filter((v, i, all) => all.findIndex((o) => o.name === v.name) === i)
          .map((v) => {
            const x = v as { name: string; type?: string; is_input?: boolean; description?: string };
            const type = ['text', 'number', 'file', 'table', 'list', 'any', 'date', 'boolean'].includes(String(x.type)) ? x.type : 'any';
            return { name: x.name, type: type as 'any', is_input: !!x.is_input, description: String(x.description ?? '').slice(0, 300) };
          })
      : [];
    return {
      flow: {
        name: String(raw.name ?? 'Drafted automation').slice(0, 120),
        description: `${String(raw.description ?? '').slice(0, 1000)}`.trim(),
        variables,
        steps,
      },
      dropped,
    };
  }

  /** New settings for a failed step (AI self-repair). The engine checks them again before trying. */
  async repairStep(request: RepairRequest): Promise<RepairReply> {
    const def = ACTIVITIES.get(request.activity);
    const changeable = changeableParams(request.activity);
    if (!def || !changeable.size) return { fixable: false, explanation: 'This kind of step is not repaired automatically.' };
    // Only the settings it may change are offered, so the model doesn't propose the others.
    const settings = Object.fromEntries(
      Object.entries(def.params.properties ?? {})
        .filter(([name]) => changeable.has(name))
        .map(([name, p]) => [name, { title: p.title, type: p.type ?? (p.anyOf ? 'any' : undefined), choices: p.enum, help: p.description }]),
    );
    const context = {
      step: { type: def.id, title: def.title, description: def.description, settings },
      current_settings: request.step.params,
      element: request.element ?? null,
      error: request.error,
      attempts: request.attempts ?? [],
      variables: request.variables ?? [],
      screen: request.screen ?? null,
    };
    const answer = await this.chat(
      [
        { role: 'system', content: REPAIR_RULES },
        { role: 'user', content: fitPrompt(context, 24_000) },
      ],
      true,
    );
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(extractJson(answer)) as Record<string, unknown>;
    } catch {
      return { fixable: false, explanation: 'The AI model did not return a usable fix.' };
    }
    return sanitizeRepair(raw, def.id, request.element ? String(request.element.kind ?? 'web') : def.category === 'Desktop' ? 'desktop' : 'web');
  }

  /** Explain a failed step in plain language and suggest a fix. */
  async explainError(input: { activity: string; message: string; hint?: string | null; params?: Record<string, unknown> }): Promise<string> {
    const def = ACTIVITIES.get(input.activity);
    const answer = await this.chat(
      [
        {
          role: 'system',
          content:
            'You help non-technical people fix automations in Autoflow (no-code RPA). Explain in at most 4 short sentences ' +
            'what most likely went wrong and what to change, using the names of settings they see. No code.',
        },
        {
          role: 'user',
          content: `Step: ${def?.title ?? input.activity}\nError: ${input.message}\n${input.hint ? `Hint: ${input.hint}\n` : ''}Settings: ${JSON.stringify(redact(input.params ?? {})).slice(0, 2000)}`,
        },
      ],
      false,
    );
    return answer.trim().slice(0, 2000);
  }

  /** The "Ask the AI assistant" step: classify, pull out fields, summarise, translate or follow instructions. */
  async complete(task: AiTask): Promise<{ result: unknown }> {
    const text = task.text.slice(0, 60_000);
    switch (task.task) {
      case 'classify': {
        const categories = (task.categories ?? []).map((c) => c.trim()).filter(Boolean);
        if (!categories.length) throw new HttpError(400, 'Give the categories to choose from.');
        const answer = await this.chat(
          [
            {
              role: 'system',
              content:
                `Sort the user's text into exactly one of these categories: ${categories.map((c) => JSON.stringify(c)).join(', ')}. ` +
                'Answer with the category only, written exactly as above.',
            },
            { role: 'user', content: text },
          ],
          false,
        );
        return { result: pickCategory(answer, categories) };
      }
      case 'extract': {
        const fields = (task.fields ?? []).map((f) => f.trim()).filter(Boolean);
        if (!fields.length) throw new HttpError(400, 'Give the fields to pull out.');
        const answer = await this.chat(
          [
            {
              role: 'system',
              content:
                `Pull these fields out of the user's text: ${fields.map((f) => JSON.stringify(f)).join(', ')}. ` +
                'Answer with one JSON object that has exactly these keys. Copy each value as it is written in the text ' +
                '(dates and amounts too); use null when the text does not contain it.',
            },
            { role: 'user', content: text },
          ],
          true,
        );
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(extractJson(answer)) as Record<string, unknown>;
        } catch {
          throw new HttpError(502, 'The AI model did not answer with the fields. Try again or simplify the field names.');
        }
        return { result: Object.fromEntries(fields.map((f) => [f, parsed[f] ?? null])) };
      }
      case 'summarize':
      case 'translate':
      case 'answer': {
        const system =
          task.task === 'summarize'
            ? "Summarise the user's text in a few short sentences, in the language of the text."
            : task.task === 'translate'
              ? `Translate the user's text into ${task.language || 'English'}. Answer with the translation only.`
              : `Do what these instructions say with the user's text. Answer with plain text only.\nInstructions: ${task.instructions ?? ''}`;
        const answer = await this.chat(
          [
            { role: 'system', content: system },
            { role: 'user', content: text },
          ],
          false,
        );
        return { result: answer.trim() };
      }
    }
  }
}

/** What the AI step sends (engine/activities/ai.py). */
export const AiTaskBody = z.object({
  task: z.enum(['classify', 'extract', 'summarize', 'translate', 'answer']),
  text: z.string().min(1).max(60_000),
  categories: z.array(z.string().max(200)).max(50).optional(),
  fields: z.array(z.string().max(100)).max(50).optional(),
  language: z.string().max(60).optional(),
  instructions: z.string().max(4000).optional(),
});
export type AiTask = z.infer<typeof AiTaskBody>;

/** The category a model meant, even when it adds quotes, a full stop or a sentence around it. */
export function pickCategory(answer: string, categories: string[]): string {
  const clean = (s: string) => s.trim().replace(/^["'`*\s]+|["'`*.\s]+$/g, '').toLowerCase();
  const said = clean(answer);
  return (
    categories.find((c) => clean(c) === said) ??
    categories
      .filter((c) => said.includes(clean(c)))
      .sort((a, b) => b.length - a.length)[0] ??
    answer.trim()
  );
}

/** Keep only known, non-advanced step types and their known settings; give every step a fresh id. */
const STEP_KEYS = new Set(['id', 'activity', 'type', 'label', 'params', 'settings', 'outputs', 'blocks']);

/** A step type by its id, or by a longer name a model made up from it ("browser.open_url" -> browser.open). */
export function activityNamed(name: string): ActivityDef | undefined {
  const exact = ACTIVITIES.get(name);
  if (exact) return exact;
  const parts = name.split('_');
  for (let n = parts.length - 1; n > 0; n--) {
    const def = ACTIVITIES.get(parts.slice(0, n).join('_'));
    if (def) return def;
  }
  return undefined;
}

/** Steps from a model: known types and settings only, fresh ids (`aliases` maps the model's own ids to them). */
export function sanitizeSteps(value: unknown, dropped: string[], depth = 0, aliases?: Map<string, string>): Step[] {
  if (!Array.isArray(value) || depth > 6) return [];
  const out: Step[] = [];
  for (const raw of value.slice(0, 200)) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as { id?: unknown; activity?: unknown; type?: unknown; label?: unknown; params?: unknown; settings?: unknown; outputs?: unknown; blocks?: unknown };
    const named = String(s.activity ?? s.type ?? '');
    const def = activityNamed(named);
    // Advanced steps (scripts, raw SQL changes) are never offered to the model; a person adds them.
    if (!def || def.advanced) {
      dropped.push(named);
      continue;
    }
    const known = new Set(Object.keys(def.params.properties ?? {}));
    const given = [s.params, s.settings].find((v) => v && typeof v === 'object') as Record<string, unknown> | undefined;
    // Small models often write the settings on the step itself.
    const flat = Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([k]) => !STEP_KEYS.has(k)));
    const params = Object.fromEntries(
      Object.entries({ ...flat, ...given })
        .filter(([k]) => known.has(k))
        // Models often write a condition as text; store the proper shape (a rule set or a formula).
        .map(([k, v]) => [k, isConditionParam(def, k) ? normalizeCondition(v) : v]),
    );
    const outputNames = new Set(def.outputs.map((o) => o.name));
    const outputs = Object.fromEntries(
      Object.entries(s.outputs && typeof s.outputs === 'object' ? (s.outputs as Record<string, unknown>) : {})
        .filter(([k, v]) => outputNames.has(k) && typeof v === 'string' && /^[A-Za-z_]\w{0,63}$/.test(v))
        .map(([k, v]) => [k, v as string]),
    );
    for (const o of def.outputs) outputs[o.name] ??= o.default_variable;
    const step: Step = { id: `s${randomBytes(6).toString('hex')}`, activity: def.id, params };
    if (aliases && typeof s.id === 'string' && s.id.trim()) aliases.set(s.id.trim().slice(0, 64), step.id);
    if (typeof s.label === 'string' && s.label.trim()) step.label = s.label.trim().slice(0, 120);
    if (def.outputs.length) step.outputs = outputs;
    const sections = blocksOf(def, params);
    if (sections.length) {
      const blocks = s.blocks && typeof s.blocks === 'object' ? (s.blocks as Record<string, unknown>) : {};
      step.blocks = Object.fromEntries(sections.map((b) => [b.name, sanitizeSteps(blocks[b.name], dropped, depth + 1, aliases)]));
    }
    out.push(step);
  }
  return out;
}

/** Keep only changes the step can take: known, non-credential settings and well-formed selectors. */
export function sanitizeRepair(raw: Record<string, unknown>, activity: string, kind: string): RepairReply {
  const def = ACTIVITIES.get(activity);
  const explanation = String(raw.explanation ?? '').trim().slice(0, 500);
  if (!def || raw.fixable === false) return { fixable: false, explanation: explanation || 'No fix found.' };
  const props = def.params.properties ?? {};
  const changeable = changeableParams(activity);
  const params = Object.fromEntries(
    Object.entries(raw.params && typeof raw.params === 'object' ? (raw.params as Record<string, unknown>) : {}).filter(
      ([k, v]) => changeable.has(k) && k !== 'element' && JSON.stringify(v ?? null).length <= 2000,
    ),
  );
  const allowed = kind === 'desktop' ? new Set(['uia']) : WEB_STRATEGIES;
  const selectors = ('element' in props && Array.isArray(raw.selectors) ? raw.selectors : [])
    .slice(0, 5)
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object' && allowed.has(String((s as { strategy?: unknown }).strategy)))
    .map((s) => ({
      strategy: String(s.strategy),
      value: String(s.value ?? '').slice(0, 300),
      options: Object.fromEntries(
        Object.entries(s.options && typeof s.options === 'object' ? (s.options as Record<string, unknown>) : {}).filter(
          ([k, v]) => SELECTOR_OPTIONS.has(k) && ['string', 'number', 'boolean'].includes(typeof v) && String(v).length <= 300,
        ),
      ),
    }))
    .filter((s) => s.value.trim() || Object.keys(s.options).length);
  if (!Object.keys(params).length && !selectors.length) return { fixable: false, explanation: explanation || 'No usable change was suggested.' };
  const reply: RepairReply = { fixable: true, explanation: explanation || 'Adjusted the settings of this step.' };
  if (Object.keys(params).length) reply.params = params;
  if (selectors.length) reply.selectors = selectors;
  if (typeof raw.element_name === 'string' && raw.element_name.trim()) reply.element_name = raw.element_name.trim().slice(0, 80);
  return reply;
}

/** JSON for the prompt, shortening the screen lists until it fits the model's context. */
function fitPrompt(context: { screen: unknown } & Record<string, unknown>, maxChars: number): string {
  let text = JSON.stringify(context);
  for (const keep of [100, 60, 30, 10]) {
    if (text.length <= maxChars) break;
    const screen = context.screen as Record<string, unknown> | null;
    if (!screen) break;
    for (const key of ['elements', 'controls']) if (Array.isArray(screen[key])) screen[key] = (screen[key] as unknown[]).slice(0, keep);
    text = JSON.stringify(context);
  }
  return text.slice(0, maxChars);
}

function isConditionParam(def: ActivityDef, name: string): boolean {
  return String(def.params.properties?.[name]?.$ref ?? '').endsWith('/Condition');
}

/** fetch() only says "fetch failed"; turn the network cause into something an admin can act on. */
function unreachable(url: string, err: unknown): string {
  const host = new URL(url).host;
  const code = String((err as { cause?: { code?: unknown } }).cause?.code ?? '');
  if (code === 'ECONNREFUSED') {
    return `Nothing is answering at ${host}. Make sure the AI model server is running there (Ollama: start "Ollama" from the Start menu).`;
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `Can't find the AI model server "${new URL(url).hostname}". Check the address under Settings → AI assistant.`;
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return `The AI model server at ${host} did not respond. Check the network and its firewall.`;
  return `Could not reach the AI model server at ${host}: ${(err as Error).message}`;
}

/** The model server's own reason for refusing a request (e.g. "the request exceeds the available context size"). */
async function errorDetail(res: Response): Promise<string> {
  try {
    const text = await res.text();
    let message = text;
    try {
      const body = JSON.parse(text) as { error?: string | { message?: string }; message?: string };
      message = (typeof body.error === 'string' ? body.error : body.error?.message) ?? body.message ?? '';
    } catch {
      // not JSON: the text itself
    }
    return message.replace(/\s+/g, ' ').trim().slice(0, 200);
  } catch {
    return '';
  }
}

/** Models sometimes wrap JSON in ```json fences or add a sentence; take the JSON object. */
export function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  return start >= 0 && end > start ? body.slice(start, end + 1) : body;
}

function redact(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(params).map(([k, v]) => [k, /password|secret|token/i.test(k) ? '••••' : v]));
}
