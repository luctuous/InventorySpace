import { z } from 'zod';
import { auditFieldsSchema, translatedTextSchema } from './common';

export const variantSchema = z.object({
  id: z.uuid(),
  humanId: z.string(), // VAR001
  analogousId: z.uuid(),
  conceptId: z.uuid(), // denormalized — synced when analogousId changes
  typeId: z.uuid(),
  name: translatedTextSchema,
  brand: z.string().nullable(),
  supplier: z.string().nullable(),
  catalogRef: z.string().nullable(),
  format: z.string().nullable(),
  packSize: z.number().positive().nullable(),
  packUnit: z.string().nullable(),
  purity: z.string().nullable(),
  concentration: z.string().nullable(),
  notes: z.string().nullable(),
  ...auditFieldsSchema.shape,
});
export type Variant = z.infer<typeof variantSchema>;

// conceptId is derived server-side from the chosen analogous — never sent.
export const variantCreateSchema = variantSchema
  .omit({
    id: true,
    humanId: true,
    conceptId: true,
    createdAt: true,
    updatedAt: true,
    deletedAt: true,
  })
  .extend({
    brand: z.string().nullish(),
    supplier: z.string().nullish(),
    catalogRef: z.string().nullish(),
    format: z.string().nullish(),
    packSize: z.number().positive().nullish(),
    packUnit: z.string().nullish(),
    purity: z.string().nullish(),
    concentration: z.string().nullish(),
    notes: z.string().nullish(),
  });
export type VariantCreate = z.infer<typeof variantCreateSchema>;

// Changing analogousId triggers THE denormalization sync.
export const variantUpdateSchema = variantCreateSchema.partial();
export type VariantUpdate = z.infer<typeof variantUpdateSchema>;
