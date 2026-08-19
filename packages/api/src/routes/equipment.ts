import { createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  errorResponseSchema,
  itemLinkCreateSchema,
  itemLinkSchema,
  itemLinksResponseSchema,
  maintenanceDoneSchema,
  maintenancePlanCreateSchema,
  maintenancePlanSchema,
  maintenancePlanUpdateSchema,
  maintenancePlanWithStatusSchema,
  maintenanceRecordSchema,
  maintenanceUsesSchema,
} from '@inventory/shared';
import type { ItemLinkWithRefs } from '@inventory/shared';
import { createRouter } from '../lib/router';
import { db } from '../db/client';
import {
  itemLinks,
  items,
  locations,
  maintenancePlans,
  maintenanceRecords,
  types,
  variants,
} from '../db/schema';
import { user as userTable } from '../db/auth-schema';
import { jsonBody, jsonContent, errorResponse, idParam } from '../lib/openapi';
import { serializeAudit, toIso } from '../lib/serialize';
import { requireRole } from '../middleware/auth';
import type { AuthEnv } from '../middleware/auth';
import { ApiError, notFoundError } from '../middleware/error';
import { logEvent } from '../services/history';
import {
  computeNextDue,
  dueMaintenance,
  markDone,
  plansFor,
  serializePlan,
} from '../services/maintenance';

// Equipment. Two things an instrument has that a bottle of
// buffer does not: other items hanging off it, and a service schedule.
//
// Both are generic rather than instrument-only. A cupboard has a service
// interval and a torque wrench has a calibration certificate, so gating either
// behind a type named "instrument" would only mean re-implementing it the
// first time somebody attached a manual to something else.

export const equipmentRouter = createRouter<AuthEnv>();

// ---------------------------------------------------------------- helpers

function getActiveItem(id: string) {
  const row = db
    .select()
    .from(items)
    .where(and(eq(items.id, id), isNull(items.deletedAt)))
    .get();
  if (!row) throw notFoundError('item', id);
  return row;
}

/** The far end of a link, named the way a person would recognise it. */
const otherSelect = {
  link: itemLinks,
  otherItemId: items.id,
  otherHumanId: items.humanId,
  otherName: variants.name,
  otherStatus: items.status,
  otherTypeName: types.name,
  otherLocationCode: locations.code,
};

function serializeLink(
  row: {
    link: typeof itemLinks.$inferSelect;
    otherItemId: string;
    otherHumanId: string;
    otherName: unknown;
    otherStatus: string;
    otherTypeName: unknown;
    otherLocationCode: string | null;
  },
  direction: 'child' | 'parent',
): ItemLinkWithRefs {
  return {
    ...serializeAudit(row.link),
    direction,
    otherItemId: row.otherItemId,
    otherHumanId: row.otherHumanId,
    otherName: (row.otherName ?? null) as ItemLinkWithRefs['otherName'],
    otherStatus: row.otherStatus,
    otherTypeName: (row.otherTypeName ?? null) as ItemLinkWithRefs['otherTypeName'],
    otherLocationCode: row.otherLocationCode,
  };
}

/**
 * Links with the far item resolved. `farSide` says which column of the link is
 * the far one, so the same query serves both halves — it has to be joined
 * first, since every other join hangs off `items`.
 */
function linkQuery(farSide: 'child' | 'parent') {
  const farColumn = farSide === 'child' ? itemLinks.childItemId : itemLinks.parentItemId;
  return db
    .select(otherSelect)
    .from(itemLinks)
    .innerJoin(items, eq(farColumn, items.id))
    .leftJoin(variants, eq(items.variantId, variants.id))
    .leftJoin(types, eq(items.typeId, types.id))
    .leftJoin(locations, eq(items.locationId, locations.id));
}

/**
 * Walk up from `itemId` collecting every ancestor.
 *
 * Guards against the cycle a person creates by accident: attach the manual to
 * the machine, then attach the machine to the manual. Depth is capped because
 * a corrupted table must not hang the request.
 */
