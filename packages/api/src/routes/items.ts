import { createRoute, z } from '@hono/zod-openapi';
import { and, asc, count, desc, eq, inArray, isNull, like, or, sql } from 'drizzle-orm';
import type { AnyColumn, SQL } from 'drizzle-orm';
import {
  DEFAULT_LOCALE,
  ITEM_SORT_KEYS,
  ITEM_STATUSES,
  LOCALES,
  buildCustomFieldsValidator,
  itemAdjustSchema,
  itemCreateSchema,
  itemMoveSchema,
  itemSchema,
  itemStatusSchema,
  itemUpdateSchema,
  itemWithRefsSchema,
  listResponseSchema,
  paginationQuerySchema,
  quickAddResponseSchema,
  quickAddSchema,
  quickSearchResultSchema,
  sortQuerySchema,
} from '@inventory/shared';
import type { ItemSortKey, ItemStatus, SortDirection } from '@inventory/shared';
import { createRouter } from '../lib/router';
import { db } from '../db/client';
import { analogous, concepts, items, locations, types, variants } from '../db/schema';
import { jsonBody, jsonContent, errorResponse, idParam } from '../lib/openapi';
import { serializeAudit, toIso } from '../lib/serialize';
import { requireRole } from '../middleware/auth';
import type { AuthEnv } from '../middleware/auth';
import { ApiError, notFoundError } from '../middleware/error';
import { reconcileOnClose } from '../services/actions';
import { logEvent } from '../services/history';
import { generateHumanId } from '../services/ids';
import { subtreeIds } from './locations';

export const itemsRouter = createRouter<AuthEnv>();

// ---------------------------------------------------------------- helpers

type ItemRow = typeof items.$inferSelect;
type TypeRow = typeof types.$inferSelect;

function serializeItem(row: ItemRow) {
  return {
    ...serializeAudit(row),
    receivedAt: toIso(row.receivedAt),
    openedAt: toIso(row.openedAt),
    depletedAt: toIso(row.depletedAt),
  };
}

function getActiveItem(id: string): ItemRow {
  const row = db
    .select()
    .from(items)
    .where(and(eq(items.id, id), isNull(items.deletedAt)))
    .get();
  if (!row) throw notFoundError('item', id);
  return row;
}

function getActiveType(id: string): TypeRow {
  const row = db
    .select()
    .from(types)
    .where(and(eq(types.id, id), isNull(types.deletedAt)))
    .get();
  if (!row) throw notFoundError('type', id);
  return row;
}

/** Runtime validation of user-defined fields against the Type. */
function validateCustomFields(
  type: TypeRow,
  customFields: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const validator = buildCustomFieldsValidator(type.fieldDefinitions);
  const result = validator.safeParse(customFields ?? {});
  if (!result.success) {
    throw new ApiError(400, 'invalid_custom_fields', 'Custom fields failed validation', result.error.issues);
  }
  return result.data;
}

function assertValidStatus(type: TypeRow, status: ItemStatus): void {
  if (!type.validStatuses.includes(status)) {
    throw new ApiError(
      400,
      'invalid_status',
      `Status '${status}' is not valid for type '${type.key}' (allowed: ${type.validStatuses.join(', ')})`,
    );
  }
}

const refsSelect = {
  row: items,
  typeName: types.name,
  typeKey: types.key,
  conceptName: concepts.name,
  conceptHumanId: concepts.humanId,
  analogousName: analogous.name,
  variantName: variants.name,
  variantHumanId: variants.humanId,
  locationCode: locations.code,
  locationName: locations.name,
};

function withRefsQuery() {
  return db
    .select(refsSelect)
    .from(items)
    .leftJoin(types, eq(items.typeId, types.id))
    .leftJoin(concepts, eq(items.conceptId, concepts.id))
    .leftJoin(analogous, eq(items.analogousId, analogous.id))
    .leftJoin(variants, eq(items.variantId, variants.id))
    .leftJoin(locations, eq(items.locationId, locations.id));
}

function serializeWithRefs<T extends { row: ItemRow }>({ row, ...refs }: T) {
  return { ...serializeItem(row), ...refs };
}

/**
 * A translated name sorts by what the reader actually sees.
 *
 * Names are JSON columns (`{"en":"Wood glue","ca":"Heptà"}`), so ordering by the
 * raw column would sort by whatever language happens to come first in the JSON
 * — which is stable, and wrong for everyone reading in Catalan. `json_extract`
 * pulls the requested language out and falls back to English, which is the
 * same rule `resolveText()` applies in the browser.
 */
