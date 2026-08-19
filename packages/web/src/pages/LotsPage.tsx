import { useState } from 'react';
import { ListPlus, PackageCheck, Plus, Send, Trash2, TrendingUp } from 'lucide-react';
import { resolveText, roleAtLeast } from '@inventory/shared';
import type { LotStatus, LotWithLines, RequestWithRefs } from '@inventory/shared';
import { asSessionUser, authClient } from '../api/auth';
import { useItems } from '../api/entities';
import {
  useCreateLot,
  useDeleteLot,
  useDeleteLotLine,
  useLots,
  useOrderLot,
  useRequests,
  useSupplierStats,
} from '../api/operations';
import { LabelSheet } from '../components/LabelSheet';
import { LotLineForm } from '../components/LotLineForm';
import { SupplierPicker } from '../components/SupplierPicker';
import { ReceiveModal, ReceivedSummary } from '../components/ReceiveModal';
import type { ReceiveResultView } from '../api/operations';
import { useToast } from '../components/toast';
import { Button, Drawer, Input, Label, Modal, Pagination, Select, Spinner } from '../components/ui';
import { useI18n } from '../i18n';
import { cn } from '../lib/cn';
import { formatDate, formatPrice } from '../lib/format';

// Lots. The table shows both sides of every line, because
// ordered-vs-received is the interesting data, not an error to be tidied away.

const STATUS_STYLE: Record<LotStatus, string> = {
  draft: 'bg-surface-2 text-muted',
  ordered: 'bg-primary-tint text-primary',
  partial: 'bg-warning-tint text-warning',
  received: 'bg-success-tint text-success',
  cancelled: 'bg-danger-tint text-danger',
};

