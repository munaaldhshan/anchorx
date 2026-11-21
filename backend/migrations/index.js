// Tiny forward-only migration runner. Each migration exports { id, up(db) };
// applied ids are recorded in the `_migrations` collection so a migration runs
// at most once per database. Migrations must be idempotent anyway (a crash
// between `up` and the bookkeeping insert re-runs it), and additive — anything
// destructive needs a separate, reviewed migration.
import mongoose from 'mongoose';
import logger from '../utils/logger.js';
import * as m001 from './001-session-duration-seconds.js';

export const MIGRATIONS = [m001];

export async function runMigrations({ db = mongoose.connection.db, log = logger } = {}) {
  const ledger  = db.collection('_migrations');
  const applied = new Set((await ledger.find({}, { projection: { _id: 1 } }).toArray()).map(d => d._id));
  const ran = [];

  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    const started = Date.now();
    log.info({ migration: m.id }, '[migrate] applying');
    const result = await m.up(db);
    await ledger.updateOne(
      { _id: m.id },
      { $setOnInsert: { appliedAt: new Date(), result: result ?? null } },
      { upsert: true },
    );
    log.info({ migration: m.id, ms: Date.now() - started, result }, '[migrate] applied');
    ran.push(m.id);
  }
  return ran;
}
