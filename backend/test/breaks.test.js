// Custom Breaks (COUNTDOWN / STOPWATCH): plan validation, break endpoints,
// allowance, clamping, and how breaks affect focus time, score and stats.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import Session from '../models/Session.js';

const app = createApp();
let seq = 0;

async function user() {
  const reg = await request(app).post('/api/auth/register')
    .send({ name: 'Breaks', email: `breaks-${seq++}@example.test`, password: 'sup3rsecret' });
  const token = reg.body.accessToken;
  const cats = await request(app).get('/api/user/categories').set('Authorization', `Bearer ${token}`);
  return { token, categoryId: cats.body[0].id };
}
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const minsAgo = (m) => new Date(Date.now() - m * 60_000);

const PLAN = {
  planned:   [{ startAfter: 45, duration: 10 }],
  allowance: { maxBreaks: 2, maxMinutes: 20 },
};

async function create(token, categoryId, { breakPlan = PLAN, timerMode = 'COUNTDOWN', startedAt = minsAgo(60), plannedDurationSec = 7200 } = {}) {
  return request(app).post('/api/sessions').set(auth(token)).send({
    categoryId, timerMode, plannedDurationSec, timezone: 'UTC',
    startedAt: startedAt.toISOString(),
    timerConfig: breakPlan === null ? {} : { breakPlan },
  });
}
const startBreak = (token, id, body) =>
  request(app).post(`/api/sessions/${id}/breaks/start`).set(auth(token)).send(body);
const endBreak = (token, id, body = {}) =>
  request(app).post(`/api/sessions/${id}/breaks/end`).set(auth(token)).send(body);

describe('break plan validation (POST /api/sessions)', () => {
  it('stores a valid plan and exposes it on the record', async () => {
    const { token, categoryId } = await user();
    const res = await create(token, categoryId);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      breakPlan: { ...PLAN, unlockAppsDuringBreak: false },
      breaks: [], activeBreak: null, breaksTaken: 0, breakMinutes: 0,
      allowanceRemaining: { breaks: 2, minutes: 20 },
    });
  });

  it('rejects a plan on a POMODORO session', async () => {
    const { token, categoryId } = await user();
    const res = await create(token, categoryId, { timerMode: 'POMODORO' });
    expect(res.status).toBe(400);
  });

  it.each([
    ['startAfter at/after the planned end', { planned: [{ startAfter: 120, duration: 5 }] }],
    ['unsorted planned breaks',            { planned: [{ startAfter: 50, duration: 5 }, { startAfter: 20, duration: 5 }] }],
    ['duplicate startAfter',               { planned: [{ startAfter: 20, duration: 5 }, { startAfter: 20, duration: 5 }] }],
    ['break longer than 60 min',           { planned: [{ startAfter: 20, duration: 61 }] }],
    ['more than 10 planned breaks',        { planned: Array.from({ length: 11 }, (_, i) => ({ startAfter: i + 1, duration: 1 })) }],
    ['maxBreaks out of range',             { allowance: { maxBreaks: 11 } }],
    ['maxMinutes out of range',            { allowance: { maxMinutes: 181 } }],
    ['empty allowance',                    { allowance: {} }],
    ['non-boolean unlock flag',            { unlockAppsDuringBreak: 'yes' }],
  ])('rejects %s', async (_label, breakPlan) => {
    const { token, categoryId } = await user();
    const res = await create(token, categoryId, { breakPlan });
    expect(res.status).toBe(400);
  });

  it('a session without a plan behaves as before', async () => {
    const { token, categoryId } = await user();
    const created = await create(token, categoryId, { breakPlan: null });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ breakPlan: null, allowanceRemaining: null, breaks: [] });
    const brk = await startBreak(token, created.body.id, { type: 'ON_DEMAND', duration: 5 });
    expect(brk.status).toBe(400);
    const ended = await request(app).patch(`/api/sessions/${created.body.id}/end`).set(auth(token))
      .send({ status: 'COMPLETED', actualDurationSec: 1800 });
    expect(ended.body.session).toMatchObject({ actualDurationSec: 1800, breakMinutes: 0, breaksTaken: 0 });
  });
});

