import { createRoute, z } from '@hono/zod-openapi';
import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  actionCreateSchema,
  actionRecordCreateSchema,
  actionRecordResultSchema,
  actionRecordSchema,
  actionSchema,
  actionUpdateSchema,
  actionWithCostSchema,
  errorResponseSchema,
  reconciliationSchema,
  resolveText,
  translatedTextSchema,
  unassignedSummarySchema,
} from '@inventory/shared';
import { createRouter } from '../lib/router';
import { db } from '../db/client';
import {
  actionLines,
  actionRecords,
  actions,
  concepts,
  items,
  reconciliations,
} from '../db/schema';
import { user as userTable } from '../db/auth-schema';
import { serializeAudit, toIso } from '../lib/serialize';
import { requireRole } from '../middleware/auth';
import type { AuthEnv } from '../middleware/auth';
import { notFoundError } from '../middleware/error';
import {
  chargeAction,
  mapInForce,
  overheadByConcept,
  unassignedSummary,
  unitPriceByConcept,
} from '../services/actions';
import { logEvent } from '../services/history';
import { generateHumanId } from '../services/ids';

// Actions and consumption maps.
//
// Recording an action must be near-zero friction — pick, how many, when — or
// it will never happen. Everything else here is derivation.

export const actionsRouter = createRouter<AuthEnv>();

const jsonContent = <T extends z.ZodType>(schema: T) => ({
  content: { 'application/json': { schema } },
});
const errorResponse = (description: string) => ({
  description,
  ...jsonContent(errorResponseSchema),
});
const idParam = z.object({ id: z.uuid() });

function getAction(id: string) {
  const row = db
    .select()
    .from(actions)
    .where(and(eq(actions.id, id), isNull(actions.deletedAt)))
    .get();
  if (!row) throw notFoundError('action', id);
  return row;
}

function currentLines(actionId: string) {
  return mapInForce(actionId, new Date()).map((line) => ({
    conceptId: line.conceptId,
    quantity: line.quantity,
  }));
}

/**
 * Two costs, always together: theoretical (map × price) and real (theoretical
 * plus this action's share of unassigned consumption). Their ratio is a
 * process-quality metric — "ICP prep runs at 1.33× theoretical".
 */
function withCost(action: typeof actions.$inferSelect) {
  const lines = currentLines(action.id);
  const prices = unitPriceByConcept();
  const overhead = overheadByConcept();

  let theoreticalCost = 0;
  let realCost = 0;
  let currency: string | null = null;

  const lineDetails = lines.map((line) => {
    const concept = db.select().from(concepts).where(eq(concepts.id, line.conceptId)).get();
    const price = prices.get(line.conceptId);
    if (price) {
      currency ??= price.currency;
      theoreticalCost += line.quantity * price.amount;
      // Unassigned units go only to actions that use that concept, weighted by
      // how many each uses — the only distribution defensible to a person.
      realCost += line.quantity * (overhead.get(line.conceptId) ?? 1) * price.amount;
    }
    return {
      conceptId: line.conceptId,
      quantity: line.quantity,
      conceptName: concept?.name ?? { en: '?' },
      conceptUnit: concept?.unit ?? '',
      unitPriceAmount: price ? Math.round(price.amount) : null,
    };
  });

  const recordRow = db
    .select({ n: count(), last: sql<number>`max(${actionRecords.occurredAt})` })
    .from(actionRecords)
    .where(eq(actionRecords.actionId, action.id))
    .get();

  return {
    ...serializeAudit(action),
    lines,
    lineDetails,
    recordCount: recordRow?.n ?? 0,
    lastRecordedAt: recordRow?.last ? new Date(Number(recordRow.last) * 1000).toISOString() : null,
    theoreticalCost: Math.round(theoreticalCost),
    realCost: Math.round(realCost),
    costRatio:
      theoreticalCost > 0 ? Math.round((realCost / theoreticalCost) * 100) / 100 : null,
    currency,
  };
}

// ---------------------------------------------------------------- GET /actions
const listRoute = createRoute({
  method: 'get',
  path: '/actions',
  tags: ['actions'],
  middleware: [requireRole('viewer')] as const,
  responses: {
    200: {
      description: 'Actions with their current map, theoretical and real cost',
      ...jsonContent(z.array(actionWithCostSchema)),
    },
    401: errorResponse('Not signed in'),
  },
});

