// Unit tests for the unified LLM layer (llm/). No network: global fetch is
// stubbed and routed by URL to fake OpenAI-compatible / Gemini endpoints.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { generate, defineTask, registerFallback, getLLMStatus } from '../llm/index.js';
import { resolveChain, limitsFor } from '../llm/config.js';
import { resetLimiters } from '../llm/rateLimiter.js';
import { resetStatus } from '../llm/status.js';
import { toStrictJsonSchema, toGeminiSchema, zodToJsonSchema } from '../llm/schema.js';
import { parseRetryAfter } from '../llm/errors.js';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const ENV_KEYS = [
  'LLM_PROVIDER', 'LLM_MODEL', 'LLM_FALLBACKS', 'LLM_API_KEY', 'LLM_BASE_URL',
  'GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_BASE_URL', 'GEMINI_THINKING_BUDGET',
  'LLM_TIMEOUT_MS', 'LLM_MAX_RETRIES', 'LLM_MAX_RETRY_WAIT_MS', 'LLM_QUEUE_TIMEOUT_MS',
  'LLM_BACKOFF_BASE_MS', 'LLM_RPM_OPENAI', 'LLM_TPM_OPENAI', 'LLM_RPM_GEMINI', 'LLM_TPM_GEMINI',
];

// ─── Fake HTTP responses ─────────────────────────────────────────────────────
const headers = (h = {}) => ({ get: (k) => h[k.toLowerCase()] ?? null });
const openaiOk = (obj, usage = { prompt_tokens: 50, completion_tokens: 20 }) => ({
  ok: true, status: 200, headers: headers(),
  json: async () => ({ choices: [{ message: { content: typeof obj === 'string' ? obj : JSON.stringify(obj) } }], usage }),
});
const geminiOk = (obj) => ({
  ok: true, status: 200, headers: headers(),
  json: async () => ({
    candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 10 },
  }),
});
const httpErr = (status, h = {}, body = { error: { message: 'nope' } }) => ({
  ok: false, status, headers: headers(h), json: async () => body,
});

const isGemini = (url) => String(url).includes('generativelanguage');

/** Route fetch calls: openai → queue `oa`, gemini → queue `gm` (last item repeats). */
function routeFetch({ oa = [], gm = [] }) {
  const take = (q) => (q.length > 1 ? q.shift() : q[0]);
  fetchMock.mockImplementation(async (url) => {
    const next = take(isGemini(url) ? gm : oa);
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next();
    if (!next) throw new Error(`unexpected fetch to ${url}`);
    return next;
  });
}
const calls = (pred) => fetchMock.mock.calls.filter(([url]) => pred(url));

// ─── A test task ─────────────────────────────────────────────────────────────
const Answer = z.object({ hour: z.int().min(0).max(23), label: z.enum(['low', 'high']) });
let fallbackImpl = (ctx) => ({ hour: ctx.hour ?? 9, label: 'low' });
const TASK = defineTask({
  name: 'test_answer',
  schema: Answer,
  fallback: (ctx) => fallbackImpl(ctx),
  safeDefault: { hour: 9, label: 'low' },
});
const MSGS = [
  { role: 'system', content: 'You answer in JSON.' },
  { role: 'user', content: 'What hour?' },
];
const VALID = { hour: 14, label: 'high' };

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  // Fast, deterministic retry timing for tests.
  process.env.LLM_BACKOFF_BASE_MS = '1';
  fetchMock.mockReset();
  resetLimiters();
  resetStatus();
  fallbackImpl = (ctx) => ({ hour: ctx.hour ?? 9, label: 'low' });
});

afterEach(() => {
  vi.useRealTimers();
});

const withBoth = () => { process.env.LLM_API_KEY = 'pat'; process.env.GEMINI_API_KEY = 'gk'; };

