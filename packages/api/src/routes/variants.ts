import { createRoute, z } from '@hono/zod-openapi';
import { and, asc, count, desc, eq, isNull, like, or, sql } from 'drizzle-orm';
import type { AnyColumn, SQL } from 'drizzle-orm';
import {
  DEFAULT_LOCALE,
  LOCALES,
  VARIANT_SORT_KEYS,
  listResponseSchema,
  paginationQuerySchema,
  sortQuerySchema,
  variantCreateSchema,
  variantSchema,
  variantUpdateSchema,
  variantWithRefsSchema,
} from '@inventory/shared';
import type { SortDirection, VariantSortKey } from '@inventory/shared';
import { createRouter } from '../lib/router';
import { db } from '../db/client';
import { analogous, concepts, items, types, variants } from '../db/schema';
import { jsonBody, jsonContent, errorResponse, idParam } from '../lib/openapi';
import { serializeAudit } from '../lib/serialize';
import { requireRole } from '../middleware/auth';
import type { AuthEnv } from '../middleware/auth';
import { ApiError, notFoundError } from '../middleware/error';
import { cascadeFromVariant, previewVariantCascade } from '../services/cascade';
import { logEvent } from '../services/history';
import { generateHumanId } from '../services/ids';

export const variantsRouter = createRouter<AuthEnv>();

function getActive(id: string) {
  const row = db
    .select()
    .from(variants)
    .where(and(eq(variants.id, id), isNull(variants.deletedAt)))
    .get();
  if (!row) throw notFoundError('variant', id);
  return row;
}

function getActiveAnalogous(id: string) {
  const row = db
    .select()
    .from(analogous)
    .where(and(eq(analogous.id, id), isNull(analogous.deletedAt)))
    .get();
  if (!row) throw notFoundError('analogous', id);
  return row;
}

// Same ordering rules as the Items table — see the note there. Duplicated
// rather than shared because the two tables order by different columns and a
// generic "sort anything" helper would need a column registry to stay honest.
function displayName(column: AnyColumn, locale: string): SQL {
  return sql`lower(coalesce(json_extract(${column}, ${`$.${locale}`}), json_extract(${column}, '$.en')))`;
}

function nullsLast(expression: SQL | AnyColumn, direction: SortDirection): SQL[] {
  const order = direction === 'desc' ? desc(expression) : asc(expression);
  return [sql`(${expression}) is null`, order];
}

/**
 * The item count is not a column on `variants` — it is a correlated count, and
 * it has to be the same expression the response reports or the sort would
 * disagree with the number printed next to it.
 */
const itemCountExpr = sql<number>`(
  select count(*) from items
  where items.variant_id = ${variants.id} and items.deleted_at is null
)`;

function variantOrderBy(
  sort: VariantSortKey | undefined,
  dir: SortDirection,
  locale: string,
): SQL[] {
  switch (sort) {
    case 'humanId': return nullsLast(variants.humanId, dir);
    case 'name': return nullsLast(displayName(variants.name, locale), dir);
    case 'brand': return nullsLast(sql`lower(${variants.brand})`, dir);
    case 'concept': return nullsLast(displayName(concepts.name, locale), dir);
    case 'type': return nullsLast(displayName(types.name, locale), dir);
    case 'packSize': return nullsLast(variants.packSize, dir);
    case 'items': return nullsLast(itemCountExpr, dir);
    default: return [asc(variants.humanId)];
  }
}

// ------------------------------------------------------------- GET /variants
const listRoute = createRoute({
  method: 'get',
  path: '/variants',
  tags: ['variants'],
  middleware: [requireRole('viewer')] as const,
  request: {
    query: paginationQuerySchema.extend({
      analogousId: z.uuid().optional(),
      conceptId: z.uuid().optional(),
      typeId: z.uuid().optional(),
      search: z.string().optional(),
      ...sortQuerySchema(VARIANT_SORT_KEYS).shape,
      locale: z.enum(LOCALES).optional(),
    }),
  },
  responses: {
    200: {
      description: 'Paginated variants with display references',
      ...jsonContent(listResponseSchema(variantWithRefsSchema)),
    },
    401: errorResponse('Not signed in'),
  },
});

