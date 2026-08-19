import { z } from 'zod';
import { FIELD_KINDS, ITEM_STATUSES } from '../constants';
import { auditFieldsSchema, translatedTextSchema } from './common';

export const fieldDefinitionSchema = z.object({
  // Immutable once saved — it is the key inside Item.customFields JSON.
  key: z.string().regex(/^[a-z][a-zA-Z0-9_]*$/, 'lowerCamel or snake, starts with a letter'),
  label: translatedTextSchema,
  kind: z.enum(FIELD_KINDS),
  required: z.boolean().default(false),
  unit: z.string().optional(), // number kind only
  options: z.array(z.string().min(1)).optional(), // select kind only
  helpText: translatedTextSchema.optional(),
  order: z.number().int().default(0),
});
export type FieldDefinition = z.infer<typeof fieldDefinitionSchema>;

export const typeSchema = z.object({
  id: z.uuid(),
  key: z.string().regex(/^[a-z][a-z0-9_-]*$/), // slug, immutable
  name: translatedTextSchema,
  humanIdPrefix: z.string().regex(/^[a-z][a-z0-9]*$/),
  validStatuses: z.array(z.enum(ITEM_STATUSES)).min(1),
  tracksQuantity: z.boolean(),
  /**
   * Whether running out of this is worth a warning. Instruments and documents
   * say no: they are Items with Concepts underneath so they can still be
   * bought, but they do not belong on the stock screen.
   */
  countsAsStock: z.boolean().default(true),
  fieldDefinitions: z.array(fieldDefinitionSchema),
  ...auditFieldsSchema.shape,
});
export type Type = z.infer<typeof typeSchema>;

export const typeCreateSchema = typeSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
});
export type TypeCreate = z.infer<typeof typeCreateSchema>;

// key is immutable after creation.
export const typeUpdateSchema = typeCreateSchema
  .omit({ key: true })
  .partial()
  .extend({
    /**
     * Renaming a field's key would orphan the values already stored under the
     * old key in every Item.customFields. Send the mapping here instead and
     * the server migrates the existing data in the same transaction.
     * `{ "oldKey": "newKey" }`
     */
    fieldKeyRenames: z.record(z.string(), z.string()).optional(),
  });
export type TypeUpdate = z.infer<typeof typeUpdateSchema>;

/**
 * Builds a Zod validator AT RUNTIME from a Type's field definitions, so
 * user-defined custom fields get real validation.
 *
 * Loose object: keys from removed field definitions stay in old Items'
 * customFields — that legacy data is harmless and must not fail validation.
 */
export function buildCustomFieldsValidator(defs: FieldDefinition[]) {
  const shape: Record<string, z.ZodType> = {};
  for (const def of defs) {
    let field: z.ZodType;
    switch (def.kind) {
      case 'text':
        field = z.string();
        break;
      case 'number':
        field = z.number();
        break;
      case 'date':
        field = z.iso.date(); // YYYY-MM-DD
        break;
      case 'boolean':
        field = z.boolean();
        break;
      case 'select':
        field =
          def.options && def.options.length > 0
            ? z.enum(def.options as [string, ...string[]])
            : z.string();
        break;
    }
    shape[def.key] = def.required ? field : field.nullish();
  }
  return z.looseObject(shape);
}
