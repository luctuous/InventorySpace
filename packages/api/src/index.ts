import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import type { NetworkInterfaceInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { app } from './app';
import { db } from './db/client';
import { seedDemoData } from './db/seed';

// Apply pending migrations on boot — "download → run one command → open your
// browser" means the server owns its own schema upgrades.
// Works from src/ (dev) and dist/ (build): drizzle/ sits one level up of both.
migrate(db, {
  migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
});

/**
 * A brand-new installation opens on a small demo inventory instead of on
 * nothing.
 *
 * An empty inventory app is unusable as a first impression: there is no way to
 * tell what a Concept is for, the tour has nothing to point at, and the first
 * thing a person must do is invent data before they can judge whether the
 * thing suits them. So the first boot of an empty database fills it with a
 * home workshop — a handful of rows, all of them ordinary things, all of them
 * deletable from the Bin in a minute.
 *
 * It runs ONCE, because `seedDemoData` returns immediately if there is a
 * single concept in the database. No upgrade can overwrite anyone's data.
 * Set `SEED_DEMO=0` for an installation that should start truly empty.
 */
if (process.env.SEED_DEMO !== '0') seedDemoData();

// The session secret used to be a warning here and nothing else, which meant a
// production container started, printed the warning, and then died on its first
// authenticated request. It is now generated and persisted beside the database
// (lib/secret.ts), so there is nothing left to warn about.

const port = Number(process.env.PORT ?? 3001);

/**
 * The addresses other machines on the workshop network can actually use. The server
 * already listens on every interface, but printing only "localhost" leaves you
 * guessing what to tell your colleagues (: one server, one file, the
 * whole workshop connects to it).
 */
function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((iface): iface is NetworkInterfaceInfo =>
      Boolean(iface) && iface!.family === 'IPv4' && !iface!.internal)
    .map((iface) => iface.address);
}

/**
 * Inside a container the only address we can see is the bridge one
 * (172.17.x.x), which is useless to a colleague and worse than saying nothing:
 * it looks like an answer. Detected the standard way — Docker creates
 * /.dockerenv in every container.
 */
function inContainer(): boolean {
  return existsSync('/.dockerenv');
}

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
  if (inContainer()) {
    console.log(
      `             from other machines: http://<this computer's address>:${info.port}`,
    );
    console.log("             (in a container, so the host's address is not visible from here)");
  } else {
    for (const address of lanAddresses()) {
      console.log(`             on http://${address}:${info.port}  (this network)`);
    }
  }
  console.log(`Docs at http://localhost:${info.port}/api/docs`);
});
