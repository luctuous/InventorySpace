import { useEffect, useState } from 'react';
import { Boxes, ListChecks, PackagePlus, Plus, Trash2 } from 'lucide-react';
import { resolveText, roleAtLeast } from '@inventory/shared';
import type { PoolUnitState, PoolWithStats } from '@inventory/shared';
import { asSessionUser, authClient } from '../api/auth';
import { ApiRequestError } from '../api/client';
import {
  useAddPoolUnit,
  useCloseOccupancy,
  useCommissionPool,
  useCreatePool,
  useDeletePool,
  useOccupancies,
  useOpenOccupancy,
  usePoolEvent,
  usePoolEvents,
  usePoolStock,
  usePoolUnits,
  usePools,
  useRecount,
  useSetUnitState,
} from '../api/operations';
import { useToast } from '../components/toast';
import {
  Button,
  Drawer,
  FieldError,
  Input,
  Label,
  Modal,
  Select,
  Spinner,
} from '../components/ui';
import { useI18n } from '../i18n';
import { cn } from '../lib/cn';
import { formatDateTime } from '../lib/format';

// Reusable pools. A cup is never an Item: what you need
// to know is how many are clean and how many you lose a month, and neither
// question requires individual identity.

const UNIT_STATE_STYLE: Record<PoolUnitState, string> = {
  available: 'bg-success-tint text-success',
  in_use: 'bg-warning-tint text-warning',
  dirty: 'bg-surface-2 text-muted',
  retired: 'bg-danger-tint text-danger',
};

