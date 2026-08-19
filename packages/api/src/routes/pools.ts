import { createRoute, z } from '@hono/zod-openapi';
import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  errorResponseSchema,
  occupancyCreateSchema,
  occupancySchema,
  poolCommissionResultSchema,
  poolCommissionSchema,
  poolCreateSchema,
  poolEventCreateSchema,
  poolEventSchema,
  poolSchema,
  poolStockSchema,
  poolUnitCreateSchema,
  poolUnitSchema,
  poolUnitStateSchema,
  poolUpdateSchema,
  poolWithStatsSchema,
  recountCreateSchema,
  recountSchema,
} from '@inventory/shared';
import type { PoolEventKind } from '@inventory/shared';
import { createRouter } from '../lib/router';
import { db } from '../db/client';
import {
  concepts,
  items,
  locations,
  occupancies,
  poolEvents,
  poolRecounts,
  poolUnits,
  pools,
} from '../db/schema';
import { user as userTable } from '../db/auth-schema';
import { serializeAudit, toIso } from '../lib/serialize';
import { requireRole } from '../middleware/auth';
import type { AuthEnv } from '../middleware/auth';
import { ApiError, conflictError, notFoundError } from '../middleware/error';
import { logEvent } from '../services/history';
import { generateHumanId } from '../services/ids';

// Reusable pools. Neither consumables nor assets: lent out
// and returned, with attrition as the only true consumption.
//
// Deliberately NOT individual Items — modelling each mixing cup as an Item of
// quantity 1 implies an identity nobody maintains and demands per-jar
// bookkeeping nobody will ever do.

export const poolsRouter = createRouter<AuthEnv>();

const jsonContent = <T extends z.ZodType>(schema: T) => ({
  content: { 'application/json': { schema } },
});
const errorResponse = (description: string) => ({
  description,
  ...jsonContent(errorResponseSchema),
});
const idParam = z.object({ id: z.uuid() });

const DAY_MS = 24 * 60 * 60 * 1000;

function getPool(id: string) {
  const row = db
    .select()
    .from(pools)
    .where(and(eq(pools.id, id), isNull(pools.deletedAt)))
    .get();
  if (!row) throw notFoundError('pool', id);
  return row;
}

type PoolRow = typeof pools.$inferSelect;

function unitCounts(poolId: string) {
  const rows = db
    .select({ state: poolUnits.state, n: count() })
    .from(poolUnits)
    .where(and(eq(poolUnits.poolId, poolId), isNull(poolUnits.deletedAt)))
    .groupBy(poolUnits.state)
    .all();
  const map = Object.fromEntries(rows.map((r) => [r.state, r.n]));
  return {
    available: map.available ?? 0,
    inUse: map.in_use ?? 0,
    dirty: map.dirty ?? 0,
    retired: map.retired ?? 0,
  };
}

/**
 * Units lost per 30 days, derived from recounts. This is the only number a
 * pool contributes to purchasing — you buy jars at the rate you break them,
 * and nobody ever has to report a breakage.
 */
function attritionPerMonth(poolId: string): { rate: number | null; lastAt: Date | null } {
  const rows = db
    .select()
    .from(poolRecounts)
    .where(eq(poolRecounts.poolId, poolId))
    .orderBy(poolRecounts.createdAt)
    .all();
  if (rows.length === 0) return { rate: null, lastAt: null };

  const last = rows[rows.length - 1]!;
  if (rows.length < 2) return { rate: null, lastAt: last.createdAt };

  const first = rows[0]!;
  const days = (last.createdAt.getTime() - first.createdAt.getTime()) / DAY_MS;
  if (days <= 0) return { rate: null, lastAt: last.createdAt };

  // The first recount only establishes the baseline; the losses are what the
  // later ones found.
  const lost = rows.slice(1).reduce((sum, row) => sum + Math.max(0, row.attrition), 0);
  return { rate: Math.round((lost / days) * 30 * 10) / 10, lastAt: last.createdAt };
}

