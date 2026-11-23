// AI Focus Coach data tools (services/coach/tools.js): user scoping, input
// validation, minimal output and honest empty results. No LLM involved.
import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import Session from '../models/Session.js';
import FocusLog from '../models/FocusLog.js';
import Statistics from '../models/Statistics.js';
import { executeTool, toolContextFor, TOOLS, TOOL_NAMES, MAX_RANGE_DAYS } from '../services/coach/tools.js';
import { userTodayStr, shiftDateStr, localDayStartUtc } from '../utils/datetime.js';

const oid = () => new mongoose.Types.ObjectId();
const userA = { _id: oid(), settings: { timezone: 'UTC' } };
const userB = { _id: oid(), settings: { timezone: 'UTC' } };
const ctxA = toolContextFor(userA);
const today = userTodayStr('UTC');
const yesterday = shiftDateStr(today, -1);
const range = { from: shiftDateStr(today, -6), to: today };

/** A completed (or abandoned) session on `dateStr` starting at `hour` UTC. */
async function seedSession(user, { dateStr = yesterday, hour = 9, minutes = 30, score = 80, status = 'COMPLETED' } = {}) {
  const startedAt = new Date(localDayStartUtc(dateStr, 'UTC').getTime() + hour * 3600_000);
  return Session.create({
    userId: user._id, categoryId: 'work', customName: 'Secret project name', status,
    timerMode: 'COUNTDOWN', plannedDurationSec: minutes * 60, actualDurationSec: minutes * 60,
    focusScore: score, dateStr, timezone: 'UTC', startedAt,
    endedAt: new Date(startedAt.getTime() + minutes * 60_000),
  });
}

async function seedDistraction(user, session, appName = 'Instagram', event = 'APP_BLOCKED') {
  return FocusLog.create({
    userId: user._id, sessionId: session._id, event,
    timestamp: new Date(session.startedAt.getTime() + 60_000), metadata: { appName },
  });
}

const run = async (name, args, ctx = ctxA) => {
  const out = await executeTool(ctx, name, args);
  expect(out.ok, out.error).toBe(true);
  return out.result;
};

describe('coach tools — scoped to the authenticated user', () => {
  it('getSessionsByRange returns only the caller\'s sessions, with no ids or titles', async () => {
    await seedSession(userA, { minutes: 30 });
    await seedSession(userB, { minutes: 55 });
    await seedSession(userB, { minutes: 65 });

    const r = await run('getSessionsByRange', range);
    expect(r.totalSessions).toBe(1);
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0]).toMatchObject({ date: yesterday, focusMinutes: 30, status: 'COMPLETED' });
    const json = JSON.stringify(r);
    expect(json).not.toContain('Secret project name');
    expect(json).not.toContain(String(userA._id));
    expect(json).not.toContain('55');
  });

  it('getDailyAggregates aggregates only the caller\'s sessions', async () => {
    await seedSession(userA, { minutes: 20, score: 70 });
    await seedSession(userA, { minutes: 40, score: 90 });
    await seedSession(userA, { status: 'ABANDONED', minutes: 5 });
    await seedSession(userB, { minutes: 120 });

    const r = await run('getDailyAggregates', range);
    expect(r.totalFocusMinutes).toBe(60);
    expect(r.days).toEqual([{ date: yesterday, focusMinutes: 60, sessionsCompleted: 2, sessionsAbandoned: 1, avgFocusScore: 80 }]);
  });

  it('getHourlyAverages groups only the caller\'s completed sessions by local hour', async () => {
    await seedSession(userA, { hour: 9, minutes: 30, score: 60 });
    await seedSession(userA, { hour: 9, minutes: 50, score: 80 });
    await seedSession(userB, { hour: 21, minutes: 90 });

    const r = await run('getHourlyAverages', range);
    expect(r.completedSessions).toBe(2);
    expect(r.hours).toEqual([{ hour: 9, label: '09:00', sessions: 2, avgFocusMinutes: 40, avgFocusScore: 70 }]);
  });

  it('getHourlyAverages buckets by the user\'s timezone, not the server\'s', async () => {
    const ist = { _id: oid(), settings: { timezone: 'Europe/Istanbul' } };   // UTC+3
    await seedSession(ist, { hour: 6 });                                       // 06:00Z = 09:00 local
    const r = await run('getHourlyAverages', { from: shiftDateStr(today, -6), to: today }, toolContextFor(ist));
    expect(r.hours.map(h => h.hour)).toEqual([9]);
  });

  it('getStreak reads only the caller\'s statistics', async () => {
    await Statistics.create({ userId: userA._id, date: new Date(), dateStr: yesterday, sessionsCompleted: 1, longestStreak: 3 });
    for (let i = 1; i <= 5; i++) {
      await Statistics.create({ userId: userB._id, date: new Date(), dateStr: shiftDateStr(today, -i), sessionsCompleted: 2, longestStreak: 9 });
    }
    expect(await run('getStreak', {})).toEqual({ currentStreakDays: 1, longestStreakDays: 3 });
  });

  it('getDistractionStats counts only the caller\'s events, even for a log pointing at their session', async () => {
    const mine = await seedSession(userA);
    await seedDistraction(userA, mine, 'Instagram');
    await seedDistraction(userA, mine, 'Instagram', 'DISTRACTION');
    // A FocusLog owned by B that (corruptly) references A's session must not count.
    await seedDistraction(userB, mine, 'TikTok');
    const theirs = await seedSession(userB);
    await seedDistraction(userB, theirs, 'TikTok');

    const r = await run('getDistractionStats', range);
    expect(r).toMatchObject({
      sessionsInRange: 1, totalDistractions: 2, blockedAppAttempts: 1, otherDistractions: 1,
      sessionsWithDistractions: 1, avgDistractionsPerSession: 2,
    });
    expect(r.topApps).toEqual([{ app: 'Instagram', count: 2 }]);
    expect(JSON.stringify(r)).not.toContain('TikTok');
  });

  it('getDistractionStats excludes events that fall inside a break', async () => {
    const s = await seedSession(userA);
    s.breaks = [{ type: 'ON_DEMAND', duration: 5, startedAt: s.startedAt, endedAt: new Date(s.startedAt.getTime() + 5 * 60_000) }];
    await s.save();
    await seedDistraction(userA, s);                        // +1 min → inside the break
    const r = await run('getDistractionStats', range);
    expect(r.totalDistractions).toBe(0);
  });

  it('a model-supplied userId is rejected, not honoured', async () => {
    await seedSession(userB);
    for (const name of TOOL_NAMES) {
      const out = await executeTool(ctxA, name, { ...range, userId: String(userB._id) });
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(/Invalid arguments/);
    }
  });

  it('toolContextFor requires an authenticated user', () => {
    expect(() => toolContextFor(null)).toThrow();
    expect(() => toolContextFor({})).toThrow();
  });
});

