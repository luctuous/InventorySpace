import { z } from 'zod';
import { auditFieldsSchema, translatedTextSchema } from './common';
import { TRACKING_LEVELS } from '../constants';

export const trackingLevelSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

export const conceptSchema = z.object({
  id: z.uuid(),
  humanId: z.string(), // CON001 — generated server-side
  name: translatedTextSchema,
  unit: z.string().min(1), // functional unit: L, box, unit…
  minStockThreshold: z.number().nonnegative().nullable(),
  notes: z.string().nullable(),
  /**
   * How closely this Concept is tracked. A property of the
   * Concept, never a global mode — a workshop runs all three at once.
   *   1 manual · 2 seeded rate superseded by measurement · 3 actions + maps
   */
  trackingLevel: trackingLevelSchema,
  /** The level-2 bootstrap. Never overwritten by measurement. */
  seededMonthlyRate: z.number().nonnegative().nullable(),
  ...auditFieldsSchema.shape,
});
export type Concept = z.infer<typeof conceptSchema>;

export const conceptCreateSchema = conceptSchema
  .omit({ id: true, humanId: true, createdAt: true, updatedAt: true, deletedAt: true })
  .extend({
    minStockThreshold: z.number().nonnegative().nullish(),
    notes: z.string().nullish(),
    trackingLevel: trackingLevelSchema.default(1),
    seededMonthlyRate: z.number().nonnegative().nullish(),
  });
export type ConceptCreate = z.infer<typeof conceptCreateSchema>;

export const conceptUpdateSchema = conceptCreateSchema.partial();
export type ConceptUpdate = z.infer<typeof conceptUpdateSchema>;

// List/detail rows carry computed stock (never stored).
export const conceptWithStockSchema = conceptSchema.extend({
  stock: z.number(),
  analogousCount: z.number().int(),
});
export type ConceptWithStock = z.infer<typeof conceptWithStockSchema>;
