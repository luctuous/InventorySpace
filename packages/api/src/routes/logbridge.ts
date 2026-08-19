import { readFile } from 'node:fs/promises';
import { createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  errorResponseSchema,
  ingestRequestSchema,
  ingestResultSchema,
  logEventCreateSchema,
  logEventSchema,
  logEventUpdateSchema,
  logEventVersionSchema,
  logHealthSchema,
  logLineSchema,
  logSourceCreateSchema,
  logSourceSchema,
  logSourceUpdateSchema,
  parserProbeResultSchema,
  parserProbeSchema,
  unknownEventSchema,
  LOG_LINE_STATUSES,
} from '@inventory/shared';
import { createRouter } from '../lib/router';
import { db } from '../db/client';
import { logEventDefs, logEventVersions, logLines, logSources } from '../db/schema';
import { serializeAudit, toIso } from '../lib/serialize';
import { requireRole } from '../middleware/auth';
import type { AuthEnv } from '../middleware/auth';
import { ApiError, notFoundError } from '../middleware/error';
import { logEvent } from '../services/history';
import {
  deriveParser,
  effectsInForce,
  ingestContent,
  logHealth,
  parseLine,
  resolveTimestamp,
  unknownEvents,
} from '../services/logbridge';

// The log bridge screens. Everything an admin needs to point
// the app at a machine controller log and teach it what the workshop's own event names mean.

export const logRouter = createRouter<AuthEnv>();

const jsonContent = <T extends z.ZodType>(schema: T) => ({
  content: { 'application/json': { schema } },
});
const errorResponse = (description: string) => ({
  description,
  ...jsonContent(errorResponseSchema),
});
const idParam = z.object({ id: z.uuid() });

function getSource(id: string) {
  const row = db
    .select()
    .from(logSources)
    .where(and(eq(logSources.id, id), isNull(logSources.deletedAt)))
    .get();
  if (!row) throw notFoundError('log source', id);
  return row;
}

const serializeSource = (row: typeof logSources.$inferSelect) => ({
  ...serializeAudit(row),
  lastLineAt: toIso(row.lastLineAt),
  lastPolledAt: toIso(row.lastPolledAt),
});

// ------------------------------------------------------------ GET /log/sources
const sourceListRoute = createRoute({
  method: 'get',
  path: '/log/sources',
  tags: ['log'],
  middleware: [requireRole('admin')] as const,
  responses: {
    200: { description: 'Watched log files', ...jsonContent(z.array(logSourceSchema)) },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires admin role'),
  },
});

logRouter.openapi(sourceListRoute, (c) => {
  const rows = db
    .select()
    .from(logSources)
    .where(isNull(logSources.deletedAt))
    .orderBy(logSources.name)
    .all();
  return c.json(rows.map(serializeSource), 200);
});