function displayName(column: AnyColumn, locale: string): SQL {
  return sql`lower(coalesce(json_extract(${column}, ${`$.${locale}`}), json_extract(${column}, '$.en')))`;
}

/**
 * NULLs last in both directions. SQLite sorts NULL before everything, so a
 * page of items with no price would open with a column of dashes and bury the
 * cheapest real item at the bottom — the opposite of what clicking "price"
 * asks for.
 */
function nullsLast(expression: SQL | AnyColumn, direction: SortDirection): SQL[] {
  const order = direction === 'desc' ? desc(expression) : asc(expression);
  return [sql`(${expression}) is null`, order];
}

function itemOrderBy(sort: ItemSortKey | undefined, dir: SortDirection, locale: string): SQL[] {
  switch (sort) {
    case 'humanId': return nullsLast(items.humanId, dir);
    case 'type': return nullsLast(displayName(types.name, locale), dir);
    case 'concept': return nullsLast(displayName(concepts.name, locale), dir);
    case 'variant': return nullsLast(displayName(variants.name, locale), dir);
    case 'status': return nullsLast(items.status, dir);
    case 'location': return nullsLast(locations.code, dir);
    case 'remaining': return nullsLast(items.quantityRemaining, dir);
    case 'received': return nullsLast(items.receivedAt, dir);
    case 'price': return nullsLast(items.priceAmount, dir);
    // No column chosen: newest first, which is what you want when you have just
    // added something and go looking for it.
    default: return [desc(items.createdAt), asc(items.humanId)];
  }
}

// ------------------------------------------------------------- GET /items
const listRoute = createRoute({
  method: 'get',
  path: '/items',
  tags: ['items'],
  middleware: [requireRole('viewer')] as const,
  request: {
    query: paginationQuerySchema.extend({
      // comma-separated: ?status=in_stock,open
      status: z.string().optional(),
      typeId: z.uuid().optional(),
      conceptId: z.uuid().optional(),
      variantId: z.uuid().optional(),
      locationId: z.uuid().optional(), // includes the whole subtree
      /** Narrow that to the shelf itself: "what is on THIS shelf", not below it. */
      locationExact: z.enum(['true', 'false']).optional(),
      search: z.string().optional(),
      // Sorting is server-side so a click on a header orders every matching
      // item, not the 25 that happen to be on screen (see sortQuerySchema).
      ...sortQuerySchema(ITEM_SORT_KEYS).shape,
      /** Which language the name columns sort by. */
      locale: z.enum(LOCALES).optional(),
    }),
  },
  responses: {
    200: {
      description: 'Paginated items with display references',
      ...jsonContent(listResponseSchema(itemWithRefsSchema)),
    },
    401: errorResponse('Not signed in'),
  },
});

itemsRouter.openapi(listRoute, (c) => {
  const q = c.req.valid('query');

  const conditions = [isNull(items.deletedAt)];
  if (q.status) {
    const statuses = q.status
      .split(',')
      .filter((s): s is ItemStatus => (ITEM_STATUSES as readonly string[]).includes(s));
    if (statuses.length > 0) conditions.push(inArray(items.status, statuses));
  }
  if (q.typeId) conditions.push(eq(items.typeId, q.typeId));
  if (q.conceptId) conditions.push(eq(items.conceptId, q.conceptId));
  if (q.variantId) conditions.push(eq(items.variantId, q.variantId));
  if (q.locationId) {
    conditions.push(
      q.locationExact === 'true'
        ? eq(items.locationId, q.locationId)
        : inArray(items.locationId, subtreeIds(q.locationId)),
    );
  }
  if (q.search) {
    const term = `%${q.search.toLowerCase()}%`;
    conditions.push(
      or(
        like(sql`lower(${items.humanId})`, term),
        like(sql`lower(coalesce(${items.serialNumber}, ''))`, term),
        like(sql`lower(coalesce(${items.batchNumber}, ''))`, term),
        like(sql`lower(coalesce(${items.notes}, ''))`, term),
      )!,
    );
  }
  const where = and(...conditions);

  const total = db.select({ n: count() }).from(items).where(where).get()?.n ?? 0;
  const rows = withRefsQuery()
    .where(where)
    .orderBy(...itemOrderBy(q.sort, q.dir ?? 'asc', q.locale ?? DEFAULT_LOCALE))
    .limit(q.perPage)
    .offset((q.page - 1) * q.perPage)
    .all();

  return c.json(
    {
      data: rows.map(serializeWithRefs),
      meta: {
        page: q.page,
        perPage: q.perPage,
        total,
        totalPages: Math.max(1, Math.ceil(total / q.perPage)),
      },
    },
    200,
  );
});

