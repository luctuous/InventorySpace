import { eq } from 'drizzle-orm';
import { DEFAULT_BRANDING, brandingSchema } from '@inventory/shared';
import type { Branding } from '@inventory/shared';
import { db } from '../db/client';
import { settings } from '../db/schema';

// Read/write side of the settings table. Everything the workshop has configured
// about itself goes through here, so there is exactly one place that knows
// what a missing row means (the built-in default, never an error).

const BRANDING_KEY = 'branding';

/**
 * Stored JSON is trusted less than freshly-posted JSON: it may predate a schema
 * change, or have been edited with a SQLite browser at two in the morning.
 * Anything that no longer parses falls back to the built-in look rather than
 * throwing — a bad logo must never be able to take the whole app down.
 */
export function readBranding(): Branding {
  const row = db.select().from(settings).where(eq(settings.key, BRANDING_KEY)).get();
  if (!row) return DEFAULT_BRANDING;
  const parsed = brandingSchema.safeParse(row.value);
  return parsed.success ? parsed.data : DEFAULT_BRANDING;
}

export function writeBranding(next: Branding, userId: string): Branding {
  db.insert(settings)
    .values({ key: BRANDING_KEY, value: next, updatedBy: userId })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: next, updatedBy: userId, updatedAt: new Date() },
    })
    .run();
  return next;
}
