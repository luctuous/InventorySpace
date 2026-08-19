import { APIError, createAuthEndpoint, getSessionFromCtx } from 'better-auth/api';
import type { BetterAuthPlugin } from 'better-auth';
import { deleteSessionCookie, setSessionCookie } from 'better-auth/cookies';
import * as z from 'zod';
import { chordSchema } from '@inventory/shared';
import { userIdForChord } from '../services/fastkeys';

// Signing in with a key chord has to end in a real better-auth session cookie,
// and only better-auth can mint one. Rather than forge a cookie next door, this
// is a plugin: an extra endpoint that lives inside better-auth and uses its own
// session machinery, exactly the way the built-in anonymous plugin does.
//
// It is mounted at POST /api/auth/sign-in/fast-key.

/**
 * A chord is short enough to be guessed by a machine (there are a few thousand
 * of them), so the route is throttled rather than trusted. This is per process
 * and per address, and it is deliberately blunt: nobody presses a chord wrong
 * twelve times in a minute, and someone doing it from a script has to spend
 * more than a day on the search space instead of two seconds.
 */
const ATTEMPT_LIMIT = 12;
const WINDOW_MS = 60_000;
const attempts = new Map<string, { count: number; resetAt: number }>();

function tooManyAttempts(key: string): boolean {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now > entry.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > ATTEMPT_LIMIT;
}

/** A success clears the counter — a person who got it right is not an attacker. */
function clearAttempts(key: string): void {
  attempts.delete(key);
}

export const fastLogin = () =>
  ({
    id: 'fast-login',
    endpoints: {
      signInFastKey: createAuthEndpoint(
        '/sign-in/fast-key',
        {
          method: 'POST',
          body: z.object({
            chord: chordSchema,
            /**
             * Who, if anyone, has claimed this browser.
             *
             * A user id rather than a boolean, because a claimed computer is
             * claimed by ONE person: Anna's desk stays signed in as Anna
             * through shutdowns, and a colleague who presses their own chord
             * on it gets an ordinary session that times out. Sending an id
             * that is not yours does nothing — it only has an effect when it
             * equals the id the chord just proved you own.
             *
             * Without this, walking up to your own desk and using the shortcut
             * would silently un-claim it, and you would be thrown out at
             * lunchtime with no explanation anybody could give you.
             */
            rememberDeviceFor: z.string().optional(),
          }),
        },
        async (ctx) => {
          const source =
            ctx.request?.headers.get('x-forwarded-for') ??
            ctx.headers?.get('x-forwarded-for') ??
            'local';
          if (tooManyAttempts(source)) {
            throw new APIError('TOO_MANY_REQUESTS', {
              message: 'Too many chord attempts. Wait a minute, or sign in with your password.',
            });
          }

          const userId = userIdForChord(ctx.body.chord);
          // One message for "no such chord" and for "revoked account": telling
          // the difference apart is telling an attacker they found half of it.
          if (!userId) {
            throw new APIError('UNAUTHORIZED', { message: 'That chord is not registered' });
          }
          const user = await ctx.context.internalAdapter.findUserById(userId);
          if (!user) {
            throw new APIError('UNAUTHORIZED', { message: 'That chord is not registered' });
          }
          clearAttempts(source);

          // Your own chord, pressed while you are signed in, signs you out.
          // One gesture with one meaning — "make it me" — which reads as
          // sign in, switch user, or sign out depending on who is already
          // there, and none of those needs a second chord to remember.
          const current = await getSessionFromCtx(ctx, { disableRefresh: true });
          if (current?.user.id === user.id) {
            await ctx.context.internalAdapter.deleteSession(current.session.token);
            deleteSessionCookie(ctx);
            return ctx.json({ action: 'signed-out' as const, name: user.name });
          }

          // Switching users leaves no stale session behind on this machine.
          if (current) {
            await ctx.context.internalAdapter.deleteSession(current.session.token);
          }

          const session = await ctx.context.internalAdapter.createSession(user.id);
          if (!session) {
            throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Could not create a session' });
          }
          const claimed = ctx.body.rememberDeviceFor === user.id;
          await setSessionCookie(ctx, { session, user }, !claimed);
          return ctx.json({ action: 'signed-in' as const, name: user.name, remembered: claimed });
        },
      ),
    },
  }) satisfies BetterAuthPlugin;