// ----------------------------------------------------- GET /items/metrics
const metricsRoute = createRoute({
  method: 'get',
  path: '/items/metrics',
  tags: ['items'],
  middleware: [requireRole('viewer')] as const,
  request: { query: z.object({ locationId: z.uuid().optional() }) },
  responses: {
    200: {
      description: 'Counts for the Home summary strip',
      ...jsonContent(z.object({ activeItems: z.number(), openItems: z.number() })),
    },
    401: errorResponse('Not signed in'),
  },
});

itemsRouter.openapi(metricsRoute, (c) => {
  const { locationId } = c.req.valid('query');
  const locationFilter = locationId
    ? inArray(items.locationId, subtreeIds(locationId))
    : undefined;

  const activeItems =
    db
      .select({ n: count() })
      .from(items)
      .where(and(isNull(items.deletedAt), inArray(items.status, ['in_stock', 'open']), locationFilter))
      .get()?.n ?? 0;
  const openItems =
    db
      .select({ n: count() })
      .from(items)
      .where(and(isNull(items.deletedAt), eq(items.status, 'open'), locationFilter))
      .get()?.n ?? 0;

  return c.json({ activeItems, openItems }, 200);
});

// ------------------------------------------------ GET /items/quick-search
const quickSearchRoute = createRoute({
  method: 'get',
  path: '/items/quick-search',
  tags: ['items'],
  middleware: [requireRole('viewer')] as const,
  request: { query: z.object({ q: z.string().min(1) }) },
  responses: {
    200: {
      description: 'Typeahead for Quick Add: variants ranked above concepts, all languages',
      ...jsonContent(quickSearchResultSchema),
    },
    401: errorResponse('Not signed in'),
  },
});

itemsRouter.openapi(quickSearchRoute, (c) => {
  const { q } = c.req.valid('query');
  const term = `%${q.toLowerCase()}%`;

  const variantRows = db
    .select({
      id: variants.id,
      humanId: variants.humanId,
      name: variants.name,
      brand: variants.brand,
      packSize: variants.packSize,
      packUnit: variants.packUnit,
      typeId: variants.typeId,
      conceptId: variants.conceptId,
    })
    .from(variants)
    .where(
      and(
        isNull(variants.deletedAt),
        or(
          like(sql`lower(${variants.name})`, term),
          like(sql`lower(coalesce(${variants.brand}, ''))`, term),
        )!,
      ),
    )
    .limit(8)
    .all();

  const conceptRows = db
    .select({
      id: concepts.id,
      humanId: concepts.humanId,
      name: concepts.name,
      unit: concepts.unit,
    })
    .from(concepts)
    .where(and(isNull(concepts.deletedAt), like(sql`lower(${concepts.name})`, term)))
    .limit(5)
    .all();

  return c.json({ variants: variantRows, concepts: conceptRows }, 200);
});

// ------------------------------------------------------- POST /items/quick
const quickAddRoute = createRoute({
  method: 'post',
  path: '/items/quick',
  tags: ['items'],
  middleware: [requireRole('operator')] as const,
  request: jsonBody(quickAddSchema),
  responses: {
    201: { description: 'Quick Add result', ...jsonContent(quickAddResponseSchema) },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires operator role'),
    404: errorResponse('Type / variant / location not found'),
  },
});

