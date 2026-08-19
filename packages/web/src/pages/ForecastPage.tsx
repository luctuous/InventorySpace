import { useState } from 'react';
import { ShoppingCart } from 'lucide-react';
import { resolveText, roleAtLeast } from '@inventory/shared';
import type { ForecastRow } from '@inventory/shared';
import { asSessionUser, authClient } from '../api/auth';
import { useForecast, useRequestAll } from '../api/operations';
import { useToast } from '../components/toast';
import { Button, Select, Spinner } from '../components/ui';
import { useI18n } from '../i18n';
import { cn } from '../lib/cn';

// Forecast. A forecast that produces a chart is useless: this
// page is a list that ends in one button, which closes the loop back to
// Requests and makes the whole cycle circular.

function RateExplanation({ row }: { row: ForecastRow }) {
  const { t } = useI18n();

  if (row.source === 'none') {
    return <span className="text-xs text-muted">{t('tracking.notEnough')}</span>;
  }

  return (
    <span className="text-xs text-muted">
      {/* The seed is kept and shown beside the measurement, so the user can
          watch their own estimate get corrected — that is the moment they
          start trusting the app. */}
      {row.seededMonthlyRate !== null && (
        <>
          {t('tracking.youSaid')}{' '}
          <span className={cn(row.source === 'measured' && 'line-through')}>
            {row.seededMonthlyRate}
          </span>
          {' · '}
        </>
      )}
      {row.measuredMonthlyRate !== null && (
        <>
          {t('tracking.measured')} {row.measuredMonthlyRate}
          {' · '}
        </>
      )}
      {t('tracking.using')} <span className="text-text">{row.monthlyRate}</span>/
      {t('lots.days') === 'days' ? 'mo' : 'M'}
      {row.depletionsObserved > 0 && (
        <>
          {' · '}
          {t('tracking.fromDepletions', {
            n: row.depletionsObserved,
            days: row.observedDays,
          })}
        </>
      )}
      {/* Per day the bottle stood open — a measurement, where splitting it
          across the activities in the window would have been a guess
. The sign carries two opposite meanings, so it gets two
          sentences rather than one with a minus in front of it. */}
      {row.overheadPerDay !== null && row.overheadPerDay !== 0 && (
        <>
          {' · '}
          <span className="text-accent">
            {row.overheadPerDay > 0
              ? t('tracking.overhead', { n: row.overheadPerDay, unit: row.unit })
              : t('tracking.overclaim', { n: -row.overheadPerDay, unit: row.unit })}
          </span>
        </>
      )}
    </span>
  );
}

