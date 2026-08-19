import { z } from 'zod';
import { auditFieldsSchema, translatedTextSchema } from './common';
import { REQUEST_STATUSES, REQUEST_URGENCIES } from '../constants';

// A Request is a functional demand at Concept level, with no purchasing
// decision in it. The person who needs wood glue must not have
// to know which brand — that is what the Concept level is for.

export const requestSchema = z.object({
  id: z.uuid(),
  humanId: z.string(), // REQ001
  conceptId: z.uuid(),
  quantity: z.number().positive(),
  unit: z.string().nullable(),
  urgency: z.enum(REQUEST_URGENCIES),
  /** A suggestion to the buyer ("the Corvid one works better"), never a decision. */
  hintVariantId: z.uuid().nullable(),
  note: z.string().nullable(),
  status: z.enum(REQUEST_STATUSES),
  lotLineId: z.uuid().nullable(),
  requestedBy: z.string().nullable(),
  ...auditFieldsSchema.shape,
});
export type Request = z.infer<typeof requestSchema>;

export const requestCreateSchema = z.object({
  conceptId: z.uuid(),
  quantity: z.number().positive(),
  unit: z.string().nullish(),
  urgency: z.enum(REQUEST_URGENCIES).default('normal'),
  hintVariantId: z.uuid().nullish(),
  note: z.string().nullish(),
});
export type RequestCreate = z.infer<typeof requestCreateSchema>;

export const requestUpdateSchema = requestCreateSchema.partial().omit({ conceptId: true });
export type RequestUpdate = z.infer<typeof requestUpdateSchema>;

/** List rows carry enough to triage without a second call. */
export const requestWithRefsSchema = requestSchema.extend({
  conceptName: translatedTextSchema,
  conceptHumanId: z.string(),
  conceptUnit: z.string(),
  hintVariantName: translatedTextSchema.nullable(),
  requesterName: z.string().nullable(),
  /** Everyone who has said "me too". A +1 is better data than a duplicate. */
  supporters: z.array(z.object({ userId: z.string(), name: z.string().nullable() })),
  lotHumanId: z.string().nullable(),
  lotStatus: z.string().nullable(),
  currentStock: z.number(),
});
export type RequestWithRefs = z.infer<typeof requestWithRefsSchema>;

/**
 * Answered before a new request is written: if someone already asked for this
 * Concept, offer to add a +1 instead of creating a duplicate row.
 */
export const existingRequestSchema = z.object({
  request: requestWithRefsSchema.nullable(),
});
export type ExistingRequest = z.infer<typeof existingRequestSchema>;