// --------------------------------------------------------- POST /log/probe
// Derive a parser from a pasted line. The user highlights which token is
// which; nobody ever types a regular expression.
const probeRoute = createRoute({
  method: 'post',
  path: '/log/probe',
  tags: ['log'],
  middleware: [requireRole('admin')] as const,
  request: {
    body: {
      content: {
        'application/json': {
          schema: parserProbeSchema.extend({
            /** Optional extra lines to preview the derived pattern against. */
            content: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Derived parser plus a live preview', ...jsonContent(parserProbeResultSchema) },
    400: errorResponse('The labels do not fit the sample line'),
    401: errorResponse('Not signed in'),
  },
});

logRouter.openapi(probeRoute, (c) => {
  const body = c.req.valid('json');

  let parser;
  try {
    parser = deriveParser(body.sample, body.assignments);
  } catch (error) {
    throw new ApiError(400, 'bad_sample', error instanceof Error ? error.message : String(error));
  }

  const lines = (body.content ?? body.sample)
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  const preview = lines.slice(0, 20).map((raw) => parseLine(parser, raw));
  const matchedCount = lines.filter((raw) => parseLine(parser, raw).matched).length;

  return c.json({ parser, preview, matchedCount, totalCount: lines.length }, 200);
});

// -------------------------------------------------------- POST /log/sources
const createSourceRoute = createRoute({
  method: 'post',
  path: '/log/sources',
  tags: ['log'],
  middleware: [requireRole('admin')] as const,
  request: { body: { content: { 'application/json': { schema: logSourceCreateSchema } } } },
  responses: {
    201: { description: 'Created source', ...jsonContent(logSourceSchema) },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires admin role'),
  },
});

logRouter.openapi(createSourceRoute, (c) => {
  const body = c.req.valid('json');
  const user = c.get('user');

  const row = db.transaction(() => {
    const id = crypto.randomUUID();
    db.insert(logSources)
      .values({
        id,
        name: body.name,
        path: body.path,
        parser: body.parser,
        enabled: body.enabled,
        silenceMinutes: body.silenceMinutes,
      })
      .run();
    logEvent({
      entityType: 'logEvent', entityId: id, entityHumanId: body.name,
      action: 'created', valueAfter: { path: body.path }, userId: user.id,
    });
    return db.select().from(logSources).where(eq(logSources.id, id)).get()!;
  });

  return c.json(serializeSource(row), 201);
});

// --------------------------------------------------- PATCH /log/sources/:id
const updateSourceRoute = createRoute({
  method: 'patch',
  path: '/log/sources/{id}',
  tags: ['log'],
  middleware: [requireRole('admin')] as const,
  request: {
    params: idParam,
    body: { content: { 'application/json': { schema: logSourceUpdateSchema } } },
  },
  responses: {
    200: { description: 'Updated source', ...jsonContent(logSourceSchema) },
    401: errorResponse('Not signed in'),
    404: errorResponse('Not found'),
  },
});

logRouter.openapi(updateSourceRoute, (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const user = c.get('user');

  const row = db.transaction(() => {
    const before = getSource(id);
    db.update(logSources)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.path !== undefined ? { path: body.path } : {}),
        ...(body.parser !== undefined ? { parser: body.parser } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.silenceMinutes !== undefined ? { silenceMinutes: body.silenceMinutes } : {}),
      })
      .where(eq(logSources.id, id))
      .run();
    if (body.enabled !== undefined && body.enabled !== before.enabled) {
      logEvent({
        entityType: 'logEvent', entityId: id, entityHumanId: before.name,
        action: 'updated', fieldChanged: 'enabled',
        valueBefore: before.enabled, valueAfter: body.enabled, userId: user.id,
      });
    }
    return db.select().from(logSources).where(eq(logSources.id, id)).get()!;
  });

  return c.json(serializeSource(row), 200);
});

// -------------------------------------------------- DELETE /log/sources/:id
const deleteSourceRoute = createRoute({
  method: 'delete',
  path: '/log/sources/{id}',
  tags: ['log'],
  middleware: [requireRole('admin')] as const,
  request: { params: idParam },
  responses: {
    200: { description: 'Soft-deleted source', ...jsonContent(logSourceSchema) },
    401: errorResponse('Not signed in'),
    404: errorResponse('Not found'),
  },
});

logRouter.openapi(deleteSourceRoute, (c) => {
  const { id } = c.req.valid('param');
  const row = db.transaction(() => {
    getSource(id);
    db.update(logSources).set({ deletedAt: new Date() }).where(eq(logSources.id, id)).run();
    return db.select().from(logSources).where(eq(logSources.id, id)).get()!;
  });
  return c.json(serializeSource(row), 200);
});

// ------------------------------------------------ POST /log/sources/:id/ingest
const ingestRoute = createRoute({
  method: 'post',
  path: '/log/sources/{id}/ingest',
  tags: ['log'],
  middleware: [requireRole('admin')] as const,
  request: {
    params: idParam,
    body: { content: { 'application/json': { schema: ingestRequestSchema } } },
  },
  responses: {
    200: {
      description:
        'Read new lines and apply them. Each line takes effect exactly once; ' +
        'replaying a historical file is safe and is a supported workflow.',
      ...jsonContent(ingestResultSchema),
    },
    400: errorResponse('Could not read the file'),
    401: errorResponse('Not signed in'),
    404: errorResponse('Not found'),
  },
});

logRouter.openapi(ingestRoute, async (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const source = getSource(id);

  let content = body.content;
  if (content === undefined) {
    content = await readFile(source.path, 'utf8').catch((error: Error) => {
      throw new ApiError(400, 'log_unreadable', `Cannot read ${source.path}: ${error.message}`);
    });
  }

  // Continuing a watched file keeps the cursor so already-seen lines are
  // skipped; a replay starts from zero and relies on the hash for idempotency.
  const startIndex = body.fromStart || body.content !== undefined ? 0 : source.cursorOffset;
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const slice = body.fromStart || body.content !== undefined
    ? content
    : lines.slice(source.cursorOffset).join('\n');

  return c.json(ingestContent(id, slice, { startIndex }), 200);
});

// ------------------------------------------------------------ GET /log/lines
const lineListRoute = createRoute({
  method: 'get',
  path: '/log/lines',
  tags: ['log'],
  middleware: [requireRole('admin')] as const,
  request: {
    query: z.object({
      status: z.enum(LOG_LINE_STATUSES).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
  },
  responses: {
    200: { description: 'Recent ingested lines', ...jsonContent(z.array(logLineSchema)) },
    401: errorResponse('Not signed in'),
  },
});

logRouter.openapi(lineListRoute, (c) => {
  const { status, limit } = c.req.valid('query');
  const rows = db
    .select()
    .from(logLines)
    .where(status ? eq(logLines.status, status) : undefined)
    .orderBy(desc(logLines.occurredAt))
    .limit(limit)
    .all();
  return c.json(
    rows.map((row) => ({
      ...row,
      occurredAt: row.occurredAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    })),
    200,
  );
});

// -------------------------------------------------- GET /log/unknown-events
const unknownRoute = createRoute({
  method: 'get',
  path: '/log/unknown-events',
  tags: ['log'],
  middleware: [requireRole('admin')] as const,
  responses: {
    200: {
      description:
        'Event names nobody has explained yet. This is the main configuration ' +
        'screen, not an error list — the log teaches you which rules you need.',
      ...jsonContent(z.array(unknownEventSchema)),
    },
    401: errorResponse('Not signed in'),
  },
});

logRouter.openapi(unknownRoute, (c) => c.json(unknownEvents(), 200));

// ------------------------------------------------------------ GET /log/health
const healthRoute = createRoute({
  method: 'get',
  path: '/log/health',
  tags: ['log'],
  middleware: [requireRole('viewer')] as const,
  responses: {
    200: {
      description: 'Silence watch — the failure mode that does not shout',
      ...jsonContent(z.array(logHealthSchema)),
    },
    401: errorResponse('Not signed in'),
  },
});

logRouter.openapi(healthRoute, (c) => c.json(logHealth(), 200));

// ---------------------------------------------------------- the dictionary

function serializeEventDef(row: typeof logEventDefs.$inferSelect) {
  const current = db
    .select()
    .from(logEventVersions)
    .where(and(eq(logEventVersions.eventId, row.id), isNull(logEventVersions.validTo)))
    .orderBy(desc(logEventVersions.validFrom))
    .get();
  const versionCount =
    db
      .select({ n: sql<number>`count(*)` })
      .from(logEventVersions)
      .where(eq(logEventVersions.eventId, row.id))
      .get()?.n ?? 0;

  return {
    ...serializeAudit(row),
    effects: current?.effects ?? [],
    validFrom: (current?.validFrom ?? row.createdAt).toISOString(),
    versionCount: Number(versionCount),
  };
}

const eventListRoute = createRoute({
  method: 'get',
  path: '/log/events',
  tags: ['log'],
  middleware: [requireRole('viewer')] as const,
  responses: {
    200: { description: 'The event dictionary', ...jsonContent(z.array(logEventSchema)) },
    401: errorResponse('Not signed in'),
  },
});

logRouter.openapi(eventListRoute, (c) => {
  const rows = db
    .select()
    .from(logEventDefs)
    .where(isNull(logEventDefs.deletedAt))
    .orderBy(logEventDefs.name)
    .all();
  return c.json(rows.map(serializeEventDef), 200);
});

const eventCreateRoute = createRoute({
  method: 'post',
  path: '/log/events',
  tags: ['log'],
  middleware: [requireRole('admin')] as const,
  request: { body: { content: { 'application/json': { schema: logEventCreateSchema } } } },
  responses: {
    201: { description: 'Created dictionary entry', ...jsonContent(logEventSchema) },
    401: errorResponse('Not signed in'),
    409: errorResponse('That event name already exists'),
  },
});

logRouter.openapi(eventCreateRoute, (c) => {
  const body = c.req.valid('json');
  const user = c.get('user');

  const row = db.transaction(() => {
    const clash = db
      .select()
      .from(logEventDefs)
      .where(and(eq(logEventDefs.name, body.name), isNull(logEventDefs.deletedAt)))
      .get();
    if (clash) {
      throw new ApiError(409, 'event_exists', `'${body.name}' is already in the dictionary`);
    }

    const id = crypto.randomUUID();
    db.insert(logEventDefs)
      .values({
        id,
        name: body.name,
        description: body.description ?? null,
        shadow: body.shadow,
      })
      .run();
    db.insert(logEventVersions)
      .values({
        id: crypto.randomUUID(),
        eventId: id,
        validFrom: new Date(0), // covers historical replay from the beginning
        effects: body.effects,
        createdBy: user.id,
      })
      .run();
    logEvent({
      entityType: 'logEvent', entityId: id, entityHumanId: body.name,
      action: 'created', valueAfter: body.effects, userId: user.id,
    });
    return db.select().from(logEventDefs).where(eq(logEventDefs.id, id)).get()!;
  });

  return c.json(serializeEventDef(row), 201);
});

const eventUpdateRoute = createRoute({
  method: 'patch',
  path: '/log/events/{id}',
  tags: ['log'],
  middleware: [requireRole('admin')] as const,
  request: {
    params: idParam,
    body: { content: { 'application/json': { schema: logEventUpdateSchema } } },
  },
  responses: {
    200: { description: 'Updated entry', ...jsonContent(logEventSchema) },
    401: errorResponse('Not signed in'),
    404: errorResponse('Not found'),
  },
});

logRouter.openapi(eventUpdateRoute, (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const user = c.get('user');

  const row = db.transaction(() => {
    const before = db
      .select()
      .from(logEventDefs)
      .where(and(eq(logEventDefs.id, id), isNull(logEventDefs.deletedAt)))
      .get();
    if (!before) throw notFoundError('log event', id);

    if (body.description !== undefined || body.shadow !== undefined) {
      db.update(logEventDefs)
        .set({
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.shadow !== undefined ? { shadow: body.shadow } : {}),
        })
        .where(eq(logEventDefs.id, id))
        .run();
    }

    if (body.effects) {
      // A new effect list does NOT mutate the old one: the current version is
      // closed and a new one opens. Reprocessing then applies the
      // recipe that was in force on the day of each line, which is the only
      // way the cost curve stays honest across a procedure change.
      const validFrom = body.validFrom ? new Date(body.validFrom) : new Date();
      const current = effectsInForce(id, validFrom);
      db.update(logEventVersions)
        .set({ validTo: validFrom })
        .where(and(eq(logEventVersions.eventId, id), isNull(logEventVersions.validTo)))
        .run();
      db.insert(logEventVersions)
        .values({
          id: crypto.randomUUID(),
          eventId: id,
          validFrom,
          effects: body.effects,
          createdBy: user.id,
        })
        .run();
      logEvent({
        entityType: 'logEvent', entityId: id, entityHumanId: before.name,
        action: 'updated', fieldChanged: 'effects',
        valueBefore: current, valueAfter: body.effects,
        notes: `new version from ${validFrom.toISOString().slice(0, 10)}`,
        userId: user.id,
      });
    }

    if (body.shadow === false && before.shadow) {
      logEvent({
        entityType: 'logEvent', entityId: id, entityHumanId: before.name,
        action: 'updated', fieldChanged: 'shadow',
        valueBefore: true, valueAfter: false, notes: 'rule enabled', userId: user.id,
      });
    }
    return db.select().from(logEventDefs).where(eq(logEventDefs.id, id)).get()!;
  });

  return c.json(serializeEventDef(row), 200);
});

const eventVersionsRoute = createRoute({
  method: 'get',
  path: '/log/events/{id}/versions',
  tags: ['log'],
  middleware: [requireRole('viewer')] as const,
  request: { params: idParam },
  responses: {
    200: {
      description:
        'Dated version history — also a record of when the workshop changed its ' +
        'procedures, written by nobody.',
      ...jsonContent(z.array(logEventVersionSchema)),
    },
    401: errorResponse('Not signed in'),
  },
});

logRouter.openapi(eventVersionsRoute, (c) => {
  const { id } = c.req.valid('param');
  const rows = db
    .select()
    .from(logEventVersions)
    .where(eq(logEventVersions.eventId, id))
    .orderBy(desc(logEventVersions.validFrom))
    .all();
  return c.json(
    rows.map((row) => ({
      id: row.id,
      validFrom: row.validFrom.toISOString(),
      validTo: toIso(row.validTo),
      effects: row.effects,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
    })),
    200,
  );
});

const eventDeleteRoute = createRoute({
  method: 'delete',
  path: '/log/events/{id}',
  tags: ['log'],
  middleware: [requireRole('admin')] as const,
  request: { params: idParam },
  responses: {
    200: { description: 'Soft-deleted entry', ...jsonContent(logEventSchema) },
    401: errorResponse('Not signed in'),
    404: errorResponse('Not found'),
  },
});

logRouter.openapi(eventDeleteRoute, (c) => {
  const { id } = c.req.valid('param');
  const row = db.transaction(() => {
    db.update(logEventDefs).set({ deletedAt: new Date() }).where(eq(logEventDefs.id, id)).run();
    const after = db.select().from(logEventDefs).where(eq(logEventDefs.id, id)).get();
    if (!after) throw notFoundError('log event', id);
    return after;
  });
  return c.json(serializeEventDef(row), 200);
});

// Re-exported so the ingest route can name the same helper the service uses.
export { resolveTimestamp };
