import { createRoute, z } from '@hono/zod-openapi';
import { and, count, desc, eq, gte, like, lte, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import {
  errorResponseSchema,
  historyEntrySchema,
  historyQuerySchema,
  listResponseSchema,
  paginationQuerySchema,
  translatedTextSchema,
} from '@inventory/shared';
import type { AuditEntity, TranslatedText } from '@inventory/shared';
import { createRouter } from '../lib/router';
import { db } from '../db/client';
import { user } from '../db/auth-schema';
import {
  actions,
  analogous,
  concepts,
  history,
  items,
  locations,
  logEventDefs,
  lots,
  maintenancePlans,
  pools,
  requests,
  suppliers,
  types,
  variants,
} from '../db/schema';
import { requireRole } from '../middleware/auth';
import type { AuthEnv } from '../middleware/auth';

export const historyRouter = createRouter<AuthEnv>();

/**
 * "ACT001" tells you nothing. The name does. History rows keep the human id
 * denormalised because it must survive deletion, but the name is looked
 * up now so a row reads as a sentence rather than as a foreign key.
 */
const NAMED: Partial<
  Record<AuditEntity, { find: (id: string) => Record<string, unknown> | undefined }>
> = {
  concept: { find: (id) => db.select().from(concepts).where(eq(concepts.id, id)).get() },
  analogous: { find: (id) => db.select().from(analogous).where(eq(analogous.id, id)).get() },
  variant: { find: (id) => db.select().from(variants).where(eq(variants.id, id)).get() },
  item: { find: (id) => db.select().from(items).where(eq(items.id, id)).get() },
  location: { find: (id) => db.select().from(locations).where(eq(locations.id, id)).get() },
  type: { find: (id) => db.select().from(types).where(eq(types.id, id)).get() },
  action: { find: (id) => db.select().from(actions).where(eq(actions.id, id)).get() },
  pool: { find: (id) => db.select().from(pools).where(eq(pools.id, id)).get() },
  logEvent: { find: (id) => db.select().from(logEventDefs).where(eq(logEventDefs.id, id)).get() },
  maintenance: {
    find: (id) => db.select().from(maintenancePlans).where(eq(maintenancePlans.id, id)).get(),
  },
};

function displayName(entityType: AuditEntity, entityId: string): TranslatedText | null {
  // Entities whose "name" is a plain string, not a translated one.
  if (entityType === 'supplier') {
    const row = db.select().from(suppliers).where(eq(suppliers.id, entityId)).get();
    return row ? { en: row.name } : null;
  }
  if (entityType === 'lot') {
    const row = db
      .select({ name: suppliers.name })
      .from(lots)
      .leftJoin(suppliers, eq(lots.supplierId, suppliers.id))
      .where(eq(lots.id, entityId))
      .get();
    return row?.name ? { en: row.name } : null;
  }
  if (entityType === 'request') {
    const row = db
      .select({ name: concepts.name })
      .from(requests)
      .leftJoin(concepts, eq(requests.conceptId, concepts.id))
      .where(eq(requests.id, entityId))
      .get();
    return (row?.name as TranslatedText | undefined) ?? null;
  }

  const found = NAMED[entityType]?.find(entityId);
  if (!found) return null;
  // Items carry a plain optional label; locations are known by their code.
  if (typeof found.name === 'string' && found.name) return { en: found.name };
  // An unlabelled item is still called something — what people say out loud is
  // its Variant ("Precisio XPR205"), so a row about a caliper says so.
  if (entityType === 'item') {
    const row = db
      .select({ name: variants.name })
      .from(items)
      .leftJoin(variants, eq(items.variantId, variants.id))
      .where(eq(items.id, entityId))
      .get();
    return (row?.name as TranslatedText | undefined) ?? null;
  }
  if (typeof found.name === 'string') return null;
  if (found.name) return found.name as TranslatedText;
  if (typeof found.code === 'string') return { en: found.code };
  return null;
}

const listRoute = createRoute({
  method: 'get',
  path: '/history',
  tags: ['history'],
  middleware: [requireRole('viewer')] as const,
  request: {
    query: paginationQuerySchema
      .extend(historyQuerySchema.shape)
      .extend({ q: z.string().optional() }), // free text over the humanId
  },
  responses: {
    200: {
      description: 'Audit trail, newest first',
      content: {
        'application/json': {
          schema: listResponseSchema(
            historyEntrySchema.extend({
              userName: z.string().nullable(),
              entityName: translatedTextSchema.nullable(),
            }),
          ),
        },
      },
    },
    401: {
      description: 'Not signed in',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

historyRouter.openapi(listRoute, (c) => {
  const q = c.req.valid('query');

  const conditions: SQL[] = [];
  if (q.entityType) conditions.push(eq(history.entityType, q.entityType));
  if (q.entityId) conditions.push(eq(history.entityId, q.entityId));
  if (q.action) conditions.push(eq(history.action, q.action));
  if (q.userId) conditions.push(eq(history.userId, q.userId));
  if (q.from) conditions.push(gte(history.createdAt, new Date(q.from)));
  if (q.to) conditions.push(lte(history.createdAt, new Date(q.to)));
  if (q.q)
    conditions.push(
      like(sql`lower(coalesce(${history.entityHumanId}, ''))`, `%${q.q.toLowerCase()}%`),
    );
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const total = db.select({ n: count() }).from(history).where(where).get()?.n ?? 0;
  const rows = db
    .select({ row: history, userName: user.name })
    .from(history)
    .leftJoin(user, eq(history.userId, user.id))
    .where(where)
    .orderBy(desc(history.createdAt))
    .limit(q.perPage)
    .offset((q.page - 1) * q.perPage)
    .all();

  return c.json(
    {
      data: rows.map(({ row, userName }) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
        userName,
        entityName: displayName(row.entityType, row.entityId),
      })),
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
