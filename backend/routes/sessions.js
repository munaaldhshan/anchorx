import express from 'express';
import Session, { plannedSecOf } from '../models/Session.js';
import FocusLog from '../models/FocusLog.js';
import Statistics from '../models/Statistics.js';
import User from '../models/User.js';
import auth from '../middleware/auth.js';
import asyncHandler from '../middleware/asyncHandler.js';
import {
  requireObjectId, requireInt, requireEnum, requireString, requireDateStr, badRequest,
} from '../middleware/validate.js';
import { invalidateSuggestion } from '../services/aiSuggestionService.js';
import { sendPush } from '../utils/push.js';
import { resolveTimezone, isValidTimezone, localDayOf, diffDays } from '../utils/datetime.js';
import {
  FOCUS_EVENT, CLIENT_LOGGABLE_EVENTS, normalizeEventMetadata,
} from '../constants/focusEvents.js';

const router = express.Router();

router.use(auth);

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Client and server clocks can disagree slightly when endedAt is server-filled;
// allow this much slack before clamping reported focus time to wall-clock time.
const CLOCK_SKEW_TOLERANCE_SEC = 60;
const MAX_PLANNED_SEC = 480 * 60;

/** Compute score using the same formula as the frontend ActiveSessionScreen. */
export function computeFocusScore(actualSec, plannedSec, isPomo, distractionCount) {
  const ratio    = Math.min(1, actualSec / Math.max(60, plannedSec));
  const pomoBon  = isPomo ? 8 : 0;
  const penalty  = Math.min(24, distractionCount * 4);
  return Math.min(99, Math.max(20, Math.round(ratio * 80) + pomoBon - penalty + 12));
}

/** Validate + normalize the blockedApps array (≤50 items, each ≤200 chars). */
/** Parse an optional ISO timestamp from the body; 400 on garbage. */
function parseInstant(v, field) {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(v);
  if (typeof v !== 'string' && typeof v !== 'number') throw badRequest(`${field} must be an ISO timestamp`);
  if (Number.isNaN(d.getTime())) throw badRequest(`${field} must be an ISO timestamp`);
  return d;
}

/**
 * Which local day a session counts toward. New clients send `timezone`, and
 * the day is derived from startedAt in that zone. Older app builds send only a
 * device-local `dateStr`: it is trusted when it's within a day of the derived
 * value (settings.timezone may lag a device that just changed zone), else the
 * derived value wins.
 */
export function resolveSessionDay({ startedAt, clientTz, clientDateStr, userTz }) {
  if (clientTz) return localDayOf(startedAt, clientTz);
  const derived = localDayOf(startedAt, userTz);
  if (clientDateStr && Math.abs(diffDays(derived, clientDateStr)) <= 1) return clientDateStr;
  return derived;
}

/** Planned focus seconds from either the new or the legacy (minutes) field. */
function readPlannedSec(body) {
  if (body.plannedDurationSec !== undefined)
    return requireInt(body.plannedDurationSec, { min: 60, max: MAX_PLANNED_SEC, field: 'plannedDurationSec' });
  if (body.timerConfig?.plannedDuration !== undefined)
    return 60 * requireInt(body.timerConfig.plannedDuration, { min: 1, max: 480, field: 'timerConfig.plannedDuration' });
  throw badRequest('plannedDurationSec is required');
}

/** Client-reported focus seconds (new or legacy minutes field), or null. */
function readReportedActualSec(body) {
  if (body.actualDurationSec !== undefined && body.actualDurationSec !== null)
    return requireInt(body.actualDurationSec, { min: 0, max: 24 * 3600, field: 'actualDurationSec' });
  const legacy = body.timerState?.actualDuration;
  if (legacy !== undefined && legacy !== null)
    return 60 * requireInt(legacy, { min: 0, max: 24 * 60, field: 'timerState.actualDuration' });
  return null;
}

function validateBlockedApps(arr) {
  if (arr === undefined || arr === null) return [];
  if (!Array.isArray(arr)) throw badRequest('blockedApps must be an array');
  if (arr.length > 50)     throw badRequest('blockedApps may contain at most 50 items');
  return arr.map((a, i) => requireString(a, { max: 200, field: `blockedApps[${i}]` }));
}

