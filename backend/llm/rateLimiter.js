// Per-provider sliding-window limiter (requests/min + tokens/min) with a
// bounded wait queue, plus a cool-down honoured after a provider 429 with
// Retry-After. In-process only: with N server instances the effective limit is
// N× — fine for a single Render dyno, revisit if we scale out.
import { LLMError } from './errors.js';
import { limitsFor } from './config.js';

const WINDOW_MS = 60_000;
const limiters = new Map();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class ProviderLimiter {
  constructor(provider) {
    this.provider = provider;
    this.entries = [];          // { at, tokens }
    // 429 cool-downs are per MODEL: provider quotas (e.g. Gemini free tier)
    // are tracked per model, so 3.8 Flash running out must not also block
    // 3.5 Flash-Lite. Key '' = whole provider (no model given).
    this.blockedUntil = new Map();
  }

  blockedFor(model, now) {
    const until = Math.max(this.blockedUntil.get('') ?? 0, model ? (this.blockedUntil.get(model) ?? 0) : 0);
    return Math.max(0, until - now);
  }

  prune(now) {
    while (this.entries.length && now - this.entries[0].at >= WINDOW_MS) this.entries.shift();
  }

  /** ms until a slot for `tokens` frees up (0 = available now). */
  waitFor(tokens, now, model) {
    const { rpm, tpm } = limitsFor(this.provider);
    this.prune(now);
    let wait = this.blockedFor(model, now);
    if (rpm > 0 && this.entries.length >= rpm) {
      wait = Math.max(wait, this.entries[this.entries.length - rpm].at + WINDOW_MS - now);
    }
    if (tpm > 0) {
      const used = this.entries.reduce((a, e) => a + e.tokens, 0);
      if (used + tokens > tpm) {
        // Oldest entries expire first; find when enough tokens roll off.
        let freed = 0;
        for (const e of this.entries) {
          freed += e.tokens;
          if (used - freed + tokens <= tpm) { wait = Math.max(wait, e.at + WINDOW_MS - now); break; }
        }
        if (tokens > tpm) wait = Infinity;   // a single request bigger than the budget never fits
      }
    }
    return wait;
  }

  /**
   * Reserve a slot, waiting up to maxWaitMs. Resolves to a handle whose
   * commit(actualTokens) replaces the estimate once usage is known.
   */
  async acquire(estTokens, maxWaitMs, model) {
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
      const now = Date.now();
      const wait = this.waitFor(estTokens, now, model);
      if (wait === 0) {
        const entry = { at: now, tokens: estTokens };
        this.entries.push(entry);
        return { commit: (actual) => { if (Number.isFinite(actual)) entry.tokens = actual; } };
      }
      if (now + wait > deadline) {
        throw new LLMError(`${this.provider} local rate limit: no slot within ${maxWaitMs}ms`, {
          code: 'RATE_LIMITED_LOCAL', retryAfterMs: Number.isFinite(wait) ? wait : null,
        });
      }
      // Small jitter so queued callers don't stampede the same instant.
      await sleep(wait + Math.floor(Math.random() * 50));
    }
  }

  /** Provider told us to back off (429 + Retry-After) — for `model`, or all models. */
  blockFor(ms, model = '') {
    this.blockedUntil.set(model, Math.max(this.blockedUntil.get(model) ?? 0, Date.now() + ms));
  }
}

export function limiterFor(provider) {
  if (!limiters.has(provider)) limiters.set(provider, new ProviderLimiter(provider));
  return limiters.get(provider);
}

/** Test hook: forget all usage history. */
export function resetLimiters() {
  limiters.clear();
}
