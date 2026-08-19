import { useRef, useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowDown, ArrowUp, GripVertical, Pencil, Plus, Trash2 } from 'lucide-react';
import { z } from 'zod';
import { ITEM_STATUSES, resolveText, typeCreateSchema } from '@inventory/shared';
import type { TypeCreate, TypeWithCount } from '@inventory/shared';
import { ApiRequestError } from '../api/client';
import { useCreateType, useDeleteType, useTypes, useUpdateType } from '../api/entities';
import { CustomFields } from '../components/CustomFields';
import { MultilangInput } from '../components/MultilangInput';
import { useToast } from '../components/toast';
import { Button, Drawer, FieldError, Input, Label, Select, Spinner } from '../components/ui';
import { useI18n } from '../i18n';
import { cn } from '../lib/cn';

// The configurability showcase. Built in de-risk order:
// basic props → field builder with up/down buttons → live preview.

// The schema has defaults (field `required`/`order`), so what the form holds
// (input) and what validation produces (output) differ — react-hook-form is
// told both, and handleSubmit hands us the parsed output.
type TypeFormInput = z.input<typeof typeCreateSchema>;

const EMPTY_FORM: TypeFormInput = {
  key: '',
  name: { en: '' },
  humanIdPrefix: '',
  validStatuses: ['in_stock', 'open', 'depleted'],
  tracksQuantity: true,
  countsAsStock: true,
  fieldDefinitions: [],
};

