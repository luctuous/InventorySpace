import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AnalogousCreate,
  AnalogousUpdate,
  AnalogousWithCount,
  AppUser,
  Analogous,
  CsvImportResult,
  FastKey,
  ItemSortKey,
  TranslatedText,
  VariantSortKey,
  TrashEntity,
  TrashRow,
  ItemCreate,
  ItemUpdate,
  ItemWithRefs,
  Item,
  Location,
  LocationCreate,
  LocationUpdate,
  LocationWithCount,
  PaginationMeta,
  QuickAdd,
  QuickAddResponse,
  QuickSearchResult,
  Type,
  TypeCreate,
  TypeUpdate,
  TypeWithCount,
  UserCreate,
  UserRole,
  Variant,
  VariantCreate,
  VariantUpdate,
  VariantWithRefs,
} from '@inventory/shared';
import { api } from './client';

// One hooks module for the Phase-2 entities, all following the concepts.ts
// pattern: [entity, 'list', filters] keys, invalidate the entity + history.

type Paged<T> = { data: T[]; meta: PaginationMeta };

function useInvalidator(...keys: string[]) {
  const queryClient = useQueryClient();
  return () => {
    for (const key of [...keys, 'history']) {
      void queryClient.invalidateQueries({ queryKey: [key] });
    }
  };
}

// ------------------------------------------------------------------- types

export function useTypes() {
  return useQuery({
    queryKey: ['types', 'list'],
    queryFn: () => api<TypeWithCount[]>('/types'),
    staleTime: 5 * 60_000, // types change rarely; forms read them constantly
  });
}

export function useCreateType() {
  const invalidate = useInvalidator('types');
  return useMutation({
    mutationFn: (body: TypeCreate) => api<Type>('/types', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useUpdateType() {
  const invalidate = useInvalidator('types');
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: TypeUpdate }) =>
      api<Type>(`/types/${id}`, { method: 'PATCH', body }),
    onSuccess: invalidate,
  });
}

