import { z } from 'zod';

// ---------------------------------------------------------------------------
// The workshop's own look: a logo and the three colours the rest of the theme is
// derived from.
//
// This is deliberately ONE site-wide record rather than a per-browser
// preference. A logo is the institution's, not the machine's: the person who
// uploads it does so once and every computer in the workshop shows it, including
// the ones nobody will ever open a settings menu on. A private per-browser
// override still exists on top (theme/ThemeProvider) for anyone who wants
// their own colours — the workshop record is the default, not a lock.
// ---------------------------------------------------------------------------

export const hexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use a #rrggbb colour');

export const themeColorsSchema = z.object({
  primary: hexColorSchema,
  secondary: hexColorSchema,
  accent: hexColorSchema,
});
export type ThemeColorsValue = z.infer<typeof themeColorsSchema>;

/**
 * The logo travels as a `data:` URI inside the JSON, not as a file on disk.
 *
 * The whole product is "one file you can copy" — a backup is the
 * SQLite file and nothing else. A logo living in an uploads/ directory beside
 * it would be the first thing to go missing when somebody copies the database
 * to a stick, so it goes IN the database. The cost is a size cap: an image
 * beyond a few hundred KB has no business being a logo, and the browser
 * downscales before it ever gets here.
 */
export const LOGO_MAX_CHARS = 400_000; // ≈ 300 KB of image after base64

export const logoSchema = z
  .string()
  .max(LOGO_MAX_CHARS, 'That image is too large — use one under 300 KB')
  .refine(
    (value) => /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(value),
    'Only PNG, JPEG, WebP or SVG images',
  );

export const brandingSchema = z.object({
  /** Shown beside the logo in the sidebar; null keeps the built-in name. */
  name: z.string().max(60).nullable(),
  logo: logoSchema.nullable(),
  /** Null = the built-in palette; the colour menu writes the rest. */
  colors: themeColorsSchema.nullable(),
});
export type Branding = z.infer<typeof brandingSchema>;

export const brandingUpdateSchema = brandingSchema.partial();
export type BrandingUpdate = z.infer<typeof brandingUpdateSchema>;

export const DEFAULT_BRANDING: Branding = { name: null, logo: null, colors: null };

// ---------------------------------------------------------------------------
// Sign-in policy. Lives here because both the API and the web
// client have to agree on the numbers to the millisecond.
// ---------------------------------------------------------------------------

/**
 * How long a shared computer may sit untouched before the session ends.
 *
 * A bench machine left signed in is the whole reason inventory records get
 * attributed to whoever walked away last. Twenty minutes is short enough that
 * a coffee break does not leave your account open, and long enough that
 * reading a protocol does not throw you out.
 *
 * A computer somebody has claimed with "remember this computer" is exempt —
 * that is the point of claiming it.
 */
export const IDLE_TIMEOUT_MS = 20 * 60 * 1000;

/** The last minute of the idle countdown, spent warning rather than acting. */
export const IDLE_WARNING_MS = 60 * 1000;