function ancestorsOf(itemId: string, depth = 0): Set<string> {
  const found = new Set<string>();
  if (depth > 20) return found;
  const parents = db
    .select({ id: itemLinks.parentItemId })
    .from(itemLinks)
    .where(and(eq(itemLinks.childItemId, itemId), isNull(itemLinks.deletedAt)))
    .all();
  for (const parent of parents) {
    if (found.has(parent.id)) continue;
    found.add(parent.id);
    for (const grand of ancestorsOf(parent.id, depth + 1)) found.add(grand);
  }
  return found;
}

// ------------------------------------------------------- GET /items/:id/links
const listLinksRoute = createRoute({
  method: 'get',
  path: '/items/{id}/links',
  tags: ['equipment'],
  middleware: [requireRole('viewer')] as const,
  request: { params: idParam },
  responses: {
    200: {
      description: 'What hangs off this item, and what it hangs off',
      ...jsonContent(itemLinksResponseSchema),
    },
    401: errorResponse('Not signed in'),
    404: errorResponse('Item not found'),
  },
});

equipmentRouter.openapi(listLinksRoute, (c) => {
  const { id } = c.req.valid('param');
  getActiveItem(id);

  // A deleted item is dropped from both lists: the drawer must not offer to
  // show you a manual that is sitting in the bin.
  const children = linkQuery('child')
    .where(
      and(
        eq(itemLinks.parentItemId, id),
        isNull(itemLinks.deletedAt),
        isNull(items.deletedAt),
      ),
    )
    .all()
    .map((row) => serializeLink(row, 'child'));

  const parents = linkQuery('parent')
    .where(
      and(eq(itemLinks.childItemId, id), isNull(itemLinks.deletedAt), isNull(items.deletedAt)),
    )
    .all()
    .map((row) => serializeLink(row, 'parent'));

  return c.json({ children, parents }, 200);
});

// ------------------------------------------------------ POST /items/:id/links
const createLinkRoute = createRoute({
  method: 'post',
  path: '/items/{id}/links',
  tags: ['equipment'],
  middleware: [requireRole('operator')] as const,
  request: { params: idParam, ...jsonBody(itemLinkCreateSchema) },
  responses: {
    201: { description: 'Attached', ...jsonContent(itemLinkSchema) },
    400: errorResponse('Would create a loop, or is already attached'),
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires operator role'),
    404: errorResponse('Item not found'),
  },
});

equipmentRouter.openapi(createLinkRoute, (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const parent = getActiveItem(id);
  const child = getActiveItem(body.childItemId);

  if (parent.id === child.id) {
    throw new ApiError(400, 'invalid_link', 'An item cannot be attached to itself');
  }
  if (ancestorsOf(parent.id).has(child.id)) {
    throw new ApiError(
      400,
      'invalid_link',
      `${child.humanId} is already further up this chain — attaching it here would make a loop`,
    );
  }

  const duplicate = db
    .select({ id: itemLinks.id })
    .from(itemLinks)
    .where(
      and(
        eq(itemLinks.parentItemId, parent.id),
        eq(itemLinks.childItemId, child.id),
        isNull(itemLinks.deletedAt),
      ),
    )
    .get();
  if (duplicate) {
    throw new ApiError(400, 'invalid_link', `${child.humanId} is already attached to this item`);
  }

  const created = db.transaction((tx) => {
    const row = tx
      .insert(itemLinks)
      .values({
        id: crypto.randomUUID(),
        parentItemId: parent.id,
        childItemId: child.id,
        relation: body.relation,
        notes: body.notes ?? null,
      })
      .returning()
      .get();

    logEvent({
      entityType: 'item',
      entityId: parent.id,
      entityHumanId: parent.humanId,
      action: 'linked',
      fieldChanged: body.relation,
      valueAfter: { item: child.humanId },
      userId: c.get('user')?.id ?? null,
    });
    return row;
  });

  return c.json(serializeAudit(created), 201);
});