itemsRouter.openapi(quickAddRoute, (c) => {
  const body = c.req.valid('json');
  const user = c.get('user');

  // The whole find-or-create chain is ONE transaction:
  // concept + analogous + variant + item(s) + every history row — all or nothing.
  const result = db.transaction(() => {
    let variantId: string;
    let conceptId: string;
    let analogousId: string;
    let typeId: string;
    let unit: string | null = body.unit ?? null;
    let chainCreated = false;

    if (body.existingVariantId) {
      const variant = db
        .select()
        .from(variants)
        .where(and(eq(variants.id, body.existingVariantId), isNull(variants.deletedAt)))
        .get();
      if (!variant) throw notFoundError('variant', body.existingVariantId);
      variantId = variant.id;
      conceptId = variant.conceptId;
      analogousId = variant.analogousId;
      typeId = variant.typeId; // the variant knows its type better than the form
      unit ??= variant.packUnit;
    } else {
      // No match picked → create the invisible 1:1 chain. Nothing marks these
      // as second-class; a power user can unfold them later.
      const name = { en: body.name };
      conceptId = crypto.randomUUID();
      const conceptHumanId = generateHumanId('CON', 'simple');
      db.insert(concepts)
        .values({ id: conceptId, humanId: conceptHumanId, name, unit: body.unit ?? 'unit' })
        .run();
      logEvent({
        entityType: 'concept', entityId: conceptId, entityHumanId: conceptHumanId,
        action: 'created', valueAfter: { name, quickAdd: true }, userId: user.id,
      });

      analogousId = crypto.randomUUID();
      const anaHumanId = generateHumanId('ANA', 'simple');
      db.insert(analogous)
        .values({ id: analogousId, humanId: anaHumanId, conceptId, name })
        .run();
      logEvent({
        entityType: 'analogous', entityId: analogousId, entityHumanId: anaHumanId,
        action: 'created', valueAfter: { name, quickAdd: true }, userId: user.id,
      });

      variantId = crypto.randomUUID();
      const varHumanId = generateHumanId('VAR', 'simple');
      db.insert(variants)
        .values({ id: variantId, humanId: varHumanId, analogousId, conceptId, typeId: body.typeId, name })
        .run();
      logEvent({
        entityType: 'variant', entityId: variantId, entityHumanId: varHumanId,
        action: 'created', valueAfter: { name, quickAdd: true }, userId: user.id,
      });

      typeId = body.typeId;
      chainCreated = true;
    }

    const type = getActiveType(typeId);
    if (body.locationId) {
      const loc = db
        .select()
        .from(locations)
        .where(and(eq(locations.id, body.locationId), isNull(locations.deletedAt)))
        .get();
      if (!loc) throw notFoundError('location', body.locationId);
    }
    const customFields = validateCustomFields(type, body.customFields);
    const status = type.validStatuses[0]!;
    const quantity = type.tracksQuantity ? (body.quantity ?? null) : null;

    const created: ItemRow[] = [];
    for (let i = 0; i < body.copies; i++) {
      const id = crypto.randomUUID();
      const humanId = generateHumanId(type.humanIdPrefix, 'lettered');
      db.insert(items)
        .values({
          id,
          humanId,
          typeId,
          variantId,
          analogousId,
          conceptId,
          locationId: body.locationId ?? null,
          status,
          quantityInitial: quantity,
          quantityRemaining: quantity,
          unit,
          priceAmount: body.priceAmount ?? null,
          priceCurrency: body.priceAmount != null ? (body.priceCurrency ?? 'EUR') : null,
          priceLocked: body.priceAmount != null,
          customFields,
          receivedAt: new Date(),
          createdBy: user.id,
        })
        .run();
      logEvent({
        entityType: 'item', entityId: id, entityHumanId: humanId,
        action: 'created', valueAfter: { quickAdd: true, name: body.name }, userId: user.id,
      });
      created.push(db.select().from(items).where(eq(items.id, id)).get()!);
    }
    return { items: created, variantId, chainCreated };
  });

  return c.json(
    { items: result.items.map(serializeItem), variantId: result.variantId, chainCreated: result.chainCreated },
    201,
  );
});

// ------------------------------------------------------------ POST /items
const createRoute_ = createRoute({
  method: 'post',
  path: '/items',
  tags: ['items'],
  middleware: [requireRole('operator')] as const,
  request: jsonBody(itemCreateSchema),
  responses: {
    201: { description: 'Created item(s) — one per copy', ...jsonContent(z.array(itemSchema)) },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires operator role'),
    404: errorResponse('Type / variant / location not found'),
  },
});