export function useDeleteType() {
  const invalidate = useInvalidator('types');
  return useMutation({
    mutationFn: (id: string) => api<Type>(`/types/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
}

// --------------------------------------------------------------- locations

export function useLocations() {
  return useQuery({
    queryKey: ['locations', 'list'],
    queryFn: () => api<LocationWithCount[]>('/locations'),
  });
}

export function useCreateLocation() {
  const invalidate = useInvalidator('locations');
  return useMutation({
    mutationFn: (body: LocationCreate) => api<Location>('/locations', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useUpdateLocation() {
  const invalidate = useInvalidator('locations');
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: LocationUpdate }) =>
      api<Location>(`/locations/${id}`, { method: 'PATCH', body }),
    onSuccess: invalidate,
  });
}

export function useDeleteLocation() {
  const invalidate = useInvalidator('locations', 'items', 'trash');
  return useMutation({
    mutationFn: ({ id, cascade }: { id: string; cascade?: boolean }) =>
      api<Location>(`/locations/${id}`, {
        method: 'DELETE',
        query: cascade ? { cascade: 'true' } : undefined,
      }),
    onSuccess: invalidate,
  });
}

// --------------------------------------------------------------- analogous

export interface AnalogousListParams {
  page?: number;
  conceptId?: string;
  search?: string;
}

export function useAnalogous(params: AnalogousListParams) {
  return useQuery({
    queryKey: ['analogous', 'list', params],
    queryFn: () =>
      api<Paged<AnalogousWithCount>>('/analogous', {
        query: { page: params.page ?? 1, conceptId: params.conceptId, search: params.search || undefined },
      }),
    placeholderData: keepPreviousData,
  });
}

export function useCreateAnalogous() {
  const invalidate = useInvalidator('analogous', 'concepts');
  return useMutation({
    mutationFn: (body: AnalogousCreate) => api<Analogous>('/analogous', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useUpdateAnalogous() {
  // conceptId change mass-updates variants+items server-side → refresh all
  const invalidate = useInvalidator('analogous', 'concepts', 'variants', 'items');
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: AnalogousUpdate }) =>
      api<Analogous>(`/analogous/${id}`, { method: 'PATCH', body }),
    onSuccess: invalidate,
  });
}

export function useDeleteAnalogous() {
  const invalidate = useInvalidator('analogous', 'concepts', 'variants', 'items', 'trash');
  return useMutation({
    mutationFn: ({ id, cascade }: { id: string; cascade?: boolean }) =>
      api<Analogous>(`/analogous/${id}`, {
        method: 'DELETE',
        query: cascade ? { cascade: 'true' } : undefined,
      }),
    onSuccess: invalidate,
  });
}

// ---------------------------------------------------------------- variants

export interface VariantListParams {
  page?: number;
  analogousId?: string;
  conceptId?: string;
  typeId?: string;
  search?: string;
  sort?: VariantSortKey;
  dir?: 'asc' | 'desc';
  /** Which language the name columns sort by — see the note in routes/items.ts. */
  locale?: string;
}

export function useVariants(params: VariantListParams) {
  return useQuery({
    queryKey: ['variants', 'list', params],
    queryFn: () =>
      api<Paged<VariantWithRefs>>('/variants', {
        query: {
          page: params.page ?? 1,
          analogousId: params.analogousId,
          conceptId: params.conceptId,
          typeId: params.typeId,
          search: params.search || undefined,
          sort: params.sort,
          dir: params.sort ? params.dir : undefined,
          locale: params.sort ? params.locale : undefined,
        },
      }),
    placeholderData: keepPreviousData,
  });
}

/** Every variant, dropdown-sized. See /variants/options in the API. */
export interface VariantOption {
  id: string;
  humanId: string;
  name: TranslatedText;
  brand: string | null;
  packSize: number | null;
  packUnit: string | null;
  conceptId: string;
  typeId: string;
}

export function useVariantOptions(filter: { conceptId?: string; typeId?: string } = {}) {
  return useQuery({
    queryKey: ['variants', 'options', filter],
    queryFn: () =>
      api<VariantOption[]>('/variants/options', {
        query: { conceptId: filter.conceptId, typeId: filter.typeId },
      }),
    staleTime: 60_000,
  });
}

export function useCreateVariant() {
  const invalidate = useInvalidator('variants', 'analogous');
  return useMutation({
    mutationFn: (body: VariantCreate) => api<Variant>('/variants', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useUpdateVariant() {
  const invalidate = useInvalidator('variants', 'analogous', 'concepts', 'items');
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: VariantUpdate }) =>
      api<Variant>(`/variants/${id}`, { method: 'PATCH', body }),
    onSuccess: invalidate,
  });
}

export function useDeleteVariant() {
  const invalidate = useInvalidator('variants', 'analogous', 'items', 'trash');
  return useMutation({
    mutationFn: ({ id, cascade }: { id: string; cascade?: boolean }) =>
      api<Variant>(`/variants/${id}`, {
        method: 'DELETE',
        query: cascade ? { cascade: 'true' } : undefined,
      }),
    onSuccess: invalidate,
  });
}

// ------------------------------------------------------------------- items

export interface ItemListParams {
  page?: number;
  status?: string[]; // joined server-side as CSV
  typeId?: string;
  conceptId?: string;
  variantId?: string;
  locationId?: string;
  /** True = only that exact location, not everything filed under it. */
  locationExact?: boolean;
  search?: string;
  perPage?: number;
  sort?: ItemSortKey;
  dir?: 'asc' | 'desc';
  locale?: string;
}

/** One item, by id — for the places that hold an id and want the whole row. */
export function useItem(id: string | null) {
  return useQuery({
    queryKey: ['items', 'detail', id],
    queryFn: () => api<ItemWithRefs>(`/items/${id}`),
    enabled: id !== null,
  });
}

export function useItems(params: ItemListParams, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['items', 'list', params],
    queryFn: () =>
      api<Paged<ItemWithRefs>>('/items', {
        query: {
          page: params.page ?? 1,
          perPage: params.perPage,
          status: params.status?.length ? params.status.join(',') : undefined,
          typeId: params.typeId,
          conceptId: params.conceptId,
          variantId: params.variantId,
          locationId: params.locationId,
          locationExact: params.locationExact ? 'true' : undefined,
          search: params.search || undefined,
          sort: params.sort,
          // Only sent alongside a sort key: they mean nothing on their own and
          // would otherwise split the query cache for identical results.
          dir: params.sort ? params.dir : undefined,
          locale: params.sort ? params.locale : undefined,
        },
      }),
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
  });
}

export function useItemMetrics(locationId?: string) {
  return useQuery({
    queryKey: ['items', 'metrics', locationId ?? null],
    queryFn: () =>
      api<{ activeItems: number; openItems: number }>('/items/metrics', {
        query: { locationId },
      }),
  });
}

export function useConceptStockMap(locationId?: string) {
  return useQuery({
    queryKey: ['concepts', 'stock-map', locationId ?? null],
    queryFn: () =>
      api<Record<string, number>>('/concepts/stock', { query: { locationId } }),
  });
}

export function useQuickSearch(q: string) {
  return useQuery({
    queryKey: ['items', 'quick-search', q],
    queryFn: () => api<QuickSearchResult>('/items/quick-search', { query: { q } }),
    enabled: q.trim().length >= 2,
    placeholderData: keepPreviousData,
  });
}

function useInvalidateItems() {
  return useInvalidator('items', 'concepts', 'analogous', 'variants', 'locations');
}

export function useCreateItems() {
  const invalidate = useInvalidateItems();
  return useMutation({
    mutationFn: (body: ItemCreate) => api<Item[]>('/items', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useQuickAdd() {
  const invalidate = useInvalidateItems();
  return useMutation({
    mutationFn: (body: QuickAdd) =>
      api<QuickAddResponse>('/items/quick', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useUpdateItem() {
  const invalidate = useInvalidateItems();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ItemUpdate }) =>
      api<Item>(`/items/${id}`, { method: 'PATCH', body }),
    onSuccess: invalidate,
  });
}

/** open | deplete | delete, plus generic status/move/adjust actions. */
export function useItemAction() {
  const invalidate = useInvalidateItems();
  return useMutation({
    mutationFn: ({
      id,
      action,
      body,
    }: {
      id: string;
      action: 'open' | 'deplete' | 'status' | 'move' | 'adjust' | 'delete';
      body?: unknown;
    }) =>
      action === 'delete'
        ? api<Item>(`/items/${id}`, { method: 'DELETE' })
        : api<Item>(`/items/${id}/${action}`, { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

// ------------------------------------------------------------------- users

export function useUsers(enabled: boolean) {
  return useQuery({
    queryKey: ['users', 'list'],
    queryFn: () => api<AppUser[]>('/users'),
    enabled,
  });
}

export function useCreateUser() {
  const invalidate = useInvalidator('users');
  return useMutation({
    mutationFn: (body: UserCreate) => api<AppUser>('/users', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useSetUserRole() {
  const invalidate = useInvalidator('users');
  return useMutation({
    mutationFn: ({ id, role }: { id: string; role: UserRole }) =>
      api<AppUser>(`/users/${id}/role`, { method: 'PATCH', body: { role } }),
    onSuccess: invalidate,
  });
}

/**
 * Ends every session on every computer, claimed ones included.
 *
 * No invalidation: the caller's own session is among the ones just deleted, so
 * the next thing that happens is a redirect to the sign-in screen, and any
 * refetch in between would only produce a pile of 401s.
 */
export function useRevokeAllSessions() {
  return useMutation({
    mutationFn: () =>
      api<{ ok: boolean; sessions: number }>('/users/sessions/revoke-all', { method: 'POST' }),
  });
}

export function useChangeOwnPassword() {
  return useMutation({
    mutationFn: (body: { currentPassword: string; newPassword: string }) =>
      api<{ ok: boolean }>('/users/me/password', { method: 'POST', body }),
  });
}

export function useResetUserPassword() {
  return useMutation({
    mutationFn: ({ id, newPassword }: { id: string; newPassword: string }) =>
      api<{ ok: boolean }>(`/users/${id}/password`, { method: 'POST', body: { newPassword } }),
  });
}

// ------------------------------------------------- fast login

export function useMyFastKey() {
  return useQuery({
    queryKey: ['users', 'me', 'fast-key'],
    queryFn: () => api<FastKey>('/users/me/fast-key'),
    staleTime: Infinity, // it only changes when this screen changes it
  });
}

export function useGenerateFastKey() {
  const invalidate = useInvalidator('users');
  return useMutation({
    mutationFn: () => api<FastKey>('/users/me/fast-key', { method: 'POST' }),
    onSuccess: invalidate,
  });
}

export function useDropFastKey() {
  const invalidate = useInvalidator('users');
  return useMutation({
    mutationFn: () => api<FastKey>('/users/me/fast-key', { method: 'DELETE' }),
    onSuccess: invalidate,
  });
}

export function useRevokeFastKey() {
  const invalidate = useInvalidator('users');
  return useMutation({
    mutationFn: (id: string) => api<{ ok: boolean }>(`/users/${id}/fast-key`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
}

// ------------------------------------------------------------------- trash

export function useTrash(enabled: boolean) {
  return useQuery({
    queryKey: ['trash', 'list'],
    queryFn: () => api<TrashRow[]>('/trash'),
    enabled,
  });
}

export function useTrashCount(enabled: boolean) {
  return useQuery({
    queryKey: ['trash', 'count'],
    queryFn: () => api<{ total: number }>('/trash/count'),
    enabled,
  });
}

// A restore or a purge can touch anything in the bin, so both refresh the lot.
const TRASH_KEYS = [
  'trash', 'concepts', 'analogous', 'variants', 'items', 'locations', 'types',
  'requests', 'lots', 'suppliers', 'actions', 'pools',
] as const;

export function useRestore() {
  const invalidate = useInvalidator(...TRASH_KEYS);
  return useMutation({
    mutationFn: ({ entityType, id }: { entityType: TrashEntity; id: string }) =>
      api<{ ok: boolean; humanId: string }>(`/trash/${entityType}/${id}/restore`, {
        method: 'POST',
      }),
    onSuccess: invalidate,
  });
}

/** Gone for good. Only reachable from the bin, and only for managers up. */
export function usePurge() {
  const invalidate = useInvalidator(...TRASH_KEYS);
  return useMutation({
    mutationFn: ({ entityType, id }: { entityType: TrashEntity; id: string }) =>
      api<{ ok: boolean; humanId: string }>(`/trash/${entityType}/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
}

// ---------------------------------------------------------------- CSV

export function useImportItems() {
  const invalidate = useInvalidateItems();
  return useMutation({
    mutationFn: (body: { csv: string; dryRun: boolean }) =>
      api<CsvImportResult>('/import/items', { method: 'POST', body }),
    onSuccess: (_data, variables) => {
      if (!variables.dryRun) invalidate();
    },
  });
}
