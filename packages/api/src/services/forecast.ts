import { and, eq, gte, isNotNull, isNull, sql } from 'drizzle-orm';
import type {
  ConsumptionRate,
  ForecastRow,
  TrackingLevel,
  TranslatedText,
} from '@inventory/shared';
import { db } from '../db/client';
import { concepts, items, types } from '../db/schema';
import { overheadDailyByConcept } from './actions';
import { leadDaysForConcept } from './purchasing';
import { stockByConcept } from './stock';

// Consumption rate and forecast.
//
// THE signal is real depletion events — never recorded actions. Actions sharpen
// the picture between depletions but are not the measurement, which is why the
// forecast works even if nobody ever records a single action, and improves if
// they do.

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 90; // rolling three months
export const DEFAULT_LEAD_DAYS = 14;

/** Below this, the honest answer is "not enough history yet". */
const MIN_DEPLETIONS_FOR_CONFIDENCE = 2;

interface DepletionStats {
  count: number;
  quantity: number;
  firstAt: Date | null;
}

function depletionsInWindow(since: Date): Map<string, DepletionStats> {
  const rows = db
    .select({
      conceptId: items.conceptId,
      // A container that tracks quantity contributes what it held; one that
      // does not contributes one unit.
      quantity: sql<number>`sum(coalesce(${items.quantityInitial}, 1))`,
      n: sql<number>`count(*)`,
      firstAt: sql<number>`min(${items.depletedAt})`,
    })
    .from(items)
    .where(
      and(
        eq(items.status, 'depleted'),
        isNotNull(items.depletedAt),
        isNotNull(items.conceptId),
        gte(items.depletedAt, since),
        isNull(items.deletedAt),
      ),
    )
    .groupBy(items.conceptId)
    .all();

  const map = new Map<string, DepletionStats>();
  for (const row of rows) {
    map.set(row.conceptId!, {
      count: Number(row.n),
      quantity: Number(row.quantity ?? 0),
      firstAt: row.firstAt ? new Date(Number(row.firstAt) * 1000) : null,
    });
  }
  return map;
}

type ConceptRow = typeof concepts.$inferSelect;

function rateFor(
  concept: ConceptRow,
  stats: DepletionStats | undefined,
  now: Date,
  overheadPerDay: number | null = null,
): ConsumptionRate {
  const ageDays = Math.max(
    1,
    Math.round((now.getTime() - concept.createdAt.getTime()) / DAY_MS),
  );
  const observedDays = Math.min(WINDOW_DAYS, ageDays);

  const count = stats?.count ?? 0;
  const quantity = stats?.quantity ?? 0;
  const measured = count > 0 ? (quantity / observedDays) * 30 : null;
  const confident = count >= MIN_DEPLETIONS_FOR_CONFIDENCE;

  // Measurement takes over as soon as there is any, but the seed is kept and
  // shown beside it — that moment is when the user starts trusting the app.
  let source: ConsumptionRate['source'] = 'none';
  let monthlyRate: number | null = null;
  if (measured !== null && confident) {
    source = 'measured';
    monthlyRate = measured;
  } else if (concept.seededMonthlyRate !== null) {
    source = 'seeded';
    monthlyRate = concept.seededMonthlyRate;
  } else if (measured !== null) {
    source = 'measured';
    monthlyRate = measured;
  }

  return {
    conceptId: concept.id,
    conceptName: concept.name,
    conceptHumanId: concept.humanId,
    unit: concept.unit,
    trackingLevel: concept.trackingLevel as TrackingLevel,
    seededMonthlyRate: concept.seededMonthlyRate,
    measuredMonthlyRate: measured === null ? null : Math.round(measured * 100) / 100,
    source,
    monthlyRate: monthlyRate === null ? null : Math.round(monthlyRate * 100) / 100,
    depletionsObserved: count,
    observedDays,
    quantityConsumed: Math.round(quantity * 100) / 100,
    confident,
    overheadPerDay,
  };
}

