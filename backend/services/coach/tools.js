// Read-only, user-scoped data tools for the AI Focus Coach.
//
// Security contract (tested in test/coachTools.test.js):
//   - The user identity comes ONLY from the execution context the server
//     builds from the authenticated request ({ userId, tz }). Tool argument
//     schemas are .strict(), so a model-supplied `userId` (or any other
//     unknown key) is rejected rather than ignored.
//   - Every query filters on that userId. Tools only read (find/count); none
//     writes, and none accepts free-form query fragments, field names or code.
//   - Results carry the minimum needed to answer: no ids, no session titles,
//     no category names, no account details.
//
// Each tool: { name, description, args (zod), parameters (JSON Schema derived
// from args with the LLM layer's zodToJsonSchema), run(ctx, args) }.
import { z } from 'zod';
import Session, { actualSecOf, plannedSecOf } from '../../models/Session.js';
import FocusLog from '../../models/FocusLog.js';
import Statistics from '../../models/Statistics.js';
import { DISTRACTION_EVENTS, FOCUS_EVENT, eventAppKey } from '../../constants/focusEvents.js';
import { breakWindows, isDuringBreak } from '../../utils/breaks.js';
import { zodToJsonSchema } from '../../llm/schema.js';
import {
  localHourOf, formatLocalHHMM, userTodayStr, shiftDateStr, diffDays, resolveTimezone,
} from '../../utils/datetime.js';

export const MAX_RANGE_DAYS     = 92;   // ~one quarter per call
export const MAX_SESSIONS_LIMIT = 50;
export const EARLIEST_DATE      = '2020-01-01';

const ENDED = ['COMPLETED', 'ABANDONED'];

/** Thrown for bad tool input; its message is safe to show the model. */
export class ToolInputError extends Error {
  constructor(message) { super(message); this.name = 'ToolInputError'; }
}

// ─── Argument schemas ────────────────────────────────────────────────────────

const isRealDate = (s) => shiftDateStr(s, 0) === s;   // rejects 2026-02-30 etc.
const dateStr = (what) => z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, `${what} must be YYYY-MM-DD`)
  .refine(isRealDate, `${what} is not a real calendar date`)
  .describe(`${what} as a local calendar date, YYYY-MM-DD (inclusive)`);

const RangeArgs = z.object({ from: dateStr('Start date'), to: dateStr('End date') }).strict();

/** Range rules that need "today" in the user's zone. Returns normalized range. */
function checkRange({ from, to }, tz) {
  const latest = shiftDateStr(userTodayStr(tz), 1);
  if (from > to)              throw new ToolInputError('from must be on or before to');
  if (from < EARLIEST_DATE)   throw new ToolInputError(`from must be on or after ${EARLIEST_DATE}`);
  if (to > latest)            throw new ToolInputError('to must not be in the future');
  if (diffDays(from, to) + 1 > MAX_RANGE_DAYS)
    throw new ToolInputError(`range must span at most ${MAX_RANGE_DAYS} days`);
  return { from, to, days: diffDays(from, to) + 1 };
}

const minutes  = (sec) => (sec === null || sec === undefined ? null : Math.round(sec / 60));
const avg      = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round1   = (n) => (n === null ? null : Math.round(n * 10) / 10);
const hourLabel = (h) => `${String(h).padStart(2, '0')}:00`;
const scoreOf  = (s) => (typeof s.focusScore === 'number' ? s.focusScore : null);

function endedSessionsInRange(userId, { from, to }, projection) {
  return Session.find(
    { userId, status: { $in: ENDED }, dateStr: { $gte: from, $lte: to } },
    projection,
  ).sort({ startedAt: 1 }).lean();
}

// ─── Tools ───────────────────────────────────────────────────────────────────

