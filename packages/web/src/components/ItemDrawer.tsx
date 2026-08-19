import { useState } from 'react';
import { Ban, PackageOpen, Pencil, Move, Scale, Trash2 } from 'lucide-react';
import {
  parseMoneyInput,
  resolveText,
  roleAtLeast,
} from '@inventory/shared';
import type { ItemWithRefs, TypeWithCount } from '@inventory/shared';
import { asSessionUser, authClient } from '../api/auth';
import { ApiRequestError } from '../api/client';
import { useConceptStockMap, useItemAction, useTypes, useUpdateItem } from '../api/entities';
import { useHistory } from '../api/history';
import { CustomFields } from './CustomFields';
import { EquipmentPanel } from './EquipmentPanel';
import { LocationPicker } from './LocationPicker';
import { RequestModal } from './RequestModal';
import { useToast } from './toast';
import { Button, Drawer, Input, Label, Modal, Select, Spinner, StatusBadge, Textarea } from './ui';
import { useI18n } from '../i18n';
import { formatDateTime, formatPrice, formatQty } from '../lib/format';

// Item detail slide-over: all fields incl. per-Type custom
// fields, lifecycle timestamps, actions, and the item's own history tab.

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 border-b border-line py-2 last:border-0">
      <span className="w-40 shrink-0 text-xs uppercase tracking-wide text-muted">{label}</span>
      <span className="min-w-0 flex-1 text-sm text-text">{children}</span>
    </div>
  );
}

function ItemHistoryTab({ itemId }: { itemId: string }) {
  const { t, locale } = useI18n();
  const historyQuery = useHistory({ page: 1, entityId: itemId, perPage: 50 });

  if (historyQuery.isPending) return <div className="py-8 text-center"><Spinner /></div>;

  return (
    <div className="space-y-2">
      {historyQuery.data?.data.map((entry) => (
        <div key={entry.id} className="rounded-md border border-line px-3 py-2 text-sm">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-xs uppercase text-primary">{entry.action}</span>
            <span className="font-mono text-xs text-muted">{formatDateTime(entry.createdAt, locale)}</span>
          </div>
          {entry.fieldChanged && (
            <p className="mt-1 font-mono text-xs text-muted">
              {entry.fieldChanged}: {JSON.stringify(entry.valueBefore)} → {JSON.stringify(entry.valueAfter)}
            </p>
          )}
          {entry.notes && <p className="mt-1 text-xs text-text">{entry.notes}</p>}
          {entry.userName && <p className="mt-1 text-xs text-muted">{entry.userName}</p>}
        </div>
      ))}
      {historyQuery.data?.data.length === 0 && (
        <p className="py-6 text-center text-sm text-muted">{t('common.empty')}</p>
      )}
    </div>
  );
}

