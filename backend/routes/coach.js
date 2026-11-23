// AI Focus Coach conversations. Mounted at /api/ai/coach by routes/ai.js,
// which applies the auth middleware first.
//
// Ownership: every lookup filters on { _id, userId: req.user._id } and a miss
// is a 404 whether the conversation doesn't exist or belongs to someone else,
// so ids can't be probed. Responses use CoachConversation.toRecord(), which
// carries only the labeled answers — never prompts, tool traffic or provider
// details.
import express from 'express';
import rateLimit from 'express-rate-limit';
import asyncHandler from '../middleware/asyncHandler.js';
import { requireString, requireObjectId, requireEnum, badRequest } from '../middleware/validate.js';
import CoachConversation, {
  FEEDBACK_VALUES, MAX_MESSAGES_PER_CONVERSATION, MAX_CONVERSATIONS_PER_USER,
} from '../models/CoachConversation.js';
import { runCoachTurn, MAX_USER_MESSAGE_LEN } from '../services/coach/coachService.js';

const router = express.Router();

// Each message can fan out to several LLM calls; cap bursts per user on top
// of the per-user daily AI quota (llm/userQuota.js). Disabled in tests.
const messageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `coach:${req.user._id}`,
  skip: () => process.env.NODE_ENV === 'test',
  message: { message: 'Too many coach messages, please slow down' },
});

const notFound = (res) => res.status(404).json({ message: 'Conversation not found' });

function onlyKeys(body, allowed) {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) throw badRequest('Request body must be a JSON object');
  const extra = Object.keys(body).filter(k => !allowed.includes(k));
  if (extra.length) throw badRequest(`Unexpected field(s): ${extra.join(', ')}`);
  return body;
}

function readMessage(v) {
  const text = requireString(v, { min: 1, max: MAX_USER_MESSAGE_LEN, field: 'message' }).trim();
  if (!text) throw badRequest('message must not be empty');
  return text;
}

const titleFrom = (text) => (text.length > 60 ? `${text.slice(0, 57).trimEnd()}…` : text);

/**
 * Run a turn and append [user, assistant] atomically. The push is guarded on
 * owner + remaining capacity, so a concurrent delete or a full conversation
 * can't be written past. Returns the assistant record, or null on a miss.
 */
async function appendTurn(req, convo, text) {
  const result = await runCoachTurn({ user: req.user, history: convo.messages, message: text, log: req.log });

  const now = new Date();
  const userMsg = { role: 'user', content: text, createdAt: now };
  const assistantMsg = {
    role: 'assistant',
    status: result.status,
    sections: result.sections,
    dataGaps: result.dataGaps,
    unavailableReason: result.status === 'unavailable' ? result.unavailableReason : null,
    createdAt: new Date(now.getTime() + 1),
  };

  const update = { $push: { messages: { $each: [userMsg, assistantMsg] } } };
  if (convo.messages.length === 0) update.$set = { title: titleFrom(text) };

  const updated = await CoachConversation.findOneAndUpdate(
    {
      _id: convo._id,
      userId: req.user._id,
      [`messages.${MAX_MESSAGES_PER_CONVERSATION - 2}`]: { $exists: false },
    },
    update,
    { returnDocument: 'after' },
  );
  if (!updated) return null;
  const last = updated.messages[updated.messages.length - 1];
  return { conversation: updated, reply: CoachConversation.messageRecord(last) };
}

// ─── GET /api/ai/coach/conversations ─────────────────────────────────────────
router.get('/conversations', asyncHandler(async (req, res) => {
  const docs = await CoachConversation.find({ userId: req.user._id })
    .sort({ updatedAt: -1 })
    .limit(MAX_CONVERSATIONS_PER_USER);
  res.json({ conversations: docs.map(d => CoachConversation.toRecord(d, { withMessages: false })) });
}));

// ─── POST /api/ai/coach/conversations  { message? } ──────────────────────────
// Starts a conversation; with `message`, also runs the first turn.
router.post('/conversations', messageLimiter, asyncHandler(async (req, res) => {
  const body = onlyKeys(req.body, ['message']);
  const text = body.message === undefined ? null : readMessage(body.message);

  const count = await CoachConversation.countDocuments({ userId: req.user._id });
  if (count >= MAX_CONVERSATIONS_PER_USER) {
    return res.status(409).json({
      message: `You can keep up to ${MAX_CONVERSATIONS_PER_USER} coach conversations. Delete one to start another.`,
    });
  }

  const convo = await CoachConversation.create({ userId: req.user._id });
  if (!text) return res.status(201).json({ conversation: CoachConversation.toRecord(convo) });

  const out = await appendTurn(req, convo, text);
  if (!out) return notFound(res);   // deleted mid-turn
  res.status(201).json({ conversation: CoachConversation.toRecord(out.conversation), reply: out.reply });
}));

// ─── GET /api/ai/coach/conversations/:id ─────────────────────────────────────
router.get('/conversations/:id', asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, { field: 'conversation id' });
  const convo = await CoachConversation.findOne({ _id: id, userId: req.user._id });
  if (!convo) return notFound(res);
  res.json({ conversation: CoachConversation.toRecord(convo) });
}));

// ─── POST /api/ai/coach/conversations/:id/messages  { message } ──────────────
router.post('/conversations/:id/messages', messageLimiter, asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, { field: 'conversation id' });
  const body = onlyKeys(req.body, ['message']);
  if (body.message === undefined) throw badRequest('message is required');
  const text = readMessage(body.message);

  const convo = await CoachConversation.findOne({ _id: id, userId: req.user._id });
  if (!convo) return notFound(res);
  if (convo.messages.length + 2 > MAX_MESSAGES_PER_CONVERSATION) {
    return res.status(409).json({ message: 'This conversation is full. Start a new one.' });
  }

  const out = await appendTurn(req, convo, text);
  if (!out) {
    const stillThere = await CoachConversation.exists({ _id: id, userId: req.user._id });
    return stillThere
      ? res.status(409).json({ message: 'This conversation is full. Start a new one.' })
      : notFound(res);
  }
  res.status(201).json({ reply: out.reply, messageCount: out.conversation.messages.length });
}));

// ─── PUT /api/ai/coach/conversations/:id/messages/:messageId/feedback ────────
// { rating: 'up' | 'down' | null }  — assistant messages only.
router.put('/conversations/:id/messages/:messageId/feedback', asyncHandler(async (req, res) => {
  const id        = requireObjectId(req.params.id, { field: 'conversation id' });
  const messageId = requireObjectId(req.params.messageId, { field: 'message id' });
  const body = onlyKeys(req.body, ['rating']);
  if (!('rating' in body)) throw badRequest('rating is required');
  const rating = body.rating === null ? null : requireEnum(body.rating, FEEDBACK_VALUES, { field: 'rating' });

  const r = await CoachConversation.updateOne(
    { _id: id, userId: req.user._id, messages: { $elemMatch: { _id: messageId, role: 'assistant' } } },
    { $set: { 'messages.$.feedback': rating } },
    { timestamps: false },
  );
  if (r.matchedCount === 0) return res.status(404).json({ message: 'Message not found' });
  res.json({ id: messageId, feedback: rating });
}));

// ─── DELETE /api/ai/coach/conversations/:id ──────────────────────────────────
router.delete('/conversations/:id', asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, { field: 'conversation id' });
  const r = await CoachConversation.deleteOne({ _id: id, userId: req.user._id });
  if (r.deletedCount === 0) return notFound(res);
  res.json({ deleted: true });
}));

export default router;