const getSessionsByRange = {
  name: 'getSessionsByRange',
  description: 'List the user\'s ended focus sessions (completed or abandoned) between two local dates, '
             + 'oldest first. Use for questions about specific sessions.',
  args: RangeArgs.extend({
    limit: z.number().int().min(1).max(MAX_SESSIONS_LIMIT).optional()
      .describe(`Max sessions to return, 1-${MAX_SESSIONS_LIMIT} (default 20)`),
  }).strict(),
  async run({ userId, tz }, args) {
    const range = checkRange(args, tz);
    const limit = args.limit ?? 20;
    const rows = await endedSessionsInRange(userId, range, {
      status: 1, timerMode: 1, dateStr: 1, startedAt: 1, focusScore: 1,
      plannedDurationSec: 1, actualDurationSec: 1, timerConfig: 1, timerState: 1,
    });
    return {
      from: range.from,
      to: range.to,
      daysInRange: range.days,
      totalSessions: rows.length,
      returned: Math.min(rows.length, limit),
      truncated: rows.length > limit,
      sessions: rows.slice(0, limit).map(s => ({
        date:           s.dateStr,
        startTime:      s.startedAt ? formatLocalHHMM(s.startedAt, tz) : null,
        status:         s.status,
        mode:           s.timerMode,
        plannedMinutes: minutes(plannedSecOf(s)),
        focusMinutes:   minutes(actualSecOf(s)),
        focusScore:     scoreOf(s),
      })),
    };
  },
};

const getDailyAggregates = {
  name: 'getDailyAggregates',
  description: 'Per-day totals between two local dates: focus minutes (completed sessions), '
             + 'completed and abandoned counts, average focus score. Only days with sessions are listed.',
  args: RangeArgs,
  async run({ userId, tz }, args) {
    const range = checkRange(args, tz);
    const rows = await endedSessionsInRange(userId, range, {
      status: 1, dateStr: 1, focusScore: 1, actualDurationSec: 1, timerState: 1,
    });
    const byDay = new Map();
    for (const s of rows) {
      const d = byDay.get(s.dateStr) ?? { date: s.dateStr, sec: 0, completed: 0, abandoned: 0, scores: [] };
      if (s.status === 'COMPLETED') {
        d.completed++;
        d.sec += actualSecOf(s) ?? 0;
        if (scoreOf(s) !== null) d.scores.push(s.focusScore);
      } else d.abandoned++;
      byDay.set(s.dateStr, d);
    }
    const days = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)).map(d => ({
      date:              d.date,
      focusMinutes:      Math.round(d.sec / 60),
      sessionsCompleted: d.completed,
      sessionsAbandoned: d.abandoned,
      avgFocusScore:     d.scores.length ? Math.round(avg(d.scores)) : null,
    }));
    return {
      from: range.from,
      to: range.to,
      daysInRange: range.days,
      daysWithSessions: days.length,
      totalFocusMinutes: days.reduce((a, d) => a + d.focusMinutes, 0),
      days,
    };
  },
};

const getHourlyAverages = {
  name: 'getHourlyAverages',
  description: 'For completed sessions between two local dates, grouped by local start hour (0-23): '
             + 'session count, average focus minutes, average focus score. Only hours with sessions are listed.',
  args: RangeArgs,
  async run({ userId, tz }, args) {
    const range = checkRange(args, tz);
    const rows = (await endedSessionsInRange(userId, range, {
      status: 1, startedAt: 1, focusScore: 1, actualDurationSec: 1, timerState: 1,
    })).filter(s => s.status === 'COMPLETED' && s.startedAt);

    const byHour = new Map();
    for (const s of rows) {
      const h = localHourOf(s.startedAt, tz);
      const b = byHour.get(h) ?? { mins: [], scores: [] };
      b.mins.push((actualSecOf(s) ?? 0) / 60);
      if (scoreOf(s) !== null) b.scores.push(s.focusScore);
      byHour.set(h, b);
    }
    const hours = [...byHour.entries()].sort((a, b) => a[0] - b[0]).map(([h, b]) => ({
      hour:            h,
      label:           hourLabel(h),
      sessions:        b.mins.length,
      avgFocusMinutes: Math.round(avg(b.mins)),
      avgFocusScore:   b.scores.length ? Math.round(avg(b.scores)) : null,
    }));
    return { from: range.from, to: range.to, daysInRange: range.days, completedSessions: rows.length, hours };
  },
};

