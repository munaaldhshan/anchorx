import mongoose from 'mongoose';

// One doc per user per UTC day: how many AI calls they made and the tokens
// those calls used. Drives the per-user daily limit (config/llm.js) and shows
// which users/tasks cost the most.
const AIUsageSchema = new mongoose.Schema({
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  dateStr:      { type: String, required: true },        // UTC YYYY-MM-DD
  calls:        { type: Number, default: 0 },
  inputTokens:  { type: Number, default: 0 },
  outputTokens: { type: Number, default: 0 },
  byTask:       { type: Map, of: Number, default: () => ({}) },
}, { timestamps: true });

AIUsageSchema.index({ userId: 1, dateStr: 1 }, { unique: true });
// Keep ~90 days of history; older docs expire automatically.
AIUsageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 3600 });

export default mongoose.model('AIUsage', AIUsageSchema);
