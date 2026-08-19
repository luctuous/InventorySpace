import { createRoute, z } from '@hono/zod-openapi';
import { and, count, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { TRASH_ENTITIES, trashRowSchema } from '@inventory/shared';
import type { TranslatedText, TrashEntity } from '@inventory/shared';
import { createRouter } from '../lib/router';
import { db } from '../db/client';
import {
  actionLines,
  actionRecords,
  actions,
  analogous,
  concepts,
  items,
  locations,
  lotLines,
  lots,
  poolUnits,
  pools,
  requests,
  suppliers,
  types,
  variants,
} from '../db/schema';
import { jsonContent, errorResponse } from '../lib/openapi';
import { requireRole } from '../middleware/auth';
import type { AuthEnv } from '../middleware/auth';
import { ApiError, notFoundError } from '../middleware/error';
import { logEvent } from '../services/history';

// The bin: deleting is always soft, so everything that was
// ever deleted can be listed and put back — or, from here and nowhere else,
// destroyed for good. Managers and admins only: they are the roles that could
// delete it in the first place.

export const trashRouter = createRouter<AuthEnv>();

/**
 * A row can only come back if its parent is still alive — otherwise you would
 * restore a variant into an analogous group that no longer exists. We report
 * that up front instead of failing on the restore click.
 */
function parentBlocker(entityType: TrashEntity, row: Record<string, unknown>): string | null {
  const aliveParent = (
    table: typeof concepts | typeof analogous | typeof variants | typeof types | typeof locations,
    id: string | null,
    label: string,
  ) => {
    if (!id) return null;
    const parent = db.select().from(table).where(eq(table.id, id)).get() as
      | { deletedAt: Date | null }
      | undefined;
    return parent && parent.deletedAt === null ? null : label;
  };

  switch (entityType) {
    case 'analogous':
      return aliveParent(concepts, row.conceptId as string, 'concept');
    case 'variant':
      return (
        aliveParent(analogous, row.analogousId as string, 'analogous') ??
        aliveParent(types, row.typeId as string, 'type')
      );
    case 'item':
      return (
        aliveParent(types, row.typeId as string, 'type') ??
        aliveParent(variants, row.variantId as string | null, 'variant') ??
        aliveParent(locations, row.locationId as string | null, 'location')
      );
    case 'location':
      return aliveParent(locations, row.parentId as string | null, 'parent location');
    default:
      return null;
  }
}

const SOURCES = {
  concept: { table: concepts, humanId: (r: any) => r.humanId, label: (r: any) => r.name },
  analogous: { table: analogous, humanId: (r: any) => r.humanId, label: (r: any) => r.name },
  variant: { table: variants, humanId: (r: any) => r.humanId, label: (r: any) => r.name },
  item: { table: items, humanId: (r: any) => r.humanId, label: () => null },
  location: { table: locations, humanId: (r: any) => r.code, label: (r: any) => r.name },
  type: { table: types, humanId: (r: any) => r.key, label: (r: any) => r.name },
  //. Requests and lots have no name of their own, so they borrow the
  // one thing that identifies them: what was asked for, and who from.
  request: {
    table: requests,
    humanId: (r: any) => r.humanId,
    label: (r: any) =>
      db.select().from(concepts).where(eq(concepts.id, r.conceptId)).get()?.name ?? null,
  },
  lot: {
    table: lots,
    humanId: (r: any) => r.humanId,
    label: (r: any) => {
      if (!r.supplierId) return null;
      const found = db.select().from(suppliers).where(eq(suppliers.id, r.supplierId)).get();
      return found ? { en: found.name } : null;
    },
  },
  supplier: { table: suppliers, humanId: (r: any) => r.humanId, label: (r: any) => ({ en: r.name }) },
  action: { table: actions, humanId: (r: any) => r.humanId, label: (r: any) => r.name },
  pool: { table: pools, humanId: (r: any) => r.humanId, label: (r: any) => r.name },
} as const;

// --------------------------------------------------------------- GET /trash
const listRoute = createRoute({
  method: 'get',
  path: '/trash',
  tags: ['trash'],
  middleware: [requireRole('manager')] as const,
  responses: {
    200: {
      description: 'Everything that has been soft-deleted, newest first',
      ...jsonContent(z.array(trashRowSchema)),
    },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires manager role'),
  },
});

trashRouter.openapi(listRoute, (c) => {
  const rows: Array<z.infer<typeof trashRowSchema>> = [];

  for (const entityType of TRASH_ENTITIES) {
    const source = SOURCES[entityType];
    const deleted = db
      .select()
      .from(source.table)
      .where(isNotNull(source.table.deletedAt))
      .orderBy(desc(source.table.deletedAt))
      .all() as Array<Record<string, unknown>>;

    for (const row of deleted) {
      rows.push({
        entityType,
        id: row.id as string,
        humanId: source.humanId(row),
        label: (source.label(row) ?? null) as TranslatedText | null,
        deletedAt: (row.deletedAt as Date).toISOString(),
        blockedBy: parentBlocker(entityType, row),
      });
    }
  }

  rows.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  return c.json(rows, 200);
});

// ------------------------------------------- POST /trash/:entityType/:id/restore
const restoreRoute = createRoute({
  method: 'post',
  path: '/trash/{entityType}/{id}/restore',
  tags: ['trash'],
  middleware: [requireRole('manager')] as const,
  request: {
    params: z.object({
      entityType: z.enum(TRASH_ENTITIES),
      id: z.string().min(1),
    }),
  },
  responses: {
    200: {
      description: 'Restored',
      ...jsonContent(z.object({ ok: z.boolean(), humanId: z.string() })),
    },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires manager role'),
    404: errorResponse('Not found in the bin'),
    409: errorResponse('Its parent is still deleted'),
  },
});

trashRouter.openapi(restoreRoute, (c) => {
  const { entityType, id } = c.req.valid('param');
  const user = c.get('user');
  const source = SOURCES[entityType];

  const restored = db.transaction(() => {
    const row = db
      .select()
      .from(source.table)
      .where(and(eq(source.table.id, id), isNotNull(source.table.deletedAt)))
      .get() as Record<string, unknown> | undefined;
    if (!row) throw notFoundError(`deleted ${entityType}`, id);

    const blocker = parentBlocker(entityType, row);
    if (blocker) {
      throw new ApiError(
        409,
        'parent_deleted',
        `Restore its ${blocker} first — this ${entityType} has nowhere to attach to`,
        { blockedBy: blocker },
      );
    }

    db.update(source.table).set({ deletedAt: null }).where(eq(source.table.id, id)).run();
    const humanId = source.humanId(row);
    logEvent({
      entityType,
      entityId: id,
      entityHumanId: humanId,
      action: 'restored',
      userId: user.id,
    });
    return humanId as string;
  });

  return c.json({ ok: true, humanId: restored }, 200);
});

// ------------------------------------------- DELETE /trash/:entityType/:id
/**
 * Permanent deletion. Soft delete is the default everywhere and stays
 * that way — but a bin you can only put things into is not a bin, and test
 * rows and typos would sit in it for ever.
 *
 * Two things make this safe rather than reckless:
 *   · the history row survives. It keeps the human id and what happened, so
 *     the trail is never broken by a purge — only the row itself goes.
 *   · anything still referenced refuses to go, with the reason.
 */
const purgeRoute = createRoute({
  method: 'delete',
  path: '/trash/{entityType}/{id}',
  tags: ['trash'],
  middleware: [requireRole('manager')] as const,
  request: {
    params: z.object({ entityType: z.enum(TRASH_ENTITIES), id: z.string().min(1) }),
  },
  responses: {
    200: { description: 'Gone for good', ...jsonContent(z.object({ ok: z.boolean(), humanId: z.string() })) },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires manager role'),
    404: errorResponse('Not found in the bin'),
    409: errorResponse('Something still points at it'),
  },
});

/** What would break if this row disappeared. Empty means it is safe to go. */
function referencesTo(entityType: TrashEntity, id: string): string | null {
  const has = (table: any, column: any, label: string) => {
    const n = db.select({ n: count() }).from(table).where(eq(column, id)).get()?.n ?? 0;
    return n > 0 ? `${n} ${label}` : null;
  };

  switch (entityType) {
    case 'concept':
      return (
        has(analogous, analogous.conceptId, 'analogous groups') ??
        has(items, items.conceptId, 'items') ??
        has(requests, requests.conceptId, 'requests') ??
        has(actionLines, actionLines.conceptId, 'activity lines')
      );
    case 'analogous':
      return has(variants, variants.analogousId, 'variants');
    case 'variant':
      return has(items, items.variantId, 'items') ?? has(lotLines, lotLines.orderedVariantId, 'lot lines');
    case 'location':
      return has(items, items.locationId, 'items') ?? has(locations, locations.parentId, 'child locations');
    case 'type':
      return has(items, items.typeId, 'items') ?? has(variants, variants.typeId, 'variants');
    case 'lot':
      return has(lotLines, lotLines.lotId, 'lot lines');
    case 'supplier':
      return has(lots, lots.supplierId, 'lots');
    case 'action':
      return has(actionRecords, actionRecords.actionId, 'recorded activities');
    case 'pool':
      return has(poolUnits, poolUnits.poolId, 'pool units');
    default:
      return null;
  }
}

trashRouter.openapi(purgeRoute, (c) => {
  const { entityType, id } = c.req.valid('param');
  const user = c.get('user');
  const source = SOURCES[entityType];

  const humanId = db.transaction(() => {
    const row = db
      .select()
      .from(source.table)
      .where(and(eq(source.table.id, id), isNotNull(source.table.deletedAt)))
      .get() as Record<string, unknown> | undefined;
    // Only what is already in the bin can be purged: there is no way to skip
    // the soft delete and go straight to gone.
    if (!row) throw notFoundError(`deleted ${entityType}`, id);

    const blocker = referencesTo(entityType, id);
    if (blocker) {
      throw new ApiError(
        409,
        'still_referenced',
        `${blocker} still point at this ${entityType}. Delete those first.`,
        { blockedBy: blocker },
      );
    }

    const label = source.humanId(row) as string;
    // The trail is written BEFORE the row goes, so the purge itself is on
    // record even though the thing it happened to no longer exists.
    logEvent({
      entityType: entityType as never,
      entityId: id,
      entityHumanId: label,
      action: 'purged',
      userId: user.id,
    });
    db.delete(source.table).where(eq(source.table.id, id)).run();
    return label;
  });

  return c.json({ ok: true, humanId }, 200);
});

// --------------------------------------------------------- GET /trash/count
const countRoute = createRoute({
  method: 'get',
  path: '/trash/count',
  tags: ['trash'],
  middleware: [requireRole('manager')] as const,
  responses: {
    200: { description: 'How many rows are in the bin', ...jsonContent(z.object({ total: z.number() })) },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires manager role'),
  },
});

trashRouter.openapi(countRoute, (c) => {
  let total = 0;
  for (const entityType of TRASH_ENTITIES) {
    const table = SOURCES[entityType].table;
    total += db.select({ n: count() }).from(table).where(isNotNull(table.deletedAt)).get()?.n ?? 0;
  }
  return c.json({ total }, 200);
});

// Re-exported for the cascade delete helper in the entity routers.
export const aliveFilter = <T extends { deletedAt: unknown }>(table: T) =>
  isNull(table.deletedAt as never);
