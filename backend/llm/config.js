// All LLM configuration, read from env at call time (so tests and key
// rotations don't depend on import order). This is the ONLY file that knows
// default model names.
//
// Default chain (LLM_PROVIDER and LLM_FALLBACKS both unset) depends on the
// task's tier (defineTask({ tier })), skipping providers without a key:
//
//   strong (insights)            gemini:GEMINI_MODEL       (gemini-3.8-flash)
//                                gemini:GEMINI_MODEL_FAST  (gemini-3.5-flash-lite)
//                                openai:LLM_MODEL          (openai/gpt-4.1-mini, GitHub Models)
//   fast (tips, coach, planner)  gemini:GEMINI_MODEL_FAST
//                                openai:LLM_MODEL
//
// So an overloaded 3.8 Flash (503 "high demand") drops to 3.5 Flash-Lite
// before leaving Gemini, and GitHub is the last LLM before the rule-based
// backup.
//
// Explicit chain (either variable set) — the same for every task:
//   LLM_PROVIDER     primary provider id (openai | gemini).
//   LLM_MODEL        primary model (default depends on provider, see below).
//   LLM_FALLBACKS    comma list of provider:model tried after the primary,
//                    e.g. "openai:openai/gpt-4.1-mini". "none" = no LLM
//                    fallbacks. Default: Gemini (GEMINI_MODEL) when it isn't
//                    the primary and GEMINI_API_KEY is set.
//   LLM_TIMEOUT_MS          per-request timeout (default 20000)
//   LLM_MAX_RETRIES         transient-error retries per provider (default 2)
//   LLM_MAX_RETRY_WAIT_MS   longest single backoff / Retry-After we'll sit
//                           through before moving down the chain (default 8000)
//   LLM_QUEUE_TIMEOUT_MS    longest wait for a local rate-limit slot (default 5000)
//   LLM_RPM_<PROVIDER>      requests/min limit, e.g. LLM_RPM_OPENAI (0 = none)
//   LLM_TPM_<PROVIDER>      tokens/min limit,   e.g. LLM_TPM_GEMINI (0 = none)
//
// Provider credentials: openai → LLM_API_KEY, LLM_BASE_URL;
//                       gemini → GEMINI_API_KEY, GEMINI_MODEL, GEMINI_MODEL_FAST,
//                                GEMINI_BASE_URL.

export const DEFAULT_MODELS = {
  openai: 'openai/gpt-4.1-mini',
  gemini: 'gemini-3.8-flash',
};
export const DEFAULT_GEMINI_FAST_MODEL = 'gemini-3.5-flash-lite';
export const TIERS = Object.freeze(['strong', 'fast']);

// Free-tier-friendly defaults; override per deployment.
const DEFAULT_LIMITS = {
  openai: { rpm: 15, tpm: 0 },
  gemini: { rpm: 10, tpm: 250_000 },
};

const int = (v, fallback) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};

function defaultModelFor(provider) {
  if (provider === 'gemini') return process.env.GEMINI_MODEL || DEFAULT_MODELS.gemini;
  return DEFAULT_MODELS[provider] ?? null;
}

function primaryProvider() {
  if (process.env.LLM_PROVIDER) return process.env.LLM_PROVIDER.trim();
  if (process.env.LLM_API_KEY) return 'openai';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  return null;
}

const geminiFastModel = () => process.env.GEMINI_MODEL_FAST || DEFAULT_GEMINI_FAST_MODEL;

function tieredChain(tier) {
  const chain = [];
  if (process.env.GEMINI_API_KEY) {
    const strong = defaultModelFor('gemini');
    const fast   = geminiFastModel();
    if (tier === 'strong') chain.push({ provider: 'gemini', model: strong });
    if (tier === 'fast' || fast !== strong) chain.push({ provider: 'gemini', model: fast });
  }
  if (process.env.LLM_API_KEY) {
    chain.push({ provider: 'openai', model: process.env.LLM_MODEL || DEFAULT_MODELS.openai });
  }
  return chain;
}

/**
 * Ordered [{ provider, model }] the generate() loop walks through.
 * `task` (or a tier string) picks the default chain; see the header.
 */
export function resolveChain(task) {
  const tier = (typeof task === 'string' ? task : task?.tier) === 'fast' ? 'fast' : 'strong';
  if (process.env.LLM_PROVIDER === undefined && process.env.LLM_FALLBACKS === undefined) {
    return tieredChain(tier);
  }

  const chain = [];
  const primary = primaryProvider();
  if (primary) {
    // LLM_MODEL historically meant the OpenAI-compatible model; it applies to
    // whichever provider is primary.
    chain.push({ provider: primary, model: process.env.LLM_MODEL || defaultModelFor(primary) });
  }

  const raw = process.env.LLM_FALLBACKS;
  if (raw !== undefined) {
    if (raw.trim().toLowerCase() !== 'none') {
      for (const entry of raw.split(',').map(s => s.trim()).filter(Boolean)) {
        const [provider, ...rest] = entry.split(':');
        chain.push({ provider, model: rest.join(':') || defaultModelFor(provider) });
      }
    }
  } else if (primary !== 'gemini' && process.env.GEMINI_API_KEY) {
    chain.push({ provider: 'gemini', model: defaultModelFor('gemini') });
  }
  return chain;
}

export function runtimeConfig() {
  return {
    timeoutMs:       int(process.env.LLM_TIMEOUT_MS, 20_000),
    maxRetries:      int(process.env.LLM_MAX_RETRIES, 2),
    maxRetryWaitMs:  int(process.env.LLM_MAX_RETRY_WAIT_MS, 8_000),
    queueTimeoutMs:  int(process.env.LLM_QUEUE_TIMEOUT_MS, 5_000),
    backoffBaseMs:   int(process.env.LLM_BACKOFF_BASE_MS, 500),
  };
}

export function limitsFor(provider) {
  const key = provider.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const d = DEFAULT_LIMITS[provider] ?? { rpm: 0, tpm: 0 };
  return {
    rpm: int(process.env[`LLM_RPM_${key}`], d.rpm),
    tpm: int(process.env[`LLM_TPM_${key}`], d.tpm),
  };
}
