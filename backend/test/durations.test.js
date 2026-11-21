// Planned vs actual duration (seconds) — API behaviour and the 001 backfill.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { createApp } from '../app.js';
import Session, { plannedSecOf, actualSecOf } from '../models/Session.js';
import { runMigrations } from '../migrations/index.js';
import { up as backfill } from '../migrations/001-session-duration-seconds.js';

const app = createApp();
let seq = 0;

async function user() {
  const reg = await request(app).post('/api/auth/register')
    .send({ name: 'Dur', email: `dur-${seq++}@example.test`, password: 'sup3rsecret' });
  const token = reg.body.accessToken;
  const cats = await request(app).get('/api/user/categories').set('Authorization', `Bearer ${token}`);
  return { token, userId: reg.body.user.id, categoryId: cats.body[0].id };
}
const auth = (t) => ({ Authorization: `Bearer ${t}` });

describe('API: planned/actual duration in seconds', () => {
  it('stores plannedDurationSec at create and actualDurationSec at end', async () => {
    const { token, categoryId } = await user();
    const startedAt = new Date(Date.now() - 3600_000);
    const created = await request(app).post('/api/sessions').set(auth(token))
      .send({ categoryId, plannedDurationSec: 1500, timezone: 'UTC', startedAt: startedAt.toISOString() });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ plannedDurationSec: 1500, actualDurationSec: null, plannedDuration: 25, duration: 25 });

    const ended = await request(app).patch(`/api/sessions/${created.body.id}/end`).set(auth(token))
      .send({ status: 'COMPLETED', actualDurationSec: 1234, endedAt: new Date(startedAt.getTime() + 1800_000).toISOString() });
    expect(ended.body.session).toMatchObject({ plannedDurationSec: 1500, actualDurationSec: 1234, duration: 21 });

    const doc = await Session.findById(created.body.id).lean();
    expect(doc.actualDurationSec).toBe(1234);
    // Legacy minute fields are dual-written for rollback safety.
    expect(doc.timerConfig.plannedDuration).toBe(25);
    expect(doc.timerState.actualDuration).toBe(21);
  });

  it('bounds reported focus time by wall-clock time (endedAt − startedAt)', async () => {
    const { token, categoryId } = await user();
    const startedAt = new Date(Date.now() - 3600_000);
    const created = await request(app).post('/api/sessions').set(auth(token))
      .send({ categoryId, plannedDurationSec: 1500, startedAt: startedAt.toISOString() });
    const ended = await request(app).patch(`/api/sessions/${created.body.id}/end`).set(auth(token))
      .send({ status: 'COMPLETED', actualDurationSec: 7200,                 // claims 2h…
              endedAt: new Date(startedAt.getTime() + 600_000).toISOString() }); // …in 10 min
    expect(ended.body.session.actualDurationSec).toBe(600 + 60);          // wall + skew tolerance
  });

  it('derives actual from timestamps when the client reports none', async () => {
    const { token, categoryId } = await user();
    const startedAt = new Date(Date.now() - 3600_000);
    const created = await request(app).post('/api/sessions').set(auth(token))
      .send({ categoryId, plannedDurationSec: 1500, startedAt: startedAt.toISOString() });
    const ended = await request(app).patch(`/api/sessions/${created.body.id}/end`).set(auth(token))
      .send({ status: 'ABANDONED', endedAt: new Date(startedAt.getTime() + 437_000).toISOString() });
    expect(ended.body.session.actualDurationSec).toBe(437);
  });

  it('still accepts the legacy minute fields from older app builds', async () => {
    const { token, categoryId } = await user();
    const startedAt = new Date(Date.now() - 3600_000);
    const created = await request(app).post('/api/sessions').set(auth(token))
      .send({ categoryId, timerConfig: { plannedDuration: 30 }, dateStr: new Date().toISOString().slice(0, 10),
              startedAt: startedAt.toISOString() });
    expect(created.body.plannedDurationSec).toBe(1800);
    const ended = await request(app).patch(`/api/sessions/${created.body.id}/end`).set(auth(token))
      .send({ status: 'COMPLETED', timerState: { actualDuration: 30 } });
    expect(ended.body.session.actualDurationSec).toBe(1800);
  });

  it('rejects a missing/out-of-range planned duration and an end before start', async () => {
    const { token, categoryId } = await user();
    expect((await request(app).post('/api/sessions').set(auth(token)).send({ categoryId })).status).toBe(400);
    expect((await request(app).post('/api/sessions').set(auth(token)).send({ categoryId, plannedDurationSec: 30 })).status).toBe(400);
    expect((await request(app).post('/api/sessions').set(auth(token)).send({ categoryId, plannedDurationSec: 1500, startedAt: 'nope' })).status).toBe(400);

    const created = await request(app).post('/api/sessions').set(auth(token)).send({ categoryId, plannedDurationSec: 1500 });
    const ended = await request(app).patch(`/api/sessions/${created.body.id}/end`).set(auth(token))
      .send({ status: 'COMPLETED', endedAt: '2000-01-01T00:00:00Z' });
    expect(ended.status).toBe(400);
  });
});