/**
 * After any session mutation: rebuild the affected day's metrics, recompute the
 * streak efficiently (Statistics.computeStreak), and persist it. Statistics is
 * never mutated directly.
 */
async function syncStats(userId, dateStr, tz) {
  await Statistics.rebuildForDay(userId, dateStr, tz);
  const { current, longest } = await Statistics.computeStreak(userId, tz);
  await Statistics.setStreak(userId, dateStr, current, longest);
  return { streak: current, longestStreak: longest };
}

// ─── GET /api/sessions ────────────────────────────────────────────────────────
// Query params: ?status=COMPLETED&dateStr=YYYY-MM-DD&limit=50
router.get('/', asyncHandler(async (req, res) => {
  const filter = { userId: req.user._id };
  if (req.query.status)  filter.status  = req.query.status;
  if (req.query.dateStr) filter.dateStr = req.query.dateStr;

  const sessions = await Session
    .find(filter)
    .sort({ dateStr: -1, startedAt: -1 })
    .limit(Number(req.query.limit) || 100);

  const tz = resolveTimezone(req.user);
  res.json(sessions.map(s => Session.toFrontendRecord(s, tz)));
}));

// ─── POST /api/sessions ───────────────────────────────────────────────────────
// Create a new session (ACTIVE state) when the user taps "Start".
// Body: { categoryId, customName, timerMode, plannedDurationSec, timerConfig?,
//         blockedApps, startedAt, timezone?, dateStr? (legacy), nfcTagUid? }
// timerConfig.plannedDuration (minutes) is still accepted from older builds.
router.post('/', asyncHandler(async (req, res) => {
  const { categoryId, customName, timerMode, blockedApps, dateStr, nfcTagUid } = req.body;
  const timerConfig = req.body.timerConfig ?? {};

  if (dateStr !== undefined) requireDateStr(dateStr);
  const categoryIdStr = requireString(categoryId, { field: 'categoryId' });
  const customNameStr = customName ? requireString(customName, { max: 100, field: 'customName' }) : 'Untitled';

  if (typeof timerConfig !== 'object' || Array.isArray(timerConfig))
    throw badRequest('timerConfig must be an object');
  if (req.body.timezone !== undefined && !isValidTimezone(req.body.timezone))
    throw badRequest('timezone must be a valid IANA timezone');

  // Validate that the category exists for this user
  const category = req.user.categories?.find(c => c.id === categoryIdStr);
  if (!category) throw badRequest('Invalid categoryId');

  const finalMode = timerMode === undefined
    ? 'COUNTDOWN'
    : requireEnum(timerMode, ['COUNTDOWN', 'POMODORO', 'STOPWATCH'], { field: 'timerMode' });

  const plannedDurationSec = readPlannedSec(req.body);
  const pomodoroWork = timerConfig.pomodoroWork === undefined
    ? req.user.settings.pomodoroWork
    : requireInt(timerConfig.pomodoroWork, { min: 1, max: 60, field: 'timerConfig.pomodoroWork' });
  const pomodoroBreak = timerConfig.pomodoroBreak === undefined
    ? req.user.settings.pomodoroBreak
    : requireInt(timerConfig.pomodoroBreak, { min: 1, max: 60, field: 'timerConfig.pomodoroBreak' });
  const pomodoroRounds = timerConfig.pomodoroRounds === undefined
    ? 4
    : requireInt(timerConfig.pomodoroRounds, { min: 1, max: 20, field: 'timerConfig.pomodoroRounds' });

  const apps = validateBlockedApps(blockedApps);

  const userTz    = resolveTimezone(req.user);
  const sessionTz = req.body.timezone ?? userTz;
  const startedAt = parseInstant(req.body.startedAt, 'startedAt') ?? new Date();

  const session = await Session.create({
    userId:      req.user._id,
    categoryId:  categoryIdStr,
    customName:  customNameStr,
    status:      'ACTIVE',
    timerMode:   finalMode,
    timerConfig: {
      // Legacy minutes, dual-written for rollback safety (see models/Session.js).
      plannedDuration: Math.max(1, Math.round(plannedDurationSec / 60)),
      pomodoroWork, pomodoroBreak, pomodoroRounds,
    },
    plannedDurationSec,
    blockedApps: apps,
    dateStr:     resolveSessionDay({
      startedAt, clientTz: req.body.timezone, clientDateStr: dateStr, userTz,
    }),
    timezone:    sessionTz,
    startedAt,
    nfcTagUid:   nfcTagUid || null,
  });

  await FocusLog.create({
    sessionId: session._id,
    userId:    req.user._id,
    event:     FOCUS_EVENT.SESSION_STARTED,
    timestamp: session.startedAt,
  });

  const tz = userTz;
  res.status(201).json(Session.toFrontendRecord(session, tz));
}));

