import type { ThemeColorsValue } from '@inventory/shared';

// Reading a theme out of a logo.
//
// Nobody wants to pick three hex values. Almost everybody already has a logo,
// and a logo is a colour decision somebody made on purpose — so the honest
// shortcut is to read that decision back out and offer it.
//
// The app's surfaces are dark and tinted by the primary (styles/index.css), so
// a colour taken raw from an image is usually wrong for the job: a brand navy
// disappears into the background and a brand pastel washes it out. Every
// extracted hue is therefore kept but re-lit, three ways, and the person picks
// which reading they like. What survives from the logo is the hue — which is
// what anybody actually recognises as "our colour".

// --------------------------------------------------------------- conversions

interface Hsl {
  h: number; // 0–360
  s: number; // 0–1
  l: number; // 0–1
}

function rgbToHsl(r: number, g: number, b: number): Hsl {
  const rf = r / 255;
  const gf = g / 255;
  const bf = b / 255;
  const max = Math.max(rf, gf, bf);
  const min = Math.min(rf, gf, bf);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rf) h = ((gf - bf) / d + (gf < bf ? 6 : 0)) * 60;
  else if (max === gf) h = ((bf - rf) / d + 2) * 60;
  else h = ((rf - gf) / d + 4) * 60;
  return { h, s, l };
}

