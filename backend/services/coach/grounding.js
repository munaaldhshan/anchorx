// Numeric grounding for AI Focus Coach answers.
//
// Rule: every number that appears in a validated answer (any section, any
// label, and dataGaps) must appear in the AUTHORIZED evidence for the turn:
//   - tool results executed by the server during this turn,
//   - the user's own messages (current turn + history sent to the model),
//   - earlier assistant answers in the conversation (themselves validated),
//   - the reference date the server put in the prompt.
//
// A small set of mechanical derivations of evidence numbers is accepted
// (rounding to an integer or to one decimal, and minutes → hours), because a
// model reasonably writes "about 2.5 hours" for 150 minutes. Anything else —
// including new percentages, ratios or "typical" figures — is rejected and fed
// back to the model as a validation error (bounded retry in llm/generate).
//
// Known limit: numbers spelled out as words ("twenty") aren't detected; the
// system prompt forbids them for figures.

const NUM_RE = /\d+(?:,\d{3})*(?:\.\d+)?/g;

/** Numeric tokens in a string, as Numbers ("1,200" → 1200, "09" → 9). */
export function extractNumbers(text) {
  if (typeof text !== 'string') return [];
  return (text.match(NUM_RE) ?? []).map(t => Number(t.replace(/,/g, ''))).filter(Number.isFinite);
}

/** Every number in an arbitrary JSON value (numbers + numbers inside strings). */
function collect(value, out) {
  if (typeof value === 'number') { if (Number.isFinite(value)) out.push(Math.abs(value)); return out; }
  if (typeof value === 'string') { out.push(...extractNumbers(value)); return out; }
  if (Array.isArray(value)) { for (const v of value) collect(v, out); return out; }
  if (value && typeof value === 'object') { for (const v of Object.values(value)) collect(v, out); }
  return out;
}

const key = (n) => String(Math.round(n * 1000) / 1000);
const r1 = (n) => Math.round(n * 10) / 10;

/** Build the allowed-number set from evidence values (any JSON / strings). */
export function buildEvidence(...sources) {
  const allowed = new Set();
  for (const n of collect(sources, [])) {
    for (const v of [n, Math.round(n), r1(n), Math.floor(n), Math.ceil(n), r1(n / 60), Math.round(n / 60)]) {
      allowed.add(key(v));
    }
  }
  return allowed;
}

/** Numbers in `texts` not supported by `evidence` (unique, in order). */
export function ungroundedNumbers(texts, evidence) {
  const bad = [];
  for (const text of texts) {
    for (const n of extractNumbers(text)) {
      if (!evidence.has(key(n)) && !bad.includes(n)) bad.push(n);
    }
  }
  return bad;
}

/**
 * Check a validated answer against two evidence tiers:
 *   measured  — measured_data sections: server tool results (this turn),
 *               earlier measured_data answers, the reference date.
 *   context   — ai_suggestion sections and dataGaps: everything in
 *               `measured` plus the user's own messages and earlier
 *               suggestions. A figure the user typed may be echoed in a
 *               suggestion, but never presented as measured data.
 * Returns an error message for the model, or null when grounded.
 */
export function groundingProblem(answer, { measured, context }) {
  const sections = answer?.sections ?? [];
  const badMeasured = ungroundedNumbers(
    sections.filter(s => s.kind === 'measured_data').map(s => s.text), measured);
  const badOther = ungroundedNumbers(
    [...sections.filter(s => s.kind !== 'measured_data').map(s => s.text), ...(answer?.dataGaps ?? [])], context);
  if (!badMeasured.length && !badOther.length) return null;

  const parts = [];
  if (badMeasured.length)
    parts.push(`measured_data sections contain numbers that are not in this turn's tool results: ${badMeasured.slice(0, 5).join(', ')}`);
  if (badOther.length)
    parts.push(`ai_suggestion sections or dataGaps contain numbers not supported by the tool results or conversation: ${badOther.slice(0, 5).join(', ')}`);
  return `${parts.join('; ')}. Use only figures that appear in the tool results (call a tool if you need data), `
       + 'or remove the numbers. If the data is missing, say so in dataGaps.';
}
