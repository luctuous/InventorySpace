import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Branding, BrandingUpdate, Concept, LocationWithCount } from '@inventory/shared';
import { api } from './client';

// The two unauthenticated reads (see api/routes/public.ts). They are ordinary
// queries — the fetch wrapper sends the session cookie when there is one and
// the endpoints do not care either way.

export function useBranding() {
  return useQuery({
    queryKey: ['branding'],
    queryFn: () => api<Branding>('/branding'),
    // Read on every page load by the sidebar and the sign-in screen, and only
    // ever changed from one dialog, which invalidates it itself.
    staleTime: 10 * 60_000,
  });
}

export function useSaveBranding() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: BrandingUpdate) => api<Branding>('/branding', { method: 'PUT', body }),
    onSuccess: (data) => queryClient.setQueryData(['branding'], data),
  });
}

/** Exactly what the signed-out Home shows — one request, no item-level data. */
export interface PublicHome {
  concepts: Array<
    Pick<Concept, 'id' | 'humanId' | 'name' | 'unit' | 'minStockThreshold'> & { stock: number }
  >;
  metrics: { activeItems: number; openItems: number };
  locations: LocationWithCount[];
}

export function usePublicHome(locationId: string | null) {
  return useQuery({
    queryKey: ['public-home', locationId],
    queryFn: () =>
      api<PublicHome>('/public/home', { query: { locationId: locationId ?? undefined } }),
  });
}
