import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DB_PATH } from '../db/client';

// The secret that signs session cookies.
//
// better-auth needs one, and in production it refuses to start without it —
// correctly, because a default secret means anybody can forge a session. But
// "set an environment variable before the app will run at all" is exactly the
// configuration step promises this product does not have, and the
// first `docker run -v ./data:/data` from the README died on it.
//
// So the secret is generated once and kept beside the database, which is the
// one thing a self-hosted install already knows it must back up. Restarting
// keeps everyone signed in; deleting the file signs everyone out and nothing
// else. An explicit BETTER_AUTH_SECRET always wins, which is what a real
// deployment behind a secret manager wants.

const SECRET_FILE = join(dirname(DB_PATH), 'auth-secret');

export function authSecret(): string {
  const fromEnv = process.env.BETTER_AUTH_SECRET?.trim();
  if (fromEnv) return fromEnv;

  if (existsSync(SECRET_FILE)) {
    const stored = readFileSync(SECRET_FILE, 'utf8').trim();
    if (stored) return stored;
  }

  const generated = randomBytes(32).toString('base64');
  // 0600: the file sits in the data volume next to the database, and the
  // database is only as private as its directory — but there is no reason to
  // make the secret readable by everyone on the host.
  writeFileSync(SECRET_FILE, `${generated}\n`, { mode: 0o600 });
  console.log(`Generated a session secret at ${SECRET_FILE} — back it up with the database.`);
  return generated;
}
