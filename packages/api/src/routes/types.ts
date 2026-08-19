import { createRoute, z } from '@hono/zod-openapi';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import { typeCreateSchema, typeSchema, typeUpdateSchema, typeWithCountSchema } from '@inventory/shared';
import { createRouter } from '../lib/router';
import { db } from '../db/client';
import { items, types } from '../db/schema';
import { jsonBody, jsonContent, errorResponse, idParam } from '../lib/openapi';
import { serializeAudit } from '../lib/serialize';
import { requireRole } from '../middleware/auth';
import type { AuthEnv } from '../middleware/auth';
import { ApiError, notFoundError } from '../middleware/error';
import { logEvent } from '../services/history';

export const typesRouter = createRouter<AuthEnv>();

function itemCountByType(): Record<string, number> {
  const rows = db
    .select({ typeId: items.typeId, n: count() })
    .from(items)
    .where(isNull(items.deletedAt))
    .groupBy(items.typeId)
    .all();
  return Object.fromEntries(rows.map((r) => [r.typeId, r.n]));
}

function getActiveType(id: string) {
  const row = db
    .select()
    .from(types)
    .where(and(eq(types.id, id), isNull(types.deletedAt)))
    .get();
  if (!row) throw notFoundError('type', id);
  return row;
}

// -------------------------------------------------------------- GET /types
const listRoute = createRoute({
  method: 'get',
  path: '/types',
  tags: ['types'],
  middleware: [requireRole('viewer')] as const,
  responses: {
    200: { description: 'All types', ...jsonContent(z.array(typeWithCountSchema)) },
    401: errorResponse('Not signed in'),
  },
});

typesRouter.openapi(listRoute, (c) => {
  const counts = itemCountByType();
  const rows = db.select().from(types).where(isNull(types.deletedAt)).orderBy(types.key).all();
  return c.json(
    rows.map((row) => ({ ...serializeAudit(row), itemCount: counts[row.id] ?? 0 })),
    200,
  );
});

// ------------------------------------------------------------- POST /types
const createRoute_ = createRoute({
  method: 'post',
  path: '/types',
  tags: ['types'],
  middleware: [requireRole('admin')] as const,
  request: jsonBody(typeCreateSchema),
  responses: {
    201: { description: 'Created type', ...jsonContent(typeSchema) },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires admin role'),
    409: errorResponse('Duplicate key or prefix'),
  },
});

typesRouter.openapi(createRoute_, (c) => {
  const body = c.req.valid('json');
  const user = c.get('user');

  const dupKey = db.select().from(types).where(eq(types.key, body.key)).get();
  if (dupKey) throw new ApiError(409, 'duplicate_key', `Type key '${body.key}' already exists`);

  const row = db.transaction(() => {
    const id = crypto.randomUUID();
    db.insert(types).values({ id, ...body }).run();
    logEvent({
      entityType: 'type',
      entityId: id,
      entityHumanId: body.key,
      action: 'created',
      valueAfter: body,
      userId: user.id,
    });
    return db.select().from(types).where(eq(types.id, id)).get()!;
  });
  return c.json(serializeAudit(row), 201);
});

// -------------------------------------------------------- PATCH /types/:id
const updateRoute = createRoute({
  method: 'patch',
  path: '/types/{id}',
  tags: ['types'],
  middleware: [requireRole('admin')] as const,
  request: { params: idParam, ...jsonBody(typeUpdateSchema) },
  responses: {
    200: { description: 'Updated type', ...jsonContent(typeSchema) },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires admin role'),
    404: errorResponse('Not found'),
  },
});

typesRouter.openapi(updateRoute, (c) => {
  const { id } = c.req.valid('param');
  const { fieldKeyRenames, ...body } = c.req.valid('json'); // type key stays immutable
  const user = c.get('user');

  const updated = db.transaction(() => {
    const before = getActiveType(id);

    // A field key is the key inside every Item.customFields JSON, so renaming
    // one has to carry the stored values across or they are orphaned. SQLite's
    // JSON functions do it in a single statement, inside this transaction.
    for (const [oldKey, newKey] of Object.entries(fieldKeyRenames ?? {})) {
      if (oldKey === newKey) continue;
      if (!/^[a-z][a-zA-Z0-9_]*$/.test(newKey)) {
        throw new ApiError(400, 'invalid_field_key', `'${newKey}' is not a valid field key`);
      }
      if (before.fieldDefinitions.some((def) => def.key === newKey)) {
        throw new ApiError(409, 'duplicate_field_key', `Field key '${newKey}' already exists`);
      }
      db.update(items)
        .set({
          customFields: sql`json_remove(json_set(${items.customFields}, '$.' || ${newKey}, json_extract(${items.customFields}, '$.' || ${oldKey})), '$.' || ${oldKey})`,
        })
        .where(
          and(
            eq(items.typeId, id),
            sql`json_type(${items.customFields}, '$.' || ${oldKey}) IS NOT NULL`,
          ),
        )
        .run();
      logEvent({
        entityType: 'type',
        entityId: id,
        entityHumanId: before.key,
        action: 'updated',
        fieldChanged: 'fieldDefinitions.key',
        valueBefore: oldKey,
        valueAfter: newKey,
        notes: 'field key renamed; stored item values migrated',
        userId: user.id,
      });
    }

    db.update(types).set(body).where(eq(types.id, id)).run();

    const beforeRecord = before as unknown as Record<string, unknown>;
    for (const [field, after] of Object.entries(body)) {
      if (after === undefined) continue;
      const prev = beforeRecord[field] ?? null;
      if (JSON.stringify(prev) === JSON.stringify(after)) continue;
      logEvent({
        entityType: 'type',
        entityId: id,
        entityHumanId: before.key,
        action: 'updated',
        fieldChanged: field,
        valueBefore: prev,
        valueAfter: after,
        userId: user.id,
      });
    }
    return db.select().from(types).where(eq(types.id, id)).get()!;
  });
  return c.json(serializeAudit(updated), 200);
});

// ------------------------------------------------------- DELETE /types/:id
const deleteRoute = createRoute({
  method: 'delete',
  path: '/types/{id}',
  tags: ['types'],
  middleware: [requireRole('admin')] as const,
  request: { params: idParam },
  responses: {
    200: { description: 'Soft-deleted type', ...jsonContent(typeSchema) },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires admin role'),
    404: errorResponse('Not found'),
    409: errorResponse('Items of this type exist'),
  },
});

typesRouter.openapi(deleteRoute, (c) => {
  const { id } = c.req.valid('param');
  const user = c.get('user');

  const deleted = db.transaction(() => {
    const row = getActiveType(id);
    const inUse =
      db
        .select({ n: count() })
        .from(items)
        .where(and(eq(items.typeId, id), isNull(items.deletedAt)))
        .get()?.n ?? 0;
    if (inUse > 0) {
      throw new ApiError(409, 'type_in_use', `Cannot delete: ${inUse} item(s) use this type`, {
        itemCount: inUse,
      });
    }
    db.update(types).set({ deletedAt: new Date() }).where(eq(types.id, id)).run();
    logEvent({
      entityType: 'type',
      entityId: id,
      entityHumanId: row.key,
      action: 'soft_deleted',
      userId: user.id,
    });
    return db.select().from(types).where(eq(types.id, id)).get()!;
  });
  return c.json(serializeAudit(deleted), 200);
});
