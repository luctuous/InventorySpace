import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db } from './client';
import { seedDemoData } from './seed';

// `npm run db:seed`.
//
// Its own file rather than a "was I run directly?" guard inside seed.ts: the
// production build inlines seed.ts into dist/index.js, so the two become one
// file and any such guard is true for both. The server would then run the
// script path on every boot — which is how this was found.

migrate(db, {
  migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)),
});

console.log(seedDemoData() ? '' : 'Database is not empty — seed skipped.');
