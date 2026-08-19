import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { PriceHistoryPoint, SupplierStats } from '@inventory/shared';
import { db } from '../db/client';
import { lotLines, lots, suppliers, variants } from '../db/schema';
import { notFoundError } from '../middleware/error';
import { logEvent } from './history';
import { generateHumanId } from './ids';

// Purchasing derivations. Everything here reads from lot
// lines: the price curve, supplier reliability and lead time all fall out of
// having used the purchase flow, with nothing to configure.

export function supplierNameFor(supplierId: string | null): string | null {
  if (!supplierId) return null;
  return db.select().from(suppliers).where(eq(suppliers.id, supplierId)).get()?.name ?? null;
}

/**
 * Pick an existing supplier or name a new one inline — the same find-or-create
 * that Quick Add uses, so the buyer never has to leave the form and go
 * register a shop first. Matching is case-insensitive on the name, which is
 * what stops "Corvid" and "sigma" becoming two separate price histories.
 */
export function resolveSupplier(
  body: { supplierId?: string | null; newSupplierName?: string | null },
  userId: string,
): string | null {
  if (body.supplierId) {
    const existing = db
      .select()
      .from(suppliers)
      .where(and(eq(suppliers.id, body.supplierId), isNull(suppliers.deletedAt)))
      .get();
    if (!existing) throw notFoundError('supplier', body.supplierId);
    return existing.id;
  }

  const name = body.newSupplierName?.trim();
  if (!name) return null;

  const found = db
    .select()
    .from(suppliers)
    .where(and(sql`lower(${suppliers.name}) = lower(${name})`, isNull(suppliers.deletedAt)))
    .get();
  if (found) return found.id;

  const id = crypto.randomUUID();
  const humanId = generateHumanId('SUP', 'simple');
  db.insert(suppliers).values({ id, humanId, name }).run();
  logEvent({
    entityType: 'supplier',
    entityId: id,
    entityHumanId: humanId,
    action: 'created',
    valueAfter: { name },
    userId,
  });
  return id;
}

export interface LastPrice {
  amount: number;
  currency: string;
  date: Date;
}

/**
 * The Variant's last known price. Item prices stay locked at their own
 * creation — this is a separate, forward-looking number.
 */
export function lastPriceForVariant(
  variantId: string,
  beforeLotId?: string,
): LastPrice | null {
  const row = db
    .select({
      amount: lotLines.unitPriceAmount,
      currency: lotLines.priceCurrency,
      date: lots.orderedAt,
      createdAt: lotLines.createdAt,
      lotId: lots.id,
    })
    .from(lotLines)
    .innerJoin(lots, eq(lotLines.lotId, lots.id))
    .where(
      and(
        eq(lotLines.orderedVariantId, variantId),
        isNotNull(lotLines.unitPriceAmount),
        isNull(lotLines.deletedAt),
        isNull(lots.deletedAt),
        beforeLotId ? sql`${lots.id} != ${beforeLotId}` : undefined,
      ),
    )
    .orderBy(desc(lots.orderedAt), desc(lotLines.createdAt))
    .get();

  if (!row || row.amount === null) return null;
  return {
    amount: row.amount,
    currency: row.currency ?? 'EUR',
    date: row.date ?? row.createdAt,
  };
}

/** Whole price curve for one Variant, newest last. */
export function priceHistory(variantId: string): PriceHistoryPoint[] {
  return db
    .select({
      amount: lotLines.unitPriceAmount,
      currency: lotLines.priceCurrency,
      orderedAt: lots.orderedAt,
      createdAt: lotLines.createdAt,
      lotHumanId: lots.humanId,
      supplier: suppliers.name,
    })
    .from(lotLines)
    .innerJoin(lots, eq(lotLines.lotId, lots.id))
    .leftJoin(suppliers, eq(lots.supplierId, suppliers.id))
    .where(
      and(
        eq(lotLines.orderedVariantId, variantId),
        isNotNull(lotLines.unitPriceAmount),
        isNull(lotLines.deletedAt),
        isNull(lots.deletedAt),
      ),
    )
    .orderBy(lots.orderedAt, lotLines.createdAt)
    .all()
    .map((row) => ({
      date: (row.orderedAt ?? row.createdAt).toISOString(),
      amount: row.amount!,
      currency: row.currency ?? 'EUR',
      lotHumanId: row.lotHumanId,
      supplier: row.supplier,
    }));
}