describe('break endpoints', () => {
  it('start → end cycle records the break and logs both events', async () => {
    const { token, categoryId } = await user();
    const { body: s } = await create(token, categoryId);

    const started = await startBreak(token, s.id, { type: 'PLANNED', plannedIndex: 0 });
    expect(started.status).toBe(200);
    expect(started.body.activeBreak).toMatchObject({ type: 'PLANNED', plannedIndex: 0, duration: 10, endedAtISO: null });

    const ended = await endBreak(token, s.id);
    expect(ended.status).toBe(200);
    expect(ended.body.activeBreak).toBeNull();
    expect(ended.body.breaks[0]).toMatchObject({ endedEarly: true });
    expect(ended.body.breaks[0].endedAtISO).toBeTruthy();

    const logs = await request(app).get(`/api/sessions/${s.id}/logs`).set(auth(token));
    const brkLogs = logs.body.filter(l => l.event.startsWith('BREAK_'));
    expect(brkLogs.map(l => l.event)).toEqual(['BREAK_STARTED', 'BREAK_ENDED']);
    expect(brkLogs[0].metadata).toMatchObject({ breakType: 'PLANNED', breakIndex: 0 });
    expect(brkLogs[1].metadata).toMatchObject({ reason: 'EARLY' });
  });

  it('409 when a break is already open, and when there is none to end', async () => {
    const { token, categoryId } = await user();
    const { body: s } = await create(token, categoryId);
    expect((await endBreak(token, s.id)).body.code).toBe('NO_OPEN_BREAK');

    expect((await startBreak(token, s.id, { type: 'ON_DEMAND', duration: 5 })).status).toBe(200);
    const again = await startBreak(token, s.id, { type: 'ON_DEMAND', duration: 5 });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('BREAK_ALREADY_OPEN');
  });

  it('a planned break can only be taken once, and not before it is due', async () => {
    const { token, categoryId } = await user();
    const early = await create(token, categoryId, { startedAt: minsAgo(5) });
    const notDue = await startBreak(token, early.body.id, { type: 'PLANNED', plannedIndex: 0 });
    expect(notDue.status).toBe(409);
    expect(notDue.body.code).toBe('PLANNED_BREAK_NOT_DUE');

    const { body: s } = await create(token, categoryId);
    await startBreak(token, s.id, { type: 'PLANNED', plannedIndex: 0 });
    await endBreak(token, s.id);
    const twice = await startBreak(token, s.id, { type: 'PLANNED', plannedIndex: 0 });
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('PLANNED_BREAK_TAKEN');
  });

  it('enforces the on-demand allowance by count', async () => {
    const { token, categoryId } = await user();
    const { body: s } = await create(token, categoryId, { breakPlan: { allowance: { maxBreaks: 1 } } });
    await startBreak(token, s.id, { type: 'ON_DEMAND', duration: 5 });
    const ended = await endBreak(token, s.id);
    expect(ended.body.allowanceRemaining).toEqual({ breaks: 0, minutes: null });
    const over = await startBreak(token, s.id, { type: 'ON_DEMAND', duration: 5 });
    expect(over.status).toBe(403);
    expect(over.body.code).toBe('ALLOWANCE_EXCEEDED');
  });

  it('enforces the on-demand allowance by minutes, charged at the requested length', async () => {
    const { token, categoryId } = await user();
    const { body: s } = await create(token, categoryId, { breakPlan: { allowance: { maxMinutes: 15 } } });
    await startBreak(token, s.id, { type: 'ON_DEMAND', duration: 10 });
    await endBreak(token, s.id);                         // ended early: no refund
    expect((await startBreak(token, s.id, { type: 'ON_DEMAND', duration: 10 })).status).toBe(403);
    expect((await startBreak(token, s.id, { type: 'ON_DEMAND', duration: 5 })).status).toBe(200);
  });

  it('no allowance means on-demand breaks are off', async () => {
    const { token, categoryId } = await user();
    const { body: s } = await create(token, categoryId, { breakPlan: { planned: [{ startAfter: 30, duration: 5 }] } });
    expect(s.allowanceRemaining).toEqual({ breaks: 0, minutes: 0 });
    expect((await startBreak(token, s.id, { type: 'ON_DEMAND', duration: 5 })).status).toBe(403);
  });

  it('clamps a late break end to the break length', async () => {
    const { token, categoryId } = await user();
    const { body: s } = await create(token, categoryId);
    await startBreak(token, s.id, { type: 'ON_DEMAND', duration: 5 });
    const startedAt = minsAgo(20);
    await Session.updateOne({ _id: s.id }, { $set: { 'breaks.0.startedAt': startedAt } });

    const ended = await endBreak(token, s.id);
    expect(ended.body.breaks[0].endedEarly).toBe(false);
    expect(new Date(ended.body.breaks[0].endedAtISO).getTime()).toBe(startedAt.getTime() + 5 * 60_000);
  });

  it('auto-closes an elapsed break so the next one can start', async () => {
    const { token, categoryId } = await user();
    const { body: s } = await create(token, categoryId);
    await startBreak(token, s.id, { type: 'ON_DEMAND', duration: 5 });
    await Session.updateOne({ _id: s.id }, { $set: { 'breaks.0.startedAt': minsAgo(20) } });
    const next = await startBreak(token, s.id, { type: 'PLANNED', plannedIndex: 0 });
    expect(next.status).toBe(200);
    expect(next.body.breaks).toHaveLength(2);
    expect(next.body.breaks[0].endedAtISO).toBeTruthy();
  });

  it('rejects client-logged BREAK_* events on non-Pomodoro sessions', async () => {
    const { token, categoryId } = await user();
    const { body: s } = await create(token, categoryId);
    const res = await request(app).post(`/api/sessions/${s.id}/log`).set(auth(token))
      .send({ event: 'BREAK_STARTED' });
    expect(res.status).toBe(400);
  });
});

