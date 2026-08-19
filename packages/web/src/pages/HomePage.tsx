import { useState } from 'react';
import { AlertTriangle, CalendarClock, ChevronDown, ChevronRight, PackageOpen, X, Zap } from 'lucide-react';
import { resolveText, roleAtLeast } from '@inventory/shared';
import type { ConceptWithStock, ItemWithRefs } from '@inventory/shared';
import { asSessionUser, authClient } from '../api/auth';
import { ApiRequestError } from '../api/client';
import { useConcepts } from '../api/concepts';
import { useConceptStockMap, useItem, useItemMetrics, useItems, useItemAction, useLocations } from '../api/entities';
import { useDueMaintenance } from '../api/operations';
import { useDueLabel } from '../components/EquipmentPanel';
import { ItemDrawer } from '../components/ItemDrawer';
import { TourInvite } from '../components/Tour';
import { LocationTree } from '../components/LocationTree';
import { QuickAddModal, useQuickAddShortcut } from '../components/QuickAddModal';
import { ResizablePanel } from '../components/ResizablePanel';
import { useToast } from '../components/toast';
import { Button, Input, Spinner, StatusBadge } from '../components/ui';
import { useI18n } from '../i18n';
import { cn } from '../lib/cn';
import { daysUntil, formatQty } from '../lib/format';

// Home speaks in Concepts: what do I have, is anything running
// low, and let me act fast.

type StockLevel = 'ok' | 'low' | 'zero';

/**
 * Instruments do not run low, they fall out of calibration — and a machine
 * that is overdue is the one thing on this screen that stops work outright, so
 * it sits above the stock cards and disappears entirely when there is nothing
 * to say.
 */