// ─── PATCH /api/sessions/:id/end ─────────────────────────────────────────────
// Body: { status: 'COMPLETED'|'ABANDONED', actualDurationSec?, endedAt?, nfcTagUid?,
//         timerState? (pomodoroRoundsCompleted, breaks; legacy actualDuration minutes) }
router.patch('/:id/end', asyncHandler(async (req, res) => {
  requireObjectId(req.params.id);

  const session = await Session.findOne({ _id: req.params.id, userId: req.user._id });
  if (!session) return res.status(404).json({ message: 'Session not found' });
  if (session.status !== 'ACTIVE')
    return res.status(400).json({ message: `Session is already ${session.status}` });

  const { status, timerState, nfcTagUid } = req.body;
  const finalStatus = ['COMPLETED', 'ABANDONED'].includes(status) ? status : 'ABANDONED';
  const endTime     = parseInstant(req.body.endedAt, 'endedAt') ?? new Date();
  const startTime   = session.startedAt ?? session.createdAt;
  if (endTime < startTime) throw badRequest('endedAt must not be before the session start');

  // actualDurationSec = focus time the client measured (excludes pauses and
  // Pomodoro breaks), bounded by real wall-clock time between the UTC start
  // and end instants. Without a client figure, wall-clock time is used.
  const wallSec     = Math.floor((endTime - startTime) / 1000);
  const reportedSec = readReportedActualSec(req.body);
  const actualDurationSec = reportedSec === null
    ? wallSec
    : Math.min(reportedSec, wallSec + CLOCK_SKEW_TOLERANCE_SEC);

  // Focus score is computed server-side from authoritative sources only.
  // Client-supplied focusScore / distractionCount values are ignored.
  const distractionCount = await FocusLog.countDistractions(session._id);
  const isPomo     = session.timerMode === 'POMODORO';
  const focusScore = finalStatus === 'COMPLETED'
    ? computeFocusScore(actualDurationSec, plannedSecOf(session) ?? 0, isPomo, distractionCount)
    : null;

  // Atomic transition: the guard on status:'ACTIVE' means only the first of two
  // racing end requests wins. The loser gets null and does no side effects, so
  // logs and stats can't be double-counted.
  const updated = await Session.findOneAndUpdate(
    { _id: session._id, userId: req.user._id, status: 'ACTIVE' },
    {
      $set: {
        status:     finalStatus,
        actualDurationSec,
        timerState: {
          // Legacy minutes, dual-written for rollback safety.
          actualDuration:          Math.round(actualDurationSec / 60),
          pomodoroRoundsCompleted: timerState?.pomodoroRoundsCompleted ?? 0,
          breaks:                  timerState?.breaks                  ?? 0,
        },
        focusScore,
        endedAt: endTime,
      },
    },
    { returnDocument: 'after' },
  );
  if (!updated) return res.status(409).json({ message: 'Session already ended' });

  // Log NFC_VERIFIED before SESSION_ENDED so the event order is chronological.
  if (nfcTagUid) {
    await FocusLog.create({
      sessionId: updated._id,
      userId:    req.user._id,
      event:     FOCUS_EVENT.NFC_VERIFIED,
      timestamp: endTime,
      metadata:  { tagUid: String(nfcTagUid).slice(0, 100) },
    });
  }

  await FocusLog.create({
    sessionId: updated._id,
    userId:    req.user._id,
    event:     FOCUS_EVENT.SESSION_ENDED,
    timestamp: endTime,
    metadata:  { reason: finalStatus },
  });

  const tz = resolveTimezone(req.user);

  // Snapshot today's minutes before rebuilding so we can detect the goal crossing.
  const prevStat = await Statistics.findOne(
    { userId: req.user._id, dateStr: updated.dateStr },
    { totalFocusMinutes: 1 },
  );
  const prevMinutes = prevStat?.totalFocusMinutes ?? 0;

  const streakData = await syncStats(req.user._id, updated.dateStr, tz);

  // Goal-achieved push — fires once when the session that crosses the daily goal completes.
  if (
    finalStatus === 'COMPLETED' &&
    req.user.settings?.notificationsEnabled &&
    req.user.settings?.notify?.goalAchieved &&
    req.user.pushTokens?.length
  ) {
    const goal = req.user.settings.dailyGoalMinutes ?? 120;
    const afterStat = await Statistics.findOne(
      { userId: req.user._id, dateStr: updated.dateStr },
      { totalFocusMinutes: 1 },
    );
    const nextMinutes = afterStat?.totalFocusMinutes ?? 0;
    if (prevMinutes < goal && nextMinutes >= goal) {
      const dead = await sendPush(req.user.pushTokens, {
        title: 'Daily goal achieved! 🎉',
        body:  `You hit your ${goal}-minute focus goal for today. Keep it up!`,
        data:  { type: 'GOAL_ACHIEVED' },
      });
      if (dead.length) {
        await User.findByIdAndUpdate(req.user._id, { $pull: { pushTokens: { $in: dead } } });
      }
    }
  }

  invalidateSuggestion(req.user._id);

  res.json({
    session: Session.toFrontendRecord(updated, tz),
    streak:  streakData.streak,
    distractionCount,
  });
}));