function serializePool(pool: PoolRow) {
  const identified = pool.granularity === 'identified';
  const counts = identified ? unitCounts(pool.id) : null;

  const available = counts ? counts.available : pool.available;
  const inUse = counts ? counts.inUse : pool.inUse;
  const dirty = counts ? counts.dirty : pool.dirty;

  const unitCount = identified
    ? (db
        .select({ n: count() })
        .from(poolUnits)
        .where(and(eq(poolUnits.poolId, pool.id), isNull(poolUnits.deletedAt)))
        .get()?.n ?? 0)
    : 0;

  const openOccupancies =
    db
      .select({ n: count() })
      .from(occupancies)
      .innerJoin(poolUnits, eq(occupancies.unitId, poolUnits.id))
      .where(and(eq(poolUnits.poolId, pool.id), isNull(occupancies.closedAt)))
      .get()?.n ?? 0;

  const attrition = attritionPerMonth(pool.id);

  return {
    ...serializeAudit(pool),
    available,
    inUse,
    dirty,
    total: available + inUse + dirty,
    unitCount,
    openOccupancies,
    attritionPerMonth: attrition.rate,
    lastRecountAt: toIso(attrition.lastAt),
  };
}

// ------------------------------------------------------------------ GET /pools
const listRoute = createRoute({
  method: 'get',
  path: '/pools',
  tags: ['pools'],
  middleware: [requireRole('viewer')] as const,
  responses: {
    200: { description: 'Reusable pools with their state counts', ...jsonContent(z.array(poolWithStatsSchema)) },
    401: errorResponse('Not signed in'),
  },
});

poolsRouter.openapi(listRoute, (c) => {
  const rows = db
    .select()
    .from(pools)
    .where(isNull(pools.deletedAt))
    .orderBy(pools.humanId)
    .all();
  return c.json(rows.map(serializePool), 200);
});

// ----------------------------------------------------------------- POST /pools
const createRoute_ = createRoute({
  method: 'post',
  path: '/pools',
  tags: ['pools'],
  middleware: [requireRole('manager')] as const,
  request: { body: { content: { 'application/json': { schema: poolCreateSchema } } } },
  responses: {
    201: { description: 'Created pool', ...jsonContent(poolSchema) },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires manager role'),
  },
});

poolsRouter.openapi(createRoute_, (c) => {
  const body = c.req.valid('json');
  const user = c.get('user');

  const row = db.transaction(() => {
    const id = crypto.randomUUID();
    const humanId = generateHumanId('POO', 'simple');
    db.insert(pools)
      .values({
        id,
        humanId,
        name: body.name,
        granularity: body.granularity,
        conceptId: body.conceptId ?? null,
        addressable: body.addressable,
        slotsPerUnit: body.slotsPerUnit ?? null,
        available: body.granularity === 'pooled' ? body.initialUnits : 0,
        notes: body.notes ?? null,
      })
      .run();
    if (body.granularity === 'pooled' && body.initialUnits > 0) {
      db.insert(poolEvents)
        .values({
          id: crypto.randomUUID(),
          poolId: id,
          kind: 'add',
          quantity: body.initialUnits,
          note: 'initial count',
          userId: user.id,
        })
        .run();
    }
    logEvent({
      entityType: 'pool', entityId: id, entityHumanId: humanId,
      action: 'created', valueAfter: { granularity: body.granularity }, userId: user.id,
    });
    return db.select().from(pools).where(eq(pools.id, id)).get()!;
  });

  return c.json(serializeAudit(row), 201);
});

// ------------------------------------------------------------- GET /pools/:id
const detailRoute = createRoute({
  method: 'get',
  path: '/pools/{id}',
  tags: ['pools'],
  middleware: [requireRole('viewer')] as const,
  request: { params: idParam },
  responses: {
    200: { description: 'Pool with stats', ...jsonContent(poolWithStatsSchema) },
    401: errorResponse('Not signed in'),
    404: errorResponse('Not found'),
  },
});

poolsRouter.openapi(detailRoute, (c) =>
  c.json(serializePool(getPool(c.req.valid('param').id)), 200),
);

// ----------------------------------------------------------- PATCH /pools/:id
const updateRoute = createRoute({
  method: 'patch',
  path: '/pools/{id}',
  tags: ['pools'],
  middleware: [requireRole('manager')] as const,
  request: {
    params: idParam,
    body: { content: { 'application/json': { schema: poolUpdateSchema } } },
  },
  responses: {
    200: { description: 'Updated pool', ...jsonContent(poolSchema) },
    401: errorResponse('Not signed in'),
    404: errorResponse('Not found'),
  },
});

