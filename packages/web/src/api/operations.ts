import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Action,
  ActionCreate,
  ActionRecord,
  ActionRecordCreate,
  ActionRecordResult,
  ActionUpdate,
  ActionWithCost,
  ConsumptionRate,
  ExistingRequest,
  ForecastResponse,
  IngestResult,
  ItemLink,
  ItemLinkCreate,
  ItemLinksResponse,
  LogEventCreate,
  LogEventDef,
  LogEventUpdate,
  LogEventVersion,
  LogHealth,
  LogLine,
  LogLineStatus,
  LogSource,
  LogSourceCreate,
  LogSourceUpdate,
  Lot,
  LotCreate,
  LotLineCreate,
  LotLineUpdate,
  LotWithLines,
  MaintenanceDone,
  MaintenancePlan,
  MaintenancePlanCreate,
  MaintenancePlanUpdate,
  MaintenancePlanWithStatus,
  MaintenanceRecord,
  Occupancy,
  OccupancyCreate,
  PaginationMeta,
  ParserProbeResult,
  Pool,
  PoolCommission,
  PoolCommissionResult,
  PoolCreate,
  PoolEvent,
  PoolEventCreate,
  PoolStock,
  PoolUnit,
  PoolUnitCreate,
  PoolUnitStateChange,
  PoolWithStats,
  PriceHistoryPoint,
  Reconciliation,
  Recount,
  RecountCreate,
  Request as LabRequest,
  RequestAllResult,
  RequestCreate,
  RequestUpdate,
  RequestWithRefs,
  Supplier,
  SupplierCreate,
  SupplierStats,
  TranslatedText,
  UnassignedSummary,
  UnknownEvent,
} from '@inventory/shared';
import { api } from './client';

// Hooks for everything. Same conventions as entities.ts:
// ['entity', 'list', filters] keys, and every mutation invalidates history too.

type Paged<T> = { data: T[]; meta: PaginationMeta };

function useInvalidator(...keys: string[]) {
  const queryClient = useQueryClient();
  return () => {
    for (const key of [...keys, 'history']) {
      void queryClient.invalidateQueries({ queryKey: [key] });
    }
  };
}

// ---------------------------------------------------------------- requests

export interface RequestListParams {
  page?: number;
  perPage?: number;
  status?: string[];
  conceptId?: string;
  mine?: boolean;
}

export function useRequests(params: RequestListParams = {}) {
  return useQuery({
    queryKey: ['requests', 'list', params],
    queryFn: () =>
      api<Paged<RequestWithRefs>>('/requests', {
        query: {
          page: params.page ?? 1,
          perPage: params.perPage,
          status: params.status?.length ? params.status.join(',') : undefined,
          conceptId: params.conceptId,
          mine: params.mine ? 'true' : undefined,
        },
      }),
    placeholderData: keepPreviousData,
  });
}

/** Answered before writing a new request, so a duplicate becomes a +1. */
export function useOpenRequestFor(conceptId: string | null) {
  return useQuery({
    queryKey: ['requests', 'open-for', conceptId],
    queryFn: () => api<ExistingRequest>(`/requests/open/${conceptId}`),
    enabled: conceptId !== null,
  });
}

export function useCreateRequest() {
  const invalidate = useInvalidator('requests', 'forecast');
  return useMutation({
    mutationFn: (body: RequestCreate) =>
      api<LabRequest>('/requests', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useSupportRequest() {
  const invalidate = useInvalidator('requests');
  return useMutation({
    mutationFn: (id: string) =>
      api<{ ok: boolean; supporters: number }>(`/requests/${id}/support`, { method: 'POST' }),
    onSuccess: invalidate,
  });
}

export function useUpdateRequest() {
  const invalidate = useInvalidator('requests');
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: RequestUpdate }) =>
      api<LabRequest>(`/requests/${id}`, { method: 'PATCH', body }),
    onSuccess: invalidate,
  });
}

export function useCancelRequest() {
  const invalidate = useInvalidator('requests', 'forecast');
  return useMutation({
    mutationFn: (id: string) => api<LabRequest>(`/requests/${id}/cancel`, { method: 'POST' }),
    onSuccess: invalidate,
  });
}

// -------------------------------------------------------------------- lots

export function useLots(params: { page?: number; status?: string[] } = {}) {
  return useQuery({
    queryKey: ['lots', 'list', params],
    queryFn: () =>
      api<Paged<LotWithLines>>('/lots', {
        query: {
          page: params.page ?? 1,
          status: params.status?.length ? params.status.join(',') : undefined,
        },
      }),
    placeholderData: keepPreviousData,
  });
}

