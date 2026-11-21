// 001 — Session durations move to explicit-unit seconds fields.
//
//   plannedDurationSec ← timerConfig.plannedDuration (minutes) × 60
//   actualDurationSec  ← timerState.actualDuration (minutes) × 60 when > 0,
//                        else (endedAt − startedAt) when both exist,
//                        else null. Always null for ACTIVE/PENDING sessions.
//   timezone           ← left null (unknown for legacy rows; readers fall back
//                        to the user's settings zone).
//
// Additive only: legacy minute fields are kept (still dual-written by the app
// for rollback safety), so this is safe to re-run and safe to roll back. The
// client-reported legacy actual is kept as-is (not clamped to wall time) so
// existing Statistics totals don't shift.
export const id = '001-session-duration-seconds';

export async function up(db) {
  const sessions = db.collection('sessions');

  const planned = await sessions.updateMany(
    { plannedDurationSec: { $exists: false } },
    [{
      $set: {
        plannedDurationSec: {
          $cond: [
            { $isNumber: '$timerConfig.plannedDuration' },
            { $round: [{ $multiply: ['$timerConfig.plannedDuration', 60] }, 0] },
            null,
          ],
        },
      },
    }],
  );

  const wallSec = {
    $cond: [
      { $and: [{ $eq: [{ $type: '$startedAt' }, 'date'] }, { $eq: [{ $type: '$endedAt' }, 'date'] },
               { $gte: ['$endedAt', '$startedAt'] }] },
      { $floor: { $divide: [{ $subtract: ['$endedAt', '$startedAt'] }, 1000] } },
      null,
    ],
  };
  const legacySec = {
    $cond: [
      { $and: [{ $isNumber: '$timerState.actualDuration' }, { $gt: ['$timerState.actualDuration', 0] }] },
      { $round: [{ $multiply: ['$timerState.actualDuration', 60] }, 0] },
      null,
    ],
  };

  const actual = await sessions.updateMany(
    { actualDurationSec: { $exists: false } },
    [{
      $set: {
        actualDurationSec: {
          $cond: [
            { $in: ['$status', ['COMPLETED', 'ABANDONED']] },
            { $ifNull: [legacySec, wallSec] },
            null,
          ],
        },
      },
    }],
  );

  return { plannedUpdated: planned.modifiedCount, actualUpdated: actual.modifiedCount };
}