poolsRouter.openapi(updateRoute, (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const user = c.get('user');

  const row = db.transaction(() => {
    const before = getPool(id);
    db.update(pools)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.conceptId !== undefined ? { conceptId: body.conceptId } : {}),
        ...(body.addressable !== undefined ? { addressable: body.addressable } : {}),
        ...(body.slotsPerUnit !== undefined ? { slotsPerUnit: body.slotsPerUnit } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
      })
      .where(eq(pools.id, id))
      .run();
    logEvent({
      entityType: 'pool', entityId: id, entityHumanId: before.humanId,
      action: 'updated', valueAfter: body, userId: user.id,
    });
    return db.select().from(pools).where(eq(pools.id, id)).get()!;
  });

  return c.json(serializeAudit(row), 200);
});

// ---------------------------------------------------------- DELETE /pools/:id
const deleteRoute = createRoute({
  method: 'delete',
  path: '/pools/{id}',
  tags: ['pools'],
  middleware: [requireRole('manager')] as const,
  request: { params: idParam },
  responses: {
    200: { description: 'Soft-deleted pool', ...jsonContent(poolSchema) },
    401: errorResponse('Not signed in'),
    404: errorResponse('Not found'),
    409: errorResponse('Units still in use'),
  },
});

poolsRouter.openapi(deleteRoute, (c) => {
  const { id } = c.req.valid('param');
  const user = c.get('user');

  const row = db.transaction(() => {
    const before = getPool(id);
    const open =
      db
        .select({ n: count() })
        .from(occupancies)
        .innerJoin(poolUnits, eq(occupancies.unitId, poolUnits.id))
        .where(and(eq(poolUnits.poolId, id), isNull(occupancies.closedAt)))
        .get()?.n ?? 0;
    if (open > 0) {
      throw new ApiError(
        409,
        'pool_in_use',
        `${open} slot(s) still hold something — empty them first`,
      );
    }
    db.update(pools).set({ deletedAt: new Date() }).where(eq(pools.id, id)).run();
    logEvent({
      entityType: 'pool', entityId: id, entityHumanId: before.humanId,
      action: 'soft_deleted', userId: user.id,
    });
    return db.select().from(pools).where(eq(pools.id, id)).get()!;
  });

  return c.json(serializeAudit(row), 200);
});

// ------------------------------------------------------ POST /pools/:id/events
// take → return → wash → available. The whole lifecycle of a lent-out thing.
const STATE_MOVES: Record<PoolEventKind, { from: keyof PoolRow | null; to: keyof PoolRow | null }> = {
  take: { from: 'available', to: 'inUse' },
  return: { from: 'inUse', to: 'dirty' },
  wash: { from: 'dirty', to: 'available' },
  retire: { from: 'available', to: null },
  add: { from: null, to: 'available' },
  recount: { from: null, to: null },
};

/** The kinds that move one unit from one state to another. */
const MOVES_A_UNIT = new Set<PoolEventKind>(['take', 'return', 'wash', 'retire']);

export function applyPoolEvent(
  poolId: string,
  kind: PoolEventKind,
  quantity: number,
  options: {
    unitId?: string | null;
    note?: string | null;
    userId?: string | null;
    source?: string;
    /**
     * Refuse rather than move less than asked. A person gets told their number
     * is wrong; the log never does, because a wrong line must not stop
     * ingestion — it clamps, and the recount corrects the belief later.
     */
    strict?: boolean;
  } = {},
): { requested: number; moved: number } {
  const pool = getPool(poolId);
  let moved = quantity;

  if (pool.granularity === 'identified') {
    if (options.unitId) {
      const unit = db.select().from(poolUnits).where(eq(poolUnits.id, options.unitId)).get();
      if (!unit) throw notFoundError('pool unit', options.unitId);
      const nextState =
        kind === 'take' ? 'in_use' : kind === 'return' ? 'dirty' : kind === 'wash' ? 'available' : kind === 'retire' ? 'retired' : unit.state;
      db.update(poolUnits).set({ state: nextState }).where(eq(poolUnits.id, unit.id)).run();
    } else if (MOVES_A_UNIT.has(kind)) {
      // An identified pool IS its units: which tray, not how many. The
      // aggregate columns are derived from the units on the way out, so
      // writing them here would corrupt the row while the screen kept showing
      // the right numbers — wrong in the one place nobody would look.
      throw new ApiError(
        400,
        'unit_required',
        `${pool.humanId} tracks individual units — say which one`,
      );
    }
    // add/recount are pool-level: the units already carry the truth.
  } else {
    const move = STATE_MOVES[kind];
    const patch: Record<string, number> = {};

    // BOTH ends move by the same amount. Clamping only the source — so a
    // counter never goes negative — while crediting the destination in full
    // invents units out of nothing, and the pool's total is precisely what the
    // recount measures attrition against.
    if (move.from) {
      const current = pool[move.from] as number;
      moved = Math.min(quantity, current);
      if (options.strict && moved < quantity) {
        throw conflictError(
          'not_enough_units',
          `${pool.humanId} has ${current} ${String(move.from)}, ${quantity} asked for`,
        );
      }
      patch[move.from as string] = current - moved;
    }
    if (move.to) {
      patch[move.to as string] = (pool[move.to] as number) + moved;
    }
    if (Object.keys(patch).length > 0) {
      db.update(pools).set(patch).where(eq(pools.id, poolId)).run();
    }
  }

  db.insert(poolEvents)
    .values({
      id: crypto.randomUUID(),
      poolId,
      unitId: options.unitId ?? null,
      kind,
      // What actually happened, not what was asked for — otherwise the pool's
      // own feed disagrees with its counters.
      quantity: moved,
      note: options.note ?? null,
      userId: options.userId ?? null,
      source: options.source ?? 'manual',
    })
    .run();

  // Take/return/wash circulate inside the pool and belong to the pool's own
  // feed — in a working workshop there are hundreds a day and they would drown the
  // inventory in the global history. Retiring and adding change how much the
  // workshop owns, so those two do belong there.
  if (kind === 'retire' || kind === 'add') {
    logEvent({
      entityType: 'pool',
      entityId: poolId,
      entityHumanId: pool.humanId,
      action: kind === 'retire' ? 'retired' : 'commissioned',
      fieldChanged: 'units',
      valueAfter: { kind, quantity: moved, unitId: options.unitId ?? null },
      notes: options.note ?? null,
      userId: options.userId ?? null,
    });
  }

  return { requested: quantity, moved };
}

