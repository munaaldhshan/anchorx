import mongoose from 'mongoose';

// AI Focus Coach conversation (services/coach). One document per conversation,
// owned by exactly one user; every route query filters on { _id, userId }.
//
// Assistant messages store the validated, labeled answer only. The system
// prompt, raw model output, tool arguments/results and provider details are
// never persisted here, so history can't leak them.

export const SECTION_KINDS   = Object.freeze(['measured_data', 'ai_suggestion']);
export const MESSAGE_STATUS  = Object.freeze(['ok', 'unavailable']);
export const FEEDBACK_VALUES = Object.freeze(['up', 'down']);
export const UNAVAILABLE_REASONS = Object.freeze(['daily_limit', 'service_unavailable']);

const UNAVAILABLE_NOTICE = {
  daily_limit:         "You've reached today's AI coach limit. Please try again tomorrow.",
  service_unavailable: "The coach couldn't answer right now. Please try again in a moment.",
};

export const MAX_MESSAGES_PER_CONVERSATION = 100;   // 50 turns
export const MAX_CONVERSATIONS_PER_USER    = 50;

const SectionSchema = new mongoose.Schema({
  kind: { type: String, enum: SECTION_KINDS, required: true },
  text: { type: String, required: true, maxlength: 600 },
}, { _id: false });

const MessageSchema = new mongoose.Schema({
  role:     { type: String, enum: ['user', 'assistant'], required: true },
  // user messages
  content:  { type: String, default: null, maxlength: 1000 },
  // assistant messages
  status:   { type: String, enum: [...MESSAGE_STATUS, null], default: null },
  sections: { type: [SectionSchema], default: undefined },
  dataGaps: { type: [String], default: undefined },
  feedback: { type: String, enum: [...FEEDBACK_VALUES, null], default: null },
  // status 'unavailable' only: why the coach couldn't answer (no provider detail).
  unavailableReason: { type: String, enum: [...UNAVAILABLE_REASONS, null], default: null },
  createdAt: { type: Date, default: Date.now },
});

const CoachConversationSchema = new mongoose.Schema({
  userId: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'User',
    required: true,
    index:    true,
  },
  title:    { type: String, default: 'New conversation', maxlength: 80 },
  messages: { type: [MessageSchema], default: [] },
}, { timestamps: true });

CoachConversationSchema.index({ userId: 1, updatedAt: -1 });

function messageRecord(m) {
  if (m.role === 'user') {
    return { id: m._id.toString(), role: 'user', content: m.content, createdAt: m.createdAt };
  }
  return {
    id:        m._id.toString(),
    role:      'assistant',
    status:    m.status,
    sections:  (m.sections ?? []).map(s => ({ kind: s.kind, text: s.text })),
    dataGaps:  [...(m.dataGaps ?? [])],
    ...(m.status === 'unavailable'
      ? { unavailableReason: m.unavailableReason, notice: UNAVAILABLE_NOTICE[m.unavailableReason] ?? UNAVAILABLE_NOTICE.service_unavailable }
      : {}),
    feedback:  m.feedback ?? null,
    createdAt: m.createdAt,
  };
}

/** Client-facing shape. Never includes userId or internal fields. */
CoachConversationSchema.statics.toRecord = function (doc, { withMessages = true } = {}) {
  return {
    id:           doc._id.toString(),
    title:        doc.title,
    createdAt:    doc.createdAt,
    updatedAt:    doc.updatedAt,
    messageCount: doc.messages?.length ?? 0,
    ...(withMessages ? { messages: (doc.messages ?? []).map(messageRecord) } : {}),
  };
};

CoachConversationSchema.statics.messageRecord = messageRecord;

export default mongoose.model('CoachConversation', CoachConversationSchema);
