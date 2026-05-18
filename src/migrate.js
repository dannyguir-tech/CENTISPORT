import { migrate, closeDb } from './db.js';

try {
  await migrate();
  console.log('Migration complete');
} catch (error) {
  console.error('Migration failed:', error);
  process.exitCode = 1;
} finally {
  await closeDb();
}
