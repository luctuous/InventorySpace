import { useState } from 'react';
import { Download, Plus, QrCode, Upload, Zap } from 'lucide-react';
import { ITEM_STATUSES, parseMoneyInput, resolveText, roleAtLeast } from '@inventory/shared';
import type { ItemSortKey, ItemStatus, ItemWithRefs } from '@inventory/shared';
import { asSessionUser, authClient } from '../api/auth';
import { ApiRequestError } from '../api/client';
import { useConceptOptions } from '../api/concepts';
import { useCreateItems, useItems, useTypes, useVariantOptions, useVariants } from '../api/entities';
import { Combobox } from '../components/Combobox';
import { CsvImportModal } from '../components/CsvModal';
import { CustomFields } from '../components/CustomFields';
import { ItemDrawer } from '../components/ItemDrawer';
import { LabelSheet } from '../components/LabelSheet';
import { LocationPicker } from '../components/LocationPicker';
import { QuickAddModal } from '../components/QuickAddModal';
import { useToast } from '../components/toast';
import {
  Button,
  Drawer,
  Input,
  Label,
  Pagination,
  Select,
  SortHeader,
  Spinner,
  StatusBadge,
  Textarea,
  nextSort,
} from '../components/ui';
import type { SortState } from '../components/ui';
import { useI18n } from '../i18n';
import { cn } from '../lib/cn';
import { formatDate, formatPrice, formatQty } from '../lib/format';

// The full item browser: filter bar, table, detail drawer,
// and the detailed Add-Item form whose custom fields come from the Type.

const DEFAULT_STATUSES: ItemStatus[] = ['in_stock', 'open'];

function AddItemDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const typesQuery = useTypes();
  const createItems = useCreateItems();

  const [typeId, setTypeId] = useState('');
  const [variantId, setVariantId] = useState('');
  const [locationId, setLocationId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState('');
  const [priceText, setPriceText] = useState('');
  const [serialNumber, setSerialNumber] = useState('');
  const [batchNumber, setBatchNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [copies, setCopies] = useState('1');
  const [customFields, setCustomFields] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const type = typesQuery.data?.find((x) => x.id === typeId);
  // Variant list is scoped to the chosen type, so the two can never disagree.
  const variantsQuery = useVariants({ page: 1, typeId: typeId || undefined });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const created = await createItems.mutateAsync({
        typeId,
        variantId: variantId || null,
        locationId,
        quantityInitial: quantity ? Number(quantity) : null,
        unit: unit || null,
        priceAmount: priceText ? parseMoneyInput(priceText) : null,
        serialNumber: serialNumber || null,
        batchNumber: batchNumber || null,
        notes: notes || null,
        customFields,
        copies: Number(copies) || 1,
      });
      toast({
        message: `✓ ${created.map((i) => i.humanId).join(', ')}`,
        variant: 'success',
      });
      onClose();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer open={open} onClose={onClose} title={t('items.new')}>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <Label htmlFor="add-type">{t('nav.types')} *</Label>
          <Select
            id="add-type"
            value={typeId}
            onChange={(e) => {
              setTypeId(e.target.value);
              setVariantId('');
              setCustomFields({});
            }}
          >
            <option value="">—</option>
            {typesQuery.data?.map((x) => (
              <option key={x.id} value={x.id}>{resolveText(x.name, locale)}</option>
            ))}
          </Select>
        </div>

        {typeId && (
          <>
            <div>
              <Label htmlFor="add-variant">{t('nav.variants')}</Label>
              <Select
                id="add-variant"
                value={variantId}
                onChange={(e) => {
                  setVariantId(e.target.value);
                  const variant = variantsQuery.data?.data.find((v) => v.id === e.target.value);
                  if (variant?.packUnit) setUnit(variant.packUnit);
                  if (variant?.packSize) setQuantity(String(variant.packSize));
                }}
              >
                <option value="">{t('items.standalone')}</option>
                {variantsQuery.data?.data.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.humanId} · {resolveText(v.name, locale)}
                  </option>
                ))}
              </Select>
            </div>

            <div>
              <Label>{t('items.location')}</Label>
              <LocationPicker value={locationId} onChange={setLocationId} allowClear />
            </div>

            {type?.tracksQuantity && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="add-qty">{t('items.quantity')}</Label>
                  <Input id="add-qty" type="number" step="any" min="0" value={quantity}
                    onChange={(e) => setQuantity(e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="add-unit">{t('items.unit')}</Label>
                  <Input id="add-unit" placeholder="L" value={unit} onChange={(e) => setUnit(e.target.value)} />
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="add-price">{t('items.price')}</Label>
                <Input id="add-price" placeholder="22.40" value={priceText}
                  onChange={(e) => setPriceText(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="add-copies">{t('items.copies')}</Label>
                <Input id="add-copies" type="number" min="1" max="100" value={copies}
                  onChange={(e) => setCopies(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="add-serial">{t('items.serial')}</Label>
                <Input id="add-serial" value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="add-batch">{t('items.batch')}</Label>
                <Input id="add-batch" value={batchNumber} onChange={(e) => setBatchNumber(e.target.value)} />
              </div>
            </div>

            {/* The dynamic part: fields defined by the chosen Type */}
            {type && type.fieldDefinitions.length > 0 && (
              <div className="rounded-md border border-line p-3">
                <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted">
                  {resolveText(type.name, locale)} — {t('items.customFields')}
                </p>
                <CustomFields definitions={type.fieldDefinitions} values={customFields} onChange={setCustomFields} />
              </div>
            )}

            <div>
              <Label htmlFor="add-notes">{t('concepts.notes')}</Label>
              <Textarea id="add-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </>
        )}

        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" disabled={!typeId || saving}>{t('common.save')}</Button>
        </div>
      </form>
    </Drawer>
  );
}

export function ItemsPage() {
  const { t, locale } = useI18n();
  const { data: session } = authClient.useSession();
  const typesQuery = useTypes();
  const conceptOptions = useConceptOptions();

  const [statuses, setStatuses] = useState<ItemStatus[]>(DEFAULT_STATUSES);
  const [typeId, setTypeId] = useState('');
  const [conceptId, setConceptId] = useState('');
  const [variantId, setVariantId] = useState('');
  const [locationId, setLocationId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortState<ItemSortKey>>({ key: null, dir: 'asc' });
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<ItemWithRefs | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [csvOpen, setCsvOpen] = useState(false);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // The variant list follows the two filters above it, so it can never offer a
  // variant that would produce an empty table on its own.
  const variantOptions = useVariantOptions({
    conceptId: conceptId || undefined,
    typeId: conceptId ? undefined : typeId || undefined,
  });

  const itemsQuery = useItems({
    page,
    status: statuses,
    typeId: typeId || undefined,
    conceptId: conceptId || undefined,
    variantId: variantId || undefined,
    locationId: locationId ?? undefined,
    search,
    sort: sort.key ?? undefined,
    dir: sort.dir,
    locale,
  });

  // "Filtered" means anything narrower than "every item there is" — including
  // the status chips, which start narrowed and are the usual reason a search
  // comes back empty.
  const filtersActive =
    statuses.length > 0 ||
    typeId !== '' ||
    conceptId !== '' ||
    variantId !== '' ||
    locationId !== null ||
    search.trim() !== '';

  const clearFilters = () => {
    setStatuses([]);
    setTypeId('');
    setConceptId('');
    setVariantId('');
    setLocationId(null);
    setSearch('');
    setPage(1);
  };

  const onSort = (key: ItemSortKey) => {
    setSort((current) => nextSort(current, key));
    // A different order means a different page 1; staying on page 4 of the old
    // order would land you somewhere arbitrary.
    setPage(1);
  };

  const user = session ? asSessionUser(session.user) : null;
  const canOperate = user !== null && roleAtLeast(user.role, 'operator');
  const canManage = user !== null && roleAtLeast(user.role, 'manager');

  // The API streams the file back; letting the browser follow the URL keeps
  // the session cookie and the Content-Disposition filename intact.
  const exportCsv = () => {
    window.location.href = `/api/v1/export/items.csv?locale=${locale}`;
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleStatus = (status: ItemStatus) => {
    setStatuses((current) =>
      current.includes(status) ? current.filter((s) => s !== status) : [...current, status],
    );
    setPage(1);
  };

  // Keep the drawer showing fresh data after an action refetches the list.
  const selectedFresh = selected
    ? (itemsQuery.data?.data.find((i) => i.id === selected.id) ?? selected)
    : null;

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-text">{t('items.title')}</h1>
        <div className="flex flex-wrap gap-2">
          {canOperate && (
            <>
              <Button onClick={() => setQuickOpen(true)}>
                <Zap className="h-4 w-4" /> {t('quickAdd.button')}
              </Button>
              <Button variant="outline" onClick={() => setAddOpen(true)}>
                <Plus className="h-4 w-4" /> {t('items.new')}
              </Button>
            </>
          )}
          {/* The export carries the current filters, so what you see is what
              you get in the file. */}
          <Button variant="outline" onClick={exportCsv} title={t('csv.exportHint')}>
            <Download className="h-4 w-4" /> {t('csv.export')}
          </Button>
          {canManage && (
            <Button variant="outline" onClick={() => setCsvOpen(true)}>
              <Upload className="h-4 w-4" /> {t('csv.import')}
            </Button>
          )}
        </div>
      </div>

      {selectedIds.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-primary/40 bg-primary-tint px-3 py-2 text-sm">
          <span className="text-primary">
            {t('items.selected').replace('{count}', String(selectedIds.size))}
          </span>
          <Button size="sm" variant="outline" onClick={() => setLabelsOpen(true)}>
            <QrCode className="h-4 w-4" /> {t('labels.print')}
          </Button>
          <button
            className="ml-auto text-xs text-muted hover:text-text cursor-pointer"
            onClick={() => setSelectedIds(new Set())}
          >
            {t('items.clearSelection')}
          </button>
        </div>
      )}

      {/* Filter bar */}
      <div className="mb-4 space-y-3 rounded-lg border border-line bg-surface/40 p-3">
        <div className="flex flex-wrap gap-1.5">
          {ITEM_STATUSES.map((status) => (
            <button
              key={status}
              onClick={() => toggleStatus(status)}
              className={cn(
                'rounded-full px-2.5 py-1 font-mono text-[0.65rem] uppercase tracking-wide cursor-pointer transition-colors',
                statuses.includes(status)
                  ? 'bg-primary-tint text-primary'
                  : 'bg-surface-2 text-muted hover:text-text',
              )}
            >
              {status.replaceAll('_', ' ')}
            </button>
          ))}
        </div>
        <div data-tour="items-filters" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <Combobox
            value={typeId}
            onChange={(next) => {
              setTypeId(next);
              // A variant belongs to exactly one type, so a leftover variant
              // filter under a new type would silently empty the table.
              setVariantId('');
              setPage(1);
            }}
            placeholder={t('items.allTypes')}
            options={(typesQuery.data ?? []).map((row) => ({
              value: row.id,
              label: resolveText(row.name, locale),
            }))}
          />
          <Combobox
            value={conceptId}
            onChange={(next) => {
              setConceptId(next);
              setVariantId('');
              setPage(1);
            }}
            placeholder={t('items.allConcepts')}
            options={(conceptOptions.data ?? []).map((row) => ({
              value: row.id,
              label: resolveText(row.name, locale),
              hint: row.humanId,
            }))}
          />
          <Combobox
            value={variantId}
            onChange={(next) => { setVariantId(next); setPage(1); }}
            placeholder={t('items.allVariants')}
            options={(variantOptions.data ?? []).map((row) => ({
              value: row.id,
              label: resolveText(row.name, locale),
              hint: [row.humanId, row.brand, row.packSize && `${row.packSize} ${row.packUnit ?? ''}`]
                .filter(Boolean)
                .join(' · '),
            }))}
          />
          <LocationPicker value={locationId} onChange={(id) => { setLocationId(id); setPage(1); }} allowClear />
          <Input
            placeholder={t('items.searchPlaceholder')}
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          />
        </div>
      </div>

      {itemsQuery.isPending ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : (
        <div data-tour="items-table" className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface text-left text-xs uppercase tracking-wide text-muted">
                <th className="w-9 px-3 py-2.5">
                  <input
                    type="checkbox"
                    aria-label={t('items.selectAll')}
                    className="h-3.5 w-3.5 accent-(--color-primary-base)"
                    checked={
                      (itemsQuery.data?.data.length ?? 0) > 0 &&
                      itemsQuery.data!.data.every((i) => selectedIds.has(i.id))
                    }
                    onChange={(e) =>
                      setSelectedIds(
                        e.target.checked
                          ? new Set(itemsQuery.data?.data.map((i) => i.id) ?? [])
                          : new Set(),
                      )
                    }
                  />
                </th>
                <SortHeader sortKey="humanId" state={sort} onSort={onSort}>ID</SortHeader>
                <SortHeader sortKey="type" state={sort} onSort={onSort}>{t('nav.types')}</SortHeader>
                <SortHeader sortKey="concept" state={sort} onSort={onSort}>{t('nav.concepts')}</SortHeader>
                {/* The variant column is new: you cannot sort by a column that
                    is not on screen, and "which exact product is this" was the
                    question the table could not answer. */}
                <SortHeader sortKey="variant" state={sort} onSort={onSort}>{t('items.variant')}</SortHeader>
                <SortHeader sortKey="status" state={sort} onSort={onSort}>{t('items.status')}</SortHeader>
                <SortHeader sortKey="location" state={sort} onSort={onSort}>{t('items.location')}</SortHeader>
                <SortHeader sortKey="remaining" state={sort} onSort={onSort} align="right">{t('items.remaining')}</SortHeader>
                <SortHeader sortKey="received" state={sort} onSort={onSort} align="right">{t('items.received')}</SortHeader>
                <SortHeader sortKey="price" state={sort} onSort={onSort} align="right">{t('items.price')}</SortHeader>
              </tr>
            </thead>
            <tbody>
              {itemsQuery.data?.data.map((item) => (
                <tr
                  key={item.id}
                  onClick={() => setSelected(item)}
                  className="cursor-pointer border-b border-line last:border-0 hover:bg-surface"
                >
                  <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={item.humanId}
                      className="h-3.5 w-3.5 accent-(--color-primary-base)"
                      checked={selectedIds.has(item.id)}
                      onChange={() => toggleSelected(item.id)}
                    />
                  </td>
                  <td className="px-4 py-2.5"><span className="human-id">{item.humanId}</span></td>
                  <td className="px-4 py-2.5 text-muted">{resolveText(item.typeName, locale)}</td>
                  <td className="px-4 py-2.5 text-text">{resolveText(item.conceptName, locale) || '—'}</td>
                  <td className="px-4 py-2.5 text-muted">
                    {resolveText(item.variantName, locale) || t('items.standalone')}
                  </td>
                  <td className="px-4 py-2.5"><StatusBadge status={item.status} /></td>
                  <td className="px-4 py-2.5 text-muted">
                    {item.locationCode ? <span className="human-id">{item.locationCode}</span> : '—'}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono">{formatQty(item.quantityRemaining, item.unit)}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs text-muted">
                    {item.receivedAt ? formatDate(item.receivedAt, locale) : '—'}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-muted">
                    {formatPrice(item.priceAmount, item.priceCurrency, locale)}
                  </td>
                </tr>
              ))}
              {/* "Nothing here yet" is a lie when a filter is hiding the row.
                  The default status filter is stock-shaped, so an instrument
                  (in service) or a document (active) is invisible until you
                  say otherwise — and a person searching for their caliper
                  deserves to be told that, not that it does not exist. */}
              {itemsQuery.data?.data.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-4 py-10 text-center text-muted">
                    {filtersActive ? (
                      <>
                        <p>{t('items.noMatch')}</p>
                        <Button
                          className="mt-3"
                          size="sm"
                          variant="outline"
                          onClick={clearFilters}
                        >
                          {t('items.clearFilters')}
                        </Button>
                      </>
                    ) : (
                      t('common.empty')
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <Pagination page={page} totalPages={itemsQuery.data?.meta.totalPages ?? 1} onPage={setPage} />

      <ItemDrawer item={selectedFresh} onClose={() => setSelected(null)} />
      {addOpen && <AddItemDrawer open onClose={() => setAddOpen(false)} />}
      <QuickAddModal open={quickOpen} onClose={() => setQuickOpen(false)} />
      <CsvImportModal open={csvOpen} onClose={() => setCsvOpen(false)} />
      {labelsOpen && (
        <LabelSheet
          items={(itemsQuery.data?.data ?? []).filter((i) => selectedIds.has(i.id))}
          onClose={() => setLabelsOpen(false)}
        />
      )}
    </div>
  );
}
