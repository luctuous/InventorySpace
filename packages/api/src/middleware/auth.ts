import { createMiddleware } from 'hono/factory';
import { roleAtLeast } from '@inventory/shared';
import type { UserRole } from '@inventory/shared';
import { auth } from '../auth';
import { ApiError } from './error';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

// Hono lets routes declare what lives in their context; every guarded route
// can then read c.get('user') fully typed.
export interface AuthEnv {
  Variables: { user: AuthUser };
}

/**
 * Session guard + role gate in one middleware:
 * requireRole('operator') → any signed-in operator, manager or admin passes.
 * The UI hides what the API would reject — but THIS is the real enforcement.
 */
export function requireRole(minimum: UserRole) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) {
      throw new ApiError(401, 'unauthenticated', 'Sign in required');
    }
    const user = session.user as unknown as AuthUser;
    if (!roleAtLeast(user.role, minimum)) {
      throw new ApiError(403, 'forbidden', `Requires ${minimum} role or higher`);
    }
    c.set('user', user);
    await next();
  });
}

/** Signed-in check with no minimum role (viewers included). */
export const requireAuth = requireRole('viewer');
