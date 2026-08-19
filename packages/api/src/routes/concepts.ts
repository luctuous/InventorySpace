import { createRoute, z } from '@hono/zod-openapi';
import { and, count, eq, isNull, like, sql } from 'drizzle-orm';
import {
  analogousSchema,
  conceptCreateSchema,
  conceptSchema,
  conceptUpdateSchema,
  conceptWithStockSchema,
  errorResponseSchema,
  listResponseSchema,
  paginationQuerySchema,
} from '@inventory/shared';
import { createRouter } from '../lib/router';
import { db } from '../db/client';
import { analogous, concepts } from '../db/schema';
import { serializeAudit } from '../lib/serialize';
import { requireRole } from '../middleware/auth';
import type { AuthEnv } from '../middleware/auth';
import { ApiError, notFoundError } from '../middleware/error';
import { cascadeFromConcept, previewConceptCascade } from '../services/cascade';
import { logEvent } from '../services/history';
import { generateHumanId } from '../services/ids';
import { stockByConcept, stockForConcept } from '../services/stock';
import { subtreeIds } from './locations';

// This file is the reference pattern for every entity router:
//   createRoute (OpenAPI) → requireRole middleware → handler →
//   mutations inside ONE db.transaction that also writes History.

export const conceptsRouter = createRouter<AuthEnv>();

const jsonContent = <T extends z.ZodType>(schema: T) => ({
  content: { 'application/json': { schema } },
});
const errorResponse = (description: string) => ({
  description,
  ...jsonContent(errorResponseSchema),
});

const idParam = z.object({ id: z.uuid() });

function analogousCountMap(): Record<string, number> {
  const rows = db
    .select({ conceptId: analogous.conceptId, n: count() })
    .from(analogous)
    .where(isNull(analogous.deletedAt))
    .groupBy(analogous.conceptId)
    .all();
  return Object.fromEntries(rows.map((r) => [r.conceptId, r.n]));
}

function getActiveConcept(id: string) {
  const row = db
    .select()
    .from(concepts)
    .where(and(eq(concepts.id, id), isNull(concepts.deletedAt)))
    .get();
  if (!row) throw notFoundError('concept', id);
  return row;
}

// ---------------------------------------------------------------- GET /concepts
const listRoute = createRoute({
  method: 'get',
  path: '/concepts',
  tags: ['concepts'],
  middleware: [requireRole('viewer')] as const,
  request: {
    query: paginationQuerySchema.extend({
      search: z.string().optional(),
      /** Home passes this: instruments and documents are not stock. */
      stockOnly: z.enum(['true', 'false']).optional(),
    }),
  },
  responses: {
    200: {
      description: 'Paginated concepts with computed stock',
      ...jsonContent(listResponseSchema(conceptWithStockSchema)),
    },
    401: errorResponse('Not signed in'),
  },
});

conceptsRouter.openapi(listRoute, (c) => {
  const { page, perPage, search, stockOnly } = c.req.valid('query');

  const conditions = [isNull(concepts.deletedAt)];
  if (search) {
    // name is a JSON text column ({"en":…,"de":…,"ca":…}) — a LIKE over the
    // raw JSON searches every language at once.
    conditions.push(like(sql`lower(${concepts.name})`, `%${search.toLowerCase()}%`));
  }
  if (stockOnly === 'true') {
    // A concept counts as stock when any of its live items is of a type that
    // does. One with no items at all is kept: it has simply not been used yet,
    // and hiding it would make new concepts look broken.
    conditions.push(
      sql`not exists (
        select 1 from items
        join types on types.id = items.type_id
        where items.concept_id = ${concepts.id}
          and items.deleted_at is null
      ) or exists (
        select 1 from items
        join types on types.id = items.type_id
        where items.concept_id = ${concepts.id}
          and items.deleted_at is null
          and types.counts_as_stock = 1
      )`,
    );
  }
  const where = and(...conditions);

  const total = db.select({ n: count() }).from(concepts).where(where).get()?.n ?? 0;
  const rows = db
    .select()
    .from(concepts)
    .where(where)
    .orderBy(concepts.humanId)
    .limit(perPage)
    .offset((page - 1) * perPage)
    .all();

  const stocks = stockByConcept();
  const anaCounts = analogousCountMap();

  return c.json(
    {
      data: rows.map((row) => ({
        ...serializeAudit(row),
        stock: stocks[row.id] ?? 0,
        analogousCount: anaCounts[row.id] ?? 0,
      })),
      meta: { page, perPage, total, totalPages: Math.max(1, Math.ceil(total / perPage)) },
    },
    200,
  );
});

