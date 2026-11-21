// Per-USER daily AI budget (the rate limiter in rateLimiter.js is per
// PROVIDER). Stops one heavy user from burning the shared quota and gives a
// per-user/per-task token tally for cost tracking.
//
//   AI_DAILY_LIMIT   LLM calls per user per UTC day (default 50, 0 = unlimited).
//
// Only calls that reach generate() with a userId count; cached answers never
// get here. Fails open: if Mongo hiccups, the call is allowed and logged.
import AIUsage from '../models/AIUsage.js';

function dailyLimit() {
  const n = Number(process.env.AI_DAILY_LIMIT ?? 50);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : Infinity;
}

const utcDay = () => new Date().toISOString().slice(0, 10);

/**
 * Atomically reserve one call. The filter only matches while calls < limit;
 * at the limit the upsert tries to insert a duplicate (userId, dateStr) and
 * hits the unique index (E11000). A first-insert race between two concurrent
 * calls also raises E11000, so retry once before reporting "limit reached".
 *
 * @returns {Promise<boolean>} true if the call may proceed.
 */
export async function reserveUserCall(userId, taskName, log) {
  const limit = dailyLimit();
  if (limit === Infinity) return true;
  const dateStr = utcDay();
  const taskKey = String(taskName).replace(/[.$]/g, '_');

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await AIUsage.findOneAndUpdate(
        { userId, dateStr, calls: { $lt: limit } },
        { $inc: { calls: 1, [`byTask.${taskKey}`]: 1 } },
        { upsert: true },
      );
      return true;
    } catch (err) {
      if (err?.code !== 11000) {
        log?.warn?.({ err }, '[llm] user quota check failed; allowing call');
        return true;
      }
    }
  }
  log?.info?.({ userId: String(userId), task: taskName, limit }, '[llm] user daily AI limit reached');
  return false;
}

export async function recordUserTokens(userId, usage, log) {
  try {
    await AIUsage.updateOne(
      { userId, dateStr: utcDay() },
      { $inc: { inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0 } },
    );
  } catch (err) {
    log?.warn?.({ err }, '[llm] failed to record user token usage');
  }
}
