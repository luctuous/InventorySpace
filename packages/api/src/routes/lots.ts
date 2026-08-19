import { createRoute, z } from '@hono/zod-openapi';
import { and, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  errorResponseSchema,
  listResponseSchema,
  lotCreateSchema,
  lotLineCreateSchema,
  lotLineUpdateSchema,
  lotOrderSchema,
  lotSchema,
  lotUpdateSchema,
  lotWithLinesSchema,
  paginationQuerySchema,
  parseMoneyInput,
  priceHistoryPointSchema,
  receiveResultSchema,
  receiveSchema,
  supplierCreateSchema,
  supplierSchema,
  supplierStatsSchema,
  translatedTextSchema,
  LOT_STATUSES,
} from '@inventory/shared';
import type { LotStatus } from '@inventory/shared';
import { createRouter } from '../lib/router';
import { db } from '../db/client';
import {
  analogous,
  concepts,
  items,
  locations,
  lotLines,
  lots,
  requests,
  suppliers,
  types,
  variants,
} from '../db/schema';
import { serializeAudit, toIso } from '../lib/serialize';
import { requireRole } from '../middleware/auth';
import type { AuthEnv } from '../middleware/auth';
import { ApiError, notFoundError } from '../middleware/error';
import { logEvent } from '../services/history';
import { generateHumanId } from '../services/ids';
import {
  lastPriceForVariant,
  priceDelta,
  priceHistory,
  resolveSupplier,
  supplierNameFor,
  supplierStats,
  usualLocationForConcept,
} from '../services/purchasing';

// Lots: one order to one supplier, assembled by triaging
// open Requests. Reception is the payoff — it creates the Items automatically.
//
// The invariant this whole file protects: a lot line has an ORDERED side and a
// RECEIVED side, and neither is ever overwritten. Editing the line to say
// "4 × B" when you ordered "5 × A" would destroy exactly the interesting data.

export const lotsRouter = createRouter<AuthEnv>();

const jsonContent = <T extends z.ZodType>(schema: T) => ({
  content: { 'application/json': { schema } },
});
const errorResponse = (description: string) => ({
  description,
  ...jsonContent(errorResponseSchema),
});
const idParam = z.object({ id: z.uuid() });

// ---------------------------------------------------------------- helpers

function getLot(id: string) {
  const row = db
    .select()
    .from(lots)
    .where(and(eq(lots.id, id), isNull(lots.deletedAt)))
    .get();
  if (!row) throw notFoundError('lot', id);
  return row;
}

function getLine(lotId: string, lineId: string) {
  const row = db
    .select()
    .from(lotLines)
    .where(
      and(eq(lotLines.id, lineId), eq(lotLines.lotId, lotId), isNull(lotLines.deletedAt)),
    )
    .get();
  if (!row) throw notFoundError('lot line', lineId);
  return row;
}

function linesFor(lotId: string) {
  const rows = db
    .select()
    .from(lotLines)
    .where(and(eq(lotLines.lotId, lotId), isNull(lotLines.deletedAt)))
    .orderBy(lotLines.createdAt)
    .all();

  return rows.map((line) => {
    const concept = db.select().from(concepts).where(eq(concepts.id, line.conceptId)).get();
    const ordered = db
      .select()
      .from(variants)
      .where(eq(variants.id, line.orderedVariantId))
      .get();
    const received = line.receivedVariantId
      ? db.select().from(variants).where(eq(variants.id, line.receivedVariantId)).get()
      : null;
    const location = line.locationId
      ? db.select().from(locations).where(eq(locations.id, line.locationId)).get()
      : null;
    const requestCount =
      db
        .select({ n: count() })
        .from(requests)
        .where(and(eq(requests.lotLineId, line.id), isNull(requests.deletedAt)))
        .get()?.n ?? 0;
    const itemsCreated =
      db
        .select({ n: count() })
        .from(items)
        .where(and(eq(items.lotLineId, line.id), isNull(items.deletedAt)))
        .get()?.n ?? 0;

    // "+12% since your last order" — the information at the moment of the
    // decision, not in a report nobody opens.
    const { last, deltaPercent } = priceDelta(
      line.orderedVariantId,
      line.unitPriceAmount,
      line.lotId,
    );

    return {
      ...serializeAudit(line),
      expiryDate: toIso(line.expiryDate),
      conceptName: concept?.name ?? { en: '?' },
      conceptUnit: concept?.unit ?? '',
      orderedVariantName: ordered?.name ?? { en: '?' },
      orderedVariantPackSize: ordered?.packSize ?? null,
      orderedVariantPackUnit: ordered?.packUnit ?? null,
      receivedVariantName: received?.name ?? null,
      locationCode: location?.code ?? null,
      requestCount,
      itemsCreated,
      priceDeltaPercent: deltaPercent,
      lastPriceAmount: last?.amount ?? null,
    };
  });
}

type EnrichedLine = ReturnType<typeof linesFor>[number];

