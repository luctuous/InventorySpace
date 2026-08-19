import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useBranding } from '../api/branding';

// The 3 configurable colors. The CSS in styles/index.css holds
// the same defaults, so the app renders correctly before React mounts and
// when nothing is stored — this provider only *overrides* on top.
//
// There are now two sources, in this order of precedence:
//
//   1. this browser's own choice (localStorage) — a personal override;
//   2. the workshop's colours, set by an admin and stored in the database;
//   3. the built-in palette in the CSS.
//
// Personal beats institutional on purpose. The workshop's look is the default
// everybody gets without doing anything, not a lock — somebody who needs more
// contrast at their own bench should not have to ask permission for it.

export interface ThemeColors {
  primary: string;
  secondary: string;
  accent: string;
}

export const DEFAULT_COLORS: ThemeColors = {
  primary: '#2dd4bf',
  secondary: '#a78bfa',
  accent: '#fb923c',
};

const STORAGE_KEY = 'theme-colors';
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** WCAG relative luminance of a #rrggbb color (0 = black, 1 = white). */
function relativeLuminance(hex: string): number {
  const channel = (i: number) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/**
 * Users pick arbitrary colors, so the text on a primary button must be
 * computed: light colors get near-black text, dark colors get near-white.
 */
export function contrastForeground(hex: string): string {
  return relativeLuminance(hex) > 0.35 ? '#0c1013' : '#f5f7fa';
}

function applyColors(colors: ThemeColors): void {
  const style = document.documentElement.style;
  style.setProperty('--color-primary-base', colors.primary);
  style.setProperty('--color-secondary-base', colors.secondary);
  style.setProperty('--color-accent-base', colors.accent);
  style.setProperty('--primary-foreground', contrastForeground(colors.primary));
  style.setProperty('--secondary-foreground', contrastForeground(colors.secondary));
  style.setProperty('--accent-foreground', contrastForeground(colors.accent));
}

function clearColors(): void {
  const style = document.documentElement.style;
  for (const prop of [
    '--color-primary-base',
    '--color-secondary-base',
    '--color-accent-base',
    '--primary-foreground',
    '--secondary-foreground',
    '--accent-foreground',
  ]) {
    style.removeProperty(prop); // CSS defaults take over again
  }
}

function loadStored(): ThemeColors | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ThemeColors>;
    if (
      HEX_RE.test(parsed.primary ?? '') &&
      HEX_RE.test(parsed.secondary ?? '') &&
      HEX_RE.test(parsed.accent ?? '')
    ) {
      return parsed as ThemeColors;
    }
  } catch {
    // corrupted storage → fall back to defaults
  }
  return null;
}

interface ThemeContextValue {
  colors: ThemeColors;
  /** Whether what is on screen is this browser's own choice or the workshop's. */
  personal: boolean;
  /** The workshop's colours, or null when nobody has set any. */
  labColors: ThemeColors | null;
  /** Keep these colours on this computer only. */
  setColors: (colors: ThemeColors) => void;
  /** Preview without storing anything — used while a dialog is open. */
  previewColors: (colors: ThemeColors | null) => void;
  /** Drop the personal override and go back to the workshop's look. */
  resetColors: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const branding = useBranding();
  const [personalColors, setPersonalColors] = useState<ThemeColors | null>(loadStored);
  const [preview, setPreview] = useState<ThemeColors | null>(null);

  const labColors = branding.data?.colors ?? null;
  const colors = preview ?? personalColors ?? labColors ?? DEFAULT_COLORS;

  // One effect for all three sources. Re-runs when the workshop's colours arrive
  // from the server, which is the whole reason a computer that has never
  // opened the colour menu still ends up wearing the workshop's look.
  useEffect(() => {
    if (personalColors ?? labColors ?? preview) applyColors(colors);
    else clearColors();
  }, [colors, labColors, personalColors, preview]);

  const setColors = (next: ThemeColors) => {
    setPreview(null);
    setPersonalColors(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  };

  const resetColors = () => {
    setPreview(null);
    setPersonalColors(null);
    localStorage.removeItem(STORAGE_KEY);
  };

  return (
    <ThemeContext.Provider
      value={{
        colors,
        personal: personalColors !== null,
        labColors,
        setColors,
        previewColors: setPreview,
        resetColors,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}
