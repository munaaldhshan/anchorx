import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

// The real LLM layer runs; only the network is faked. No provider env → the
// rule-based fallback answers; LLM_API_KEY + stubbed fetch → the "LLM" answers.
import { createApp } from '../app.js';
import AIInsight from '../models/AIInsight.js';
import Session from '../models/Session.js';
import User from '../models/User.js';
import { resetLimiters } from '../llm/rateLimiter.js';
import { invalidateSuggestion } from '../services/aiSuggestionService.js';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const app = createApp();

let seq = 0;
async function makeUser() {
  const reg = await request(app).post('/api/auth/register')
    .send({ name: 'AI User', email: `ai-${seq++}@example.test`, password: 'sup3rsecret' });
  return { token: reg.body.accessToken, userId: reg.body.user.id };
}

// Create N completed 25-minute sessions so buildUserProfile has enough data.
async function seedCompleted(token, n) {
  const cats = await request(app).get('/api/user/categories')
    .set('Authorization', `Bearer ${token}`);
  const categoryId = cats.body[0].id;
  for (let i = 0; i < n; i++) {
    const startedAt = new Date(Date.now() - (2 + i) * 3600_000);
    const created = await request(app).post('/api/sessions')
      .set('Authorization', `Bearer ${token}`)
      .send({ categoryId, timerMode: 'COUNTDOWN', plannedDurationSec: 1500,
              timezone: 'UTC', startedAt: startedAt.toISOString() });
    await request(app).patch(`/api/sessions/${created.body.id}/end`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'COMPLETED', actualDurationSec: 1500,
              endedAt: new Date(startedAt.getTime() + 1500_000).toISOString() });
  }
}

const VALID_AI = {
  bestProductiveHour: 9,
  optimalDuration:    30,
  suggestedSchedule:  ['Monday', 'Tuesday', 'Monday'].map(day => ({
    day, startHour: 9, durationMinutes: 30, confidence: 0.8, categoryName: 'Work',
  })),
  distractionRisk: { score: 20, level: 'low', factors: ['evening scrolling'] },
  insightText:     'You focus best in the morning — protect your 9am block.',
};

const openaiOk = (obj) => ({
  ok: true, status: 200, headers: { get: () => null },
  json: async () => ({ choices: [{ message: { content: JSON.stringify(obj) } }], usage: {} }),
});

beforeEach(() => {
  fetchMock.mockReset();
  resetLimiters();
  for (const k of ['LLM_API_KEY', 'LLM_PROVIDER', 'LLM_FALLBACKS', 'GEMINI_API_KEY']) delete process.env[k];
});

const configureLLM = (reply) => {
  process.env.LLM_API_KEY = 'test-pat';
  fetchMock.mockResolvedValue(openaiOk(reply));
};

