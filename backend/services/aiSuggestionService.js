import { z } from 'zod';
import Session, { actualSecOf, plannedSecOf } from '../models/Session.js';
import User from '../models/User.js';
import { generate, defineTask } from '../llm/index.js';
import {
  resolveTimezone, userTodayStr, shiftDateStr, localDayStartUtc, localHourOf,
} from '../utils/datetime.js';

const CACHE_TTL_MS          = 30 * 60 * 1000; // 30 minutes
const FALLBACK_CACHE_TTL_MS = 10 * 60 * 1000; // retry the LLM sooner after a fallback
const cache = new Map(); // userId -> { suggestion, source, expiresAt }

const MIN_SESSIONS = 3;
const WINDOW_DAYS  = 7;

export function invalidateSuggestion(userId) {
  cache.delete(String(userId));
}

const fmtHour = (h) => `${String(h).padStart(2, '0')}:00`;

// ─── Structured-output task ──────────────────────────────────────────────────
const TipSchema = z.object({ tip: z.string().min(10).max(280) });

/** Deterministic tip from the same stats the LLM sees. */
export function ruleBasedTip(stats) {
  const best = stats?.bestHour ?? 9;
  const now  = stats?.currentHour ?? best;
  const len  = Math.max(15, Math.round((stats?.avgMinutes || 25) / 5) * 5);

  let tip;
  if (Math.abs(now - best) <= 1) {
    tip = `This is your peak focus hour — start a ${len}-minute session now while it's on your side.`;
  } else if ((stats?.avgScore ?? 100) < 60) {
    tip = `Try a shorter ${Math.max(15, len - 10)}-minute block with apps blocked to rebuild momentum.`;
  } else {
    tip = `You focus best around ${fmtHour(best)}. Block out ${len} minutes then for your hardest task.`;
  }
  return { tip };
}

export const FOCUS_TIP_TASK = defineTask({
  name:        'focus_tip',
  schema:      TipSchema,
  temperature: 0.4,
  maxTokens:   512,
  tier:        'fast',        // Gemini 3.5 Flash-Lite → GitHub gpt-4.1-mini
  fallback:    ruleBasedTip,
  safeDefault: { tip: 'Pick one task, block distracting apps, and start a 25-minute session.' },
});

function buildSuggestionMessages(stats) {
  return [
    {
      role: 'system',
      content: 'You are a friendly productivity coach. Reply with a JSON object {"tip": string}: ONE short, '
             + 'actionable tip (1-2 sentences, under 280 characters) for the next focus session. '
             + 'Be encouraging and specific. No greetings, no markdown.',
    },
    {
      role: 'user',
      content: `Recent stats:
- Sessions in last 7 days: ${stats.recentSessions}
- Average session length: ${stats.avgMinutes} minutes
- Average focus score: ${stats.avgScore}/100
- Best hour of day: ${fmtHour(stats.bestHour)}
- Current hour: ${fmtHour(stats.currentHour)}`,
    },
  ];
}

async function buildLightStats(userId) {
  const user = await User.findById(userId, 'settings.timezone').lean();
  const tz = resolveTimezone(user);
  const since = localDayStartUtc(shiftDateStr(userTodayStr(tz), -(WINDOW_DAYS - 1)), tz);

  const sessions = await Session.find({
    userId,
    status: 'COMPLETED',
    startedAt: { $gte: since },
  }).lean();

  if (sessions.length < MIN_SESSIONS) {
    return { enoughData: false, sessionCount: sessions.length };
  }

  let totalMinutes = 0;
  let totalScore = 0;
  let scoreCount = 0;
  const hourly = Array(24).fill(0);

  for (const s of sessions) {
    const mins = Math.round((actualSecOf(s) ?? plannedSecOf(s) ?? 0) / 60);
    totalMinutes += mins;
    if (typeof s.focusScore === 'number') {
      totalScore += s.focusScore;
      scoreCount++;
    }
    hourly[localHourOf(s.startedAt, tz)] += mins;
  }

  let bestHour = 9;
  let bestMins = 0;
  for (let h = 0; h < 24; h++) {
    if (hourly[h] > bestMins) {
      bestMins = hourly[h];
      bestHour = h;
    }
  }

  return {
    enoughData: true,
    recentSessions: sessions.length,
    avgMinutes: Math.round(totalMinutes / sessions.length),
    avgScore: scoreCount > 0 ? Math.round(totalScore / scoreCount) : 0,
    bestHour,
    currentHour: localHourOf(new Date(), tz),
  };
}

export async function getSuggestion(userId) {
  const key = String(userId);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { suggestion: cached.suggestion, source: cached.source, cached: true };
  }

  const stats = await buildLightStats(userId);
  if (!stats.enoughData) {
    const err = new Error(`Need at least ${MIN_SESSIONS} sessions (have ${stats.sessionCount})`);
    err.code = 'NOT_ENOUGH_DATA';
    err.sessionCount = stats.sessionCount;
    throw err;
  }

  const { data, meta } = await generate(buildSuggestionMessages(stats), FOCUS_TIP_TASK, { context: stats, userId });
  const suggestion = data.tip.trim().replace(/^["']|["']$/g, '');

  cache.set(key, {
    suggestion,
    source: meta.source,
    expiresAt: Date.now() + (meta.source === 'fallback' ? FALLBACK_CACHE_TTL_MS : CACHE_TTL_MS),
  });

  return { suggestion, source: meta.source, cached: false };
}
