import { and, asc, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { UnassignedSummary } from '@inventory/shared';
import { db } from '../db/client';
import { actionLines, concepts, items, reconciliations } from '../db/schema';
import { logEvent } from './history';

// Level 3. The rule that governs every function here:
//
//   RULE — an activity moves the quantity; only a person declares a
//   container finished.
//
// Recording "I ran a pH test" is not an estimate. It is a person saying what
// happened, and doing it by hand would have moved stock seven times — so the
// button does the same thing, and the numbers follow.
//
// Two figures are kept, and they answer different questions:
//
//   quantityRemaining — what the app believes is physically left. Clamped at
//                       zero, because a bottle cannot hold less than nothing,
//                       and this is what stock sums.
//   estimatedUsed     — what the recipes have claimed, UNCAPPED. This is what
//                       makes the gap measurable at close, in both directions:
//                       quantityInitial − estimatedUsed is positive when the
//                       workshop used more than any recipe accounted for, and
//                       negative when the recipes run fat.
//
// Nothing here ever closes a container or changes a status. That decision is
// a person's, always.

/**
 * The consumption map in force on a given date. Editing a map closes the old
 * rows and opens new ones, so reprocessing history never applies today's recipe
 * to last March.
 */
export function mapInForce(actionId: string, at: Date) {
  return db
    .select()
    .from(actionLines)
    .where(
      and(
        eq(actionLines.actionId, actionId),
        sql`${actionLines.validFrom} <= ${Math.floor(at.getTime() / 1000)}`,
        or(isNull(actionLines.validTo), sql`${actionLines.validTo} > ${Math.floor(at.getTime() / 1000)}`),
      ),
    )
    .all();
}

/**
 * What a recorded activity draws from. Oldest first, but with two preferences
 * that only show up in a workshop that has been running a while:
 *
 *  1. A container that still measurably has something in it wins. A container
 *     can read zero and stay open — the app has said "this should be empty"
 *     and is waiting for a person to confirm — and if charges kept landing
 *     there, a workshop with one spent bottle left open would watch its stock stop
 *     moving while the work plainly came out of the next bottle along.
 *  2. Among those, one that tracks a quantity wins over one that does not.
 *     A container with no quantity absorbs the charge without moving any
 *     number, so preferring it would quietly make consumption invisible.
 *
 * If nothing qualifies, the oldest open container still takes the charge: the
 * over-claim has to land somewhere for the gap to be measurable at close.
 */
export function openContainerFor(conceptId: string) {
  const open = db
    .select()
    .from(items)
    .where(
      and(eq(items.conceptId, conceptId), eq(items.status, 'open'), isNull(items.deletedAt)),
    )
    .orderBy(asc(items.openedAt), asc(items.humanId))
    .all();

  return (
    open.find((item) => item.quantityRemaining !== null && item.quantityRemaining > 0) ??
    open.find((item) => item.quantityRemaining === null) ??
    open[0]
  );
}

export interface Charge {
  conceptId: string;
  quantity: number;
  itemId: string | null;
  itemHumanId: string | null;
  unbacked: boolean;
}

export interface Prompt {
  itemId: string;
  itemHumanId: string;
  conceptId: string;
  estimatedUsed: number;
  containerQuantity: number;
}

/**
 * Charge one occurrence (× count) of an action's map to the open containers.
 * Returns what was charged and which containers the map now says are empty.
 */
export function chargeAction(
  actionId: string,
  count: number,
  at: Date,
): { charges: Charge[]; prompts: Prompt[] } {
  const lines = mapInForce(actionId, at);
  const charges: Charge[] = [];
  const prompts: Prompt[] = [];

  for (const line of lines) {
    const quantity = line.quantity * count;
    const container = openContainerFor(line.conceptId);

    if (!container) {
      // Nothing open to charge. Not an error — the estimate simply has
      // nowhere to land, and the UI says so rather than inventing a container.
      charges.push({
        conceptId: line.conceptId,
        quantity,
        itemId: null,
        itemHumanId: null,
        unbacked: true,
      });
      continue;
    }

    const nextEstimate = container.estimatedUsed + quantity;
    // The stock number moves. Clamped at zero: the container may well be empty
    // already, but "−100 mL in the cupboard" is not a thing, and the overdraw
    // is not lost — estimatedUsed keeps it, uncapped, for the reconciliation.
    const nextRemaining =
      container.quantityRemaining === null
        ? null
        : Math.max(0, Math.round((container.quantityRemaining - quantity) * 1000) / 1000);

    db.update(items)
      .set({
        estimatedUsed: nextEstimate,
        ...(nextRemaining === null ? {} : { quantityRemaining: nextRemaining }),
      })
      .where(eq(items.id, container.id))
      .run();

    charges.push({
      conceptId: line.conceptId,
      quantity,
      itemId: container.id,
      itemHumanId: container.humanId,
      unbacked: false,
    });

    // "The app thinks this is empty." Not a question with a number in it: the
    // only two answers are that it ran out, or that there is more left than
    // the recipe expected — and the second one needs no typing, because the
    // truth gets recorded when the container is finally closed.
    const held = container.quantityInitial;
    if (held !== null && nextEstimate >= held) {
      prompts.push({
        itemId: container.id,
        itemHumanId: container.humanId,
        conceptId: line.conceptId,
        estimatedUsed: Math.round(nextEstimate * 1000) / 1000,
        containerQuantity: held,
      });
    }
  }

  return { charges, prompts };
}

/**
 * Written when a container closes, and only then. One depleted
 * container = one row, which is what keeps the real-cost figure stable instead
 * of re-dancing every morning.
 *
 * Called from the deplete endpoint, inside its transaction.
 */
export function reconcileOnClose(
  item: typeof items.$inferSelect,
  userId?: string | null,
): void {
  if (!item.conceptId) return;
  // Only containers that actually held a measurable amount can be reconciled.
  const held = item.quantityInitial;
  if (held === null || held <= 0) return;
  // Nothing was ever charged: there is no map for this concept, so there is
  // no theoretical figure to compare against and no gap worth recording.
  if (item.estimatedUsed <= 0) return;

  // Never "waste": it does not claim the units were lost, only that no action
  // claimed them. Often it means a map is missing.
  const unassigned = Math.round((held - item.estimatedUsed) * 1000) / 1000;

  db.insert(reconciliations)
    .values({
      id: crypto.randomUUID(),
      itemId: item.id,
      conceptId: item.conceptId,
      containerQuantity: held,
      theoreticalUsed: item.estimatedUsed,
      unassigned,
      openedAt: item.openedAt,
      closedAt: new Date(),
    })
    .run();

  // The gap is the most valuable number the app produces, so it belongs in the
  // history where you can find it, not only in a summary page.
  logEvent({
    entityType: 'item',
    entityId: item.id,
    entityHumanId: item.humanId,
    action: 'reconciled',
    fieldChanged: 'unassigned',
    valueBefore: Math.round(item.estimatedUsed * 1000) / 1000,
    valueAfter: held,
    notes: `unassigned ${unassigned}`,
    userId: userId ?? null,
  });
}

/**
 * Per-concept overhead factor from CLOSED containers only. This is what turns
 * a theoretical cost per action into a real one.
 */
export function overheadByConcept(): Map<string, number> {
  const rows = db
    .select({
      conceptId: reconciliations.conceptId,
      held: sql<number>`sum(${reconciliations.containerQuantity})`,
      theoretical: sql<number>`sum(${reconciliations.theoreticalUsed})`,
    })
    .from(reconciliations)
    .groupBy(reconciliations.conceptId)
    .all();

  const map = new Map<string, number>();
  for (const row of rows) {
    const theoretical = Number(row.theoretical ?? 0);
    const held = Number(row.held ?? 0);
    if (theoretical <= 0) continue;
    map.set(row.conceptId, held / theoretical);
  }
  return map;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The unassigned quantity, expressed as a rate per day a container was open.
 *
 * Spreading it over the activities in the window was the obvious thing to do
 * and it was wrong: you do not know it was the activities. Spreading it over
 * the days is a measurement rather than a guess — "this bottle loses 12 mL a
 * day just by being open" — and it is available from the FIRST closed
 * container, where a per-activity split needs a busy month to mean anything.
 *
 * A day with unusually many activities still shows up: the total burn rises,
 * and you can go and look. The number just stops claiming to know why.
 */
export function overheadDailyByConcept(): Map<
  string,
  { perDay: number; daysOpen: number; containers: number; unassigned: number }
> {
  const rows = db
    .select({
      conceptId: reconciliations.conceptId,
      unassigned: reconciliations.unassigned,
      openedAt: reconciliations.openedAt,
      closedAt: reconciliations.closedAt,
    })
    .from(reconciliations)
    .where(isNotNull(reconciliations.openedAt))
    .all();

  const totals = new Map<string, { unassigned: number; days: number; containers: number }>();
  for (const row of rows) {
    if (!row.openedAt) continue;
    // A container opened and closed the same day still counts as one day, so
    // a single fast bottle cannot divide by zero and report an infinite rate.
    const days = Math.max(1, (row.closedAt.getTime() - row.openedAt.getTime()) / DAY_MS);
    const entry = totals.get(row.conceptId) ?? { unassigned: 0, days: 0, containers: 0 };
    entry.unassigned += row.unassigned;
    entry.days += days;
    entry.containers += 1;
    totals.set(row.conceptId, entry);
  }

  const out = new Map<
    string,
    { perDay: number; daysOpen: number; containers: number; unassigned: number }
  >();
  for (const [conceptId, entry] of totals) {
    out.set(conceptId, {
      perDay: Math.round((entry.unassigned / entry.days) * 1000) / 1000,
      daysOpen: Math.round(entry.days * 10) / 10,
      containers: entry.containers,
      unassigned: Math.round(entry.unassigned * 1000) / 1000,
    });
  }
  return out;
}

export function unassignedSummary(): UnassignedSummary[] {
  const rows = db
    .select({
      conceptId: reconciliations.conceptId,
      n: sql<number>`count(*)`,
      held: sql<number>`sum(${reconciliations.containerQuantity})`,
      theoretical: sql<number>`sum(${reconciliations.theoreticalUsed})`,
      unassigned: sql<number>`sum(${reconciliations.unassigned})`,
    })
    .from(reconciliations)
    .groupBy(reconciliations.conceptId)
    .all();

  const overhead = overheadDailyByConcept();

  return rows.map((row) => {
    const concept = db.select().from(concepts).where(eq(concepts.id, row.conceptId)).get();
    const theoretical = Number(row.theoretical ?? 0);
    const held = Number(row.held ?? 0);
    const daily = overhead.get(row.conceptId) ?? null;
    return {
      conceptId: row.conceptId,
      conceptName: concept?.name ?? { en: '?' },
      containersClosed: Number(row.n),
      totalHeld: Math.round(held * 1000) / 1000,
      totalTheoretical: Math.round(theoretical * 1000) / 1000,
      totalUnassigned: Math.round(Number(row.unassigned ?? 0) * 1000) / 1000,
      ratio: theoretical > 0 ? Math.round((held / theoretical) * 1000) / 1000 : null,
      unassignedPerDay: daily?.perDay ?? null,
      daysOpen: daily?.daysOpen ?? null,
    };
  });
}

/**
 * Price of one functional unit of a Concept, averaged over items that carry
 * both a price and a quantity. Used to turn consumption into money.
 */
export function unitPriceByConcept(): Map<string, { amount: number; currency: string }> {
  const rows = db
    .select({
      conceptId: items.conceptId,
      amount: sql<number>`avg(
        cast(${items.priceAmount} as real) /
        case when coalesce(${items.quantityInitial}, 0) > 0
             then ${items.quantityInitial} else 1 end
      )`,
      currency: sql<string>`max(${items.priceCurrency})`,
    })
    .from(items)
    .where(
      and(isNotNull(items.priceAmount), isNotNull(items.conceptId), isNull(items.deletedAt)),
    )
    .groupBy(items.conceptId)
    .all();

  const map = new Map<string, { amount: number; currency: string }>();
  for (const row of rows) {
    if (row.amount === null) continue;
    map.set(row.conceptId!, {
      amount: Number(row.amount),
      currency: row.currency ?? 'EUR',
    });
  }
  return map;
}
