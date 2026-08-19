import { createRoute, z } from '@hono/zod-openapi';
import { and, count, eq, inArray, isNull } from 'drizzle-orm';
import {
  locationCreateSchema,
  locationSchema,
  locationUpdateSchema,
  locationWithCountSchema,
} from '@inventory/shared';
import { createRouter } from '../lib/router';
import { db } from '../db/client';
import { items, locations } from '../db/schema';
import { jsonBody, jsonContent, errorResponse, idParam } from '../lib/openapi';
import { serializeAudit } from '../lib/serialize';
import { requireRole } from '../middleware/auth';
import type { AuthEnv } from '../middleware/auth';
import { ApiError, notFoundError } from '../middleware/error';
import { cascadeFromLocation } from '../services/cascade';
import { logEvent } from '../services/history';

export const locationsRouter = createRouter<AuthEnv>();

/**
 * The whole tree is tiny (a building, not a warehouse chain), so subtree
 * questions are answered by fetching all rows and walking parentId in JS —
 * the fetch-all choice explicitly allows. Used by the DELETE
 * guard here and by the items location filter.
 */
export function subtreeIds(rootId: string): string[] {
  const all = db
    .select({ id: locations.id, parentId: locations.parentId })
    .from(locations)
    .where(isNull(locations.deletedAt))
    .all();
  const children = new Map<string | null, string[]>();
  for (const row of all) {
    const list = children.get(row.parentId) ?? [];
    list.push(row.id);
    children.set(row.parentId, list);
  }
  const result: string[] = [];
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.pop()!;
    result.push(id);
    queue.push(...(children.get(id) ?? []));
  }
  return result;
}

function getActiveLocation(id: string) {
  const row = db
    .select()
    .from(locations)
    .where(and(eq(locations.id, id), isNull(locations.deletedAt)))
    .get();
  if (!row) throw notFoundError('location', id);
  return row;
}

// ---------------------------------------------------------- GET /locations
const listRoute = createRoute({
  method: 'get',
  path: '/locations',
  tags: ['locations'],
  middleware: [requireRole('viewer')] as const,
  responses: {
    200: {
      description: 'Flat list with parentId (client builds the tree) + active item counts',
      ...jsonContent(z.array(locationWithCountSchema)),
    },
    401: errorResponse('Not signed in'),
  },
});

locationsRouter.openapi(listRoute, (c) => {
  const counts = Object.fromEntries(
    db
      .select({ locationId: items.locationId, n: count() })
      .from(items)
      .where(isNull(items.deletedAt))
      .groupBy(items.locationId)
      .all()
      .map((r) => [r.locationId ?? '', r.n]),
  );
  const rows = db
    .select()
    .from(locations)
    .where(isNull(locations.deletedAt))
    .orderBy(locations.code)
    .all();
  return c.json(
    rows.map((row) => ({ ...serializeAudit(row), itemCount: counts[row.id] ?? 0 })),
    200,
  );
});

// --------------------------------------------------------- POST /locations
const createRoute_ = createRoute({
  method: 'post',
  path: '/locations',
  tags: ['locations'],
  middleware: [requireRole('manager')] as const,
  request: jsonBody(locationCreateSchema),
  responses: {
    201: { description: 'Created location', ...jsonContent(locationSchema) },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires manager role'),
    409: errorResponse('Duplicate code'),
  },
});

locationsRouter.openapi(createRoute_, (c) => {
  const body = c.req.valid('json');
  const user = c.get('user');

  const dup = db.select().from(locations).where(eq(locations.code, body.code)).get();
  if (dup) throw new ApiError(409, 'duplicate_code', `Location code '${body.code}' already exists`);
  if (body.parentId) getActiveLocation(body.parentId); // 404 if bogus parent

  const row = db.transaction(() => {
    const id = crypto.randomUUID();
    db.insert(locations)
      .values({
        id,
        code: body.code,
        level: body.level,
        name: body.name ?? null,
        parentId: body.parentId ?? null,
      })
      .run();
    logEvent({
      entityType: 'location',
      entityId: id,
      entityHumanId: body.code,
      action: 'created',
      valueAfter: body,
      userId: user.id,
    });
    return db.select().from(locations).where(eq(locations.id, id)).get()!;
  });
  return c.json(serializeAudit(row), 201);
});

