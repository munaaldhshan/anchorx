import { z } from 'zod';
import Session, { actualSecOf, plannedSecOf } from '../models/Session.js';
import FocusLog from '../models/FocusLog.js';
import AIInsight from '../models/AIInsight.js';
import User from '../models/User.js';
import { generate, defineTask } from '../llm/index.js';
import { DISTRACTION_EVENTS, eventAppKey } from '../constants/focusEvents.js';
import {
  resolveTimezone, userTodayStr, shiftDateStr, localDayStartUtc, localHourOf, localWeekdayOf,
} from '../utils/datetime.js';

const CACHE_HOURS = 6;
// Rule-based answers are refreshed sooner so the LLM gets another go once the
// provider recovers.
const FALLBACK_CACHE_HOURS = 0.5;
export const MIN_SESSIONS = 3;
const WINDOW_DAYS = 30;

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** True while a stored insight is still fresh enough to serve as-is. */
export function isInsightFresh(insight, now = Date.now()) {
  if (!insight?.generatedAt) return false;
  const ageHours = (now - new Date(insight.generatedAt).getTime()) / 3_600_000;
  return ageHours < (insight.source === 'fallback' ? FALLBACK_CACHE_HOURS : CACHE_HOURS);
}

const sessionMinutes = (s) => Math.round((actualSecOf(s) ?? plannedSecOf(s) ?? 0) / 60);

const median = (xs) => {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
};