// ---------------------------------------------------------- GET /concepts/stock
const stockMapRoute = createRoute({
  method: 'get',
  path: '/concepts/stock',
  tags: ['concepts'],
  middleware: [requireRole('viewer')] as const,
  request: { query: z.object({ locationId: z.uuid().optional() }) },
  responses: {
    200: {
      description:
        'conceptId → stock map (single aggregation query, for Home). ' +
        'locationId restricts to that location subtree.',
      ...jsonContent(z.record(z.string(), z.number())),
    },
    401: errorResponse('Not signed in'),
  },
});

conceptsRouter.openapi(stockMapRoute, (c) => {
  const { locationId } = c.req.valid('query');
  return c.json(stockByConcept(locationId ? subtreeIds(locationId) : undefined), 200);
});

// -------------------------------------------------------- GET /concepts/options
/**
 * Every concept, as just enough to fill a dropdown.
 *
 * The filter bars used to read `/concepts?page=1`, which is a page — so with
 * 40 concepts the filter silently only offered the first 25, and the missing
 * ones looked like concepts that did not exist. A search box in the dropdown
 * makes it worse, not better: typing a name that is on page 2 finds nothing.
 *
 * Unpaginated on the same reasoning as `/types` and `/locations`: these rows
 * are three fields wide and a workshop has hundreds of them, not millions.
 */
const optionsRoute = createRoute({
  method: 'get',
  path: '/concepts/options',
  tags: ['concepts'],
  middleware: [requireRole('viewer')] as const,
  responses: {
    200: {
      description: 'id + humanId + name + unit for every concept, for pickers',
      ...jsonContent(
        z.array(conceptSchema.pick({ id: true, humanId: true, name: true, unit: true })),
      ),
    },
    401: errorResponse('Not signed in'),
  },
});

conceptsRouter.openapi(optionsRoute, (c) =>
  c.json(
    db
      .select({
        id: concepts.id,
        humanId: concepts.humanId,
        name: concepts.name,
        unit: concepts.unit,
      })
      .from(concepts)
      .where(isNull(concepts.deletedAt))
      .orderBy(concepts.humanId)
      .all(),
    200,
  ),
);

// ------------------------------------------------------------- POST /concepts
const createRoute_ = createRoute({
  method: 'post',
  path: '/concepts',
  tags: ['concepts'],
  middleware: [requireRole('manager')] as const,
  request: { body: { content: { 'application/json': { schema: conceptCreateSchema } } } },
  responses: {
    201: { description: 'Created concept', ...jsonContent(conceptSchema) },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires manager role'),
  },
});

conceptsRouter.openapi(createRoute_, (c) => {
  const body = c.req.valid('json');
  const user = c.get('user');

  const row = db.transaction(() => {
    const id = crypto.randomUUID();
    const humanId = generateHumanId('CON', 'simple');
    db.insert(concepts)
      .values({
        id,
        humanId,
        name: body.name,
        unit: body.unit,
        minStockThreshold: body.minStockThreshold ?? null,
        notes: body.notes ?? null,
        trackingLevel: body.trackingLevel,
        seededMonthlyRate: body.seededMonthlyRate ?? null,
      })
      .run();
    logEvent({
      entityType: 'concept',
      entityId: id,
      entityHumanId: humanId,
      action: 'created',
      valueAfter: body,
      userId: user.id,
    });
    return db.select().from(concepts).where(eq(concepts.id, id)).get()!;
  });

  return c.json(serializeAudit(row), 201);
});

// ---------------------------------------------------------- GET /concepts/:id
const detailRoute = createRoute({
  method: 'get',
  path: '/concepts/{id}',
  tags: ['concepts'],
  middleware: [requireRole('viewer')] as const,
  request: { params: idParam },
  responses: {
    200: {
      description: 'Concept with stock and its analogous groups',
      ...jsonContent(
        conceptWithStockSchema.extend({ analogous: z.array(analogousSchema) }),
      ),
    },
    401: errorResponse('Not signed in'),
    404: errorResponse('Not found'),
  },
});

conceptsRouter.openapi(detailRoute, (c) => {
  const { id } = c.req.valid('param');
  const row = getActiveConcept(id);

  const analogousRows = db
    .select()
    .from(analogous)
    .where(and(eq(analogous.conceptId, id), isNull(analogous.deletedAt)))
    .orderBy(analogous.humanId)
    .all();

  return c.json(
    {
      ...serializeAudit(row),
      stock: stockForConcept(id),
      analogousCount: analogousRows.length,
      analogous: analogousRows.map(serializeAudit),
    },
    200,
  );
});