export function ForecastPage() {
  const { t, locale } = useI18n();
  const toast = useToast();
  const { data: session } = authClient.useSession();
  const [reorderOnly, setReorderOnly] = useState(true);
  const [typeId, setTypeId] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const user = session ? asSessionUser(session.user) : null;
  const canRequest = user !== null && roleAtLeast(user.role, 'operator');

  const forecastQuery = useForecast(reorderOnly);
  const requestAll = useRequestAll();

  const all = forecastQuery.data?.rows ?? [];

  // Preparing an order is rarely "everything at once": it is the consumables,
  // or the supplies. The type filter is built from what is actually on the
  // list, so it never offers a type with nothing behind it.
  const typesPresent = new Map<string, string>();
  for (const row of all) {
    if (row.typeId && row.typeName) typesPresent.set(row.typeId, resolveText(row.typeName, locale));
  }

  const rows = typeId ? all.filter((row) => row.typeId === typeId) : all;
  const needing = rows.filter((row) => row.reorderNow && row.openRequestId === null);

  const toggle = (conceptId: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(conceptId)) next.delete(conceptId);
      else next.add(conceptId);
      return next;
    });

  const requestSelected = async (conceptIds: string[]) => {
    if (conceptIds.length === 0) return;
    const result = await requestAll.mutateAsync(conceptIds);
    toast({
      message: t('forecast.requested', { created: result.created, joined: result.joined }),
      variant: 'success',
    });
    setSelected(new Set());
  };

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-text">{t('forecast.title')}</h1>
          <p className="mt-0.5 text-sm text-muted">{t('forecast.subtitle')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {typesPresent.size > 1 && (
            <Select
              value={typeId}
              onChange={(e) => { setTypeId(e.target.value); setSelected(new Set()); }}
              className="w-auto"
            >
              <option value="">{t('forecast.allTypes')}</option>
              {[...typesPresent.entries()].map(([id, name]) => (
                <option key={id} value={id}>{name}</option>
              ))}
            </Select>
          )}
          <Button variant="outline" size="sm" onClick={() => setReorderOnly((v) => !v)}>
            {reorderOnly ? t('forecast.showAll') : t('forecast.showReorder')}
          </Button>
        </div>
      </div>

      {forecastQuery.isLoading ? (
        <Spinner />
      ) : (
        <>
          {/* The headline is a sentence, not a number. */}
          <div className="mb-4 rounded-lg border border-line bg-surface p-4">
            {needing.length > 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-lg text-text">
                  {t('forecast.reorderNow', { n: needing.length })}
                </p>
                {canRequest && (
                  <Button
                    onClick={() =>
                      requestSelected(
                        selected.size > 0
                          ? [...selected]
                          : needing.map((row) => row.conceptId),
                      )
                    }
                    disabled={requestAll.isPending}
                  >
                    <ShoppingCart className="h-4 w-4" />
                    {t('forecast.requestAll')}
                    {selected.size > 0 && ` (${selected.size})`}
                  </Button>
                )}
              </div>
            ) : (
              <p className="text-lg text-text">{t('forecast.allFine')}</p>
            )}
          </div>

          {rows.length === 0 ? (
            <p className="text-muted">{t('common.empty')}</p>
          ) : (
            <div data-tour="forecast-list" className="space-y-2">
              {rows.map((row) => (
                <div
                  key={row.conceptId}
                  className={cn(
                    'rounded-lg border bg-surface p-3',
                    row.reorderNow ? 'border-warning/50' : 'border-line',
                  )}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-2.5">
                      {canRequest && row.reorderNow && row.openRequestId === null && (
                        <input
                          type="checkbox"
                          className="mt-1 cursor-pointer"
                          checked={selected.has(row.conceptId)}
                          onChange={() => toggle(row.conceptId)}
                          aria-label={resolveText(row.conceptName, locale)}
                        />
                      )}
                      <div className="min-w-0">
                        <p className="truncate text-sm text-text">
                          {resolveText(row.conceptName, locale)}
                        </p>
                        <p className="font-mono text-xs text-muted">
                          {row.conceptHumanId}
                          {row.typeName && ` · ${resolveText(row.typeName, locale)}`}
                        </p>
                      </div>
                    </div>

                    <div className="shrink-0 text-right">
                      {row.daysRemaining !== null ? (
                        <p
                          className={cn(
                            'text-lg font-semibold tabular-nums',
                            row.reorderNow ? 'text-warning' : 'text-text',
                          )}
                        >
                          {Math.max(0, Math.round(row.daysRemaining))}{' '}
                          <span className="text-xs font-normal text-muted">
                            {t('forecast.daysLeft')}
                          </span>
                        </p>
                      ) : (
                        <p className="text-sm text-muted">{t('tracking.notEnough')}</p>
                      )}
                      <p className="text-xs text-muted">
                        {t('forecast.leadDays', { n: row.leadDays ?? 0 })}
                        {row.leadSource === 'measured' && ` · ${t('forecast.leadLearned')}`}
                      </p>
                    </div>
                  </div>

                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-xs tabular-nums text-muted">
                      {row.currentStock} {row.unit}
                    </span>
                    <RateExplanation row={row} />
                    {row.openRequestId !== null && (
                      <span className="rounded-sm bg-secondary-tint px-1.5 py-0.5 text-xs text-secondary">
                        {t('forecast.alreadyRequested')}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
