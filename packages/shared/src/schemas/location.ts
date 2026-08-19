import { z } from 'zod';
import { LOCATION_LEVELS } from '../constants';
import { auditFieldsSchema, translatedTextSchema } from './common';

export const locationSchema = z.object({
  id: z.uuid(),
  code: z.string().regex(/^L\d{2}(R\d{2}(Z\d{2}(S\d{2})?)?)?$/), // L01R02Z03S01
  level: z.enum(LOCATION_LEVELS),
  name: translatedTextSchema.nullable(), // display name: "Solvent Cabinet"
  parentId: z.uuid().nullable(), // null = root (workshop)
  ...auditFieldsSchema.shape,
});
export type Location = z.infer<typeof locationSchema>;

export const locationCreateSchema = locationSchema
  .omit({ id: true, createdAt: true, updatedAt: true, deletedAt: true })
  .extend({
    name: translatedTextSchema.nullish(),
    parentId: z.uuid().nullish(),
  });
export type LocationCreate = z.infer<typeof locationCreateSchema>;

export const locationUpdateSchema = locationCreateSchema.partial();
export type LocationUpdate = z.infer<typeof locationUpdateSchema>;
