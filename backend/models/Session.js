import mongoose from 'mongoose';
import { formatLocalHHMM } from '../utils/datetime.js';

// Durations: the source of truth is the top-level `plannedDurationSec` /
// `actualDurationSec` (integer SECONDS). The legacy minute fields
// `timerConfig.plannedDuration` / `timerState.actualDuration` are still
// dual-written for one release so a backend rollback keeps working, but must
// not be read directly — use plannedSecOf()/actualSecOf() below.

const TimerConfigSchema = new mongoose.Schema({
  plannedDuration:   { type: Number },        // DEPRECATED (minutes) — see plannedDurationSec
  pomodoroWork:      { type: Number, default: 25  },    
  pomodoroBreak:     { type: Number, default: 5   },    
  pomodoroRounds:    { type: Number, default: 4   },
}, { _id: false });

const TimerStateSchema = new mongoose.Schema({
  actualDuration:          { type: Number, default: 0 },  // DEPRECATED (minutes) — see actualDurationSec
  pomodoroRoundsCompleted: { type: Number, default: 0 },
  breaks:                  { type: Number, default: 0 },
}, { _id: false });

const SessionSchema = new mongoose.Schema({
  userId: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'User',
    required: true,
    index:    true,
  },

  // categoryId references the user's custom category (stored in User.categories)
  categoryId: {
    type: String,
    required: true,
  },
  
  // Custom name given to this session by the user
  customName: {
    type: String,
    default: 'Untitled',
  },
  status: {
    type:    String,
    enum:    ['PENDING', 'ACTIVE', 'COMPLETED', 'ABANDONED'],
    default: 'PENDING',
  },
  timerMode: {
    type:    String,
    enum:    ['COUNTDOWN', 'POMODORO', 'STOPWATCH'],
    default: 'COUNTDOWN',
  },
  timerConfig: { type: TimerConfigSchema, default: () => ({}) },
  // Planned focus time, set at creation (Pomodoro: focus time, excluding breaks).
  plannedDurationSec: { type: Number, default: null, min: 0 },
  // Real focus time, set at end. Bounded server-side by endedAt - startedAt,
  // so pauses/breaks are excluded but it can never exceed wall-clock time.
  // null while the session is ACTIVE/PENDING (or legacy rows with no data).
  actualDurationSec:  { type: Number, default: null, min: 0 },
  timerState:  { type: TimerStateSchema,  default: () => ({}) },
  blockedApps: { type: [String], default: [] },
  focusScore: { type: Number, default: null, min: 0, max: 100 },
  // Local calendar day (YYYY-MM-DD) of startedAt in `timezone` — the day this
  // session counts toward for stats/streaks. Derived server-side.
  dateStr: { type: String, required: true, index: true },
  // IANA zone the session was run in (client device zone at start, else the
  // user's settings zone). Null on legacy rows.
  timezone: { type: String, default: null },
  startedAt: { type: Date, default: null },   // UTC
  endedAt:   { type: Date, default: null },   // UTC
}, {
  timestamps: true,  
});

SessionSchema.index({ userId: 1, dateStr: -1 });
SessionSchema.index({ userId: 1, status: 1, dateStr: 1 });

// ─── Duration accessors (migration-safe) ─────────────────────────────────────
// Prefer the seconds fields; fall back to the legacy minute fields for rows
// written before migration 001 ran.
export function plannedSecOf(doc) {
  if (typeof doc?.plannedDurationSec === 'number') return doc.plannedDurationSec;
  const legacy = doc?.timerConfig?.plannedDuration;
  return typeof legacy === 'number' ? legacy * 60 : null;
}

export function actualSecOf(doc) {
  if (typeof doc?.actualDurationSec === 'number') return doc.actualDurationSec;
  if (doc?.status !== 'COMPLETED' && doc?.status !== 'ABANDONED') return null;
  const legacy = doc?.timerState?.actualDuration;
  return typeof legacy === 'number' ? legacy * 60 : null;
}

/** Actual focus minutes (rounded), 0 when unknown. For aggregates. */
export function actualMinutesOf(doc) {
  return Math.round((actualSecOf(doc) ?? 0) / 60);
}

// `tz` is the user's IANA timezone (req.user.settings.timezone), so the
// displayed start/end times match the local clock the session was run on —
// the same zone used by the analytics "best hour" and date-range queries.
SessionSchema.statics.toFrontendRecord = function (doc, tz = 'UTC') {
  const plannedSec = plannedSecOf(doc);
  const actualSec  = actualSecOf(doc);
  const toMin = (sec) => (sec === null ? null : Math.round(sec / 60));

  return {
    id:         doc._id.toString(),
    title:      doc.customName || 'Untitled',
    categoryId: doc.categoryId,
    // Minutes, kept for existing app builds: actual once ended, else planned.
    duration:   toMin(actualSec ?? plannedSec) ?? 0,
    startTime:  doc.startedAt ? formatLocalHHMM(doc.startedAt, tz) : '',
    endTime:    doc.endedAt   ? formatLocalHHMM(doc.endedAt, tz)   : '',
    focusScore: doc.focusScore,
    completed:  doc.status === 'COMPLETED',
    dateStr:    doc.dateStr,

    // Explicit-unit durations (seconds). actualDurationSec is null until ended.
    plannedDurationSec: plannedSec,
    actualDurationSec:  actualSec,

    // Lifecycle fields — let the client detect a session orphaned by an app
    // kill (still ACTIVE, no end) and either finalize or resume it on launch.
    status:          doc.status,
    timerMode:       doc.timerMode,
    startedAtISO:    doc.startedAt ? doc.startedAt.toISOString() : null,
    plannedDuration: toMin(plannedSec),       // minutes (legacy name)
    pomodoroWork:    doc.timerConfig?.pomodoroWork    ?? null,
    pomodoroBreak:   doc.timerConfig?.pomodoroBreak   ?? null,
    blockedApps:     doc.blockedApps ?? [],
  };
};

export default mongoose.model('Session', SessionSchema);