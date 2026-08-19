import { createRoute, z } from '@hono/zod-openapi';
import { and, count, eq, isNull, like, sql } from 'drizzle-orm';
import {
  analogousCreateSchema,
  analogousSchema,
  analogousUpdateSchema,
  analogousWithCountSchema,
  listResponseSchema,
  paginationQuerySchema,
} from '@inventory/shared';
import { createRouter } from '../lib/router';
import { db } from '../db/client';
import { analogous, concepts, items, variants } from '../db/schema';
import { jsonBody, jsonContent, errorResponse, idParam } from '../lib/openapi';
import { serializeAudit } from '../lib/serialize';
import { requireRole } from '../middleware/auth';
import type { AuthEnv } from '../middleware/auth';
import { ApiError, notFoundError } from '../middleware/error';
import { cascadeFromAnalogous, previewAnalogousCascade } from '../services/cascade';
import { logEvent } from '../services/history';
import { generateHumanId } from '../services/ids';

export const analogousRouter = createRouter<AuthEnv>();

function getActive(id: string) {
  const row = db
    .select()
    .from(analogous)
    .where(and(eq(analogous.id, id), isNull(analogous.deletedAt)))
    .get();
  if (!row) throw notFoundError('analogous', id);
  return row;
}

function countBy<T extends { conceptId?: string | null; analogousId?: string | null }>(
  rows: Array<{ key: string | null; n: number }>,
): Record<string, number> {
  return Object.fromEntries(rows.filter((r) => r.key !== null).map((r) => [r.key!, r.n]));
}

// ------------------------------------------------------------ GET /analogous
const listRoute = createRoute({
  method: 'get',
  path: '/analogous',
  tags: ['analogous'],
  middleware: [requireRole('viewer')] as const,
  request: {
    query: paginationQuerySchema.extend({
      conceptId: z.uuid().optional(),
      search: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: 'Paginated analogous groups with counts',
      ...jsonContent(listResponseSchema(analogousWithCountSchema)),
    },
    401: errorResponse('Not signed in'),
  },
});

analogousRouter.openapi(listRoute, (c) => {
  const { page, perPage, conceptId, search } = c.req.valid('query');

  const conditions = [isNull(analogous.deletedAt)];
  if (conceptId) conditions.push(eq(analogous.conceptId, conceptId));
  if (search)
    conditions.push(like(sql`lower(${analogous.name})`, `%${search.toLowerCase()}%`));
  const where = and(...conditions);

  const total = db.select({ n: count() }).from(analogous).where(where).get()?.n ?? 0;
  const rows = db
    .select({
      row: analogous,
      conceptName: concepts.name,
      conceptHumanId: concepts.humanId,
    })
    .from(analogous)
    .leftJoin(concepts, eq(analogous.conceptId, concepts.id))
    .where(where)
    .orderBy(analogous.humanId)
    .limit(perPage)
    .offset((page - 1) * perPage)
    .all();

  const variantCounts = countBy(
    db
      .select({ key: variants.analogousId, n: count() })
      .from(variants)
      .where(isNull(variants.deletedAt))
      .groupBy(variants.analogousId)
      .all(),
  );
  const itemCounts = countBy(
    db
      .select({ key: items.analogousId, n: count() })
      .from(items)
      .where(isNull(items.deletedAt))
      .groupBy(items.analogousId)
      .all(),
  );

  return c.json(
    {
      data: rows.map(({ row, conceptName, conceptHumanId }) => ({
        ...serializeAudit(row),
        conceptName,
        conceptHumanId,
        variantCount: variantCounts[row.id] ?? 0,
        itemCount: itemCounts[row.id] ?? 0,
      })),
      meta: { page, perPage, total, totalPages: Math.max(1, Math.ceil(total / perPage)) },
    },
    200,
  );
});

// ----------------------------------------------------------- POST /analogous
const createRoute_ = createRoute({
  method: 'post',
  path: '/analogous',
  tags: ['analogous'],
  middleware: [requireRole('manager')] as const,
  request: jsonBody(analogousCreateSchema),
  responses: {
    201: { description: 'Created analogous', ...jsonContent(analogousSchema) },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires manager role'),
    404: errorResponse('Concept not found'),
  },
});

analogousRouter.openapi(createRoute_, (c) => {
  const body = c.req.valid('json');
  const user = c.get('user');

  const concept = db
    .select()
    .from(concepts)
    .where(and(eq(concepts.id, body.conceptId), isNull(concepts.deletedAt)))
    .get();
  if (!concept) throw notFoundError('concept', body.conceptId);

  const row = db.transaction(() => {
    const id = crypto.randomUUID();
    const humanId = generateHumanId('ANA', 'simple');
    db.insert(analogous)
      .values({ id, humanId, conceptId: body.conceptId, name: body.name, notes: body.notes ?? null })
      .run();
    logEvent({
      entityType: 'analogous',
      entityId: id,
      entityHumanId: humanId,
      action: 'created',
      valueAfter: body,
      userId: user.id,
    });
    return db.select().from(analogous).where(eq(analogous.id, id)).get()!;
  });
  return c.json(serializeAudit(row), 201);
});

// ------------------------------------------------------ PATCH /analogous/:id
const updateRoute = createRoute({
  method: 'patch',
  path: '/analogous/{id}',
  tags: ['analogous'],
  middleware: [requireRole('manager')] as const,
  request: { params: idParam, ...jsonBody(analogousUpdateSchema) },
  responses: {
    200: { description: 'Updated analogous', ...jsonContent(analogousSchema) },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires manager role'),
    404: errorResponse('Not found'),
  },
});

analogousRouter.openapi(updateRoute, (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const user = c.get('user');

  const updated = db.transaction(() => {
    const before = getActive(id);

    // THE denormalization sync: re-parenting an analogous to a
    // different concept mass-updates every variant and item that hangs off it,
    // in this same transaction — all or nothing.
    if (body.conceptId && body.conceptId !== before.conceptId) {
      const target = db
        .select()
        .from(concepts)
        .where(and(eq(concepts.id, body.conceptId), isNull(concepts.deletedAt)))
        .get();
      if (!target) throw notFoundError('concept', body.conceptId);

      db.update(variants)
        .set({ conceptId: body.conceptId })
        .where(eq(variants.analogousId, id))
        .run();
      db.update(items)
        .set({ conceptId: body.conceptId })
        .where(eq(items.analogousId, id))
        .run();
    }

    db.update(analogous)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.conceptId !== undefined ? { conceptId: body.conceptId } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
      })
      .where(eq(analogous.id, id))
      .run();

    const beforeRecord = before as unknown as Record<string, unknown>;
    for (const [field, after] of Object.entries(body)) {
      if (after === undefined) continue;
      const prev = beforeRecord[field] ?? null;
      if (JSON.stringify(prev) === JSON.stringify(after)) continue;
      logEvent({
        entityType: 'analogous',
        entityId: id,
        entityHumanId: before.humanId,
        action: 'updated',
        fieldChanged: field,
        valueBefore: prev,
        valueAfter: after,
        userId: user.id,
      });
    }
    return db.select().from(analogous).where(eq(analogous.id, id)).get()!;
  });
  return c.json(serializeAudit(updated), 200);
});