function discrepancyCount(lines: EnrichedLine[]): number {
  return lines.filter(
    (line) =>
      (line.receivedVariantId && line.receivedVariantId !== line.orderedVariantId) ||
      ((line.status === 'received' || line.status === 'closed') &&
        line.receivedQuantity !== line.orderedQuantity),
  ).length;
}


function serializeLot(lot: typeof lots.$inferSelect) {
  const lines = linesFor(lot.id);
  const totalAmount = lines.reduce(
    (sum, line) => sum + (line.unitPriceAmount ?? 0) * line.orderedQuantity,
    0,
  );
  return {
    ...serializeAudit(lot),
    supplierName: supplierNameFor(lot.supplierId),
    orderedAt: toIso(lot.orderedAt),
    receivedAt: toIso(lot.receivedAt),
    lines,
    totalAmount: Math.round(totalAmount),
    currency: lines.find((line) => line.priceCurrency)?.priceCurrency ?? null,
    discrepancies: discrepancyCount(lines),
  };
}

/** Roll the lot's status up from its lines after any reception. */
function recomputeLotStatus(lotId: string): LotStatus {
  const rows = db
    .select({ status: lotLines.status })
    .from(lotLines)
    .where(and(eq(lotLines.lotId, lotId), isNull(lotLines.deletedAt)))
    .all();
  if (rows.length === 0) return 'ordered';
  const settled = rows.filter((r) => r.status === 'received' || r.status === 'closed');
  if (settled.length === rows.length) return 'received';
  if (settled.length > 0 || rows.some((r) => r.status === 'partial')) return 'partial';
  return 'ordered';
}

// ------------------------------------------------------------------ GET /lots
const listRoute = createRoute({
  method: 'get',
  path: '/lots',
  tags: ['lots'],
  middleware: [requireRole('viewer')] as const,
  request: {
    query: paginationQuerySchema.extend({ status: z.string().optional() }),
  },
  responses: {
    200: { description: 'Paginated lots', ...jsonContent(listResponseSchema(lotWithLinesSchema)) },
    401: errorResponse('Not signed in'),
  },
});

lotsRouter.openapi(listRoute, (c) => {
  const { page, perPage, status } = c.req.valid('query');
  const statuses = (status?.split(',').filter(Boolean) ?? []) as LotStatus[];
  const invalid = statuses.filter((s) => !LOT_STATUSES.includes(s));
  if (invalid.length > 0) {
    throw new ApiError(400, 'bad_status', `Unknown lot status: ${invalid.join(', ')}`);
  }

  const where = and(
    isNull(lots.deletedAt),
    statuses.length > 0 ? inArray(lots.status, statuses) : undefined,
  );
  const total = db.select({ n: count() }).from(lots).where(where).get()?.n ?? 0;
  const rows = db
    .select()
    .from(lots)
    .where(where)
    .orderBy(desc(lots.createdAt))
    .limit(perPage)
    .offset((page - 1) * perPage)
    .all();

  return c.json(
    {
      data: rows.map(serializeLot),
      meta: { page, perPage, total, totalPages: Math.max(1, Math.ceil(total / perPage)) },
    },
    200,
  );
});

// ----------------------------------------------------------------- POST /lots
const createLotRoute = createRoute({
  method: 'post',
  path: '/lots',
  tags: ['lots'],
  middleware: [requireRole('manager')] as const,
  request: { body: { content: { 'application/json': { schema: lotCreateSchema } } } },
  responses: {
    201: { description: 'Created draft lot', ...jsonContent(lotSchema) },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires manager role'),
  },
});

lotsRouter.openapi(createLotRoute, (c) => {
  const body = c.req.valid('json');
  const user = c.get('user');

  const row = db.transaction(() => {
    const supplierId = resolveSupplier(body, user.id);
    const id = crypto.randomUUID();
    const humanId = generateHumanId('LOT', 'simple');
    db.insert(lots)
      .values({
        id,
        humanId,
        supplierId,
        notes: body.notes ?? null,
        status: 'draft',
        createdBy: user.id,
      })
      .run();
    logEvent({
      entityType: 'lot',
      entityId: id,
      entityHumanId: humanId,
      action: 'created',
      valueAfter: { supplier: supplierNameFor(supplierId) },
      userId: user.id,
    });
    return db.select().from(lots).where(eq(lots.id, id)).get()!;
  });

  return c.json(
    {
      ...serializeAudit(row),
      supplierName: supplierNameFor(row.supplierId),
      orderedAt: null,
      receivedAt: null,
    },
    201,
  );
});

// ------------------------------------------------------------- GET /lots/:id
const detailRoute = createRoute({
  method: 'get',
  path: '/lots/{id}',
  tags: ['lots'],
  middleware: [requireRole('viewer')] as const,
  request: { params: idParam },
  responses: {
    200: { description: 'Lot with its lines', ...jsonContent(lotWithLinesSchema) },
    401: errorResponse('Not signed in'),
    404: errorResponse('Not found'),
  },
});

lotsRouter.openapi(detailRoute, (c) => {
  const { id } = c.req.valid('param');
  return c.json(serializeLot(getLot(id)), 200);
});

