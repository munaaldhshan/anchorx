// Canonical FocusLog event model — the one definition producers (routes,
// future iOS shield extension) and consumers (scoring, Statistics, AI
// insights) share. See docs/step0.md for the full contract.
//
// Semantics:
//   APP_BLOCKED  A block was ENFORCED: the user tried to open a shielded app
//                and the shield stopped them.
//   DISTRACTION  A distracting activity was DETECTED that no shield stopped
//                (e.g. left the app for something not on the block list).
//
// One occurrence → exactly one event. A blocked attempt is logged as
// APP_BLOCKED only (never also as DISTRACTION), so the distraction total is
// simply count(APP_BLOCKED) + count(DISTRACTION) with no double counting.

export const FOCUS_EVENT = Object.freeze({
  SESSION_STARTED: 'SESSION_STARTED',
  SESSION_ENDED:   'SESSION_ENDED',
  APP_BLOCKED:     'APP_BLOCKED',
  DISTRACTION:     'DISTRACTION',
  BREAK_STARTED:   'BREAK_STARTED',
  BREAK_ENDED:     'BREAK_ENDED',
  NFC_VERIFIED:    'NFC_VERIFIED',
  NFC_REJECTED:    'NFC_REJECTED',
});

export const FOCUS_EVENTS = Object.freeze(Object.values(FOCUS_EVENT));

/** Every event that counts as "the user got distracted" (scoring, insights). */
export const DISTRACTION_EVENTS = Object.freeze([FOCUS_EVENT.APP_BLOCKED, FOCUS_EVENT.DISTRACTION]);

/**
 * Events a client may append via POST /api/sessions/:id/log. Lifecycle and
 * NFC events are written by the server itself as side effects of start/end.
 */
export const CLIENT_LOGGABLE_EVENTS = Object.freeze([
  FOCUS_EVENT.APP_BLOCKED,
  FOCUS_EVENT.DISTRACTION,
  FOCUS_EVENT.BREAK_STARTED,
  FOCUS_EVENT.BREAK_ENDED,
]);

/** Where a distraction signal came from. Free-form values are rejected. */
export const EVENT_SOURCES = Object.freeze(['shield', 'app_state', 'manual', 'system']);

// Allowed metadata keys and their max lengths. Anything else is dropped.
const METADATA_LIMITS = { appName: 200, packageName: 200, reason: 200, source: 20, tagUid: 100 };

/**
 * Normalize client-supplied metadata to the canonical shape. Unknown keys are
 * dropped, strings are trimmed/truncated, and `source` must be an EVENT_SOURCES
 * value. Returns { metadata } or { error } — never throws.
 */
export function normalizeEventMetadata(raw) {
  if (raw === undefined || raw === null) return { metadata: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'metadata must be an object' };

  const metadata = {};
  for (const [key, max] of Object.entries(METADATA_LIMITS)) {
    const v = raw[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') return { error: `metadata.${key} must be a string` };
    const s = v.trim().slice(0, max);
    if (s) metadata[key] = s;
  }
  if (metadata.source && !EVENT_SOURCES.includes(metadata.source))
    return { error: `metadata.source must be one of: ${EVENT_SOURCES.join(', ')}` };
  return { metadata };
}

/** Display key for an app in a distraction event (bundle id preferred). */
export function eventAppKey(log) {
  return log?.metadata?.packageName || log?.metadata?.appName || null;
}
