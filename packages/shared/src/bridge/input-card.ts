export interface InputOption {
  label: string;
  value: string;
  description?: string;
}

export interface InputQuestion {
  id: string;
  text: string;
  header?: string;
  options?: InputOption[];
  multiple?: boolean;
}

export interface InputRequiredEvent {
  type: 'input_required';
  requestId?: string;
  agent: string;
  risk: 'medium';
  summary: string;
  questions: InputQuestion[];
}

interface InputRequestLike {
  id?: unknown;
  params?: unknown;
  [key: string]: unknown;
}

export function formatInputRequiredEvent(req: InputRequestLike, agent: string): InputRequiredEvent {
  const params = asRecord(req.params);
  const questions = extractQuestions(params);
  const summary = firstString(
    params.summary,
    params.title,
    params.prompt,
    params.question,
    params.text,
    questions[0]?.text,
    'Agent input required',
  );

  return {
    type: 'input_required',
    requestId: req.id === undefined ? undefined : String(req.id),
    agent,
    risk: 'medium',
    summary,
    questions: questions.length > 0 ? questions : [{ id: 'input', text: summary }],
  };
}

export function tryFormatInputRequiredEvent(value: unknown, agent: string): InputRequiredEvent | null {
  const params = asRecord(value);
  if (Object.keys(params).length === 0) return null;
  const questions = extractQuestions(params);
  if (questions.length === 0) return null;
  return formatInputRequiredEvent({ id: params.id ?? params.requestId, params }, agent);
}

export function parseInputReply(message: string, questions: Pick<InputQuestion, 'id'>[]): Record<string, string[]> {
  const text = message.trim();
  if (!text) return {};
  if (questions.length === 0) return { input: [text] };

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, string[]> = {};
      for (const q of questions) {
        const value = (parsed as Record<string, unknown>)[q.id];
        if (Array.isArray(value)) out[q.id] = value.map(String);
        else if (value !== undefined && value !== null) out[q.id] = [String(value)];
      }
      if (Object.keys(out).length > 0) return out;
    }
  } catch {
    // Plain text is the common mobile reply path.
  }

  return { [questions[0].id]: [text] };
}

function extractQuestions(params: Record<string, unknown>): InputQuestion[] {
  const rawQuestions = firstArray(params.questions, params.items);
  if (rawQuestions.length > 0) {
    return rawQuestions.map((q, idx) => normalizeQuestion(q, idx)).filter((q): q is InputQuestion => !!q);
  }

  const options = normalizeOptions(firstArray(params.options, params.choices, params.agents));
  if (options.length > 0) {
    return [{
      id: firstString(params.id, params.name, 'selection'),
      text: firstString(params.question, params.prompt, params.title, 'Choose an option'),
      options,
    }];
  }

  return [];
}

function normalizeQuestion(raw: unknown, idx: number): InputQuestion | null {
  const q = asRecord(raw);
  if (Object.keys(q).length === 0 && typeof raw !== 'string') return null;
  if (typeof raw === 'string') return { id: `q${idx + 1}`, text: raw };

  const text = firstString(q.text, q.question, q.prompt, q.label, q.header, `Question ${idx + 1}`);
  const options = normalizeOptions(firstArray(q.options, q.choices, q.agents));
  return {
    id: firstString(q.id, q.name, `q${idx + 1}`),
    text,
    ...(typeof q.header === 'string' ? { header: q.header } : {}),
    ...(options.length > 0 ? { options } : {}),
    ...(typeof q.multiple === 'boolean' ? { multiple: q.multiple } : {}),
  };
}

function normalizeOptions(raw: unknown[]): InputOption[] {
  return raw.map((option) => {
    if (typeof option === 'string') return { label: option, value: option };
    const o = asRecord(option);
    const label = firstString(o.label, o.name, o.title, o.value, '');
    if (!label) return null;
    const normalized: InputOption = {
      label,
      value: firstString(o.value, o.id, o.key, label),
    };
    const description = firstString(o.description, o.detail, o.subtitle, '');
    if (description) normalized.description = description;
    return normalized;
  }).filter((o): o is InputOption => !!o);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function firstArray(...values: unknown[]): unknown[] {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }
  return '';
}