describe('accessors', () => {
  it('prefer seconds fields and fall back to legacy minutes', () => {
    expect(plannedSecOf({ plannedDurationSec: 90, timerConfig: { plannedDuration: 5 } })).toBe(90);
    expect(plannedSecOf({ timerConfig: { plannedDuration: 5 } })).toBe(300);
    expect(plannedSecOf({})).toBe(null);
    expect(actualSecOf({ status: 'COMPLETED', timerState: { actualDuration: 2 } })).toBe(120);
    expect(actualSecOf({ status: 'ACTIVE', timerState: { actualDuration: 0 } })).toBe(null);
    expect(actualSecOf({ status: 'ACTIVE', actualDurationSec: 0 })).toBe(0);
  });
});

describe('migration 001 backfill', () => {
  // Raw inserts bypass mongoose so rows look exactly like pre-migration data.
  async function insertLegacy(rows) {
    const userId = new mongoose.Types.ObjectId();
    const base = { userId, categoryId: 'c', dateStr: '2026-01-01', blockedApps: [] };
    const { insertedIds } = await mongoose.connection.db.collection('sessions')
      .insertMany(rows.map(r => ({ ...base, ...r })));
    return Object.values(insertedIds);
  }
  const t0 = new Date('2026-01-01T10:00:00Z');
  const at = (sec) => new Date(t0.getTime() + sec * 1000);

  it('backfills planned/actual seconds by the documented rules', async () => {
    const ids = await insertLegacy([
      // 0: completed, legacy actual present → actual × 60 (not clamped)
      { status: 'COMPLETED', timerConfig: { plannedDuration: 25 }, timerState: { actualDuration: 20 }, startedAt: t0, endedAt: at(600) },
      // 1: abandoned, legacy actual 0 → wall-clock from timestamps
      { status: 'ABANDONED', timerConfig: { plannedDuration: 45 }, timerState: { actualDuration: 0 }, startedAt: t0, endedAt: at(437.9) },
      // 2: completed, no actual and no endedAt → null
      { status: 'COMPLETED', timerConfig: { plannedDuration: 10 }, timerState: {}, startedAt: t0, endedAt: null },
      // 3: still active → actual null even with a legacy default of 0
      { status: 'ACTIVE', timerConfig: { plannedDuration: 30 }, timerState: { actualDuration: 0 }, startedAt: t0 },
      // 4: no planned at all → null
      { status: 'COMPLETED', timerState: { actualDuration: 5 }, startedAt: t0, endedAt: at(300) },
      // 5: end before start (corrupt) → null
      { status: 'COMPLETED', timerConfig: { plannedDuration: 5 }, timerState: {}, startedAt: t0, endedAt: at(-60) },
    ]);

    const result = await backfill(mongoose.connection.db);
    expect(result).toEqual({ plannedUpdated: 6, actualUpdated: 6 });

    const docs = await mongoose.connection.db.collection('sessions').find({ _id: { $in: ids } }).toArray();
    const byId = Object.fromEntries(docs.map(d => [String(d._id), d]));
    const row = (i) => byId[String(ids[i])];
    expect([0, 1, 2, 3, 4, 5].map(i => [row(i).plannedDurationSec, row(i).actualDurationSec])).toEqual([
      [1500, 1200],
      [2700, 437],
      [600, null],
      [1800, null],
      [null, 300],
      [300, null],
    ]);
    // Additive: legacy fields untouched.
    expect(row(0).timerState.actualDuration).toBe(20);
  });

  it('is idempotent and does not overwrite rows already on the new fields', async () => {
    const [id] = await insertLegacy([
      { status: 'COMPLETED', plannedDurationSec: 99, actualDurationSec: 42,
        timerConfig: { plannedDuration: 25 }, timerState: { actualDuration: 25 }, startedAt: t0, endedAt: at(1500) },
    ]);
    await backfill(mongoose.connection.db);
    const second = await backfill(mongoose.connection.db);
    expect(second).toEqual({ plannedUpdated: 0, actualUpdated: 0 });
    const doc = await mongoose.connection.db.collection('sessions').findOne({ _id: id });
    expect([doc.plannedDurationSec, doc.actualDurationSec]).toEqual([99, 42]);
  });

  it('runMigrations applies each migration once and records it', async () => {
    const silent = { info() {}, warn() {}, error() {} };
    expect(await runMigrations({ log: silent })).toEqual(['001-session-duration-seconds']);
    expect(await runMigrations({ log: silent })).toEqual([]);
    const ledger = await mongoose.connection.db.collection('_migrations').find().toArray();
    expect(ledger.map(l => l._id)).toEqual(['001-session-duration-seconds']);
  });

  it('migrated legacy rows read the same through the API as before', async () => {
    const { token, userId, categoryId } = await user();
    await mongoose.connection.db.collection('sessions').insertOne({
      userId: new mongoose.Types.ObjectId(userId), categoryId, dateStr: '2026-01-01', status: 'COMPLETED',
      timerMode: 'COUNTDOWN', timerConfig: { plannedDuration: 25 }, timerState: { actualDuration: 20 },
      startedAt: t0, endedAt: at(1200), blockedApps: [],
    });
    const before = await request(app).get('/api/sessions').set(auth(token));
    await backfill(mongoose.connection.db);
    const after = await request(app).get('/api/sessions').set(auth(token));
    expect(after.body).toEqual(before.body);
    expect(after.body[0]).toMatchObject({ duration: 20, plannedDuration: 25, plannedDurationSec: 1500, actualDurationSec: 1200 });
  });
});
