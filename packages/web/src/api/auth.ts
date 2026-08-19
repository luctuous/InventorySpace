import { createAuthClient } from 'better-auth/react';
import { usernameClient } from 'better-auth/client/plugins';
import type { UserRole } from '@inventory/shared';

// Talks to /api/auth/* (same origin; proxied to the API in dev).
// usernameClient mirrors the server's username plugin → signIn.username().
export const authClient = createAuthClient({
  plugins: [usernameClient()],
});

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
}

/** The server adds `role` as an additional field; the client type doesn't know it. */
export function asSessionUser(user: { id: string; name: string; email: string }): SessionUser {
  return user as SessionUser;
}
