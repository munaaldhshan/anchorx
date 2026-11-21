// Per-user daily AI limit (llm/userQuota.js) against the real in-memory Mongo.
// Network is stubbed: every Gemini call returns a valid answer.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { z } from 'zod';
import { generate, defineTask } from '../llm/index.js';
import { resetLimiters } from '../llm/rateLimiter.js';
import AIUsage from '../models/AIUsage.js';

const fetchMock = vi.fn(async () => ({
  ok: true, status: 200, headers: { get: () => null },
  json: async () => ({
    candidates: [{ content: { parts: [{ text: '{"n":1}' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
  }),
}));
vi.stubGlobal('fetch', fetchMock);

const TASK = defineTask({
  name: 'quota_test',
  schema: z.object({ n: z.int() }),
  tier: 'fast',
  fallback: () => ({ n: 0 }),
  safeDefault: { n: 0 },
});
const MSGS = [{ role: 'user', content: 'n?' }];

beforeEach(async () => {
  for (const k of ['LLM_PROVIDER', 'LLM_FALLBACKS', 'LLM_API_KEY', 'LLM_RPM_GEMINI']) delete process.env[k];
  process.env.GEMINI_API_KEY = 'gk';
  process.env.LLM_RPM_GEMINI = '0';   // no per-provider limit: isolate the per-user one
  process.env.AI_DAILY_LIMIT = '2';
  fetchMock.mockClear();
  resetLimiters();
  await AIUsage.init();               // unique (userId, dateStr) index must exist
});

describe('per-user daily AI limit', () => {
  it('serves calls up to the limit, then the rule-based fallback, and tallies tokens', async () => {
    const userId = new mongoose.Types.ObjectId();
    const a = await generate(MSGS, TASK, { userId });
    const b = await generate(MSGS, TASK, { userId });
    const c = await generate(MSGS, TASK, { userId });

    expect(a.meta.source).toBe('llm');
    expect(b.meta.source).toBe('llm');
    expect(c.meta).toMatchObject({ source: 'fallback', reason: 'user_daily_limit', attempts: 0 });
    expect(c.data).toEqual({ n: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const usage = await AIUsage.findOne({ userId }).lean();
    expect(usage).toMatchObject({ calls: 2, inputTokens: 200, outputTokens: 40 });
    expect(usage.byTask).toMatchObject({ quota_test: 2 });
  });

  it('limits each user separately', async () => {
    const a = new mongoose.Types.ObjectId();
    const b = new mongoose.Types.ObjectId();
    await generate(MSGS, TASK, { userId: a });
    await generate(MSGS, TASK, { userId: a });
    expect((await generate(MSGS, TASK, { userId: b })).meta.source).toBe('llm');
  });

  it('does not count calls without a userId; AI_DAILY_LIMIT=0 means unlimited', async () => {
    for (let i = 0; i < 3; i++) await generate(MSGS, TASK);
    expect(await AIUsage.countDocuments()).toBe(0);

    process.env.AI_DAILY_LIMIT = '0';
    const userId = new mongoose.Types.ObjectId();
    for (let i = 0; i < 4; i++) expect((await generate(MSGS, TASK, { userId })).meta.source).toBe('llm');
  });
});
