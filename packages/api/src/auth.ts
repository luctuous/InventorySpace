import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { username } from 'better-auth/plugins';
import { count } from 'drizzle-orm';
import { usernameProblem, USERNAME_MAX } from '@inventory/shared';
import { db } from './db/client';
import * as authSchema from './db/auth-schema';
import { fastLogin } from './lib/fast-login-plugin';
import { authSecret } from './lib/secret';

function userCount(): number {
  const row = db.select({ n: count() }).from(authSchema.user).get();
  return row?.n ?? 0;
}

/**
 * Public registration closes after the first user; from then on only the
 * Users admin page creates accounts. That flow calls better-auth's own
 * sign-up API server-side, so it passes through the same before-create hook —
 * this flag lets it through. Node runs the route handler synchronously up to
 * the awaited call, so the flag cannot leak across unrelated requests in any
 * realistic self-hosted deployment.
 */
export const adminCreateBypass = { active: false };

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'sqlite', schema: authSchema }),
  // Generated once and kept beside the database when the environment does not
  // supply one — see lib/secret.ts. Without this, a production container
  // refuses to serve a single authenticated request.
  secret: authSecret(),
  advanced: {
    /**
     * Whether the session cookie is marked `Secure`.
     *
     * better-auth decides this from `NODE_ENV` alone, which is right for a SaaS
     * and wrong for this product. A browser refuses to *store* a `Secure`
     * cookie served over plain `http://` — every host except `localhost` — so
     * the production container was handing out a cookie that every machine on
     * the workshop network silently dropped. It worked on the server itself and
     * nowhere else: sign in, land on Home, press F5, back to the login screen.
     *
     * The whole premise here is one server reached at
     * `http://192.168.1.20:3000`, so plain HTTP is the normal
     * case, not a mistake. Secure cookies switch on when somebody actually
     * puts TLS in front and says so with `BETTER_AUTH_URL=https://…`.
     */
    useSecureCookies: (process.env.BETTER_AUTH_URL ?? '').startsWith('https://'),
  },
  emailAndPassword: { enabled: true },
  plugins: [
    // The username is the identity people actually type. better-auth's own
    // validator only allows `[a-zA-Z0-9_.]`, which rules out `Müller`,
    // `anna-r` and `torn nit` — all perfectly ordinary in a workshop — so it is
    // replaced by the shared rule, which forbids only what genuinely breaks
    // (see `usernameProblem`). Lower-casing for lookup is kept: `Anna` and
    // `anna` must never become two accounts. `displayUsername` keeps the
    // spelling as it was typed.
    username({
      minUsernameLength: 2,
      maxUsernameLength: USERNAME_MAX,
      usernameValidator: (value) => usernameProblem(value) === null,
    }),
    // Sign in with a key chord: POST /api/auth/sign-in/fast-key.
    fastLogin(),
  ],
  // In production the API serves the frontend itself, so every request is
  // same-origin and this list is not consulted — including when the workshop
  // reaches the server by IP over the LAN (http://192.168.x.x:3000).
  //
  // It matters in development, where the browser is on :5173 and the API on
  // :3001. Add the machine's own address to work from a second computer:
  //   TRUSTED_ORIGINS=http://192.168.1.20:5173 npm run dev
  trustedOrigins: [
    'http://localhost:5173',
    ...(process.env.TRUSTED_ORIGINS?.split(',').map((o) => o.trim()).filter(Boolean) ?? []),
  ],
  user: {
    additionalFields: {
      // viewer | operator | manager | admin — enforced by requireRole middleware.
      // input: false → clients can never set their own role on signup.
      role: { type: 'string', defaultValue: 'operator', input: false },
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          if (adminCreateBypass.active) return { data: user };
          // First registered user becomes admin.
          if (userCount() === 0) {
            return { data: { ...user, role: 'admin' } };
          }
          throw new APIError('FORBIDDEN', {
            message:
              'Registration is closed. Ask an admin to create your account.',
          });
        },
      },
    },
  },
  session: {
    /**
     * A year, not thirty days — because how long a session lives is decided by
     * the cookie, not by this number.
     *
     * Two kinds of computer use this app. A shared bench machine gets a
     * *browser-session* cookie (better-auth's `rememberMe: false`), so closing
     * the browser ends it, and twenty minutes of silence ends it sooner. A
     * computer somebody has claimed gets a lasting cookie and is meant to
     * survive shutdowns indefinitely — with a thirty-day server expiry, that
     * person would be thrown out after a long holiday for no reason a user
     * could ever explain.
     *
     * Ending a claimed session is therefore always a deliberate act: signing
     * out, or an admin using POST /users/sessions/revoke-all.
     */
    expiresIn: 60 * 60 * 24 * 365,
    /** Refreshed at most daily, so an everyday machine never drifts near expiry. */
    updateAge: 60 * 60 * 24,
  },
});
