import { and, asc, eq, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type { MaintenancePlanWithStatus } from '@inventory/shared';
import { db } from '../db/client';
import { items, maintenancePlans, variants } from '../db/schema';

// Maintenance. A caliper ages by the calendar, a
// pillar drill ages by use, and plenty of things age by both — so a plan can
// count days, uses, or both, and "due" means whichever comes first.

const DAY_MS = 24 * 60 * 60 * 1000;

/** How far ahead something has to be before it is worth putting on Home. */
export const DUE_SOON_DAYS = 14;

type PlanRow = typeof maintenancePlans.$inferSelect;

/**
 * When the next service falls due, from the last one plus the interval.
 *
 * Stored rather than computed on read, so "what is due" stays one indexed
 * query instead of a scan that grows with the equipment list. Recomputed on
 * every change that could move it.
 */
export function computeNextDue(plan: {
  everyDays: number | null;
  lastDoneAt: Date | null;
  createdAt?: Date;
}): Date | null {
  if (plan.everyDays === null) return null;
  // Never serviced: the clock starts when the plan was written, which is the
  // only honest guess and is visibly wrong in a way a person will correct.
  const from = plan.lastDoneAt ?? plan.createdAt ?? new Date();
  return new Date(from.getTime() + plan.everyDays * DAY_MS);
}

export function planStatus(plan: PlanRow, now = new Date()) {
  const daysUntilDue =
    plan.nextDueAt === null
      ? null
      : Math.round(((plan.nextDueAt.getTime() - now.getTime()) / DAY_MS) * 10) / 10;

  const usesUntilDue =
    plan.everyUses === null ? null : plan.everyUses - plan.usesSinceLast;

  // Whichever comes first. A plan that counts both is overdue as soon as
  // either counter runs out — that is what "every 6 months or 500 runs" means.
  const overdue = (daysUntilDue !== null && daysUntilDue <= 0) ||
    (usesUntilDue !== null && usesUntilDue <= 0);

  const dueSoon =
    !overdue &&
    ((daysUntilDue !== null && daysUntilDue <= DUE_SOON_DAYS) ||
      // Within a tenth of the interval is the same idea, counted in runs.
      (usesUntilDue !== null &&
        plan.everyUses !== null &&
        usesUntilDue <= Math.max(1, Math.ceil(plan.everyUses / 10))));

  return { daysUntilDue, usesUntilDue, overdue, dueSoon };
}

export function serializePlan(plan: PlanRow, now = new Date()): MaintenancePlanWithStatus {
  // An Item has no name of its own — what people call the machine is its
  // Variant ("Precisio XPR205"), so that is what the card has to show.
  const item = db
    .select({ humanId: items.humanId, name: variants.name })
    .from(items)
    .leftJoin(variants, eq(items.variantId, variants.id))
    .where(eq(items.id, plan.itemId))
    .get();

  return {
    id: plan.id,
    itemId: plan.itemId,
    name: plan.name,
    kind: plan.kind,
    everyDays: plan.everyDays,
    everyUses: plan.everyUses,
    usesSinceLast: plan.usesSinceLast,
    lastDoneAt: plan.lastDoneAt?.toISOString() ?? null,
    nextDueAt: plan.nextDueAt?.toISOString() ?? null,
    notes: plan.notes,
    createdAt: plan.createdAt.toISOString(),
    updatedAt: plan.updatedAt.toISOString(),
    deletedAt: plan.deletedAt?.toISOString() ?? null,
    itemHumanId: item?.humanId ?? '?',
    itemName: item?.name ?? null,
    ...planStatus(plan, now),
  };
}

/**
 * Everything overdue or nearly, soonest first — the Home card.
 *
 * Date filtering happens in SQL; the use counter is checked in JS because
 * "overdue by runs" compares two columns to each other, and pushing that into
 * the query buys nothing at a workshop's scale.
 */
export function dueMaintenance(now = new Date()): MaintenancePlanWithStatus[] {
  const soon = new Date(now.getTime() + DUE_SOON_DAYS * DAY_MS);

  const rows = db
    .select()
    .from(maintenancePlans)
    .where(
      and(
        isNull(maintenancePlans.deletedAt),
        or(
          and(isNotNull(maintenancePlans.nextDueAt), lte(maintenancePlans.nextDueAt, soon)),
          isNotNull(maintenancePlans.everyUses),
        ),
      ),
    )
    .orderBy(asc(maintenancePlans.nextDueAt))
    .all();

  return rows
    .map((plan) => serializePlan(plan, now))
    .filter((plan) => plan.overdue || plan.dueSoon)
    .sort((a, b) => {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      return (a.daysUntilDue ?? Infinity) - (b.daysUntilDue ?? Infinity);
    });
}

/** Count runs against every plan on an instrument that measures them. */
export function countUses(itemId: string, uses: number): number {
  const affected = db
    .select()
    .from(maintenancePlans)
    .where(
      and(
        eq(maintenancePlans.itemId, itemId),
        isNotNull(maintenancePlans.everyUses),
        isNull(maintenancePlans.deletedAt),
      ),
    )
    .all();

  for (const plan of affected) {
    db.update(maintenancePlans)
      .set({ usesSinceLast: plan.usesSinceLast + uses })
      .where(eq(maintenancePlans.id, plan.id))
      .run();
  }
  return affected.length;
}

/** Both counters reset together: the service covered whatever was due. */
export function markDone(planId: string, doneAt: Date): PlanRow {
  const plan = db
    .select()
    .from(maintenancePlans)
    .where(eq(maintenancePlans.id, planId))
    .get()!;

  db.update(maintenancePlans)
    .set({
      lastDoneAt: doneAt,
      usesSinceLast: 0,
      nextDueAt: computeNextDue({ everyDays: plan.everyDays, lastDoneAt: doneAt }),
    })
    .where(eq(maintenancePlans.id, planId))
    .run();

  return db.select().from(maintenancePlans).where(eq(maintenancePlans.id, planId)).get()!;
}

/** Guard used by the item routes: an instrument in service cannot be deleted. */
export function plansFor(itemId: string) {
  return db
    .select()
    .from(maintenancePlans)
    .where(and(eq(maintenancePlans.itemId, itemId), isNull(maintenancePlans.deletedAt)))
    .orderBy(sql`${maintenancePlans.nextDueAt} is null`, asc(maintenancePlans.nextDueAt))
    .all();
}
