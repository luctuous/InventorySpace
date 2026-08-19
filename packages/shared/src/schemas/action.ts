import { z } from 'zod';
import { auditFieldsSchema, translatedTextSchema } from './common';

// Level 3: an activity declares what it consumes.
// Recording it charges the OPEN CONTAINER — the quantity moves, because doing
// the same thing by hand would have moved it too. Rule: what it never
// does is close the container. When the map says a bottle should be empty, the
// app raises its hand and a person answers.

export const actionLineSchema = z.object({
  conceptId: z.uuid(),
  quantity: z.number().positive(),
});
export type ActionLine = z.infer<typeof actionLineSchema>;

export const actionSchema = z.object({
  id: z.uuid(),
  humanId: z.string(), // ACT001
  name: translatedTextSchema,
  notes: z.string().nullable(),
  /** The map in force right now. Past recipes live in the version history. */
  lines: z.array(actionLineSchema),
  ...auditFieldsSchema.shape,
});
export type Action = z.infer<typeof actionSchema>;

export const actionCreateSchema = z.object({
  name: translatedTextSchema,
  notes: z.string().nullish(),
  lines: z.array(actionLineSchema).min(1),
});
export type ActionCreate = z.infer<typeof actionCreateSchema>;

/**
 * Editing the map does not mutate history: the current lines are closed with a
 * `validTo` and new ones open from `validFrom`. Otherwise a change in
 * September would silently rewrite March and flatten the cost curve.
 */
export const actionUpdateSchema = z.object({
  name: translatedTextSchema.optional(),
  notes: z.string().nullish(),
  lines: z.array(actionLineSchema).min(1).optional(),
  validFrom: z.iso.datetime().optional(),
});
export type ActionUpdate = z.infer<typeof actionUpdateSchema>;

export const actionWithCostSchema = actionSchema.extend({
  lineDetails: z.array(
    actionLineSchema.extend({
      conceptName: translatedTextSchema,
      conceptUnit: z.string(),
      unitPriceAmount: z.number().int().nullable(),
    }),
  ),
  recordCount: z.number().int(),
  lastRecordedAt: z.iso.datetime().nullable(),
  /** map × price */
  theoreticalCost: z.number().int(),
  /** theoretical + this action's share of unassigned consumption */
  realCost: z.number().int(),
  /** realCost / theoreticalCost — a process-quality metric, e.g. 1.33× */
  costRatio: z.number().nullable(),
  currency: z.string().nullable(),
});
export type ActionWithCost = z.infer<typeof actionWithCostSchema>;

export const actionRecordCreateSchema = z.object({
  actionId: z.uuid(),
  count: z.number().int().positive().default(1),
  occurredAt: z.iso.datetime().optional(),
});
export type ActionRecordCreate = z.infer<typeof actionRecordCreateSchema>;

export const actionRecordSchema = z.object({
  id: z.uuid(),
  actionId: z.uuid(),
  actionName: translatedTextSchema,
  count: z.number().int(),
  occurredAt: z.iso.datetime(),
  userId: z.string().nullable(),
  userName: z.string().nullable(),
  source: z.string(),
  createdAt: z.iso.datetime(),
});
export type ActionRecord = z.infer<typeof actionRecordSchema>;

export const actionRecordResultSchema = z.object({
  recordId: z.uuid(),
  /** Which open containers absorbed the theoretical use, and how much. */
  charged: z.array(
    z.object({
      conceptId: z.uuid(),
      conceptName: translatedTextSchema,
      quantity: z.number(),
      itemId: z.uuid().nullable(),
      itemHumanId: z.string().nullable(),
      /** No open container to charge — the estimate has nowhere to land. */
      unbacked: z.boolean(),
    }),
  ),
  /** "This box should be empty — is it?" The app raises its hand. */
  prompts: z.array(
    z.object({
      itemId: z.uuid(),
      itemHumanId: z.string(),
      conceptName: translatedTextSchema,
      estimatedUsed: z.number(),
      containerQuantity: z.number(),
    }),
  ),
});
export type ActionRecordResult = z.infer<typeof actionRecordResultSchema>;

// ---------------------------------------------------------------------------
// Reconciliation — written when a container closes, and only then.
// ---------------------------------------------------------------------------

export const reconciliationSchema = z.object({
  id: z.uuid(),
  itemId: z.uuid(),
  itemHumanId: z.string().nullable(),
  conceptId: z.uuid(),
  conceptName: translatedTextSchema,
  containerQuantity: z.number(),
  theoreticalUsed: z.number(),
  /**
   * Never called "waste": it does not claim the units were lost, only that no
   * action claimed them. Often it means a map is missing.
   */
  unassigned: z.number(),
  openedAt: z.iso.datetime().nullable(),
  closedAt: z.iso.datetime(),
});
export type Reconciliation = z.infer<typeof reconciliationSchema>;

/** Per-Concept summary of how well the maps match reality. */
export const unassignedSummarySchema = z.object({
  conceptId: z.uuid(),
  conceptName: translatedTextSchema,
  containersClosed: z.number().int(),
  totalHeld: z.number(),
  totalTheoretical: z.number(),
  totalUnassigned: z.number(),
  /** totalHeld / totalTheoretical — "the map says 2 mL, it empties like 3.1". */
  ratio: z.number().nullable(),
  /**
   * The unassigned quantity per day a container was open. Spread over days
   * rather than over the activities in the window, because you do not know it
   * was the activities: this is a measurement, that would be a guess.
   */
  unassignedPerDay: z.number().nullable(),
  /** Total days of open-container time behind that rate. */
  daysOpen: z.number().nullable(),
});
export type UnassignedSummary = z.infer<typeof unassignedSummarySchema>;
