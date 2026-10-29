import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { getOrgCurrency } from './org-format';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Triggers a browser download of an in-memory blob via a throwaway anchor. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function formatPhone(phone: string | null | undefined): string {
  // Null-tolerant: customers.phone is nullable (Talon import + the #352 backfill
  // NULLs junk values), and search dropdowns render it straight off the API.
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits[0] === '1') return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  return phone;
}

// The US typing mask lives with the phone field in the kit (mobile slice 36).
export { formatPhoneInput } from '@/ui-kit/lib/phoneField';

export function formatCurrency(amount: number | string): string {
  const num = typeof amount === 'string' ? parseFloat(amount) : amount;
  // Currency code comes from the hydrated org prefs (defaults to USD). Keep the
  // en-US locale for stable grouping/decimals; Intl derives the right symbol
  // from the currency code regardless of locale. (#126)
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: getOrgCurrency() }).format(
    num
  );
}

/** Whole-dollar currency (no trailing cents) for headline figures, org-aware. (#126) */
export function formatCurrencyWhole(amount: number | string): string {
  const num = typeof amount === 'string' ? parseFloat(amount) : amount;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: getOrgCurrency(),
    maximumFractionDigits: 0,
  }).format(num);
}

/**
 * Fraction → trimmed percent string (0.06875 -> "6.875", 0.04 -> "4"). tax_rate
 * carries 5 decimal places (R5c) so a plain toFixed(2) silently rounds off the
 * digit that R5c's precision widening exists to preserve.
 */
export function formatTaxRatePercent(fraction: number | string): string {
  const num = typeof fraction === 'string' ? parseFloat(fraction) : fraction;
  return (num * 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Name -> initials for avatar badges ("John Doe" -> "JD"). Single word takes its
 * first 2 chars; empty/whitespace-only input returns `fallback`. Callers with
 * separate first/last (or a first/last -> company_name cascade) join into one
 * string before calling - e.g. `getInitials(\`${first ?? ''} ${last ?? ''}\`.trim() || company)`.
 */
export function getInitials(name: string | null | undefined, fallback = '?'): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  const first = parts[0];
  if (!first) return fallback;
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? first;
  return (first[0]! + last[0]!).toUpperCase();
}

/**
 * `service_request` -> `Service request`, `lines.0.reviewComment` -> `Review comment`: the same
 * readable label the backend's Zod error map (`backend/src/lib/zod-error-map.ts`) puts in front of
 * a too-long message.
 */
function readableFieldLabel(field: string): string {
  const key = [...field.split('.')].reverse().find((p) => p && !/^\d+$/.test(p)) ?? '';
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function extractApiError(err: unknown, fallback: string): string {
  const data = (
    err as {
      response?: {
        data?: { error?: string; details?: Array<{ field?: string; message?: string }> };
      };
    }
  )?.response?.data;
  // Prefer per-field validation details (the API returns `details[]` on 400)
  // over the generic "Validation failed" so failures name the offending field.
  const details = data?.details;
  if (details?.length) {
    const msg = details
      .map((d) => {
        if (!d.field) return d.message;
        // A message that already opens with the field's readable label needs no `field:` prefix.
        const label = readableFieldLabel(d.field);
        if (label && d.message?.startsWith(`${label} `)) return d.message;
        return `${d.field}: ${d.message ?? ''}`.trim();
      })
      .filter(Boolean)
      .join('; ');
    if (msg) return msg;
  }
  if (data?.error) return data.error;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
