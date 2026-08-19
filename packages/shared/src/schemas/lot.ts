import { z } from 'zod';
import { auditFieldsSchema, currencySchema, translatedTextSchema } from './common';
import { LOT_LINE_STATUSES, LOT_STATUSES } from '../constants';

// A Lot is one order to one supplier, assembled by triaging open Requests
//.

// A supplier is an entity, so that "Corvid" and "Corvid" cannot be two
// different histories of the same shop.
export const supplierSchema = z.object({
  id: z.uuid(),
  humanId: z.string(), // SUP001
  name: z.string(),
  notes: z.string().nullable(),
  ...auditFieldsSchema.shape,
});
export type Supplier = z.infer<typeof supplierSchema>;

export const supplierCreateSchema = z.object({
  name: z.string().min(1).max(120),
  notes: z.string().nullish(),
});
export type SupplierCreate = z.infer<typeof supplierCreateSchema>;

export const lotSchema = z.object({
  id: z.uuid(),
  humanId: z.string(), // LOT001
  supplierId: z.uuid().nullable(),
  supplierName: z.string().nullable(),
  reference: z.string().nullable(),
  status: z.enum(LOT_STATUSES),
  orderedAt: z.iso.datetime().nullable(),
  receivedAt: z.iso.datetime().nullable(),
  notes: z.string().nullable(),
  createdBy: z.string().nullable(),
  ...auditFieldsSchema.shape,
});
export type Lot = z.infer<typeof lotSchema>;

/**
 * Creating a lot asks for the supplier and nothing else. The order reference
 * does not exist yet — you get it from the shop after placing the order, which
 * is why it belongs to the "mark as ordered" step (lotOrderSchema below).
 */
export const lotCreateSchema = z.object({
  supplierId: z.uuid().nullish(),
  /** Or name a new supplier inline, exactly like Quick Add does. */
  newSupplierName: z.string().min(1).max(120).nullish(),
  notes: z.string().nullish(),
});
export type LotCreate = z.infer<typeof lotCreateSchema>;

export const lotUpdateSchema = lotCreateSchema
  .extend({ reference: z.string().nullish() })
  .partial();
export type LotUpdate = z.infer<typeof lotUpdateSchema>;

/** Placing the order: now — and only now — there can be a reference. */
export const lotOrderSchema = z.object({
  reference: z.string().max(120).nullish(),
});
export type LotOrder = z.infer<typeof lotOrderSchema>;

// ---------------------------------------------------------------------------
// Lines. Two sides, never overwritten.
// ---------------------------------------------------------------------------

export const lotLineSchema = z.object({
  id: z.uuid(),
  lotId: z.uuid(),
  conceptId: z.uuid(),
  // — ordered —
  orderedVariantId: z.uuid(),
  orderedQuantity: z.number().positive(),
  unitPriceAmount: z.number().int().nonnegative().nullable(), // minor units
  priceCurrency: z.string().nullable(),
  // — received —
  receivedVariantId: z.uuid().nullable(),
  receivedQuantity: z.number().nonnegative(),
  status: z.enum(LOT_LINE_STATUSES),
  expiryDate: z.iso.datetime().nullable(),
  locationId: z.uuid().nullable(),
  notes: z.string().nullable(),
  ...auditFieldsSchema.shape,
});
export type LotLine = z.infer<typeof lotLineSchema>;

// The fields, before the create-only rule below. `lotLineUpdateSchema` needs a
// plain object to `.omit()` from, and a refinement is not one.
const lotLineFieldsSchema = z
  .object({
    conceptId: z.uuid(),
    /** An existing product. Leave out to name a new one instead. */
    orderedVariantId: z.uuid().optional(),
    /**
     * Naming the product on the spot.
     *
     * Requests are made at Concept level on purpose — the person who needs
     * wood glue must not have to know which brand. But a Concept
     * nobody has ever ordered has no Variants under it at all, and a buyer who
     * has just decided to order the 1 L Northline bottle has nowhere to put that
     * decision. Without this the first order for any new Concept is
     * impossible: the form asks you to pick from an empty list.
     *
     * Same find-or-create shape as Quick Add and as receiving a
     * substitute — created inside the line's own transaction, so the Variant
     * cannot survive a line that failed to save.
     */
    newVariantName: z.string().min(1).max(200).optional(),
    /** Required with `newVariantName` when the concept has nothing to copy from. */
    newVariantTypeId: z.uuid().optional(),
    newVariantPackSize: z.number().positive().nullish(),
    newVariantPackUnit: z.string().max(20).nullish(),
    newVariantBrand: z.string().max(120).nullish(),
    orderedQuantity: z.number().positive(),
    /** Decimal string ("34.50") — parsed to minor units server-side. */
    unitPrice: z.string().optional(),
    priceCurrency: currencySchema.optional(),
    locationId: z.uuid().nullish(),
    notes: z.string().nullish(),
    /** Requests this line satisfies; they follow the lot's status from here on. */
    requestIds: z.array(z.uuid()).default([]),
  });