itemsRouter.openapi(createRoute_, (c) => {
  const body = c.req.valid('json');
  const user = c.get('user');

  const created = db.transaction(() => {
    let typeId = body.typeId;
    let conceptId: string | null = null;
    let analogousId: string | null = null;

    if (body.variantId) {
      const variant = db
        .select()
        .from(variants)
        .where(and(eq(variants.id, body.variantId), isNull(variants.deletedAt)))
        .get();
      if (!variant) throw notFoundError('variant', body.variantId);
      conceptId = variant.conceptId;
      analogousId = variant.analogousId;
      typeId = variant.typeId; // denormalized ids always come from the variant
    }

    const type = getActiveType(typeId);
    const status = body.status ?? type.validStatuses[0]!;
    assertValidStatus(type, status);
    const customFields = validateCustomFields(type, body.customFields);
    if (body.locationId) {
      const loc = db
        .select()
        .from(locations)
        .where(and(eq(locations.id, body.locationId), isNull(locations.deletedAt)))
        .get();
      if (!loc) throw notFoundError('location', body.locationId);
    }
    const quantity = type.tracksQuantity ? (body.quantityInitial ?? null) : null;

    const rows: ItemRow[] = [];
    for (let i = 0; i < body.copies; i++) {
      const id = crypto.randomUUID();
      const humanId = generateHumanId(type.humanIdPrefix, 'lettered');
      db.insert(items)
        .values({
          id,
          humanId,
          typeId,
          variantId: body.variantId ?? null,
          analogousId,
          conceptId,
          locationId: body.locationId ?? null,
          status,
          quantityInitial: quantity,
          quantityRemaining: quantity,
          unit: body.unit ?? null,
          priceAmount: body.priceAmount ?? null,
          priceCurrency: body.priceAmount != null ? (body.priceCurrency ?? 'EUR') : null,
          // Price is locked at creation ( / PLAN) — price
          // changes are never retroactive.
          priceLocked: body.priceAmount != null,
          serialNumber: body.serialNumber ?? null,
          batchNumber: body.batchNumber ?? null,
          customFields,
          receivedAt: body.receivedAt ? new Date(body.receivedAt) : new Date(),
          notes: body.notes ?? null,
          createdBy: user.id,
        })
        .run();
      logEvent({
        entityType: 'item', entityId: id, entityHumanId: humanId,
        action: 'created', userId: user.id,
      });
      rows.push(db.select().from(items).where(eq(items.id, id)).get()!);
    }
    return rows;
  });

  return c.json(created.map(serializeItem), 201);
});

// --------------------------------------------------------- GET /items/:id
const detailRoute = createRoute({
  method: 'get',
  path: '/items/{id}',
  tags: ['items'],
  middleware: [requireRole('viewer')] as const,
  request: { params: idParam },
  responses: {
    200: { description: 'Item with display references', ...jsonContent(itemWithRefsSchema) },
    401: errorResponse('Not signed in'),
    404: errorResponse('Not found'),
  },
});

itemsRouter.openapi(detailRoute, (c) => {
  const { id } = c.req.valid('param');
  const row = withRefsQuery().where(and(eq(items.id, id), isNull(items.deletedAt))).get();
  if (!row) throw notFoundError('item', id);
  return c.json(serializeWithRefs(row), 200);
});

// ------------------------------------------------------- PATCH /items/:id
const updateRoute = createRoute({
  method: 'patch',
  path: '/items/{id}',
  tags: ['items'],
  middleware: [requireRole('operator')] as const,
  request: { params: idParam, ...jsonBody(itemUpdateSchema) },
  responses: {
    200: { description: 'Updated item', ...jsonContent(itemSchema) },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires operator role'),
    404: errorResponse('Not found'),
  },
});

