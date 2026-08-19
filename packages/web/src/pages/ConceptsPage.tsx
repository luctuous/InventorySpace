import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { z } from 'zod';
import { conceptCreateSchema, resolveText, roleAtLeast, LOCALES } from '@inventory/shared';
import type { ConceptCreate, ConceptWithStock, Locale } from '@inventory/shared';

type ConceptFormInput = z.input<typeof conceptCreateSchema>;
import { asSessionUser, authClient } from '../api/auth';
import { ApiRequestError } from '../api/client';
import { useConcepts, useCreateConcept, useDeleteConcept, useUpdateConcept } from '../api/concepts';
import { DeleteDialog } from '../components/DeleteDialog';
import type { DeleteTarget } from '../components/DeleteDialog';
import {
  Button,
  FieldError,
  Input,
  Label,
  Modal,
  Pagination,
  Select,
  Spinner,
} from '../components/ui';
import { useI18n } from '../i18n';
import { cn } from '../lib/cn';

// The Phase-1 vertical slice page: list + create + edit + soft delete,
// stock computed server-side, name editable per language (EN required).

type StockLevel = 'ok' | 'low' | 'zero';

function stockLevel(concept: ConceptWithStock): StockLevel {
  if (concept.stock <= 0) return 'zero';
  if (concept.minStockThreshold !== null && concept.stock < concept.minStockThreshold)
    return 'low';
  return 'ok';
}

const dotColor: Record<StockLevel, string> = {
  ok: 'bg-success',
  low: 'bg-warning',
  zero: 'bg-danger',
};

// ---------------------------------------------------------------- form modal

interface FormModalProps {
  open: boolean;
  onClose: () => void;
  editing: ConceptWithStock | null; // null → create
}