const eventRoute = createRoute({
  method: 'post',
  path: '/pools/{id}/events',
  tags: ['pools'],
  middleware: [requireRole('operator')] as const,
  request: {
    params: idParam,
    body: { content: { 'application/json': { schema: poolEventCreateSchema } } },
  },
  responses: {
    200: { description: 'Pool after the event', ...jsonContent(poolWithStatsSchema) },
    400: errorResponse('An identified pool needs to know which unit'),
    401: errorResponse('Not signed in'),
    404: errorResponse('Not found'),
    409: errorResponse('The pool does not hold that many'),
  },
});

poolsRouter.openapi(eventRoute, (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const user = c.get('user');

  const pool = db.transaction(() => {
    applyPoolEvent(id, body.kind, body.quantity, {
      unitId: body.unitId,
      note: body.note,
      userId: user.id,
      // A person asking for more than the pool holds has made a mistake worth
      // hearing about, rather than one to swallow silently.
      strict: true,
    });
    return getPool(id);
  });

  return c.json(serializePool(pool), 200);
});

// ----------------------------------------------------- GET /pools/:id/events
const eventListRoute = createRoute({
  method: 'get',
  path: '/pools/{id}/events',
  tags: ['pools'],
  middleware: [requireRole('viewer')] as const,
  request: { params: idParam },
  responses: {
    200: { description: 'Recent pool events', ...jsonContent(z.array(poolEventSchema)) },
    401: errorResponse('Not signed in'),
  },
});

poolsRouter.openapi(eventListRoute, (c) => {
  const { id } = c.req.valid('param');
  getPool(id);
  const rows = db
    .select()
    .from(poolEvents)
    .where(eq(poolEvents.poolId, id))
    .orderBy(desc(poolEvents.createdAt))
    .limit(100)
    .all();

  return c.json(
    rows.map((row) => {
      const unit = row.unitId
        ? db.select().from(poolUnits).where(eq(poolUnits.id, row.unitId)).get()
        : null;
      const who = row.userId
        ? db.select().from(userTable).where(eq(userTable.id, row.userId)).get()
        : null;
      return {
        id: row.id,
        poolId: row.poolId,
        unitId: row.unitId,
        unitCode: unit?.code ?? null,
        kind: row.kind,
        quantity: row.quantity,
        note: row.note,
        userId: row.userId,
        userName: who?.name ?? null,
        source: row.source,
        createdAt: row.createdAt.toISOString(),
      };
    }),
    200,
  );
});