// ---------------------------------------------------- PATCH /locations/:id
const updateRoute = createRoute({
  method: 'patch',
  path: '/locations/{id}',
  tags: ['locations'],
  middleware: [requireRole('manager')] as const,
  request: { params: idParam, ...jsonBody(locationUpdateSchema) },
  responses: {
    200: { description: 'Updated location', ...jsonContent(locationSchema) },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires manager role'),
    404: errorResponse('Not found'),
  },
});

locationsRouter.openapi(updateRoute, (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const user = c.get('user');

  const updated = db.transaction(() => {
    const before = getActiveLocation(id);
    db.update(locations)
      .set({
        ...(body.code !== undefined ? { code: body.code } : {}),
        ...(body.level !== undefined ? { level: body.level } : {}),
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.parentId !== undefined ? { parentId: body.parentId } : {}),
      })
      .where(eq(locations.id, id))
      .run();

    const beforeRecord = before as unknown as Record<string, unknown>;
    for (const [field, after] of Object.entries(body)) {
      if (after === undefined) continue;
      const prev = beforeRecord[field] ?? null;
      if (JSON.stringify(prev) === JSON.stringify(after)) continue;
      logEvent({
        entityType: 'location',
        entityId: id,
        entityHumanId: before.code,
        action: 'updated',
        fieldChanged: field,
        valueBefore: prev,
        valueAfter: after,
        userId: user.id,
      });
    }
    return db.select().from(locations).where(eq(locations.id, id)).get()!;
  });
  return c.json(serializeAudit(updated), 200);
});

// --------------------------------------------------- DELETE /locations/:id
const deleteRoute = createRoute({
  method: 'delete',
  path: '/locations/{id}',
  tags: ['locations'],
  middleware: [requireRole('manager')] as const,
  request: {
    params: idParam,
    query: z.object({ cascade: z.enum(['true', 'false']).optional() }),
  },
  responses: {
    200: { description: 'Soft-deleted location', ...jsonContent(locationSchema) },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires manager role'),
    404: errorResponse('Not found'),
    409: errorResponse('Active items in this subtree'),
  },
});

locationsRouter.openapi(deleteRoute, (c) => {
  const { id } = c.req.valid('param');
  const cascade = c.req.valid('query').cascade === 'true';
  const user = c.get('user');

  const deleted = db.transaction(() => {
    const row = getActiveLocation(id);

    const subtree = subtreeIds(id);
    // Items are never cascaded away with a location: deleting a shelf must not
    // delete the stock standing on it. Move or delete the items first.
    const active =
      db
        .select({ n: count() })
        .from(items)
        .where(and(inArray(items.locationId, subtree), isNull(items.deletedAt)))
        .get()?.n ?? 0;
    if (active > 0) {
      throw new ApiError(
        409,
        'location_in_use',
        `Cannot delete: ${active} item(s) in this location or its sub-locations`,
        { itemCount: active },
      );
    }
    const childCount = subtree.length - 1;
    if (childCount > 0 && !cascade) {
      throw new ApiError(
        409,
        'location_has_children',
        `Cannot delete: ${childCount} sub-location(s) exist. Delete them first.`,
        { childCount, cascade: { locations: childCount } },
      );
    }
    if (cascade) cascadeFromLocation(subtree, id, user.id);

    db.update(locations).set({ deletedAt: new Date() }).where(eq(locations.id, id)).run();
    logEvent({
      entityType: 'location',
      entityId: id,
      entityHumanId: row.code,
      action: 'soft_deleted',
      userId: user.id,
    });
    return db.select().from(locations).where(eq(locations.id, id)).get()!;
  });
  return c.json(serializeAudit(deleted), 200);
});
