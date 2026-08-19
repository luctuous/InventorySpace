import { useEffect, useRef, useState } from 'react';
import { Building2, Image as ImageIcon, Monitor, Palette, RotateCcw, Trash2, Upload } from 'lucide-react';
import { LOGO_MAX_CHARS, roleAtLeast } from '@inventory/shared';
import type { ThemeColorsValue } from '@inventory/shared';
import { asSessionUser, authClient } from '../api/auth';
import { useBranding, useSaveBranding } from '../api/branding';
import { ApiRequestError } from '../api/client';
import { DEFAULT_COLORS, useTheme } from '../theme/ThemeProvider';
import type { ThemeColors } from '../theme/ThemeProvider';
import { useI18n } from '../i18n';
import { cn } from '../lib/cn';
import { SCHEME_NAMES, fileToLogo, paletteFromImage } from '../lib/palette';
import type { SchemeName } from '../lib/palette';
import { useToast } from './toast';
import { Button, Input, Label, Modal, Spinner } from './ui';

// The look menu. Two halves that used to be one:
//
//   · the workshop's own look — logo, name, colours — set once by an admin and seen
//     on every computer, including the ones nobody will ever open this on;
//   · a personal override, kept in this browser, for whoever wants it.
//
// Everything still comes down to three colours; color-mix() in the CSS derives
// the other thirty. The logo is here rather than in a separate settings page
// because picking colours out of it is the fastest way anybody will ever set a
// theme, and the two belong next to each other.

const PRESETS: Array<{ name: string; colors: ThemeColors }> = [
  { name: 'Teal', colors: DEFAULT_COLORS },
  { name: 'Ocean', colors: { primary: '#38bdf8', secondary: '#818cf8', accent: '#f472b6' } },
  { name: 'Forest', colors: { primary: '#4ade80', secondary: '#facc15', accent: '#22d3ee' } },
  { name: 'Ember', colors: { primary: '#fb7185', secondary: '#fbbf24', accent: '#a78bfa' } },
];

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (hex: string) => void;
}) {
  return (
    <label className="flex items-center gap-3">
      <input
        type="color"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 w-14 cursor-pointer rounded border border-line bg-surface"
      />
      <span className="flex-1 text-sm text-text">{label}</span>
      <span className="font-mono text-xs uppercase text-muted">{value}</span>
    </label>
  );
}

function Swatches({ colors }: { colors: ThemeColorsValue }) {
  return (
    <span className="flex gap-1">
      {[colors.primary, colors.secondary, colors.accent].map((hex) => (
        <span key={hex} className="h-4 w-4 rounded-full" style={{ background: hex }} />
      ))}
    </span>
  );
}