/** "+12% since your last order", shown on the line at the moment of decision. */
export function priceDelta(
  variantId: string,
  currentAmount: number | null,
  excludeLotId?: string,
): { last: LastPrice | null; deltaPercent: number | null } {
  const last = lastPriceForVariant(variantId, excludeLotId);
  if (!last || currentAmount === null || last.amount === 0) {
    return { last, deltaPercent: null };
  }
  return {
    last,
    deltaPercent: Math.round(((currentAmount - last.amount) / last.amount) * 1000) / 10,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Discrepancies are supplier data, not error handling. Accumulated
 * they say "short-ships 8% of lines" and "11 days average" — and that second
 * number is exactly what the forecast needs.
 */
export function supplierStats(): SupplierStats[] {
  const rows = db
    .select({
      supplierId: lots.supplierId,
      supplier: suppliers.name,
      lotId: lots.id,
      orderedAt: lots.orderedAt,
      receivedAt: lots.receivedAt,
      lineId: lotLines.id,
      orderedQuantity: lotLines.orderedQuantity,
      receivedQuantity: lotLines.receivedQuantity,
      orderedVariantId: lotLines.orderedVariantId,
      receivedVariantId: lotLines.receivedVariantId,
      lineStatus: lotLines.status,
    })
    .from(lots)
    .leftJoin(lotLines, and(eq(lotLines.lotId, lots.id), isNull(lotLines.deletedAt)))
    .leftJoin(suppliers, eq(lots.supplierId, suppliers.id))
    .where(and(isNull(lots.deletedAt), isNotNull(lots.orderedAt)))
    .all();

  const bySupplier = new Map<
    string,
    {
      name: string;
      lots: Set<string>;
      lines: number;
      short: number;
      substituted: number;
      leadDays: number[];
    }
  >();

  for (const row of rows) {
    // A lot with no supplier still has performance worth counting; it just
    // shares one bucket rather than being dropped.
    const key = row.supplierId ?? '';
    let entry = bySupplier.get(key);
    if (!entry) {
      entry = {
        name: row.supplier ?? '—',
        lots: new Set(),
        lines: 0,
        short: 0,
        substituted: 0,
        leadDays: [],
      };
      bySupplier.set(key, entry);
    }
    if (!entry.lots.has(row.lotId)) {
      entry.lots.add(row.lotId);
      if (row.orderedAt && row.receivedAt) {
        entry.leadDays.push((row.receivedAt.getTime() - row.orderedAt.getTime()) / DAY_MS);
      }
    }
    if (!row.lineId) continue;
    entry.lines += 1;
    // Only count a shortfall once the line has stopped waiting for more.
    if (
      (row.lineStatus === 'received' || row.lineStatus === 'closed') &&
      (row.receivedQuantity ?? 0) < (row.orderedQuantity ?? 0)
    ) {
      entry.short += 1;
    }
    if (row.receivedVariantId && row.receivedVariantId !== row.orderedVariantId) {
      entry.substituted += 1;
    }
  }

  return [...bySupplier.entries()]
    .map(([supplierId, e]) => ({
      supplierId,
      supplier: e.name,
      lots: e.lots.size,
      lines: e.lines,
      shortLines: e.short,
      substitutedLines: e.substituted,
      shortRate: e.lines > 0 ? Math.round((e.short / e.lines) * 1000) / 1000 : 0,
      avgLeadDays:
        e.leadDays.length > 0
          ? Math.round((e.leadDays.reduce((a, b) => a + b, 0) / e.leadDays.length) * 10) / 10
          : null,
    }))
    .sort((a, b) => b.lots - a.lots);
}

/**
 * Lead time learned from this Concept's own purchase history — how long its
 * orders have actually taken to arrive. The forecast gets smarter purely from
 * using the purchase flow.
 */
export function leadDaysForConcept(conceptId: string): number | null {
  const rows = db
    .select({ orderedAt: lots.orderedAt, receivedAt: lots.receivedAt })
    .from(lotLines)
    .innerJoin(lots, eq(lotLines.lotId, lots.id))
    .where(
      and(
        eq(lotLines.conceptId, conceptId),
        isNotNull(lots.orderedAt),
        isNotNull(lots.receivedAt),
        isNull(lotLines.deletedAt),
        isNull(lots.deletedAt),
      ),
    )
    .all();

  if (rows.length === 0) return null;
  const days = rows.map(
    (r) => (r.receivedAt!.getTime() - r.orderedAt!.getTime()) / DAY_MS,
  );
  return Math.round((days.reduce((a, b) => a + b, 0) / days.length) * 10) / 10;
}

/** Where this Concept's items usually live — the reception location default. */
export function usualLocationForConcept(conceptId: string): string | null {
  const row = db
    .select({ locationId: sql<string>`location_id`, n: sql<number>`count(*)` })
    .from(sql`items`)
    .where(sql`concept_id = ${conceptId} AND location_id IS NOT NULL AND deleted_at IS NULL`)
    .groupBy(sql`location_id`)
    .orderBy(sql`count(*) DESC`)
    .get();
  return row?.locationId ?? null;
}

export function variantName(variantId: string) {
  return db.select().from(variants).where(eq(variants.id, variantId)).get();
}
