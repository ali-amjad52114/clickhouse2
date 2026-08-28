/**
 * Anthropic Messages API client.
 *
 * Deliberately fetch-based: the project has no Anthropic SDK dependency and
 * package.json is frozen, so this speaks the raw HTTP protocol documented at
 * https://docs.anthropic.com/en/api/messages.
 *
 * Honesty rules baked in:
 *  - With no ANTHROPIC_API_KEY, `isConfigured()` is false and `complete()`
 *    throws LlmNotConfiguredError. There is no offline/mock/canned path.
 *  - Every failure (HTTP error, refusal, truncation) becomes a typed error
 *    carrying the real upstream detail, so callers can surface it verbatim.
 */

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-5';
const DEFAULT_MAX_TOKENS = 32000;
const DEFAULT_TIMEOUT_MS = 240_000;

export interface LlmStatus {
  configured: boolean;
  provider: 'anthropic';
  model: string;
  endpoint: string;
  detail: string;
}

export function llmModel(): string {
  return process.env.LLM_MODEL?.trim() || DEFAULT_MODEL;
}

export function isConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

export function llmStatus(): LlmStatus {
  const configured = isConfigured();
  const model = llmModel();
  return {
    configured,
    provider: 'anthropic',
    model,
    endpoint: ENDPOINT,
    detail: configured
      ? `ANTHROPIC_API_KEY present - live calls to ${ENDPOINT} as ${model}`
      : 'ANTHROPIC_API_KEY is not set - the server cannot call any model, so generation is disabled',
  };
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export class LlmNotConfiguredError extends Error {
  constructor(message = llmStatus().detail) {
    super(message);
    this.name = 'LlmNotConfiguredError';
  }
}

/** An upstream failure. `status` is the HTTP status we should answer with. */
export class LlmRequestError extends Error {
  status: number;
  upstreamStatus: number | null;
  detail: string;

  constructor(message: string, status: number, upstreamStatus: number | null, detail: string) {
    super(message);
    this.name = 'LlmRequestError';
    this.status = status;
    this.upstreamStatus = upstreamStatus;
    this.detail = detail;
  }
}

/* ------------------------------------------------------------------ */
/* Completion                                                          */
/* ------------------------------------------------------------------ */

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CompleteRequest {
  /** Stable across calls so prompt caching actually hits. */
  system: string;
  messages: LlmMessage[];
  maxTokens?: number;
  timeoutMs?: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface CompleteResult {
  text: string;
  stopReason: string | null;
  model: string;
  usage: LlmUsage;
  ms: number;
}

interface StreamEvent {
  type?: string;
  message?: { model?: string; usage?: Record<string, number> };
  delta?: { type?: string; text?: string; stop_reason?: string | null };
  content_block?: { type?: string };
  usage?: Record<string, number>;
  error?: { type?: string; message?: string };
}

/**
 * One streaming Messages request, accumulated into a single string.
 *
 * Streaming (rather than a plain JSON response) is not cosmetic: a full story
 * is several thousand output tokens and a non-streamed request of that size
 * routinely trips HTTP idle timeouts.
 *
 * `thinking` is deliberately not sent. On Claude Sonnet 5 / Opus 5 omitting it
 * runs adaptive thinking; on older models it means no thinking. Either way the
 * request stays valid, and thinking deltas are dropped here because only text
 * blocks carry the JSON we want.
 */
export async function complete(req: CompleteRequest): Promise<CompleteResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new LlmNotConfiguredError();

  const model = llmModel();
  const started = Date.now();

  const body = {
    model,
    max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: true,
    // Array form + cache_control so repair attempts reuse the cached prefix.
    system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
  };

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(req.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new LlmRequestError(`could not reach ${ENDPOINT}`, 502, null, detail);
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    throw new LlmRequestError(
      `Anthropic API returned ${res.status}`,
      502,
      res.status,
      extractApiErrorMessage(raw) || raw.slice(0, 500) || res.statusText,
    );
  }
  if (!res.body) {
    throw new LlmRequestError('Anthropic API returned an empty body', 502, res.status, 'no response stream');
  }

  const usage: LlmUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  let text = '';
  let stopReason: string | null = null;
  let responseModel = model;
  /** Only text blocks matter; thinking blocks stream separately. */
  let inTextBlock = false;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const handleLine = (line: string) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;

    let evt: StreamEvent;
    try {
      evt = JSON.parse(payload) as StreamEvent;
    } catch {
      return;
    }

    switch (evt.type) {
      case 'message_start':
        if (evt.message?.model) responseModel = evt.message.model;
        applyUsage(usage, evt.message?.usage);
        break;
      case 'content_block_start':
        inTextBlock = evt.content_block?.type === 'text';
        break;
      case 'content_block_delta':
        if (inTextBlock && evt.delta?.type === 'text_delta' && evt.delta.text) {
          text += evt.delta.text;
        }
        break;
      case 'content_block_stop':
        inTextBlock = false;
        break;
      case 'message_delta':
        if (evt.delta?.stop_reason !== undefined) stopReason = evt.delta.stop_reason ?? null;
        applyUsage(usage, evt.usage);
        break;
      case 'error':
        throw new LlmRequestError(
          'Anthropic API streamed an error',
          502,
          null,
          evt.error?.message || evt.error?.type || 'unknown stream error',
        );
      default:
        break;
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        handleLine(buffer.slice(0, nl).replace(/\r$/, ''));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
      }
    }
    if (buffer.trim()) handleLine(buffer.trim());
  } catch (err) {
    if (err instanceof LlmRequestError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new LlmRequestError('the model response stream failed', 502, null, detail);
  }

  if (stopReason === 'refusal') {
    throw new LlmRequestError(
      'the model declined to answer this request',
      422,
      null,
      'stop_reason was "refusal" - the pasted text may not be suitable for a children\'s adventure',
    );
  }
  if (stopReason === 'max_tokens') {
    throw new LlmRequestError(
      'the model ran out of output tokens before finishing the story',
      502,
      null,
      `stop_reason was "max_tokens" after ${usage.outputTokens} output tokens - try shorter source text`,
    );
  }
  if (!text.trim()) {
    throw new LlmRequestError(
      'the model returned no text',
      502,
      null,
      `stop_reason was "${stopReason ?? 'unknown'}"`,
    );
  }

  return { text, stopReason, model: responseModel, usage, ms: Date.now() - started };
}

function applyUsage(target: LlmUsage, raw: Record<string, number> | undefined): void {
  if (!raw) return;
  if (typeof raw.input_tokens === 'number') target.inputTokens += raw.input_tokens;
  if (typeof raw.output_tokens === 'number') target.outputTokens = raw.output_tokens;
  if (typeof raw.cache_read_input_tokens === 'number') {
    target.cacheReadInputTokens += raw.cache_read_input_tokens;
  }
  if (typeof raw.cache_creation_input_tokens === 'number') {
    target.cacheCreationInputTokens += raw.cache_creation_input_tokens;
  }
}

function extractApiErrorMessage(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string; type?: string } };
    return parsed.error?.message || parsed.error?.type || '';
  } catch {
    return '';
  }
}
