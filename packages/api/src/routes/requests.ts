import { createRoute, z } from '@hono/zod-openapi';
import { and, count, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  errorResponseSchema,
  existingRequestSchema,
  listResponseSchema,
  paginationQuerySchema,
  requestCreateSchema,
  requestSchema,
  requestUpdateSchema,
  requestWithRefsSchema,
  REQUEST_STATUSES,
} from '@inventory/shared';
import type { RequestStatus } from '@inventory/shared';
import { createRouter } from '../lib/router';
import { db } from '../db/client';
import {
  concepts,
  lotLines,
  lots,
  requestSupporters,
  requests,
  variants,
} from '../db/schema';
import { user as userTable } from '../db/auth-schema';
import { serializeAudit } from '../lib/serialize';
import { requireRole } from '../middleware/auth';
import type { AuthEnv } from '../middleware/auth';
import { ApiError, notFoundError } from '../middleware/error';
import { logEvent } from '../services/history';
import { generateHumanId } from '../services/ids';
import { stockByConcept } from '../services/stock';

// Requests. A functional demand at Concept level with no
// purchasing decision in it — the person who needs wood glue must not have to
// know which brand. Deliberately tiny: what, and how much.

export const requestsRouter = createRouter<AuthEnv>();

const jsonContent = <T extends z.ZodType>(schema: T) => ({
  content: { 'application/json': { schema } },
});
const errorResponse = (description: string) => ({
  description,
  ...jsonContent(errorResponseSchema),
});
const idParam = z.object({ id: z.uuid() });

// ---------------------------------------------------------------- enrichment

function supportersFor(requestIds: string[]): Map<string, { userId: string; name: string | null }[]> {
  const map = new Map<string, { userId: string; name: string | null }[]>();
  if (requestIds.length === 0) return map;
  const rows = db
    .select({
      requestId: requestSupporters.requestId,
      userId: requestSupporters.userId,
      name: userTable.name,
    })
    .from(requestSupporters)
    .leftJoin(userTable, eq(requestSupporters.userId, userTable.id))
    .where(inArray(requestSupporters.requestId, requestIds))
    .all();
  for (const row of rows) {
    const list = map.get(row.requestId) ?? [];
    list.push({ userId: row.userId, name: row.name ?? null });
    map.set(row.requestId, list);
  }
  return map;
}

type RequestRow = typeof requests.$inferSelect;

function enrich(rows: RequestRow[]) {
  const supporters = supportersFor(rows.map((r) => r.id));
  const stocks = stockByConcept();

  return rows.map((row) => {
    const concept = db.select().from(concepts).where(eq(concepts.id, row.conceptId)).get();
    const hint = row.hintVariantId
      ? db.select().from(variants).where(eq(variants.id, row.hintVariantId)).get()
      : null;
    const requester = row.requestedBy
      ? db.select().from(userTable).where(eq(userTable.id, row.requestedBy)).get()
      : null;
    const line = row.lotLineId
      ? db.select().from(lotLines).where(eq(lotLines.id, row.lotLineId)).get()
      : null;
    const lot = line ? db.select().from(lots).where(eq(lots.id, line.lotId)).get() : null;

    return {
      ...serializeAudit(row),
      conceptName: concept?.name ?? { en: '?' },
      conceptHumanId: concept?.humanId ?? '',
      conceptUnit: concept?.unit ?? '',
      hintVariantName: hint?.name ?? null,
      requesterName: requester?.name ?? null,
      supporters: supporters.get(row.id) ?? [],
      lotHumanId: lot?.humanId ?? null,
      lotStatus: lot?.status ?? null,
      currentStock: stocks[row.conceptId] ?? 0,
    };
  });
}

function getRequest(id: string) {
  const row = db
    .select()
    .from(requests)
    .where(and(eq(requests.id, id), isNull(requests.deletedAt)))
    .get();
  if (!row) throw notFoundError('request', id);
  return row;
}

/** The open request for a concept, if any — the basis of the "+1" offer. */
export function openRequestForConcept(conceptId: string) {
  return db
    .select()
    .from(requests)
    .where(
      and(
        eq(requests.conceptId, conceptId),
        eq(requests.status, 'open'),
        isNull(requests.deletedAt),
      ),
    )
    .orderBy(requests.createdAt)
    .get();
}

// -------------------------------------------------------------- GET /requests
const listRoute = createRoute({
  method: 'get',
  path: '/requests',
  tags: ['requests'],
  middleware: [requireRole('viewer')] as const,
  request: {
    query: paginationQuerySchema.extend({
      status: z.string().optional(), // CSV of RequestStatus
      conceptId: z.uuid().optional(),
      mine: z.enum(['true', 'false']).optional(),
    }),
  },
  responses: {
    200: {
      description: 'Paginated requests',
      ...jsonContent(listResponseSchema(requestWithRefsSchema)),
    },
    401: errorResponse('Not signed in'),
  },
});

