import { z } from 'zod';
import { translatedTextSchema } from './common';

// Forecast. A forecast that produces a chart is useless —
// the surface is a list of things about to run out, with one button that turns
// the whole list into Requests. That closes the loop and makes the cycle
// circular.

/** Where the consumption figure came from, shown to the user verbatim. */
export const RATE_SOURCES = ['measured', 'seeded', 'none'] as const;
export type RateSource = (typeof RATE_SOURCES)[number];

export const consumptionRateSchema = z.object({
  conceptId: z.uuid(),
  conceptName: translatedTextSchema,
  conceptHumanId: z.string(),
  unit: z.string(),
  trackingLevel: z.union([z.literal(1), z.literal(2), z.literal(3)]),

  /** What the user typed before any history existed. Never overwritten. */
  seededMonthlyRate: z.number().nullable(),
  /**
   * Measured from real depletion events only. Actions sharpen the
   * picture between depletions but are never the signal — so the forecast
   * works even if nobody records a single action.
   */
  measuredMonthlyRate: z.number().nullable(),
  /** Which of the two is actually being used, and why. */
  source: z.enum(RATE_SOURCES),
  monthlyRate: z.number().nullable(),

  // The working, shown rather than hidden: "4 bottles in 90 days".
  depletionsObserved: z.number().int(),
  observedDays: z.number().int(),
  quantityConsumed: z.number(),

  /** With three depletions in three months you cannot forecast anything. */
  confident: z.boolean(),

  /**
   * Consumption that no activity claimed, per day a container was open
   *. Spread over days rather than over the activities in the window:
   * you do not know it was the activities, but you do know how long the bottle
   * stood open. Null until at least one container has been closed.
   */
  overheadPerDay: z.number().nullable(),
});
export type ConsumptionRate = z.infer<typeof consumptionRateSchema>;

export const forecastRowSchema = consumptionRateSchema.extend({
  /**
   * A Concept has no Type of its own — its items do. This is the Type most of
   * them carry, which is what lets you prepare an order of only consumables,
   * or ask "am I running out of supplies" without reading the whole list.
   */
  typeId: z.uuid().nullable(),
  typeName: translatedTextSchema.nullable(),
  currentStock: z.number(),
  /** stock ÷ rate. Null when there is no usable rate. */
  daysRemaining: z.number().nullable(),
  runsOutAt: z.iso.datetime().nullable(),
  /** Learned from this concept's own lots: ordered date → received date. */
  leadDays: z.number().nullable(),
  leadSource: z.enum(['measured', 'default']),
  /** daysRemaining < leadDays: it runs out before a reorder could arrive. */
  reorderNow: z.boolean(),
  /** How much to ask for: roughly two months of use, rounded up. */
  suggestedQuantity: z.number().nullable(),
  openRequestId: z.uuid().nullable(),
});
export type ForecastRow = z.infer<typeof forecastRowSchema>;

export const forecastResponseSchema = z.object({
  rows: z.array(forecastRowSchema),
  defaultLeadDays: z.number().int(),
  generatedAt: z.iso.datetime(),
});
export type ForecastResponse = z.infer<typeof forecastResponseSchema>;

/** "Request all" — the one button the whole screen exists for. */
export const requestAllSchema = z.object({
  conceptIds: z.array(z.uuid()).min(1),
});
export type RequestAll = z.infer<typeof requestAllSchema>;

export const requestAllResultSchema = z.object({
  created: z.number().int(),
  joined: z.number().int(), // added a +1 to someone else's open request
  humanIds: z.array(z.string()),
});
export type RequestAllResult = z.infer<typeof requestAllResultSchema>;
