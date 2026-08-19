import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { PackageOpen, Pencil, Plus, Trash2 } from 'lucide-react';
import { locationCreateSchema, resolveText, roleAtLeast } from '@inventory/shared';
import type { ItemWithRefs, LocationCreate, LocationLevel } from '@inventory/shared';
import { asSessionUser, authClient } from '../api/auth';
import { ApiRequestError } from '../api/client';
import {
  useCreateLocation,
  useDeleteLocation,
  useItems,
  useLocations,
  useTypes,
  useUpdateLocation,
} from '../api/entities';
import { DeleteDialog } from '../components/DeleteDialog';
import { ItemDrawer } from '../components/ItemDrawer';
import type { DeleteTarget } from '../components/DeleteDialog';
import { LocationTree } from '../components/LocationTree';
import type { LocationNode } from '../components/LocationTree';
import { MultilangInput } from '../components/MultilangInput';
import { useToast } from '../components/toast';
import {
  Button,
  FieldError,
  Input,
  Label,
  Modal,
  Pagination,
  Select,
  Spinner,
  StatusBadge,
} from '../components/ui';
import { useI18n } from '../i18n';
import { formatQty } from '../lib/format';

// Tree CRUD. Child codes are suggested from the parent:
// parent L01R01 + level zone → next free L01R01Z0X.
//
// The tree is also how you BROWSE the place: pick a shelf and the panel beside
// it lists what is on it. Without that, the page could only describe places
// that exist, never answer "what is in this cupboard" — which is the question
// somebody standing in front of the cupboard actually has.

const CHILD_LEVEL: Record<LocationLevel, LocationLevel | null> = {
  site: 'room',
  room: 'zone',
  zone: 'surface',
  surface: null,
};
const LEVEL_SEGMENT: Record<LocationLevel, string> = { site: 'L', room: 'R', zone: 'Z', surface: 'S' };

function suggestChildCode(parent: LocationNode | null, existing: string[], rootCount: number): { code: string; level: LocationLevel } {
  if (!parent) {
    return { code: `L${String(rootCount + 1).padStart(2, '0')}`, level: 'site' };
  }
  const level = CHILD_LEVEL[parent.level] ?? 'surface';
  const seg = LEVEL_SEGMENT[level];
  for (let n = 1; n < 100; n++) {
    const candidate = `${parent.code}${seg}${String(n).padStart(2, '0')}`;
    if (!existing.includes(candidate)) return { code: candidate, level };
  }
  return { code: `${parent.code}${seg}99`, level };
}