// ---------------------------------------------------------- DELETE /links/:id
const deleteLinkRoute = createRoute({
  method: 'delete',
  path: '/links/{id}',
  tags: ['equipment'],
  middleware: [requireRole('operator')] as const,
  request: { params: idParam },
  responses: {
    200: { description: 'Detached', ...jsonContent(itemLinkSchema) },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires operator role'),
    404: errorResponse('Link not found'),
  },
});

equipmentRouter.openapi(deleteLinkRoute, (c) => {
  const { id } = c.req.valid('param');
  const link = db
    .select()
    .from(itemLinks)
    .where(and(eq(itemLinks.id, id), isNull(itemLinks.deletedAt)))
    .get();
  if (!link) throw notFoundError('link', id);

  const parent = db.select().from(items).where(eq(items.id, link.parentItemId)).get();
  const child = db.select().from(items).where(eq(items.id, link.childItemId)).get();

  const updated = db.transaction((tx) => {
    const row = tx
      .update(itemLinks)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(itemLinks.id, id))
      .returning()
      .get();

    logEvent({
      entityType: 'item',
      entityId: link.parentItemId,
      entityHumanId: parent?.humanId ?? null,
      action: 'unlinked',
      fieldChanged: link.relation,
      valueBefore: { item: child?.humanId ?? '?' },
      userId: c.get('user')?.id ?? null,
    });
    return row;
  });

  return c.json(serializeAudit(updated), 200);
});

// ------------------------------------------------- GET /items/:id/maintenance
const listPlansRoute = createRoute({
  method: 'get',
  path: '/items/{id}/maintenance',
  tags: ['equipment'],
  middleware: [requireRole('viewer')] as const,
  request: { params: idParam },
  responses: {
    200: {
      description: 'Service plans on this item, soonest due first',
      ...jsonContent(z.array(maintenancePlanWithStatusSchema)),
    },
    401: errorResponse('Not signed in'),
    404: errorResponse('Item not found'),
  },
});

equipmentRouter.openapi(listPlansRoute, (c) => {
  const { id } = c.req.valid('param');
  getActiveItem(id);
  return c.json(
    plansFor(id).map((plan) => serializePlan(plan)),
    200,
  );
});

// ------------------------------------------------ POST /items/:id/maintenance
const createPlanRoute = createRoute({
  method: 'post',
  path: '/items/{id}/maintenance',
  tags: ['equipment'],
  middleware: [requireRole('operator')] as const,
  request: { params: idParam, ...jsonBody(maintenancePlanCreateSchema) },
  responses: {
    201: { description: 'Plan created', ...jsonContent(maintenancePlanWithStatusSchema) },
    400: errorResponse('A plan must count days, uses, or both'),
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires operator role'),
    404: errorResponse('Item not found'),
  },
});

equipmentRouter.openapi(createPlanRoute, (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const item = getActiveItem(id);

  const lastDoneAt = body.lastDoneAt ? new Date(body.lastDoneAt) : null;
  const now = new Date();

  const created = db.transaction((tx) => {
    const row = tx
      .insert(maintenancePlans)
      .values({
        id: crypto.randomUUID(),
        itemId: item.id,
        name: body.name,
        kind: body.kind,
        everyDays: body.everyDays ?? null,
        everyUses: body.everyUses ?? null,
        lastDoneAt,
        nextDueAt: computeNextDue({
          everyDays: body.everyDays ?? null,
          lastDoneAt,
          createdAt: now,
        }),
        notes: body.notes ?? null,
      })
      .returning()
      .get();

    logEvent({
      entityType: 'maintenance',
      entityId: row.id,
      entityHumanId: item.humanId,
      action: 'created',
      valueAfter: {
        every: row.everyDays ? `${row.everyDays} days` : `${row.everyUses} uses`,
      },
      userId: c.get('user')?.id ?? null,
    });
    return row;
  });

  return c.json(serializePlan(created), 201);
});

// --------------------------------------------------------- PATCH /maintenance
const updatePlanRoute = createRoute({
  method: 'patch',
  path: '/maintenance/{id}',
  tags: ['equipment'],
  middleware: [requireRole('operator')] as const,
  request: { params: idParam, ...jsonBody(maintenancePlanUpdateSchema) },
  responses: {
    200: { description: 'Plan updated', ...jsonContent(maintenancePlanWithStatusSchema) },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires operator role'),
    404: errorResponse('Plan not found'),
  },
});

