// LLM health counters surfaced via GET /api/health. Fallbacks hide primary
// failures from users, so this is where they become visible. A monotonic
// sequence (not timestamps) decides ok/failing so same-millisecond events
// aren't ambiguous.
let seq = 0;
let lastPrimarySuccess = null;   // { seq, at }
let lastFallback       = null;   // { seq, at, reason }
let fallbackCount      = 0;      // calls not served by the primary
let ruleBasedCount     = 0;      // calls served by the rule-based backup

export function recordOutcome({ servedByPrimary, ruleBased, reason }) {
  if (servedByPrimary) {
    lastPrimarySuccess = { seq: ++seq, at: new Date() };
    return;
  }
  lastFallback = { seq: ++seq, at: new Date(), reason: reason ?? 'error' };
  fallbackCount++;
  if (ruleBased) ruleBasedCount++;
}

export function getLLMStatus(chain) {
  const primary = !chain.length
    ? 'unconfigured'
    : (lastFallback && (!lastPrimarySuccess || lastFallback.seq > lastPrimarySuccess.seq))
      ? 'failing'
      : 'ok';
  return {
    primary,
    chain: chain.map(l => `${l.provider}:${l.model}`),
    fallbackCount,
    ruleBasedCount,
    lastFallbackAt:       lastFallback?.at ?? null,
    lastFallbackReason:   lastFallback?.reason ?? null,
    lastPrimarySuccessAt: lastPrimarySuccess?.at ?? null,
  };
}

export function resetStatus() {
  seq = 0; lastPrimarySuccess = null; lastFallback = null; fallbackCount = 0; ruleBasedCount = 0;
}