// ─── Config ──────────────────────────────────────────────────────────────────
describe('resolveChain', () => {
  it('is empty with no credentials', () => {
    expect(resolveChain()).toEqual([]);
  });

  it('defaults to openai primary + gemini fallback when both keys exist (legacy env)', () => {
    withBoth();
    process.env.GEMINI_MODEL = 'gemini-x';
    expect(resolveChain()).toEqual([
      { provider: 'openai', model: 'openai/gpt-4.1-mini' },
      { provider: 'gemini', model: 'gemini-x' },
    ]);
  });

  it('honors LLM_PROVIDER/LLM_MODEL and an explicit LLM_FALLBACKS list', () => {
    process.env.LLM_PROVIDER = 'gemini';
    process.env.LLM_MODEL = 'gemini-pro-y';
    process.env.LLM_FALLBACKS = 'openai:some/model, gemini';
    expect(resolveChain()).toEqual([
      { provider: 'gemini', model: 'gemini-pro-y' },
      { provider: 'openai', model: 'some/model' },
      { provider: 'gemini', model: 'gemini-2.5-flash' },
    ]);
  });

  it('LLM_FALLBACKS=none disables LLM fallbacks', () => {
    withBoth();
    process.env.LLM_FALLBACKS = 'none';
    expect(resolveChain()).toEqual([{ provider: 'openai', model: 'openai/gpt-4.1-mini' }]);
  });

  it('reads per-provider rate limits from env', () => {
    process.env.LLM_RPM_OPENAI = '3';
    process.env.LLM_TPM_OPENAI = '900';
    expect(limitsFor('openai')).toEqual({ rpm: 3, tpm: 900 });
    expect(limitsFor('gemini')).toEqual({ rpm: 10, tpm: 250_000 });
  });
});

// ─── Success path ────────────────────────────────────────────────────────────
describe('generate — success', () => {
  it('returns validated data with llm metadata from the primary', async () => {
    withBoth();
    routeFetch({ oa: [openaiOk(VALID)] });

    const { data, meta } = await generate(MSGS, TASK);
    expect(data).toEqual(VALID);
    expect(meta).toMatchObject({
      source: 'llm', provider: 'openai', model: 'openai/gpt-4.1-mini', task: 'test_answer',
      attempts: 1, fallbackUsed: false, degraded: false,
      usage: { inputTokens: 50, outputTokens: 20 },
    });
    expect(calls(isGemini)).toHaveLength(0);

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://models.github.ai/inference/chat/completions');
    expect(opts.headers.Authorization).toBe('Bearer pat');
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(opts.body);
    expect(body.messages).toEqual(MSGS);
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema).toMatchObject({ name: 'test_answer', strict: true });
    // Structural schema only: bounds are enforced by zod, not sent upstream.
    expect(body.response_format.json_schema.schema.properties.hour).toEqual({ type: 'integer' });
  });

  it('strips markdown fences before parsing', async () => {
    process.env.LLM_API_KEY = 'pat';
    routeFetch({ oa: [openaiOk('```json\n{"hour":3,"label":"low"}\n```')] });
    const { data } = await generate(MSGS, TASK);
    expect(data).toEqual({ hour: 3, label: 'low' });
  });

  it('maps messages to Gemini systemInstruction/contents when Gemini is primary', async () => {
    process.env.GEMINI_API_KEY = 'gk';
    routeFetch({ gm: [geminiOk(VALID)] });

    const { meta } = await generate(
      [...MSGS, { role: 'assistant', content: 'prev' }, { role: 'user', content: 'again' }], TASK);
    expect(meta).toMatchObject({ source: 'llm', provider: 'gemini', model: 'gemini-2.5-flash' });

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('/models/gemini-2.5-flash:generateContent');
    expect(opts.headers['x-goog-api-key']).toBe('gk');
    const body = JSON.parse(opts.body);
    expect(body.systemInstruction.parts[0].text).toBe('You answer in JSON.');
    expect(body.contents.map(c => c.role)).toEqual(['user', 'model', 'user']);
    expect(body.generationConfig.responseSchema.type).toBe('OBJECT');
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });
});

