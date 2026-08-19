import { z } from 'zod';
import { auditFieldsSchema, translatedTextSchema } from './common';
import {
  POOL_EVENT_KINDS,
  POOL_GRANULARITIES,
  POOL_UNIT_STATES,
} from '../constants';

// Reusable pools. Neither consumables nor assets: they are
// lent out and come back, and the only true consumption is attrition.
// Deliberately NOT individual Items — modelling each mixing cup as an Item of
// quantity 1 implies an identity nobody maintains.

export const poolSchema = z.object({
  id: z.uuid(),
  humanId: z.string(), // POO001
  name: translatedTextSchema,
  granularity: z.enum(POOL_GRANULARITIES),
  conceptId: z.uuid().nullable(),
  available: z.number().int(),
  inUse: z.number().int(),
  dirty: z.number().int(),
  /** Does a taken unit sit in an addressable slot? A bench receptacle does not. */
  addressable: z.boolean(),
  slotsPerUnit: z.number().int().nullable(),
  notes: z.string().nullable(),
  ...auditFieldsSchema.shape,
});
export type Pool = z.infer<typeof poolSchema>;

export const poolCreateSchema = z.object({
  name: translatedTextSchema,
  granularity: z.enum(POOL_GRANULARITIES),
  conceptId: z.uuid().nullish(),
  addressable: z.boolean().default(false),
  slotsPerUnit: z.number().int().positive().nullish(),
  /** Pooled granularity only: how many exist right now. */
  initialUnits: z.number().int().nonnegative().default(0),
  notes: z.string().nullish(),
});
export type PoolCreate = z.infer<typeof poolCreateSchema>;

export const poolUpdateSchema = poolCreateSchema
  .omit({ granularity: true, initialUnits: true })
  .partial();
export type PoolUpdate = z.infer<typeof poolUpdateSchema>;

export const poolWithStatsSchema = poolSchema.extend({
  total: z.number().int(),
  unitCount: z.number().int(),
  openOccupancies: z.number().int(),
  /** Units lost per 30 days, measured by recounts — this is what reaches buying. */
  attritionPerMonth: z.number().nullable(),
  lastRecountAt: z.iso.datetime().nullable(),
});
export type PoolWithStats = z.infer<typeof poolWithStatsSchema>;

// --------------------------------------------------------------------- units

export const poolUnitSchema = z.object({
  id: z.uuid(),
  poolId: z.uuid(),
  code: z.string(),
  state: z.enum(POOL_UNIT_STATES),
  locationId: z.uuid().nullable(),
  locationCode: z.string().nullable(),
  occupancyCount: z.number().int(),
  ...auditFieldsSchema.shape,
});
export type PoolUnit = z.infer<typeof poolUnitSchema>;

export const poolUnitCreateSchema = z.object({
  code: z.string().min(1),
  locationId: z.uuid().nullish(),
});
export type PoolUnitCreate = z.infer<typeof poolUnitCreateSchema>;

export const poolUnitStateSchema = z.object({
  state: z.enum(POOL_UNIT_STATES),
  locationId: z.uuid().nullish(),
});
export type PoolUnitStateChange = z.infer<typeof poolUnitStateSchema>;

// -------------------------------------------------------------------- events

export const poolEventCreateSchema = z.object({
  kind: z.enum(POOL_EVENT_KINDS),
  quantity: z.number().int().positive().default(1),
  unitId: z.uuid().nullish(),
  note: z.string().nullish(),
});
export type PoolEventCreate = z.infer<typeof poolEventCreateSchema>;

// ------------------------------------------------------- commissioning
//
// The boxes of unused cups in the cupboard are ORDINARY STOCK. They are
// bought, received and forecast like anything else. Putting some into rotation
// is a move between two places the app already understands: it takes them out
// of stock and into the pool.
//
// This is what closes the loop. Breakage retires units, the pool drains, the
// cupboard drains to refill it, and purchasing sees the whole thing — without
// pools needing any buying logic of their own.

export const poolCommissionSchema = z.object({
  quantity: z.number().int().positive(),
  /** Which container to draw from. Defaults to the oldest with stock in it. */
  itemId: z.uuid().nullish(),
  /**
   * Codes for an identified pool ("4", "5", "6"). Left empty, the app carries
   * on from the highest number already in the pool.
   */
  codes: z.array(z.string().min(1)).optional(),
  note: z.string().nullish(),
});
export type PoolCommission = z.infer<typeof poolCommissionSchema>;

export const poolCommissionResultSchema = z.object({
  commissioned: z.number().int(),
  /** Human ids of the units created, for an identified pool. */
  unitCodes: z.array(z.string()),
  fromItemHumanId: z.string().nullable(),
  /** What is left in the cupboard afterwards, so the screen can say so. */
  stockRemaining: z.number(),
});
export type PoolCommissionResult = z.infer<typeof poolCommissionResultSchema>;

/** What the commission screen needs to know before you press anything. */
export const poolStockSchema = z.object({
  conceptId: z.uuid().nullable(),
  conceptName: translatedTextSchema.nullable(),
  unit: z.string().nullable(),
  /** Unopened stock of that concept: the cupboard. */
  available: z.number(),
  sources: z.array(
    z.object({
      itemId: z.uuid(),
      humanId: z.string(),
      quantity: z.number(),
      locationCode: z.string().nullable(),
    }),
  ),
});
export type PoolStock = z.infer<typeof poolStockSchema>;

export const poolEventSchema = z.object({
  id: z.uuid(),
  poolId: z.uuid(),
  unitId: z.uuid().nullable(),
  unitCode: z.string().nullable(),
  kind: z.enum(POOL_EVENT_KINDS),
  quantity: z.number().int(),
  note: z.string().nullable(),
  userId: z.string().nullable(),
  userName: z.string().nullable(),
  source: z.string(),
  createdAt: z.iso.datetime(),
});
export type PoolEvent = z.infer<typeof poolEventSchema>;

// ------------------------------------------------------------------ recounts

/**
 * The measuring instrument, not housekeeping. The difference between
 * what the app expected and what you counted IS the attrition — which is why
 * nobody ever has to report a breakage.
 */
export const recountCreateSchema = z.object({
  counted: z.number().int().nonnegative(),
  note: z.string().nullish(),
});
export type RecountCreate = z.infer<typeof recountCreateSchema>;

export const recountSchema = z.object({
  id: z.uuid(),
  poolId: z.uuid(),
  expected: z.number().int(),
  counted: z.number().int(),
  attrition: z.number().int(),
  note: z.string().nullable(),
  userId: z.string().nullable(),
  userName: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type Recount = z.infer<typeof recountSchema>;

// --------------------------------------------------------------- occupancies

/**
 * A kit has no location of its own. This row IS the kit's
 * whereabouts: move the tray and forty kits move with it, zero rows updated.
 */
export const occupancySchema = z.object({
  id: z.uuid(),
  unitId: z.uuid(),
  unitCode: z.string(),
  poolId: z.uuid(),
  poolName: translatedTextSchema,
  position: z.string().nullable(),
  sampleTag: z.string(),
  openedAt: z.iso.datetime(),
  closedAt: z.iso.datetime().nullable(),
  /** Walked up the chain, never stored on the kit. */
  locationCode: z.string().nullable(),
  unitState: z.enum(POOL_UNIT_STATES),
});
export type Occupancy = z.infer<typeof occupancySchema>;

export const occupancyCreateSchema = z.object({
  unitId: z.uuid(),
  sampleTag: z.string().min(1),
  position: z.string().nullish(),
});
export type OccupancyCreate = z.infer<typeof occupancyCreateSchema>;
