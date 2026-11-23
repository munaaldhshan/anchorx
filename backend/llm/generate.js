// The ONLY way the app calls an LLM.
//
//   const { data, meta } = await generate(messages, task, { context });
//
//   messages  [{ role: 'system'|'user'|'assistant', content: string }]
//   task      a defineTask() result: { name, schema (zod), fallback, safeDefault }
//   context   plain data handed to the task's rule-based fallback
//   check     optional (data) => string|null run after zod succeeds. A string
//             is treated exactly like a validation error (corrective retry,
//             then next link, then rule-based fallback). Use it for per-call
//             rules a static schema can't express (e.g. "every number must
//             appear in the tool results").
//
// Flow: for each { provider, model } in the configured chain → local rate
// limit slot → request with timeout → transient-error retries (backoff +
// jitter, Retry-After respected) → JSON parse + zod validation → on invalid
// output ONE corrective retry with the validation error fed back → next link.
// When every link fails, the task's deterministic rule-based fallback runs; if
// even that misbehaves, its safeDefault is returned. generate() never rejects
// for provider/model problems.
//
//   meta = { source: 'llm'|'fallback', provider, model, task, attempts,
//            latencyMs, usage, fallbackUsed, reason, degraded }
import { z } from 'zod';
import logger from '../utils/logger.js';
import { resolveChain, runtimeConfig, TIERS } from './config.js';
import { reserveUserCall, recordUserTokens } from './userQuota.js';
import { getProvider } from './providers/index.js';
import { limiterFor } from './rateLimiter.js';
import { LLMError, isRetryable, toLLMError } from './errors.js';
import { zodToJsonSchema } from './schema.js';
import { recordOutcome, getLLMStatus as statusFor } from './status.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const registry = new Map();   // task name → task

// ─── Tasks ──────────────────────────────────────────────────────────────────

/**
 * Declare a structured-output task. `fallback(context)` must be deterministic
 * and offline; `safeDefault` is the last-resort value and must itself pass the
 * schema (checked here, at definition time).
 */
export function defineTask({ name, schema, fallback, safeDefault, temperature = 0.2, maxTokens = 1024, tier = 'strong' }) {
  if (!name || !(schema instanceof z.ZodType)) throw new TypeError('defineTask needs a name and a zod schema');
  if (!TIERS.includes(tier)) throw new TypeError(`defineTask tier must be one of: ${TIERS.join(', ')}`);
  const ok = schema.safeParse(safeDefault);
  if (!ok.success) throw new TypeError(`safeDefault for task "${name}" fails its schema: ${z.prettifyError(ok.error)}`);

  // tier picks the default model chain (llm/config.js): 'strong' = Gemini 3.8
  // Flash first, 'fast' = Gemini 3.5 Flash-Lite first.
  const task = {
    name, schema, temperature, maxTokens, tier,
    safeDefault: ok.data,
    jsonSchema: zodToJsonSchema(schema),
    fallback: fallback ?? null,
  };
  registry.set(name, task);
  return task;
}

/** Replace the rule-based backup for an already-defined task. */
export function registerFallback(name, handler) {
  const task = registry.get(name);
  if (!task) throw new Error(`Unknown LLM task "${name}"`);
  task.fallback = handler;
}

export function getTask(name) {
  return registry.get(name) ?? null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseJSON(text) {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { return JSON.parse(clean); } catch { /* fall through */ }
  const first = clean.indexOf('{');
  const last  = clean.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(clean.slice(first, last + 1)); } catch { /* fall through */ }
  }
  return undefined;
}

function validate(task, text, check) {
  const raw = parseJSON(text);
  if (raw === undefined) return { ok: false, error: 'Response was not valid JSON.' };
  const r = task.schema.safeParse(raw);
  if (!r.success) return { ok: false, error: z.prettifyError(r.error) };
  if (check) {
    let problem;
    try { problem = check(r.data); } catch { problem = 'Response failed a server-side check.'; }
    if (problem) return { ok: false, error: String(problem) };
  }
  return { ok: true, data: r.data };
}

const estimateTokens = (messages, maxTokens) =>
  Math.ceil(messages.reduce((a, m) => a + m.content.length, 0) / 4) + maxTokens;

function backoffMs(attempt, baseMs) {
  // Full jitter: uniform in [0.5, 1.5) × base·2^attempt.
  return Math.round(baseMs * 2 ** attempt * (0.5 + Math.random()));
}

