import { useState } from 'react';
import { useNavigate } from 'react-router';
import { AlertTriangle, Boxes, KeySquare, Lock, LogIn, PackageOpen, X } from 'lucide-react';
import { resolveText } from '@inventory/shared';
import { useBranding, usePublicHome } from '../api/branding';
import { LocationTree } from '../components/LocationTree';
import { ResizablePanel } from '../components/ResizablePanel';
import { Button, Spinner } from '../components/ui';
import { LanguagePicker } from '../components/Layout';
import { useI18n } from '../i18n';
import { cn } from '../lib/cn';

// The noticeboard: what the workshop has, readable by anyone who opens the address,
// with no account and no password.
//
// This is a real decision, not a convenience. Everything on this page — names,
// quantities, the location tree — is visible to anybody who can reach the
// server, which on a workshop network is everyone in the building. It carries no
// item rows: no serial numbers, no batch numbers, no prices, no notes, and no
// names of people. The server enforces that (routes/public.ts); this page just
// cannot ask for more.
//
// Everything else needs a session. Clicking a card does not open it — it asks
// you to sign in, which is the honest answer to "why can't I do anything".

type StockLevel = 'ok' | 'low' | 'zero';

function levelOf(stock: number, threshold: number | null): StockLevel {
  if (stock <= 0) return 'zero';
  if (threshold !== null && stock < threshold) return 'low';
  return 'ok';
}

