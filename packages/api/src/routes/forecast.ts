import { createRoute, z } from '@hono/zod-openapi';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  consumptionRateSchema,
  errorResponseSchema,
  forecastResponseSchema,
  requestAllResultSchema,
  requestAllSchema,
} from '@inventory/shared';
import { createRouter } from '../lib/router';
import { db } from '../db/client';
import { concepts, requestSupporters, requests } from '../db/schema';
import { requireRole } from '../middleware/auth';
import type { AuthEnv } from '../middleware/auth';
import { DEFAULT_LEAD_DAYS, consumptionRates, forecast } from '../services/forecast';
import { logEvent } from '../services/history';
import { generateHumanId } from '../services/ids';

// Forecast. The surface is a list that ends in one button —
// "Request all" — which closes the loop back to Requests and makes the cycle
// circular. A chart would produce nothing.

export const forecastRouter = createRouter<AuthEnv>();

const jsonContent = <T extends z.ZodType>(schema: T) => ({
  content: { 'application/json': { schema } },
});
const errorResponse = (description: string) => ({
  description,
  ...jsonContent(errorResponseSchema),
});

// ----------------------------------------------------------------- GET /forecast
const forecastRoute = createRoute({
  method: 'get',
  path: '/forecast',
  tags: ['forecast'],
  middleware: [requireRole('viewer')] as const,
  request: {
    query: z.object({
      /** Only the rows that need action — what the page shows by default. */
      reorderOnly: z.enum(['true', 'false']).optional(),
    }),
  },
  responses: {
    200: { description: 'Days of stock left, per concept', ...jsonContent(forecastResponseSchema) },
    401: errorResponse('Not signed in'),
  },
});

forecastRouter.openapi(forecastRoute, (c) => {
  const reorderOnly = c.req.valid('query').reorderOnly === 'true';
  const rows = forecast();

  // Mark the ones somebody has already asked for, so the page never invites
  // you to request the same thing twice.
  const open = db
    .select({ id: requests.id, conceptId: requests.conceptId })
    .from(requests)
    .where(and(inArray(requests.status, ['open', 'in_lot', 'ordered']), isNull(requests.deletedAt)))
    .all();
  const openByConcept = new Map(open.map((r) => [r.conceptId, r.id]));

  const withRequests = rows.map((row) => ({
    ...row,
    openRequestId: openByConcept.get(row.conceptId) ?? null,
  }));

  const filtered = reorderOnly ? withRequests.filter((row) => row.reorderNow) : withRequests;
  // Most urgent first: least days of stock remaining.
  filtered.sort((a, b) => (a.daysRemaining ?? Infinity) - (b.daysRemaining ?? Infinity));

  return c.json(
    {
      rows: filtered,
      defaultLeadDays: DEFAULT_LEAD_DAYS,
      generatedAt: new Date().toISOString(),
    },
    200,
  );
});

// ------------------------------------------------------ GET /consumption-rates
const ratesRoute = createRoute({
  method: 'get',
  path: '/consumption-rates',
  tags: ['forecast'],
  middleware: [requireRole('viewer')] as const,
  responses: {
    200: {
      description:
        'Seeded vs measured monthly consumption per concept. The seed is never ' +
        'overwritten — both are returned so the UI can show the correction.',
      ...jsonContent(z.array(consumptionRateSchema)),
    },
    401: errorResponse('Not signed in'),
  },
});

forecastRouter.openapi(ratesRoute, (c) => c.json(consumptionRates(), 200));

// ------------------------------------------------- POST /forecast/request-all
const requestAllRoute = createRoute({
  method: 'post',
  path: '/forecast/request-all',
  tags: ['forecast'],
  middleware: [requireRole('operator')] as const,
  request: { body: { content: { 'application/json': { schema: requestAllSchema } } } },
  responses: {
    200: {
      description: 'Requests created (or joined, where one was already open)',
      ...jsonContent(requestAllResultSchema),
    },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires operator role'),
  },
});

forecastRouter.openapi(requestAllRoute, (c) => {
  const { conceptIds } = c.req.valid('json');
  const user = c.get('user');
  const rows = forecast();
  const byConcept = new Map(rows.map((row) => [row.conceptId, row]));

  const result = db.transaction(() => {
    let created = 0;
    let joined = 0;
    const humanIds: string[] = [];

    for (const conceptId of conceptIds) {
      const concept = db
        .select()
        .from(concepts)
        .where(and(eq(concepts.id, conceptId), isNull(concepts.deletedAt)))
        .get();
      if (!concept) continue;

      // Someone already asked: a +1 is better data than a duplicate.
      const existing = db
        .select()
        .from(requests)
        .where(
          and(
            eq(requests.conceptId, conceptId),
            eq(requests.status, 'open'),
            isNull(requests.deletedAt),
          ),
        )
        .get();
      if (existing) {
        const already = db
          .select()
          .from(requestSupporters)
          .where(
            and(
              eq(requestSupporters.requestId, existing.id),
              eq(requestSupporters.userId, user.id),
            ),
          )
          .get();
        if (!already) {
          db.insert(requestSupporters)
            .values({ id: crypto.randomUUID(), requestId: existing.id, userId: user.id })
            .run();
        }
        joined += 1;
        humanIds.push(existing.humanId);
        continue;
      }

      const row = byConcept.get(conceptId);
      const id = crypto.randomUUID();
      const humanId = generateHumanId('REQ', 'simple');
      db.insert(requests)
        .values({
          id,
          humanId,
          conceptId,
          quantity: row?.suggestedQuantity ?? 1,
          unit: concept.unit,
          urgency: row?.daysRemaining !== null && (row?.daysRemaining ?? 99) <= 0
            ? 'blocking'
            : 'normal',
          note: row
            ? `Forecast: about ${row.daysRemaining ?? '?'} days of stock left`
            : null,
          status: 'open',
          requestedBy: user.id,
        })
        .run();
      logEvent({
        entityType: 'request',
        entityId: id,
        entityHumanId: humanId,
        action: 'created',
        notes: 'from forecast',
        userId: user.id,
      });
      created += 1;
      humanIds.push(humanId);
    }

    return { created, joined, humanIds };
  });

  return c.json(result, 200);
});
