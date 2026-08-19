import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Concept,
  ConceptCreate,
  ConceptUpdate,
  ConceptWithStock,
  PaginationMeta,
  TranslatedText,
} from '@inventory/shared';
import { api } from './client';

// Query keys follow the project convention:
//   [entity, 'list', filters] / [entity, 'detail', id]
// Mutations invalidate the entity's whole key so every list refetches.

export interface ConceptListParams {
  page?: number;
  search?: string;
  /** Pickers want every concept in one go, not a page of 25. */
  perPage?: number;
  /** Home only: leave out the concepts whose type is not stock. */
  stockOnly?: boolean;
}

export function useConcepts(params: ConceptListParams) {
  return useQuery({
    queryKey: ['concepts', 'list', params],
    queryFn: () =>
      api<{ data: ConceptWithStock[]; meta: PaginationMeta }>('/concepts', {
        query: {
          page: params.page ?? 1,
          perPage: params.perPage,
          search: params.search || undefined,
          stockOnly: params.stockOnly ? 'true' : undefined,
        },
      }),
    placeholderData: keepPreviousData, // old page stays visible while the next loads
  });
}

/** Every concept, dropdown-sized. See /concepts/options in the API. */
export interface ConceptOption {
  id: string;
  humanId: string;
  name: TranslatedText;
  unit: string;
}

export function useConceptOptions() {
  return useQuery({
    queryKey: ['concepts', 'options'],
    queryFn: () => api<ConceptOption[]>('/concepts/options'),
    // Read by three filter bars and the lot-line form; changes only when
    // somebody adds a concept, which invalidates the whole 'concepts' key.
    staleTime: 60_000,
  });
}

function useInvalidateConcepts() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['concepts'] });
    void queryClient.invalidateQueries({ queryKey: ['history'] });
  };
}

export function useCreateConcept() {
  const invalidate = useInvalidateConcepts();
  return useMutation({
    mutationFn: (body: ConceptCreate) =>
      api<Concept>('/concepts', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useUpdateConcept() {
  const invalidate = useInvalidateConcepts();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ConceptUpdate }) =>
      api<Concept>(`/concepts/${id}`, { method: 'PATCH', body }),
    onSuccess: invalidate,
  });
}

export function useDeleteConcept() {
  const queryClient = useQueryClient();
  return useMutation({
    // cascade also soft-deletes the analogous groups, variants and items below.
    mutationFn: ({ id, cascade }: { id: string; cascade?: boolean }) =>
      api<Concept>(`/concepts/${id}`, {
        method: 'DELETE',
        query: cascade ? { cascade: 'true' } : undefined,
      }),
    onSuccess: () => {
      for (const key of ['concepts', 'analogous', 'variants', 'items', 'history', 'trash']) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
  });
}