export function consumptionRates(now = new Date()): ConsumptionRate[] {
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
  const stats = depletionsInWindow(since);
  const overhead = overheadDailyByConcept();
  const rows = db
    .select()
    .from(concepts)
    .where(isNull(concepts.deletedAt))
    .orderBy(concepts.humanId)
    .all();
  return rows.map((concept) =>
    rateFor(concept, stats.get(concept.id), now, overhead.get(concept.id)?.perDay ?? null),
  );
}

export function consumptionRateFor(
  conceptId: string,
  now = new Date(),
): ConsumptionRate | null {
  const concept = db
    .select()
    .from(concepts)
    .where(and(eq(concepts.id, conceptId), isNull(concepts.deletedAt)))
    .get();
  if (!concept) return null;
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
  return rateFor(
    concept,
    depletionsInWindow(since).get(conceptId),
    now,
    overheadDailyByConcept().get(conceptId)?.perDay ?? null,
  );
}

/**
 * The Type most of a Concept's live items carry. Concepts have no Type of
 * their own, so this is derived — one query for all of them rather than one
 * per row, because the forecast walks every concept in the workshop.
 */
function dominantTypeByConcept(): Map<string, { id: string; name: TranslatedText }> {
  const rows = db
    .select({
      conceptId: items.conceptId,
      typeId: items.typeId,
      typeName: types.name,
      n: sql<number>`count(*)`,
    })
    .from(items)
    .innerJoin(types, eq(items.typeId, types.id))
    .where(and(isNotNull(items.conceptId), isNull(items.deletedAt)))
    .groupBy(items.conceptId, items.typeId)
    .orderBy(sql`count(*) desc`)
    .all();

  const map = new Map<string, { id: string; name: TranslatedText }>();
  for (const row of rows) {
    // Rows arrive most-common-first, so the first one wins.
    if (!row.conceptId || map.has(row.conceptId)) continue;
    map.set(row.conceptId, { id: row.typeId, name: row.typeName });
  }
  return map;
}

/**
 * The forecast list. Not a chart: a list of things that will run out before a
 * reorder could arrive, so the screen can end in one button.
 */
export function forecast(now = new Date()): ForecastRow[] {
  const rates = consumptionRates(now);
  const stocks = stockByConcept();
  const typeByConcept = dominantTypeByConcept();

  // Same rule as Home: a forecast of when the documents run out is not a
  // forecast. Concepts with no items yet stay, because they have simply not
  // been used — only ones whose type says "not stock" drop out.
  const notStock = new Set(
    db
      .select({ id: types.id })
      .from(types)
      .where(eq(types.countsAsStock, false))
      .all()
      .map((row) => row.id),
  );

  return rates
    .filter((rate) => {
      const type = typeByConcept.get(rate.conceptId);
      return !type || !notStock.has(type.id);
    })
    .map((rate) => {
      const currentStock = stocks[rate.conceptId] ?? 0;
      const dailyRate = rate.monthlyRate !== null ? rate.monthlyRate / 30 : null;

      const daysRemaining =
        dailyRate !== null && dailyRate > 0
          ? Math.round((currentStock / dailyRate) * 10) / 10
          : null;

      const measuredLead = leadDaysForConcept(rate.conceptId);
      const leadDays = measuredLead ?? DEFAULT_LEAD_DAYS;

      const suggested =
        rate.monthlyRate !== null
          ? Math.max(Math.ceil(rate.monthlyRate * 2 - currentStock), 1)
          : null;

      const type = typeByConcept.get(rate.conceptId) ?? null;

      return {
        ...rate,
        typeId: type?.id ?? null,
        typeName: type?.name ?? null,
        currentStock: Math.round(currentStock * 100) / 100,
        daysRemaining,
        runsOutAt:
          daysRemaining !== null
            ? new Date(now.getTime() + daysRemaining * DAY_MS).toISOString()
            : null,
        leadDays,
        leadSource: measuredLead !== null ? ('measured' as const) : ('default' as const),
        reorderNow: daysRemaining !== null && daysRemaining <= leadDays,
        suggestedQuantity: suggested,
        openRequestId: null, // filled in by the route, which knows about requests
      };
    });
}