function LocationFormModal({
  open,
  onClose,
  parent,
  editing,
  existingCodes,
  rootCount,
}: {
  open: boolean;
  onClose: () => void;
  parent: LocationNode | null;
  editing: LocationNode | null;
  existingCodes: string[];
  rootCount: number;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const createLocation = useCreateLocation();
  const updateLocation = useUpdateLocation();
  const [serverError, setServerError] = useState<string | null>(null);

  const suggestion = suggestChildCode(parent, existingCodes, rootCount);
  const form = useForm<LocationCreate>({
    resolver: zodResolver(locationCreateSchema),
    values: editing
      ? { code: editing.code, level: editing.level, name: editing.name ?? { en: '' }, parentId: editing.parentId }
      : { code: suggestion.code, level: suggestion.level, name: { en: '' }, parentId: parent?.id ?? null },
  });

  const submit = form.handleSubmit(async (values) => {
    setServerError(null);
    const body = { ...values, name: values.name?.en ? values.name : null };
    try {
      if (editing) {
        await updateLocation.mutateAsync({ id: editing.id, body });
      } else {
        await createLocation.mutateAsync(body);
      }
      toast({ message: t('common.saved'), variant: 'success' });
      onClose();
    } catch (error) {
      setServerError(error instanceof ApiRequestError ? error.message : String(error));
    }
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? t('locations.edit') : parent ? `${t('locations.addChild')} — ${parent.code}` : t('locations.newRoot')}
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="loc-code">{t('locations.code')}</Label>
            <Input id="loc-code" className="font-mono" {...form.register('code')} />
            <FieldError message={form.formState.errors.code?.message} />
          </div>
          <div>
            <Label htmlFor="loc-level">{t('locations.level')}</Label>
            <Select id="loc-level" {...form.register('level')}>
              <option value="site">{t('locations.site')}</option>
              <option value="room">{t('locations.room')}</option>
              <option value="zone">{t('locations.zone')}</option>
              <option value="surface">{t('locations.surface')}</option>
            </Select>
          </div>
        </div>
        <MultilangInput
          label={t('locations.nameLabel')}
          basePath="name"
          register={form.register}
          placeholder="Solvent Cabinet"
        />
        {serverError && <p className="text-sm text-danger">{serverError}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>{t('common.save')}</Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * What is in the selected place. Two filters, because standing in front of a
 * shelf you want either "this shelf" or "this room" — and the difference
 * between them is the whole point of having a tree.
 */
function LocationContents({
  node,
  onSelectItem,
}: {
  node: LocationNode;
  onSelectItem: (item: ItemWithRefs) => void;
}) {
  const { t, locale } = useI18n();
  const typesQuery = useTypes();
  const [page, setPage] = useState(1);
  const [includeSubtree, setIncludeSubtree] = useState(true);
  const [typeId, setTypeId] = useState('');
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);

  const itemsQuery = useItems({
    page,
    perPage: 25,
    locationId: node.id,
    locationExact: !includeSubtree,
    typeId: typeId || undefined,
    search: search || undefined,
    // A shelf full of empty bottles is not what the shelf holds.
    status: showInactive ? [] : ['in_stock', 'open', 'in_service', 'active', 'installed'],
  });

  const rows = itemsQuery.data?.data ?? [];
  const hasChildren = node.children.length > 0;

  return (
    <div className="min-w-0">
      <div className="mb-3 flex flex-wrap items-baseline gap-2">
        <span className="human-id">{node.code}</span>
        <h2 className="text-lg font-medium text-text">{resolveText(node.name, locale)}</h2>
        <span className="text-xs text-muted">
          {t(`locations.level.${node.level}`)} ·{' '}
          {t('locations.itemsHere', { n: node.subtreeItemCount })}
        </span>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          className="max-w-48"
          placeholder={t('common.search')}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        <Select
          className="h-9 w-auto min-w-36 text-xs"
          value={typeId}
          onChange={(e) => {
            setTypeId(e.target.value);
            setPage(1);
          }}
        >
          <option value="">{t('items.allTypes')}</option>
          {typesQuery.data?.map((type) => (
            <option key={type.id} value={type.id}>
              {resolveText(type.name, locale)}
            </option>
          ))}
        </Select>
        {hasChildren && (
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-(--color-primary-base)"
              checked={includeSubtree}
              onChange={(e) => {
                setIncludeSubtree(e.target.checked);
                setPage(1);
              }}
            />
            {t('locations.includeSubtree')}
          </label>
        )}
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-(--color-primary-base)"
            checked={showInactive}
            onChange={(e) => {
              setShowInactive(e.target.checked);
              setPage(1);
            }}
          />
          {t('locations.showInactive')}
        </label>
      </div>

      {itemsQuery.isPending ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line py-12 text-center">
          <PackageOpen className="mx-auto mb-2 h-7 w-7 text-muted" />
          <p className="text-sm text-muted">{t('locations.emptyHere')}</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <tbody>
              {rows.map((item) => (
                <tr
                  key={item.id}
                  onClick={() => onSelectItem(item)}
                  className="cursor-pointer border-b border-line last:border-0 hover:bg-surface-2"
                >
                  <td className="px-3 py-2">
                    <span className="human-id">{item.humanId}</span>
                  </td>
                  {/* w-full + max-w-0: the name column takes whatever the
                      fixed columns leave and truncates inside it, instead of
                      collapsing to one letter. */}
                  <td className="w-full max-w-0 px-3 py-2">
                    <span className="block truncate text-text">
                      {resolveText(item.variantName, locale) ||
                        resolveText(item.conceptName, locale) ||
                        '—'}
                    </span>
                    <span className="block truncate text-xs text-muted">
                      {resolveText(item.typeName, locale)}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs text-muted">
                    {formatQty(item.quantityRemaining, item.unit)}
                  </td>
                  {/* Where exactly, when the list spans a subtree. */}
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    {item.locationCode !== node.code && (
                      <span className="human-id text-xs">{item.locationCode}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <StatusBadge status={item.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pagination
        page={page}
        totalPages={itemsQuery.data?.meta.totalPages ?? 1}
        onPage={setPage}
      />
    </div>
  );
}

export function LocationsPage() {
  const { t } = useI18n();
  const toast = useToast();
  const { data: session } = authClient.useSession();
  const locationsQuery = useLocations();
  const deleteLocation = useDeleteLocation();
  const [modal, setModal] = useState<{ parent: LocationNode | null; editing: LocationNode | null } | null>(null);

  const user = session ? asSessionUser(session.user) : null;
  const canManage = user !== null && roleAtLeast(user.role, 'manager');

  const [deleting, setDeleting] = useState<DeleteTarget | null>(null);
  const [selected, setSelected] = useState<LocationNode | null>(null);
  const [selectedItem, setSelectedItem] = useState<ItemWithRefs | null>(null);

  if (locationsQuery.isPending) {
    return <div className="flex justify-center py-16"><Spinner /></div>;
  }

  const locations = locationsQuery.data ?? [];
  const rootCount = locations.filter((l) => l.parentId === null).length;

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-text">{t('locations.title')}</h1>
        {canManage && (
          <Button onClick={() => setModal({ parent: null, editing: null })}>
            <Plus className="h-4 w-4" /> {t('locations.newRoot')}
          </Button>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-[22rem_1fr]">
      <div
        data-tour="location-tree"
        className="h-fit min-w-0 overflow-x-auto rounded-lg border border-line bg-surface/40 p-3"
      >
        {locations.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-muted">{t('common.empty')}</p>
        ) : (
          <LocationTree
            locations={locations}
            showCounts
            selectedId={selected?.id ?? null}
            onSelect={(node) => setSelected(node.id === selected?.id ? null : node)}
            renderActions={
              canManage
                ? (node) => (
                    <span className="flex gap-0.5">
                      {CHILD_LEVEL[node.level] && (
                        <Button variant="ghost" size="icon" className="h-6 w-6" title={t('locations.addChild')}
                          onClick={() => setModal({ parent: node, editing: null })}>
                          <Plus className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      <Button variant="ghost" size="icon" className="h-6 w-6" title={t('common.edit')}
                        onClick={() => setModal({ parent: null, editing: node })}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost" size="icon" className="h-6 w-6" title={t('common.delete')}
                        onClick={() =>
                          setDeleting({
                            label: node.code,
                            onDelete: (cascade) =>
                              deleteLocation.mutateAsync({ id: node.id, cascade }),
                          })
                        }
                      >
                        <Trash2 className="h-3.5 w-3.5 text-danger" />
                      </Button>
                    </span>
                  )
                : undefined
            }
          />
        )}
      </div>

        {selected ? (
          <LocationContents node={selected} onSelectItem={setSelectedItem} />
        ) : (
          <div className="flex h-fit items-center justify-center rounded-lg border border-dashed border-line py-16">
            <p className="max-w-xs text-center text-sm text-muted">{t('locations.pickHint')}</p>
          </div>
        )}
      </div>

      <ItemDrawer item={selectedItem} onClose={() => setSelectedItem(null)} />

      <DeleteDialog target={deleting} onClose={() => setDeleting(null)} />

      {modal && (
        <LocationFormModal
          open
          onClose={() => setModal(null)}
          parent={modal.parent}
          editing={modal.editing}
          existingCodes={locations.map((l) => l.code)}
          rootCount={rootCount}
        />
      )}
    </div>
  );
}
