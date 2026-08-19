import { z } from 'zod';
import { USER_ROLES } from '../constants';
import { translatedTextSchema } from './common';
import { analogousSchema } from './analogous';
import { itemSchema } from './item';
import { locationSchema } from './location';
import { typeSchema } from './type';
import { variantSchema } from './variant';

// API response shapes that enrich the base entities with usage counts or
// display references, so list pages never need JOIN-chasing on the client.

export const typeWithCountSchema = typeSchema.extend({
  itemCount: z.number().int(),
});
export type TypeWithCount = z.infer<typeof typeWithCountSchema>;

export const locationWithCountSchema = locationSchema.extend({
  // active items directly AT this node (subtree totals are summed client-side)
  itemCount: z.number().int(),
});
export type LocationWithCount = z.infer<typeof locationWithCountSchema>;

export const analogousWithCountSchema = analogousSchema.extend({
  conceptName: translatedTextSchema.nullable(),
  conceptHumanId: z.string().nullable(),
  variantCount: z.number().int(),
  itemCount: z.number().int(),
});
export type AnalogousWithCount = z.infer<typeof analogousWithCountSchema>;

export const variantWithRefsSchema = variantSchema.extend({
  analogousName: translatedTextSchema.nullable(),
  analogousHumanId: z.string().nullable(),
  conceptName: translatedTextSchema.nullable(),
  conceptHumanId: z.string().nullable(),
  typeName: translatedTextSchema.nullable(),
  typeKey: z.string().nullable(),
  itemCount: z.number().int(),
});
export type VariantWithRefs = z.infer<typeof variantWithRefsSchema>;

export const itemWithRefsSchema = itemSchema.extend({
  typeName: translatedTextSchema.nullable(),
  typeKey: z.string().nullable(),
  conceptName: translatedTextSchema.nullable(),
  conceptHumanId: z.string().nullable(),
  analogousName: translatedTextSchema.nullable(),
  variantName: translatedTextSchema.nullable(),
  variantHumanId: z.string().nullable(),
  locationCode: z.string().nullable(),
  locationName: translatedTextSchema.nullable(),
});
export type ItemWithRefs = z.infer<typeof itemWithRefsSchema>;

// Quick Add

export const quickSearchResultSchema = z.object({
  variants: z.array(
    z.object({
      id: z.uuid(),
      humanId: z.string(),
      name: translatedTextSchema,
      brand: z.string().nullable(),
      packSize: z.number().nullable(),
      packUnit: z.string().nullable(),
      typeId: z.uuid(),
      conceptId: z.uuid(),
    }),
  ),
  concepts: z.array(
    z.object({
      id: z.uuid(),
      humanId: z.string(),
      name: translatedTextSchema,
      unit: z.string(),
    }),
  ),
});
export type QuickSearchResult = z.infer<typeof quickSearchResultSchema>;

export const quickAddResponseSchema = z.object({
  items: z.array(itemSchema),
  variantId: z.uuid(),
  // true → the 1:1 Concept→Analogous→Variant chain was created new
  chainCreated: z.boolean(),
});
export type QuickAddResponse = z.infer<typeof quickAddResponseSchema>;

// Users admin ( — registration closes after the first user)

/**
 * The username is the identity a person types; it is deliberately free-form,
 * because a workshop's naming habits are not ours to legislate — `jm`, `Anna.R`,
 * `torn-nit` and `Müller` are all reasonable. Only three rules survive:
 *
 * - no `@`, because sign-in decides between the username and the email route
 *   by looking for one (and because a username must never look like an address);
 * - no leading, trailing or doubled whitespace, which is invisible and
 *   therefore impossible to type back correctly;
 * - no control characters.
 *
 * Matching is case-insensitive (better-auth lower-cases for lookup and keeps
 * the original spelling for display), so `Anna` and `anna` are one account.
 */
export const USERNAME_MAX = 40;
export function usernameProblem(value: string): 'empty' | 'at' | 'spacing' | 'control' | null {
  if (value.length === 0 || value.length > USERNAME_MAX) return 'empty';
  if (value.includes('@')) return 'at';
  if (value !== value.trim() || /\s\s/.test(value)) return 'spacing';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return 'control';
  return null;
}
export const usernameSchema = z
  .string()
  .min(2)
  .max(USERNAME_MAX)
  .refine((value) => usernameProblem(value) === null, {
    message: 'Usernames cannot contain @, control characters or stray spaces',
  });

