import { createRoute, z } from '@hono/zod-openapi';
import { and, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  brandingSchema,
  brandingUpdateSchema,
  conceptSchema,
  locationWithCountSchema,
} from '@inventory/shared';
import { createRouter } from '../lib/router';
import { db } from '../db/client';
import { concepts, items, locations } from '../db/schema';
import { jsonBody, jsonContent, errorResponse } from '../lib/openapi';
import { serializeAudit } from '../lib/serialize';
import { requireRole } from '../middleware/auth';
import type { AuthEnv } from '../middleware/auth';
import { logEvent } from '../services/history';
import { readBranding, writeBranding } from '../services/settings';
import { stockByConcept } from '../services/stock';
import { subtreeIds } from './locations';

// ---------------------------------------------------------------------------
// The two things the app must be able to answer BEFORE anyone signs in.
//
// 1. What does this workshop look like — its logo and colours, so the sign-in
//    screen is already the workshop's own screen rather than a generic one.
// 2. What is in stock — the noticeboard view. Somebody walking past a bench
//    computer can see whether there is wood glue left without borrowing an
//    account, which is the single most common reason people asked to "just
//    have a look".
//
// This is the ONLY unauthenticated data in the product, and it is deliberately
// its own router rather than a relaxed `requireRole` on the real ones. What
// leaves this file is a fixed, hand-written list: concept names, quantities,
// units, thresholds and the location tree. It carries no item rows, so no
// serial numbers, no batch numbers, no prices, no notes, no names of people.
// Adding a field here is a decision to publish it to anyone who can reach the
// server — which on a workshop network is everybody.
// ---------------------------------------------------------------------------

export const publicRouter = createRouter<AuthEnv>();

// ------------------------------------------------------------ GET /branding
const brandingRoute = createRoute({
  method: 'get',
  path: '/branding',
  tags: ['meta'],
  responses: {
    200: {
      description: "The workshop's logo, name and theme colours. Public: the sign-in screen needs it.",
      ...jsonContent(brandingSchema),
    },
  },
});

publicRouter.openapi(brandingRoute, (c) => c.json(readBranding(), 200));

// ------------------------------------------------------------ PUT /branding
const setBrandingRoute = createRoute({
  method: 'put',
  path: '/branding',
  tags: ['meta'],
  middleware: [requireRole('admin')] as const,
  request: jsonBody(brandingUpdateSchema),
  responses: {
    200: { description: 'Updated branding', ...jsonContent(brandingSchema) },
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires admin role'),
  },
});

publicRouter.openapi(setBrandingRoute, (c) => {
  const body = c.req.valid('json');
  const user = c.get('user');

  const next = db.transaction(() => {
    const before = readBranding();
    // A partial update, so clearing the logo means sending `logo: null` and
    // leaving it alone means not sending the key at all. Sending a 300 KB
    // image back just to change the workshop's name would be silly.
    const merged = {
      name: body.name !== undefined ? body.name : before.name,
      logo: body.logo !== undefined ? body.logo : before.logo,
      colors: body.colors !== undefined ? body.colors : before.colors,
    };
    const saved = writeBranding(merged, user.id);
    // The logo itself is far too big for a history row and would drown the
    // feed; what matters is that somebody changed the workshop's look and when.
    logEvent({
      entityType: 'setting',
      entityId: 'branding',
      entityHumanId: 'branding',
      action: 'updated',
      valueAfter: {
        name: saved.name,
        logo: saved.logo ? `${Math.round(saved.logo.length / 1024)} KB` : null,
        colors: saved.colors,
      },
      userId: user.id,
    });
    return saved;
  });

  return c.json(next, 200);
});

// --------------------------------------------------------- GET /public/home
/**
 * Exactly what the signed-out Home renders, in one request.
 *
 * One endpoint rather than public variants of /concepts, /concepts/stock,
 * /items/metrics and /locations: four relaxed endpoints are four things to get
 * wrong later, and each of them takes filters that would let a caller ask
 * questions this view is not meant to answer.
 */
const publicHomeSchema = z.object({
  concepts: z.array(
    conceptSchema
      .pick({ id: true, humanId: true, name: true, unit: true, minStockThreshold: true })
      .extend({ stock: z.number() }),
  ),
  metrics: z.object({ activeItems: z.number().int(), openItems: z.number().int() }),
  locations: z.array(locationWithCountSchema),
});

const publicHomeRoute = createRoute({
  method: 'get',
  path: '/public/home',
  tags: ['meta'],
  request: { query: z.object({ locationId: z.uuid().optional() }) },
  responses: {
    200: {
      description:
        'Read-only stock overview for people who have not signed in. Names, ' +
        'quantities and the location tree only — no item-level data.',
      ...jsonContent(publicHomeSchema),
    },
  },
});

publicRouter.openapi(publicHomeRoute, (c) => {
  const { locationId } = c.req.valid('query');
  const scope = locationId ? subtreeIds(locationId) : undefined;

  // Same "is this stock?" rule as the signed-in Home (routes/concepts.ts):
  // instruments and documents are not stock, and "0 pillar drills" was
  // never a warning worth showing anybody.
  const rows = db
    .select({
      id: concepts.id,
      humanId: concepts.humanId,
      name: concepts.name,
      unit: concepts.unit,
      minStockThreshold: concepts.minStockThreshold,
    })
    .from(concepts)
    .where(
      and(
        isNull(concepts.deletedAt),
        sql`not exists (
          select 1 from items
          join types on types.id = items.type_id
          where items.concept_id = ${concepts.id}
            and items.deleted_at is null
        ) or exists (
          select 1 from items
          join types on types.id = items.type_id
          where items.concept_id = ${concepts.id}
            and items.deleted_at is null
            and types.counts_as_stock = 1
        )`,
      ),
    )
    .orderBy(concepts.humanId)
    .all();

  const stocks = stockByConcept(scope);
  const locationFilter = scope ? inArray(items.locationId, scope) : undefined;

  const activeItems =
    db
      .select({ n: count() })
      .from(items)
      .where(and(isNull(items.deletedAt), inArray(items.status, ['in_stock', 'open']), locationFilter))
      .get()?.n ?? 0;
  const openItems =
    db
      .select({ n: count() })
      .from(items)
      .where(and(isNull(items.deletedAt), eq(items.status, 'open'), locationFilter))
      .get()?.n ?? 0;

  const itemCounts = Object.fromEntries(
    db
      .select({ locationId: items.locationId, n: count() })
      .from(items)
      .where(isNull(items.deletedAt))
      .groupBy(items.locationId)
      .all()
      .filter((row) => row.locationId !== null)
      .map((row) => [row.locationId!, row.n]),
  );

  const tree = db
    .select()
    .from(locations)
    .where(isNull(locations.deletedAt))
    .orderBy(locations.code)
    .all()
    .map((row) => ({ ...serializeAudit(row), itemCount: itemCounts[row.id] ?? 0 }));

  return c.json(
    {
      concepts: rows.map((row) => ({ ...row, stock: stocks[row.id] ?? 0 })),
      metrics: { activeItems, openItems },
      locations: tree,
    },
    200,
  );
});