itemsRouter.openapi(updateRoute, (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const user = c.get('user');

  const updated = db.transaction(() => {
    const before = getActiveItem(id);
    const type = getActiveType(before.typeId);

    let denorm: Partial<ItemRow> = {};
    if (body.variantId !== undefined && body.variantId !== before.variantId) {
      if (body.variantId === null) {
        denorm = { variantId: null, analogousId: null, conceptId: null };
      } else {
        const variant = db
          .select()
          .from(variants)
          .where(and(eq(variants.id, body.variantId), isNull(variants.deletedAt)))
          .get();
        if (!variant) throw notFoundError('variant', body.variantId);
        denorm = {
          variantId: variant.id,
          analogousId: variant.analogousId,
          conceptId: variant.conceptId,
        };
      }
    }

    const customFields =
      body.customFields !== undefined && body.customFields !== null
        ? validateCustomFields(type, body.customFields)
        : undefined;

    db.update(items)
      .set({
        ...denorm,
        ...(body.locationId !== undefined ? { locationId: body.locationId } : {}),
        ...(body.quantityInitial !== undefined ? { quantityInitial: body.quantityInitial } : {}),
        ...(body.unit !== undefined ? { unit: body.unit } : {}),
        // Locked prices never change (PLAN)
        ...(body.priceAmount !== undefined && !before.priceLocked
          ? { priceAmount: body.priceAmount, priceLocked: body.priceAmount != null }
          : {}),
        ...(body.priceCurrency !== undefined && !before.priceLocked
          ? { priceCurrency: body.priceCurrency }
          : {}),
        ...(body.serialNumber !== undefined ? { serialNumber: body.serialNumber } : {}),
        ...(body.batchNumber !== undefined ? { batchNumber: body.batchNumber } : {}),
        ...(customFields !== undefined ? { customFields } : {}),
        ...(body.receivedAt !== undefined
          ? { receivedAt: body.receivedAt ? new Date(body.receivedAt) : null }
          : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
      })
      .where(eq(items.id, id))
      .run();

    const beforeRecord = before as unknown as Record<string, unknown>;
    for (const [field, after] of Object.entries(body)) {
      if (after === undefined) continue;
      const prev =
        beforeRecord[field] instanceof Date
          ? (beforeRecord[field] as Date).toISOString()
          : (beforeRecord[field] ?? null);
      if (JSON.stringify(prev) === JSON.stringify(after)) continue;
      logEvent({
        entityType: 'item', entityId: id, entityHumanId: before.humanId,
        action: 'updated', fieldChanged: field, valueBefore: prev, valueAfter: after,
        userId: user.id,
      });
    }
    return db.select().from(items).where(eq(items.id, id)).get()!;
  });
  return c.json(serializeItem(updated), 200);
});

// ------------------------------------------------- item lifecycle actions
// Status never changes through PATCH — only through these endpoints, each
// validated against the Type's validStatuses.

function statusChange(
  id: string,
  userId: string,
  next: ItemStatus,
  extra: Partial<ItemRow>,
  options: {
    requireCurrent?: ItemStatus[];
    note?: string;
    /** Runs inside the transaction, with the row as it was before the change. */
    onBefore?: (row: ItemRow, userId: string) => void;
  } = {},
): ItemRow {
  return db.transaction(() => {
    const before = getActiveItem(id);
    const type = getActiveType(before.typeId);
    assertValidStatus(type, next);
    if (options.requireCurrent && !options.requireCurrent.includes(before.status)) {
      throw new ApiError(
        409,
        'invalid_transition',
        `Cannot go from '${before.status}' to '${next}'`,
      );
    }
    options.onBefore?.(before, userId);
    db.update(items).set({ status: next, ...extra }).where(eq(items.id, id)).run();
    logEvent({
      entityType: 'item', entityId: id, entityHumanId: before.humanId,
      action: 'status_changed', fieldChanged: 'status',
      valueBefore: before.status, valueAfter: next,
      notes: options.note ?? null, userId,
    });
    return db.select().from(items).where(eq(items.id, id)).get()!;
  });
}

const actionResponses = {
  200: { description: 'Updated item', ...jsonContent(itemSchema) },
  401: errorResponse('Not signed in'),
  403: errorResponse('Requires operator role'),
  404: errorResponse('Not found'),
  409: errorResponse('Invalid transition'),
};

const openRoute = createRoute({
  method: 'post',
  path: '/items/{id}/open',
  tags: ['items'],
  middleware: [requireRole('operator')] as const,
  request: { params: idParam },
  responses: actionResponses,
});
itemsRouter.openapi(openRoute, (c) => {
  const { id } = c.req.valid('param');
  const row = statusChange(id, c.get('user').id, 'open', { openedAt: new Date() }, {
    requireCurrent: ['in_stock'],
  });
  return c.json(serializeItem(row), 200);
});

const depleteRoute = createRoute({
  method: 'post',
  path: '/items/{id}/deplete',
  tags: ['items'],
  middleware: [requireRole('operator')] as const,
  request: { params: idParam },
  responses: actionResponses,
});
itemsRouter.openapi(depleteRoute, (c) => {
  const { id } = c.req.valid('param');
  // The depletion event is trusted reality: quantity goes to 0 (PLAN).
  // It is also the moment the container closes, which is the only moment a
  // level-3 reconciliation can be written — the human's word is what
  // settles the gap between the map's estimate and what the container held.
  const row = statusChange(
    id,
    c.get('user').id,
    'depleted',
    { depletedAt: new Date(), quantityRemaining: 0 },
    { requireCurrent: ['in_stock', 'open'], onBefore: reconcileOnClose },
  );
  return c.json(serializeItem(row), 200);
});

const genericStatusRoute = createRoute({
  method: 'post',
  path: '/items/{id}/status',
  tags: ['items'],
  middleware: [requireRole('operator')] as const,
  request: { params: idParam, ...jsonBody(itemStatusSchema) },
  responses: actionResponses,
});
itemsRouter.openapi(genericStatusRoute, (c) => {
  const { id } = c.req.valid('param');
  const { status } = c.req.valid('json');
  const before = getActiveItem(id);
  // Leaving a lifecycle state clears its timestamp (used by toast-undo).
  const extra: Partial<ItemRow> = {};
  if (before.status === 'depleted' && status !== 'depleted') extra.depletedAt = null;
  if (before.status === 'open' && status === 'in_stock') extra.openedAt = null;
  const row = statusChange(id, c.get('user').id, status, extra);
  return c.json(serializeItem(row), 200);
});

const moveRoute = createRoute({
  method: 'post',
  path: '/items/{id}/move',
  tags: ['items'],
  middleware: [requireRole('operator')] as const,
  request: { params: idParam, ...jsonBody(itemMoveSchema) },
  responses: actionResponses,
});
itemsRouter.openapi(moveRoute, (c) => {
  const { id } = c.req.valid('param');
  const { locationId } = c.req.valid('json');
  const user = c.get('user');

  const row = db.transaction(() => {
    const before = getActiveItem(id);
    const target = db
      .select()
      .from(locations)
      .where(and(eq(locations.id, locationId), isNull(locations.deletedAt)))
      .get();
    if (!target) throw notFoundError('location', locationId);
    const from = before.locationId
      ? db.select().from(locations).where(eq(locations.id, before.locationId)).get()
      : null;

    db.update(items).set({ locationId }).where(eq(items.id, id)).run();
    logEvent({
      entityType: 'item', entityId: id, entityHumanId: before.humanId,
      action: 'moved', fieldChanged: 'locationId',
      valueBefore: from?.code ?? null, valueAfter: target.code,
      userId: user.id,
    });
    return db.select().from(items).where(eq(items.id, id)).get()!;
  });
  return c.json(serializeItem(row), 200);
});

const adjustRoute = createRoute({
  method: 'post',
  path: '/items/{id}/adjust',
  tags: ['items'],
  middleware: [requireRole('operator')] as const,
  request: { params: idParam, ...jsonBody(itemAdjustSchema) },
  responses: actionResponses,
});
itemsRouter.openapi(adjustRoute, (c) => {
  const { id } = c.req.valid('param');
  const { quantityRemaining, note } = c.req.valid('json');
  const user = c.get('user');

  const row = db.transaction(() => {
    const before = getActiveItem(id);
    db.update(items).set({ quantityRemaining }).where(eq(items.id, id)).run();
    logEvent({
      entityType: 'item', entityId: id, entityHumanId: before.humanId,
      action: 'quantity_adjusted', fieldChanged: 'quantityRemaining',
      valueBefore: before.quantityRemaining, valueAfter: quantityRemaining,
      notes: note, userId: user.id,
    });
    return db.select().from(items).where(eq(items.id, id)).get()!;
  });
  return c.json(serializeItem(row), 200);
});

// ------------------------------------------------------ DELETE /items/:id
const deleteRoute = createRoute({
  method: 'delete',
  path: '/items/{id}',
  tags: ['items'],
  middleware: [requireRole('manager')] as const,
  request: { params: idParam },
  responses: {
    200: { description: 'Soft-deleted item', ...jsonContent(itemSchema) },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires manager role'),
    404: errorResponse('Not found'),
  },
});
itemsRouter.openapi(deleteRoute, (c) => {
  const { id } = c.req.valid('param');
  const user = c.get('user');

  const row = db.transaction(() => {
    const before = getActiveItem(id);
    db.update(items).set({ deletedAt: new Date() }).where(eq(items.id, id)).run();
    logEvent({
      entityType: 'item', entityId: id, entityHumanId: before.humanId,
      action: 'soft_deleted', userId: user.id,
    });
    return db.select().from(items).where(eq(items.id, id)).get()!;
  });
  return c.json(serializeItem(row), 200);
});
