// End-to-end tests for the canonical FocusLog event model
// (constants/focusEvents.js): APP_BLOCKED = block enforced, DISTRACTION =
// distraction detected but not blocked; distraction total = both.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import FocusLog from '../models/FocusLog.js';
import Statistics from '../models/Statistics.js';
import {
  FOCUS_EVENTS, DISTRACTION_EVENTS, CLIENT_LOGGABLE_EVENTS, normalizeEventMetadata, eventAppKey,
} from '../constants/focusEvents.js';

const app = createApp();
let seq = 0;

async function setup() {
  const reg = await request(app).post('/api/auth/register')
    .send({ name: 'Ev', email: `events-${seq++}@example.test`, password: 'sup3rsecret' });
  const token = reg.body.accessToken;
  const cats = await request(app).get('/api/user/categories').set('Authorization', `Bearer ${token}`);
  const startedAt = new Date(Date.now() - 3600_000);
  const created = await request(app).post('/api/sessions').set('Authorization', `Bearer ${token}`)
    .send({ categoryId: cats.body[0].id, plannedDurationSec: 1500, timezone: 'UTC', startedAt: startedAt.toISOString() });
  return { token, id: created.body.id, dateStr: created.body.dateStr };
}

const log = (token, id, body) =>
  request(app).post(`/api/sessions/${id}/log`).set('Authorization', `Bearer ${token}`).send(body);
const end = (token, id, body = {}) =>
  request(app).patch(`/api/sessions/${id}/end`).set('Authorization', `Bearer ${token}`)
    .send({ status: 'COMPLETED', actualDurationSec: 1500, ...body });

describe('event constants', () => {
  it('DISTRACTION exists in the stored enum and both distraction types are client-loggable', () => {
    expect(FOCUS_EVENTS).toContain('DISTRACTION');
    expect(FOCUS_EVENTS).toContain('APP_BLOCKED');
    expect(DISTRACTION_EVENTS).toEqual(['APP_BLOCKED', 'DISTRACTION']);
    for (const e of DISTRACTION_EVENTS) expect(CLIENT_LOGGABLE_EVENTS).toContain(e);
    expect(CLIENT_LOGGABLE_EVENTS).not.toContain('SESSION_STARTED');
  });

  it('normalizeEventMetadata keeps known keys, trims, drops unknown, validates source', () => {
    expect(normalizeEventMetadata(undefined)).toEqual({ metadata: {} });
    expect(normalizeEventMetadata({ appName: '  Instagram ', extra: 'x', packageName: '' }))
      .toEqual({ metadata: { appName: 'Instagram' } });
    expect(normalizeEventMetadata({ source: 'shield' }).metadata.source).toBe('shield');
    expect(normalizeEventMetadata({ source: 'telepathy' }).error).toMatch(/source/);
    expect(normalizeEventMetadata({ appName: 5 }).error).toMatch(/appName/);
    expect(normalizeEventMetadata([1]).error).toMatch(/object/);
  });

  it('eventAppKey prefers the bundle id', () => {
    expect(eventAppKey({ metadata: { packageName: 'com.a', appName: 'A' } })).toBe('com.a');
    expect(eventAppKey({ metadata: { appName: 'A' } })).toBe('A');
    expect(eventAppKey({})).toBe(null);
  });
});

describe('POST /api/sessions/:id/log', () => {
  it('accepts APP_BLOCKED and DISTRACTION with canonical metadata', async () => {
    const { token, id } = await setup();
    const a = await log(token, id, { event: 'APP_BLOCKED', metadata: { packageName: 'com.burbn.instagram', source: 'shield' } });
    const b = await log(token, id, { event: 'DISTRACTION', metadata: { appName: 'Safari', source: 'app_state', junk: 1 } });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.metadata).toMatchObject({ packageName: 'com.burbn.instagram', source: 'shield' });
    expect(b.body.metadata).toMatchObject({ appName: 'Safari', source: 'app_state' });
    expect(b.body.metadata.junk).toBeUndefined();
  });

  it('rejects server-owned and unknown events with 400', async () => {
    const { token, id } = await setup();
    expect((await log(token, id, { event: 'SESSION_STARTED' })).status).toBe(400);
    expect((await log(token, id, { event: 'NFC_VERIFIED' })).status).toBe(400);
    expect((await log(token, id, { event: 'DISTRACTED' })).status).toBe(400);
    expect((await log(token, id, {})).status).toBe(400);
  });

  it('rejects bad metadata with 400', async () => {
    const { token, id } = await setup();
    expect((await log(token, id, { event: 'DISTRACTION', metadata: { source: 'nope' } })).status).toBe(400);
    expect((await log(token, id, { event: 'DISTRACTION', metadata: 'str' })).status).toBe(400);
  });

  it('rejects events on a session that already ended (409)', async () => {
    const { token, id } = await setup();
    await end(token, id);
    expect((await log(token, id, { event: 'DISTRACTION' })).status).toBe(409);
  });

  it('keeps a client timestamp inside the session window, else stamps server time', async () => {
    const { token, id } = await setup();
    const inside = new Date(Date.now() - 10 * 60_000).toISOString();
    const r1 = await log(token, id, { event: 'DISTRACTION', timestamp: inside });
    expect(r1.body.timestamp).toBe(inside);
    const r2 = await log(token, id, { event: 'DISTRACTION', timestamp: '1999-01-01T00:00:00Z' });
    expect(new Date(r2.body.timestamp).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect((await log(token, id, { event: 'DISTRACTION', timestamp: 'garbage' })).status).toBe(400);
  });
});

describe('consumers', () => {
  it('scoring counts APP_BLOCKED + DISTRACTION and /end returns the count', async () => {
    const { token, id } = await setup();
    await log(token, id, { event: 'APP_BLOCKED', metadata: { packageName: 'com.a' } });
    await log(token, id, { event: 'DISTRACTION', metadata: { appName: 'B' } });
    await log(token, id, { event: 'BREAK_STARTED' });   // not a distraction

    const res = await end(token, id);
    expect(res.status).toBe(200);
    expect(res.body.distractionCount).toBe(2);
    // 25/25 → 80 + 12 − 2×4 = 84
    expect(res.body.session.focusScore).toBe(84);
  });

  it('Statistics.topBlockedApp counts enforced blocks only', async () => {
    const { token, id, dateStr } = await setup();
    await log(token, id, { event: 'APP_BLOCKED', metadata: { packageName: 'com.blocked' } });
    for (let i = 0; i < 3; i++) await log(token, id, { event: 'DISTRACTION', metadata: { packageName: 'com.unblocked' } });
    await end(token, id);

    const stat = await Statistics.findOne({ dateStr });
    expect(stat.topBlockedApp).toBe('com.blocked');
  });

  it('NFC_VERIFIED keeps the tag uid (previously dropped by the schema)', async () => {
    const { token, id } = await setup();
    await end(token, id, { nfcTagUid: '04:A2:B3' });
    const nfc = await FocusLog.findOne({ sessionId: id, event: 'NFC_VERIFIED' });
    expect(nfc.metadata.tagUid).toBe('04:A2:B3');
  });
});