variantsRouter.openapi(listRoute, (c) => {
  const { page, perPage, analogousId, conceptId, typeId, search, sort, dir, locale } =
    c.req.valid('query');

  const conditions = [isNull(variants.deletedAt)];
  if (analogousId) conditions.push(eq(variants.analogousId, analogousId));
  if (conceptId) conditions.push(eq(variants.conceptId, conceptId));
  if (typeId) conditions.push(eq(variants.typeId, typeId));
  if (search) {
    const term = `%${search.toLowerCase()}%`;
    conditions.push(
      or(
        like(sql`lower(${variants.name})`, term),
        like(sql`lower(coalesce(${variants.brand}, ''))`, term),
      )!,
    );
  }
  const where = and(...conditions);

  const total = db.select({ n: count() }).from(variants).where(where).get()?.n ?? 0;
  const rows = db
    .select({
      row: variants,
      analogousName: analogous.name,
      analogousHumanId: analogous.humanId,
      conceptName: concepts.name,
      conceptHumanId: concepts.humanId,
      typeName: types.name,
      typeKey: types.key,
      // Selected rather than looked up in a second query, so the number shown
      // and the number sorted on are the same expression.
      itemCount: itemCountExpr,
    })
    .from(variants)
    .leftJoin(analogous, eq(variants.analogousId, analogous.id))
    .leftJoin(concepts, eq(variants.conceptId, concepts.id))
    .leftJoin(types, eq(variants.typeId, types.id))
    .where(where)
    .orderBy(...variantOrderBy(sort, dir ?? 'asc', locale ?? DEFAULT_LOCALE))
    .limit(perPage)
    .offset((page - 1) * perPage)
    .all();

  return c.json(
    {
      data: rows.map(({ row, ...refs }) => ({
        ...serializeAudit(row),
        ...refs,
      })),
      meta: { page, perPage, total, totalPages: Math.max(1, Math.ceil(total / perPage)) },
    },
    200,
  );
});

// -------------------------------------------------------- GET /variants/options
/** The same dropdown-sized read as /concepts/options — see the note there. */
const optionsRoute = createRoute({
  method: 'get',
  path: '/variants/options',
  tags: ['variants'],
  middleware: [requireRole('viewer')] as const,
  request: {
    query: z.object({ conceptId: z.uuid().optional(), typeId: z.uuid().optional() }),
  },
  responses: {
    200: {
      description: 'Every variant as id + humanId + name + brand + pack, for pickers',
      ...jsonContent(
        z.array(
          variantSchema
            .pick({ id: true, humanId: true, name: true, brand: true, packSize: true, packUnit: true })
            .extend({ conceptId: z.uuid(), typeId: z.uuid() }),
        ),
      ),
    },
    401: errorResponse('Not signed in'),
  },
});

variantsRouter.openapi(optionsRoute, (c) => {
  const { conceptId, typeId } = c.req.valid('query');
  return c.json(
    db
      .select({
        id: variants.id,
        humanId: variants.humanId,
        name: variants.name,
        brand: variants.brand,
        packSize: variants.packSize,
        packUnit: variants.packUnit,
        conceptId: variants.conceptId,
        typeId: variants.typeId,
      })
      .from(variants)
      .where(
        and(
          isNull(variants.deletedAt),
          conceptId ? eq(variants.conceptId, conceptId) : undefined,
          typeId ? eq(variants.typeId, typeId) : undefined,
        ),
      )
      .orderBy(variants.humanId)
      .all(),
    200,
  );
});

// ------------------------------------------------------------ POST /variants
const createRoute_ = createRoute({
  method: 'post',
  path: '/variants',
  tags: ['variants'],
  middleware: [requireRole('manager')] as const,
  request: jsonBody(variantCreateSchema),
  responses: {
    201: { description: 'Created variant', ...jsonContent(variantSchema) },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires manager role'),
    404: errorResponse('Analogous or type not found'),
  },
});

variantsRouter.openapi(createRoute_, (c) => {
  const body = c.req.valid('json');
  const user = c.get('user');

  const parent = getActiveAnalogous(body.analogousId);
  const type = db
    .select()
    .from(types)
    .where(and(eq(types.id, body.typeId), isNull(types.deletedAt)))
    .get();
  if (!type) throw notFoundError('type', body.typeId);

  const row = db.transaction(() => {
    const id = crypto.randomUUID();
    const humanId = generateHumanId('VAR', 'simple');
    db.insert(variants)
      .values({
        id,
        humanId,
        analogousId: body.analogousId,
        conceptId: parent.conceptId, // derived — the client never sends it
        typeId: body.typeId,
        name: body.name,
        brand: body.brand ?? null,
        supplier: body.supplier ?? null,
        catalogRef: body.catalogRef ?? null,
        format: body.format ?? null,
        packSize: body.packSize ?? null,
        packUnit: body.packUnit ?? null,
        purity: body.purity ?? null,
        concentration: body.concentration ?? null,
        notes: body.notes ?? null,
      })
      .run();
    logEvent({
      entityType: 'variant',
      entityId: id,
      entityHumanId: humanId,
      action: 'created',
      valueAfter: body,
      userId: user.id,
    });
    return db.select().from(variants).where(eq(variants.id, id)).get()!;
  });
  return c.json(serializeAudit(row), 201);
});