export function ItemDrawer({
  item,
  onClose,
}: {
  item: ItemWithRefs | null;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const { data: session } = authClient.useSession();
  const typesQuery = useTypes();
  const itemAction = useItemAction();
  const updateItem = useUpdateItem();

  const [tab, setTab] = useState<'details' | 'equipment' | 'history'>('details');
  const [editing, setEditing] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const conceptStock = useConceptStockMap();

  if (!item) return null;

  const user = session ? asSessionUser(session.user) : null;
  const canOperate = user !== null && roleAtLeast(user.role, 'operator');
  const canManage = user !== null && roleAtLeast(user.role, 'manager');
  const type: TypeWithCount | undefined = typesQuery.data?.find((x) => x.id === item.typeId);

  // open/deplete already have their own buttons; everything else the Type
  // permits goes in the dropdown.
  const otherStatuses = (type?.validStatuses ?? []).filter(
    (status) => status !== item.status && status !== 'open' && status !== 'depleted',
  );

  const run = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      toast({ message: `${item.humanId} · ${label}`, variant: 'success' });
    } catch (error) {
      toast({ message: error instanceof ApiRequestError ? error.message : String(error), variant: 'danger' });
    }
  };

  /**
   * Depleting the last one is the exact second a person KNOWS something is
   * needed. Catching the demand here, with no navigation,
   * is worth more than any Requests screen.
   */
  const deplete = async () => {
    const remainingBefore = item.conceptId ? (conceptStock.data?.[item.conceptId] ?? 0) : 0;
    const wasLast = item.conceptId !== null && remainingBefore - (item.quantityRemaining ?? 0) <= 0;
    await run(t('items.depleted'), () =>
      itemAction.mutateAsync({ id: item.id, action: 'deplete' }),
    );
    if (wasLast) setRequestOpen(true);
  };

  return (
    <Drawer
      open
      onClose={onClose}
      wide
      title={
        <span className="flex items-center gap-2">
          <span className="human-id">{item.humanId}</span>
          <StatusBadge status={item.status} />
        </span>
      }
    >
      <div className="mb-4 flex gap-1 border-b border-line">
        {(['details', 'equipment', 'history'] as const).map((key) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={
              tab === key
                ? 'border-b-2 border-primary px-3 py-2 text-sm font-medium text-primary cursor-pointer'
                : 'px-3 py-2 text-sm text-muted hover:text-text cursor-pointer'
            }
          >
            {t(`items.tab.${key}`)}
          </button>
        ))}
      </div>

      {tab === 'history' ? (
        <ItemHistoryTab itemId={item.id} />
      ) : tab === 'equipment' ? (
        <EquipmentPanel item={item} />
      ) : (
        <>
          {canOperate && (
            <div className="mb-4 flex flex-wrap gap-2">
              {item.status === 'in_stock' && (
                <Button size="sm" onClick={() => void run(t('items.opened'), () => itemAction.mutateAsync({ id: item.id, action: 'open' }))}>
                  <PackageOpen className="h-4 w-4" /> {t('items.open')}
                </Button>
              )}
              {(item.status === 'in_stock' || item.status === 'open') && (
                <Button size="sm" variant="outline" onClick={() => void deplete()}>
                  <Ban className="h-4 w-4" /> {t('items.deplete')}
                </Button>
              )}
              {/* Every other status this Type allows. Without this, types with
                  their own lifecycle (an instrument, a document) had no way to
                  change status at all. */}
              {otherStatuses.length > 0 && (
                <Select
                  className="h-8 w-auto min-w-36 text-xs"
                  value=""
                  onChange={(e) => {
                    const status = e.target.value;
                    if (!status) return;
                    e.target.value = '';
                    // Say it the way the badge does — a toast is user-facing
                    // text, not a place for the raw enum value.
                    void run(status.replaceAll('_', ' '), () =>
                      itemAction.mutateAsync({ id: item.id, action: 'status', body: { status } }),
                    );
                  }}
                >
                  <option value="">{t('items.setStatus')}…</option>
                  {otherStatuses.map((status) => (
                    <option key={status} value={status}>{status.replaceAll('_', ' ')}</option>
                  ))}
                </Select>
              )}
              <Button size="sm" variant="outline" onClick={() => setMoveOpen(true)}>
                <Move className="h-4 w-4" /> {t('items.move')}
              </Button>
              {type?.tracksQuantity && (
                <Button size="sm" variant="outline" onClick={() => setAdjustOpen(true)}>
                  <Scale className="h-4 w-4" /> {t('items.adjust')}
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => setEditing((v) => !v)}>
                <Pencil className="h-4 w-4" /> {t('common.edit')}
              </Button>
              {canManage && (
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => {
                    if (!window.confirm(`${t('items.deleteConfirm')} (${item.humanId})`)) return;
                    void run(t('common.deleted'), async () => {
                      await itemAction.mutateAsync({ id: item.id, action: 'delete' });
                      onClose();
                    });
                  }}
                >
                  <Trash2 className="h-4 w-4" /> {t('common.delete')}
                </Button>
              )}
            </div>
          )}

          {editing ? (
            <EditItemForm
              item={item}
              type={type}
              onDone={() => setEditing(false)}
              onSave={async (body) => {
                await run(t('common.saved'), () => updateItem.mutateAsync({ id: item.id, body }));
                setEditing(false);
              }}
            />
          ) : (
            <div>
              <Row label={t('nav.types')}>{resolveText(item.typeName, locale)}</Row>
              <Row label={t('nav.concepts')}>
                {item.conceptHumanId && <span className="human-id mr-2">{item.conceptHumanId}</span>}
                {resolveText(item.conceptName, locale) || '—'}
              </Row>
              <Row label={t('nav.variants')}>
                {item.variantHumanId && <span className="human-id mr-2">{item.variantHumanId}</span>}
                {resolveText(item.variantName, locale) || '—'}
              </Row>
              <Row label={t('items.location')}>
                {item.locationCode ? (
                  <>
                    <span className="human-id mr-2">{item.locationCode}</span>
                    {resolveText(item.locationName, locale)}
                  </>
                ) : '—'}
              </Row>
              <Row label={t('items.remaining')}>
                <span className="font-mono">{formatQty(item.quantityRemaining, item.unit)}</span>
                {item.quantityInitial !== null && (
                  <span className="ml-2 text-xs text-muted">
                    / {formatQty(item.quantityInitial, item.unit)} {t('items.initial')}
                  </span>
                )}
              </Row>
              <Row label={t('items.price')}>
                <span className="font-mono">{formatPrice(item.priceAmount, item.priceCurrency, locale)}</span>
                {item.priceLocked && <span className="ml-2 text-xs text-muted">🔒 {t('items.priceLocked')}</span>}
              </Row>
              {item.serialNumber && <Row label={t('items.serial')}>{item.serialNumber}</Row>}
              {item.batchNumber && <Row label={t('items.batch')}>{item.batchNumber}</Row>}
              {item.receivedAt && <Row label={t('items.received')}>{formatDateTime(item.receivedAt, locale)}</Row>}
              {item.openedAt && <Row label={t('items.openedAt')}>{formatDateTime(item.openedAt, locale)}</Row>}
              {item.depletedAt && <Row label={t('items.depletedAt')}>{formatDateTime(item.depletedAt, locale)}</Row>}
              {item.notes && <Row label={t('concepts.notes')}>{item.notes}</Row>}

              {type && type.fieldDefinitions.length > 0 && (
                <div className="mt-5">
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
                    {t('items.customFields')}
                  </p>
                  {[...type.fieldDefinitions]
                    .sort((a, b) => a.order - b.order)
                    .map((def) => {
                      const value = item.customFields[def.key];
                      return (
                        <Row key={def.key} label={resolveText(def.label, locale)}>
                          {value === null || value === undefined || value === ''
                            ? '—'
                            : typeof value === 'boolean'
                              ? value ? '✓' : '—'
                              : String(value)}
                          {def.kind === 'number' && def.unit && value != null ? ` ${def.unit}` : ''}
                        </Row>
                      );
                    })}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Move modal */}
      <MoveModal
        open={moveOpen}
        onClose={() => setMoveOpen(false)}
        currentLocationId={item.locationId}
        onMove={async (locationId) => {
          await run(t('items.moved'), () =>
            itemAction.mutateAsync({ id: item.id, action: 'move', body: { locationId } }),
          );
          setMoveOpen(false);
        }}
      />

      {/* Adjust modal */}
      <AdjustModal
        open={adjustOpen}
        onClose={() => setAdjustOpen(false)}
        current={item.quantityRemaining}
        unit={item.unit}
        onAdjust={async (quantityRemaining, note) => {
          await run(t('items.adjusted'), () =>
            itemAction.mutateAsync({ id: item.id, action: 'adjust', body: { quantityRemaining, note } }),
          );
          setAdjustOpen(false);
        }}
      />

      <RequestModal
        open={requestOpen}
        onClose={() => setRequestOpen(false)}
        conceptId={item.conceptId}
      />
    </Drawer>
  );
}

function EditItemForm({
  item,
  type,
  onSave,
  onDone,
}: {
  item: ItemWithRefs;
  type: TypeWithCount | undefined;
  onSave: (body: Record<string, unknown>) => Promise<void>;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const [locationId, setLocationId] = useState(item.locationId);
  const [unit, setUnit] = useState(item.unit ?? '');
  const [serialNumber, setSerialNumber] = useState(item.serialNumber ?? '');
  const [batchNumber, setBatchNumber] = useState(item.batchNumber ?? '');
  const [notes, setNotes] = useState(item.notes ?? '');
  const [priceText, setPriceText] = useState(
    item.priceAmount !== null ? (item.priceAmount / 100).toFixed(2) : '',
  );
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(item.customFields);
  const [saving, setSaving] = useState(false);

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        const price = priceText ? parseMoneyInput(priceText) : null;
        await onSave({
          locationId,
          unit: unit || null,
          serialNumber: serialNumber || null,
          batchNumber: batchNumber || null,
          notes: notes || null,
          ...(item.priceLocked ? {} : { priceAmount: price }),
          customFields,
        });
        setSaving(false);
      }}
    >
      <div>
        <Label>{t('items.location')}</Label>
        <LocationPicker value={locationId} onChange={setLocationId} allowClear />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>{t('items.unit')}</Label>
          <Input value={unit} onChange={(e) => setUnit(e.target.value)} />
        </div>
        <div>
          <Label>{t('items.price')}</Label>
          <Input
            value={priceText}
            disabled={item.priceLocked}
            placeholder="22.40"
            onChange={(e) => setPriceText(e.target.value)}
          />
        </div>
        <div>
          <Label>{t('items.serial')}</Label>
          <Input value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)} />
        </div>
        <div>
          <Label>{t('items.batch')}</Label>
          <Input value={batchNumber} onChange={(e) => setBatchNumber(e.target.value)} />
        </div>
      </div>
      <div>
        <Label>{t('concepts.notes')}</Label>
        <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      {type && type.fieldDefinitions.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
            {t('items.customFields')}
          </p>
          <CustomFields definitions={type.fieldDefinitions} values={customFields} onChange={setCustomFields} />
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>{t('common.cancel')}</Button>
        <Button type="submit" disabled={saving}>{t('common.save')}</Button>
      </div>
    </form>
  );
}