/**
 * better-auth requires every account to carry an email, and this app does not:
 * a workshop hands out logins at the bench, and half the people who need one have no
 * mailbox worth typing. So an account without an address gets a placeholder in
 * a domain that can never resolve — `.invalid` is reserved by RFC 2606 for
 * exactly this — and the app treats it as "no email" everywhere a human looks.
 *
 * The day this is wired to Outlook, a real address simply replaces it and
 * nothing else has to change.
 */
export const PLACEHOLDER_EMAIL_DOMAIN = 'no-mail.invalid';

export function isPlaceholderEmail(email: string | null | undefined): boolean {
  return typeof email === 'string' && email.endsWith(`@${PLACEHOLDER_EMAIL_DOMAIN}`);
}

/** A readable, unique, permanently undeliverable address for `anna-r`. */
export function placeholderEmail(username: string, unique: string): string {
  const slug = username.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${slug || 'user'}.${unique}@${PLACEHOLDER_EMAIL_DOMAIN}`;
}

export const appUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Null when the account has no real address — see `isPlaceholderEmail`. */
  email: z.string().nullable(),
  username: z.string().nullish(),
  role: z.enum(USER_ROLES),
  createdAt: z.iso.datetime(),
  /** Whether this person has a fast-login chord (never the chord itself). */
  hasFastKey: z.boolean().default(false),
});
export type AppUser = z.infer<typeof appUserSchema>;

export const userCreateSchema = z.object({
  name: z.string().min(1),
  username: usernameSchema,
  /** Optional, and kept only so the account can be linked to a mailbox later. */
  email: z.email().nullish(),
  password: z.string().min(8),
  role: z.enum(USER_ROLES),
});
export type UserCreate = z.infer<typeof userCreateSchema>;

export const userRoleUpdateSchema = z.object({ role: z.enum(USER_ROLES) });

// Passwords. Changing your own requires proving you know the current one;
// an admin resetting someone else's does not (that is the point of a reset).
export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});
export const passwordResetSchema = z.object({ newPassword: z.string().min(8) });

// ---------------------------------------------------------------------------
// Fast login — a key chord instead of typing a name and a password
// ---------------------------------------------------------------------------

/**
 * A chord is two groups of keys, each held down together for a moment:
 * `"d+e+w x+c+v"`. Groups are separated by a space, keys within a group by
 * `+` and sorted, so a chord has exactly one written form no matter which
 * finger landed first. Keys are single lower-case letters (`KeyD` → `d`),
 * which is what makes the same chord work on a Catalan, German or English
 * keyboard: it is the *position*, not the character.
 */
export const chordSchema = z
  .string()
  .regex(/^[a-z](\+[a-z])* [a-z](\+[a-z])*$/, 'Not a chord: expected "a+s+d f+g+h"');

export const fastKeySchema = z.object({
  /** Null when this person has no chord yet. */
  chord: z.string().nullable(),
  createdAt: z.iso.datetime().nullable(),
});
export type FastKey = z.infer<typeof fastKeySchema>;

export const fastKeySignInSchema = z.object({ chord: chordSchema });

// ---------------------------------------------------------------------------
// Trash — soft-deleted rows, restorable by an admin
// ---------------------------------------------------------------------------

export const TRASH_ENTITIES = [
  'concept',
  'analogous',
  'variant',
  'item',
  'location',
  'type',
  // — these have always been deletable; without them here, deleting one
  // made it vanish with no way back, which is worse than not deleting at all.
  'request',
  'lot',
  'supplier',
  'action',
  'pool',
] as const;
export type TrashEntity = (typeof TRASH_ENTITIES)[number];

export const trashRowSchema = z.object({
  entityType: z.enum(TRASH_ENTITIES),
  id: z.string(),
  humanId: z.string(), // code for locations, key for types
  label: translatedTextSchema.nullable(),
  deletedAt: z.iso.datetime(),
  /** Why restoring is currently impossible, if it is. */
  blockedBy: z.string().nullable(),
});
export type TrashRow = z.infer<typeof trashRowSchema>;

// ---------------------------------------------------------------------------
// CSV import (export is a plain text/csv download, no schema needed)
// ---------------------------------------------------------------------------

export const csvImportSchema = z.object({
  csv: z.string().min(1),
  /** Parse and report without writing anything. */
  dryRun: z.boolean().default(false),
});

export const csvImportResultSchema = z.object({
  created: z.number().int(),
  rows: z.number().int(),
  errors: z.array(z.object({ row: z.number().int(), message: z.string() })),
  humanIds: z.array(z.string()),
});
export type CsvImportResult = z.infer<typeof csvImportResultSchema>;
