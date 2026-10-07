// Optional AI assistant backed by a self-hosted, OpenAI-compatible model server
// (Ollama, LM Studio, vLLM...). Nothing leaves the company network; it is off until
// an administrator configures it. Model output is never trusted: drafts are checked
// against the activity catalog and reviewed by a person before anything runs.
import type { Catalog, Flow, Step } from '@autoflow/flow-types';
import catalogJson from '@autoflow/flow-types/activity-catalog.json';
import { randomBytes } from 'node:crypto';
import { HttpError, type Settings } from './core.js';

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
const ACTIVITIES = new Map(catalog.activities.map((a) => [a.id, a]));

/** A compact description of every step type for the model (id, purpose, settings). */
function catalogForPrompt(): string {
  return catalog.activities
    .filter((a) => !a.advanced)
    .map((a) => {
      const params = Object.keys(a.params.properties ?? {}).filter((p) => !a.params.properties[p]?.['x-advanced']);
      const blocks = a.blocks.length ? ` blocks: ${a.blocks.map((b) => b.name).join('/')}` : '';
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
- Leave settings you cannot know (web addresses, screen elements, file paths) as "" - the user fills them in.
- Never put passwords in steps; use control.get_credential.
Available steps:
`;

export class AiService {
  constructor(
    private readonly settings: Settings,
    private readonly decrypt: (sealed: string) => string,
  ) {}

  config(): AiSettings {
    return this.settings.get<AiSettings>('ai', DEFAULT_AI);
  }

  private async chat(messages: { role: 'system' | 'user'; content: string }[], json: boolean): Promise<string> {
    const cfg = this.config();
    if (!cfg.enabled) throw new HttpError(404, 'The AI assistant is not set up. An administrator can enable it under Settings.');
    const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutS * 1000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.apiKey ? { Authorization: `Bearer ${this.decrypt(cfg.apiKey)}` } : {}),
        },
        body: JSON.stringify({
          model: cfg.model,
          messages,
          temperature: 0.2,
          ...(json ? { response_format: { type: 'json_object' } } : {}),
        }),
      });
      if (!res.ok) throw new HttpError(502, `The AI model server answered ${res.status}. Check Settings → AI assistant.`);
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new HttpError(502, 'The AI model returned an empty answer.');
      return content;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if ((err as Error).name === 'AbortError') throw new HttpError(504, 'The AI model took too long to answer.');
      throw new HttpError(502, `Could not reach the AI model server: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
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
}

/** Keep only known, non-advanced step types and their known settings; give every step a fresh id. */
export function sanitizeSteps(value: unknown, dropped: string[], depth = 0): Step[] {
  if (!Array.isArray(value) || depth > 6) return [];
  const out: Step[] = [];
  for (const raw of value.slice(0, 200)) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as { activity?: unknown; label?: unknown; params?: unknown; outputs?: unknown; blocks?: unknown };
    const def = ACTIVITIES.get(String(s.activity));
    // Advanced steps (scripts, raw SQL changes) are never offered to the model; a person adds them.
    if (!def || def.advanced) {
      dropped.push(String(s.activity));
      continue;
    }
    const known = new Set(Object.keys(def.params.properties ?? {}));
    const params = Object.fromEntries(
      Object.entries(s.params && typeof s.params === 'object' ? (s.params as Record<string, unknown>) : {}).filter(([k]) => known.has(k)),
    );
    const outputNames = new Set(def.outputs.map((o) => o.name));
    const outputs = Object.fromEntries(
      Object.entries(s.outputs && typeof s.outputs === 'object' ? (s.outputs as Record<string, unknown>) : {})
        .filter(([k, v]) => outputNames.has(k) && typeof v === 'string' && /^[A-Za-z_]\w{0,63}$/.test(v))
        .map(([k, v]) => [k, v as string]),
    );
    for (const o of def.outputs) outputs[o.name] ??= o.default_variable;
    const step: Step = { id: `s${randomBytes(6).toString('hex')}`, activity: def.id, params };
    if (typeof s.label === 'string' && s.label.trim()) step.label = s.label.trim().slice(0, 120);
    if (def.outputs.length) step.outputs = outputs;
    if (def.blocks.length) {
      const blocks = s.blocks && typeof s.blocks === 'object' ? (s.blocks as Record<string, unknown>) : {};
      step.blocks = Object.fromEntries(def.blocks.map((b) => [b.name, sanitizeSteps(blocks[b.name], dropped, depth + 1)]));
    }
    out.push(step);
  }
  return out;
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
