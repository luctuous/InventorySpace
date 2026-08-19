// Ops utility: create a user from the command line (bypasses the closed
// registration, same as the Users admin page).
//
//   npx tsx --env-file-if-exists=.env scripts/create-user.mts \
//     <username> <password> <name> [role=operator] [email]
//
// The email is optional and only there for the day accounts get linked to a
// mailbox; without one the account gets an address that can never receive.

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { placeholderEmail, usernameProblem } from '@inventory/shared';
import { auth, adminCreateBypass } from '../src/auth';
import { db } from '../src/db/client';
import { user } from '../src/db/auth-schema';

const [username, password, name, role = 'operator', emailArg] = process.argv.slice(2);
if (!username || !password || !name) {
  console.error('Usage: create-user.mts <username> <password> <name> [role] [email]');
  process.exit(1);
}
if (usernameProblem(username)) {
  console.error(`Not a usable username: ${username} (${usernameProblem(username)})`);
  process.exit(1);
}

const email = emailArg ?? placeholderEmail(username, randomUUID().slice(0, 8));

adminCreateBypass.active = true;
await auth.api.signUpEmail({ body: { email, password, name, username } as never });
adminCreateBypass.active = false;

db.update(user).set({ role }).where(eq(user.email, email)).run();
const row = db
  .select({ username: user.displayUsername, role: user.role, email: user.email })
  .from(user)
  .where(eq(user.email, email))
  .get();
console.log('Created:', row);