describe('coach tools — input validation', () => {
  const cases = [
    ['missing dates', {}],
    ['missing to', { from: today }],
    ['bad format', { from: '23/11/2026', to: today }],
    ['impossible date', { from: '2026-02-30', to: '2026-03-01' }],
    ['from after to', { from: today, to: yesterday }],
    ['future range', { from: today, to: shiftDateStr(today, 10) }],
    ['range too long', { from: shiftDateStr(today, -MAX_RANGE_DAYS), to: today }],
    ['too early', { from: '1999-01-01', to: '1999-01-02' }],
    ['non-string dates', { from: 20261101, to: 20261102 }],
    ['query injection', { from: { $gte: '' }, to: today }],
    ['unknown key', { ...range, where: 'status == "ACTIVE"' }],
  ];
  for (const [label, args] of cases) {
    it(`rejects ${label}`, async () => {
      const out = await executeTool(ctxA, 'getDailyAggregates', args);
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(/Invalid arguments/);
    });
  }

  it('rejects an out-of-range limit and unknown tools', async () => {
    expect((await executeTool(ctxA, 'getSessionsByRange', { ...range, limit: 500 })).ok).toBe(false);
    expect((await executeTool(ctxA, 'getSessionsByRange', { ...range, limit: 0 })).ok).toBe(false);
    const unknown = await executeTool(ctxA, 'dropDatabase', {});
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toMatch(/Unknown tool/);
  });

  it('accepts a 92-day range ending today', async () => {
    const out = await executeTool(ctxA, 'getDailyAggregates', { from: shiftDateStr(today, -(MAX_RANGE_DAYS - 1)), to: today });
    expect(out.ok).toBe(true);
  });

  it('every tool exposes a closed JSON Schema for the model', () => {
    for (const t of TOOLS) {
      expect(t.parameters.type).toBe('object');
      expect(t.parameters.additionalProperties).toBe(false);
      expect(t.parameters.properties?.userId).toBeUndefined();
    }
  });
});

describe('coach tools — missing data', () => {
  it('returns explicit empties and nulls, never invented figures', async () => {
    expect(await run('getSessionsByRange', range)).toMatchObject({ totalSessions: 0, sessions: [] });
    expect(await run('getDailyAggregates', range)).toMatchObject({ daysWithSessions: 0, totalFocusMinutes: 0, days: [] });
    expect(await run('getHourlyAverages', range)).toMatchObject({ completedSessions: 0, hours: [] });
    expect(await run('getStreak', {})).toEqual({ currentStreakDays: 0, longestStreakDays: 0 });
    expect(await run('getDistractionStats', range)).toMatchObject({
      sessionsInRange: 0, totalDistractions: 0, avgDistractionsPerSession: null, topApps: [],
    });
  });

  it('reports a null average score when sessions have no score', async () => {
    await seedSession(userA, { score: null });
    const r = await run('getDailyAggregates', range);
    expect(r.days[0].avgFocusScore).toBeNull();
  });
});
