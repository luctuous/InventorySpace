import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { resolveText, roleAtLeast, variantCreateSchema } from '@inventory/shared';
import type { VariantCreate, VariantSortKey, VariantWithRefs } from '@inventory/shared';
import { asSessionUser, authClient } from '../api/auth';
import { ApiRequestError } from '../api/client';
import { useConceptOptions } from '../api/concepts';
import { useAnalogous, useCreateVariant, useDeleteVariant, useTypes, useUpdateVariant, useVariants } from '../api/entities';
import { Combobox } from '../components/Combobox';
import { DeleteDialog } from '../components/DeleteDialog';
import type { DeleteTarget } from '../components/DeleteDialog';
import { MultilangInput } from '../components/MultilangInput';
import { useToast } from '../components/toast';
import { Button, Drawer, FieldError, Input, Label, Pagination, Select, SortHeader, Spinner, Textarea, nextSort } from '../components/ui';
import type { SortState } from '../components/ui';
import { useI18n } from '../i18n';

const nullableText = { setValueAs: (v: string) => (v ? v : null) };

function VariantFormDrawer({
  open,
  onClose,
  editing,
}: {
  open: boolean;
  onClose: () => void;
  editing: VariantWithRefs | null;
}) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const analogousQuery = useAnalogous({ page: 1 });
  const typesQuery = useTypes();
  const createVariant = useCreateVariant();
  const updateVariant = useUpdateVariant();
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<VariantCreate>({
    resolver: zodResolver(variantCreateSchema),
    values: editing
      ? {
          analogousId: editing.analogousId,
          typeId: editing.typeId,
          name: editing.name,
          brand: editing.brand,
          supplier: editing.supplier,
          catalogRef: editing.catalogRef,
          format: editing.format,
          packSize: editing.packSize,
          packUnit: editing.packUnit,
          purity: editing.purity,
          concentration: editing.concentration,
          notes: editing.notes,
        }
      : { analogousId: '', typeId: '', name: { en: '' } },
  });

  const watchedAnalogousId = form.watch('analogousId');
  const showRelinkWarning =
    editing !== null && watchedAnalogousId !== editing.analogousId && editing.itemCount > 0;

  const submit = form.handleSubmit(async (values) => {
    setServerError(null);
    try {
      if (editing) {
        await updateVariant.mutateAsync({ id: editing.id, body: values });
      } else {
        await createVariant.mutateAsync(values);
      }
      toast({ message: t('common.saved'), variant: 'success' });
      onClose();
    } catch (error) {
      setServerError(error instanceof ApiRequestError ? error.message : String(error));
    }
  });

  return (
    <Drawer open={open} onClose={onClose} title={editing ? t('variants.edit') : t('variants.new')}>
      <form onSubmit={submit} className="space-y-4">
        <MultilangInput
          label={t('variants.nameLabel')}
          basePath="name"
          register={form.register}
          error={form.formState.errors.name?.en?.message}
          placeholder="Bondwell wood glue D3, 750 mL"
        />

        <div>
          <Label htmlFor="var-analogous">{t('nav.analogous')}</Label>
          <Select id="var-analogous" {...form.register('analogousId')}>
            <option value="">—</option>
            {analogousQuery.data?.data.map((row) => (
              <option key={row.id} value={row.id}>
                {row.humanId} · {resolveText(row.name, locale)}
              </option>
            ))}
          </Select>
          <FieldError message={form.formState.errors.analogousId?.message} />
          {showRelinkWarning && (
            <p className="mt-2 rounded-md bg-warning-tint px-3 py-2 text-xs text-warning">
              ⚠ {t('variants.relinkWarning').replace('{items}', String(editing.itemCount))}
            </p>
          )}
        </div>

        <div>
          <Label htmlFor="var-type">{t('nav.types')}</Label>
          <Select id="var-type" {...form.register('typeId')}>
            <option value="">—</option>
            {typesQuery.data?.map((type) => (
              <option key={type.id} value={type.id}>
                {resolveText(type.name, locale)}
              </option>
            ))}
          </Select>
          <FieldError message={form.formState.errors.typeId?.message} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>{t('variants.brand')}</Label>
            <Input {...form.register('brand', nullableText)} />
          </div>
          <div>
            <Label>{t('variants.supplier')}</Label>
            <Input {...form.register('supplier', nullableText)} />
          </div>
          <div>
            <Label>{t('variants.catalogRef')}</Label>
            <Input {...form.register('catalogRef', nullableText)} />
          </div>
          <div>
            <Label>{t('variants.format')}</Label>
            <Input {...form.register('format', nullableText)} />
          </div>
          <div>
            <Label>{t('variants.packSize')}</Label>
            <Input
              type="number" step="any" min="0"
              {...form.register('packSize', { setValueAs: (v: string) => (v === '' || v === null ? null : Number(v)) })}
            />
          </div>
          <div>
            <Label>{t('variants.packUnit')}</Label>
            <Input placeholder="L" {...form.register('packUnit', nullableText)} />
          </div>
          <div>
            <Label>{t('variants.purity')}</Label>
            <Input placeholder="99%" {...form.register('purity', nullableText)} />
          </div>
          <div>
            <Label>{t('variants.concentration')}</Label>
            <Input {...form.register('concentration', nullableText)} />
          </div>
        </div>

        <div>
          <Label>{t('concepts.notes')}</Label>
          <Textarea {...form.register('notes', nullableText)} />
        </div>

        {serverError && <p className="text-sm text-danger">{serverError}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>{t('common.save')}</Button>
        </div>
      </form>
    </Drawer>
  );
}

