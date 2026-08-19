import { createRoute, z } from '@hono/zod-openapi';
import { and, eq, isNull } from 'drizzle-orm';
import {
  csvImportResultSchema,
  csvImportSchema,
  parseMoneyInput,
  resolveText,
} from '@inventory/shared';
import type { ItemStatus } from '@inventory/shared';
import { createRouter } from '../lib/router';
import { db } from '../db/client';
import { analogous, concepts, items, locations, types, variants } from '../db/schema';
import { parseCsv, toCsv } from '../lib/csv';
import { jsonBody, jsonContent, errorResponse } from '../lib/openapi';
import { requireRole } from '../middleware/auth';
import type { AuthEnv } from '../middleware/auth';
import { ApiError } from '../middleware/error';
import { logEvent } from '../services/history';
import { generateHumanId } from '../services/ids';

// Bulk in and out. Export is a plain CSV download; import takes the same
// column set back, so "export → edit in a spreadsheet → import" round-trips.

export const transferRouter = createRouter<AuthEnv>();

const EXPORT_COLUMNS = [
  'humanId',
  'type',
  'concept',
  'variant',
  'status',
  'location',
  'quantityRemaining',
  'quantityInitial',
  'unit',
  'price',
  'currency',
  'serialNumber',
  'batchNumber',
  'receivedAt',
  'notes',
  'customFields',
];

// -------------------------------------------------------- GET /export/items
const exportRoute = createRoute({
  method: 'get',
  path: '/export/items.csv',
  tags: ['transfer'],
  middleware: [requireRole('viewer')] as const,
  request: {
    query: z.object({
      locale: z.enum(['en', 'de', 'ca']).default('en'),
      includeDeleted: z.enum(['true', 'false']).optional(),
    }),
  },
  responses: {
    200: { description: 'All items as CSV', content: { 'text/csv': { schema: z.string() } } },
    401: errorResponse('Not signed in'),
  },
});