equipmentRouter.openapi(updatePlanRoute, (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const plan = db
    .select()
    .from(maintenancePlans)
    .where(and(eq(maintenancePlans.id, id), isNull(maintenancePlans.deletedAt)))
    .get();
  if (!plan) throw notFoundError('maintenance', id);

  const everyDays = body.everyDays === undefined ? plan.everyDays : (body.everyDays ?? null);
  const everyUses = body.everyUses === undefined ? plan.everyUses : (body.everyUses ?? null);
  if (everyDays === null && everyUses === null) {
    throw new ApiError(
      400,
      'invalid_plan',
      'A plan must count something — days, uses, or both',
    );
  }

  const updated = db.transaction((tx) => {
    const row = tx
      .update(maintenancePlans)
      .set({
        ...(body.name !== undefined && { name: body.name }),
        ...(body.kind !== undefined && { kind: body.kind }),
        everyDays,
        everyUses,
        ...(body.notes !== undefined && { notes: body.notes ?? null }),
        // The window moved, so when it next falls due moved with it.
        nextDueAt: computeNextDue({
          everyDays,
          lastDoneAt: plan.lastDoneAt,
          createdAt: plan.createdAt,
        }),
        updatedAt: new Date(),
      })
      .where(eq(maintenancePlans.id, id))
      .returning()
      .get();

    logEvent({
      entityType: 'maintenance',
      entityId: id,
      action: 'updated',
      userId: c.get('user')?.id ?? null,
    });
    return row;
  });

  return c.json(serializePlan(updated), 200);
});

// -------------------------------------------------------- DELETE /maintenance
const deletePlanRoute = createRoute({
  method: 'delete',
  path: '/maintenance/{id}',
  tags: ['equipment'],
  middleware: [requireRole('manager')] as const,
  request: { params: idParam },
  responses: {
    200: { description: 'Plan removed', ...jsonContent(maintenancePlanSchema) },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires manager role'),
    404: errorResponse('Plan not found'),
  },
});

equipmentRouter.openapi(deletePlanRoute, (c) => {
  const { id } = c.req.valid('param');
  const plan = db
    .select()
    .from(maintenancePlans)
    .where(and(eq(maintenancePlans.id, id), isNull(maintenancePlans.deletedAt)))
    .get();
  if (!plan) throw notFoundError('maintenance', id);

  const updated = db.transaction((tx) => {
    const row = tx
      .update(maintenancePlans)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(maintenancePlans.id, id))
      .returning()
      .get();

    logEvent({
      entityType: 'maintenance',
      entityId: id,
      action: 'soft_deleted',
      userId: c.get('user')?.id ?? null,
    });
    return row;
  });

  return c.json(
    {
      ...serializeAudit(updated),
      lastDoneAt: toIso(updated.lastDoneAt),
      nextDueAt: toIso(updated.nextDueAt),
    },
    200,
  );
});

// --------------------------------------------------- POST /maintenance/:id/done
const doneRoute = createRoute({
  method: 'post',
  path: '/maintenance/{id}/done',
  tags: ['equipment'],
  middleware: [requireRole('operator')] as const,
  request: { params: idParam, ...jsonBody(maintenanceDoneSchema) },
  responses: {
    200: {
      description: 'Recorded; both counters start again',
      ...jsonContent(maintenancePlanWithStatusSchema),
    },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires operator role'),
    404: errorResponse('Plan not found'),
  },
});