function RecountModal({
  pool,
  onClose,
}: {
  pool: PoolWithStats;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const recount = useRecount();
  const [counted, setCounted] = useState(String(pool.available));
  const [note, setNote] = useState('');

  const parsed = Number(counted);
  const attrition = Number.isFinite(parsed) ? pool.available - parsed : 0;

  return (
    <Modal open onClose={onClose} title={t('pools.recountTitle')}>
      <div className="space-y-4">
        {/* The recount is the measuring instrument, not housekeeping. */}
        <p className="text-sm text-muted">{t('pools.recountHint')}</p>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>{t('pools.expected')}</Label>
            <p className="text-2xl font-semibold tabular-nums text-text">{pool.available}</p>
          </div>
          <div>
            <Label htmlFor="counted">{t('pools.counted')}</Label>
            <Input
              id="counted"
              type="number"
              min="0"
              value={counted}
              onChange={(e) => setCounted(e.target.value)}
            />
          </div>
        </div>

        {attrition > 0 && (
          <p className="rounded-md bg-accent-tint px-3 py-2 text-sm text-text">
            <span className="font-semibold tabular-nums">{attrition}</span>{' '}
            {t('pools.attrition')}
          </p>
        )}

        <div>
          <Label htmlFor="rc-note">{t('common.notes')}</Label>
          <Input id="rc-note" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={async () => {
              await recount.mutateAsync({
                poolId: pool.id,
                body: { counted: parsed, note: note.trim() || null },
              });
              toast({ message: t('pools.recount'), variant: 'success' });
              onClose();
            }}
            disabled={recount.isPending || !Number.isFinite(parsed)}
          >
            {t('common.save')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * The cupboard: boxes of unused cups that have never been in
 * rotation. They are ordinary stock — bought, received and forecast like
 * anything else — and this is the one move between the two.
 *
 * It is what closes the loop: breakage retires units, the pool drains, the
 * cupboard drains to refill it, and purchasing sees the whole chain without
 * pools needing any buying logic of their own.
 */
function CupboardPanel({ pool, canManage }: { pool: PoolWithStats; canManage: boolean }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const stockQuery = usePoolStock(pool.id);
  const commission = useCommissionPool();
  const [quantity, setQuantity] = useState('');
  const [error, setError] = useState<string | null>(null);

  const stock = stockQuery.data;
  // A pool with no concept behind it has no cupboard to draw from, and saying
  // so would just be noise on a screen that is working fine.
  if (!stock?.conceptId) return null;

  const asked = Number(quantity);
  const valid = Number.isFinite(asked) && asked > 0 && asked <= stock.available;

  return (
    <div className="rounded-lg border border-line bg-surface-2 p-3">
      <h3 className="mb-1 flex items-center gap-2 text-sm font-medium text-text">
        <PackagePlus className="h-4 w-4 text-primary" />
        {t('pools.cupboard')}
      </h3>
      <p className="mb-2 text-xs text-muted">{t('pools.cupboardHint')}</p>

      <p className="text-sm text-text">
        <span className="text-lg font-semibold tabular-nums">{stock.available}</span>{' '}
        <span className="text-muted">
          {stock.unit} · {resolveText(stock.conceptName, locale)}
        </span>
      </p>
      {stock.sources.length > 0 && (
        <p className="mt-0.5 font-mono text-xs text-muted">
          {stock.sources.map((s) => `${s.humanId} (${s.quantity})`).join(' · ')}
        </p>
      )}

      {canManage && stock.available > 0 && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <Input
            id="commission-qty"
            type="number"
            min="1"
            max={stock.available}
            placeholder={t('common.quantity')}
            className="w-28"
            value={quantity}
            onChange={(e) => { setQuantity(e.target.value); setError(null); }}
          />
          <Button
            size="sm"
            disabled={!valid || commission.isPending}
            onClick={async () => {
              try {
                const result = await commission.mutateAsync({
                  poolId: pool.id,
                  body: { quantity: asked },
                });
                toast({
                  message: t('pools.commissioned', {
                    n: result.commissioned,
                    left: result.stockRemaining,
                  }),
                  variant: 'success',
                });
                setQuantity('');
              } catch (err) {
                setError(err instanceof ApiRequestError ? err.message : String(err));
              }
            }}
          >
            {t('pools.commission')}
          </Button>
        </div>
      )}
      {stock.available === 0 && (
        <p className="mt-2 text-xs text-warning">{t('pools.cupboardEmpty')}</p>
      )}
      <FieldError message={error ?? undefined} />
    </div>
  );
}

function PoolDetail({
  pool,
  canManage,
  onClose,
}: {
  pool: PoolWithStats;
  canManage: boolean;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const unitsQuery = usePoolUnits(pool.granularity === 'identified' ? pool.id : null);
  const eventsQuery = usePoolEvents(pool.id);
  const occupanciesQuery = useOccupancies({ open: true });
  const addUnit = useAddPoolUnit();
  const setUnitState = useSetUnitState();
  const openOccupancy = useOpenOccupancy();
  const closeOccupancy = useCloseOccupancy();

  const [unitCode, setUnitCode] = useState('');
  const [sampleTag, setSampleTag] = useState('');
  const [position, setPosition] = useState('');
  const [targetUnit, setTargetUnit] = useState('');

  const units = unitsQuery.data ?? [];
  const occupancies = (occupanciesQuery.data ?? []).filter((o) => o.poolId === pool.id);

  return (
    <Drawer open wide onClose={onClose} title={resolveText(pool.name, locale)}>
      <div className="space-y-5">
        <div className="grid grid-cols-3 gap-2">
          {(['available', 'inUse', 'dirty'] as const).map((key) => (
            <div key={key} className="rounded-lg border border-line px-3 py-2">
              <p className="text-xs text-muted">{t(`pools.${key}`)}</p>
              <p className="text-xl font-semibold tabular-nums text-text">{pool[key]}</p>
            </div>
          ))}
        </div>

        {pool.attritionPerMonth !== null ? (
          <p className="rounded-md bg-accent-tint px-3 py-2 text-sm text-text">
            {t('pools.attritionRate', { n: pool.attritionPerMonth })}
          </p>
        ) : (
          <p className="text-xs text-muted">{t('pools.noAttritionYet')}</p>
        )}

        <CupboardPanel pool={pool} canManage={canManage} />

        {pool.granularity === 'identified' && (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-medium text-text">{t('pools.units')}</h3>
            </div>
            {canManage && (
              <div className="mb-2 flex gap-2">
                <Input
                  placeholder={t('pools.unitCode')}
                  value={unitCode}
                  onChange={(e) => setUnitCode(e.target.value)}
                />
                <Button
                  variant="outline"
                  onClick={async () => {
                    if (!unitCode.trim()) return;
                    await addUnit.mutateAsync({
                      poolId: pool.id,
                      body: { code: unitCode.trim() },
                    });
                    setUnitCode('');
                  }}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            )}
            <div className="space-y-1.5">
              {units.map((unit) => (
                <div
                  key={unit.id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-2"
                >
                  <div className="min-w-0">
                    <span className="font-mono text-sm text-text">{unit.code}</span>
                    {unit.occupancyCount > 0 && (
                      <span className="ml-2 text-xs text-muted">
                        {unit.occupancyCount} {t('pools.occupancies').toLowerCase()}
                      </span>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span
                      className={cn(
                        'rounded-sm px-1.5 py-0.5 font-mono text-[0.65rem] uppercase',
                        UNIT_STATE_STYLE[unit.state],
                      )}
                    >
                      {unit.state.replaceAll('_', ' ')}
                    </span>
                    <Select
                      className="w-auto"
                      value={unit.state}
                      onChange={(e) =>
                        setUnitState.mutate({
                          poolId: pool.id,
                          unitId: unit.id,
                          body: { state: e.target.value as PoolUnitState },
                        })
                      }
                    >
                      <option value="available">{t('pools.available')}</option>
                      <option value="in_use">{t('pools.inUse')}</option>
                      <option value="dirty">{t('pools.dirty')}</option>
                      <option value="retired">{t('pools.retire')}</option>
                    </Select>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {pool.addressable && units.length > 0 && (
          <div>
            <h3 className="mb-2 text-sm font-medium text-text">{t('pools.occupancies')}</h3>
            <div className="mb-2 grid grid-cols-3 gap-2">
              <Select value={targetUnit} onChange={(e) => setTargetUnit(e.target.value)}>
                <option value="">—</option>
                {units.map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {unit.code}
                  </option>
                ))}
              </Select>
              <Input
                placeholder={t('pools.position')}
                value={position}
                onChange={(e) => setPosition(e.target.value)}
              />
              <Input
                placeholder={t('pools.sampleTag')}
                value={sampleTag}
                onChange={(e) => setSampleTag(e.target.value)}
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                if (!targetUnit || !sampleTag.trim()) return;
                await openOccupancy.mutateAsync({
                  unitId: targetUnit,
                  sampleTag: sampleTag.trim(),
                  position: position.trim() || null,
                });
                setSampleTag('');
                setPosition('');
              }}
            >
              {t('pools.occupancyOpen')}
            </Button>

            <div className="mt-3 space-y-1">
              {occupancies.map((occupancy) => (
                <div
                  key={occupancy.id}
                  className="flex items-center justify-between gap-2 rounded-md border border-line px-3 py-1.5"
                >
                  <div className="min-w-0">
                    <span className="font-mono text-xs text-text">{occupancy.sampleTag}</span>
                    {/* The kit's whereabouts, walked up the chain — never
                        stored on the kit itself. */}
                    <span className="ml-2 text-xs text-muted">
                      {t('pools.viaUnit', {
                        unit: `${occupancy.unitCode}${occupancy.position ? `/${occupancy.position}` : ''}`,
                        location: occupancy.locationCode ?? t('pools.noLocation'),
                      })}
                    </span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => closeOccupancy.mutate(occupancy.id)}
                  >
                    {t('pools.empty')}
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div>
          <h3 className="mb-2 text-sm font-medium text-text">{t('pools.events')}</h3>
          <ul className="space-y-0.5">
            {(eventsQuery.data ?? []).slice(0, 15).map((event) => (
              <li key={event.id} className="flex justify-between gap-2 font-mono text-xs text-muted">
                <span>
                  {t(`pools.${event.kind}`)} ×{event.quantity}
                  {event.unitCode && ` · ${event.unitCode}`}
                  {event.source === 'log' && ' · log'}
                </span>
                <span className="shrink-0">{formatDateTime(event.createdAt, locale)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Drawer>
  );
}

export function PoolsPage() {
  const { t, locale } = useI18n();
  const toast = useToast();
  const { data: session } = authClient.useSession();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [recountFor, setRecountFor] = useState<PoolWithStats | null>(null);
  const [newOpen, setNewOpen] = useState(false);

  const user = session ? asSessionUser(session.user) : null;
  const canManage = user !== null && roleAtLeast(user.role, 'manager');
  const canAct = user !== null && roleAtLeast(user.role, 'operator');

  const poolsQuery = usePools();
  const poolEvent = usePoolEvent();
  const deletePool = useDeletePool();
  const pools = poolsQuery.data ?? [];
  const selected = pools.find((pool) => pool.id === selectedId) ?? null;

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-text">{t('pools.title')}</h1>
          <p className="mt-0.5 text-sm text-muted">{t('pools.subtitle')}</p>
        </div>
        {canManage && (
          <Button onClick={() => setNewOpen(true)}>
            <Plus className="h-4 w-4" />
            {t('pools.new')}
          </Button>
        )}
      </div>

      {poolsQuery.isLoading ? (
        <Spinner />
      ) : pools.length === 0 ? (
        <p className="text-muted">{t('pools.emptyPools')}</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {pools.map((pool) => (
            <div key={pool.id} className="min-w-0 rounded-lg border border-line bg-surface p-4">
              <div className="flex items-start justify-between gap-2">
                <button
                  type="button"
                  className="min-w-0 text-left cursor-pointer"
                  onClick={() => setSelectedId(pool.id)}
                >
                  <p className="flex items-center gap-2 truncate text-sm font-medium text-text">
                    <Boxes className="h-4 w-4 shrink-0 text-primary" />
                    {resolveText(pool.name, locale)}
                  </p>
                  <p className="font-mono text-xs text-muted">
                    {pool.humanId} · {t(`pools.${pool.granularity}`)}
                  </p>
                </button>
                {canManage && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => deletePool.mutate(pool.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>

              <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                {(['available', 'inUse', 'dirty'] as const).map((key) => (
                  <div key={key} className="rounded-md bg-surface-2 px-2 py-1.5">
                    <p className="text-[0.65rem] uppercase tracking-wide text-muted">
                      {t(`pools.${key}`)}
                    </p>
                    <p className="text-lg font-semibold tabular-nums text-text">{pool[key]}</p>
                  </div>
                ))}
              </div>

              {pool.attritionPerMonth !== null && (
                <p className="mt-2 text-xs text-accent">
                  {t('pools.attritionRate', { n: pool.attritionPerMonth })}
                </p>
              )}

              {canAct && pool.granularity === 'pooled' && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {(['take', 'return', 'wash'] as const).map((kind) => (
                    <Button
                      key={kind}
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        // The pool refuses to hand out what it does not have,
                        // so this button can fail — and a button that fails
                        // silently is worse than one that never fails.
                        poolEvent.mutate(
                          { poolId: pool.id, body: { kind, quantity: 1 } },
                          {
                            onError: (error) =>
                              toast({
                                message:
                                  error instanceof ApiRequestError
                                    ? error.message
                                    : String(error),
                                variant: 'danger',
                              }),
                          },
                        )
                      }
                    >
                      {t(`pools.${kind}`)}
                    </Button>
                  ))}
                  <Button size="sm" variant="secondary" onClick={() => setRecountFor(pool)}>
                    <ListChecks className="h-4 w-4" />
                    {t('pools.recount')}
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {selected && (
        <PoolDetail pool={selected} canManage={canManage} onClose={() => setSelectedId(null)} />
      )}
      {recountFor && <RecountModal pool={recountFor} onClose={() => setRecountFor(null)} />}
      <NewPoolModal open={newOpen} onClose={() => setNewOpen(false)} />
    </div>
  );
}

function NewPoolModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const createPool = useCreatePool();
  const [name, setName] = useState('');
  const [granularity, setGranularity] = useState<'pooled' | 'identified'>('pooled');
  const [initialUnits, setInitialUnits] = useState('0');
  const [addressable, setAddressable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setGranularity('pooled');
    setInitialUnits('0');
    setAddressable(false);
    setError(null);
  }, [open]);

  return (
    <Modal open={open} onClose={onClose} title={t('pools.new')}>
      <div className="space-y-4">
        <div>
          <Label htmlFor="pool-name">{t('common.name')}</Label>
          <Input id="pool-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        <div>
          <Label htmlFor="pool-gran">{t('pools.granularity')}</Label>
          <Select
            id="pool-gran"
            value={granularity}
            onChange={(e) => setGranularity(e.target.value as 'pooled' | 'identified')}
          >
            <option value="pooled">{t('pools.pooled')}</option>
            <option value="identified">{t('pools.identified')}</option>
          </Select>
          <p className="mt-1 text-xs text-muted">{t(`pools.${granularity}Hint`)}</p>
        </div>

        {granularity === 'pooled' && (
          <div>
            <Label htmlFor="pool-initial">{t('pools.initialUnits')}</Label>
            <Input
              id="pool-initial"
              type="number"
              min="0"
              value={initialUnits}
              onChange={(e) => setInitialUnits(e.target.value)}
            />
          </div>
        )}

        <label className="flex items-center gap-2 text-sm text-muted cursor-pointer">
          <input
            type="checkbox"
            checked={addressable}
            onChange={(e) => setAddressable(e.target.checked)}
          />
          {t('pools.addressable')}
        </label>

        <FieldError message={error ?? undefined} />

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={async () => {
              setError(null);
              if (!name.trim()) {
                setError(t('common.name'));
                return;
              }
              try {
                await createPool.mutateAsync({
                  name: { en: name.trim() },
                  granularity,
                  addressable,
                  initialUnits: Number(initialUnits) || 0,
                });
                onClose();
              } catch (err) {
                setError(err instanceof ApiRequestError ? err.message : String(err));
              }
            }}
            disabled={createPool.isPending}
          >
            {t('common.save')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
