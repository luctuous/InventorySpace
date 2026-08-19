import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type {
  AuditAction,
  AuditEntity,
  HistoryEntry,
  PaginationMeta,
  TranslatedText,
} from '@inventory/shared';
import { api } from './client';

export interface HistoryParams {
  page?: number;
  perPage?: number;
  entityType?: AuditEntity;
  entityId?: string;
  action?: AuditAction;
  userId?: string;
  q?: string;
}

// The API joins the user name and the entity's own name onto each row, so a
// row reads as a sentence instead of as a pair of identifiers.
export type HistoryRow = HistoryEntry & {
  userName: string | null;
  entityName: TranslatedText | null;
};

export function useHistory(params: HistoryParams) {
  return useQuery({
    queryKey: ['history', 'list', params],
    queryFn: () =>
      api<{ data: HistoryRow[]; meta: PaginationMeta }>('/history', {
        query: {
          page: params.page ?? 1,
          perPage: params.perPage,
          entityType: params.entityType,
          entityId: params.entityId,
          action: params.action,
          userId: params.userId,
          q: params.q || undefined,
        },
      }),
    placeholderData: keepPreviousData,
  });
}