// ----------------------------------------------------- DELETE /analogous/:id
const deleteRoute = createRoute({
  method: 'delete',
  path: '/analogous/{id}',
  tags: ['analogous'],
  middleware: [requireRole('manager')] as const,
  request: {
    params: idParam,
    query: z.object({ cascade: z.enum(['true', 'false']).optional() }),
  },
  responses: {
    200: { description: 'Soft-deleted analogous', ...jsonContent(analogousSchema) },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires manager role'),
    404: errorResponse('Not found'),
    409: errorResponse('Variants still reference this analogous'),
  },
});

analogousRouter.openapi(deleteRoute, (c) => {
  const { id } = c.req.valid('param');
  const cascade = c.req.valid('query').cascade === 'true';
  const user = c.get('user');

  const deleted = db.transaction(() => {
    const row = getActive(id);
    const linked =
      db
        .select({ n: count() })
        .from(variants)
        .where(and(eq(variants.analogousId, id), isNull(variants.deletedAt)))
        .get()?.n ?? 0;
    if (linked > 0 && !cascade) {
      throw new ApiError(
        409,
        'analogous_in_use',
        `Cannot delete: ${linked} variant(s) still reference this analogous group`,
        { variantCount: linked, cascade: previewAnalogousCascade(id) },
      );
    }
    if (cascade) cascadeFromAnalogous(id, user.id);
    db.update(analogous).set({ deletedAt: new Date() }).where(eq(analogous.id, id)).run();
    logEvent({
      entityType: 'analogous',
      entityId: id,
      entityHumanId: row.humanId,
      action: 'soft_deleted',
      userId: user.id,
    });
    return db.select().from(analogous).where(eq(analogous.id, id)).get()!;
  });
  return c.json(serializeAudit(deleted), 200);
});