export function VariantsPage() {
  const { t, locale } = useI18n();
  const toast = useToast();
  const { data: session } = authClient.useSession();
  const [search, setSearch] = useState('');
  const [typeId, setTypeId] = useState('');
  const [conceptId, setConceptId] = useState('');
  const [sort, setSort] = useState<SortState<VariantSortKey>>({ key: null, dir: 'asc' });
  const [page, setPage] = useState(1);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<VariantWithRefs | null>(null);

  const typesQuery = useTypes();
  const conceptOptions = useConceptOptions();
  const variantsQuery = useVariants({
    page,
    search,
    typeId: typeId || undefined,
    conceptId: conceptId || undefined,
    sort: sort.key ?? undefined,
    dir: sort.dir,
    locale,
  });
  const deleteVariant = useDeleteVariant();

  const onSort = (key: VariantSortKey) => {
    setSort((current) => nextSort(current, key));
    setPage(1);
  };

  const user = session ? asSessionUser(session.user) : null;
  const canManage = user !== null && roleAtLeast(user.role, 'manager');

  const [deleting, setDeleting] = useState<DeleteTarget | null>(null);

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-text">{t('variants.title')}</h1>
        {canManage && (
          <Button onClick={() => { setEditing(null); setDrawerOpen(true); }}>
            <Plus className="h-4 w-4" /> {t('variants.new')}
          </Button>
        )}
      </div>

      {/* The same filter bar as Items, one row shorter: a variant already
          belongs to one concept and one type, so there is nothing below it to
          narrow further. */}
      <div className="mb-4 grid gap-2 rounded-lg border border-line bg-surface/40 p-3 sm:grid-cols-2 lg:grid-cols-3">
        <Combobox
          value={typeId}
          onChange={(next) => { setTypeId(next); setPage(1); }}
          placeholder={t('variants.allTypes')}
          options={(typesQuery.data ?? []).map((row) => ({
            value: row.id,
            label: resolveText(row.name, locale),
          }))}
        />
        <Combobox
          value={conceptId}
          onChange={(next) => { setConceptId(next); setPage(1); }}
          placeholder={t('variants.allConcepts')}
          options={(conceptOptions.data ?? []).map((row) => ({
            value: row.id,
            label: resolveText(row.name, locale),
            hint: row.humanId,
          }))}
        />
        <Input
          placeholder={t('variants.searchPlaceholder')}
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
        />
      </div>

      {variantsQuery.isPending ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface text-left text-xs uppercase tracking-wide text-muted">
                <SortHeader sortKey="humanId" state={sort} onSort={onSort}>ID</SortHeader>
                <SortHeader sortKey="name" state={sort} onSort={onSort}>{t('variants.nameLabel')}</SortHeader>
                <SortHeader sortKey="brand" state={sort} onSort={onSort}>{t('variants.brand')}</SortHeader>
                <SortHeader sortKey="concept" state={sort} onSort={onSort}>{t('nav.concepts')}</SortHeader>
                <SortHeader sortKey="type" state={sort} onSort={onSort}>{t('nav.types')}</SortHeader>
                <SortHeader sortKey="packSize" state={sort} onSort={onSort} align="right">{t('variants.packSize')}</SortHeader>
                <SortHeader sortKey="items" state={sort} onSort={onSort} align="right">{t('nav.items')}</SortHeader>
                {canManage && <th className="px-4 py-2.5 text-right font-medium">{t('common.actions')}</th>}
              </tr>
            </thead>
            <tbody>
              {variantsQuery.data?.data.map((row) => (
                <tr key={row.id} className="border-b border-line last:border-0 hover:bg-surface">
                  <td className="px-4 py-2.5"><span className="human-id">{row.humanId}</span></td>
                  <td className="px-4 py-2.5 text-text">{resolveText(row.name, locale)}</td>
                  <td className="px-4 py-2.5 text-muted">{row.brand ?? '—'}</td>
                  <td className="px-4 py-2.5 text-muted">{resolveText(row.conceptName, locale)}</td>
                  <td className="px-4 py-2.5 text-muted">{resolveText(row.typeName, locale)}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-muted">
                    {row.packSize !== null ? `${row.packSize} ${row.packUnit ?? ''}`.trim() : '—'}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-muted">{row.itemCount}</td>
                  {canManage && (
                    <td className="px-4 py-2.5 text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="icon" title={t('common.edit')}
                          onClick={() => { setEditing(row); setDrawerOpen(true); }}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost" size="icon" title={t('common.delete')}
                          onClick={() =>
                            setDeleting({
                              label: row.humanId,
                              onDelete: (cascade) =>
                                deleteVariant.mutateAsync({ id: row.id, cascade }),
                            })
                          }
                        >
                          <Trash2 className="h-4 w-4 text-danger" />
                        </Button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
              {variantsQuery.data?.data.length === 0 && (
                <tr><td colSpan={canManage ? 8 : 7} className="px-4 py-10 text-center text-muted">{t('common.empty')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <Pagination page={page} totalPages={variantsQuery.data?.meta.totalPages ?? 1} onPage={setPage} />

      <DeleteDialog target={deleting} onClose={() => setDeleting(null)} />

      {drawerOpen && (
        <VariantFormDrawer
          key={editing?.id ?? 'new'}
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          editing={editing}
        />
      )}
    </div>
  );
}
