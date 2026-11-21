// Error shape shared by provider adapters and the retry loop.
//   status        HTTP status (if any)
//   code          TIMEOUT | NETWORK | RATE_LIMITED_LOCAL | BAD_RESPONSE | HTTP
//   retryAfterMs  provider-requested wait (Retry-After / Gemini retryDelay)
export class LLMError extends Error {
  constructor(message, { status = null, code = 'HTTP', retryAfterMs = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'LLMError';
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

/** 429, 5xx, timeouts and network errors are worth retrying; 4xx are not. */
export function isRetryable(err) {
  if (err?.code === 'TIMEOUT' || err?.code === 'NETWORK') return true;
  const s = err?.status;
  return s === 429 || s === 408 || (typeof s === 'number' && s >= 500);
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) into ms. */
export function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** Normalize a thrown fetch/abort error into an LLMError. */
export function toLLMError(err, { timedOut = false } = {}) {
  if (err instanceof LLMError) return err;
  if (timedOut || err?.name === 'AbortError' || err?.name === 'TimeoutError')
    return new LLMError('LLM request timed out', { code: 'TIMEOUT', cause: err });
  return new LLMError(`LLM network error: ${err?.message ?? err}`, { code: 'NETWORK', cause: err });
}