requestsRouter.openapi(listRoute, (c) => {
  const { page, perPage, status, conceptId, mine } = c.req.valid('query');
  const user = c.get('user');

  const statuses = (status?.split(',').filter(Boolean) ?? []) as RequestStatus[];
  const invalid = statuses.filter((s) => !REQUEST_STATUSES.includes(s));
  if (invalid.length > 0) {
    throw new ApiError(400, 'bad_status', `Unknown request status: ${invalid.join(', ')}`);
  }

  const where = and(
    isNull(requests.deletedAt),
    statuses.length > 0 ? inArray(requests.status, statuses) : undefined,
    conceptId ? eq(requests.conceptId, conceptId) : undefined,
    mine === 'true' ? eq(requests.requestedBy, user.id) : undefined,
  );

  const total = db.select({ n: count() }).from(requests).where(where).get()?.n ?? 0;
  const rows = db
    .select()
    .from(requests)
    .where(where)
    // Blocking first, then oldest — the triage order.
    .orderBy(desc(requests.urgency), requests.createdAt)
    .limit(perPage)
    .offset((page - 1) * perPage)
    .all();

  return c.json(
    {
      data: enrich(rows),
      meta: { page, perPage, total, totalPages: Math.max(1, Math.ceil(total / perPage)) },
    },
    200,
  );
});

// ------------------------------------------- GET /requests/open/{conceptId}
const existingRoute = createRoute({
  method: 'get',
  path: '/requests/open/{conceptId}',
  tags: ['requests'],
  middleware: [requireRole('viewer')] as const,
  request: { params: z.object({ conceptId: z.uuid() }) },
  responses: {
    200: {
      description:
        'The open request for this concept, if someone already asked. Turns a ' +
        'duplicate into a +1, which is better data.',
      ...jsonContent(existingRequestSchema),
    },
    401: errorResponse('Not signed in'),
  },
});

requestsRouter.openapi(existingRoute, (c) => {
  const { conceptId } = c.req.valid('param');
  const row = openRequestForConcept(conceptId);
  return c.json({ request: row ? enrich([row])[0]! : null }, 200);
});

// ------------------------------------------------------------- POST /requests
const createRoute_ = createRoute({
  method: 'post',
  path: '/requests',
  tags: ['requests'],
  middleware: [requireRole('operator')] as const,
  request: { body: { content: { 'application/json': { schema: requestCreateSchema } } } },
  responses: {
    201: { description: 'Created request', ...jsonContent(requestSchema) },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires operator role'),
    404: errorResponse('Concept not found'),
  },
});

requestsRouter.openapi(createRoute_, (c) => {
  const body = c.req.valid('json');
  const user = c.get('user');

  const row = db.transaction(() => {
    const concept = db
      .select()
      .from(concepts)
      .where(and(eq(concepts.id, body.conceptId), isNull(concepts.deletedAt)))
      .get();
    if (!concept) throw notFoundError('concept', body.conceptId);

    const id = crypto.randomUUID();
    const humanId = generateHumanId('REQ', 'simple');
    db.insert(requests)
      .values({
        id,
        humanId,
        conceptId: body.conceptId,
        quantity: body.quantity,
        unit: body.unit ?? concept.unit,
        urgency: body.urgency,
        hintVariantId: body.hintVariantId ?? null,
        note: body.note ?? null,
        status: 'open',
        requestedBy: user.id,
      })
      .run();
    logEvent({
      entityType: 'request',
      entityId: id,
      entityHumanId: humanId,
      action: 'created',
      valueAfter: { concept: concept.humanId, quantity: body.quantity, urgency: body.urgency },
      userId: user.id,
    });
    return db.select().from(requests).where(eq(requests.id, id)).get()!;
  });

  return c.json(serializeAudit(row), 201);
});

// ----------------------------------------------------- POST /requests/:id/me-too
const supportRoute = createRoute({
  method: 'post',
  path: '/requests/{id}/support',
  tags: ['requests'],
  middleware: [requireRole('viewer')] as const,
  request: { params: idParam },
  responses: {
    200: {
      description: 'Added a +1. Demand intensity, not a duplicate row.',
      ...jsonContent(z.object({ ok: z.boolean(), supporters: z.number().int() })),
    },
    401: errorResponse('Not signed in'),
    404: errorResponse('Not found'),
  },
});