function LotDetail({
  lot,
  canManage,
  onClose,
}: {
  lot: LotWithLines;
  canManage: boolean;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const [lineFormOpen, setLineFormOpen] = useState(false);
  const [seedRequests, setSeedRequests] = useState<RequestWithRefs[]>([]);
  const [orderOpen, setOrderOpen] = useState(false);
  const [reference, setReference] = useState('');
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [received, setReceived] = useState<ReceiveResultView | null>(null);
  const [labelIds, setLabelIds] = useState<string[] | null>(null);

  const orderLot = useOrderLot();
  const deleteLine = useDeleteLotLine();

  // Only fetched when labels are actually asked for.
  const labelItemsQuery = useItems(
    { perPage: 100, variantId: undefined },
    { enabled: labelIds !== null },
  );
  const labelItems = (labelItemsQuery.data?.data ?? []).filter((item) =>
    labelIds?.includes(item.id),
  );

  return (
    <Drawer open wide onClose={onClose} title={`${lot.humanId} · ${lot.supplierName ?? '—'}`}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              'rounded-sm px-1.5 py-0.5 font-mono text-[0.65rem] font-medium uppercase tracking-wide',
              STATUS_STYLE[lot.status],
            )}
          >
            {t(`lots.status.${lot.status}`)}
          </span>
          {lot.reference && (
            <span className="font-mono text-xs text-muted">{lot.reference}</span>
          )}
          {lot.orderedAt && (
            <span className="text-xs text-muted">
              {t('lots.ordered')} {formatDate(lot.orderedAt, locale)}
            </span>
          )}
          {lot.discrepancies > 0 && (
            <span className="rounded-sm bg-warning-tint px-1.5 py-0.5 text-xs text-warning">
              {t('lots.discrepancy', { n: lot.discrepancies })}
            </span>
          )}
        </div>

        {received && (
          <ReceivedSummary
            result={received}
            onPrint={() => setLabelIds(received.itemIds)}
          />
        )}

        {canManage && lot.status === 'draft' && (
          <OpenRequestsPanel
            onAdd={(requests) => {
              setSeedRequests(requests);
              setLineFormOpen(true);
            }}
          />
        )}

        <div>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-medium text-text">{t('lots.lines')}</h3>
            {canManage && lot.status === 'draft' && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setSeedRequests([]);
                  setLineFormOpen(true);
                }}
              >
                <Plus className="h-4 w-4" />
                {t('lots.addLine')}
              </Button>
            )}
          </div>

          {lot.lines.length === 0 ? (
            <p className="text-sm text-muted">{t('lots.emptyLines')}</p>
          ) : (
            <div className="space-y-2">
              {lot.lines.map((line) => (
                <div key={line.id} className="rounded-lg border border-line p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm text-text">
                        {resolveText(line.orderedVariantName, locale)}
                      </p>
                      <p className="font-mono text-xs text-muted">
                        {resolveText(line.conceptName, locale)}
                        {line.requestCount > 0 &&
                          ` · ${
                            line.requestCount === 1
                              ? t('requests.countOne', { n: 1 })
                              : t('requests.countMany', { n: line.requestCount })
                          }`}
                      </p>
                    </div>
                    {canManage && lot.status === 'draft' && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() =>
                          deleteLine.mutate({ lotId: lot.id, lineId: line.id })
                        }
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>

                  {/* Two sides, side by side. Neither is ever overwritten. */}
                  <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
                    <div className="rounded-md bg-surface-2 px-2.5 py-1.5">
                      <p className="text-[0.65rem] uppercase tracking-wide text-muted">
                        {t('lots.ordered')}
                      </p>
                      <p className="tabular-nums text-text">
                        {line.orderedQuantity} ×{' '}
                        {formatPrice(line.unitPriceAmount, line.priceCurrency, locale)}
                      </p>
                    </div>
                    <div
                      className={cn(
                        'rounded-md px-2.5 py-1.5',
                        line.receivedQuantity === 0
                          ? 'bg-surface-2'
                          : line.receivedQuantity < line.orderedQuantity
                            ? 'bg-warning-tint'
                            : 'bg-success-tint',
                      )}
                    >
                      <p className="text-[0.65rem] uppercase tracking-wide text-muted">
                        {t('lots.received')}
                      </p>
                      <p className="tabular-nums text-text">
                        {line.receivedQuantity}
                        {line.receivedVariantName &&
                          line.receivedVariantId !== line.orderedVariantId && (
                            <span className="ml-1 text-xs text-warning">
                              {resolveText(line.receivedVariantName, locale)}
                            </span>
                          )}
                      </p>
                    </div>
                  </div>

                  {line.priceDeltaPercent !== null && line.priceDeltaPercent !== 0 && (
                    <p
                      className={cn(
                        'mt-1.5 text-xs',
                        line.priceDeltaPercent > 0 ? 'text-danger' : 'text-success',
                      )}
                    >
                      {line.priceDeltaPercent > 0
                        ? t('lots.priceUp', { pct: line.priceDeltaPercent })
                        : t('lots.priceDown', { pct: line.priceDeltaPercent })}
                    </p>
                  )}
                  {line.itemsCreated > 0 && (
                    <p className="mt-1 text-xs text-success">
                      {t('lots.itemsCreated', { n: line.itemsCreated })}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-line pt-3">
          <span className="text-sm text-muted">{t('lots.total')}</span>
          <span className="text-lg font-semibold tabular-nums text-text">
            {formatPrice(lot.totalAmount, lot.currency, locale)}
          </span>
        </div>

        {canManage && (
          <div className="flex flex-wrap justify-end gap-2">
            {lot.status === 'draft' && lot.lines.length > 0 && (
              <Button onClick={() => setOrderOpen(true)}>
                <Send className="h-4 w-4" />
                {t('lots.order')}
              </Button>
            )}
            {(lot.status === 'ordered' || lot.status === 'partial') && (
              <Button onClick={() => setReceiveOpen(true)}>
                <PackageCheck className="h-4 w-4" />
                {t('lots.receive')}
              </Button>
            )}
          </div>
        )}
      </div>

      <LotLineForm
        open={lineFormOpen}
        onClose={() => {
          setLineFormOpen(false);
          setSeedRequests([]);
        }}
        lotId={lot.id}
        seedRequests={seedRequests}
      />

      {/* Placing the order is where the reference finally exists. */}
      <Modal open={orderOpen} onClose={() => setOrderOpen(false)} title={t('lots.order')}>
        <div className="space-y-3">
          <div>
            <Label htmlFor="order-ref">{t('lots.reference')}</Label>
            <Input
              id="order-ref"
              value={reference}
              placeholder={t('lots.referencePlaceholder')}
              onChange={(e) => setReference(e.target.value)}
            />
            <p className="mt-1 text-xs text-muted">{t('lots.referenceOptional')}</p>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => setOrderOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={async () => {
                await orderLot.mutateAsync({ lotId: lot.id, reference: reference.trim() || null });
                setOrderOpen(false);
                setReference('');
                toast({ message: t('lots.order'), variant: 'success' });
              }}
              disabled={orderLot.isPending}
            >
              <Send className="h-4 w-4" />
              {t('lots.order')}
            </Button>
          </div>
        </div>
      </Modal>
      {receiveOpen && (
        <ReceiveModal
          open
          lot={lot}
          onClose={() => setReceiveOpen(false)}
          onReceived={(result) => {
            setReceived(result);
            toast({
              message: t('lots.itemsCreated', { n: result.itemsCreated }),
              variant: 'success',
            });
          }}
        />
      )}
      {labelIds !== null && labelItems.length > 0 && (
        <LabelSheet items={labelItems} onClose={() => setLabelIds(null)} />
      )}
    </Drawer>
  );
}

/**
 * The open requests, inside the lot, with checkboxes. A lot is
 * assembled by triaging what people have asked for — so the queue has to be
 * here, where the buying decision is made, not on another page.
 *
 * Requests are grouped by Concept because that is how they become one line:
 * three people asking for wood glue is one bottle to order, not three.
 */
function OpenRequestsPanel({ onAdd }: { onAdd: (requests: RequestWithRefs[]) => void }) {
  const { t, locale } = useI18n();
  const openQuery = useRequests({ status: ['open'], perPage: 100 });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const requestCount = (n: number) =>
    n === 1 ? t('requests.countOne', { n }) : t('requests.countMany', { n });

  const rows = openQuery.data?.data ?? [];
  if (rows.length === 0) return null;

  const byConcept = new Map<string, RequestWithRefs[]>();
  for (const row of rows) {
    const list = byConcept.get(row.conceptId);
    if (list) list.push(row);
    else byConcept.set(row.conceptId, [row]);
  }

  const toggle = (ids: string[]) =>
    setPicked((current) => {
      const next = new Set(current);
      const allOn = ids.every((id) => next.has(id));
      for (const id of ids) {
        if (allOn) next.delete(id);
        else next.add(id);
      }
      return next;
    });

  const chosen = rows.filter((row) => picked.has(row.id));
  // One line per concept, so adding two concepts at once would need two forms.
  const chosenConcepts = new Set(chosen.map((row) => row.conceptId));

  return (
    <div className="rounded-lg border border-line bg-surface-2 p-3">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-medium text-text">
        <ListPlus className="h-4 w-4 text-primary" />
        {t('lots.openRequests', { n: rows.length })}
      </h3>

      <div className="space-y-1.5">
        {[...byConcept.entries()].map(([conceptId, group]) => {
          const [first] = group;
          if (!first) return null;
          const ids = group.map((row) => row.id);
          const on = ids.every((id) => picked.has(id));
          const total = group.reduce((sum, row) => sum + row.quantity, 0);
          const blocking = group.some((row) => row.urgency === 'blocking');
          return (
            <label
              key={conceptId}
              className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-surface"
            >
              <input
                type="checkbox"
                checked={on}
                onChange={() => toggle(ids)}
                className="h-4 w-4 shrink-0 accent-[var(--color-primary)]"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-text">
                  {resolveText(first.conceptName, locale)}
                  {blocking && (
                    <span className="ml-2 rounded-sm bg-danger-tint px-1.5 py-0.5 text-[0.65rem] uppercase tracking-wide text-danger">
                      {t('requests.blockingShort')}
                    </span>
                  )}
                </span>
                <span className="block font-mono text-xs text-muted">
                  {total} {first.conceptUnit} · {requestCount(group.length)}
                </span>
              </span>
            </label>
          );
        })}
      </div>

      <div className="mt-2.5 flex justify-end">
        <Button
          size="sm"
          disabled={chosen.length === 0 || chosenConcepts.size > 1}
          onClick={() => {
            onAdd(chosen);
            setPicked(new Set());
          }}
        >
          <Plus className="h-4 w-4" />
          {chosenConcepts.size > 1
            ? t('lots.oneConceptAtATime')
            : chosen.length === 0
              ? t('lots.pickToOrder')
              : t('lots.addPicked', { n: chosen.length })}
        </Button>
      </div>
    </div>
  );
}

function SupplierStatsPanel() {
  const { t } = useI18n();
  const statsQuery = useSupplierStats();
  const rows = (statsQuery.data ?? []).filter((row) => row.lines > 0);
  if (rows.length === 0) return null;

  return (
    <div className="mb-5 rounded-lg border border-line bg-surface p-4">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-medium text-text">
        <TrendingUp className="h-4 w-4 text-primary" />
        {t('lots.suppliers')}
      </h2>
      <div className="flex flex-wrap gap-4">
        {rows.map((row) => (
          <div key={row.supplierId} className="min-w-0">
            <p className="truncate text-sm text-text">{row.supplier}</p>
            <p className="font-mono text-xs text-muted">
              {Math.round(row.shortRate * 100)}% {t('lots.shortRate')}
              {row.avgLeadDays !== null &&
                ` · ${row.avgLeadDays} ${t('lots.days')} ${t('lots.leadTime')}`}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function LotsPage() {
  const { t, locale } = useI18n();
  const { data: session } = authClient.useSession();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [newSupplier, setNewSupplier] = useState('');

  const user = session ? asSessionUser(session.user) : null;
  const canManage = user !== null && roleAtLeast(user.role, 'manager');

  const lotsQuery = useLots({ page, status: status ? [status] : undefined });
  const createLot = useCreateLot();
  const deleteLot = useDeleteLot();
  const openRequests = useRequests({ status: ['open'] });

  const rows = lotsQuery.data?.data ?? [];
  const meta = lotsQuery.data?.meta;
  const selected = rows.find((lot) => lot.id === selectedId) ?? null;
  const openCount = openRequests.data?.meta.total ?? 0;

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-text">{t('lots.title')}</h1>
          <p className="mt-0.5 text-sm text-muted">{t('lots.subtitle')}</p>
        </div>
        {canManage && (
          <Button onClick={() => setNewOpen(true)}>
            <Plus className="h-4 w-4" />
            {t('lots.new')}
          </Button>
        )}
      </div>

      {/* The queue is a prompt to start a lot; picking from it happens inside
          the draft, where the buying decision is actually made. */}
      {openCount > 0 && (
        <p className="mb-4 rounded-lg border border-warning/40 bg-warning-tint px-3 py-2 text-sm text-text">
          {openCount} {t('requests.status.open').toLowerCase()} · {t('lots.fromRequests')}
        </p>
      )}

      <SupplierStatsPanel />

      <div className="mb-4">
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto">
          <option value="">{t('common.all')}</option>
          <option value="draft">{t('lots.status.draft')}</option>
          <option value="ordered">{t('lots.status.ordered')}</option>
          <option value="partial">{t('lots.status.partial')}</option>
          <option value="received">{t('lots.status.received')}</option>
        </Select>
      </div>

      {lotsQuery.isLoading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <p className="text-muted">{t('common.empty')}</p>
      ) : (
        <div data-tour="lots-list" className="space-y-2">
          {rows.map((lot) => (
            <button
              key={lot.id}
              type="button"
              onClick={() => setSelectedId(lot.id)}
              className="flex w-full items-center justify-between gap-3 rounded-lg border border-line bg-surface px-4 py-3 text-left transition-colors hover:bg-surface-2 cursor-pointer"
            >
              <div className="min-w-0">
                <p className="truncate text-sm text-text">
                  {lot.supplierName ?? '—'}
                  {lot.reference && (
                    <span className="ml-2 font-mono text-xs text-muted">{lot.reference}</span>
                  )}
                </p>
                <p className="font-mono text-xs text-muted">
                  {lot.humanId} · {lot.lines.length} {t('lots.lines').toLowerCase()}
                  {lot.discrepancies > 0 &&
                    ` · ${t('lots.discrepancy', { n: lot.discrepancies })}`}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="text-sm tabular-nums text-text">
                  {formatPrice(lot.totalAmount, lot.currency, locale)}
                </span>
                <span
                  className={cn(
                    'rounded-sm px-1.5 py-0.5 font-mono text-[0.65rem] font-medium uppercase tracking-wide',
                    STATUS_STYLE[lot.status],
                  )}
                >
                  {t(`lots.status.${lot.status}`)}
                </span>
                {canManage && lot.status === 'draft' && (
                  <span
                    role="button"
                    tabIndex={0}
                    className="text-muted hover:text-danger"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteLot.mutate(lot.id);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') deleteLot.mutate(lot.id);
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}

      {meta && <Pagination page={meta.page} totalPages={meta.totalPages} onPage={setPage} />}

      {selected && (
        <LotDetail lot={selected} canManage={canManage} onClose={() => setSelectedId(null)} />
      )}

      {/* Creating a lot asks for the supplier and nothing else. The order
          reference does not exist until the order has been placed, so it is
          asked for at that step instead. */}
      <Modal open={newOpen} onClose={() => setNewOpen(false)} title={t('lots.new')}>
        <div className="space-y-3">
          <SupplierPicker
            supplierId={supplierId}
            newName={newSupplier}
            onPick={setSupplierId}
            onNewName={setNewSupplier}
          />
          <p className="text-xs text-muted">{t('lots.referenceLater')}</p>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => setNewOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={async () => {
                const lot = await createLot.mutateAsync({
                  supplierId,
                  newSupplierName: newSupplier.trim() || null,
                });
                setSupplierId(null);
                setNewSupplier('');
                setNewOpen(false);
                setSelectedId(lot.id);
              }}
              disabled={createLot.isPending || (!supplierId && !newSupplier.trim())}
            >
              {t('common.save')}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