transferRouter.openapi(exportRoute, (c) => {
  const { locale, includeDeleted } = c.req.valid('query');

  const rows = db
    .select({
      item: items,
      typeName: types.name,
      conceptName: concepts.name,
      variantName: variants.name,
      locationCode: locations.code,
    })
    .from(items)
    .leftJoin(types, eq(items.typeId, types.id))
    .leftJoin(concepts, eq(items.conceptId, concepts.id))
    .leftJoin(variants, eq(items.variantId, variants.id))
    .leftJoin(locations, eq(items.locationId, locations.id))
    .where(includeDeleted === 'true' ? undefined : isNull(items.deletedAt))
    .orderBy(items.humanId)
    .all();

  const csv = toCsv(
    rows.map(({ item, typeName, conceptName, variantName, locationCode }) => ({
      humanId: item.humanId,
      type: resolveText(typeName, locale),
      concept: resolveText(conceptName, locale),
      variant: resolveText(variantName, locale),
      status: item.status,
      location: locationCode ?? '',
      quantityRemaining: item.quantityRemaining,
      quantityInitial: item.quantityInitial,
      unit: item.unit,
      // Exported as a decimal string for humans; re-parsed to cents on import.
      price: item.priceAmount === null ? '' : (item.priceAmount / 100).toFixed(2),
      currency: item.priceCurrency,
      serialNumber: item.serialNumber,
      batchNumber: item.batchNumber,
      receivedAt: item.receivedAt ? item.receivedAt.toISOString().slice(0, 10) : '',
      notes: item.notes,
      customFields: JSON.stringify(item.customFields ?? {}),
    })),
    EXPORT_COLUMNS,
  );

  return c.newResponse(csv, 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="items-${new Date().toISOString().slice(0, 10)}.csv"`,
  });
});

// ------------------------------------------------------- POST /import/items
const importRoute = createRoute({
  method: 'post',
  path: '/import/items',
  tags: ['transfer'],
  middleware: [requireRole('manager')] as const,
  request: jsonBody(csvImportSchema),
  responses: {
    200: { description: 'Import result', ...jsonContent(csvImportResultSchema) },
    400: errorResponse('Unusable CSV'),
    401: errorResponse('Not signed in'),
    403: errorResponse('Requires manager role'),
  },
});

transferRouter.openapi(importRoute, (c) => {
  const { csv, dryRun } = c.req.valid('json');
  const user = c.get('user');

  const { columns, rows } = parseCsv(csv);
  if (!columns.includes('type')) {
    throw new ApiError(
      400,
      'missing_column',
      "The CSV needs at least a 'type' column. Export your items first to see the expected shape.",
    );
  }

  const activeTypes = db.select().from(types).where(isNull(types.deletedAt)).all();
  const activeLocations = db.select().from(locations).where(isNull(locations.deletedAt)).all();

  const errors: Array<{ row: number; message: string }> = [];
  const humanIds: string[] = [];

  const run = () => {
    rows.forEach((row, index) => {
      const line = index + 2; // 1-based, and the header is line 1
      try {
        const typeRow = activeTypes.find(
          (t) =>
            t.key === row.type ||
            Object.values(t.name).some((n) => n?.toLowerCase() === row.type?.toLowerCase()),
        );
        if (!typeRow) throw new Error(`Unknown type '${row.type}'`);

        const locationRow = row.location
          ? activeLocations.find((l) => l.code === row.location)
          : undefined;
        if (row.location && !locationRow) throw new Error(`Unknown location '${row.location}'`);

        const status = (row.status || typeRow.validStatuses[0]!) as ItemStatus;
        if (!typeRow.validStatuses.includes(status)) {
          throw new Error(`Status '${status}' is not valid for type '${typeRow.key}'`);
        }

        let customFields: Record<string, unknown> = {};
        if (row.customFields) {
          try {
            customFields = JSON.parse(row.customFields) as Record<string, unknown>;
          } catch {
            throw new Error('customFields is not valid JSON');
          }
        }

        // A named variant links the item into the catalogue; without one it is
        // a standalone item, which is a perfectly normal thing to be.
        let variantId: string | null = null;
        let analogousId: string | null = null;
        let conceptId: string | null = null;
        if (row.variant) {
          const variantRow = db
            .select()
            .from(variants)
            .where(isNull(variants.deletedAt))
            .all()
            .find((v) =>
              Object.values(v.name).some((n) => n?.toLowerCase() === row.variant!.toLowerCase()),
            );
          if (!variantRow) throw new Error(`Unknown variant '${row.variant}'`);
          variantId = variantRow.id;
          analogousId = variantRow.analogousId;
          conceptId = variantRow.conceptId;
        }

        const priceAmount = row.price ? parseMoneyInput(row.price) : null;
        if (row.price && priceAmount === null) throw new Error(`Unreadable price '${row.price}'`);

        const quantity = row.quantityRemaining || row.quantityInitial || '';
        const quantityValue =
          typeRow.tracksQuantity && quantity !== '' ? Number(quantity) : null;
        if (quantityValue !== null && Number.isNaN(quantityValue)) {
          throw new Error(`Unreadable quantity '${quantity}'`);
        }

        if (dryRun) {
          humanIds.push(`${typeRow.humanIdPrefix}…`);
          return;
        }

        const id = crypto.randomUUID();
        const humanId = generateHumanId(typeRow.humanIdPrefix, 'lettered');
        db.insert(items)
          .values({
            id,
            humanId,
            typeId: typeRow.id,
            variantId,
            analogousId,
            conceptId,
            locationId: locationRow?.id ?? null,
            status,
            quantityInitial: row.quantityInitial ? Number(row.quantityInitial) : quantityValue,
            quantityRemaining: quantityValue,
            unit: row.unit || null,
            priceAmount,
            priceCurrency: priceAmount !== null ? row.currency || 'EUR' : null,
            priceLocked: priceAmount !== null,
            serialNumber: row.serialNumber || null,
            batchNumber: row.batchNumber || null,
            customFields,
            receivedAt: row.receivedAt ? new Date(row.receivedAt) : new Date(),
            notes: row.notes || null,
            createdBy: user.id,
          })
          .run();
        logEvent({
          entityType: 'item',
          entityId: id,
          entityHumanId: humanId,
          action: 'created',
          notes: 'csv import',
          userId: user.id,
        });
        humanIds.push(humanId);
      } catch (error) {
        errors.push({ row: line, message: error instanceof Error ? error.message : String(error) });
      }
    });
  };

  if (dryRun) {
    run();
  } else {
    // All or nothing: a half-imported spreadsheet is worse than none.
    db.transaction(() => {
      run();
      if (errors.length > 0) {
        throw new ApiError(400, 'import_failed', `${errors.length} row(s) could not be imported`, {
          errors,
        });
      }
    });
  }

  return c.json(
    { created: dryRun ? 0 : humanIds.length, rows: rows.length, errors, humanIds },
    200,
  );
});