// ─── POST /api/sessions/:id/log ───────────────────────────────────────────────
// Append a client-observed event to an ACTIVE session.
// Body: { event: APP_BLOCKED|DISTRACTION|BREAK_STARTED|BREAK_ENDED,
//         metadata?: { appName?, packageName?, source? }, timestamp? (ISO) }
// See constants/focusEvents.js for semantics.
router.post('/:id/log', asyncHandler(async (req, res) => {
  requireObjectId(req.params.id);

  const event = requireEnum(req.body.event, CLIENT_LOGGABLE_EVENTS, { field: 'event' });
  const { metadata, error } = normalizeEventMetadata(req.body.metadata);
  if (error) throw badRequest(error);

  const session = await Session.findOne({ _id: req.params.id, userId: req.user._id });
  if (!session) return res.status(404).json({ message: 'Session not found' });
  // Scoring happens at /end, so events after that would silently disagree
  // with the stored score.
  if (session.status !== 'ACTIVE')
    return res.status(409).json({ message: `Session is already ${session.status}` });

  // A client may queue events briefly offline; accept its timestamp when it
  // lies inside the session, otherwise stamp server time.
  const now = new Date();
  const ts  = parseInstant(req.body.timestamp, 'timestamp');
  const timestamp = ts && ts >= session.startedAt && ts <= now ? ts : now;

  const log = await FocusLog.create({
    sessionId: session._id,
    userId:    req.user._id,
    event,
    timestamp,
    metadata,
  });

  res.status(201).json(log);
}));

// ─── GET /api/sessions/:id/logs ──────────────────────────────────────────────
router.get('/:id/logs', asyncHandler(async (req, res) => {
  requireObjectId(req.params.id);

  const logs = await FocusLog
    .find({ sessionId: req.params.id, userId: req.user._id })
    .sort({ timestamp: 1 });
  res.json(logs);
}));

// ─── DELETE /api/sessions/:id ─────────────────────────────────────────────────
router.delete('/:id', asyncHandler(async (req, res) => {
  requireObjectId(req.params.id);

  const session = await Session.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
  if (!session) return res.status(404).json({ message: 'Session not found' });

  await FocusLog.deleteMany({ sessionId: session._id });
  const tz = resolveTimezone(req.user);
  await syncStats(req.user._id, session.dateStr, tz);

  invalidateSuggestion(req.user._id);

  res.json({ deleted: true });
}));

export default router;