function MaintenanceDueCard({ onSelectItem }: { onSelectItem: (id: string) => void }) {
  const { t, locale } = useI18n();
  const dueLabel = useDueLabel();
  const due = useDueMaintenance();

  if (due.isPending || (due.data ?? []).length === 0) return null;

  return (
    <div data-tour="maintenance-due" className="mb-5 rounded-lg border border-warning/40 bg-warning-tint p-3">
      <h2 className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-warning">
        <CalendarClock className="h-3.5 w-3.5" /> {t('equipment.dueTitle')}
      </h2>
      <div className="space-y-1">
        {due.data?.map((plan) => (
          <button
            key={plan.id}
            onClick={() => onSelectItem(plan.itemId)}
            className="flex w-full cursor-pointer flex-wrap items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-black/5"
          >
            <span className="human-id shrink-0">{plan.itemHumanId}</span>
            <span className="min-w-0 flex-1 truncate text-sm text-text">
              {resolveText(plan.itemName, locale) || '—'}
              <span className="ml-2 text-muted">{resolveText(plan.name, locale)}</span>
            </span>
            <span
              className={cn(
                'shrink-0 text-xs font-medium',
                plan.overdue ? 'text-danger' : 'text-warning',
              )}
            >
              {dueLabel(plan)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function levelOf(stock: number, threshold: number | null): StockLevel {
  if (stock <= 0) return 'zero';
  if (threshold !== null && stock < threshold) return 'low';
  return 'ok';
}

function MetricCard({ label, value, tone }: { label: string; value: number; tone?: StockLevel }) {
  return (
    <div
      className={cn(
        'rounded-lg border bg-surface px-4 py-3',
        tone === 'zero' ? 'border-danger/40 bg-danger-tint' : 'border-line',
      )}
    >
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className={cn('mt-1 font-mono text-2xl', tone === 'zero' ? 'text-danger' : 'text-text')}>
        {value}
      </p>
    </div>
  );
}

/** Expiry-soon badge: any date custom field whose key looks like an expiry. */
function ExpiryWarning({ item }: { item: ItemWithRefs }) {
  const entry = Object.entries(item.customFields).find(
    ([key, value]) => /expir|caduc|verfall/i.test(key) && typeof value === 'string' && value,
  );
  if (!entry) return null;
  const days = daysUntil(entry[1] as string);
  if (days > 90) return null;
  return (
    <span className={cn('font-mono text-[0.65rem]', days < 0 ? 'text-danger' : 'text-warning')}>
      ⚠ exp {days}d
    </span>
  );
}

function ConceptCard({
  concept,
  stock,
  locationId,
  showDepleted,
  onSelectItem,
}: {
  concept: ConceptWithStock;
  stock: number;
  locationId: string | null;
  showDepleted: boolean;
  onSelectItem: (item: ItemWithRefs) => void;
}) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const { data: session } = authClient.useSession();
  const level = levelOf(stock, concept.minStockThreshold);
  // Cards with a problem open themselves — the alert IS the reason to look.
  const [expanded, setExpanded] = useState(level !== 'ok');
  const itemAction = useItemAction();

  const itemsQuery = useItems(
    {
      conceptId: concept.id,
      locationId: locationId ?? undefined,
      status: showDepleted ? [] : ['in_stock', 'open'],
      perPage: 100,
    },
    { enabled: expanded },
  );

  const user = session ? asSessionUser(session.user) : null;
  const canOperate = user !== null && roleAtLeast(user.role, 'operator');

  // Optimistic-feeling quick action with a 5s undo.
  const act = async (item: ItemWithRefs, action: 'open' | 'deplete') => {
    const previousStatus = item.status;
    try {
      await itemAction.mutateAsync({ id: item.id, action });
      toast({
        message: `${item.humanId} → ${action === 'open' ? t('items.opened') : t('items.depleted')}`,
        variant: 'success',
        actionLabel: t('common.undo'),
        onAction: () => {
          void itemAction.mutateAsync({
            id: item.id,
            action: 'status',
            body: { status: previousStatus },
          });
        },
      });
    } catch (error) {
      toast({ message: error instanceof ApiRequestError ? error.message : String(error), variant: 'danger' });
    }
  };

  // Group items by variant so the card shows the hierarchy.
  const groups = new Map<string, { label: string; items: ItemWithRefs[] }>();
  for (const item of itemsQuery.data?.data ?? []) {
    const key = item.variantId ?? 'standalone';
    const label = resolveText(item.variantName, locale) || t('items.standalone');
    const group = groups.get(key) ?? { label, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }

  return (
    <div
      className={cn(
        // h-fit: in the grid, a card must be as tall as its own content and no
        // taller — without it every card in a row stretches to match whichever
        // neighbour happens to be expanded.
        'h-fit rounded-lg border border-l-4 bg-surface',
        level === 'zero' ? 'border-l-danger border-line' :
        level === 'low' ? 'border-l-warning border-line' :
        'border-l-success/50 border-line',
      )}
    >
      {/* Two rows, not one.
          In the grid a card is a third of the width a full-page row used to be,
          and squeezing the name, the alert and the number onto one line left
          "Analytical he…" — which is the one thing on the card nobody can do
          without. The name now gets the top line to itself and may wrap; the
          numbers, which are short and fixed-width, get the line below. */}
      <button
        className="flex w-full flex-col gap-1.5 px-4 py-3 text-left cursor-pointer"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="flex w-full items-start gap-2">
          {expanded ? (
            <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
          ) : (
            <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
          )}
          <span className="human-id mt-0.5 shrink-0">{concept.humanId}</span>
          <span className="min-w-0 flex-1 text-text">{resolveText(concept.name, locale)}</span>
        </span>
        <span className="flex w-full items-baseline gap-2 pl-6">
          <span
            className={cn(
              'font-mono text-lg',
              level === 'zero' ? 'text-danger' : level === 'low' ? 'text-warning' : 'text-text',
            )}
          >
            {stock} {concept.unit}
          </span>
          {concept.minStockThreshold !== null && (
            <span className="font-mono text-xs text-muted">/ min {concept.minStockThreshold}</span>
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

      {expanded && (
        // Capped and scrolled inside the card: a concept with forty bottles
        // would otherwise make its whole grid row forty bottles tall and leave
        // a hole beside it.
        <div className="max-h-72 overflow-y-auto border-t border-line px-4 py-3">
          {itemsQuery.isPending ? (
            <div className="py-4 text-center"><Spinner className="h-4 w-4" /></div>
          ) : groups.size === 0 ? (
            <p className="py-2 text-center text-xs text-muted">{t('home.noItems')}</p>
          ) : (
            [...groups.entries()].map(([key, group]) => (
              <div key={key} className="mb-2 last:mb-0">
                <p className="mb-1 text-xs text-muted">▸ {group.label}</p>
                <div className="space-y-1">
                  {group.items.map((item) => (
                    <div
                      key={item.id}
                      className="flex flex-wrap items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-surface-2"
                    >
                      <button className="human-id cursor-pointer" onClick={() => onSelectItem(item)}>
                        {item.humanId}
                      </button>
                      <StatusBadge status={item.status} />
                      {item.locationCode && <span className="text-xs text-muted">{item.locationCode}</span>}
                      <span className="font-mono text-xs text-text">
                        {formatQty(item.quantityRemaining, item.unit)}
                      </span>
                      <ExpiryWarning item={item} />
                      {canOperate && (item.status === 'in_stock' || item.status === 'open') && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="ml-auto h-7"
                          onClick={() => void act(item, item.status === 'in_stock' ? 'open' : 'deplete')}
                        >
                          {item.status === 'in_stock' ? t('items.open') : t('items.deplete')}
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Home speaks in concepts, so items created without a variant used to be
 * invisible here — findable only under Items. They get their own card instead,
 * which disappears when there are none.
 */
function StandaloneCard({
  locationId,
  showDepleted,
  onSelectItem,
}: {
  locationId: string | null;
  showDepleted: boolean;
  onSelectItem: (item: ItemWithRefs) => void;
}) {
  const { t, locale } = useI18n();
  const [expanded, setExpanded] = useState(false);

  const itemsQuery = useItems({
    locationId: locationId ?? undefined,
    status: showDepleted ? [] : ['in_stock', 'open'],
    perPage: 100,
  });
  const standalone = (itemsQuery.data?.data ?? []).filter((item) => item.conceptId === null);
  if (standalone.length === 0) return null;

  return (
    <div className="h-fit rounded-lg border border-l-4 border-line border-l-secondary/60 bg-surface">
      <button
        className="flex w-full items-center gap-3 px-4 py-3 text-left cursor-pointer"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? <ChevronDown className="h-4 w-4 shrink-0 text-muted" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted" />}
        <span className="min-w-0 flex-1 truncate text-text">{t('home.standalone')}</span>
        <span className="font-mono text-lg text-text">{standalone.length}</span>
      </button>
      {expanded && (
        <div className="max-h-72 space-y-1 overflow-y-auto border-t border-line px-4 py-3">
          {standalone.map((item) => (
            <div
              key={item.id}
              className="flex flex-wrap items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-surface-2"
            >
              <button className="human-id cursor-pointer" onClick={() => onSelectItem(item)}>
                {item.humanId}
              </button>
              <StatusBadge status={item.status} />
              <span className="text-xs text-muted">{resolveText(item.typeName, locale)}</span>
              {item.locationCode && <span className="text-xs text-muted">{item.locationCode}</span>}
              <span className="font-mono text-xs text-text">
                {formatQty(item.quantityRemaining, item.unit)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function HomePage() {
  const { t, locale } = useI18n();
  const { data: session } = authClient.useSession();
  const [search, setSearch] = useState('');
  const [locationId, setLocationId] = useState<string | null>(null);
  const [showDepleted, setShowDepleted] = useState(false);
  const [selected, setSelected] = useState<ItemWithRefs | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [treeOpen, setTreeOpen] = useState(false);
  // The maintenance card knows an item id, not a whole row — so it fetches one
  // and hands the same drawer everything else on this page uses.
  const [dueItemId, setDueItemId] = useState<string | null>(null);
  const dueItem = useItem(dueItemId);

  useQuickAddShortcut(() => setQuickOpen(true));

  // Home is the stock screen: instruments and documents live on their own
  // pages, and "0 pillar drills" was never a warning worth showing.
  const conceptsQuery = useConcepts({ page: 1, search, stockOnly: true });
  const stockQuery = useConceptStockMap(locationId ?? undefined);
  const metricsQuery = useItemMetrics(locationId ?? undefined);
  const locationsQuery = useLocations();

  const user = session ? asSessionUser(session.user) : null;
  const canOperate = user !== null && roleAtLeast(user.role, 'operator');

  const concepts = conceptsQuery.data?.data ?? [];
  const stocks = stockQuery.data ?? {};
  const lowCount = concepts.filter(
    (c) => levelOf(stocks[c.id] ?? 0, c.minStockThreshold) !== 'ok',
  ).length;
  const zeroCount = concepts.filter((c) => (stocks[c.id] ?? 0) <= 0).length;
  const activeLocation = locationsQuery.data?.find((l) => l.id === locationId);

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-text">{t('home.title')}</h1>
        {canOperate && (
          <Button data-tour="quick-add" onClick={() => setQuickOpen(true)}>
            <Zap className="h-4 w-4" /> {t('quickAdd.button')}
            <kbd className="ml-1 rounded bg-black/20 px-1 font-mono text-[0.65rem]">q</kbd>
          </Button>
        )}
      </div>

      <TourInvite />

      <MaintenanceDueCard onSelectItem={setDueItemId} />

      <div data-tour="metrics" className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard label={t('home.activeConcepts')} value={concepts.length} />
        <MetricCard label={t('home.activeItems')} value={metricsQuery.data?.activeItems ?? 0} />
        <MetricCard label={t('home.openItems')} value={metricsQuery.data?.openItems ?? 0} />
        <MetricCard label={t('home.lowStockCount')} value={lowCount} tone={zeroCount > 0 ? 'zero' : undefined} />
      </div>

      {/* Flex rather than a grid template, because the panel now sets its own
          width and a grid column would need that width duplicated here. */}
      <div className="flex flex-col gap-5 lg:flex-row">
        {/* On a phone the tree is a disclosure: useful, but not worth a screen
            of scrolling before you reach your stock. */}
        <ResizablePanel storageKey="home-tree-width" defaultWidth={240} label={t('home.resizeHint')}>
          <aside
            data-tour="location-tree"
            className="h-fit min-w-0 overflow-x-auto rounded-lg border border-line bg-surface/40 p-3"
          >
            <button
              className="mb-2 flex w-full items-center gap-2 px-1 text-xs font-medium uppercase tracking-wide text-muted lg:cursor-default"
              onClick={() => setTreeOpen((v) => !v)}
            >
              <span className="lg:hidden">{treeOpen ? '▾' : '▸'}</span>
              {t('nav.locations')}
              {activeLocation && (
                <span className="human-id ml-auto normal-case">{activeLocation.code}</span>
              )}
            </button>
            <div className={cn(treeOpen ? 'block' : 'hidden', 'lg:block')}>
              <LocationTree
                locations={locationsQuery.data ?? []}
                selectedId={locationId}
                showCounts
                onSelect={(node) => setLocationId(node.id === locationId ? null : node.id)}
              />
            </div>
          </aside>
        </ResizablePanel>

        {/* min-w-0: a flex child refuses to shrink below its content by
            default, which pushes the whole column off a narrow screen. */}
        <div className="min-w-0 flex-1">
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <Input
              className="max-w-xs"
              placeholder={t('common.search')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
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
            <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-xs text-muted">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-(--color-primary-base)"
                checked={showDepleted}
                onChange={(e) => setShowDepleted(e.target.checked)}
              />
              {t('home.showDepleted')}
            </label>
          </div>

          {conceptsQuery.isPending ? (
            <div className="flex justify-center py-16"><Spinner /></div>
          ) : concepts.length === 0 ? (
            <div className="rounded-lg border border-dashed border-line py-16 text-center">
              <PackageOpen className="mx-auto mb-3 h-8 w-8 text-muted" />
              <p className="text-sm text-muted">{t('home.emptyTitle')}</p>
              {canOperate && (
                <Button className="mt-4" onClick={() => setQuickOpen(true)}>
                  <Zap className="h-4 w-4" /> {t('quickAdd.button')}
                </Button>
              )}
            </div>
          ) : (
            // auto-fill at a 19rem floor: the browser fits as many columns as
            // the space allows and rearranges them as the window changes, with
            // no breakpoints to keep in sync. On a phone that is one column,
            // which is the old row layout — so nothing was lost by moving to a
            // grid, only gained on a wide screen.
            <div
              data-tour="concept-cards"
              className="grid auto-rows-min grid-cols-[repeat(auto-fill,minmax(19rem,1fr))] gap-2.5"
            >
              {concepts.map((concept) => (
                <ConceptCard
                  key={concept.id}
                  concept={concept}
                  stock={stocks[concept.id] ?? 0}
                  locationId={locationId}
                  showDepleted={showDepleted}
                  onSelectItem={setSelected}
                />
              ))}
              <StandaloneCard
                locationId={locationId}
                showDepleted={showDepleted}
                onSelectItem={setSelected}
              />
            </div>
          )}
        </div>
      </div>

      <ItemDrawer
        item={selected ?? dueItem.data ?? null}
        onClose={() => {
          setSelected(null);
          setDueItemId(null);
        }}
      />
      <QuickAddModal open={quickOpen} onClose={() => setQuickOpen(false)} />
    </div>
  );
}
