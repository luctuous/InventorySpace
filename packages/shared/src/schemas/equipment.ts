import { z } from 'zod';
import { auditFieldsSchema, translatedTextSchema } from './common';
import { ITEM_RELATIONS, MAINTENANCE_KINDS } from '../constants';

// Equipment. An instrument is an Item like any other, but it
// is the one kind that other Items hang off — its manual, its calibration
// certificate, the spare torch in the drawer — and the one that needs looking
// after on a schedule.
//
// Both are modelled generically rather than as instrument-only features: a
// cupboard has a service interval, a torque wrench has a calibration certificate, and
// the list of things a workshop hangs off a machine is not knowable in advance.

// ------------------------------------------------------------------- links

export const itemLinkSchema = z.object({
  id: z.uuid(),
  parentItemId: z.uuid(),
  childItemId: z.uuid(),
  relation: z.enum(ITEM_RELATIONS),
  notes: z.string().nullable(),
  ...auditFieldsSchema.shape,
});
export type ItemLink = z.infer<typeof itemLinkSchema>;

/**
 * A link seen from one end. `other` is always the item at the far end, so the
 * same shape serves both halves of the drawer — "what hangs off this machine"
 * and "what this manual belongs to" — without two near-identical schemas.
 */
export const itemLinkWithRefsSchema = itemLinkSchema.extend({
  direction: z.enum(['child', 'parent']),
  otherItemId: z.uuid(),
  otherHumanId: z.string(),
  otherName: translatedTextSchema.nullable(),
  otherStatus: z.string(),
  otherTypeName: translatedTextSchema.nullable(),
  otherLocationCode: z.string().nullable(),
});
export type ItemLinkWithRefs = z.infer<typeof itemLinkWithRefsSchema>;

/** Both halves at once: one request per drawer. */
export const itemLinksResponseSchema = z.object({
  /** Things attached to this item — its manual, its spares. */
  children: z.array(itemLinkWithRefsSchema),
  /** The instruments this item is attached to. Usually none, or one. */
  parents: z.array(itemLinkWithRefsSchema),
});
export type ItemLinksResponse = z.infer<typeof itemLinksResponseSchema>;

export const itemLinkCreateSchema = z.object({
  childItemId: z.uuid(),
  relation: z.enum(ITEM_RELATIONS),
  notes: z.string().nullish(),
});
export type ItemLinkCreate = z.infer<typeof itemLinkCreateSchema>;

// ------------------------------------------------------------- maintenance

export const maintenancePlanSchema = z.object({
  id: z.uuid(),
  itemId: z.uuid(),
  name: translatedTextSchema,
  kind: z.enum(MAINTENANCE_KINDS),
  everyDays: z.number().int().positive().nullable(),
  everyUses: z.number().int().positive().nullable(),
  usesSinceLast: z.number().int(),
  lastDoneAt: z.iso.datetime().nullable(),
  nextDueAt: z.iso.datetime().nullable(),
  notes: z.string().nullable(),
  ...auditFieldsSchema.shape,
});
export type MaintenancePlan = z.infer<typeof maintenancePlanSchema>;

export const maintenancePlanWithStatusSchema = maintenancePlanSchema.extend({
  itemHumanId: z.string(),
  itemName: translatedTextSchema.nullable(),
  /** Negative means overdue. Null when the plan counts uses, not days. */
  daysUntilDue: z.number().nullable(),
  /** Uses left before it falls due. Null when the plan counts days. */
  usesUntilDue: z.number().int().nullable(),
  overdue: z.boolean(),
  /** Inside the warning window: worth seeing on Home, not yet late. */
  dueSoon: z.boolean(),
});
export type MaintenancePlanWithStatus = z.infer<typeof maintenancePlanWithStatusSchema>;

/**
 * A plan must count something — days, uses, or both. "Whichever comes first"
 * is the honest reading when both are set: a caliper ages by the calendar, a
 * pillar drill ages by use, and plenty of things age by both.
 */
export const maintenancePlanCreateSchema = z
  .object({
    name: translatedTextSchema,
    kind: z.enum(MAINTENANCE_KINDS).default('service'),
    everyDays: z.number().int().positive().nullish(),
    everyUses: z.number().int().positive().nullish(),
    lastDoneAt: z.iso.datetime().nullish(),
    notes: z.string().nullish(),
  })
  .refine((plan) => plan.everyDays != null || plan.everyUses != null, {
    message: 'Set an interval in days, in uses, or both',
    path: ['everyDays'],
  });
export type MaintenancePlanCreate = z.infer<typeof maintenancePlanCreateSchema>;

export const maintenancePlanUpdateSchema = z.object({
  name: translatedTextSchema.optional(),
  kind: z.enum(MAINTENANCE_KINDS).optional(),
  everyDays: z.number().int().positive().nullish(),
  everyUses: z.number().int().positive().nullish(),
  notes: z.string().nullish(),
});
export type MaintenancePlanUpdate = z.infer<typeof maintenancePlanUpdateSchema>;

/** "Done today." Resets the clock and the use counter, and is never edited. */
export const maintenanceDoneSchema = z.object({
  doneAt: z.iso.datetime().optional(),
  notes: z.string().nullish(),
});
export type MaintenanceDone = z.infer<typeof maintenanceDoneSchema>;

export const maintenanceRecordSchema = z.object({
  id: z.uuid(),
  planId: z.uuid(),
  doneAt: z.iso.datetime(),
  userId: z.string().nullable(),
  userName: z.string().nullable(),
  usesAtService: z.number().int().nullable(),
  notes: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type MaintenanceRecord = z.infer<typeof maintenanceRecordSchema>;

/** Counting a run: from a person, or from the machine controller log that already knows. */
export const maintenanceUsesSchema = z.object({
  uses: z.number().int().positive().default(1),
});
export type MaintenanceUses = z.infer<typeof maintenanceUsesSchema>;
