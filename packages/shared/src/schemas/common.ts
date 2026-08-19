import { z } from 'zod';
import type { Locale } from '../constants';

// Translated JSON column shape: adding a language never needs a migration.
// EN is the required fallback language.
export const translatedTextSchema = z.object({
  en: z.string().min(1),
  de: z.string().optional(),
  ca: z.string().optional(),
});
export type TranslatedText = z.infer<typeof translatedTextSchema>;

export function resolveText(
  text: TranslatedText | null | undefined,
  locale: Locale,
): string {
  if (!text) return '';
  return text[locale] || text.en;
}

// ---------------------------------------------------------------------------
// Money. Prices are ALWAYS integers in minor units (cents): 2240 = 22.40 EUR.
// Floats only ever appear at the display boundary (Intl formatting).
// ---------------------------------------------------------------------------

export const currencySchema = z.string().length(3).toUpperCase();

/** "22.40" | "22,40" | "22" → 2240. Pure string parsing — no float arithmetic. */
export function parseMoneyInput(input: string): number | null {
  const match = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(input.trim());
  if (!match) return null;
  const units = match[1]!;
  const cents = (match[2] ?? '').padEnd(2, '0');
  return Number.parseInt(units, 10) * 100 + Number.parseInt(cents || '00', 10);
}

export function formatMoney(
  amountMinor: number,
  currency: string,
  locale: string = 'en',
): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(
    amountMinor / 100,
  );
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export const paginationMetaSchema = z.object({
  page: z.number().int(),
  perPage: z.number().int(),
  total: z.number().int(),
  totalPages: z.number().int(),
});
export type PaginationMeta = z.infer<typeof paginationMetaSchema>;

export function listResponseSchema<T extends z.ZodType>(item: T) {
  return z.object({ data: z.array(item), meta: paginationMetaSchema });
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

/**
 * Clicking a column header sorts the whole table, not the page you happen to
 * be looking at — so sorting is a query parameter and SQLite does the work.
 * Sorting the 25 rows already in the browser would be a lie: "cheapest item"
 * would mean "cheapest of the 25 that arrived most recently".
 *
 * Each router declares its own key list (`sortQuerySchema(['price', …])`) so an
 * unknown key is a 400 at the edge rather than a silent fallback to some
 * default order the caller never asked for.
 */
export const sortDirectionSchema = z.enum(['asc', 'desc']);
export type SortDirection = z.infer<typeof sortDirectionSchema>;

export function sortQuerySchema<const K extends readonly [string, ...string[]]>(keys: K) {
  return z.object({
    sort: z.enum(keys).optional(),
    dir: sortDirectionSchema.optional(),
  });
}

/** Column keys the Items table can be ordered by — shared by API and web. */
export const ITEM_SORT_KEYS = [
  'humanId',
  'type',
  'concept',
  'variant',
  'status',
  'location',
  'remaining',
  'received',
  'price',
] as const;
export type ItemSortKey = (typeof ITEM_SORT_KEYS)[number];

/** Same, for Variants. */
export const VARIANT_SORT_KEYS = [
  'humanId',
  'name',
  'brand',
  'concept',
  'type',
  'packSize',
  'items',
] as const;
export type VariantSortKey = (typeof VARIANT_SORT_KEYS)[number];

// ---------------------------------------------------------------------------
// Audit fields — every entity carries them. The API serializes DB timestamps
// to ISO strings at the boundary.
// ---------------------------------------------------------------------------

export const auditFieldsSchema = z.object({
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});
export type AuditFields = z.infer<typeof auditFieldsSchema>;

// Uniform API error shape.
export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