// ─── Invalid schema → corrective retry ───────────────────────────────────────
describe('generate — schema validation', () => {
  it('retries once with the validation error fed back, then succeeds', async () => {
    process.env.LLM_API_KEY = 'pat';
    routeFetch({ oa: [openaiOk({ hour: 30, label: 'high' }), openaiOk(VALID)] });

    const { data, meta } = await generate(MSGS, TASK);
    expect(data).toEqual(VALID);
    expect(meta).toMatchObject({ source: 'llm', attempts: 2 });

    const retryBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(retryBody.messages).toHaveLength(4);
    expect(retryBody.messages[2]).toEqual({ role: 'assistant', content: JSON.stringify({ hour: 30, label: 'high' }) });
    expect(retryBody.messages[3].role).toBe('user');
    expect(retryBody.messages[3].content).toMatch(/failed validation/);
    expect(retryBody.messages[3].content).toMatch(/hour/);
  });

  it('after two invalid replies moves to the next provider', async () => {
    withBoth();
    routeFetch({ oa: [openaiOk('not json'), openaiOk({ hour: -1 })], gm: [geminiOk(VALID)] });

    const { data, meta } = await generate(MSGS, TASK);
    expect(data).toEqual(VALID);
    expect(meta).toMatchObject({ source: 'llm', provider: 'gemini', fallbackUsed: true, attempts: 3 });
    expect(meta.reason).toBe('invalid_output:openai');
    expect(calls((u) => !isGemini(u))).toHaveLength(2);
  });

  it('falls through to the rule-based backup when every provider returns junk', async () => {
    withBoth();
    routeFetch({ oa: [openaiOk('nope')], gm: [geminiOk({ wrong: true })] });

    const { data, meta } = await generate(MSGS, TASK, { context: { hour: 7 } });
    expect(data).toEqual({ hour: 7, label: 'low' });
    expect(meta).toMatchObject({ source: 'fallback', provider: null, model: null, degraded: false, attempts: 4 });
  });
});