// ---------------------------------------------------- POST /pools/:id/recount
const recountRoute = createRoute({
  method: 'post',
  path: '/pools/{id}/recount',
  tags: ['pools'],
  middleware: [requireRole('operator')] as const,
  request: {
    params: idParam,
    body: { content: { 'application/json': { schema: recountCreateSchema } } },
  },
  responses: {
    200: {
      description:
        'The measuring instrument. The difference between expected ' +
        'and counted IS the attrition — nobody ever reports a breakage.',
      ...jsonContent(recountSchema),
    },
    401: errorResponse('Not signed in'),
    404: errorResponse('Not found'),
  },
});

poolsRouter.openapi(recountRoute, (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const user = c.get('user');

  const row = db.transaction(() => {
    const pool = getPool(id);
    const expected =
      pool.granularity === 'identified' ? unitCounts(id).available : pool.available;
    const attrition = expected - body.counted;

    const recountId = crypto.randomUUID();
    db.insert(poolRecounts)
      .values({
        id: recountId,
        poolId: id,
        expected,
        counted: body.counted,
        attrition,
        note: body.note ?? null,
        userId: user.id,
      })
      .run();

    // The count is the truth; the running figure yields to it.
    if (pool.granularity === 'pooled') {
      db.update(pools).set({ available: body.counted }).where(eq(pools.id, id)).run();
    }
    db.insert(poolEvents)
      .values({
        id: crypto.randomUUID(),
        poolId: id,
        kind: 'recount',
        quantity: Math.abs(attrition),
        note: `expected ${expected}, counted ${body.counted}`,
        userId: user.id,
      })
      .run();

    logEvent({
      entityType: 'pool', entityId: id, entityHumanId: pool.humanId,
      action: 'recounted', fieldChanged: 'available',
      valueBefore: expected, valueAfter: body.counted,
      notes: attrition > 0 ? `${attrition} lost since the last count` : null,
      userId: user.id,
    });

    return db.select().from(poolRecounts).where(eq(poolRecounts.id, recountId)).get()!;
  });

  return c.json(
    {
      ...row,
      note: row.note,
      userName: null,
      createdAt: row.createdAt.toISOString(),
    },
    200,
  );
});

// ------------------------------------------------------ GET /pools/:id/units
const unitListRoute = createRoute({
  method: 'get',
  path: '/pools/{id}/units',
  tags: ['pools'],
  middleware: [requireRole('viewer')] as const,
  request: { params: idParam },
  responses: {
    200: { description: 'Identified members of this pool', ...jsonContent(z.array(poolUnitSchema)) },
    401: errorResponse('Not signed in'),
  },
});

poolsRouter.openapi(unitListRoute, (c) => {
  const { id } = c.req.valid('param');
  getPool(id);
  const rows = db
    .select()
    .from(poolUnits)
    .where(and(eq(poolUnits.poolId, id), isNull(poolUnits.deletedAt)))
    .orderBy(poolUnits.code)
    .all();

  return c.json(
    rows.map((unit) => {
      const location = unit.locationId
        ? db.select().from(locations).where(eq(locations.id, unit.locationId)).get()
        : null;
      const occupancyCount =
        db
          .select({ n: count() })
          .from(occupancies)
          .where(and(eq(occupancies.unitId, unit.id), isNull(occupancies.closedAt)))
          .get()?.n ?? 0;
      return {
        ...serializeAudit(unit),
        locationCode: location?.code ?? null,
        occupancyCount,
      };
    }),
    200,
  );
});

// ----------------------------------------------------- POST /pools/:id/units
const addUnitRoute = createRoute({
  method: 'post',
  path: '/pools/{id}/units',
  tags: ['pools'],
  middleware: [requireRole('manager')] as const,
  request: {
    params: idParam,
    body: { content: { 'application/json': { schema: poolUnitCreateSchema } } },
  },
  responses: {
    201: { description: 'Created unit', ...jsonContent(poolUnitSchema) },
    401: errorResponse('Not signed in'),
    404: errorResponse('Not found'),
    409: errorResponse('Pool is pooled, not identified'),
  },
});

poolsRouter.openapi(addUnitRoute, (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const user = c.get('user');

  const unit = db.transaction(() => {
    const pool = getPool(id);
    if (pool.granularity !== 'identified') {
      throw new ApiError(
        409,
        'pool_not_identified',
        'This pool is counted, not identified — its members have no individual identity',
      );
    }
    const unitId = crypto.randomUUID();
    db.insert(poolUnits)
      .values({
        id: unitId,
        poolId: id,
        code: body.code,
        state: 'available',
        locationId: body.locationId ?? null,
      })
      .run();
    logEvent({
      entityType: 'pool', entityId: id, entityHumanId: pool.humanId,
      action: 'updated', fieldChanged: 'units', valueAfter: body.code, userId: user.id,
    });
    return db.select().from(poolUnits).where(eq(poolUnits.id, unitId)).get()!;
  });

  return c.json({ ...serializeAudit(unit), locationCode: null, occupancyCount: 0 }, 201);
});

