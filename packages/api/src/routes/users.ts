import { randomUUID } from 'node:crypto';
import { createRoute, z } from '@hono/zod-openapi';
import { and, count, eq, inArray } from 'drizzle-orm';
import {
  appUserSchema,
  fastKeySchema,
  isPlaceholderEmail,
  passwordChangeSchema,
  passwordResetSchema,
  placeholderEmail,
  userCreateSchema,
  userRoleUpdateSchema,
} from '@inventory/shared';
import { createRouter } from '../lib/router';
import { auth, adminCreateBypass } from '../auth';
import { db } from '../db/client';
import { account, session, user } from '../db/auth-schema';
import { fastKeys } from '../db/schema';
import { jsonBody, jsonContent, errorResponse } from '../lib/openapi';
import { requireRole } from '../middleware/auth';
import type { AuthEnv } from '../middleware/auth';
import { ApiError, notFoundError } from '../middleware/error';
import { clearFastKey, getFastKey, setFastKey } from '../services/fastkeys';

// Users admin: registration is closed after the first user,
// so admins create accounts here (name, username, role, temp password).
// User management is auth domain — it does not write inventory History.

export const usersRouter = createRouter<AuthEnv>();

const idParamPlain = z.object({ id: z.string().min(1) }); // better-auth ids are not UUIDs

function serializeUser(row: typeof user.$inferSelect, hasFastKey = false) {
  return {
    id: row.id,
    name: row.name,
    // A placeholder address is an implementation detail of better-auth, not
    // something anybody should ever be shown or asked to remember.
    email: isPlaceholderEmail(row.email) ? null : row.email,
    username: row.displayUsername ?? row.username ?? null,
    role: (row.role ?? 'operator') as 'viewer' | 'operator' | 'manager' | 'admin',
    createdAt: row.createdAt.toISOString(),
    hasFastKey,
  };
}

// --------------------------------------------------------------- GET /users
const listRoute = createRoute({
  method: 'get',
  path: '/users',
  tags: ['users'],
  middleware: [requireRole('admin')] as const,
  responses: {
    200: { description: 'All users', ...jsonContent(z.array(appUserSchema)) },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires admin role'),
  },
});

usersRouter.openapi(listRoute, (c) => {
  const rows = db.select().from(user).orderBy(user.createdAt).all();
  const withChords = new Set(
    db
      .select({ userId: fastKeys.userId })
      .from(fastKeys)
      .where(inArray(fastKeys.userId, rows.map((row) => row.id)))
      .all()
      .map((row) => row.userId),
  );
  return c.json(
    rows.map((row) => serializeUser(row, withChords.has(row.id))),
    200,
  );
});

// -------------------------------------------------------------- POST /users
const createRoute_ = createRoute({
  method: 'post',
  path: '/users',
  tags: ['users'],
  middleware: [requireRole('admin')] as const,
  request: jsonBody(userCreateSchema),
  responses: {
    201: { description: 'Created user', ...jsonContent(appUserSchema) },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires admin role'),
    409: errorResponse('Username or email already taken'),
  },
});

usersRouter.openapi(createRoute_, async (c) => {
  const body = c.req.valid('json');
  // The username is the identity; an address is optional and only useful for
  // linking to a mailbox later, so accounts without one get a placeholder.
  const email = body.email ?? placeholderEmail(body.username, randomUUID().slice(0, 8));

  adminCreateBypass.active = true;
  try {
    await auth.api.signUpEmail({
      body: { email, password: body.password, name: body.name, username: body.username },
    });
  } catch (error) {
    throw new ApiError(409, 'user_create_failed', error instanceof Error ? error.message : String(error));
  } finally {
    adminCreateBypass.active = false;
  }

  // role is input:false in better-auth (clients can never self-assign),
  // so the admin-chosen role is applied directly afterwards.
  db.update(user).set({ role: body.role }).where(eq(user.email, email)).run();
  const row = db.select().from(user).where(eq(user.email, email)).get()!;
  return c.json(serializeUser(row), 201);
});

// ---------------------------------------------------- PATCH /users/:id/role
const roleRoute = createRoute({
  method: 'patch',
  path: '/users/{id}/role',
  tags: ['users'],
  middleware: [requireRole('admin')] as const,
  request: { params: idParamPlain, ...jsonBody(userRoleUpdateSchema) },
  responses: {
    200: { description: 'Updated user', ...jsonContent(appUserSchema) },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires admin role'),
    404: errorResponse('Not found'),
    409: errorResponse('Cannot change your own role'),
  },
});

// -------------------------------------------------- POST /users/me/password
const changeOwnRoute = createRoute({
  method: 'post',
  path: '/users/me/password',
  tags: ['users'],
  middleware: [requireRole('viewer')] as const, // anyone signed in
  request: jsonBody(passwordChangeSchema),
  responses: {
    200: { description: 'Password changed', ...jsonContent(z.object({ ok: z.boolean() })) },
    400: errorResponse('Current password is wrong'),
    401: errorResponse('Not signed in'),
  },
});

usersRouter.openapi(changeOwnRoute, async (c) => {
  const { currentPassword, newPassword } = c.req.valid('json');
  try {
    // better-auth verifies the current password itself; we never see the hash.
    await auth.api.changePassword({
      body: { currentPassword, newPassword, revokeOtherSessions: true },
      headers: c.req.raw.headers,
    });
  } catch (error) {
    throw new ApiError(
      400,
      'password_change_failed',
      error instanceof Error ? error.message : String(error),
    );
  }
  return c.json({ ok: true }, 200);
});

