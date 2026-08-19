import { formatMoney } from '@inventory/shared';

export function formatDateTime(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso),
  );
}

export function formatDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso));
}

export function formatQty(qty: number | null, unit: string | null): string {
  if (qty === null) return '—';
  const rounded = Math.round(qty * 1000) / 1000; // display only
  return unit ? `${rounded} ${unit}` : String(rounded);
}

export function formatPrice(
  amountMinor: number | null,
  currency: string | null,
  locale: string,
): string {
  if (amountMinor === null) return '—';
  return formatMoney(amountMinor, currency ?? 'EUR', locale);
}

/** Days until an ISO date; negative = past. */
export function daysUntil(isoDate: string): number {
  return Math.ceil((new Date(isoDate).getTime() - Date.now()) / 86_400_000);
}