// --------------------------------------------- PATCH /pools/:id/units/:unitId
const unitStateRoute = createRoute({
  method: 'patch',
  path: '/pools/{id}/units/{unitId}',
  tags: ['pools'],
  middleware: [requireRole('operator')] as const,
  request: {
    params: z.object({ id: z.uuid(), unitId: z.uuid() }),
    body: { content: { 'application/json': { schema: poolUnitStateSchema } } },
  },
  responses: {
    200: { description: 'Updated unit', ...jsonContent(poolUnitSchema) },
    401: errorResponse('Not signed in'),
    404: errorResponse('Not found'),
  },
});

poolsRouter.openapi(unitStateRoute, (c) => {
  const { id, unitId } = c.req.valid('param');
  const body = c.req.valid('json');
  const user = c.get('user');

  const unit = db.transaction(() => {
    const pool = getPool(id);
    const before = db
      .select()
      .from(poolUnits)
      .where(and(eq(poolUnits.id, unitId), eq(poolUnits.poolId, id)))
      .get();
    if (!before) throw notFoundError('pool unit', unitId);

    db.update(poolUnits)
      .set({
        state: body.state,
        ...(body.locationId !== undefined ? { locationId: body.locationId } : {}),
      })
      .where(eq(poolUnits.id, unitId))
      .run();
    db.insert(poolEvents)
      .values({
        id: crypto.randomUUID(),
        poolId: id,
        unitId,
        kind: body.state === 'in_use' ? 'take' : body.state === 'dirty' ? 'return' : body.state === 'retired' ? 'retire' : 'wash',
        quantity: 1,
        userId: user.id,
      })
      .run();
    logEvent({
      entityType: 'pool', entityId: id, entityHumanId: pool.humanId,
      action: 'status_changed', fieldChanged: before.code,
      valueBefore: before.state, valueAfter: body.state, userId: user.id,
    });
    return db.select().from(poolUnits).where(eq(poolUnits.id, unitId)).get()!;
  });

  return c.json({ ...serializeAudit(unit), locationCode: null, occupancyCount: 0 }, 200);
});

// --------------------------------------------------------------- occupancies
// A kit has no location of its own: this row IS its whereabouts.

function serializeOccupancy(row: typeof occupancies.$inferSelect) {
  const unit = db.select().from(poolUnits).where(eq(poolUnits.id, row.unitId)).get()!;
  const pool = db.select().from(pools).where(eq(pools.id, unit.poolId)).get()!;
  const location = unit.locationId
    ? db.select().from(locations).where(eq(locations.id, unit.locationId)).get()
    : null;
  return {
    id: row.id,
    unitId: row.unitId,
    unitCode: unit.code,
    poolId: pool.id,
    poolName: pool.name,
    position: row.position,
    sampleTag: row.sampleTag,
    openedAt: row.openedAt.toISOString(),
    closedAt: toIso(row.closedAt),
    // Walked up the chain, never stored on the kit.
    locationCode: location?.code ?? null,
    unitState: unit.state,
  };
}

const occupancyListRoute = createRoute({
  method: 'get',
  path: '/occupancies',
  tags: ['pools'],
  middleware: [requireRole('viewer')] as const,
  request: {
    query: z.object({
      unitId: z.uuid().optional(),
      sampleTag: z.string().optional(),
      open: z.enum(['true', 'false']).optional(),
    }),
  },
  responses: {
    200: { description: 'Slot occupancies', ...jsonContent(z.array(occupancySchema)) },
    401: errorResponse('Not signed in'),
  },
});

poolsRouter.openapi(occupancyListRoute, (c) => {
  const { unitId, sampleTag, open } = c.req.valid('query');
  const rows = db
    .select()
    .from(occupancies)
    .where(
      and(
        unitId ? eq(occupancies.unitId, unitId) : undefined,
        sampleTag ? sql`lower(${occupancies.sampleTag}) like ${`%${sampleTag.toLowerCase()}%`}` : undefined,
        open === 'true' ? isNull(occupancies.closedAt) : undefined,
      ),
    )
    .orderBy(desc(occupancies.openedAt))
    .limit(200)
    .all();
  return c.json(rows.map(serializeOccupancy), 200);
});

