import { sql } from 'drizzle-orm';
import { db, sqlite } from './client';

// Wipes the inventory and leaves the accounts alone.
//
//   npm run db:reset -w @inventory/api        # empty
//   npm run db:reset -w @inventory/api && npm run db:seed -w @inventory/api   # demo data
//
// The accounts survive on purpose. Deleting the whole file to get a clean
// database also deletes everyone's login, and the first thing that happens
// afterwards is that nobody can get back in.
//
// Order matters: children before parents, or the foreign keys refuse.
const TABLES = [
  // — the operational half
  'log_lines',
  'log_event_versions',
  'log_event_defs',
  'log_sources',
  'occupancies',
  'pool_recounts',
  'pool_events',
  'pool_units',
  'pools',
  'reconciliations',
  'action_records',
  'action_lines',
  'actions',
  'lot_lines',
  'lots',
  'suppliers',
  'request_supporters',
  'requests',
  // MVP 1
  'items',
  'variants',
  'analogous',
  'concepts',
  'locations',
  'types',
  // The trail goes with the things it describes: keeping it would leave a
  // history of rows that no longer exist.
  'history',
  // Human ids start from 001 again, in step with the empty tables.
  'id_registry',
];

function main() {
  const before = sqlite.prepare('select count(*) as n from items').get() as { n: number };

  db.transaction(() => {
    // Deferred so the order above only has to be roughly right.
    sqlite.pragma('foreign_keys = OFF');
    for (const table of TABLES) {
      db.run(sql.raw(`DELETE FROM ${table}`));
    }
    sqlite.pragma('foreign_keys = ON');
  });

  const users = sqlite.prepare('select count(*) as n from user').get() as { n: number };
  console.log(`Cleared ${TABLES.length} tables (${before.n} items).`);
  console.log(`${users.n} account(s) kept — nobody has been locked out.`);
  console.log('Run `npm run db:seed -w @inventory/api` for demo data, or start empty.');
}

main();
