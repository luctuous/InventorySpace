import { z } from 'zod';
import { auditFieldsSchema, translatedTextSchema } from './common';

export const analogousSchema = z.object({
  id: z.uuid(),
  humanId: z.string(), // ANA001
  conceptId: z.uuid(),
  name: translatedTextSchema,
  notes: z.string().nullable(),
  ...auditFieldsSchema.shape,
});
export type Analogous = z.infer<typeof analogousSchema>;

export const analogousCreateSchema = analogousSchema
  .omit({ id: true, humanId: true, createdAt: true, updatedAt: true, deletedAt: true })
  .extend({ notes: z.string().nullish() });
export type AnalogousCreate = z.infer<typeof analogousCreateSchema>;

// Changing conceptId triggers the denormalization mass-update.
export const analogousUpdateSchema = analogousCreateSchema.partial();
export type AnalogousUpdate = z.infer<typeof analogousUpdateSchema>;