const occupancyOpenRoute = createRoute({
  method: 'post',
  path: '/occupancies',
  tags: ['pools'],
  middleware: [requireRole('operator')] as const,
  request: { body: { content: { 'application/json': { schema: occupancyCreateSchema } } } },
  responses: {
    201: { description: 'Slot filled', ...jsonContent(occupancySchema) },
    401: errorResponse('Not signed in'),
    404: errorResponse('Unit not found'),
  },
});

poolsRouter.openapi(occupancyOpenRoute, (c) => {
  const body = c.req.valid('json');

  const row = db.transaction(() => {
    const unit = db.select().from(poolUnits).where(eq(poolUnits.id, body.unitId)).get();
    if (!unit) throw notFoundError('pool unit', body.unitId);
    const id = crypto.randomUUID();
    db.insert(occupancies)
      .values({
        id,
        unitId: body.unitId,
        position: body.position ?? null,
        sampleTag: body.sampleTag,
      })
      .run();
    // A tray holding something is a tray in use.
    if (unit.state === 'available') {
      db.update(poolUnits).set({ state: 'in_use' }).where(eq(poolUnits.id, unit.id)).run();
    }
    return db.select().from(occupancies).where(eq(occupancies.id, id)).get()!;
  });

  return c.json(serializeOccupancy(row), 201);
});

const occupancyCloseRoute = createRoute({
  method: 'post',
  path: '/occupancies/{id}/close',
  tags: ['pools'],
  middleware: [requireRole('operator')] as const,
  request: { params: idParam },
  responses: {
    200: { description: 'Slot emptied', ...jsonContent(occupancySchema) },
    401: errorResponse('Not signed in'),
    404: errorResponse('Not found'),
  },
});

poolsRouter.openapi(occupancyCloseRoute, (c) => {
  const { id } = c.req.valid('param');

  const row = db.transaction(() => {
    const before = db.select().from(occupancies).where(eq(occupancies.id, id)).get();
    if (!before) throw notFoundError('occupancy', id);
    if (before.closedAt) return before;

    db.update(occupancies).set({ closedAt: new Date() }).where(eq(occupancies.id, id)).run();

    // Emptied of its last kit, the tray goes back to being available.
    const stillOpen =
      db
        .select({ n: count() })
        .from(occupancies)
        .where(and(eq(occupancies.unitId, before.unitId), isNull(occupancies.closedAt)))
        .get()?.n ?? 0;
    if (stillOpen === 0) {
      db.update(poolUnits)
        .set({ state: 'available' })
        .where(and(eq(poolUnits.id, before.unitId), eq(poolUnits.state, 'in_use')))
        .run();
    }
    return db.select().from(occupancies).where(eq(occupancies.id, id)).get()!;
  });

  return c.json(serializeOccupancy(row), 200);
});

// ------------------------------------------------ GET /pools/:id/stock
/**
 * What is in the cupboard: unopened stock of the Concept this pool draws from.
 *
 * modelled the pool as a closed population, which left the boxes of
 * unused cups in the cupboard nowhere to live. They are ordinary stock —
 * bought, received and forecast like anything else — and commissioning is the
 * move between the two.
 */
const poolStockRoute = createRoute({
  method: 'get',
  path: '/pools/{id}/stock',
  tags: ['pools'],
  middleware: [requireRole('viewer')] as const,
  request: { params: idParam },
  responses: {
    200: { description: 'Unopened stock available to commission', ...jsonContent(poolStockSchema) },
    401: errorResponse('Not signed in'),
    404: errorResponse('Not found'),
  },
});

/** Unopened containers of the pool's concept, oldest first. */
function commissionSources(conceptId: string) {
  return db
    .select({
      itemId: items.id,
      humanId: items.humanId,
      quantity: items.quantityRemaining,
      quantityInitial: items.quantityInitial,
      locationCode: locations.code,
    })
    .from(items)
    .leftJoin(locations, eq(items.locationId, locations.id))
    .where(
      and(
        eq(items.conceptId, conceptId),
        eq(items.status, 'in_stock'),
        isNull(items.deletedAt),
      ),
    )
    .orderBy(items.receivedAt, items.humanId)
    .all()
    .map((row) => ({
      itemId: row.itemId,
      humanId: row.humanId,
      // A box that does not track a quantity still holds one commissionable lot.
      quantity: row.quantity ?? row.quantityInitial ?? 1,
      locationCode: row.locationCode,
    }))
    .filter((row) => row.quantity > 0);
}