export function useLot(id: string | null) {
  return useQuery({
    queryKey: ['lots', 'detail', id],
    queryFn: () => api<LotWithLines>(`/lots/${id}`),
    enabled: id !== null,
  });
}

/** "What we bought last time", in one click — most reorders are repeats. */
export interface VariantSuggestion {
  variantId: string;
  humanId: string;
  name: TranslatedText;
  packSize: number | null;
  packUnit: string | null;
  supplier: string | null;
  lastPriceAmount: number | null;
  lastPriceCurrency: string | null;
  lastPurchasedAt: string | null;
  timesPurchased: number;
}

export function useVariantSuggestions(conceptId: string | null) {
  return useQuery({
    queryKey: ['lots', 'suggest', conceptId],
    queryFn: () => api<VariantSuggestion[]>(`/lots/suggest/${conceptId}`),
    enabled: conceptId !== null,
  });
}

function useInvalidateLots() {
  return useInvalidator('lots', 'requests', 'items', 'concepts', 'forecast', 'variants');
}

export function useCreateLot() {
  const invalidate = useInvalidateLots();
  return useMutation({
    mutationFn: (body: LotCreate) => api<Lot>('/lots', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useAddLotLine() {
  const invalidate = useInvalidateLots();
  return useMutation({
    mutationFn: ({ lotId, body }: { lotId: string; body: LotLineCreate }) =>
      api<LotWithLines>(`/lots/${lotId}/lines`, { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useUpdateLotLine() {
  const invalidate = useInvalidateLots();
  return useMutation({
    mutationFn: ({ lotId, lineId, body }: { lotId: string; lineId: string; body: LotLineUpdate }) =>
      api<LotWithLines>(`/lots/${lotId}/lines/${lineId}`, { method: 'PATCH', body }),
    onSuccess: invalidate,
  });
}

export function useDeleteLotLine() {
  const invalidate = useInvalidateLots();
  return useMutation({
    mutationFn: ({ lotId, lineId }: { lotId: string; lineId: string }) =>
      api<LotWithLines>(`/lots/${lotId}/lines/${lineId}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
}

/** The reference is asked for here, because only now does it exist. */
export function useOrderLot() {
  const invalidate = useInvalidateLots();
  return useMutation({
    mutationFn: ({ lotId, reference }: { lotId: string; reference?: string | null }) =>
      api<LotWithLines>(`/lots/${lotId}/order`, {
        method: 'POST',
        body: { reference: reference ?? null },
      }),
    onSuccess: invalidate,
  });
}

export interface ReceiveLineInput {
  lineId: string;
  quantity: number;
  receivedVariantId?: string;
  newVariantName?: string;
  locationId?: string;
  expiryDate?: string;
  batchNumber?: string;
  closeRemainder: boolean;
}

export interface ReceiveResultView {
  itemsCreated: number;
  itemIds: string[];
  lotStatus: string;
  discrepancies: { lineId: string; kind: string; detail: string }[];
}

export function useReceiveLot() {
  const invalidate = useInvalidateLots();
  return useMutation({
    mutationFn: ({ lotId, lines }: { lotId: string; lines: ReceiveLineInput[] }) =>
      api<ReceiveResultView>(`/lots/${lotId}/receive`, { method: 'POST', body: { lines } }),
    onSuccess: invalidate,
  });
}

export function useDeleteLot() {
  const invalidate = useInvalidateLots();
  return useMutation({
    mutationFn: (lotId: string) => api<Lot>(`/lots/${lotId}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
}

export function usePriceHistory(variantId: string | null) {
  return useQuery({
    queryKey: ['lots', 'price-history', variantId],
    queryFn: () => api<PriceHistoryPoint[]>(`/variants/${variantId}/price-history`),
    enabled: variantId !== null,
  });
}

export function useSupplierStats() {
  return useQuery({
    queryKey: ['lots', 'supplier-stats'],
    queryFn: () => api<SupplierStats[]>('/suppliers/stats'),
  });
}

/** Every supplier, most used first — the autocomplete behind every lot. */
export function useSuppliers() {
  return useQuery({
    queryKey: ['suppliers', 'list'],
    queryFn: () => api<Supplier[]>('/suppliers'),
  });
}

export function useCreateSupplier() {
  const invalidate = useInvalidator('suppliers', 'lots');
  return useMutation({
    mutationFn: (body: SupplierCreate) => api<Supplier>('/suppliers', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useDeleteSupplier() {
  const invalidate = useInvalidator('suppliers', 'lots');
  return useMutation({
    mutationFn: (id: string) => api<Supplier>(`/suppliers/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
}

// ---------------------------------------------------------------- forecast

export function useForecast(reorderOnly: boolean) {
  return useQuery({
    queryKey: ['forecast', 'list', reorderOnly],
    queryFn: () =>
      api<ForecastResponse>('/forecast', {
        query: reorderOnly ? { reorderOnly: 'true' } : undefined,
      }),
  });
}

export function useConsumptionRates() {
  return useQuery({
    queryKey: ['forecast', 'rates'],
    queryFn: () => api<ConsumptionRate[]>('/consumption-rates'),
  });
}

export function useRequestAll() {
  const invalidate = useInvalidator('forecast', 'requests');
  return useMutation({
    mutationFn: (conceptIds: string[]) =>
      api<RequestAllResult>('/forecast/request-all', { method: 'POST', body: { conceptIds } }),
    onSuccess: invalidate,
  });
}

// ----------------------------------------------------------------- actions

export function useActions() {
  return useQuery({
    queryKey: ['actions', 'list'],
    queryFn: () => api<ActionWithCost[]>('/actions'),
  });
}

export function useCreateAction() {
  const invalidate = useInvalidator('actions');
  return useMutation({
    mutationFn: (body: ActionCreate) => api<Action>('/actions', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useUpdateAction() {
  const invalidate = useInvalidator('actions');
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ActionUpdate }) =>
      api<Action>(`/actions/${id}`, { method: 'PATCH', body }),
    onSuccess: invalidate,
  });
}

export function useDeleteAction() {
  const invalidate = useInvalidator('actions');
  return useMutation({
    mutationFn: (id: string) => api<Action>(`/actions/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
}

export interface ActionVersion {
  validFrom: string;
  validTo: string | null;
  lines: { conceptId: string; conceptName: TranslatedText; quantity: number }[];
}

export function useActionVersions(actionId: string | null) {
  return useQuery({
    queryKey: ['actions', 'versions', actionId],
    queryFn: () => api<ActionVersion[]>(`/actions/${actionId}/versions`),
    enabled: actionId !== null,
  });
}

export function useRecordAction() {
  // Charges an estimate to open containers — items must refresh, stock must not
  // change. Both are true; invalidating items simply re-reads the estimate.
  const invalidate = useInvalidator('actions', 'items');
  return useMutation({
    mutationFn: (body: ActionRecordCreate) =>
      api<ActionRecordResult>('/action-records', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useActionRecords(actionId?: string) {
  return useQuery({
    queryKey: ['actions', 'records', actionId ?? null],
    queryFn: () => api<ActionRecord[]>('/action-records', { query: { actionId } }),
  });
}

export function useReconciliations(conceptId?: string) {
  return useQuery({
    queryKey: ['actions', 'reconciliations', conceptId ?? null],
    queryFn: () => api<Reconciliation[]>('/reconciliations', { query: { conceptId } }),
  });
}

export function useUnassignedSummary() {
  return useQuery({
    queryKey: ['actions', 'unassigned'],
    queryFn: () => api<UnassignedSummary[]>('/unassigned-summary'),
  });
}

// ------------------------------------------------------------------- pools

export function usePools() {
  return useQuery({
    queryKey: ['pools', 'list'],
    queryFn: () => api<PoolWithStats[]>('/pools'),
  });
}

export function useCreatePool() {
  const invalidate = useInvalidator('pools');
  return useMutation({
    mutationFn: (body: PoolCreate) => api<Pool>('/pools', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useDeletePool() {
  const invalidate = useInvalidator('pools');
  return useMutation({
    mutationFn: (id: string) => api<Pool>(`/pools/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
}

export function usePoolEvent() {
  const invalidate = useInvalidator('pools');
  return useMutation({
    mutationFn: ({ poolId, body }: { poolId: string; body: PoolEventCreate }) =>
      api<PoolWithStats>(`/pools/${poolId}/events`, { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

/** What is in the cupboard: unopened stock this pool can be topped up from. */
export function usePoolStock(poolId: string | null) {
  return useQuery({
    queryKey: ['pools', 'stock', poolId],
    queryFn: () => api<PoolStock>(`/pools/${poolId}/stock`),
    enabled: poolId !== null,
  });
}

/** Cupboard → rotation. Takes it out of stock and puts it into the pool. */
export function useCommissionPool() {
  const invalidate = useInvalidator('pools', 'items', 'concepts', 'forecast');
  return useMutation({
    mutationFn: ({ poolId, body }: { poolId: string; body: PoolCommission }) =>
      api<PoolCommissionResult>(`/pools/${poolId}/commission`, { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function usePoolEvents(poolId: string | null) {
  return useQuery({
    queryKey: ['pools', 'events', poolId],
    queryFn: () => api<PoolEvent[]>(`/pools/${poolId}/events`),
    enabled: poolId !== null,
  });
}

export function useRecount() {
  const invalidate = useInvalidator('pools');
  return useMutation({
    mutationFn: ({ poolId, body }: { poolId: string; body: RecountCreate }) =>
      api<Recount>(`/pools/${poolId}/recount`, { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function usePoolUnits(poolId: string | null) {
  return useQuery({
    queryKey: ['pools', 'units', poolId],
    queryFn: () => api<PoolUnit[]>(`/pools/${poolId}/units`),
    enabled: poolId !== null,
  });
}

export function useAddPoolUnit() {
  const invalidate = useInvalidator('pools');
  return useMutation({
    mutationFn: ({ poolId, body }: { poolId: string; body: PoolUnitCreate }) =>
      api<PoolUnit>(`/pools/${poolId}/units`, { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useSetUnitState() {
  const invalidate = useInvalidator('pools');
  return useMutation({
    mutationFn: ({
      poolId,
      unitId,
      body,
    }: {
      poolId: string;
      unitId: string;
      body: PoolUnitStateChange;
    }) => api<PoolUnit>(`/pools/${poolId}/units/${unitId}`, { method: 'PATCH', body }),
    onSuccess: invalidate,
  });
}

export function useOccupancies(params: { unitId?: string; sampleTag?: string; open?: boolean }) {
  return useQuery({
    queryKey: ['pools', 'occupancies', params],
    queryFn: () =>
      api<Occupancy[]>('/occupancies', {
        query: {
          unitId: params.unitId,
          sampleTag: params.sampleTag || undefined,
          open: params.open ? 'true' : undefined,
        },
      }),
  });
}

export function useOpenOccupancy() {
  const invalidate = useInvalidator('pools');
  return useMutation({
    mutationFn: (body: OccupancyCreate) =>
      api<Occupancy>('/occupancies', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useCloseOccupancy() {
  const invalidate = useInvalidator('pools');
  return useMutation({
    mutationFn: (id: string) =>
      api<Occupancy>(`/occupancies/${id}/close`, { method: 'POST' }),
    onSuccess: invalidate,
  });
}

// -------------------------------------------------------------- log bridge

export function useLogSources(enabled: boolean) {
  return useQuery({
    queryKey: ['log', 'sources'],
    queryFn: () => api<LogSource[]>('/log/sources'),
    enabled,
  });
}

export function useProbeParser() {
  return useMutation({
    mutationFn: (body: { sample: string; assignments: string[]; content?: string }) =>
      api<ParserProbeResult>('/log/probe', { method: 'POST', body }),
  });
}

export function useCreateLogSource() {
  const invalidate = useInvalidator('log');
  return useMutation({
    mutationFn: (body: LogSourceCreate) =>
      api<LogSource>('/log/sources', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useUpdateLogSource() {
  const invalidate = useInvalidator('log');
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: LogSourceUpdate }) =>
      api<LogSource>(`/log/sources/${id}`, { method: 'PATCH', body }),
    onSuccess: invalidate,
  });
}

export function useDeleteLogSource() {
  const invalidate = useInvalidator('log');
  return useMutation({
    mutationFn: (id: string) => api<LogSource>(`/log/sources/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
}

export function useIngest() {
  // An ingest can touch pools, items and actions — refresh everything it can
  // reach, exactly as a human doing the same actions by hand would.
  const invalidate = useInvalidator('log', 'pools', 'items', 'actions', 'concepts');
  return useMutation({
    mutationFn: ({
      id,
      content,
      fromStart,
    }: {
      id: string;
      content?: string;
      fromStart?: boolean;
    }) =>
      api<IngestResult>(`/log/sources/${id}/ingest`, {
        method: 'POST',
        body: { content, fromStart: fromStart ?? false },
      }),
    onSuccess: invalidate,
  });
}

export function useLogLines(status: LogLineStatus | '', enabled: boolean) {
  return useQuery({
    queryKey: ['log', 'lines', status],
    queryFn: () => api<LogLine[]>('/log/lines', { query: { status: status || undefined } }),
    enabled,
  });
}

export function useUnknownEvents(enabled: boolean) {
  return useQuery({
    queryKey: ['log', 'unknown'],
    queryFn: () => api<UnknownEvent[]>('/log/unknown-events'),
    enabled,
  });
}

export function useLogHealth() {
  return useQuery({
    queryKey: ['log', 'health'],
    queryFn: () => api<LogHealth[]>('/log/health'),
    refetchInterval: 60_000, // silence is the failure mode that does not shout
  });
}

export function useLogEvents() {
  return useQuery({
    queryKey: ['log', 'events'],
    queryFn: () => api<LogEventDef[]>('/log/events'),
  });
}

export function useCreateLogEvent() {
  const invalidate = useInvalidator('log');
  return useMutation({
    mutationFn: (body: LogEventCreate) =>
      api<LogEventDef>('/log/events', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useUpdateLogEvent() {
  const invalidate = useInvalidator('log');
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: LogEventUpdate }) =>
      api<LogEventDef>(`/log/events/${id}`, { method: 'PATCH', body }),
    onSuccess: invalidate,
  });
}

export function useDeleteLogEvent() {
  const invalidate = useInvalidator('log');
  return useMutation({
    mutationFn: (id: string) => api<LogEventDef>(`/log/events/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
}

export function useLogEventVersions(eventId: string | null) {
  return useQuery({
    queryKey: ['log', 'event-versions', eventId],
    queryFn: () => api<LogEventVersion[]>(`/log/events/${eventId}/versions`),
    enabled: eventId !== null,
  });
}

// --------------------------------------------------------------- equipment

/** What hangs off this item, and what it hangs off. One request, both halves. */
export function useItemLinks(itemId: string | null) {
  return useQuery({
    queryKey: ['equipment', 'links', itemId],
    queryFn: () => api<ItemLinksResponse>(`/items/${itemId}/links`),
    enabled: itemId !== null,
  });
}

export function useCreateItemLink() {
  const invalidate = useInvalidator('equipment');
  return useMutation({
    mutationFn: ({ itemId, body }: { itemId: string; body: ItemLinkCreate }) =>
      api<ItemLink>(`/items/${itemId}/links`, { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useDeleteItemLink() {
  const invalidate = useInvalidator('equipment');
  return useMutation({
    mutationFn: (linkId: string) => api<ItemLink>(`/links/${linkId}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
}

export function useMaintenancePlans(itemId: string | null) {
  return useQuery({
    queryKey: ['equipment', 'plans', itemId],
    queryFn: () => api<MaintenancePlanWithStatus[]>(`/items/${itemId}/maintenance`),
    enabled: itemId !== null,
  });
}

export function useCreateMaintenancePlan() {
  const invalidate = useInvalidator('equipment');
  return useMutation({
    mutationFn: ({ itemId, body }: { itemId: string; body: MaintenancePlanCreate }) =>
      api<MaintenancePlanWithStatus>(`/items/${itemId}/maintenance`, { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useUpdateMaintenancePlan() {
  const invalidate = useInvalidator('equipment');
  return useMutation({
    mutationFn: ({ planId, body }: { planId: string; body: MaintenancePlanUpdate }) =>
      api<MaintenancePlanWithStatus>(`/maintenance/${planId}`, { method: 'PATCH', body }),
    onSuccess: invalidate,
  });
}

export function useDeleteMaintenancePlan() {
  const invalidate = useInvalidator('equipment');
  return useMutation({
    mutationFn: (planId: string) =>
      api<MaintenancePlan>(`/maintenance/${planId}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
}

/** "Done today" — resets both counters and writes a line into the record. */
export function useMaintenanceDone() {
  const invalidate = useInvalidator('equipment');
  return useMutation({
    mutationFn: ({ planId, body }: { planId: string; body: MaintenanceDone }) =>
      api<MaintenancePlanWithStatus>(`/maintenance/${planId}/done`, { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useMaintenanceRecords(planId: string | null) {
  return useQuery({
    queryKey: ['equipment', 'records', planId],
    queryFn: () => api<MaintenanceRecord[]>(`/maintenance/${planId}/records`),
    enabled: planId !== null,
  });
}

/** Count runs against every plan on this item that measures uses. */
export function useCountUses() {
  const invalidate = useInvalidator('equipment');
  return useMutation({
    mutationFn: ({ itemId, uses }: { itemId: string; uses: number }) =>
      api<MaintenancePlanWithStatus[]>(`/items/${itemId}/uses`, {
        method: 'POST',
        body: { uses },
      }),
    onSuccess: invalidate,
  });
}

/** Overdue first, then what falls due soon — the Home card. */
export function useDueMaintenance() {
  return useQuery({
    queryKey: ['equipment', 'due'],
    queryFn: () => api<MaintenancePlanWithStatus[]>('/maintenance/due'),
  });
}