/** One provider link: rate limit → request (timeout) → transient retries. */
async function callProvider({ provider, model, messages, task, cfg, log, counter }) {
  const limiter = limiterFor(provider.id);

  for (let retry = 0; ; retry++) {
    const slot = await limiter.acquire(estimateTokens(messages, task.maxTokens), cfg.queueTimeoutMs, model);
    const attempt = ++counter.n;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, cfg.timeoutMs);
    const started = Date.now();

    try {
      const out = await provider.complete({
        model,
        messages,
        jsonSchema: task.jsonSchema,
        schemaName: task.name,
        temperature: task.temperature,
        maxTokens: task.maxTokens,
        signal: controller.signal,
      });
      const tokens = (out.usage?.inputTokens ?? 0) + (out.usage?.outputTokens ?? 0);
      slot.commit(tokens || undefined);
      log.info({ task: task.name, provider: provider.id, model, attempt, latencyMs: Date.now() - started,
                 usage: out.usage, outcome: 'response' }, '[llm] attempt');
      return out;
    } catch (thrown) {
      const err = toLLMError(thrown, { timedOut });
      const latencyMs = Date.now() - started;
      if (err.status === 429 && err.retryAfterMs) limiter.blockFor(err.retryAfterMs, model);

      const wait = err.retryAfterMs ?? backoffMs(retry, cfg.backoffBaseMs);
      const willRetry = isRetryable(err) && retry < cfg.maxRetries && wait <= cfg.maxRetryWaitMs;
      log.warn({ task: task.name, provider: provider.id, model, attempt, latencyMs,
                 status: err.status, code: err.code, err: err.message,
                 outcome: willRetry ? 'retry' : 'give_up', waitMs: willRetry ? wait : undefined }, '[llm] attempt failed');
      if (!willRetry) throw err;
      await sleep(wait);
    } finally {
      clearTimeout(timer);
    }
  }
}

function runFallback(task, context, log) {
  if (task.fallback) {
    try {
      const r = task.schema.safeParse(task.fallback(context ?? {}));
      if (r.success) return { data: r.data, degraded: false };
      log.error({ task: task.name, err: z.prettifyError(r.error) }, '[llm] rule-based fallback produced invalid output');
    } catch (err) {
      log.error({ task: task.name, err }, '[llm] rule-based fallback threw');
    }
  }
  return { data: structuredClone(task.safeDefault), degraded: true };
}

// ─── generate ───────────────────────────────────────────────────────────────

// `userId` (optional) counts the call against that user's AI_DAILY_LIMIT; over
// the limit the call goes straight to the rule-based fallback.
export async function generate(messages, task, { context, log = logger, userId, check } = {}) {
  if (!Array.isArray(messages) || !messages.every(m => typeof m?.content === 'string' && m.role))
    throw new TypeError('generate(messages, task): messages must be [{ role, content }]');
  if (!task?.schema || !registry.has(task.name))
    throw new TypeError('generate(messages, task): task must come from defineTask()');

  const cfg = runtimeConfig();
  let chain = resolveChain(task);
  const started = Date.now();
  const counter = { n: 0 };
  let reason = chain.length ? null : 'unconfigured';

  if (userId && chain.length && !(await reserveUserCall(userId, task.name, log))) {
    reason = 'user_daily_limit';
    chain = [];
  }

  for (const [position, link] of chain.entries()) {
    const provider = getProvider(link.provider);
    if (!provider) { reason = `unknown_provider:${link.provider}`; log.error({ link }, '[llm] unknown provider in chain'); continue; }
    if (!provider.isConfigured()) { reason = `unconfigured:${link.provider}`; continue; }

    let convo = messages;
    try {
      for (let fix = 0; fix < 2; fix++) {
        const out = await callProvider({ provider, model: link.model, messages: convo, task, cfg, log, counter });
        const v = validate(task, out.text, check);
        if (v.ok) {
          const meta = {
            source: 'llm', provider: provider.id, model: link.model, task: task.name,
            attempts: counter.n, latencyMs: Date.now() - started, usage: out.usage,
            fallbackUsed: position > 0, reason: position > 0 ? reason : null, degraded: false,
          };
          recordOutcome({ servedByPrimary: position === 0, ruleBased: false, reason });
          if (userId) await recordUserTokens(userId, out.usage, log);
          log.info(meta, '[llm] served');
          return { data: v.data, meta };
        }
        log.warn({ task: task.name, provider: provider.id, model: link.model, fix, err: v.error }, '[llm] schema validation failed');
        reason = `invalid_output:${provider.id}`;
        // Feed the error back once; a second miss moves down the chain.
        convo = [
          ...messages,
          { role: 'assistant', content: out.text },
          { role: 'user', content: `Your previous reply failed validation:\n${v.error}\nReply again with ONLY the corrected JSON object.` },
        ];
      }
    } catch (err) {
      reason = `${err instanceof LLMError ? (err.status ?? err.code) : 'error'}:${provider.id}`;
    }
  }

  const { data, degraded } = runFallback(task, context, log);
  const meta = {
    source: 'fallback', provider: null, model: null, task: task.name,
    attempts: counter.n, latencyMs: Date.now() - started, usage: null,
    fallbackUsed: true, reason, degraded,
  };
  recordOutcome({ servedByPrimary: false, ruleBased: true, reason });
  log.warn(meta, '[llm] served by rule-based fallback');
  return { data, meta };
}

export function getLLMStatus() {
  return { ...statusFor(resolveChain('strong')), fastChain: resolveChain('fast').map(l => `${l.provider}:${l.model}`) };
}