export const lotLineCreateSchema = lotLineFieldsSchema.refine(
  (line) => Boolean(line.orderedVariantId) !== Boolean(line.newVariantName),
  'Give either an existing product or a name for a new one, not both',
);
export type LotLineCreate = z.infer<typeof lotLineCreateSchema>;

export const lotLineUpdateSchema = lotLineFieldsSchema
  .omit({
    conceptId: true,
    requestIds: true,
    newVariantName: true,
    newVariantTypeId: true,
    newVariantPackSize: true,
    newVariantPackUnit: true,
    newVariantBrand: true,
  })
  .partial();
export type LotLineUpdate = z.infer<typeof lotLineUpdateSchema>;

export const lotLineWithRefsSchema = lotLineSchema.extend({
  conceptName: translatedTextSchema,
  conceptUnit: z.string(),
  orderedVariantName: translatedTextSchema,
  orderedVariantPackSize: z.number().nullable(),
  orderedVariantPackUnit: z.string().nullable(),
  receivedVariantName: translatedTextSchema.nullable(),
  locationCode: z.string().nullable(),
  requestCount: z.number().int(),
  itemsCreated: z.number().int(),
  /** Percentage change against the previous purchase of this variant. */
  priceDeltaPercent: z.number().nullable(),
  lastPriceAmount: z.number().int().nullable(),
});
export type LotLineWithRefs = z.infer<typeof lotLineWithRefsSchema>;

export const lotWithLinesSchema = lotSchema.extend({
  lines: z.array(lotLineWithRefsSchema),
  totalAmount: z.number().int(),
  currency: z.string().nullable(),
  /** Ordered vs received, summarised for the list ( discrepancies). */
  discrepancies: z.number().int(),
});
export type LotWithLines = z.infer<typeof lotWithLinesSchema>;

// ---------------------------------------------------------------------------
// Reception — the payoff. Creates the Items automatically.
// ---------------------------------------------------------------------------

export const receiveLineSchema = z.object({
  lineId: z.uuid(),
  quantity: z.number().nonnegative(),
  /** Defaults to the ordered variant; set when the supplier substituted. */
  receivedVariantId: z.uuid().optional(),
  /** Or create the substitute inline, exactly like Quick Add does. */
  newVariantName: z.string().optional(),
  locationId: z.uuid().optional(),
  expiryDate: z.iso.datetime().optional(),
  batchNumber: z.string().optional(),
  /** Give up on the remainder: "this will never come". */
  closeRemainder: z.boolean().default(false),
});
export type ReceiveLine = z.infer<typeof receiveLineSchema>;

export const receiveSchema = z.object({
  lines: z.array(receiveLineSchema).min(1),
});
export type Receive = z.infer<typeof receiveSchema>;

export const receiveResultSchema = z.object({
  itemsCreated: z.number().int(),
  itemIds: z.array(z.uuid()),
  lotStatus: z.enum(LOT_STATUSES),
  discrepancies: z.array(
    z.object({
      lineId: z.uuid(),
      kind: z.enum(['short', 'over', 'substituted']),
      detail: z.string(),
    }),
  ),
});
export type ReceiveResult = z.infer<typeof receiveResultSchema>;

// ---------------------------------------------------------------------------
// Supplier performance — accumulated discrepancies are data, not error
// handling. Lead time feeds the forecast with nothing to configure.
// ---------------------------------------------------------------------------

export const supplierStatsSchema = z.object({
  supplierId: z.uuid(),
  supplier: z.string(),
  lots: z.number().int(),
  lines: z.number().int(),
  shortLines: z.number().int(),
  substitutedLines: z.number().int(),
  shortRate: z.number(), // 0..1
  avgLeadDays: z.number().nullable(),
});
export type SupplierStats = z.infer<typeof supplierStatsSchema>;

/** Price history for one Variant, straight out of its purchased lot lines. */
export const priceHistoryPointSchema = z.object({
  date: z.iso.datetime(),
  amount: z.number().int(),
  currency: z.string(),
  lotHumanId: z.string(),
  supplier: z.string().nullable(),
});
export type PriceHistoryPoint = z.infer<typeof priceHistoryPointSchema>;
