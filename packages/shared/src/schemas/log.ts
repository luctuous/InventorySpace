import { z } from 'zod';
import { auditFieldsSchema } from './common';
import { LOG_LINE_STATUSES, POOL_STATES } from '../constants';

// The log bridge. The machine controller reports facts; the inventory
// interprets them. The channel is one-way and the inventory never answers back.

// ---------------------------------------------------------------------------
// Effects — what an event does. Rule: QUANTITIES LIVE HERE, never in a
// log line. An event that consumes three cups is a different event with its
// own name, because it is a different procedure. This is what makes the whole
// history reprocessable when a map turns out to be wrong.
// ---------------------------------------------------------------------------

const poolEffect = z.object({
  poolId: z.uuid(),
  quantity: z.number().int().positive().default(1),
});

export const logEffectSchema = z.discriminatedUnion('kind', [
  poolEffect.extend({ kind: z.literal('pool_take') }),
  poolEffect.extend({ kind: z.literal('pool_return') }),
  poolEffect.extend({ kind: z.literal('pool_wash') }),
  z.object({
    kind: z.literal('consume'),
    conceptId: z.uuid(),
    quantity: z.number().positive(),
  }),
  z.object({
    kind: z.literal('record_action'),
    actionId: z.uuid(),
    count: z.number().int().positive().default(1),
  }),
  z.object({
    kind: z.literal('occupancy_open'),
    poolId: z.uuid(), // the tray pool; the unit comes from the line's objectId
    position: z.string().optional(),
  }),
  z.object({ kind: z.literal('occupancy_close'), poolId: z.uuid() }),
  z.object({
    kind: z.literal('unit_state'),
    poolId: z.uuid(),
    state: z.enum(POOL_STATES),
  }),
]);
export type LogEffect = z.infer<typeof logEffectSchema>;

// ---------------------------------------------------------------------------
// Sources — a watched file plus the parser derived from a pasted sample line.
// No user ever writes a regular expression: they highlight the parts
// of a real line and the app builds the pattern.
// ---------------------------------------------------------------------------

export const LOG_FIELDS = ['time', 'type', 'id', 'event', 'skip'] as const;
export type LogField = (typeof LOG_FIELDS)[number];

export const logParserSchema = z.object({
  pattern: z.string().min(1),
  groups: z.array(z.enum(LOG_FIELDS)),
  timeFormat: z.string().optional(),
});
export type LogParser = z.infer<typeof logParserSchema>;

export const logSourceSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  path: z.string().min(1),
  parser: logParserSchema,
  enabled: z.boolean(),
  cursorOffset: z.number().int(),
  lastLineAt: z.iso.datetime().nullable(),
  lastPolledAt: z.iso.datetime().nullable(),
  silenceMinutes: z.number().int().positive(),
  ...auditFieldsSchema.shape,
});
export type LogSource = z.infer<typeof logSourceSchema>;

export const logSourceCreateSchema = logSourceSchema.omit({
  id: true,
  cursorOffset: true,
  lastLineAt: true,
  lastPolledAt: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
}).extend({
  enabled: z.boolean().default(false),
  silenceMinutes: z.number().int().positive().default(240),
});
export type LogSourceCreate = z.infer<typeof logSourceCreateSchema>;

export const logSourceUpdateSchema = logSourceCreateSchema.partial();
export type LogSourceUpdate = z.infer<typeof logSourceUpdateSchema>;

/**
 * Derive a parser from a sample line the user has segmented. Sent as the raw
 * line plus which field each whitespace-separated token is.
 */
export const parserProbeSchema = z.object({
  sample: z.string().min(1),
  assignments: z.array(z.enum(LOG_FIELDS)),
});
export type ParserProbe = z.infer<typeof parserProbeSchema>;