// -------------------------------------------------------- PATCH /concepts/:id
const updateRoute = createRoute({
  method: 'patch',
  path: '/concepts/{id}',
  tags: ['concepts'],
  middleware: [requireRole('manager')] as const,
  request: {
    params: idParam,
    body: { content: { 'application/json': { schema: conceptUpdateSchema } } },
  },
  responses: {
    200: { description: 'Updated concept', ...jsonContent(conceptSchema) },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires manager role'),
    404: errorResponse('Not found'),
  },
});

conceptsRouter.openapi(updateRoute, (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const user = c.get('user');

  const updated = db.transaction(() => {
    const before = getActiveConcept(id);

    db.update(concepts)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.unit !== undefined ? { unit: body.unit } : {}),
        ...(body.minStockThreshold !== undefined
          ? { minStockThreshold: body.minStockThreshold }
          : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
        ...(body.trackingLevel !== undefined ? { trackingLevel: body.trackingLevel } : {}),
        // The seed is kept, never overwritten by measurement — but
        // the user may of course revise their own estimate.
        ...(body.seededMonthlyRate !== undefined
          ? { seededMonthlyRate: body.seededMonthlyRate }
          : {}),
      })
      .where(eq(concepts.id, id))
      .run();

    // One history event per changed field — that is what displays.
    const beforeRecord = before as unknown as Record<string, unknown>;
    for (const [field, after] of Object.entries(body)) {
      if (after === undefined) continue;
      const prev = beforeRecord[field] ?? null;
      if (JSON.stringify(prev) === JSON.stringify(after)) continue;
      logEvent({
        entityType: 'concept',
        entityId: id,
        entityHumanId: before.humanId,
        action: 'updated',
        fieldChanged: field,
        valueBefore: prev,
        valueAfter: after,
        userId: user.id,
      });
    }

    return db.select().from(concepts).where(eq(concepts.id, id)).get()!;
  });

  return c.json(serializeAudit(updated), 200);
});

// ------------------------------------------------------- DELETE /concepts/:id
const deleteRoute = createRoute({
  method: 'delete',
  path: '/concepts/{id}',
  tags: ['concepts'],
  middleware: [requireRole('manager')] as const,
  request: {
    params: idParam,
    query: z.object({
      // Take the analogous groups, variants and items down with it.
      cascade: z.enum(['true', 'false']).optional(),
    }),
  },
  responses: {
    200: { description: 'Soft-deleted concept', ...jsonContent(conceptSchema) },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires manager role'),
    404: errorResponse('Not found'),
    409: errorResponse('Concept still has analogous groups'),
  },
});

conceptsRouter.openapi(deleteRoute, (c) => {
  const { id } = c.req.valid('param');
  const cascade = c.req.valid('query').cascade === 'true';
  const user = c.get('user');

  const deleted = db.transaction(() => {
    const row = getActiveConcept(id);

    const linked =
      db
        .select({ n: count() })
        .from(analogous)
        .where(and(eq(analogous.conceptId, id), isNull(analogous.deletedAt)))
        .get()?.n ?? 0;
    if (linked > 0 && !cascade) {
      const counts = previewConceptCascade(id);
      throw new ApiError(
        409,
        'concept_in_use',
        `Cannot delete: ${linked} analogous group(s) still reference this concept`,
        { analogousCount: linked, cascade: counts },
      );
    }
    if (cascade) cascadeFromConcept(id, user.id);

    db.update(concepts).set({ deletedAt: new Date() }).where(eq(concepts.id, id)).run();
    logEvent({
      entityType: 'concept',
      entityId: id,
      entityHumanId: row.humanId,
      action: 'soft_deleted',
      userId: user.id,
    });
    return db.select().from(concepts).where(eq(concepts.id, id)).get()!;
  });

  return c.json(serializeAudit(deleted), 200);
});

// ------------------------------------------------- POST /concepts/:id/restore
const restoreRoute = createRoute({
  method: 'post',
  path: '/concepts/{id}/restore',
  tags: ['concepts'],
  middleware: [requireRole('admin')] as const,
  request: { params: idParam },
  responses: {
    200: { description: 'Restored concept', ...jsonContent(conceptSchema) },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires admin role'),
    404: errorResponse('Not found'),
  },
});

conceptsRouter.openapi(restoreRoute, (c) => {
  const { id } = c.req.valid('param');
  const user = c.get('user');

  const restored = db.transaction(() => {
    const row = db.select().from(concepts).where(eq(concepts.id, id)).get();
    if (!row || row.deletedAt === null) throw notFoundError('deleted concept', id);

    db.update(concepts).set({ deletedAt: null }).where(eq(concepts.id, id)).run();
    logEvent({
      entityType: 'concept',
      entityId: id,
      entityHumanId: row.humanId,
      action: 'restored',
      userId: user.id,
    });
    return db.select().from(concepts).where(eq(concepts.id, id)).get()!;
  });

  return c.json(serializeAudit(restored), 200);
});
