import mongoose from 'mongoose';

const AIInsightSchema = new mongoose.Schema({
  userId: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'User',
    required: true,
    unique:   true,
  },

  bestProductiveHour: { type: Number, default: null, min: 0, max: 23 },
  optimalDuration:    { type: Number, default: null },
  suggestedSchedule:  [{
    day:             { type: String },
    startHour:       { type: Number, min: 0, max: 23 },
    durationMinutes: { type: Number },
    confidence:      { type: Number, min: 0, max: 1 },
    categoryName:    { type: String, default: '' },
    _id: false,
  }],

  distractionRisk: {
    score:   { type: Number, min: 0, max: 100, default: 0 },
    level:   { type: String, enum: ['Low', 'Medium', 'High'], default: 'Low' },
    factors: { type: [String], default: [] },
    _id: false,
  },

  insightText: { type: String, default: null },

  // Where this insight came from: 'llm' (provider/model below) or 'fallback'
  // (rule-based, no network). Lets the UI label estimates honestly.
  source:       { type: String,  enum: ['llm', 'fallback'], default: 'llm' },
  provider:     { type: String,  default: null },
  modelVersion: { type: String,  default: '1.0' },   // model id, or 'rule-based'
  trainingSize: { type: Number,  default: 0 },
  generatedAt:  { type: Date,    default: Date.now },
}, {
  timestamps: true,
});

export default mongoose.model('AIInsight', AIInsightSchema);