describe('breaks at session end', () => {
  it('auto-closes an open break and keeps break time out of focus time', async () => {
    const { token, categoryId } = await user();
    const { body: s } = await create(token, categoryId);    // started 60 min ago
    await startBreak(token, s.id, { type: 'ON_DEMAND', duration: 10 });
    await Session.updateOne({ _id: s.id }, { $set: { 'breaks.0.startedAt': minsAgo(30) } });

    const ended = await request(app).patch(`/api/sessions/${s.id}/end`).set(auth(token))
      .send({ status: 'COMPLETED', actualDurationSec: 3600 });   // claims the whole hour
    expect(ended.status).toBe(200);
    // wall ≈ 3600s − 600s break, + 60s skew tolerance
    expect(ended.body.session.actualDurationSec).toBeLessThanOrEqual(3000 + 60 + 2);
    expect(ended.body.session.actualDurationSec).toBeGreaterThanOrEqual(3000 + 60 - 2);
    expect(ended.body.session).toMatchObject({ breakMinutes: 10, breaksTaken: 1, activeBreak: null });

    const doc = await Session.findById(s.id).lean();
    expect(doc.breakDurationSec).toBe(600);
    expect(doc.timerState.breaks).toBe(1);

    const logs = await request(app).get(`/api/sessions/${s.id}/logs`).set(auth(token));
    expect(logs.body.find(l => l.event === 'BREAK_ENDED').metadata.reason).toBe('ELAPSED');
  });

  it('does not count distractions during a break toward score or top blocked app', async () => {
    const { token, categoryId } = await user();
    const { body: s } = await create(token, categoryId);
    const log = (packageName, ts) => request(app).post(`/api/sessions/${s.id}/log`).set(auth(token))
      .send({ event: 'APP_BLOCKED', metadata: { packageName }, timestamp: ts.toISOString() });

    await startBreak(token, s.id, { type: 'ON_DEMAND', duration: 10 });
    await Session.updateOne({ _id: s.id }, { $set: { 'breaks.0.startedAt': minsAgo(5) } });

    await log('com.focus.app', minsAgo(30));   // during focus
    await log('com.break.app', minsAgo(3));    // during the break
    await log('com.break.app', minsAgo(2));    // during the break

    const ended = await request(app).patch(`/api/sessions/${s.id}/end`).set(auth(token))
      .send({ status: 'COMPLETED', actualDurationSec: 3000 });
    expect(ended.body.distractionCount).toBe(1);

    const stats = await request(app)
      .get(`/api/analytics/statistics?from=${s.dateStr}&to=${s.dateStr}`).set(auth(token));
    expect(stats.body[0].topBlockedApp).toBe('com.focus.app');
  });
});