// ─── Provider failures → fallback chain ──────────────────────────────────────
describe('generate — provider failure', () => {
  it('retries transient 5xx, then falls back to the secondary provider', async () => {
    withBoth();
    process.env.LLM_MAX_RETRIES = '2';
    routeFetch({ oa: [httpErr(503)], gm: [geminiOk(VALID)] });

    const { meta } = await generate(MSGS, TASK);
    expect(calls((u) => !isGemini(u))).toHaveLength(3);   // 1 + 2 retries
    expect(meta).toMatchObject({ source: 'llm', provider: 'gemini', fallbackUsed: true, reason: '503:openai' });
  });

  it('does not retry non-transient 4xx errors', async () => {
    withBoth();
    routeFetch({ oa: [httpErr(401)], gm: [geminiOk(VALID)] });

    await generate(MSGS, TASK);
    expect(calls((u) => !isGemini(u))).toHaveLength(1);
  });

  it('treats network errors as transient', async () => {
    withBoth();
    process.env.LLM_MAX_RETRIES = '1';
    routeFetch({ oa: [new TypeError('fetch failed')], gm: [geminiOk(VALID)] });

    const { meta } = await generate(MSGS, TASK);
    expect(calls((u) => !isGemini(u))).toHaveLength(2);
    expect(meta.reason).toBe('NETWORK:openai');
  });

  it('aborts a hung request at LLM_TIMEOUT_MS', async () => {
    withBoth();
    process.env.LLM_TIMEOUT_MS = '30';
    process.env.LLM_MAX_RETRIES = '0';
    fetchMock.mockImplementation((url, opts) => {
      if (isGemini(url)) return Promise.resolve(geminiOk(VALID));
      return new Promise((_, reject) => {
        opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    });

    const { meta } = await generate(MSGS, TASK);
    expect(meta).toMatchObject({ provider: 'gemini', reason: 'TIMEOUT:openai' });
  });

  it('skips a provider in the chain whose key is missing', async () => {
    process.env.GEMINI_API_KEY = 'gk';
    process.env.LLM_PROVIDER = 'openai';            // primary named, but no LLM_API_KEY
    process.env.LLM_FALLBACKS = 'gemini';
    routeFetch({ gm: [geminiOk(VALID)] });

    const { meta } = await generate(MSGS, TASK);
    expect(meta).toMatchObject({ provider: 'gemini', reason: 'unconfigured:openai' });
    expect(calls((u) => !isGemini(u))).toHaveLength(0);
  });
});

// ─── Rate limiting ───────────────────────────────────────────────────────────
describe('generate — rate limiting', () => {
  it('respects Retry-After on 429 before retrying the same provider', async () => {
    process.env.LLM_API_KEY = 'pat';
    process.env.LLM_MAX_RETRIES = '1';
    vi.useFakeTimers();
    routeFetch({ oa: [httpErr(429, { 'retry-after': '2' }), openaiOk(VALID)] });

    const p = generate(MSGS, TASK);
    await vi.advanceTimersByTimeAsync(1_900);
    expect(fetchMock).toHaveBeenCalledTimes(1);     // still waiting out Retry-After
    await vi.advanceTimersByTimeAsync(300);
    const { meta } = await p;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(meta).toMatchObject({ source: 'llm', provider: 'openai', attempts: 2 });
  });

  it('moves down the chain when Retry-After exceeds LLM_MAX_RETRY_WAIT_MS', async () => {
    withBoth();
    process.env.LLM_MAX_RETRY_WAIT_MS = '1000';
    routeFetch({ oa: [httpErr(429, { 'retry-after': '60' })], gm: [geminiOk(VALID)] });

    const { meta } = await generate(MSGS, TASK);
    expect(calls((u) => !isGemini(u))).toHaveLength(1);
    expect(meta).toMatchObject({ provider: 'gemini', reason: '429:openai' });
  });

  it('reads Gemini RetryInfo from the error body', async () => {
    process.env.GEMINI_API_KEY = 'gk';
    process.env.LLM_MAX_RETRY_WAIT_MS = '500';
    routeFetch({ gm: [httpErr(429, {}, { error: { message: 'quota', details: [{ retryDelay: '13s' }] } })] });

    const { meta } = await generate(MSGS, TASK);
    // 13s > 500ms cap → no retry, straight to the rule-based backup.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(meta).toMatchObject({ source: 'fallback', reason: '429:gemini' });
  });

  it('enforces the local requests/min limit and skips to the next provider', async () => {
    withBoth();
    process.env.LLM_RPM_OPENAI = '1';
    process.env.LLM_QUEUE_TIMEOUT_MS = '0';
    routeFetch({ oa: [openaiOk(VALID)], gm: [geminiOk({ hour: 1, label: 'low' })] });

    const first = await generate(MSGS, TASK);
    const second = await generate(MSGS, TASK);
    expect(first.meta.provider).toBe('openai');
    expect(second.meta).toMatchObject({ provider: 'gemini', reason: 'RATE_LIMITED_LOCAL:openai' });
    expect(calls((u) => !isGemini(u))).toHaveLength(1);
  });

  it('queues for a free slot when the wait fits the queue timeout', async () => {
    process.env.LLM_API_KEY = 'pat';
    process.env.LLM_RPM_OPENAI = '1';
    process.env.LLM_QUEUE_TIMEOUT_MS = '120000';
    vi.useFakeTimers();
    routeFetch({ oa: [openaiOk(VALID)] });

    await generate(MSGS, TASK);
    const p = generate(MSGS, TASK);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);      // queued behind the 1-rpm window
    await vi.advanceTimersByTimeAsync(31_000);
    const { meta } = await p;
    expect(meta.provider).toBe('openai');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('enforces tokens/min using the estimate, then actual usage', async () => {
    process.env.LLM_API_KEY = 'pat';
    process.env.LLM_TPM_OPENAI = '1500';             // fits one request (est ≈ 1024 + prompt)
    process.env.LLM_QUEUE_TIMEOUT_MS = '0';
    routeFetch({ oa: [openaiOk(VALID, { prompt_tokens: 1200, completion_tokens: 100 })] });

    await generate(MSGS, TASK);
    const { meta } = await generate(MSGS, TASK);
    expect(meta).toMatchObject({ source: 'fallback', reason: 'RATE_LIMITED_LOCAL:openai' });
  });
});

// ─── Rule-based backup ───────────────────────────────────────────────────────
describe('generate — rule-based backup', () => {
  it('serves the fallback (no network) when nothing is configured', async () => {
    const { data, meta } = await generate(MSGS, TASK, { context: { hour: 22 } });
    expect(data).toEqual({ hour: 22, label: 'low' });
    expect(meta).toMatchObject({ source: 'fallback', reason: 'unconfigured', attempts: 0, degraded: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the safe default when the fallback throws', async () => {
    fallbackImpl = () => { throw new Error('boom'); };
    const { data, meta } = await generate(MSGS, TASK);
    expect(data).toEqual({ hour: 9, label: 'low' });
    expect(meta).toMatchObject({ source: 'fallback', degraded: true });
  });

  it('returns the safe default when the fallback output fails the schema', async () => {
    fallbackImpl = () => ({ hour: 99 });
    const { data, meta } = await generate(MSGS, TASK);
    expect(data).toEqual({ hour: 9, label: 'low' });
    expect(meta.degraded).toBe(true);
  });

  it('registerFallback swaps the handler for a task by name', async () => {
    registerFallback('test_answer', () => ({ hour: 5, label: 'high' }));
    const { data } = await generate(MSGS, TASK);
    expect(data).toEqual({ hour: 5, label: 'high' });
    registerFallback('test_answer', (ctx) => fallbackImpl(ctx));   // restore
  });

  it('never rejects for provider errors (all providers down)', async () => {
    withBoth();
    process.env.LLM_MAX_RETRIES = '0';
    routeFetch({ oa: [new TypeError('down')], gm: [httpErr(500)] });
    await expect(generate(MSGS, TASK)).resolves.toMatchObject({ meta: { source: 'fallback' } });
  });
});

// ─── Guards, schema conversion, status ───────────────────────────────────────
describe('task definition + input guards', () => {
  it('rejects a safeDefault that fails its own schema', () => {
    expect(() => defineTask({ name: 'bad', schema: Answer, safeDefault: { hour: 'x' } })).toThrow(/safeDefault/);
  });

  it('rejects malformed messages and unregistered tasks', async () => {
    await expect(generate('hi', TASK)).rejects.toThrow(TypeError);
    await expect(generate(MSGS, { name: 'x', schema: Answer })).rejects.toThrow(TypeError);
  });
});

describe('schema conversion', () => {
  const json = zodToJsonSchema(z.object({
    n: z.int().min(0).max(5),
    list: z.array(z.object({ s: z.string().max(3) })).max(2),
    e: z.enum(['a', 'b']),
  }));

  it('strict schema: closed objects, all props required, no bounds', () => {
    const s = toStrictJsonSchema(json);
    expect(s).toEqual({
      type: 'object', additionalProperties: false, required: ['n', 'list', 'e'],
      properties: {
        n: { type: 'integer' },
        list: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['s'], properties: { s: { type: 'string' } } } },
        e: { type: 'string', enum: ['a', 'b'] },
      },
    });
  });

  it('gemini schema: upper-case types, no additionalProperties', () => {
    const s = toGeminiSchema(json);
    expect(s.type).toBe('OBJECT');
    expect(s.additionalProperties).toBeUndefined();
    expect(s.properties.list.items.properties.s).toEqual({ type: 'STRING' });
    expect(s.properties.e).toEqual({ type: 'STRING', enum: ['a', 'b'] });
  });

  it('parseRetryAfter handles seconds, HTTP dates and junk', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter('soon')).toBe(null);
    expect(parseRetryAfter(null)).toBe(null);
  });
});

describe('getLLMStatus', () => {
  it('reports unconfigured with no chain', () => {
    expect(getLLMStatus().primary).toBe('unconfigured');
  });

  it('flips to failing after a fallback and recovers after a primary success', async () => {
    withBoth();
    process.env.LLM_MAX_RETRIES = '0';
    routeFetch({ oa: [httpErr(500), openaiOk(VALID)], gm: [geminiOk(VALID)] });

    await generate(MSGS, TASK);
    let status = getLLMStatus();
    expect(status).toMatchObject({ primary: 'failing', fallbackCount: 1, ruleBasedCount: 0, lastFallbackReason: '500:openai' });
    expect(status.chain).toEqual(['openai:openai/gpt-4.1-mini', 'gemini:gemini-2.5-flash']);

    await generate(MSGS, TASK);
    status = getLLMStatus();
    expect(status.primary).toBe('ok');
    expect(status.fallbackCount).toBe(1);
    expect(status.lastPrimarySuccessAt).toBeInstanceOf(Date);
  });
});