export const parserProbeResultSchema = z.object({
  parser: logParserSchema,
  preview: z.array(
    z.object({
      raw: z.string(),
      time: z.string().nullable(),
      type: z.string().nullable(),
      id: z.string().nullable(),
      event: z.string().nullable(),
      matched: z.boolean(),
    }),
  ),
  matchedCount: z.number().int(),
  totalCount: z.number().int(),
});
export type ParserProbeResult = z.infer<typeof parserProbeResultSchema>;

// ---------------------------------------------------------------------------
// The dictionary — the living configuration
// ---------------------------------------------------------------------------

export const logEventSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  description: z.string().nullable(),
  /** New rules start in shadow: recorded, reviewed, then enabled. */
  shadow: z.boolean(),
  effects: z.array(logEffectSchema),
  validFrom: z.iso.datetime(),
  versionCount: z.number().int(),
  ...auditFieldsSchema.shape,
});
export type LogEventDef = z.infer<typeof logEventSchema>;

export const logEventCreateSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullish(),
  shadow: z.boolean().default(true),
  effects: z.array(logEffectSchema).min(1),
});
export type LogEventCreate = z.infer<typeof logEventCreateSchema>;

/**
 * Editing effects does NOT mutate the current version — it closes it and opens
 * a new one from `validFrom`, so reprocessing applies the recipe that
 * was in force on the day of each line.
 */
export const logEventUpdateSchema = z.object({
  description: z.string().nullish(),
  shadow: z.boolean().optional(),
  effects: z.array(logEffectSchema).min(1).optional(),
  validFrom: z.iso.datetime().optional(),
});
export type LogEventUpdate = z.infer<typeof logEventUpdateSchema>;

export const logEventVersionSchema = z.object({
  id: z.uuid(),
  validFrom: z.iso.datetime(),
  validTo: z.iso.datetime().nullable(),
  effects: z.array(logEffectSchema),
  createdBy: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type LogEventVersion = z.infer<typeof logEventVersionSchema>;

// ---------------------------------------------------------------------------
// Lines and ingestion
// ---------------------------------------------------------------------------

export const logLineSchema = z.object({
  id: z.uuid(),
  sourceId: z.uuid(),
  raw: z.string(),
  occurredAt: z.iso.datetime(),
  objectType: z.string().nullable(),
  objectId: z.string().nullable(),
  eventName: z.string().nullable(),
  status: z.enum(LOG_LINE_STATUSES),
  detail: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type LogLine = z.infer<typeof logLineSchema>;

/** The configuration feedback loop: names nobody has explained yet. */
export const unknownEventSchema = z.object({
  eventName: z.string(),
  count: z.number().int(),
  firstSeen: z.iso.datetime(),
  lastSeen: z.iso.datetime(),
  sampleObjectType: z.string().nullable(),
  sampleRaw: z.string(),
});
export type UnknownEvent = z.infer<typeof unknownEventSchema>;

export const ingestResultSchema = z.object({
  read: z.number().int(),
  applied: z.number().int(),
  shadow: z.number().int(),
  unknownEvent: z.number().int(),
  unknownObject: z.number().int(),
  errors: z.number().int(),
  skipped: z.number().int(), // already ingested — idempotency at work
});
export type IngestResult = z.infer<typeof ingestResultSchema>;

/** Point the app at a historical log and backfill ( replay). */
export const ingestRequestSchema = z.object({
  /** Inline content, for replaying an uploaded file instead of the watched path. */
  content: z.string().optional(),
  /** Re-read the source from byte 0 instead of continuing from the cursor. */
  fromStart: z.boolean().default(false),
});
export type IngestRequest = z.infer<typeof ingestRequestSchema>;

export const logHealthSchema = z.object({
  sourceId: z.uuid(),
  name: z.string(),
  enabled: z.boolean(),
  lastLineAt: z.iso.datetime().nullable(),
  minutesSinceLastLine: z.number().nullable(),
  silent: z.boolean(),
  unknownEvents: z.number().int(),
});
export type LogHealth = z.infer<typeof logHealthSchema>;