function hslToHex({ h, s, l }: Hsl): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0] :
    hp < 2 ? [x, c, 0] :
    hp < 3 ? [0, c, x] :
    hp < 4 ? [0, x, c] :
    hp < 5 ? [x, 0, c] :
    [c, 0, x];
  const m = l - c / 2;
  const channel = (v: number) =>
    Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${channel(r1)}${channel(g1)}${channel(b1)}`;
}

// ------------------------------------------------------------------ sampling

/** How the three schemes re-light whatever hues came out of the image. */
const SCHEMES = {
  calm: { s: 0.5, l: 0.62 },
  bright: { s: 0.85, l: 0.66 },
  deep: { s: 0.62, l: 0.5 },
} as const;

export type SchemeName = keyof typeof SCHEMES;
export const SCHEME_NAMES = Object.keys(SCHEMES) as SchemeName[];

/**
 * The hues in an image, most-used first.
 *
 * Pixels are bucketed by hue rather than clustered properly (k-means and
 * friends): a logo has three or four flat colours, not a photograph's
 * gradient, and 24 buckets of 15° separates them perfectly well while staying
 * a single pass anybody can read.
 *
 * Skipped: anything transparent (the space around the mark), anything too grey
 * to have a hue at all, and anything nearly black or nearly white. Those are
 * almost always the background and the lettering, and taking them would give
 * every logo in the world the same grey theme.
 */
function dominantHues(pixels: Uint8ClampedArray): number[] {
  const BUCKETS = 24;
  const weight = new Float64Array(BUCKETS);
  const hueSum = new Float64Array(BUCKETS);

  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3]!;
    if (alpha < 128) continue;
    const { h, s, l } = rgbToHsl(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!);
    if (s < 0.18 || l < 0.08 || l > 0.94) continue;
    // Saturated pixels count for more: a small vivid mark on a pale field is
    // the brand, and the pale field is paper.
    const w = s * (1 - Math.abs(l - 0.5));
    const bucket = Math.floor((h / 360) * BUCKETS) % BUCKETS;
    weight[bucket]! += w;
    hueSum[bucket]! += h * w;
  }

  return [...weight.keys()]
    .filter((bucket) => weight[bucket]! > 0)
    .sort((a, b) => weight[b]! - weight[a]!)
    .map((bucket) => hueSum[bucket]! / weight[bucket]!);
}

/** Circular distance between two hues, 0–180. */
function hueGap(a: number, b: number): number {
  const raw = Math.abs(a - b) % 360;
  return raw > 180 ? 360 - raw : raw;
}

/**
 * Three hues far enough apart to read as three colours.
 *
 * A single-colour logo is the common case, so when the image cannot supply
 * three separated hues the rest are derived from the first by rotating around
 * the wheel — a triad, which is a real colour-theory answer rather than an
 * apology.
 */
function threeHues(found: number[]): [number, number, number] {
  const base = found[0] ?? 190; // nothing usable → the app's own teal
  const picked = [base];
  for (const hue of found.slice(1)) {
    if (picked.length === 3) break;
    if (picked.every((chosen) => hueGap(chosen, hue) >= 40)) picked.push(hue);
  }
  while (picked.length < 3) picked.push(base + picked.length * 130);
  return [picked[0]!, picked[1]!, picked[2]!];
}

export interface LogoPalette {
  /** Empty when the image had no colour worth using. */
  schemes: Record<SchemeName, ThemeColorsValue>;
  found: boolean;
}

/**
 * Load an image (any `data:` URI, including SVG) and read a palette out of it.
 *
 * Drawn into a 64×64 canvas first: it is enough pixels to find flat brand
 * colours, and it makes the cost independent of whatever size the file
 * happens to be. The canvas stays untainted because the source is a data URI
 * from this same page, so `getImageData` is allowed.
 */
export async function paletteFromImage(dataUri: string): Promise<LogoPalette> {
  const image = await loadImage(dataUri);
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return emptyPalette();
  context.drawImage(image, 0, 0, 64, 64);

  let pixels: Uint8ClampedArray;
  try {
    pixels = context.getImageData(0, 0, 64, 64).data;
  } catch {
    // A tainted canvas should be impossible from a data URI, but a failure
    // here must degrade to "pick the colours by hand", never to a crash.
    return emptyPalette();
  }

  const hues = dominantHues(pixels);
  const [h1, h2, h3] = threeHues(hues);

  const schemes = {} as Record<SchemeName, ThemeColorsValue>;
  for (const name of SCHEME_NAMES) {
    const { s, l } = SCHEMES[name];
    schemes[name] = {
      primary: hslToHex({ h: h1, s, l }),
      // The other two are nudged apart so the three never read as one colour
      // at three brightnesses.
      secondary: hslToHex({ h: h2, s: s * 0.95, l: l + 0.04 }),
      accent: hslToHex({ h: h3, s: Math.min(1, s * 1.05), l: l - 0.02 }),
    };
  }
  return { schemes, found: hues.length > 0 };
}

function emptyPalette(): LogoPalette {
  const schemes = {} as Record<SchemeName, ThemeColorsValue>;
  for (const name of SCHEME_NAMES) {
    const { s, l } = SCHEMES[name];
    schemes[name] = {
      primary: hslToHex({ h: 190, s, l }),
      secondary: hslToHex({ h: 320, s: s * 0.95, l: l + 0.04 }),
      accent: hslToHex({ h: 60, s, l }),
    };
  }
  return { schemes, found: false };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('bad-image'));
    image.src = src;
  });
}

// ------------------------------------------------------------------ shrinking

/** Anything above this is re-encoded before it ever reaches the server. */
const MAX_EDGE = 320;

/**
 * Read a picked file into a `data:` URI, shrinking it if it is a photograph
 * somebody dragged in by mistake.
 *
 * SVG is passed through untouched: it is already small, it is already vector,
 * and rasterising it to 320px would make the one format that scales stop
 * scaling.
 */
export async function fileToLogo(file: File): Promise<string> {
  const original = await readAsDataUri(file);
  if (file.type === 'image/svg+xml') return original;

  const image = await loadImage(original);
  const scale = Math.min(1, MAX_EDGE / Math.max(image.width, image.height));
  if (scale === 1 && original.length < 200_000) return original;

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const context = canvas.getContext('2d');
  if (!context) return original;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  // PNG, not JPEG: logos have flat colour and hard edges, which is exactly
  // what JPEG is worst at, and transparency, which JPEG cannot carry at all.
  return canvas.toDataURL('image/png');
}

function readAsDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('unreadable'));
    reader.readAsDataURL(file);
  });
}
