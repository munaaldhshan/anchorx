import mongoose from 'mongoose';
import { FOCUS_EVENTS, DISTRACTION_EVENTS, EVENT_SOURCES } from '../constants/focusEvents.js';
import { breakWindows, isDuringBreak } from '../utils/breaks.js';

// Event semantics live in constants/focusEvents.js (and docs/step0.md).
const FocusLogSchema = new mongoose.Schema({
  sessionId: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'Session',
    required: true,
    index:    true,
  },
  userId: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'User',
    required: true,
    index:    true,
  },
  event: {
    type:     String,
    enum:     FOCUS_EVENTS,
    required: true,
  },
  // UTC instant of the event.
  timestamp: { type: Date, default: Date.now },
  metadata: {
    appName:     { type: String, default: null },  // human-readable app name
    packageName: { type: String, default: null },  // bundle id, e.g. com.burbn.instagram
    reason:      { type: String, default: null },  // SESSION_ENDED: COMPLETED | ABANDONED
    source:      { type: String, enum: [...EVENT_SOURCES, null], default: null },
    tagUid:      { type: String, default: null },  // NFC_* events
    // Custom Breaks (server-written BREAK_* events only; not client-settable).
    breakType:   { type: String, enum: ['PLANNED', 'ON_DEMAND', null], default: null },
    breakIndex:  { type: Number, default: null },  // breakPlan.planned index (PLANNED)
  },
});

FocusLogSchema.index({ sessionId: 1, timestamp: 1 });
FocusLogSchema.index({ userId: 1, event: 1, timestamp: -1 });

/** Distraction total for a session: APP_BLOCKED + DISTRACTION (see constants). */
FocusLogSchema.statics.countDistractions = function (sessionId) {
  return this.countDocuments({ sessionId, event: { $in: DISTRACTION_EVENTS } });
};

/**
 * Distraction total counted during FOCUS time only: events that fall inside a
 * Custom Break window are not temptations (apps may even be unlocked then).
 * Identical to countDistractions for sessions without Custom Breaks.
 */
FocusLogSchema.statics.countFocusDistractions = async function (session, now = new Date()) {
  if (!session.breaks?.length) return this.countDistractions(session._id);
  const windows = breakWindows(session, now);
  const logs = await this.find(
    { sessionId: session._id, event: { $in: DISTRACTION_EVENTS } },
    { timestamp: 1 },
  );
  return logs.filter(l => !isDuringBreak(l.timestamp, windows)).length;
};

export default mongoose.model('FocusLog', FocusLogSchema);