function TypeEditor({
  open,
  onClose,
  editing,
}: {
  open: boolean;
  onClose: () => void;
  editing: TypeWithCount | null;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const createType = useCreateType();
  const updateType = useUpdateType();
  const [serverError, setServerError] = useState<string | null>(null);
  const [previewValues, setPreviewValues] = useState<Record<string, unknown>>({});
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  /**
   * The key each field had when the editor opened, keyed by the field's own
   * stable id rather than its position — otherwise dragging a field to a new
   * slot would read as a rename. Renaming is allowed, but the server must be
   * told so it can migrate the values already stored under the old key.
   */
  const originalKeyById = useRef(new Map<string, string>());

  const form = useForm<TypeFormInput, unknown, TypeCreate>({
    resolver: zodResolver(typeCreateSchema),
    values: editing
      ? {
          key: editing.key,
          name: editing.name,
          humanIdPrefix: editing.humanIdPrefix,
          validStatuses: editing.validStatuses,
          tracksQuantity: editing.tracksQuantity,
          countsAsStock: editing.countsAsStock,
          fieldDefinitions: editing.fieldDefinitions,
        }
      : EMPTY_FORM,
  });
  const fieldArray = useFieldArray({ control: form.control, name: 'fieldDefinitions' });
  const watched = form.watch();

  // Captured once per edit target (the component is remounted per target).
  if (editing && originalKeyById.current.size === 0) {
    fieldArray.fields.forEach((field, index) => {
      const key = editing.fieldDefinitions[index]?.key;
      if (key) originalKeyById.current.set(field.id, key);
    });
  }

  const submit = form.handleSubmit(async (values) => {
    setServerError(null);
    const ordered = {
      ...values,
      fieldDefinitions: values.fieldDefinitions.map((def, i) => ({ ...def, order: i })),
    };
    try {
      if (editing) {
        const { key: _key, ...body } = ordered;
        const renames: Record<string, string> = {};
        fieldArray.fields.forEach((field, index) => {
          const before = originalKeyById.current.get(field.id);
          const after = values.fieldDefinitions[index]?.key;
          if (before && after && before !== after) renames[before] = after;
        });
        await updateType.mutateAsync({
          id: editing.id,
          body: Object.keys(renames).length > 0 ? { ...body, fieldKeyRenames: renames } : body,
        });
      } else {
        await createType.mutateAsync(ordered);
      }
      toast({ message: t('common.saved'), variant: 'success' });
      onClose();
    } catch (error) {
      setServerError(error instanceof ApiRequestError ? error.message : String(error));
    }
  });

  return (
    <Drawer open={open} onClose={onClose} wide title={editing ? t('types.edit') : t('types.new')}>
      <form onSubmit={submit} className="grid gap-6 lg:grid-cols-[1fr_16rem]">
        <div className="space-y-4">
          <MultilangInput
            label={t('types.nameLabel')}
            basePath="name"
            register={form.register}
            error={form.formState.errors.name?.en?.message}
            placeholder="Supply"
          />

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="type-key">{t('types.key')}</Label>
              <Input
                id="type-key"
                placeholder="supply"
                disabled={!!editing}
                {...form.register('key')}
              />
              <FieldError message={form.formState.errors.key?.message} />
            </div>
            <div>
              <Label htmlFor="type-prefix">{t('types.prefix')}</Label>
              <Input id="type-prefix" placeholder="supply" {...form.register('humanIdPrefix')} />
              <FieldError message={form.formState.errors.humanIdPrefix?.message} />
            </div>
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-sm text-text">
            <input
              type="checkbox"
              className="h-4 w-4 accent-(--color-primary-base)"
              {...form.register('tracksQuantity')}
            />
            {t('types.tracksQuantity')}
          </label>

          {/* Instruments and documents say no: they are Items with Concepts
              underneath so they can still be bought, but "0 in stock" is not
              a warning about them. */}
          <label className="flex cursor-pointer items-start gap-2 text-sm text-text">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-(--color-primary-base)"
              {...form.register('countsAsStock')}
            />
            <span>
              {t('types.countsAsStock')}
              <span className="block text-xs text-muted">{t('types.countsAsStockHint')}</span>
            </span>
          </label>

          <div>
            <Label>{t('types.validStatuses')}</Label>
            <div className="grid grid-cols-2 gap-1.5 rounded-md border border-line p-3 sm:grid-cols-3">
              {ITEM_STATUSES.map((status) => (
                <label key={status} className="flex cursor-pointer items-center gap-1.5 font-mono text-xs text-text">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-(--color-primary-base)"
                    value={status}
                    checked={watched.validStatuses.includes(status)}
                    onChange={(e) => {
                      const current = form.getValues('validStatuses');
                      form.setValue(
                        'validStatuses',
                        e.target.checked
                          ? [...current, status]
                          : current.filter((s) => s !== status),
                        { shouldValidate: true },
                      );
                    }}
                  />
                  {status}
                </label>
              ))}
            </div>
            <FieldError message={form.formState.errors.validStatuses?.message} />
          </div>

          {/* ------------------------------------------- field builder */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <Label className="mb-0">{t('types.fields')}</Label>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  fieldArray.append({
                    key: '',
                    label: { en: '' },
                    kind: 'text',
                    required: false,
                    order: fieldArray.fields.length,
                  })
                }
              >
                <Plus className="h-3.5 w-3.5" /> {t('types.addField')}
              </Button>
            </div>

            <div className="space-y-3">
              {fieldArray.fields.map((field, index) => {
                const kind = watched.fieldDefinitions[index]?.kind;
                const originalKey = originalKeyById.current.get(field.id);
                const currentKey = watched.fieldDefinitions[index]?.key ?? '';
                const renamed = originalKey !== undefined && originalKey !== currentKey;
                return (
                  <div
                    key={field.id}
                    draggable
                    onDragStart={() => setDragIndex(index)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => {
                      if (dragIndex !== null && dragIndex !== index) fieldArray.move(dragIndex, index);
                      setDragIndex(null);
                    }}
                    onDragEnd={() => setDragIndex(null)}
                    className={cn(
                      'rounded-md border border-line bg-surface-2/40 p-3',
                      dragIndex === index && 'opacity-50',
                    )}
                  >
                    <div className="mb-2 flex items-center gap-1.5">
                      <span
                        className="cursor-grab text-muted active:cursor-grabbing"
                        title={t('types.dragHint')}
                      >
                        <GripVertical className="h-4 w-4" />
                      </span>
                      <Input
                        className="h-8 flex-1 font-mono text-xs"
                        placeholder="fieldKey"
                        {...form.register(`fieldDefinitions.${index}.key`)}
                      />
                      <Select className="h-8 w-28" {...form.register(`fieldDefinitions.${index}.kind`)}>
                        <option value="text">text</option>
                        <option value="number">number</option>
                        <option value="date">date</option>
                        <option value="boolean">boolean</option>
                        <option value="select">select</option>
                      </Select>
                      <Button
                        variant="ghost" size="icon" className="h-8 w-8"
                        disabled={index === 0}
                        onClick={() => fieldArray.move(index, index - 1)}
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost" size="icon" className="h-8 w-8"
                        disabled={index === fieldArray.fields.length - 1}
                        onClick={() => fieldArray.move(index, index + 1)}
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost" size="icon" className="h-8 w-8"
                        onClick={() => fieldArray.remove(index)}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-danger" />
                      </Button>
                    </div>
                    <div className={cn('grid gap-2', kind === 'number' || kind === 'select' ? 'sm:grid-cols-2' : '')}>
                      <MultilangInput
                        label={t('types.fieldLabel')}
                        basePath={`fieldDefinitions.${index}.label`}
                        register={form.register}
                        error={form.formState.errors.fieldDefinitions?.[index]?.label?.en?.message}
                      />
                      {kind === 'number' && (
                        <div>
                          <Label>{t('types.unit')}</Label>
                          <Input placeholder="mL" {...form.register(`fieldDefinitions.${index}.unit`)} />
                        </div>
                      )}
                      {kind === 'select' && (
                        <div>
                          <Label>{t('types.options')}</Label>
                          <Input
                            placeholder="a, b, c"
                            defaultValue={(watched.fieldDefinitions[index]?.options ?? []).join(', ')}
                            onChange={(e) =>
                              form.setValue(
                                `fieldDefinitions.${index}.options`,
                                e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                              )
                            }
                          />
                        </div>
                      )}
                    </div>
                    <label className="mt-2 flex cursor-pointer items-center gap-1.5 text-xs text-muted">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-(--color-primary-base)"
                        {...form.register(`fieldDefinitions.${index}.required`)}
                      />
                      {t('types.required')}
                    </label>
                    {renamed && (
                      <p className="mt-1.5 rounded bg-warning-tint px-2 py-1 text-[0.7rem] text-warning">
                        {t('types.keyRenamed')
                          .replace('{old}', originalKey!)
                          .replace('{new}', currentKey)}
                      </p>
                    )}
                  </div>
                );
              })}
              {fieldArray.fields.length === 0 && (
                <p className="rounded-md border border-dashed border-line px-3 py-4 text-center text-xs text-muted">
                  {t('types.noFields')}
                </p>
              )}
            </div>
          </div>

          {serverError && <p className="text-sm text-danger">{serverError}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={form.formState.isSubmitting}>{t('common.save')}</Button>
          </div>
        </div>

        {/* --------------------------------------------- live preview */}
        <div className="h-fit rounded-lg border border-line bg-bg p-4 lg:sticky lg:top-0">
          <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted">
            {t('types.preview')}
          </p>
          <CustomFields
            definitions={(watched.fieldDefinitions ?? []).map((def, i) => ({
              key: def.key || `field${i}`,
              label: def.label?.en ? def.label : { en: def.key || `Field ${i + 1}` },
              kind: def.kind ?? 'text',
              required: def.required ?? false,
              unit: def.unit,
              options: def.options,
              order: i,
            }))}
            values={previewValues}
            onChange={setPreviewValues}
          />
          {watched.fieldDefinitions.length === 0 && (
            <p className="text-xs text-muted">{t('types.previewEmpty')}</p>
          )}
        </div>
      </form>
    </Drawer>
  );
}

export function TypesPage() {
  const { t, locale } = useI18n();
  const toast = useToast();
  const typesQuery = useTypes();
  const deleteType = useDeleteType();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<TypeWithCount | null>(null);

  const onDelete = async (type: TypeWithCount) => {
    if (!window.confirm(`${t('types.deleteConfirm')} (${type.key})`)) return;
    try {
      await deleteType.mutateAsync(type.id);
      toast({ message: t('common.deleted'), variant: 'success' });
    } catch (error) {
      toast({
        message: error instanceof ApiRequestError ? error.message : String(error),
        variant: 'danger',
      });
    }
  };

  if (typesQuery.isPending) {
    return <div className="flex justify-center py-16"><Spinner /></div>;
  }

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-text">{t('types.title')}</h1>
        <Button onClick={() => { setEditing(null); setEditorOpen(true); }}>
          <Plus className="h-4 w-4" /> {t('types.new')}
        </Button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line bg-surface text-left text-xs uppercase tracking-wide text-muted">
              <th className="px-4 py-2.5 font-medium">{t('types.key')}</th>
              <th className="px-4 py-2.5 font-medium">{t('types.nameLabel')}</th>
              <th className="px-4 py-2.5 font-medium">{t('types.prefix')}</th>
              <th className="px-4 py-2.5 text-center font-medium">{t('types.tracksQuantityShort')}</th>
              <th className="px-4 py-2.5 text-center font-medium">{t('types.countsAsStockShort')}</th>
              <th className="px-4 py-2.5 text-right font-medium">{t('types.fields')}</th>
              <th className="px-4 py-2.5 text-right font-medium">{t('nav.items')}</th>
              <th className="px-4 py-2.5 text-right font-medium">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {typesQuery.data?.map((type) => (
              <tr key={type.id} className="border-b border-line last:border-0 hover:bg-surface">
                <td className="px-4 py-2.5"><span className="human-id">{type.key}</span></td>
                <td className="px-4 py-2.5 text-text">{resolveText(type.name, locale)}</td>
                <td className="px-4 py-2.5 font-mono text-xs text-muted">{type.humanIdPrefix}</td>
                <td className="px-4 py-2.5 text-center">{type.tracksQuantity ? '✓' : '—'}</td>
                <td className="px-4 py-2.5 text-center">{type.countsAsStock ? '✓' : '—'}</td>
                <td className="px-4 py-2.5 text-right font-mono text-muted">{type.fieldDefinitions.length}</td>
                <td className="px-4 py-2.5 text-right font-mono text-muted">{type.itemCount}</td>
                <td className="px-4 py-2.5 text-right">
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="icon" title={t('common.edit')}
                      onClick={() => { setEditing(type); setEditorOpen(true); }}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" title={t('common.delete')} onClick={() => void onDelete(type)}>
                      <Trash2 className="h-4 w-4 text-danger" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <TypeEditor
        key={editing?.id ?? 'new'} // reset form + frozen keys per target
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        editing={editing}
      />
    </div>
  );
}
