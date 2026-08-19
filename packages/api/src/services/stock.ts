import { and, eq, inArray, isNotNull, isNull, sum } from 'drizzle-orm';
import type { ItemStatus } from '@inventory/shared';
import { db } from '../db/client';
import { items } from '../db/schema';

// THE stock aggregation. It lives here and nowhere else.
// Stock is never stored — always computed from Items:
//   SUM(quantity_remaining) WHERE status IN ('in_stock','open')

const ACTIVE_STOCK_STATUSES: ItemStatus[] = ['in_stock', 'open'];

export function stockForConcept(conceptId: string): number {
  const row = db
    .select({ stock: sum(items.quantityRemaining) })
    .from(items)
    .where(
      and(
        eq(items.conceptId, conceptId),
        inArray(items.status, ACTIVE_STOCK_STATUSES),
        isNull(items.deletedAt),
      ),
    )
    .get();
  return Number(row?.stock ?? 0);
}

/**
 * One query for the whole Home page: conceptId → stock.
 * Pass locationIds (a subtree from subtreeIds()) to answer "how much do I
 * have of everything IN THIS ROOM?" — same aggregation, extra filter.
 */
export function stockByConcept(locationIds?: string[]): Record<string, number> {
  const rows = db
    .select({ conceptId: items.conceptId, stock: sum(items.quantityRemaining) })
    .from(items)
    .where(
      and(
        inArray(items.status, ACTIVE_STOCK_STATUSES),
        isNull(items.deletedAt),
        isNotNull(items.conceptId),
        locationIds ? inArray(items.locationId, locationIds) : undefined,
      ),
    )
    .groupBy(items.conceptId)
    .all();

  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.conceptId!] = Number(row.stock ?? 0);
  }
  return result;
}