export function ThemeMenu() {
  const { t } = useI18n();
  const toast = useToast();
  const { data: session } = authClient.useSession();
  const { colors, personal, labColors, setColors, previewColors, resetColors } = useTheme();
  const branding = useBranding();
  const saveBranding = useSaveBranding();
  const fileRef = useRef<HTMLInputElement>(null);

  const [open, setOpen] = useState(false);
  const [logo, setLogo] = useState<string | null>(null);
  const [labName, setLabName] = useState('');
  const [schemes, setSchemes] = useState<Record<SchemeName, ThemeColorsValue> | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const user = session ? asSessionUser(session.user) : null;
  const isAdmin = user !== null && roleAtLeast(user.role, 'admin');

  // Opening the dialog starts from what is actually saved, so cancelling by
  // pressing Escape cannot leave half-edited branding behind.
  useEffect(() => {
    if (!open) return;
    setLogo(branding.data?.logo ?? null);
    setLabName(branding.data?.name ?? '');
    setSchemes(null);
    setError(null);
  }, [open, branding.data]);

  // A preview is a live change to the whole app, so it must not outlive the
  // dialog that started it.
  useEffect(() => {
    if (!open) previewColors(null);
  }, [open, previewColors]);

  const pickFile = async (file: File) => {
    setError(null);
    setReading(true);
    try {
      const dataUri = await fileToLogo(file);
      if (dataUri.length > LOGO_MAX_CHARS) {
        setError(t('theme.logoTooBig'));
        return;
      }
      setLogo(dataUri);
      const palette = await paletteFromImage(dataUri);
      setSchemes(palette.schemes);
      if (!palette.found) setError(t('theme.noColours'));
    } catch {
      setError(t('theme.logoBadType'));
    } finally {
      setReading(false);
    }
  };

  const saveForLab = async () => {
    setError(null);
    try {
      await saveBranding.mutateAsync({
        logo,
        name: labName.trim() || null,
        // Whatever is on screen right now is what "the workshop's colours" means —
        // including a preview the admin is looking at and likes.
        colors,
      });
      // Their own override would otherwise hide the thing they just published
      // from the one person who needs to see it worked.
      resetColors();
      toast({ message: t('theme.savedForLab'), variant: 'success' });
      setOpen(false);
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : String(caught));
    }
  };

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        data-tour="theme"
        title={t('theme.title')}
        onClick={() => setOpen(true)}
      >
        <Palette className="h-4 w-4" />
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title={t('theme.title')}>
        <div className="space-y-5">
          {/* ------------------------------------------------ the workshop's look */}
          <section className="space-y-3">
            <h3 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted">
              <Building2 className="h-3.5 w-3.5" /> {t('theme.brand')}
            </h3>

            {isAdmin ? (
              <>
                <div className="flex items-center gap-3">
                  <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-2">
                    {reading ? (
                      <Spinner className="h-5 w-5" />
                    ) : logo ? (
                      <img src={logo} alt="" className="max-h-14 max-w-14 object-contain" />
                    ) : (
                      <ImageIcon className="h-5 w-5 text-muted" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
                        <Upload className="h-4 w-4" />
                        {logo ? t('theme.logoReplace') : t('theme.logoPick')}
                      </Button>
                      {logo && (
                        <Button size="sm" variant="ghost" onClick={() => { setLogo(null); setSchemes(null); }}>
                          <Trash2 className="h-4 w-4" /> {t('theme.logoRemove')}
                        </Button>
                      )}
                    </div>
                    <p className="text-xs text-muted">{t('theme.logoHint')}</p>
                  </div>
                </div>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/svg+xml"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    // Reset so picking the same file twice fires again.
                    event.target.value = '';
                    if (file) void pickFile(file);
                  }}
                />

                <div>
                  <Label htmlFor="site-name">{t('theme.labName')}</Label>
                  <Input
                    id="site-name"
                    value={labName}
                    onChange={(event) => setLabName(event.target.value)}
                    placeholder={t('app.name')}
                  />
                  <p className="mt-1 text-xs text-muted">{t('theme.labNameHint')}</p>
                </div>

                {schemes && (
                  <div>
                    <p className="mb-1.5 text-xs text-muted">{t('theme.fromLogoHint')}</p>
                    <div className="space-y-1.5">
                      {SCHEME_NAMES.map((name) => (
                        <button
                          key={name}
                          onClick={() => setColors(schemes[name])}
                          onMouseEnter={() => previewColors(schemes[name])}
                          onMouseLeave={() => previewColors(null)}
                          className="flex w-full items-center gap-3 rounded-md border border-line px-3 py-2 text-sm text-text hover:bg-surface-2 cursor-pointer"
                        >
                          <Swatches colors={schemes[name]} />
                          {t(`theme.scheme${name[0]!.toUpperCase()}${name.slice(1)}`)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <p className="flex items-center gap-2.5 rounded-md bg-surface-2 px-3 py-2 text-xs text-muted">
                {branding.data?.logo && (
                  <img src={branding.data.logo} alt="" className="h-6 w-auto max-w-16 object-contain" />
                )}
                {t('theme.adminOnly')}
              </p>
            )}
          </section>

          {/* ----------------------------------------------- personal colours */}
          <section className="space-y-3 border-t border-line pt-4">
            <h3 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted">
              <Monitor className="h-3.5 w-3.5" /> {t('theme.onlyMine')}
            </h3>
            <p className="text-xs text-muted">{t('theme.onlyMineHint')}</p>

            <div className="space-y-2.5">
              <ColorField
                label={t('theme.primary')}
                value={colors.primary}
                onChange={(primary) => setColors({ ...colors, primary })}
              />
              <ColorField
                label={t('theme.secondary')}
                value={colors.secondary}
                onChange={(secondary) => setColors({ ...colors, secondary })}
              />
              <ColorField
                label={t('theme.accent')}
                value={colors.accent}
                onChange={(accent) => setColors({ ...colors, accent })}
              />
            </div>

            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
                {t('theme.presets')}
              </p>
              <div className="grid grid-cols-2 gap-2">
                {PRESETS.map((preset) => (
                  <button
                    key={preset.name}
                    onClick={() => setColors(preset.colors)}
                    onMouseEnter={() => previewColors(preset.colors)}
                    onMouseLeave={() => previewColors(null)}
                    className="flex items-center gap-2 rounded-md border border-line px-3 py-2 text-sm text-text hover:bg-surface-2 cursor-pointer"
                  >
                    <Swatches colors={preset.colors} />
                    {preset.name}
                  </button>
                ))}
              </div>
            </div>

            {/* Only offered when there is something to go back to. */}
            {personal && (
              <Button variant="ghost" size="sm" onClick={resetColors}>
                <RotateCcw className="h-4 w-4" />
                {labColors ? t('theme.useLab') : t('theme.reset')}
              </Button>
            )}
          </section>

          {error && <p className="text-sm text-danger">{error}</p>}

          <div className="flex flex-wrap justify-between gap-2 border-t border-line pt-4">
            {isAdmin ? (
              <Button onClick={() => void saveForLab()} disabled={saveBranding.isPending}>
                <Building2 className="h-4 w-4" /> {t('theme.forEveryone')}
              </Button>
            ) : (
              <span />
            )}
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t('common.close')}
            </Button>
          </div>
          {isAdmin && <p className={cn('text-xs text-muted')}>{t('theme.forEveryoneHint')}</p>}
        </div>
      </Modal>
    </>
  );
}