function ConceptFormModal({ open, onClose, editing }: FormModalProps) {
  const { t } = useI18n();
  const [nameTab, setNameTab] = useState<Locale>('en');
  const [serverError, setServerError] = useState<string | null>(null);
  const createConcept = useCreateConcept();
  const updateConcept = useUpdateConcept();

  // trackingLevel has a Zod .default(), so the schema's input and output types
  // differ — spell both out or the resolver will not line up (same pattern as
  // TypesPage).
  const form = useForm<ConceptFormInput, unknown, ConceptCreate>({
    resolver: zodResolver(conceptCreateSchema),
    values: editing
      ? {
          name: editing.name,
          unit: editing.unit,
          minStockThreshold: editing.minStockThreshold,
          notes: editing.notes,
          trackingLevel: editing.trackingLevel,
          seededMonthlyRate: editing.seededMonthlyRate,
        }
      : {
          name: { en: '' },
          unit: '',
          minStockThreshold: null,
          notes: null,
          trackingLevel: 1,
          seededMonthlyRate: null,
        },
  });

  const trackingLevel = Number(form.watch('trackingLevel') ?? 1);

  const submit = form.handleSubmit(async (values) => {
    setServerError(null);
    try {
      if (editing) {
        await updateConcept.mutateAsync({ id: editing.id, body: values });
      } else {
        await createConcept.mutateAsync(values);
      }
      form.reset();
      onClose();
    } catch (error) {
      setServerError(error instanceof ApiRequestError ? error.message : String(error));
    }
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? t('concepts.edit') : t('concepts.new')}
    >
      <form onSubmit={submit} className="space-y-4">
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <Label className="mb-0">{t('concepts.nameLabel')}</Label>
            <div className="flex gap-1">
              {LOCALES.map((code) => (
                <button
                  key={code}
                  type="button"
                  onClick={() => setNameTab(code)}
                  className={cn(
                    'rounded px-1.5 py-0.5 font-mono text-[0.65rem] uppercase cursor-pointer',
                    nameTab === code
                      ? 'bg-primary-tint font-semibold text-primary'
                      : 'text-muted hover:text-text',
                  )}
                >
                  {code}
                  {code === 'en' ? '*' : ''}
                </button>
              ))}
            </div>
          </div>
          {/* three registered inputs; only the active language is visible */}
          {LOCALES.map((code) => (
            <Input
              key={code}
              className={nameTab === code ? '' : 'hidden'}
              placeholder={code === 'en' ? 'Wood glue D3' : ''}
              {...form.register(`name.${code}`)}
            />
          ))}
          <FieldError message={form.formState.errors.name?.en?.message} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="unit">{t('concepts.unit')}</Label>
            <Input id="unit" placeholder="L" {...form.register('unit')} />
            <FieldError message={form.formState.errors.unit?.message} />
          </div>
          <div>
            <Label htmlFor="minStock">{t('concepts.minStock')}</Label>
            <Input
              id="minStock"
              type="number"
              step="any"
              min="0"
              {...form.register('minStockThreshold', {
                setValueAs: (v: string) => (v === '' || v === null ? null : Number(v)),
              })}
            />
            <FieldError message={form.formState.errors.minStockThreshold?.message} />
          </div>
        </div>

        <div>
          <Label htmlFor="notes">{t('concepts.notes')}</Label>
          <Input
            id="notes"
            {...form.register('notes', {
              setValueAs: (v: string) => (v === '' || v === null ? null : v),
            })}
          />
        </div>

        {/* Tracking depth is a property of THIS concept, not a global mode —
            a workshop runs all three levels at once. */}
        <div className="rounded-lg border border-line bg-surface-2/40 p-3">
          <Label htmlFor="trackingLevel">{t('tracking.level')}</Label>
          <Select
            id="trackingLevel"
            {...form.register('trackingLevel', { setValueAs: (v: string) => Number(v) })}
          >
            <option value={1}>{t('tracking.level1')}</option>
            <option value={2}>{t('tracking.level2')}</option>
            <option value={3}>{t('tracking.level3')}</option>
          </Select>
          <p className="mt-1.5 text-xs text-muted">{t(`tracking.level${trackingLevel}Hint`)}</p>

          {trackingLevel >= 2 && (
            <div className="mt-3">
              <Label htmlFor="seeded">{t('tracking.seeded')}</Label>
              <Input
                id="seeded"
                type="number"
                step="any"
                min="0"
                placeholder="800"
                {...form.register('seededMonthlyRate', {
                  setValueAs: (v: string) => (v === '' || v === null ? null : Number(v)),
                })}
              />
              <p className="mt-1 text-xs text-muted">{t('tracking.seededHint')}</p>
            </div>
          )}
        </div>

        {serverError && <p className="text-sm text-danger">{serverError}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// --------------------------------------------------------------------- page

export function ConceptsPage() {
  const { t, locale } = useI18n();
  const { data: session } = authClient.useSession();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ConceptWithStock | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const conceptsQuery = useConcepts({ page, search });
  const deleteConcept = useDeleteConcept();

  const user = session ? asSessionUser(session.user) : null;
  const canManage = user !== null && roleAtLeast(user.role, 'manager');

  const [deleting, setDeleting] = useState<DeleteTarget | null>(null);

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-text">{t('concepts.title')}</h1>
        {canManage && (
          <Button
            onClick={() => {
              setEditing(null);
              setModalOpen(true);
            }}
          >
            <Plus className="h-4 w-4" />
            {t('concepts.new')}
          </Button>
        )}
      </div>

      <Input
        className="mb-4 max-w-sm"
        placeholder={t('common.search')}
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setPage(1);
        }}
      />

      {actionError && (
        <p className="mb-3 rounded-md bg-danger-tint px-3 py-2 text-sm text-danger">
          {actionError}
        </p>
      )}

      {conceptsQuery.isPending ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-2.5 font-medium">ID</th>
                <th className="px-4 py-2.5 font-medium">{t('concepts.nameLabel')}</th>
                <th className="px-4 py-2.5 font-medium">{t('concepts.unit')}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t('concepts.stock')}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t('concepts.minStock')}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t('concepts.analogous')}</th>
                {canManage && <th className="px-4 py-2.5 text-right font-medium">{t('common.actions')}</th>}
              </tr>
            </thead>
            <tbody>
              {conceptsQuery.data?.data.map((concept) => {
                const level = stockLevel(concept);
                return (
                  <tr
                    key={concept.id}
                    className="border-b border-line last:border-0 hover:bg-surface"
                  >
                    <td className="px-4 py-2.5">
                      <span className="human-id">{concept.humanId}</span>
                    </td>
                    <td className="px-4 py-2.5 text-text">
                      <span className="inline-flex items-center gap-2">
                        <span className={cn('h-2 w-2 rounded-full', dotColor[level])} />
                        {resolveText(concept.name, locale)}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-muted">{concept.unit}</td>
                    <td
                      className={cn(
                        'px-4 py-2.5 text-right font-mono',
                        level === 'zero'
                          ? 'text-danger'
                          : level === 'low'
                            ? 'text-warning'
                            : 'text-text',
                      )}
                    >
                      {concept.stock}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-muted">
                      {concept.minStockThreshold ?? '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-muted">
                      {concept.analogousCount}
                    </td>
                    {canManage && (
                      <td className="px-4 py-2.5 text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            title={t('common.edit')}
                            onClick={() => {
                              setEditing(concept);
                              setModalOpen(true);
                            }}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            title={t('common.delete')}
                            onClick={() =>
                              setDeleting({
                                label: concept.humanId,
                                onDelete: (cascade) =>
                                  deleteConcept.mutateAsync({ id: concept.id, cascade }),
                              })
                            }
                          >
                            <Trash2 className="h-4 w-4 text-danger" />
                          </Button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
              {conceptsQuery.data?.data.length === 0 && (
                <tr>
                  <td colSpan={canManage ? 7 : 6} className="px-4 py-10 text-center text-muted">
                    {t('common.empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <Pagination
        page={page}
        totalPages={conceptsQuery.data?.meta.totalPages ?? 1}
        onPage={setPage}
      />

      <ConceptFormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        editing={editing}
      />
      <DeleteDialog target={deleting} onClose={() => setDeleting(null)} />
    </div>
  );
}