equipmentRouter.openapi(doneRoute, (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const plan = db
    .select()
    .from(maintenancePlans)
    .where(and(eq(maintenancePlans.id, id), isNull(maintenancePlans.deletedAt)))
    .get();
  if (!plan) throw notFoundError('maintenance', id);

  const item = db.select().from(items).where(eq(items.id, plan.itemId)).get();
  const doneAt = body.doneAt ? new Date(body.doneAt) : new Date();
  const userId = c.get('user')?.id ?? null;

  const updated = db.transaction(() => {
    // The record keeps the counter reading at the moment of service, because
    // "serviced at 480 runs" is what makes the next window meaningful.
    db.insert(maintenanceRecords)
      .values({
        id: crypto.randomUUID(),
        planId: plan.id,
        doneAt,
        userId,
        usesAtService: plan.everyUses === null ? null : plan.usesSinceLast,
        notes: body.notes ?? null,
      })
      .run();

    const row = markDone(plan.id, doneAt);

    logEvent({
      entityType: 'maintenance',
      entityId: plan.id,
      entityHumanId: item?.humanId ?? null,
      action: 'serviced',
      valueAfter: {
        next: row.nextDueAt ? row.nextDueAt.toISOString().slice(0, 10) : `${row.everyUses} uses`,
      },
      notes: body.notes ?? null,
      userId,
    });
    return row;
  });

  return c.json(serializePlan(updated), 200);
});

// ------------------------------------------------ GET /maintenance/:id/records
const recordsRoute = createRoute({
  method: 'get',
  path: '/maintenance/{id}/records',
  tags: ['equipment'],
  middleware: [requireRole('viewer')] as const,
  request: { params: idParam },
  responses: {
    200: {
      description: 'Everything ever done under this plan, newest first',
      ...jsonContent(z.array(maintenanceRecordSchema)),
    },
    401: errorResponse('Not signed in'),
  },
});

equipmentRouter.openapi(recordsRoute, (c) => {
  const { id } = c.req.valid('param');
  const rows = db
    .select({ record: maintenanceRecords, userName: userTable.name })
    .from(maintenanceRecords)
    .leftJoin(userTable, eq(maintenanceRecords.userId, userTable.id))
    .where(eq(maintenanceRecords.planId, id))
    .orderBy(desc(maintenanceRecords.doneAt))
    .all();

  return c.json(
    rows.map(({ record, userName }) => ({
      ...record,
      doneAt: record.doneAt.toISOString(),
      createdAt: record.createdAt.toISOString(),
      userName,
    })),
    200,
  );
});

// -------------------------------------------------------- POST /items/:id/uses
const usesRoute = createRoute({
  method: 'post',
  path: '/items/{id}/uses',
  tags: ['equipment'],
  middleware: [requireRole('operator')] as const,
  request: { params: idParam, ...jsonBody(maintenanceUsesSchema) },
  responses: {
    200: {
      description: 'Counted against every plan on this item that measures uses',
      ...jsonContent(z.array(maintenancePlanWithStatusSchema)),
    },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires operator role'),
    404: errorResponse('Item not found'),
  },
});

equipmentRouter.openapi(usesRoute, (c) => {
  const { id } = c.req.valid('param');
  const { uses } = c.req.valid('json');
  const item = getActiveItem(id);

  // Deliberately not logged to History: a run is not an event anybody wants to
  // scroll past a hundred of. What it changes — the counter — is visible on
  // the plan, and the service that resets it *is* logged.
  const affected = plansFor(item.id).filter((plan) => plan.everyUses !== null);
  for (const plan of affected) {
    db.update(maintenancePlans)
      .set({ usesSinceLast: plan.usesSinceLast + uses })
      .where(eq(maintenancePlans.id, plan.id))
      .run();
  }

  return c.json(
    plansFor(item.id).map((plan) => serializePlan(plan)),
    200,
  );
});

// -------------------------------------------------------- GET /maintenance/due
const dueRoute = createRoute({
  method: 'get',
  path: '/maintenance/due',
  tags: ['equipment'],
  middleware: [requireRole('viewer')] as const,
  responses: {
    200: {
      description: 'Overdue first, then what falls due soon — the Home card',
      ...jsonContent(z.array(maintenancePlanWithStatusSchema)),
    },
    401: errorResponse('Not signed in'),
  },
});

equipmentRouter.openapi(dueRoute, (c) => c.json(dueMaintenance(), 200));