describe('GET /api/ai/insights', () => {
  it('returns a fresh (<6h) cached insight without calling the LLM', async () => {
    configureLLM(VALID_AI);
    const { token, userId } = await makeUser();
    await AIInsight.create({ userId, insightText: 'fresh', bestProductiveHour: 8, generatedAt: new Date() });

    const res = await request(app).get('/api/ai/insights').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(true);
    expect(res.body.insight.insightText).toBe('fresh');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('regenerates a rule-based insight after 30 min (sooner than an LLM one)', async () => {
    configureLLM(VALID_AI);
    const { token, userId } = await makeUser();
    await seedCompleted(token, 3);
    await AIInsight.create({
      userId, insightText: 'estimate', source: 'fallback',
      generatedAt: new Date(Date.now() - 45 * 60_000),
    });

    const res = await request(app).get('/api/ai/insights').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(false);
    expect(res.body.insight.source).toBe('llm');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('falls back to a stale insight when there is not enough data to regenerate', async () => {
    const { token, userId } = await makeUser();
    await AIInsight.create({
      userId, insightText: 'old', bestProductiveHour: 8,
      generatedAt: new Date(Date.now() - 7 * 3600 * 1000),   // 7h → stale
    });

    const res = await request(app).get('/api/ai/insights').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.stale).toBe(true);
    expect(res.body.insight.insightText).toBe('old');
  });

  it('reports progress when there is no insight and not enough data', async () => {
    const { token } = await makeUser();
    const res = await request(app).get('/api/ai/insights').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.insight).toBe(null);
    expect(res.body.needsMoreData).toBe(true);
    expect(res.body.sessionCount).toBe(0);
    expect(res.body.sessionsNeeded).toBe(3);
  });

  it('serves a rule-based insight (source: fallback) when no LLM is configured', async () => {
    const { token } = await makeUser();
    await seedCompleted(token, 3);

    const res = await request(app).get('/api/ai/insights').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.body.insight).toMatchObject({
      source: 'fallback', modelVersion: 'rule-based', optimalDuration: 25, trainingSize: 3,
    });
    expect(['Low', 'Medium', 'High']).toContain(res.body.insight.distractionRisk.level);
    expect(res.body.insight.suggestedSchedule.length).toBeGreaterThanOrEqual(2);
  });
});

describe('POST /api/ai/insights/generate', () => {
  it('force-generates and persists an LLM insight from session data', async () => {
    configureLLM(VALID_AI);
    const { token } = await makeUser();
    await seedCompleted(token, 3);

    const res = await request(app).post('/api/ai/insights/generate')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(res.body.insight).toMatchObject({
      bestProductiveHour: 9, source: 'llm', provider: 'openai', modelVersion: 'openai/gpt-4.1-mini',
    });
    expect(res.body.insight.distractionRisk.level).toBe('Low');
    // Duplicate "Monday" collapsed.
    expect(res.body.insight.suggestedSchedule.map(s => s.day)).toEqual(['Monday', 'Tuesday']);
  });

  it('uses the rule-based backup when the provider keeps failing', async () => {
    process.env.LLM_API_KEY = 'test-pat';
    process.env.LLM_MAX_RETRIES = '0';
    fetchMock.mockResolvedValue({ ok: false, status: 503, headers: { get: () => null }, json: async () => ({}) });
    const { token } = await makeUser();
    await seedCompleted(token, 3);

    const res = await request(app).post('/api/ai/insights/generate')
      .set('Authorization', `Bearer ${token}`);
    delete process.env.LLM_MAX_RETRIES;
    expect(res.status).toBe(200);
    expect(res.body.insight.source).toBe('fallback');
  });

  it('returns 400 with sessionCount when there is not enough data', async () => {
    const { token } = await makeUser();
    await seedCompleted(token, 1);   // below the 3-session minimum
    const res = await request(app).post('/api/ai/insights/generate')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NOT_ENOUGH_DATA');
    expect(res.body.sessionCount).toBe(1);
  });

  it('buckets hours/weekdays in the user\'s timezone, not the server\'s', async () => {
    // No LLM → the rule-based answer exposes the profile's best hour directly.
    const { token, userId } = await makeUser();
    await User.updateOne({ _id: userId }, { $set: { 'settings.timezone': 'Asia/Tokyo' } });
    const user = await User.findById(userId);
    // 15:30 UTC = 00:30 next day in Tokyo (+9).
    const base = Date.UTC(2026, 5, 1, 15, 30);
    await Session.insertMany([0, 1, 2].map(i => ({
      userId, categoryId: user.categories[0].id, status: 'COMPLETED',
      plannedDurationSec: 1500, actualDurationSec: 1500,
      dateStr: '2026-06-02', startedAt: new Date(base - i * 86_400_000),
      endedAt: new Date(base - i * 86_400_000 + 1_500_000),
    })));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-03T00:00:00Z'));
    try {
      const res = await request(app).post('/api/ai/insights/generate')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.insight.bestProductiveHour).toBe(0);          // Tokyo hour, not 15
      // Mon 1 Jun 15:30Z is Tue 2 Jun 00:30 in Tokyo → Tuesday is among the days.
      expect(res.body.insight.suggestedSchedule.map(s => s.day)).toContain('Tuesday');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('GET /api/ai/suggestion', () => {
  it('returns an LLM tip when there is enough recent data', async () => {
    configureLLM({ tip: 'Try a 25-minute morning block before email.' });
    const { token, userId } = await makeUser();
    invalidateSuggestion(userId);
    await seedCompleted(token, 3);

    const res = await request(app).get('/api/ai/suggestion').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ suggestion: 'Try a 25-minute morning block before email.', source: 'llm' });
  });

  it('returns a rule-based tip when no LLM is configured', async () => {
    const { token } = await makeUser();
    await seedCompleted(token, 3);

    const res = await request(app).get('/api/ai/suggestion').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('fallback');
    expect(res.body.suggestion.length).toBeGreaterThan(10);
  });

  it('returns 204 when there is not enough data', async () => {
    const { token } = await makeUser();
    const res = await request(app).get('/api/ai/suggestion').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(204);
  });
});
