import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/client';
import { analogous, concepts, items, locations, variants } from '../db/schema';
import { logEvent } from './history';

// Deleting a catalogue level is blocked while anything hangs off it, which is
// right — but making the user delete four levels by hand is not. Cascade does
// the same walk for them, still as soft deletes, still fully history-logged,
// and still inside one transaction.

export interface CascadeCounts {
  analogous: number;
  variants: number;
  items: number;
  locations: number;
}

const empty = (): CascadeCounts => ({ analogous: 0, variants: 0, items: 0, locations: 0 });

const aliveIds = (rows: Array<{ id: string }>): string[] => rows.map((r) => r.id);

/** What a cascade delete would take with it — used for the confirmation. */
export function previewConceptCascade(conceptId: string): CascadeCounts {
  const counts = empty();
  const anaRows = db
    .select({ id: analogous.id })
    .from(analogous)
    .where(and(eq(analogous.conceptId, conceptId), isNull(analogous.deletedAt)))
    .all();
  counts.analogous = anaRows.length;

  const varRows = db
    .select({ id: variants.id })
    .from(variants)
    .where(and(eq(variants.conceptId, conceptId), isNull(variants.deletedAt)))
    .all();
  counts.variants = varRows.length;

  counts.items = db
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.conceptId, conceptId), isNull(items.deletedAt)))
    .all().length;

  return counts;
}

export function previewAnalogousCascade(analogousId: string): CascadeCounts {
  const counts = empty();
  counts.variants = db
    .select({ id: variants.id })
    .from(variants)
    .where(and(eq(variants.analogousId, analogousId), isNull(variants.deletedAt)))
    .all().length;
  counts.items = db
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.analogousId, analogousId), isNull(items.deletedAt)))
    .all().length;
  return counts;
}

export function previewVariantCascade(variantId: string): CascadeCounts {
  const counts = empty();
  counts.items = db
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.variantId, variantId), isNull(items.deletedAt)))
    .all().length;
  return counts;
}

function softDeleteItems(ids: string[], userId: string | null, now: Date): void {
  if (ids.length === 0) return;
  const rows = db
    .select({ id: items.id, humanId: items.humanId })
    .from(items)
    .where(inArray(items.id, ids))
    .all();
  db.update(items).set({ deletedAt: now }).where(inArray(items.id, ids)).run();
  for (const row of rows) {
    logEvent({
      entityType: 'item',
      entityId: row.id,
      entityHumanId: row.humanId,
      action: 'soft_deleted',
      notes: 'cascade',
      userId,
    });
  }
}

function softDeleteVariants(ids: string[], userId: string | null, now: Date): void {
  if (ids.length === 0) return;
  const rows = db
    .select({ id: variants.id, humanId: variants.humanId })
    .from(variants)
    .where(inArray(variants.id, ids))
    .all();
  db.update(variants).set({ deletedAt: now }).where(inArray(variants.id, ids)).run();
  for (const row of rows) {
    logEvent({
      entityType: 'variant',
      entityId: row.id,
      entityHumanId: row.humanId,
      action: 'soft_deleted',
      notes: 'cascade',
      userId,
    });
  }
}

function softDeleteAnalogous(ids: string[], userId: string | null, now: Date): void {
  if (ids.length === 0) return;
  const rows = db
    .select({ id: analogous.id, humanId: analogous.humanId })
    .from(analogous)
    .where(inArray(analogous.id, ids))
    .all();
  db.update(analogous).set({ deletedAt: now }).where(inArray(analogous.id, ids)).run();
  for (const row of rows) {
    logEvent({
      entityType: 'analogous',
      entityId: row.id,
      entityHumanId: row.humanId,
      action: 'soft_deleted',
      notes: 'cascade',
      userId,
    });
  }
}

/** Call inside the caller's transaction, before deleting the root itself. */
export function cascadeFromConcept(conceptId: string, userId: string | null): CascadeCounts {
  const now = new Date();
  const counts = previewConceptCascade(conceptId);

  softDeleteItems(
    aliveIds(
      db
        .select({ id: items.id })
        .from(items)
        .where(and(eq(items.conceptId, conceptId), isNull(items.deletedAt)))
        .all(),
    ),
    userId,
    now,
  );
  softDeleteVariants(
    aliveIds(
      db
        .select({ id: variants.id })
        .from(variants)
        .where(and(eq(variants.conceptId, conceptId), isNull(variants.deletedAt)))
        .all(),
    ),
    userId,
    now,
  );
  softDeleteAnalogous(
    aliveIds(
      db
        .select({ id: analogous.id })
        .from(analogous)
        .where(and(eq(analogous.conceptId, conceptId), isNull(analogous.deletedAt)))
        .all(),
    ),
    userId,
    now,
  );
  return counts;
}

export function cascadeFromAnalogous(analogousId: string, userId: string | null): CascadeCounts {
  const now = new Date();
  const counts = previewAnalogousCascade(analogousId);

  softDeleteItems(
    aliveIds(
      db
        .select({ id: items.id })
        .from(items)
        .where(and(eq(items.analogousId, analogousId), isNull(items.deletedAt)))
        .all(),
    ),
    userId,
    now,
  );
  softDeleteVariants(
    aliveIds(
      db
        .select({ id: variants.id })
        .from(variants)
        .where(and(eq(variants.analogousId, analogousId), isNull(variants.deletedAt)))
        .all(),
    ),
    userId,
    now,
  );
  return counts;
}

export function cascadeFromVariant(variantId: string, userId: string | null): CascadeCounts {
  const now = new Date();
  const counts = previewVariantCascade(variantId);
  softDeleteItems(
    aliveIds(
      db
        .select({ id: items.id })
        .from(items)
        .where(and(eq(items.variantId, variantId), isNull(items.deletedAt)))
        .all(),
    ),
    userId,
    now,
  );
  return counts;
}

/**
 * Locations cascade over empty child locations only. Deleting a shelf must
 * never delete the stock standing on it — that guard stays.
 */
export function cascadeFromLocation(
  subtreeIds: string[],
  rootId: string,
  userId: string | null,
): CascadeCounts {
  const now = new Date();
  const childIds = subtreeIds.filter((id) => id !== rootId);
  const counts = empty();
  counts.locations = childIds.length;
  if (childIds.length === 0) return counts;

  const rows = db
    .select({ id: locations.id, code: locations.code })
    .from(locations)
    .where(and(inArray(locations.id, childIds), isNull(locations.deletedAt)))
    .all();
  db.update(locations).set({ deletedAt: now }).where(inArray(locations.id, childIds)).run();
  for (const row of rows) {
    logEvent({
      entityType: 'location',
      entityId: row.id,
      entityHumanId: row.code,
      action: 'soft_deleted',
      notes: 'cascade',
      userId,
    });
  }
  counts.locations = rows.length;
  return counts;
}