actionsRouter.openapi(listRoute, (c) => {
  const rows = db
    .select()
    .from(actions)
    .where(isNull(actions.deletedAt))
    .orderBy(actions.humanId)
    .all();
  return c.json(rows.map(withCost), 200);
});

// --------------------------------------------------------------- POST /actions
const createRoute_ = createRoute({
  method: 'post',
  path: '/actions',
  tags: ['actions'],
  middleware: [requireRole('manager')] as const,
  request: { body: { content: { 'application/json': { schema: actionCreateSchema } } } },
  responses: {
    201: { description: 'Created action', ...jsonContent(actionSchema) },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires manager role'),
  },
});

actionsRouter.openapi(createRoute_, (c) => {
  const body = c.req.valid('json');
  const user = c.get('user');

  const row = db.transaction(() => {
    const id = crypto.randomUUID();
    const humanId = generateHumanId('ACT', 'simple');
    const validFrom = new Date();
    db.insert(actions)
      .values({ id, humanId, name: body.name, notes: body.notes ?? null })
      .run();
    for (const line of body.lines) {
      db.insert(actionLines)
        .values({
          id: crypto.randomUUID(),
          actionId: id,
          conceptId: line.conceptId,
          quantity: line.quantity,
          validFrom,
        })
        .run();
    }
    logEvent({
      entityType: 'action', entityId: id, entityHumanId: humanId,
      action: 'created', valueAfter: { lines: body.lines.length }, userId: user.id,
    });
    return db.select().from(actions).where(eq(actions.id, id)).get()!;
  });

  return c.json({ ...serializeAudit(row), lines: currentLines(row.id) }, 201);
});

// ---------------------------------------------------------- PATCH /actions/:id
const updateRoute = createRoute({
  method: 'patch',
  path: '/actions/{id}',
  tags: ['actions'],
  middleware: [requireRole('manager')] as const,
  request: {
    params: idParam,
    body: { content: { 'application/json': { schema: actionUpdateSchema } } },
  },
  responses: {
    200: { description: 'Updated action', ...jsonContent(actionSchema) },
    401: errorResponse('Not signed in'),
    404: errorResponse('Not found'),
  },
});

actionsRouter.openapi(updateRoute, (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const user = c.get('user');

  const row = db.transaction(() => {
    const before = getAction(id);

    if (body.name !== undefined || body.notes !== undefined) {
      db.update(actions)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.notes !== undefined ? { notes: body.notes } : {}),
        })
        .where(eq(actions.id, id))
        .run();
    }

    if (body.lines) {
      // The map is versioned, never mutated: close the rows in force and open
      // new ones. Otherwise changing a quantity in September would
      // silently rewrite March and flatten the cost curve.
      const validFrom = body.validFrom ? new Date(body.validFrom) : new Date();
      const open = mapInForce(id, validFrom);
      for (const line of open) {
        db.update(actionLines)
          .set({ validTo: validFrom })
          .where(eq(actionLines.id, line.id))
          .run();
      }
      for (const line of body.lines) {
        db.insert(actionLines)
          .values({
            id: crypto.randomUUID(),
            actionId: id,
            conceptId: line.conceptId,
            quantity: line.quantity,
            validFrom,
          })
          .run();
      }
      logEvent({
        entityType: 'action', entityId: id, entityHumanId: before.humanId,
        action: 'updated', fieldChanged: 'map',
        valueBefore: open.map((l) => ({ conceptId: l.conceptId, quantity: l.quantity })),
        valueAfter: body.lines,
        notes: `new version from ${validFrom.toISOString().slice(0, 10)}`,
        userId: user.id,
      });
    }

    if (body.name !== undefined) {
      logEvent({
        entityType: 'action', entityId: id, entityHumanId: before.humanId,
        action: 'updated', fieldChanged: 'name',
        valueBefore: before.name, valueAfter: body.name, userId: user.id,
      });
    }
    return db.select().from(actions).where(eq(actions.id, id)).get()!;
  });

  return c.json({ ...serializeAudit(row), lines: currentLines(row.id) }, 200);
});

