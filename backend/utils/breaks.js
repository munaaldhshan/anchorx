// Custom Breaks (COUNTDOWN / STOPWATCH sessions).
//
// A session's break plan lives in timerConfig.breakPlan; the breaks actually
// taken live in session.breaks with server-recorded start/end times. Break time
// never counts as focus time, never lowers the score, and APP_BLOCKED events
// that land inside a break window are not counted as temptations.
import { requireInt, requireEnum, requireBool, badRequest } from '../middleware/validate.js';

export const BREAK_MODES   = ['COUNTDOWN', 'STOPWATCH'];
export const BREAK_TYPES   = ['PLANNED', 'ON_DEMAND'];
export const MAX_PLANNED   = 10;
export const MAX_BREAK_LEN = 60;   // minutes, per break
export const MAX_ALLOW_N   = 10;   // on-demand breaks per session
export const MAX_ALLOW_MIN = 180;  // on-demand minutes per session
const STOPWATCH_MAX_MIN    = 480;

const MIN_MS = 60_000;


/**
 * Validate + normalize a client-supplied break plan. Returns null when absent.
 * Throws 400 on any violation (including a plan on a POMODORO session).
 */
export function validateBreakPlan(raw, { timerMode, plannedDurationSec }) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('breakPlan must be an object');
  if (!BREAK_MODES.includes(timerMode))
    throw badRequest('breakPlan is only supported for COUNTDOWN and STOPWATCH sessions');

  // ── planned breaks ──
  const plannedRaw = raw.planned ?? [];
  if (!Array.isArray(plannedRaw)) throw badRequest('breakPlan.planned must be an array');
  if (plannedRaw.length > MAX_PLANNED)
    throw badRequest(`breakPlan.planned may contain at most ${MAX_PLANNED} breaks`);

  const maxStart = timerMode === 'STOPWATCH'
    ? STOPWATCH_MAX_MIN
    : Math.ceil(plannedDurationSec / 60) - 1;   // a break must start before focus ends
  const planned = plannedRaw.map((p, i) => {
    if (!p || typeof p !== 'object') throw badRequest(`breakPlan.planned[${i}] must be an object`);
    return {
      startAfter: requireInt(p.startAfter, { min: 1, max: maxStart, field: `breakPlan.planned[${i}].startAfter` }),
      duration:   requireInt(p.duration,   { min: 1, max: MAX_BREAK_LEN, field: `breakPlan.planned[${i}].duration` }),
    };
  });
  for (let i = 1; i < planned.length; i++) {
    if (planned[i].startAfter <= planned[i - 1].startAfter)
      throw badRequest('breakPlan.planned must be sorted by startAfter with no duplicates');
  }

  // ── on-demand allowance ──
  let allowance = null;
  if (raw.allowance !== undefined && raw.allowance !== null) {
    const a = raw.allowance;
    if (typeof a !== 'object' || Array.isArray(a)) throw badRequest('breakPlan.allowance must be an object');
    const maxBreaks  = a.maxBreaks  === undefined || a.maxBreaks  === null
      ? null : requireInt(a.maxBreaks,  { min: 0, max: MAX_ALLOW_N,   field: 'breakPlan.allowance.maxBreaks' });
    const maxMinutes = a.maxMinutes === undefined || a.maxMinutes === null
      ? null : requireInt(a.maxMinutes, { min: 0, max: MAX_ALLOW_MIN, field: 'breakPlan.allowance.maxMinutes' });
    if (maxBreaks === null && maxMinutes === null)
      throw badRequest('breakPlan.allowance needs maxBreaks and/or maxMinutes');
    allowance = { maxBreaks, maxMinutes };
  }

  const unlockAppsDuringBreak = raw.unlockAppsDuringBreak === undefined
    ? false
    : requireBool(raw.unlockAppsDuringBreak, { field: 'breakPlan.unlockAppsDuringBreak' });

  return { planned, allowance, unlockAppsDuringBreak };
}

/** The latest moment a break may end: its start plus its length. */
export function breakDeadline(brk) {
  return new Date(new Date(brk.startedAt).getTime() + brk.duration * MIN_MS);
}

/**
 * Clamp a proposed end time into [startedAt, deadline] and report whether the
 * break ended before its full length. Does not mutate.
 */
export function clampBreakEnd(brk, at) {
  const start    = new Date(brk.startedAt).getTime();
  const deadline = breakDeadline(brk).getTime();
  const t        = Math.min(Math.max(new Date(at).getTime(), start), deadline);
  return { endedAt: new Date(t), endedEarly: t < deadline };
}

/** The currently open break, or null. */
export function openBreak(session) {
  return (session.breaks ?? []).find(b => !b.endedAt) ?? null;
}

/**
 * [startMs, endMs] for every break. An open break is treated as running until
 * min(now, its deadline), so it is already excluded from focus/temptations.
 */
export function breakWindows(session, now = new Date()) {
  return (session.breaks ?? []).map(b => {
    const start = new Date(b.startedAt).getTime();
    const end   = b.endedAt
      ? new Date(b.endedAt).getTime()
      : clampBreakEnd(b, now).endedAt.getTime();
    return [start, end];
  });
}

export function isDuringBreak(timestamp, windows) {
  const t = new Date(timestamp).getTime();
  return windows.some(([s, e]) => t >= s && t < e);
}

/** On-demand allowance used so far, charged at the requested length. */
export function allowanceUsage(session) {
  const od = (session.breaks ?? []).filter(b => b.type === 'ON_DEMAND');
  return { count: od.length, minutes: od.reduce((a, b) => a + b.duration, 0) };
}

/** Remaining on-demand allowance (null field = unlimited on that axis). */
export function allowanceRemaining(session) {
  const plan = session.timerConfig?.breakPlan;
  if (!plan) return null;
  const allowance = plan.allowance;
  if (!allowance || (allowance.maxBreaks == null && allowance.maxMinutes == null)) {
    return { breaks: 0, minutes: 0 };   // no allowance → on-demand breaks disabled
  }
  const used = allowanceUsage(session);
  return {
    breaks:  allowance.maxBreaks  == null ? null : Math.max(0, allowance.maxBreaks  - used.count),
    minutes: allowance.maxMinutes == null ? null : Math.max(0, allowance.maxMinutes - used.minutes),
  };
}

/** Total seconds spent on closed breaks. */
export function totalBreakSec(session) {
  const ms = (session.breaks ?? [])
    .filter(b => b.endedAt)
    .reduce((a, b) => a + (new Date(b.endedAt).getTime() - new Date(b.startedAt).getTime()), 0);
  return Math.round(ms / 1000);
}

/** Whether this session uses Custom Breaks at all. */
export function hasCustomBreaks(session) {
  return Boolean(session.timerConfig?.breakPlan) || (session.breaks?.length ?? 0) > 0;
}
