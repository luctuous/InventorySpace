import { z } from 'zod';
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from '../constants';

// Append-only. History rows are never updated or deleted.
export const historyEntrySchema = z.object({
  id: z.uuid(),
  entityType: z.enum(AUDIT_ENTITIES),
  entityId: z.string(),
  entityHumanId: z.string().nullable(), // denormalized for display
  action: z.enum(AUDIT_ACTIONS),
  fieldChanged: z.string().nullable(),
  valueBefore: z.unknown().nullable(),
  valueAfter: z.unknown().nullable(),
  notes: z.string().nullable(),
  userId: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

export const historyQuerySchema = z.object({
  entityType: z.enum(AUDIT_ENTITIES).optional(),
  entityId: z.string().optional(),
  action: z.enum(AUDIT_ACTIONS).optional(),
  userId: z.string().optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});
export type HistoryQuery = z.infer<typeof historyQuerySchema>;