poolsRouter.openapi(poolStockRoute, (c) => {
  const { id } = c.req.valid('param');
  const pool = getPool(id);

  if (!pool.conceptId) {
    return c.json(
      { conceptId: null, conceptName: null, unit: null, available: 0, sources: [] },
      200,
    );
  }

  const concept = db.select().from(concepts).where(eq(concepts.id, pool.conceptId)).get();
  const sources = commissionSources(pool.conceptId);
  return c.json(
    {
      conceptId: pool.conceptId,
      conceptName: concept?.name ?? null,
      unit: concept?.unit ?? null,
      available: Math.round(sources.reduce((sum, s) => sum + s.quantity, 0) * 1000) / 1000,
      sources,
    },
    200,
  );
});

// ----------------------------------------- POST /pools/:id/commission
const commissionRoute = createRoute({
  method: 'post',
  path: '/pools/{id}/commission',
  tags: ['pools'],
  middleware: [requireRole('operator')] as const,
  request: {
    params: idParam,
    body: { content: { 'application/json': { schema: poolCommissionSchema } } },
  },
  responses: {
    200: { description: 'Units put into rotation', ...jsonContent(poolCommissionResultSchema) },
    401: errorResponse('Not signed in'),
    404: errorResponse('Not found'),
    409: errorResponse('Not enough in stock, or the pool draws from no concept'),
  },
});

poolsRouter.openapi(commissionRoute, (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const user = c.get('user');

  const result = db.transaction(() => {
    const pool = getPool(id);
    if (!pool.conceptId) {
      throw new ApiError(
        409,
        'no_concept',
        'This pool is not linked to a concept, so there is no stock to take from',
      );
    }

    // Draw from one named container, or from the oldest ones in turn.
    const sources = body.itemId
      ? commissionSources(pool.conceptId).filter((s) => s.itemId === body.itemId)
      : commissionSources(pool.conceptId);

    const available = sources.reduce((sum, s) => sum + s.quantity, 0);
    if (available < body.quantity) {
      throw new ApiError(
        409,
        'not_enough_stock',
        `Only ${available} in stock, ${body.quantity} asked for`,
      );
    }

    // Take it out of the cupboard, oldest box first.
    let left = body.quantity;
    const drawnFrom: string[] = [];
    for (const source of sources) {
      if (left <= 0) break;
      const take = Math.min(left, source.quantity);
      const item = db.select().from(items).where(eq(items.id, source.itemId)).get()!;
      const remaining = Math.round(((item.quantityRemaining ?? take) - take) * 1000) / 1000;
      db.update(items)
        .set({ quantityRemaining: Math.max(0, remaining) })
        .where(eq(items.id, item.id))
        .run();
      drawnFrom.push(item.humanId);
      left -= take;

      logEvent({
        entityType: 'item', entityId: item.id, entityHumanId: item.humanId,
        action: 'commissioned', fieldChanged: 'quantityRemaining',
        valueBefore: item.quantityRemaining, valueAfter: Math.max(0, remaining),
        notes: `${take} into ${pool.humanId}`, userId: user.id,
      });
    }

    // Put it into rotation. Identified pools get one numbered unit each; a
    // pooled one just counts higher.
    const unitCodes: string[] = [];
    if (pool.granularity === 'identified') {
      const existing = db
        .select({ code: poolUnits.code })
        .from(poolUnits)
        .where(eq(poolUnits.poolId, id))
        .all()
        .map((row) => Number(row.code))
        .filter((n) => Number.isFinite(n));
      let next = (existing.length > 0 ? Math.max(...existing) : 0) + 1;

      for (let i = 0; i < body.quantity; i += 1) {
        const code = body.codes?.[i] ?? String(next++);
        db.insert(poolUnits)
          .values({ id: crypto.randomUUID(), poolId: id, code, state: 'available' })
          .run();
        unitCodes.push(code);
      }
    }

    // One 'add' event carries the whole batch, and it writes the history entry.
    applyPoolEvent(id, 'add', body.quantity, {
      note: body.note ?? `from ${drawnFrom.join(', ')}`,
      userId: user.id,
    });

    const stockRemaining = commissionSources(pool.conceptId).reduce(
      (sum, s) => sum + s.quantity,
      0,
    );

    return {
      commissioned: body.quantity,
      unitCodes,
      fromItemHumanId: drawnFrom[0] ?? null,
      stockRemaining: Math.round(stockRemaining * 1000) / 1000,
    };
  });

  return c.json(result, 200);
});