export function PublicHomePage() {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const branding = useBranding();
  const [locationId, setLocationId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const home = usePublicHome(locationId);

  const signIn = () => navigate('/login');

  const concepts = (home.data?.concepts ?? []).filter((concept) => {
    const term = search.trim().toLowerCase();
    if (!term) return true;
    return resolveText(concept.name, locale).toLowerCase().includes(term);
  });
  const lowCount = concepts.filter(
    (concept) => levelOf(concept.stock, concept.minStockThreshold) !== 'ok',
  ).length;
  const activeLocation = home.data?.locations.find((row) => row.id === locationId);

  return (
    // data-chord-ok: the key chord is read here even from inside the search
    // box. Same reason as the sign-in form (see lib/chord.ts): this page tells
    // people to press their chord, and the search box is the only thing on it
    // you can click into — so the one field somebody's cursor lands in would
    // otherwise be the one place the shortcut silently does nothing.
    <div className="min-h-dvh bg-bg" data-chord-ok>
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
          {branding.data?.logo ? (
            <img src={branding.data.logo} alt="" className="h-8 w-auto max-w-40 object-contain" />
          ) : (
            <Boxes className="h-7 w-7 text-primary" />
          )}
          {/* The workshop's name, or the product's — never the page's heading, which
              is already two centimetres below and says the same thing. */}
          <span className="text-lg font-semibold text-text">
            {branding.data?.name ?? t('app.name')}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <LanguagePicker />
            <Button onClick={signIn}>
              <LogIn className="h-4 w-4" /> {t('auth.signIn')}
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold text-text">{t('home.publicTitle')}</h1>
            <p className="mt-0.5 text-sm text-muted">{t('home.publicSubtitle')}</p>
          </div>
          {/* The chord works here too: pressing yours is the fastest way in,
              and this is the screen where somebody would think to try it. */}
          <p className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-xs text-muted">
            <KeySquare className="h-3.5 w-3.5 shrink-0" />
            {t('fastKey.loginHint')}
          </p>
        </div>

        {home.isPending ? (
          <div className="flex justify-center py-20"><Spinner /></div>
        ) : (
          <>
            <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-3">
              <Metric label={t('home.activeConcepts')} value={concepts.length} />
              <Metric label={t('home.activeItems')} value={home.data?.metrics.activeItems ?? 0} />
              <Metric label={t('home.lowStockCount')} value={lowCount} alert={lowCount > 0} />
            </div>

            <div className="flex flex-col gap-5 lg:flex-row">
              <ResizablePanel
                storageKey="home-tree-width"
                defaultWidth={240}
                label={t('home.resizeHint')}
              >
                <aside className="h-fit min-w-0 overflow-x-auto rounded-lg border border-line bg-surface/40 p-3">
                  <p className="mb-2 px-1 text-xs font-medium uppercase tracking-wide text-muted">
                    {t('nav.locations')}
                  </p>
                  <LocationTree
                    locations={home.data?.locations ?? []}
                    selectedId={locationId}
                    showCounts
                    onSelect={(node) => setLocationId(node.id === locationId ? null : node.id)}
                  />
                </aside>
              </ResizablePanel>

              <div className="min-w-0 flex-1">
                <div className="mb-3 flex flex-wrap items-center gap-3">
                  <input
                    className="h-9 w-full max-w-xs rounded-md border border-line bg-surface px-3 text-sm text-text placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    placeholder={t('common.search')}
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                  {activeLocation && (
                    <button
                      className="flex items-center gap-1.5 rounded-full bg-primary-tint px-2.5 py-1 text-xs text-primary cursor-pointer"
                      onClick={() => setLocationId(null)}
                    >
                      <span className="font-mono">{activeLocation.code}</span>
                      <span>{resolveText(activeLocation.name, locale)}</span>
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>

                {concepts.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-line py-16 text-center">
                    <PackageOpen className="mx-auto mb-3 h-8 w-8 text-muted" />
                    <p className="text-sm text-muted">{t('common.empty')}</p>
                  </div>
                ) : (
                  <div className="grid auto-rows-min grid-cols-[repeat(auto-fill,minmax(19rem,1fr))] gap-2.5">
                    {concepts.map((concept) => {
                      const level = levelOf(concept.stock, concept.minStockThreshold);
                      return (
                        <button
                          key={concept.id}
                          onClick={signIn}
                          title={t('home.publicAction')}
                          className={cn(
                            'flex h-fit w-full flex-col gap-1.5 rounded-lg border border-l-4 bg-surface px-4 py-3 text-left cursor-pointer hover:bg-surface-2',
                            level === 'zero'
                              ? 'border-l-danger border-line'
                              : level === 'low'
                                ? 'border-l-warning border-line'
                                : 'border-l-success/50 border-line',
                          )}
                        >
                          {/* Same two-row card as the signed-in Home — see the
                              note there about names being the thing that must
                              not get squeezed out. */}
                          <span className="flex w-full items-start gap-2">
                            <Lock className="mt-1 h-3.5 w-3.5 shrink-0 text-muted" />
                            <span className="human-id mt-0.5 shrink-0">{concept.humanId}</span>
                            <span className="min-w-0 flex-1 text-text">
                              {resolveText(concept.name, locale)}
                            </span>
                          </span>
                          <span className="flex w-full items-baseline gap-2 pl-6">
                            <span
                              className={cn(
                                'font-mono text-lg',
                                level === 'zero'
                                  ? 'text-danger'
                                  : level === 'low'
                                    ? 'text-warning'
                                    : 'text-text',
                              )}
                            >
                              {concept.stock} {concept.unit}
                            </span>
                            {concept.minStockThreshold !== null && (
                              <span className="font-mono text-xs text-muted">
                                / min {concept.minStockThreshold}
                              </span>
                            )}
                            {level !== 'ok' && (
                              <span
                                className={cn(
                                  'ml-auto flex shrink-0 items-center gap-1 text-xs',
                                  level === 'zero' ? 'text-danger' : 'text-warning',
                                )}
                              >
                                <AlertTriangle className="h-3.5 w-3.5" />
                                {level === 'zero' ? t('home.outOfStock') : t('home.lowStock')}
                              </span>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}

                <p className="mt-5 flex items-center justify-center gap-2 rounded-lg border border-dashed border-line py-4 text-sm text-muted">
                  <Lock className="h-4 w-4" />
                  {t('home.publicAction')}
                </p>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function Metric({ label, value, alert }: { label: string; value: number; alert?: boolean }) {
  return (
    <div
      className={cn(
        'rounded-lg border bg-surface px-4 py-3',
        alert ? 'border-warning/40 bg-warning-tint' : 'border-line',
      )}
    >
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className={cn('mt-1 font-mono text-2xl', alert ? 'text-warning' : 'text-text')}>{value}</p>
    </div>
  );
}