// ----------------------------------------------------------- PATCH /lots/:id
const updateRoute = createRoute({
  method: 'patch',
  path: '/lots/{id}',
  tags: ['lots'],
  middleware: [requireRole('manager')] as const,
  request: {
    params: idParam,
    body: { content: { 'application/json': { schema: lotUpdateSchema } } },
  },
  responses: {
    200: { description: 'Updated lot', ...jsonContent(lotSchema) },
    401: errorResponse('Not signed in'),
    404: errorResponse('Not found'),
  },
});

lotsRouter.openapi(updateRoute, (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const user = c.get('user');

  const row = db.transaction(() => {
    const before = getLot(id);
    const changingSupplier =
      body.supplierId !== undefined || body.newSupplierName !== undefined;
    const supplierId = changingSupplier ? resolveSupplier(body, user.id) : undefined;

    db.update(lots)
      .set({
        ...(supplierId !== undefined ? { supplierId } : {}),
        ...(body.reference !== undefined ? { reference: body.reference } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
      })
      .where(eq(lots.id, id))
      .run();

    if (supplierId !== undefined && supplierId !== before.supplierId) {
      logEvent({
        entityType: 'lot', entityId: id, entityHumanId: before.humanId,
        action: 'updated', fieldChanged: 'supplier',
        valueBefore: supplierNameFor(before.supplierId),
        valueAfter: supplierNameFor(supplierId),
        userId: user.id,
      });
    }
    for (const field of ['reference', 'notes'] as const) {
      const after = body[field];
      if (after === undefined) continue;
      const prev = before[field] ?? null;
      if (JSON.stringify(prev) === JSON.stringify(after)) continue;
      logEvent({
        entityType: 'lot', entityId: id, entityHumanId: before.humanId,
        action: 'updated', fieldChanged: field, valueBefore: prev, valueAfter: after,
        userId: user.id,
      });
    }
    return db.select().from(lots).where(eq(lots.id, id)).get()!;
  });

  return c.json(
    {
      ...serializeAudit(row),
      supplierName: supplierNameFor(row.supplierId),
      orderedAt: toIso(row.orderedAt),
      receivedAt: toIso(row.receivedAt),
    },
    200,
  );
});

// ------------------------------------------------------- POST /lots/:id/lines
const addLineRoute = createRoute({
  method: 'post',
  path: '/lots/{id}/lines',
  tags: ['lots'],
  middleware: [requireRole('manager')] as const,
  request: {
    params: idParam,
    body: { content: { 'application/json': { schema: lotLineCreateSchema } } },
  },
  responses: {
    201: { description: 'Lot with the new line', ...jsonContent(lotWithLinesSchema) },
    400: errorResponse('Bad price format'),
    401: errorResponse('Not signed in'),
    404: errorResponse('Not found'),
    409: errorResponse('Lot already ordered'),
  },
});

/**
 * Name a product that does not exist yet, under a Concept somebody requested.
 *
 * Requests are Concept-level by design, so the buyer is routinely the first
 * person in the system to say which brand and which size. That decision has to
 * land somewhere, and the somewhere is a Variant — created here, inside the
 * line's transaction, so a failed line cannot leave a stray product behind.
 *
 * The Analogous group in between is the same invisible 1:1 link Quick Add
 * makes: nobody buying wood glue should have to think about grouping
 * levels first.
 */
function createVariantForConcept(
  conceptId: string,
  body: {
    newVariantName?: string;
    newVariantTypeId?: string;
    newVariantPackSize?: number | null;
    newVariantPackUnit?: string | null;
    newVariantBrand?: string | null;
  },
  supplierId: string | null,
  userId: string,
) {
  const concept = db
    .select()
    .from(concepts)
    .where(and(eq(concepts.id, conceptId), isNull(concepts.deletedAt)))
    .get();
  if (!concept) throw notFoundError('concept', conceptId);

  // The type is only worth asking for when it cannot be inferred: if the
  // concept already has products, a new one is the same kind of thing.
  const sibling = db
    .select()
    .from(variants)
    .where(and(eq(variants.conceptId, conceptId), isNull(variants.deletedAt)))
    .orderBy(variants.humanId)
    .get();
  const typeId = body.newVariantTypeId ?? sibling?.typeId;
  if (!typeId) {
    throw new ApiError(
      400,
      'type_required',
      'This concept has no products yet, so the new one needs a type',
    );
  }
  const type = db
    .select()
    .from(types)
    .where(and(eq(types.id, typeId), isNull(types.deletedAt)))
    .get();
  if (!type) throw notFoundError('type', typeId);

  let analogousId = sibling?.analogousId ?? null;
  if (!analogousId) {
    const existingGroup = db
      .select()
      .from(analogous)
      .where(and(eq(analogous.conceptId, conceptId), isNull(analogous.deletedAt)))
      .orderBy(analogous.humanId)
      .get();
    analogousId = existingGroup?.id ?? null;
  }
  if (!analogousId) {
    analogousId = crypto.randomUUID();
    const groupHumanId = generateHumanId('ANA', 'simple');
    db.insert(analogous)
      .values({ id: analogousId, humanId: groupHumanId, conceptId, name: concept.name })
      .run();
    logEvent({
      entityType: 'analogous', entityId: analogousId, entityHumanId: groupHumanId,
      action: 'created', valueAfter: { name: concept.name, fromLot: true }, userId,
    });
  }

  const variantId = crypto.randomUUID();
  const humanId = generateHumanId('VAR', 'simple');
  db.insert(variants)
    .values({
      id: variantId,
      humanId,
      analogousId,
      conceptId,
      typeId,
      name: { en: body.newVariantName! },
      brand: body.newVariantBrand ?? null,
      packSize: body.newVariantPackSize ?? null,
      packUnit: body.newVariantPackUnit ?? null,
      // The lot's supplier is the one fact about this product we already know.
      supplier: supplierNameFor(supplierId),
    })
    .run();
  logEvent({
    entityType: 'variant', entityId: variantId, entityHumanId: humanId,
    action: 'created', valueAfter: { name: body.newVariantName, fromLot: true }, userId,
  });

  return db.select().from(variants).where(eq(variants.id, variantId)).get()!;
}

lotsRouter.openapi(addLineRoute, (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const user = c.get('user');

  const lot = db.transaction(() => {
    const row = getLot(id);
    if (row.status !== 'draft') {
      throw new ApiError(409, 'lot_locked', 'Lines can only be added while the lot is a draft');
    }

    const variant = body.orderedVariantId
      ? db
          .select()
          .from(variants)
          .where(and(eq(variants.id, body.orderedVariantId), isNull(variants.deletedAt)))
          .get()
      : createVariantForConcept(body.conceptId, body, row.supplierId, user.id);
    if (!variant) throw notFoundError('variant', body.orderedVariantId!);
    if (variant.conceptId !== body.conceptId) {
      throw new ApiError(
        409,
        'variant_mismatch',
        'That variant does not belong to the requested concept',
      );
    }

    let priceAmount: number | null = null;
    if (body.unitPrice) {
      priceAmount = parseMoneyInput(body.unitPrice);
      if (priceAmount === null) {
        throw new ApiError(400, 'bad_price', `Cannot read '${body.unitPrice}' as a price`);
      }
    }

    const lineId = crypto.randomUUID();
    db.insert(lotLines)
      .values({
        id: lineId,
        lotId: id,
        conceptId: body.conceptId,
        orderedVariantId: variant.id,
        orderedQuantity: body.orderedQuantity,
        unitPriceAmount: priceAmount,
        priceCurrency: priceAmount !== null ? (body.priceCurrency ?? 'EUR') : null,
        // The reception default: where this concept's items usually live.
        locationId: body.locationId ?? usualLocationForConcept(body.conceptId),
        notes: body.notes ?? null,
        status: 'pending',
      })
      .run();

    // Attach the requests this line satisfies; they follow the lot from here.
    if (body.requestIds.length > 0) {
      db.update(requests)
        .set({ status: 'in_lot', lotLineId: lineId })
        .where(and(inArray(requests.id, body.requestIds), isNull(requests.deletedAt)))
        .run();
      for (const requestId of body.requestIds) {
        const req = db.select().from(requests).where(eq(requests.id, requestId)).get();
        if (!req) continue;
        logEvent({
          entityType: 'request', entityId: requestId, entityHumanId: req.humanId,
          action: 'status_changed', fieldChanged: 'status',
          valueBefore: 'open', valueAfter: 'in_lot',
          notes: `lot ${row.humanId}`, userId: user.id,
        });
      }
    }

    logEvent({
      entityType: 'lot', entityId: id, entityHumanId: row.humanId,
      action: 'updated', fieldChanged: 'lines',
      valueAfter: { variant: variant.humanId, quantity: body.orderedQuantity },
      userId: user.id,
    });
    return getLot(id);
  });

  return c.json(serializeLot(lot), 201);
});

// ------------------------------------------- PATCH /lots/:id/lines/:lineId
const updateLineRoute = createRoute({
  method: 'patch',
  path: '/lots/{id}/lines/{lineId}',
  tags: ['lots'],
  middleware: [requireRole('manager')] as const,
  request: {
    params: z.object({ id: z.uuid(), lineId: z.uuid() }),
    body: { content: { 'application/json': { schema: lotLineUpdateSchema } } },
  },
  responses: {
    200: { description: 'Updated lot', ...jsonContent(lotWithLinesSchema) },
    400: errorResponse('Bad price format'),
    401: errorResponse('Not signed in'),
    404: errorResponse('Not found'),
  },
});

lotsRouter.openapi(updateLineRoute, (c) => {
  const { id, lineId } = c.req.valid('param');
  const body = c.req.valid('json');
  const user = c.get('user');

  const lot = db.transaction(() => {
    const row = getLot(id);
    const line = getLine(id, lineId);

    let priceAmount = line.unitPriceAmount;
    if (body.unitPrice !== undefined) {
      priceAmount = body.unitPrice ? parseMoneyInput(body.unitPrice) : null;
      if (body.unitPrice && priceAmount === null) {
        throw new ApiError(400, 'bad_price', `Cannot read '${body.unitPrice}' as a price`);
      }
    }

    db.update(lotLines)
      .set({
        ...(body.orderedVariantId !== undefined
          ? { orderedVariantId: body.orderedVariantId }
          : {}),
        ...(body.orderedQuantity !== undefined
          ? { orderedQuantity: body.orderedQuantity }
          : {}),
        ...(body.unitPrice !== undefined
          ? {
              unitPriceAmount: priceAmount,
              priceCurrency: priceAmount !== null ? (body.priceCurrency ?? 'EUR') : null,
            }
          : {}),
        ...(body.locationId !== undefined ? { locationId: body.locationId } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
      })
      .where(eq(lotLines.id, lineId))
      .run();

    logEvent({
      entityType: 'lot', entityId: id, entityHumanId: row.humanId,
      action: 'updated', fieldChanged: 'line', valueAfter: body, userId: user.id,
    });
    return getLot(id);
  });

  return c.json(serializeLot(lot), 200);
});

// ------------------------------------------ DELETE /lots/:id/lines/:lineId
const deleteLineRoute = createRoute({
  method: 'delete',
  path: '/lots/{id}/lines/{lineId}',
  tags: ['lots'],
  middleware: [requireRole('manager')] as const,
  request: { params: z.object({ id: z.uuid(), lineId: z.uuid() }) },
  responses: {
    200: { description: 'Updated lot', ...jsonContent(lotWithLinesSchema) },
    401: errorResponse('Not signed in'),
    404: errorResponse('Not found'),
  },
});

lotsRouter.openapi(deleteLineRoute, (c) => {
  const { id, lineId } = c.req.valid('param');
  const user = c.get('user');

  const lot = db.transaction(() => {
    const row = getLot(id);
    getLine(id, lineId);
    // Any requests attached to this line go back to the open queue.
    db.update(requests)
      .set({ status: 'open', lotLineId: null })
      .where(eq(requests.lotLineId, lineId))
      .run();
    db.update(lotLines).set({ deletedAt: new Date() }).where(eq(lotLines.id, lineId)).run();
    logEvent({
      entityType: 'lot', entityId: id, entityHumanId: row.humanId,
      action: 'updated', fieldChanged: 'lines', notes: 'line removed', userId: user.id,
    });
    return getLot(id);
  });

  return c.json(serializeLot(lot), 200);
});

// ------------------------------------------------------- POST /lots/:id/order
const orderRoute = createRoute({
  method: 'post',
  path: '/lots/{id}/order',
  tags: ['lots'],
  middleware: [requireRole('manager')] as const,
  // The order reference arrives HERE, not at creation. Until you have actually
  // placed the order there is no number to type.
  request: {
    params: idParam,
    body: { content: { 'application/json': { schema: lotOrderSchema } } },
  },
  responses: {
    200: { description: 'Ordered lot', ...jsonContent(lotWithLinesSchema) },
    401: errorResponse('Not signed in'),
    404: errorResponse('Not found'),
    409: errorResponse('Nothing to order'),
  },
});

lotsRouter.openapi(orderRoute, (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const user = c.get('user');

  const lot = db.transaction(() => {
    const row = getLot(id);
    if (row.status !== 'draft') {
      throw new ApiError(409, 'lot_locked', `This lot is already ${row.status}`);
    }
    const lineCount =
      db
        .select({ n: count() })
        .from(lotLines)
        .where(and(eq(lotLines.lotId, id), isNull(lotLines.deletedAt)))
        .get()?.n ?? 0;
    if (lineCount === 0) {
      throw new ApiError(409, 'empty_lot', 'Add at least one line before ordering');
    }

    const orderedAt = new Date();
    const reference = body.reference?.trim() || null;
    db.update(lots)
      .set({ status: 'ordered', orderedAt, ...(reference ? { reference } : {}) })
      .where(eq(lots.id, id))
      .run();

    // The requester must be able to see what happened without asking anyone.
    const lineIds = db
      .select({ id: lotLines.id })
      .from(lotLines)
      .where(and(eq(lotLines.lotId, id), isNull(lotLines.deletedAt)))
      .all()
      .map((r) => r.id);
    if (lineIds.length > 0) {
      db.update(requests)
        .set({ status: 'ordered' })
        .where(and(inArray(requests.lotLineId, lineIds), isNull(requests.deletedAt)))
        .run();
    }

    logEvent({
      entityType: 'lot', entityId: id, entityHumanId: row.humanId,
      action: 'ordered', fieldChanged: 'status',
      valueBefore: 'draft', valueAfter: 'ordered',
      notes: reference ?? undefined, userId: user.id,
    });
    return getLot(id);
  });

  return c.json(serializeLot(lot), 200);
});

// ----------------------------------------------------- POST /lots/:id/receive
// The payoff. Twelve bottles without typing twelve items.
const receiveRoute = createRoute({
  method: 'post',
  path: '/lots/{id}/receive',
  tags: ['lots'],
  middleware: [requireRole('operator')] as const,
  request: {
    params: idParam,
    body: { content: { 'application/json': { schema: receiveSchema } } },
  },
  responses: {
    200: { description: 'Items created from the delivery', ...jsonContent(receiveResultSchema) },
    401: errorResponse('Not signed in'),
    404: errorResponse('Not found'),
    409: errorResponse('Lot not in a receivable state'),
  },
});

lotsRouter.openapi(receiveRoute, (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const user = c.get('user');

  const result = db.transaction(() => {
    const lot = getLot(id);
    if (lot.status !== 'ordered' && lot.status !== 'partial') {
      throw new ApiError(
        409,
        'lot_not_receivable',
        `A ${lot.status} lot cannot receive a delivery`,
      );
    }

    const itemIds: string[] = [];
    const discrepancies: { lineId: string; kind: 'short' | 'over' | 'substituted'; detail: string }[] = [];

    for (const entry of body.lines) {
      const line = getLine(id, entry.lineId);

      // Which variant actually arrived? Defaults to what was ordered; a
      // substitute may be picked or created inline, exactly like Quick Add.
      let receivedVariantId = entry.receivedVariantId ?? line.orderedVariantId;
      if (entry.newVariantName) {
        const ordered = db
          .select()
          .from(variants)
          .where(eq(variants.id, line.orderedVariantId))
          .get()!;
        const newId = crypto.randomUUID();
        db.insert(variants)
          .values({
            id: newId,
            humanId: generateHumanId('VAR', 'simple'),
            analogousId: ordered.analogousId,
            conceptId: ordered.conceptId,
            typeId: ordered.typeId,
            name: { en: entry.newVariantName },
            supplier: supplierNameFor(lot.supplierId),
          })
          .run();
        receivedVariantId = newId;
      }

      if (receivedVariantId !== line.orderedVariantId) {
        const got = db.select().from(variants).where(eq(variants.id, receivedVariantId)).get();
        discrepancies.push({
          lineId: line.id,
          kind: 'substituted',
          detail: `ordered ${line.orderedVariantId}, received ${got?.humanId ?? receivedVariantId}`,
        });
      }

      const totalReceived = line.receivedQuantity + entry.quantity;
      const variant = db
        .select()
        .from(variants)
        .where(eq(variants.id, receivedVariantId))
        .get();
      if (!variant) throw notFoundError('variant', receivedVariantId);
      const type = db.select().from(types).where(eq(types.id, variant.typeId)).get();
      if (!type) throw notFoundError('type', variant.typeId);
      const ana = db.select().from(analogous).where(eq(analogous.id, variant.analogousId)).get();

      // Create one Item per physical unit that arrived.
      const status = type.validStatuses.includes('in_stock')
        ? 'in_stock'
        : type.validStatuses[0]!;
      const packSize = variant.packSize ?? null;
      const locationId = entry.locationId ?? line.locationId ?? null;

      for (let i = 0; i < Math.round(entry.quantity); i++) {
        const itemId = crypto.randomUUID();
        const humanId = generateHumanId(type.humanIdPrefix, 'lettered');
        db.insert(items)
          .values({
            id: itemId,
            humanId,
            typeId: variant.typeId,
            variantId: variant.id,
            analogousId: variant.analogousId,
            conceptId: ana?.conceptId ?? variant.conceptId,
            locationId,
            status,
            quantityInitial: type.tracksQuantity ? packSize : null,
            quantityRemaining: type.tracksQuantity ? packSize : null,
            unit: variant.packUnit,
            priceAmount: line.unitPriceAmount,
            priceCurrency: line.priceCurrency,
            // Locked at creation, as always. The lot is simply where
            // prices enter the system.
            priceLocked: line.unitPriceAmount !== null,
            batchNumber: entry.batchNumber ?? null,
            customFields: {},
            receivedAt: new Date(),
            lotId: id,
            lotLineId: line.id,
            createdBy: user.id,
          })
          .run();
        logEvent({
          entityType: 'item', entityId: itemId, entityHumanId: humanId,
          action: 'created', notes: `received on lot ${lot.humanId}`, userId: user.id,
        });
        itemIds.push(itemId);
      }

      // Ordered and received are two sides of the same line — the ordered
      // side is never touched here.
      const settled = entry.closeRemainder || totalReceived >= line.orderedQuantity;
      const lineStatus = settled
        ? totalReceived >= line.orderedQuantity
          ? 'received'
          : 'closed'
        : 'partial';

      db.update(lotLines)
        .set({
          receivedVariantId,
          receivedQuantity: totalReceived,
          status: lineStatus,
          expiryDate: entry.expiryDate ? new Date(entry.expiryDate) : line.expiryDate,
          locationId,
        })
        .where(eq(lotLines.id, line.id))
        .run();

      if (settled && totalReceived < line.orderedQuantity) {
        discrepancies.push({
          lineId: line.id,
          kind: 'short',
          detail: `ordered ${line.orderedQuantity}, received ${totalReceived}`,
        });
      }
      if (totalReceived > line.orderedQuantity) {
        discrepancies.push({
          lineId: line.id,
          kind: 'over',
          detail: `ordered ${line.orderedQuantity}, received ${totalReceived}`,
        });
      }

      if (settled) {
        db.update(requests)
          .set({ status: 'received' })
          .where(and(eq(requests.lotLineId, line.id), isNull(requests.deletedAt)))
          .run();
      }
    }

    const nextStatus = recomputeLotStatus(id);
    db.update(lots)
      .set({
        status: nextStatus,
        receivedAt: nextStatus === 'received' ? new Date() : lot.receivedAt,
      })
      .where(eq(lots.id, id))
      .run();

    logEvent({
      entityType: 'lot', entityId: id, entityHumanId: lot.humanId,
      action: 'received',
      valueAfter: { items: itemIds.length, discrepancies: discrepancies.length },
      notes: discrepancies.map((d) => d.detail).join('; ') || null,
      userId: user.id,
    });

    return { itemsCreated: itemIds.length, itemIds, lotStatus: nextStatus, discrepancies };
  });

  return c.json(result, 200);
});

// ---------------------------------------------------------- DELETE /lots/:id
const deleteRoute = createRoute({
  method: 'delete',
  path: '/lots/{id}',
  tags: ['lots'],
  middleware: [requireRole('manager')] as const,
  request: { params: idParam },
  responses: {
    200: { description: 'Soft-deleted lot', ...jsonContent(lotSchema) },
    401: errorResponse('Not signed in'),
    404: errorResponse('Not found'),
    409: errorResponse('Lot already produced items'),
  },
});

lotsRouter.openapi(deleteRoute, (c) => {
  const { id } = c.req.valid('param');
  const user = c.get('user');

  const row = db.transaction(() => {
    const lot = getLot(id);
    const produced =
      db
        .select({ n: count() })
        .from(items)
        .where(and(eq(items.lotId, id), isNull(items.deletedAt)))
        .get()?.n ?? 0;
    if (produced > 0) {
      throw new ApiError(
        409,
        'lot_has_items',
        `This lot produced ${produced} item(s); they would lose their purchase record`,
      );
    }
    // Free the requests it was holding.
    const lineIds = db
      .select({ id: lotLines.id })
      .from(lotLines)
      .where(eq(lotLines.lotId, id))
      .all()
      .map((r) => r.id);
    if (lineIds.length > 0) {
      db.update(requests)
        .set({ status: 'open', lotLineId: null })
        .where(inArray(requests.lotLineId, lineIds))
        .run();
    }
    db.update(lots).set({ deletedAt: new Date() }).where(eq(lots.id, id)).run();
    logEvent({
      entityType: 'lot', entityId: id, entityHumanId: lot.humanId,
      action: 'soft_deleted', userId: user.id,
    });
    return db.select().from(lots).where(eq(lots.id, id)).get()!;
  });

  return c.json(
    {
      ...serializeAudit(row),
      supplierName: supplierNameFor(row.supplierId),
      orderedAt: toIso(row.orderedAt),
      receivedAt: toIso(row.receivedAt),
    },
    200,
  );
});

// ---------------------------------------------- GET /variants/:id/price-history
const priceHistoryRoute = createRoute({
  method: 'get',
  path: '/variants/{id}/price-history',
  tags: ['lots'],
  middleware: [requireRole('viewer')] as const,
  request: { params: idParam },
  responses: {
    200: {
      description: 'Every purchase price recorded for this variant, oldest first',
      ...jsonContent(z.array(priceHistoryPointSchema)),
    },
    401: errorResponse('Not signed in'),
  },
});

lotsRouter.openapi(priceHistoryRoute, (c) => {
  const { id } = c.req.valid('param');
  return c.json(priceHistory(id), 200);
});

// ------------------------------------------------------------- GET /suppliers
// The autocomplete behind every lot. A short list, so it is not paginated.
const supplierListRoute = createRoute({
  method: 'get',
  path: '/suppliers',
  tags: ['lots'],
  middleware: [requireRole('viewer')] as const,
  responses: {
    200: { description: 'Every supplier, most used first', ...jsonContent(z.array(supplierSchema)) },
    401: errorResponse('Not signed in'),
  },
});

lotsRouter.openapi(supplierListRoute, (c) => {
  const rows = db
    .select({
      supplier: suppliers,
      lotCount: sql<number>`(
        select count(*) from lots
        where lots.supplier_id = ${suppliers.id} and lots.deleted_at is null
      )`,
    })
    .from(suppliers)
    .where(isNull(suppliers.deletedAt))
    .all();

  // Most-used first: the shop you buy from weekly should be the first option.
  rows.sort((a, b) => b.lotCount - a.lotCount || a.supplier.name.localeCompare(b.supplier.name));
  return c.json(rows.map((row) => serializeAudit(row.supplier)), 200);
});

// ------------------------------------------------------------ POST /suppliers
const supplierCreateRoute = createRoute({
  method: 'post',
  path: '/suppliers',
  tags: ['lots'],
  middleware: [requireRole('manager')] as const,
  request: { body: { content: { 'application/json': { schema: supplierCreateSchema } } } },
  responses: {
    201: { description: 'Created supplier', ...jsonContent(supplierSchema) },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires manager role'),
  },
});

lotsRouter.openapi(supplierCreateRoute, (c) => {
  const body = c.req.valid('json');
  const user = c.get('user');
  const row = db.transaction(() => {
    // Find-or-create, so pressing save twice cannot split a price history.
    const id = resolveSupplier({ newSupplierName: body.name }, user.id)!;
    if (body.notes) db.update(suppliers).set({ notes: body.notes }).where(eq(suppliers.id, id)).run();
    return db.select().from(suppliers).where(eq(suppliers.id, id)).get()!;
  });
  return c.json(serializeAudit(row), 201);
});

// ------------------------------------------------------- DELETE /suppliers/:id
const supplierDeleteRoute = createRoute({
  method: 'delete',
  path: '/suppliers/{id}',
  tags: ['lots'],
  middleware: [requireRole('manager')] as const,
  request: { params: idParam },
  responses: {
    200: { description: 'Deleted supplier', ...jsonContent(supplierSchema) },
    401: errorResponse('Not signed in'),
    404: errorResponse('Not found'),
    409: errorResponse('Still used by lots'),
  },
});

lotsRouter.openapi(supplierDeleteRoute, (c) => {
  const { id } = c.req.valid('param');
  const user = c.get('user');
  const row = db.transaction(() => {
    const supplier = db
      .select()
      .from(suppliers)
      .where(and(eq(suppliers.id, id), isNull(suppliers.deletedAt)))
      .get();
    if (!supplier) throw notFoundError('supplier', id);

    const used =
      db
        .select({ n: count() })
        .from(lots)
        .where(and(eq(lots.supplierId, id), isNull(lots.deletedAt)))
        .get()?.n ?? 0;
    if (used > 0) {
      throw new ApiError(
        409,
        'supplier_in_use',
        `${supplier.name} is on ${used} lot${used === 1 ? '' : 's'}`,
      );
    }

    db.update(suppliers).set({ deletedAt: new Date() }).where(eq(suppliers.id, id)).run();
    logEvent({
      entityType: 'supplier', entityId: id, entityHumanId: supplier.humanId,
      action: 'soft_deleted', userId: user.id,
    });
    return db.select().from(suppliers).where(eq(suppliers.id, id)).get()!;
  });
  return c.json(serializeAudit(row), 200);
});

// ------------------------------------------------------- GET /suppliers/stats
const supplierStatsRoute = createRoute({
  method: 'get',
  path: '/suppliers/stats',
  tags: ['lots'],
  middleware: [requireRole('viewer')] as const,
  responses: {
    200: {
      description:
        'Reliability and lead time per supplier, accumulated from reception ' +
        'discrepancies. Nothing to configure.',
      ...jsonContent(z.array(supplierStatsSchema)),
    },
    401: errorResponse('Not signed in'),
  },
});

lotsRouter.openapi(supplierStatsRoute, (c) => c.json(supplierStats(), 200));

// ------------------------------------- GET /lots/suggest/{conceptId}
// "What we bought last time", in one click — most reorders are repeats.
const suggestRoute = createRoute({
  method: 'get',
  path: '/lots/suggest/{conceptId}',
  tags: ['lots'],
  middleware: [requireRole('viewer')] as const,
  request: { params: z.object({ conceptId: z.uuid() }) },
  responses: {
    200: {
      description: 'Variants already bought for this concept, with last price',
      ...jsonContent(
        z.array(
          z.object({
            variantId: z.uuid(),
            humanId: z.string(),
            name: translatedTextSchema,
            packSize: z.number().nullable(),
            packUnit: z.string().nullable(),
            supplier: z.string().nullable(),
            lastPriceAmount: z.number().int().nullable(),
            lastPriceCurrency: z.string().nullable(),
            lastPurchasedAt: z.iso.datetime().nullable(),
            timesPurchased: z.number().int(),
          }),
        ),
      ),
    },
    401: errorResponse('Not signed in'),
  },
});

lotsRouter.openapi(suggestRoute, (c) => {
  const { conceptId } = c.req.valid('param');

  const candidates = db
    .select()
    .from(variants)
    .where(and(eq(variants.conceptId, conceptId), isNull(variants.deletedAt)))
    .orderBy(variants.humanId)
    .all();

  const rows = candidates.map((variant) => {
    const last = lastPriceForVariant(variant.id);
    const times =
      db
        .select({ n: count() })
        .from(lotLines)
        .where(and(eq(lotLines.orderedVariantId, variant.id), isNull(lotLines.deletedAt)))
        .get()?.n ?? 0;
    return {
      variantId: variant.id,
      humanId: variant.humanId,
      name: variant.name,
      packSize: variant.packSize,
      packUnit: variant.packUnit,
      supplier: variant.supplier,
      lastPriceAmount: last?.amount ?? null,
      lastPriceCurrency: last?.currency ?? null,
      lastPurchasedAt: last ? last.date.toISOString() : null,
      timesPurchased: times,
    };
  });

  // Previously-purchased variants first: that is the one-click path.
  rows.sort((a, b) => b.timesPurchased - a.timesPurchased);
  return c.json(rows, 200);
});