requestsRouter.openapi(supportRoute, (c) => {
  const { id } = c.req.valid('param');
  const user = c.get('user');

  const total = db.transaction(() => {
    const row = getRequest(id);
    const already = db
      .select()
      .from(requestSupporters)
      .where(
        and(eq(requestSupporters.requestId, id), eq(requestSupporters.userId, user.id)),
      )
      .get();
    if (!already) {
      db.insert(requestSupporters)
        .values({ id: crypto.randomUUID(), requestId: id, userId: user.id })
        .run();
      logEvent({
        entityType: 'request',
        entityId: id,
        entityHumanId: row.humanId,
        action: 'updated',
        fieldChanged: 'supporters',
        notes: 'also needs this',
        userId: user.id,
      });
    }
    return (
      db
        .select({ n: count() })
        .from(requestSupporters)
        .where(eq(requestSupporters.requestId, id))
        .get()?.n ?? 0
    );
  });

  return c.json({ ok: true, supporters: total }, 200);
});

// ------------------------------------------------------- PATCH /requests/:id
const updateRoute = createRoute({
  method: 'patch',
  path: '/requests/{id}',
  tags: ['requests'],
  middleware: [requireRole('operator')] as const,
  request: {
    params: idParam,
    body: { content: { 'application/json': { schema: requestUpdateSchema } } },
  },
  responses: {
    200: { description: 'Updated request', ...jsonContent(requestSchema) },
    401: errorResponse('Not signed in'),
    404: errorResponse('Not found'),
    409: errorResponse('Already in a lot'),
  },
});

requestsRouter.openapi(updateRoute, (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const user = c.get('user');

  const updated = db.transaction(() => {
    const before = getRequest(id);
    if (before.status !== 'open') {
      throw new ApiError(
        409,
        'request_locked',
        `This request is already ${before.status.replaceAll('_', ' ')} — edit the lot line instead`,
      );
    }
    db.update(requests)
      .set({
        ...(body.quantity !== undefined ? { quantity: body.quantity } : {}),
        ...(body.unit !== undefined ? { unit: body.unit } : {}),
        ...(body.urgency !== undefined ? { urgency: body.urgency } : {}),
        ...(body.hintVariantId !== undefined ? { hintVariantId: body.hintVariantId } : {}),
        ...(body.note !== undefined ? { note: body.note } : {}),
      })
      .where(eq(requests.id, id))
      .run();

    const beforeRecord = before as unknown as Record<string, unknown>;
    for (const [field, after] of Object.entries(body)) {
      if (after === undefined) continue;
      const prev = beforeRecord[field] ?? null;
      if (JSON.stringify(prev) === JSON.stringify(after)) continue;
      logEvent({
        entityType: 'request',
        entityId: id,
        entityHumanId: before.humanId,
        action: 'updated',
        fieldChanged: field,
        valueBefore: prev,
        valueAfter: after,
        userId: user.id,
      });
    }
    return db.select().from(requests).where(eq(requests.id, id)).get()!;
  });

  return c.json(serializeAudit(updated), 200);
});

// ------------------------------------------------ POST /requests/:id/cancel
const cancelRoute = createRoute({
  method: 'post',
  path: '/requests/{id}/cancel',
  tags: ['requests'],
  middleware: [requireRole('operator')] as const,
  request: { params: idParam },
  responses: {
    200: { description: 'Cancelled request', ...jsonContent(requestSchema) },
    401: errorResponse('Not signed in'),
    404: errorResponse('Not found'),
  },
});

requestsRouter.openapi(cancelRoute, (c) => {
  const { id } = c.req.valid('param');
  const user = c.get('user');

  const row = db.transaction(() => {
    const before = getRequest(id);
    db.update(requests).set({ status: 'cancelled' }).where(eq(requests.id, id)).run();
    logEvent({
      entityType: 'request',
      entityId: id,
      entityHumanId: before.humanId,
      action: 'status_changed',
      fieldChanged: 'status',
      valueBefore: before.status,
      valueAfter: 'cancelled',
      userId: user.id,
    });
    return db.select().from(requests).where(eq(requests.id, id)).get()!;
  });

  return c.json(serializeAudit(row), 200);
});

// ------------------------------------------------------ DELETE /requests/:id
const deleteRoute = createRoute({
  method: 'delete',
  path: '/requests/{id}',
  tags: ['requests'],
  middleware: [requireRole('manager')] as const,
  request: { params: idParam },
  responses: {
    200: { description: 'Soft-deleted request', ...jsonContent(requestSchema) },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires manager role'),
    404: errorResponse('Not found'),
  },
});

requestsRouter.openapi(deleteRoute, (c) => {
  const { id } = c.req.valid('param');
  const user = c.get('user');

  const row = db.transaction(() => {
    const before = getRequest(id);
    db.update(requests).set({ deletedAt: new Date() }).where(eq(requests.id, id)).run();
    logEvent({
      entityType: 'request',
      entityId: id,
      entityHumanId: before.humanId,
      action: 'soft_deleted',
      userId: user.id,
    });
    return db.select().from(requests).where(eq(requests.id, id)).get()!;
  });

  return c.json(serializeAudit(row), 200);
});
