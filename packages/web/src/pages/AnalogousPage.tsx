import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { analogousCreateSchema, resolveText, roleAtLeast } from '@inventory/shared';
import type { AnalogousCreate, AnalogousWithCount } from '@inventory/shared';
import { asSessionUser, authClient } from '../api/auth';
import { ApiRequestError } from '../api/client';
import { useConcepts } from '../api/concepts';
import { useAnalogous, useCreateAnalogous, useDeleteAnalogous, useUpdateAnalogous } from '../api/entities';
import { DeleteDialog } from '../components/DeleteDialog';
import type { DeleteTarget } from '../components/DeleteDialog';
import { MultilangInput } from '../components/MultilangInput';
import { useToast } from '../components/toast';
import { Button, FieldError, Input, Label, Modal, Pagination, Select, Spinner, Textarea } from '../components/ui';
import { useI18n } from '../i18n';

function AnalogousFormModal({
  open,
  onClose,
  editing,
}: {
  open: boolean;
  onClose: () => void;
  editing: AnalogousWithCount | null;
}) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const conceptsQuery = useConcepts({ page: 1 });
  const createAnalogous = useCreateAnalogous();
  const updateAnalogous = useUpdateAnalogous();
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<AnalogousCreate>({
    resolver: zodResolver(analogousCreateSchema),
    values: editing
      ? { conceptId: editing.conceptId, name: editing.name, notes: editing.notes }
      : { conceptId: '', name: { en: '' }, notes: null },
  });

  const watchedConceptId = form.watch('conceptId');
  // THE warning: re-parenting mass-updates all descendants.
  const showRelinkWarning =
    editing !== null &&
    watchedConceptId !== editing.conceptId &&
    (editing.variantCount > 0 || editing.itemCount > 0);

  const submit = form.handleSubmit(async (values) => {
    setServerError(null);
    try {
      if (editing) {
        await updateAnalogous.mutateAsync({ id: editing.id, body: values });
      } else {
        await createAnalogous.mutateAsync(values);
      }
      toast({ message: t('common.saved'), variant: 'success' });
      onClose();
    } catch (error) {
      setServerError(error instanceof ApiRequestError ? error.message : String(error));
    }
  });

  return (
    <Modal open={open} onClose={onClose} title={editing ? t('analogous.edit') : t('analogous.new')}>
      <form onSubmit={submit} className="space-y-4">
        <MultilangInput
          label={t('analogous.nameLabel')}
          basePath="name"
          register={form.register}
          error={form.formState.errors.name?.en?.message}
        />
        <div>
          <Label htmlFor="ana-concept">{t('nav.concepts')}</Label>
          <Select id="ana-concept" {...form.register('conceptId')}>
            <option value="">—</option>
            {conceptsQuery.data?.data.map((concept) => (
              <option key={concept.id} value={concept.id}>
                {concept.humanId} · {resolveText(concept.name, locale)}
              </option>
            ))}
          </Select>
          <FieldError message={form.formState.errors.conceptId?.message} />
          {showRelinkWarning && (
            <p className="mt-2 rounded-md bg-warning-tint px-3 py-2 text-xs text-warning">
              ⚠ {t('analogous.relinkWarning')
                .replace('{variants}', String(editing.variantCount))
                .replace('{items}', String(editing.itemCount))}
            </p>
          )}
        </div>
        <div>
          <Label htmlFor="ana-notes">{t('concepts.notes')}</Label>
          <Textarea
            id="ana-notes"
            {...form.register('notes', { setValueAs: (v: string) => (v ? v : null) })}
          />
        </div>
        {serverError && <p className="text-sm text-danger">{serverError}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>{t('common.save')}</Button>
        </div>
      </form>
    </Modal>
  );
}

export function AnalogousPage() {
  const { t, locale } = useI18n();
  const toast = useToast();
  const { data: session } = authClient.useSession();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<AnalogousWithCount | null>(null);

  const analogousQuery = useAnalogous({ page, search });
  const deleteAnalogous = useDeleteAnalogous();

  const user = session ? asSessionUser(session.user) : null;
  const canManage = user !== null && roleAtLeast(user.role, 'manager');

  const [deleting, setDeleting] = useState<DeleteTarget | null>(null);

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-text">{t('analogous.title')}</h1>
        {canManage && (
          <Button onClick={() => { setEditing(null); setModalOpen(true); }}>
            <Plus className="h-4 w-4" /> {t('analogous.new')}
          </Button>
        )}
      </div>

      <Input
        className="mb-4 max-w-sm"
        placeholder={t('common.search')}
        value={search}
        onChange={(e) => { setSearch(e.target.value); setPage(1); }}
      />

      {analogousQuery.isPending ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-2.5 font-medium">ID</th>
                <th className="px-4 py-2.5 font-medium">{t('analogous.nameLabel')}</th>
                <th className="px-4 py-2.5 font-medium">{t('nav.concepts')}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t('nav.variants')}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t('nav.items')}</th>
                {canManage && <th className="px-4 py-2.5 text-right font-medium">{t('common.actions')}</th>}
              </tr>
            </thead>
            <tbody>
              {analogousQuery.data?.data.map((row) => (
                <tr key={row.id} className="border-b border-line last:border-0 hover:bg-surface">
                  <td className="px-4 py-2.5"><span className="human-id">{row.humanId}</span></td>
                  <td className="px-4 py-2.5 text-text">{resolveText(row.name, locale)}</td>
                  <td className="px-4 py-2.5">
                    {row.conceptHumanId && <span className="human-id mr-2">{row.conceptHumanId}</span>}
                    <span className="text-muted">{resolveText(row.conceptName, locale)}</span>
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-muted">{row.variantCount}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-muted">{row.itemCount}</td>
                  {canManage && (
                    <td className="px-4 py-2.5 text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="icon" title={t('common.edit')}
                          onClick={() => { setEditing(row); setModalOpen(true); }}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost" size="icon" title={t('common.delete')}
                          onClick={() =>
                            setDeleting({
                              label: row.humanId,
                              onDelete: (cascade) =>
                                deleteAnalogous.mutateAsync({ id: row.id, cascade }),
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
              {analogousQuery.data?.data.length === 0 && (
                <tr><td colSpan={canManage ? 6 : 5} className="px-4 py-10 text-center text-muted">{t('common.empty')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <Pagination page={page} totalPages={analogousQuery.data?.meta.totalPages ?? 1} onPage={setPage} />

      <DeleteDialog target={deleting} onClose={() => setDeleting(null)} />

      {modalOpen && (
        <AnalogousFormModal
          key={editing?.id ?? 'new'}
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          editing={editing}
        />
      )}
    </div>
  );
}