// ------------------------------------------------ POST /users/:id/password
const resetRoute = createRoute({
  method: 'post',
  path: '/users/{id}/password',
  tags: ['users'],
  middleware: [requireRole('admin')] as const,
  request: { params: idParamPlain, ...jsonBody(passwordResetSchema) },
  responses: {
    200: { description: 'Password reset', ...jsonContent(z.object({ ok: z.boolean() })) },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires admin role'),
    404: errorResponse('Not found'),
  },
});

usersRouter.openapi(resetRoute, async (c) => {
  const { id } = c.req.valid('param');
  const { newPassword } = c.req.valid('json');

  const row = db.select().from(user).where(eq(user.id, id)).get();
  if (!row) throw notFoundError('user', id);

  const hash = await auth.$context.then((ctx) => ctx.password.hash(newPassword));
  db.update(account)
    .set({ password: hash })
    .where(and(eq(account.userId, id), eq(account.providerId, 'credential')))
    .run();

  // Force them to sign in again with the new password everywhere.
  db.delete(session).where(eq(session.userId, id)).run();
  return c.json({ ok: true }, 200);
});

// ------------------------------------------- POST /users/sessions/revoke-all
/**
 * Sign everyone out, everywhere — including the computers people have claimed.
 *
 * A claimed computer never signs itself out; that is the whole point of
 * claiming it. So there has to be one lever that ends every session in the
 * building at once: someone leaves the group, a laptop goes missing, a
 * password gets shoulder-surfed. It takes the admin's own session down too,
 * which is the honest behaviour — "everyone" includes you.
 */
const revokeAllSessionsRoute = createRoute({
  method: 'post',
  path: '/users/sessions/revoke-all',
  tags: ['users'],
  middleware: [requireRole('admin')] as const,
  responses: {
    200: {
      description: 'Every session deleted, on every device',
      ...jsonContent(z.object({ ok: z.boolean(), sessions: z.number().int() })),
    },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires admin role'),
  },
});

usersRouter.openapi(revokeAllSessionsRoute, (c) => {
  const total = db.select({ n: count() }).from(session).get()?.n ?? 0;
  db.delete(session).run();
  return c.json({ ok: true, sessions: total }, 200);
});

// -------------------------------------------------- Fast login
// Yours to create, yours to see, yours to throw away — plus an admin revoke,
// because the one thing a shared shortcut needs is a way to take it back.

const myFastKeyRoute = createRoute({
  method: 'get',
  path: '/users/me/fast-key',
  tags: ['users'],
  middleware: [requireRole('viewer')] as const,
  responses: {
    200: { description: 'Your key chord', ...jsonContent(fastKeySchema) },
    401: errorResponse('Not signed in'),
  },
});

usersRouter.openapi(myFastKeyRoute, (c) => {
  const row = getFastKey(c.get('user').id);
  return c.json({ chord: row?.chord ?? null, createdAt: row?.createdAt.toISOString() ?? null }, 200);
});

const newFastKeyRoute = createRoute({
  method: 'post',
  path: '/users/me/fast-key',
  tags: ['users'],
  middleware: [requireRole('viewer')] as const,
  responses: {
    200: { description: 'Your key chord', ...jsonContent(fastKeySchema) },
    401: errorResponse('Not signed in'),
    409: errorResponse('No unused chord is left'),
  },
});

usersRouter.openapi(newFastKeyRoute, (c) => {
  // POST always generates a fresh one: "I don't like this chord" and "I have
  // no chord yet" are the same request, and neither takes an argument.
  const created = setFastKey(c.get('user').id);
  return c.json({ chord: created.chord, createdAt: created.createdAt.toISOString() }, 200);
});

const dropFastKeyRoute = createRoute({
  method: 'delete',
  path: '/users/me/fast-key',
  tags: ['users'],
  middleware: [requireRole('viewer')] as const,
  responses: {
    200: { description: 'Your key chord', ...jsonContent(fastKeySchema) },
    401: errorResponse('Not signed in'),
  },
});

usersRouter.openapi(dropFastKeyRoute, (c) => {
  clearFastKey(c.get('user').id);
  return c.json({ chord: null, createdAt: null }, 200);
});

const revokeFastKeyRoute = createRoute({
  method: 'delete',
  path: '/users/{id}/fast-key',
  tags: ['users'],
  middleware: [requireRole('admin')] as const,
  request: { params: idParamPlain },
  responses: {
    200: { description: 'Chord revoked', ...jsonContent(z.object({ ok: z.boolean() })) },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires admin role'),
    404: errorResponse('Not found'),
  },
});

usersRouter.openapi(revokeFastKeyRoute, (c) => {
  const { id } = c.req.valid('param');
  if (!db.select().from(user).where(eq(user.id, id)).get()) throw notFoundError('user', id);
  clearFastKey(id);
  return c.json({ ok: true }, 200);
});

usersRouter.openapi(roleRoute, (c) => {
  const { id } = c.req.valid('param');
  const { role } = c.req.valid('json');
  const me = c.get('user');

  // Guard against locking yourself out of the admin area.
  if (id === me.id) {
    throw new ApiError(409, 'own_role', 'You cannot change your own role');
  }
  const row = db.select().from(user).where(eq(user.id, id)).get();
  if (!row) throw notFoundError('user', id);

  db.update(user).set({ role }).where(eq(user.id, id)).run();
  return c.json(serializeUser(db.select().from(user).where(eq(user.id, id)).get()!), 200);
});