const getStreak = {
  name: 'getStreak',
  description: 'The user\'s current and longest streak of consecutive local days with at least one completed session.',
  args: z.object({}).strict(),
  async run({ userId, tz }) {
    const { current, longest } = await Statistics.computeStreak(userId, tz);
    return { currentStreakDays: current, longestStreakDays: longest };
  },
};

const getDistractionStats = {
  name: 'getDistractionStats',
  description: 'Distraction events (blocked app attempts + detected distractions) during focus time of '
             + 'sessions between two local dates, with the top apps. Events inside breaks are excluded.',
  args: RangeArgs,
  async run({ userId, tz }, args) {
    const range = checkRange(args, tz);
    const sessions = await endedSessionsInRange(userId, range, { breaks: 1 });
    const windows = new Map(sessions.filter(s => s.breaks?.length).map(s => [String(s._id), breakWindows(s)]));

    const logs = sessions.length
      ? await FocusLog.find(
          { userId, sessionId: { $in: sessions.map(s => s._id) }, event: { $in: DISTRACTION_EVENTS } },
          { sessionId: 1, event: 1, timestamp: 1, metadata: 1 },
        ).lean()
      : [];

    let appBlocked = 0, other = 0;
    const perSession = new Set();
    const apps = {};
    for (const l of logs) {
      const w = windows.get(String(l.sessionId));
      if (w && isDuringBreak(l.timestamp, w)) continue;
      if (l.event === FOCUS_EVENT.APP_BLOCKED) appBlocked++; else other++;
      perSession.add(String(l.sessionId));
      const app = (eventAppKey(l) || 'unknown').slice(0, 60);
      apps[app] = (apps[app] || 0) + 1;
    }
    const total = appBlocked + other;
    return {
      from: range.from,
      to: range.to,
      daysInRange: range.days,
      sessionsInRange: sessions.length,
      totalDistractions: total,
      blockedAppAttempts: appBlocked,
      otherDistractions: other,
      sessionsWithDistractions: perSession.size,
      avgDistractionsPerSession: sessions.length ? round1(total / sessions.length) : null,
      topApps: Object.entries(apps).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([app, count]) => ({ app, count })),
      note: 'Counts only events the app detected; zero can mean none were detected.',
    };
  },
};

export const TOOLS = Object.freeze(
  [getSessionsByRange, getDailyAggregates, getHourlyAverages, getStreak, getDistractionStats]
    .map(t => Object.freeze({ ...t, parameters: zodToJsonSchema(t.args) })),
);
export const TOOL_NAMES = Object.freeze(TOOLS.map(t => t.name));
const BY_NAME = new Map(TOOLS.map(t => [t.name, t]));

/**
 * Build the execution context from an AUTHENTICATED user doc (req.user). This
 * is the only way tools learn who they're acting for.
 */
export function toolContextFor(user) {
  if (!user?._id) throw new Error('toolContextFor requires an authenticated user');
  return Object.freeze({ userId: user._id, tz: resolveTimezone(user) });
}

/**
 * Validate + run one tool. Never throws for bad input: returns
 * { ok: false, error } so the model can correct itself. Unexpected failures
 * are reported generically (no stack traces / DB details to the model).
 *
 * @param ctx   from toolContextFor(req.user)
 * @param name  tool name chosen by the model
 * @param rawArgs  parsed JSON arguments chosen by the model (untrusted)
 */
export async function executeTool(ctx, name, rawArgs, log) {
  const tool = BY_NAME.get(name);
  if (!tool) return { ok: false, error: `Unknown tool "${String(name).slice(0, 40)}". Allowed: ${TOOL_NAMES.join(', ')}` };
  const parsed = tool.args.safeParse(rawArgs ?? {});
  if (!parsed.success) return { ok: false, error: `Invalid arguments: ${z.prettifyError(parsed.error)}` };
  try {
    return { ok: true, result: await tool.run(ctx, parsed.data) };
  } catch (err) {
    if (err instanceof ToolInputError) return { ok: false, error: `Invalid arguments: ${err.message}` };
    log?.error?.({ err, tool: name }, '[coach] tool failed');
    return { ok: false, error: 'The tool failed to run. Tell the user the data is unavailable right now.' };
  }
}