function MoveModal({
  open,
  onClose,
  currentLocationId,
  onMove,
}: {
  open: boolean;
  onClose: () => void;
  currentLocationId: string | null;
  onMove: (locationId: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [locationId, setLocationId] = useState(currentLocationId);

  return (
    <Modal open={open} onClose={onClose} title={t('items.move')}>
      <div className="space-y-4">
        <LocationPicker value={locationId} onChange={setLocationId} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button disabled={!locationId} onClick={() => locationId && void onMove(locationId)}>
            {t('items.move')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function AdjustModal({
  open,
  onClose,
  current,
  unit,
  onAdjust,
}: {
  open: boolean;
  onClose: () => void;
  current: number | null;
  unit: string | null;
  onAdjust: (quantity: number, note: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [quantity, setQuantity] = useState(current !== null ? String(current) : '');
  const [note, setNote] = useState('');

  return (
    <Modal open={open} onClose={onClose} title={t('items.adjust')}>
      <div className="space-y-4">
        <div>
          <Label>{t('items.remaining')} {unit ? `(${unit})` : ''}</Label>
          <Input type="number" step="any" min="0" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </div>
        <div>
          <Label>{t('items.adjustNote')} *</Label>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            disabled={quantity === '' || note.trim() === ''}
            onClick={() => void onAdjust(Number(quantity), note.trim())}
          >
            {t('common.save')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