async function buildUserProfile(userId) {
  const userDoc = await User.findById(userId, 'categories settings.timezone').lean();
  const tz = resolveTimezone(userDoc);
  // Last 30 *local* days, as a UTC instant range over startedAt.
  const since = localDayStartUtc(shiftDateStr(userTodayStr(tz), -(WINDOW_DAYS - 1)), tz);

  const sessions = await Session.find({ userId, status: 'COMPLETED', startedAt: { $gte: since } }).lean();

  if (sessions.length < MIN_SESSIONS) {
    return { enoughData: false, sessionCount: sessions.length };
  }

  // Hourly distribution (0-23) and weekday split, in the user's local time.
  const hourly = Array(24).fill(0);
  const weekday = [0, 0, 0, 0, 0, 0, 0]; // Sun..Sat minutes

  // Per-category breakdown: { [categoryId]: { name, hourly[24], weekday[7] } }
  const categoryMap = {};
  for (const cat of (userDoc?.categories ?? [])) {
    categoryMap[cat.id] = { name: cat.name, hourly: Array(24).fill(0), weekday: Array(7).fill(0) };
  }

  let totalMinutes = 0;
  let totalScore = 0;
  let scoreCount = 0;
  let pomodoroCount = 0;
  let countdownCount = 0;
  const lengths = [];

  for (const s of sessions) {
    const h = localHourOf(s.startedAt, tz);
    const dow = localWeekdayOf(s.startedAt, tz);
    const mins = sessionMinutes(s);

    hourly[h] += mins;
    weekday[dow] += mins;
    totalMinutes += mins;
    lengths.push(mins);

    if (s.categoryId && categoryMap[s.categoryId]) {
      categoryMap[s.categoryId].hourly[h] += mins;
      categoryMap[s.categoryId].weekday[dow] += mins;
    }

    if (typeof s.focusScore === 'number') {
      totalScore += s.focusScore;
      scoreCount++;
    }

    if (s.timerMode === 'POMODORO') pomodoroCount++;
    else countdownCount++;
  }

  // Summarise per-category data for the prompt (only categories that have sessions)
  const categoryBreakdown = Object.values(categoryMap)
    .filter(c => c.hourly.some(m => m > 0))
    .map(c => {
      const bestHour = c.hourly.indexOf(Math.max(...c.hourly));
      const bestDay  = DAY_NAMES[c.weekday.indexOf(Math.max(...c.weekday))];
      return { name: c.name, bestHour, bestDay, totalMins: c.hourly.reduce((a, b) => a + b, 0) };
    });

  // Top distractions: enforced blocks + detected distractions (constants/focusEvents.js)
  const logs = await FocusLog.find({
    userId,
    event: { $in: DISTRACTION_EVENTS },
    timestamp: { $gte: since },
  }).lean();

  const distractionMap = {};
  for (const l of logs) {
    const app = eventAppKey(l) || 'unknown';
    distractionMap[app] = (distractionMap[app] || 0) + 1;
  }
  const topDistractions = Object.entries(distractionMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  return {
    enoughData: true,
    sessionCount: sessions.length,
    totalMinutes,
    medianMinutes: median(lengths),
    distractionCount: logs.length,
    avgScore: scoreCount > 0 ? Math.round(totalScore / scoreCount) : null,
    hourly,
    weekday,
    pomodoroCount,
    countdownCount,
    topDistractions,
    categoryBreakdown,
  };
}

// ─── Structured-output task ──────────────────────────────────────────────────
export const InsightSchema = z.object({
  bestProductiveHour: z.int().min(0).max(23),
  optimalDuration:    z.int().min(15).max(120),
  suggestedSchedule:  z.array(z.object({
    day:             z.enum(DAY_NAMES),
    startHour:       z.int().min(0).max(23),
    durationMinutes: z.int().min(15).max(120),
    confidence:      z.number().min(0).max(1),
    categoryName:    z.string().max(50),
  })).min(1).max(7),
  distractionRisk: z.object({
    score:   z.int().min(0).max(100),
    level:   z.enum(['low', 'medium', 'high']),
    factors: z.array(z.string().max(100)).max(5),
  }),
  insightText: z.string().min(1).max(500),
});

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const argmax = (xs) => xs.reduce((best, v, i) => (v > xs[best] ? i : best), 0);

/**
 * Deterministic, offline insight from the same profile the LLM sees. Used
 * when every provider fails (or none is configured).
 */
export function ruleBasedInsight(profile) {
  const hourly  = profile?.hourly  ?? Array(24).fill(0);
  const weekday = profile?.weekday ?? Array(7).fill(0);
  const sessions = Math.max(1, profile?.sessionCount ?? 1);

  const bestHour = hourly.some(m => m > 0) ? argmax(hourly) : 9;
  const optimal  = clamp(Math.round((profile?.medianMinutes || 25) / 5) * 5, 15, 120);

  // Busiest days first; always at least two entries.
  const maxDay = Math.max(...weekday, 1);
  let days = weekday.map((m, i) => ({ i, m })).filter(d => d.m > 0).sort((a, b) => b.m - a.m || a.i - b.i).slice(0, 3);
  if (days.length === 0) days = [{ i: 1, m: 0 }];
  if (days.length === 1) days.push({ i: (days[0].i + 1) % 7, m: 0 });

  const cats = [...(profile?.categoryBreakdown ?? [])].sort((a, b) => b.totalMins - a.totalMins);
  const categoryFor = (dayName) => (cats.find(c => c.bestDay === dayName) ?? cats[0])?.name ?? 'Focus';

  const suggestedSchedule = days.map(({ i, m }) => ({
    day:             DAY_NAMES[i],
    startHour:       bestHour,
    durationMinutes: optimal,
    confidence:      Math.round((0.3 + 0.5 * (m / maxDay)) * 100) / 100,
    categoryName:    categoryFor(DAY_NAMES[i]).slice(0, 50),
  }));

  const perSession = (profile?.distractionCount ?? 0) / sessions;
  const scorePenalty = profile?.avgScore != null ? (100 - profile.avgScore) * 0.5 : 25;
  const riskScore = clamp(Math.round(perSession * 25 + scorePenalty), 0, 100);
  const level = riskScore < 34 ? 'low' : riskScore < 67 ? 'medium' : 'high';
  const factors = [
    ...(profile?.topDistractions ?? []).slice(0, 2).map(d => `${d.name} (${d.count}×)`.slice(0, 100)),
    ...(profile?.avgScore != null && profile.avgScore < 60 ? ['Low average focus score'] : []),
  ];

  const hh = String(bestHour).padStart(2, '0');
  const insightText =
    `You focus best around ${hh}:00, especially on ${DAY_NAMES[days[0].i]}s. ` +
    `Sessions of about ${optimal} minutes suit you — protect that slot this week.`;

  return {
    bestProductiveHour: bestHour,
    optimalDuration:    optimal,
    suggestedSchedule,
    distractionRisk:    { score: riskScore, level, factors },
    insightText,
  };
}

export const FOCUS_INSIGHT_TASK = defineTask({
  name:        'focus_insight',
  schema:      InsightSchema,
  temperature: 0.1,
  // Room for Gemini 3's (LOW) thinking tokens, which share this budget.
  maxTokens:   4096,
  tier:        'strong',      // Gemini 3.8 Flash → 3.5 Flash-Lite → GitHub gpt-4.1-mini
  fallback:    ruleBasedInsight,
  safeDefault: ruleBasedInsight({}),
});

// Exported for scripts/ai-eval.mjs, which feeds synthetic profiles through the
// real prompt + real model to sanity-check answer quality.
export function buildPrompt(profile) {
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  const categorySection = profile.categoryBreakdown?.length > 0
    ? profile.categoryBreakdown.map(c =>
        `  ${c.name}: best hour ${String(c.bestHour).padStart(2, '0')}:00, most active on ${c.bestDay}, ${c.totalMins} min total`
      ).join('\n')
    : '  (no category data)';

  const availableCategories = profile.categoryBreakdown?.length > 0
    ? profile.categoryBreakdown.map(c => `"${c.name}"`).join(', ')
    : '"Focus"';

  return `You are a productivity coach AI analyzing a user's focus session data from the last 30 days.

USER PROFILE:
- Total completed sessions: ${profile.sessionCount}
- Total focused minutes: ${profile.totalMinutes}
- Average focus score: ${profile.avgScore ?? 'N/A'}/100
- Pomodoro sessions: ${profile.pomodoroCount}
- Countdown sessions: ${profile.countdownCount}

HOURLY ACTIVITY (minutes focused per hour of day, 0-23):
${profile.hourly.map((m, h) => `  ${String(h).padStart(2, '0')}:00 -> ${m} min`).join('\n')}

WEEKDAY ACTIVITY (minutes focused per day):
${profile.weekday.map((m, i) => `  ${dayNames[i]}: ${m} min`).join('\n')}

CATEGORY BREAKDOWN (user's session categories with their best times):
${categorySection}

TOP DISTRACTIONS:
${profile.topDistractions.length > 0
  ? profile.topDistractions.map(d => `  - ${d.name}: ${d.count} times`).join('\n')
  : '  (none recorded)'}

Based on this data, return ONLY a JSON object with this exact shape (no markdown, no commentary):
{
  "bestProductiveHour": <integer 0-23>,
  "optimalDuration": <integer minutes, 15-120>,
  "suggestedSchedule": [
    { "day": "<day name>", "startHour": <0-23>, "durationMinutes": <integer>, "confidence": <0-1 float>, "categoryName": "<category name>" }
  ],
  "distractionRisk": {
    "score": <integer 0-100>,
    "level": "<low|medium|high>",
    "factors": ["<short factor 1>", "<short factor 2>"]
  },
  "insightText": "<2-3 sentence personalized insight>"
}

Rules for suggestedSchedule:
- Return between 2 and 5 entries, one per day of the week (no duplicate days).
- For categoryName use one of: ${availableCategories}. Assign whichever category historically performs best on that day/time based on the category breakdown above.
- Keep insightText under 280 characters.`;
}

/** Prompt as chat messages (system = role + rules, user = the data). */
export function buildInsightMessages(profile) {
  return [
    { role: 'system', content: 'You are a productivity coach AI. You reply with a single JSON object and nothing else.' },
    { role: 'user', content: buildPrompt(profile) },
  ];
}

// Post-validation shaping for storage: dedupe days, cap entries, and store the
// risk level title-cased (AIInsight enum).
function toStoredInsight(ai) {
  const seen = new Set();
  const suggestedSchedule = ai.suggestedSchedule
    .filter(s => (seen.has(s.day) ? false : seen.add(s.day)))
    .slice(0, 5);
  const level = ai.distractionRisk.level;
  return {
    ...ai,
    suggestedSchedule,
    distractionRisk: { ...ai.distractionRisk, level: level.charAt(0).toUpperCase() + level.slice(1) },
  };
}

export async function getOrGenerateInsight(userId, { force = false } = {}) {
  if (!force) {
    const existing = await AIInsight.findOne({ userId }).sort({ generatedAt: -1 });
    if (isInsightFresh(existing)) return { insight: existing, cached: true };
  }

  const profile = await buildUserProfile(userId);
  if (!profile.enoughData) {
    const err = new Error(`Need at least ${MIN_SESSIONS} completed sessions (have ${profile.sessionCount})`);
    err.code = 'NOT_ENOUGH_DATA';
    err.sessionCount = profile.sessionCount;
    throw err;
  }

  const { data, meta } = await generate(buildInsightMessages(profile), FOCUS_INSIGHT_TASK, { context: profile, userId });

  const insight = await AIInsight.findOneAndUpdate(
    { userId },
    {
      $set: {
        ...toStoredInsight(data),
        source:       meta.source,
        provider:     meta.provider,
        modelVersion: meta.model ?? 'rule-based',
        trainingSize: profile.sessionCount,
        generatedAt:  new Date(),
      },
    },
    { upsert: true, returnDocument: 'after' },
  );

  return { insight, cached: false };
}
