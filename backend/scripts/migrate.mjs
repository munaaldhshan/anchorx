// Apply pending migrations and exit.   Run from backend/:  npm run migrate
import 'dotenv/config';
import { connectDB, disconnectDB } from '../config/db.js';
import { runMigrations } from '../migrations/index.js';
import logger from '../utils/logger.js';

try {
  await connectDB();
  const ran = await runMigrations();
  logger.info({ ran }, ran.length ? '[migrate] done' : '[migrate] nothing to apply');
} catch (err) {
  logger.error({ err }, '[migrate] failed');
  process.exitCode = 1;
} finally {
  await disconnectDB();
}
