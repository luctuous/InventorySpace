import { z } from 'zod';
import { ITEM_STATUSES } from '../constants';
import { auditFieldsSchema, currencySchema } from './common';

export const itemSchema = z.object({
  id: z.uuid(),
  humanId: z.string(), // supplyAA001 — generated server-side
  typeId: z.uuid(),
  variantId: z.uuid().nullable(), // standalone items allowed
  analogousId: z.uuid().nullable(), // denormalized
  conceptId: z.uuid().nullable(), // denormalized
  locationId: z.uuid().nullable(),
  status: z.enum(ITEM_STATUSES),
  quantityInitial: z.number().nonnegative().nullable(),
  quantityRemaining: z.number().nonnegative().nullable(),
  unit: z.string().nullable(),
  priceAmount: z.number().int().nonnegative().nullable(), // minor units. NEVER float.
  priceCurrency: currencySchema.nullable(),
  priceLocked: z.boolean(),
  serialNumber: z.string().nullable(),
  batchNumber: z.string().nullable(),
  customFields: z.record(z.string(), z.unknown()), // validated per-Type at runtime
  receivedAt: z.iso.datetime().nullable(),
  openedAt: z.iso.datetime().nullable(),
  depletedAt: z.iso.datetime().nullable(),
  notes: z.string().nullable(),
  createdBy: z.string().nullable(), // better-auth user id (not a uuid)
  ...auditFieldsSchema.shape,
});
export type Item = z.infer<typeof itemSchema>;

export const itemCreateSchema = z.object({
  typeId: z.uuid(),
  variantId: z.uuid().nullish(),
  locationId: z.uuid().nullish(),
  status: z.enum(ITEM_STATUSES).nullish(), // defaults server-side to the Type's first valid status
  quantityInitial: z.number().nonnegative().nullish(),
  unit: z.string().nullish(),
  priceAmount: z.number().int().nonnegative().nullish(),
  priceCurrency: currencySchema.nullish(),
  serialNumber: z.string().nullish(),
  batchNumber: z.string().nullish(),
  customFields: z.record(z.string(), z.unknown()).nullish(),
  receivedAt: z.iso.datetime().nullish(),
  notes: z.string().nullish(),
  copies: z.number().int().min(1).max(100).default(1), // "3 identical bottles arrive"
});
export type ItemCreate = z.infer<typeof itemCreateSchema>;

// status is NOT patchable — status changes go through action endpoints only
//. humanId / denormalized ids are server-managed.
export const itemUpdateSchema = z
  .object({
    variantId: z.uuid().nullish(),
    locationId: z.uuid().nullish(),
    quantityInitial: z.number().nonnegative().nullish(),
    unit: z.string().nullish(),
    priceAmount: z.number().int().nonnegative().nullish(),
    priceCurrency: currencySchema.nullish(),
    serialNumber: z.string().nullish(),
    batchNumber: z.string().nullish(),
    customFields: z.record(z.string(), z.unknown()).nullish(),
    receivedAt: z.iso.datetime().nullish(),
    notes: z.string().nullish(),
  })
  .partial();
export type ItemUpdate = z.infer<typeof itemUpdateSchema>;

// Action endpoint bodies
export const itemMoveSchema = z.object({ locationId: z.uuid() });
export const itemAdjustSchema = z.object({
  quantityRemaining: z.number().nonnegative(),
  note: z.string().min(1), // a required note is the point of "adjust"
});
export const itemStatusSchema = z.object({ status: z.enum(ITEM_STATUSES) });

// Quick Add: one small form; server find-or-creates the chain.
export const quickAddSchema = z.object({
  name: z.string().min(1),
  typeId: z.uuid(),
  locationId: z.uuid().nullish(),
  quantity: z.number().nonnegative().nullish(),
  unit: z.string().nullish(),
  priceAmount: z.number().int().nonnegative().nullish(),
  priceCurrency: currencySchema.nullish(),
  copies: z.number().int().min(1).max(100).default(1),
  existingVariantId: z.uuid().nullish(), // typeahead pick → skip chain creation
  customFields: z.record(z.string(), z.unknown()).nullish(),
});
export type QuickAdd = z.infer<typeof quickAddSchema>;
