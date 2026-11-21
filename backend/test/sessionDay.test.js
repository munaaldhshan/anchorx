// Which day a session counts toward — server-derived from the UTC start
// instant + timezone, so near-midnight sessions land on the right local day.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import User from '../models/User.js';
import Statistics from '../models/Statistics.js';
import { resolveSessionDay } from '../routes/sessions.js';

const app = createApp();
let seq = 0;

async function user(tz = 'UTC') {
  const reg = await request(app).post('/api/auth/register')
    .send({ name: 'Day', email: `day-${seq++}@example.test`, password: 'sup3rsecret' });
  await User.updateOne({ _id: reg.body.user.id }, { $set: { 'settings.timezone': tz } });
  const token = reg.body.accessToken;
  const cats = await request(app).get('/api/user/categories').set('Authorization', `Bearer ${token}`);
  return { token, categoryId: cats.body[0].id };
}
const start = (token, body) => request(app).post('/api/sessions')
  .set('Authorization', `Bearer ${token}`).send({ plannedDurationSec: 1500, ...body });

describe('resolveSessionDay', () => {
  const startedAt = new Date('2026-06-08T21:30:00Z');   // 00:30 on the 9th in Cairo

  it('derives the day from the client timezone when given (ignores client dateStr)', () => {
    expect(resolveSessionDay({ startedAt, clientTz: 'Africa/Cairo', clientDateStr: '2026-06-01', userTz: 'UTC' }))
      .toBe('2026-06-09');
  });

  it('legacy client: trusts its device-local dateStr when within a day of the derived one', () => {
    expect(resolveSessionDay({ startedAt, clientDateStr: '2026-06-09', userTz: 'UTC' })).toBe('2026-06-09');
  });

  it('legacy client: replaces an implausible dateStr with the derived day', () => {
    expect(resolveSessionDay({ startedAt, clientDateStr: '2025-01-01', userTz: 'Africa/Cairo' })).toBe('2026-06-09');
  });

  it('no client data: uses the user\'s settings timezone', () => {
    expect(resolveSessionDay({ startedAt, userTz: 'Africa/Cairo' })).toBe('2026-06-09');
    expect(resolveSessionDay({ startedAt, userTz: 'UTC' })).toBe('2026-06-08');
  });
});

describe('POST /api/sessions day bucketing', () => {
  it('a 00:30 Cairo session counts toward the Cairo day, not the UTC one', async () => {
    const { token, categoryId } = await user('UTC');   // settings lag the device
    const res = await start(token, { categoryId, timezone: 'Africa/Cairo', startedAt: '2026-06-08T21:30:00Z' });
    expect(res.status).toBe(201);
    expect(res.body.dateStr).toBe('2026-06-09');
  });

  it('a 23:50 New York session stays on the local day even though UTC rolled over', async () => {
    const { token, categoryId } = await user('America/New_York');
    const res = await start(token, { categoryId, startedAt: '2026-06-09T03:50:00Z' });
    expect(res.body.dateStr).toBe('2026-06-08');
    expect(res.body.startTime).toBe('23:50');
  });

  it('rejects an invalid timezone', async () => {
    const { token, categoryId } = await user();
    expect((await start(token, { categoryId, timezone: 'Not/AZone' })).status).toBe(400);
  });

  it('daily Statistics follow the local day of the session', async () => {
    const { token, categoryId } = await user('Africa/Cairo');
    const created = await start(token, { categoryId, timezone: 'Africa/Cairo', startedAt: '2026-06-08T21:30:00Z' });
    await request(app).patch(`/api/sessions/${created.body.id}/end`).set('Authorization', `Bearer ${token}`)
      .send({ status: 'COMPLETED', actualDurationSec: 1500, endedAt: '2026-06-08T21:55:00Z' });

    const onNinth  = await Statistics.findOne({ dateStr: '2026-06-09' });
    const onEighth = await Statistics.findOne({ dateStr: '2026-06-08' });
    expect(onNinth.totalFocusMinutes).toBe(25);
    expect(onNinth.mostProductiveHour).toBe(0);        // 00:xx Cairo, not 21 UTC
    expect(onEighth).toBe(null);
  });
});