// ------------------------------------------------------- PATCH /variants/:id
const updateRoute = createRoute({
  method: 'patch',
  path: '/variants/{id}',
  tags: ['variants'],
  middleware: [requireRole('manager')] as const,
  request: { params: idParam, ...jsonBody(variantUpdateSchema) },
  responses: {
    200: { description: 'Updated variant', ...jsonContent(variantSchema) },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires manager role'),
    404: errorResponse('Not found'),
  },
});

variantsRouter.openapi(updateRoute, (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const user = c.get('user');

  const updated = db.transaction(() => {
    const before = getActive(id);

    // THE denormalization sync: moving a variant to another
    // analogous re-derives conceptId and mass-updates every item of this
    // variant — same transaction, all or nothing.
    let newConceptId = before.conceptId;
    if (body.analogousId && body.analogousId !== before.analogousId) {
      const target = getActiveAnalogous(body.analogousId);
      newConceptId = target.conceptId;
      db.update(items)
        .set({ analogousId: body.analogousId, conceptId: newConceptId })
        .where(eq(items.variantId, id))
        .run();
    }

    db.update(variants)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.analogousId !== undefined
          ? { analogousId: body.analogousId, conceptId: newConceptId }
          : {}),
        ...(body.typeId !== undefined ? { typeId: body.typeId } : {}),
        ...(body.brand !== undefined ? { brand: body.brand } : {}),
        ...(body.supplier !== undefined ? { supplier: body.supplier } : {}),
        ...(body.catalogRef !== undefined ? { catalogRef: body.catalogRef } : {}),
        ...(body.format !== undefined ? { format: body.format } : {}),
        ...(body.packSize !== undefined ? { packSize: body.packSize } : {}),
        ...(body.packUnit !== undefined ? { packUnit: body.packUnit } : {}),
        ...(body.purity !== undefined ? { purity: body.purity } : {}),
        ...(body.concentration !== undefined ? { concentration: body.concentration } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
      })
      .where(eq(variants.id, id))
      .run();

    const beforeRecord = before as unknown as Record<string, unknown>;
    for (const [field, after] of Object.entries(body)) {
      if (after === undefined) continue;
      const prev = beforeRecord[field] ?? null;
      if (JSON.stringify(prev) === JSON.stringify(after)) continue;
      logEvent({
        entityType: 'variant',
        entityId: id,
        entityHumanId: before.humanId,
        action: 'updated',
        fieldChanged: field,
        valueBefore: prev,
        valueAfter: after,
        userId: user.id,
      });
    }
    return db.select().from(variants).where(eq(variants.id, id)).get()!;
  });
  return c.json(serializeAudit(updated), 200);
});

// ------------------------------------------------------ DELETE /variants/:id
const deleteRoute = createRoute({
  method: 'delete',
  path: '/variants/{id}',
  tags: ['variants'],
  middleware: [requireRole('manager')] as const,
  request: {
    params: idParam,
    query: z.object({ cascade: z.enum(['true', 'false']).optional() }),
  },
  responses: {
    200: { description: 'Soft-deleted variant', ...jsonContent(variantSchema) },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires manager role'),
    404: errorResponse('Not found'),
    409: errorResponse('Items still reference this variant'),
  },
});

variantsRouter.openapi(deleteRoute, (c) => {
  const { id } = c.req.valid('param');
  const cascade = c.req.valid('query').cascade === 'true';
  const user = c.get('user');

  const deleted = db.transaction(() => {
    const row = getActive(id);
    const linked =
      db
        .select({ n: count() })
        .from(items)
        .where(and(eq(items.variantId, id), isNull(items.deletedAt)))
        .get()?.n ?? 0;
    if (linked > 0 && !cascade) {
      throw new ApiError(
        409,
        'variant_in_use',
        `Cannot delete: ${linked} item(s) still reference this variant`,
        { itemCount: linked, cascade: previewVariantCascade(id) },
      );
    }
    if (cascade) cascadeFromVariant(id, user.id);
    db.update(variants).set({ deletedAt: new Date() }).where(eq(variants.id, id)).run();
    logEvent({
      entityType: 'variant',
      entityId: id,
      entityHumanId: row.humanId,
      action: 'soft_deleted',
      userId: user.id,
    });
    return db.select().from(variants).where(eq(variants.id, id)).get()!;
  });
  return c.json(serializeAudit(deleted), 200);
});