// --------------------------------------------------- GET /actions/:id/versions
const versionsRoute = createRoute({
  method: 'get',
  path: '/actions/{id}/versions',
  tags: ['actions'],
  middleware: [requireRole('viewer')] as const,
  request: { params: idParam },
  responses: {
    200: {
      description:
        'Dated map history. Doubles as documentation of when the procedure ' +
        'changed, written by nobody.',
      ...jsonContent(
        z.array(
          z.object({
            validFrom: z.iso.datetime(),
            validTo: z.iso.datetime().nullable(),
            lines: z.array(
              z.object({
                conceptId: z.uuid(),
                conceptName: translatedTextSchema,
                quantity: z.number(),
              }),
            ),
          }),
        ),
      ),
    },
    401: errorResponse('Not signed in'),
  },
});

actionsRouter.openapi(versionsRoute, (c) => {
  const { id } = c.req.valid('param');
  getAction(id);
  const rows = db
    .select()
    .from(actionLines)
    .where(eq(actionLines.actionId, id))
    .orderBy(desc(actionLines.validFrom))
    .all();

  const byVersion = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.validFrom.getTime()}|${row.validTo?.getTime() ?? ''}`;
    byVersion.set(key, [...(byVersion.get(key) ?? []), row]);
  }

  return c.json(
    [...byVersion.values()].map((group) => ({
      validFrom: group[0]!.validFrom.toISOString(),
      validTo: toIso(group[0]!.validTo),
      lines: group.map((line) => {
        const concept = db.select().from(concepts).where(eq(concepts.id, line.conceptId)).get();
        return {
          conceptId: line.conceptId,
          conceptName: concept?.name ?? { en: '?' },
          quantity: line.quantity,
        };
      }),
    })),
    200,
  );
});

// --------------------------------------------------------- DELETE /actions/:id
const deleteRoute = createRoute({
  method: 'delete',
  path: '/actions/{id}',
  tags: ['actions'],
  middleware: [requireRole('manager')] as const,
  request: { params: idParam },
  responses: {
    200: { description: 'Soft-deleted action', ...jsonContent(actionSchema) },
    401: errorResponse('Not signed in'),
    404: errorResponse('Not found'),
  },
});

actionsRouter.openapi(deleteRoute, (c) => {
  const { id } = c.req.valid('param');
  const user = c.get('user');
  const row = db.transaction(() => {
    const before = getAction(id);
    db.update(actions).set({ deletedAt: new Date() }).where(eq(actions.id, id)).run();
    logEvent({
      entityType: 'action', entityId: id, entityHumanId: before.humanId,
      action: 'soft_deleted', userId: user.id,
    });
    return db.select().from(actions).where(eq(actions.id, id)).get()!;
  });
  return c.json({ ...serializeAudit(row), lines: [] }, 200);
});

// -------------------------------------------------------- POST /action-records
// Three taps: which activity, how many times, when. If it costs more than the
// workshop notebook, nobody will do it.
const recordRoute = createRoute({
  method: 'post',
  path: '/action-records',
  tags: ['actions'],
  middleware: [requireRole('operator')] as const,
  request: { body: { content: { 'application/json': { schema: actionRecordCreateSchema } } } },
  responses: {
    201: {
      description: 'Recorded. Charges theoretical use to open containers only.',
      ...jsonContent(actionRecordResultSchema),
    },
    401: errorResponse('Not signed in'),
    404: errorResponse('Action not found'),
  },
});

actionsRouter.openapi(recordRoute, (c) => {
  const body = c.req.valid('json');
  const user = c.get('user');

  const result = db.transaction(() => {
    const action = getAction(body.actionId);
    const occurredAt = body.occurredAt ? new Date(body.occurredAt) : new Date();

    const recordId = crypto.randomUUID();
    db.insert(actionRecords)
      .values({
        id: recordId,
        actionId: action.id,
        count: body.count,
        occurredAt,
        userId: user.id,
        source: 'manual',
      })
      .run();

    const { charges, prompts } = chargeAction(action.id, body.count, occurredAt);

    const named = (conceptId: string) =>
      db.select().from(concepts).where(eq(concepts.id, conceptId)).get()?.name ?? { en: '?' };

    // "count 3" is not history — it does not say what the workshop actually used.
    // The charge list is what makes the row answer that without a second click.
    const unbacked = charges.filter((ch) => ch.unbacked);
    const summary = charges
      .map((ch) => {
        const name = resolveText(named(ch.conceptId), 'en');
        return `${Math.round(ch.quantity * 1000) / 1000} ${name}${ch.unbacked ? ' (nothing open)' : ''}`;
      })
      .join(' · ');

    logEvent({
      entityType: 'action', entityId: action.id, entityHumanId: action.humanId,
      action: 'recorded', valueAfter: { count: body.count },
      notes: summary || (unbacked.length > 0 ? 'nothing open to charge' : null),
      userId: user.id,
    });

    return {
      recordId,
      charged: charges.map((ch) => ({
        conceptId: ch.conceptId,
        conceptName: named(ch.conceptId),
        quantity: Math.round(ch.quantity * 1000) / 1000,
        itemId: ch.itemId,
        itemHumanId: ch.itemHumanId,
        unbacked: ch.unbacked,
      })),
      prompts: prompts.map((p) => ({
        itemId: p.itemId,
        itemHumanId: p.itemHumanId,
        conceptName: named(p.conceptId),
        estimatedUsed: p.estimatedUsed,
        containerQuantity: p.containerQuantity,
      })),
    };
  });

  return c.json(result, 201);
});

// --------------------------------------------------------- GET /action-records
const recordListRoute = createRoute({
  method: 'get',
  path: '/action-records',
  tags: ['actions'],
  middleware: [requireRole('viewer')] as const,
  request: { query: z.object({ actionId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }) },
  responses: {
    200: { description: 'Recent action records', ...jsonContent(z.array(actionRecordSchema)) },
    401: errorResponse('Not signed in'),
  },
});

actionsRouter.openapi(recordListRoute, (c) => {
  const { actionId, limit } = c.req.valid('query');
  const rows = db
    .select()
    .from(actionRecords)
    .where(actionId ? eq(actionRecords.actionId, actionId) : undefined)
    .orderBy(desc(actionRecords.occurredAt))
    .limit(limit)
    .all();

  return c.json(
    rows.map((row) => {
      const action = db.select().from(actions).where(eq(actions.id, row.actionId)).get();
      const who = row.userId
        ? db.select().from(userTable).where(eq(userTable.id, row.userId)).get()
        : null;
      return {
        id: row.id,
        actionId: row.actionId,
        actionName: action?.name ?? { en: '?' },
        count: row.count,
        occurredAt: row.occurredAt.toISOString(),
        userId: row.userId,
        userName: who?.name ?? null,
        source: row.source,
        createdAt: row.createdAt.toISOString(),
      };
    }),
    200,
  );
});

// ------------------------------------------------------- GET /reconciliations
const reconciliationsRoute = createRoute({
  method: 'get',
  path: '/reconciliations',
  tags: ['actions'],
  middleware: [requireRole('viewer')] as const,
  request: { query: z.object({ conceptId: z.uuid().optional() }) },
  responses: {
    200: {
      description: 'One row per closed container: held, theoretical, unassigned',
      ...jsonContent(z.array(reconciliationSchema)),
    },
    401: errorResponse('Not signed in'),
  },
});

actionsRouter.openapi(reconciliationsRoute, (c) => {
  const { conceptId } = c.req.valid('query');
  const rows = db
    .select()
    .from(reconciliations)
    .where(conceptId ? eq(reconciliations.conceptId, conceptId) : undefined)
    .orderBy(desc(reconciliations.closedAt))
    .limit(200)
    .all();

  return c.json(
    rows.map((row) => {
      const concept = db.select().from(concepts).where(eq(concepts.id, row.conceptId)).get();
      const item = db.select().from(items).where(eq(items.id, row.itemId)).get();
      return {
        id: row.id,
        itemId: row.itemId,
        itemHumanId: item?.humanId ?? null,
        conceptId: row.conceptId,
        conceptName: concept?.name ?? { en: '?' },
        containerQuantity: row.containerQuantity,
        theoreticalUsed: row.theoreticalUsed,
        unassigned: row.unassigned,
        openedAt: toIso(row.openedAt),
        closedAt: row.closedAt.toISOString(),
      };
    }),
    200,
  );
});

// --------------------------------------------------- GET /unassigned-summary
const summaryRoute = createRoute({
  method: 'get',
  path: '/unassigned-summary',
  tags: ['actions'],
  middleware: [requireRole('viewer')] as const,
  responses: {
    200: {
      description:
        'Per concept: how the maps compare with reality. A ratio of 1.55 means ' +
        'containers empty as if the map understated by half.',
      ...jsonContent(z.array(unassignedSummarySchema)),
    },
    401: errorResponse('Not signed in'),
  },
});

actionsRouter.openapi(summaryRoute, (c) => c.json(unassignedSummary(), 200));
