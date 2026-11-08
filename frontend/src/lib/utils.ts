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
  // Null-tolerant: customers.phone is nullable (Riverbend import + the #352 backfill
  // NULLs junk values), and search dropdowns render it straight off the API.
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits[0] === '1') return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  return phone;
}

/**
 * Live-format a US phone as the user types → "(555) 123-4567". Re-derived from
 * the raw digits on every keystroke (so backspace/edits work naturally) and
 * capped at 10 digits. Shared by every masked customer-phone input (#352).
 */
export function formatPhoneInput(raw: string): string {
  const d = raw.replace(/\D/g, '').slice(0, 10);
  if (d.length === 0) return '';
  if (d.length < 4) return `(${d}`;
  if (d.length < 7) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

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
      .map((d) => (d.field ? `${d.field}: ${d.message ?? ''}`.trim() : d.message))
      .filter(Boolean)
      .join('; ');
    if (msg) return msg;
  }
  if (data?.error) return data.error;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

/**
 * For call logs with technical failure, extracts ONLY the message from the response body
 * (e.g. from {"message": ["..."], "error": "Bad Request", "statusCode": 400}).
 */
export function extractFailureMessage(rawSummary?: string | null): string {
  if (!rawSummary || typeof rawSummary !== 'string') return '';
  const text = rawSummary.trim();
  if (!text) return '';

  // 1. Try to find a JSON object in the text: {...}
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const jsonCandidate = text.substring(firstBrace, lastBrace + 1);
    try {
      const parsed = JSON.parse(jsonCandidate);
      // Case A: parsed.message
      if (Array.isArray(parsed?.message)) {
        const msg = parsed.message
          .filter(Boolean)
          .map((m: any) => String(m).trim())
          .join(' ');
        if (msg) return msg;
      } else if (typeof parsed?.message === 'string' && parsed.message.trim()) {
        return parsed.message.trim();
      } else if (parsed?.message && typeof parsed.message === 'object') {
        const subMsg = parsed.message.message || parsed.message.error || parsed.message.detail;
        if (typeof subMsg === 'string' && subMsg.trim()) return subMsg.trim();
      }

      // Case B: parsed.error
      if (typeof parsed?.error === 'string' && parsed.error.trim() && parsed.error.toLowerCase() !== 'bad request') {
        return parsed.error.trim();
      } else if (parsed?.error && typeof parsed.error === 'object') {
        const errMsg = parsed.error.message || parsed.error.detail || parsed.error.description;
        if (typeof errMsg === 'string' && errMsg.trim()) return errMsg.trim();
      }

      // Case C: other common API response fields
      const fallbackField = parsed?.error_description || parsed?.detail || parsed?.description || parsed?.reason;
      if (typeof fallbackField === 'string' && fallbackField.trim()) {
        return fallbackField.trim();
      }
    } catch {
      // not valid JSON, continue with string patterns below
    }
  }

  // 2. Pattern: "Vapi (Call Failed|rejected call)[^:]*:\s*(.+)$"
  const vapiPrefixMatch = text.match(/Vapi (?:Call Failed|rejected call)[^:]*:\s*(.+)$/i);
  if (vapiPrefixMatch && vapiPrefixMatch[1]) {
    const candidate = vapiPrefixMatch[1].trim();
    const subCleaned = extractFailureMessage(candidate);
    if (subCleaned) return subCleaned;
    return candidate;
  }

  // 3. Pattern: "Call for ... failed:\s*(.+)$" or "Call failed:\s*(.+)$"
  const callFailedMatch = text.match(/(?:Call (?:for [^:]+ )?failed|Failed):\s*(.+)$/i);
  if (callFailedMatch && callFailedMatch[1]) {
    const candidate = callFailedMatch[1].trim();
    const subCleaned = extractFailureMessage(candidate);
    if (subCleaned) return subCleaned;
    return candidate;
  }

  return text;
}

/** Formats snake_case, CONSTANT_CASE or raw identifiers into clean, human-readable Title Case (e.g. "New_York" -> "New York", "one_time" -> "One-time"). */
export function formatSnakeCase(val: string | null | undefined): string {
  if (!val) return '';
  const s = String(val).trim();
  if (!s) return '';
  if (s.toLowerCase() === 'one_time' || s.toLowerCase() === 'one-time') return 'One-time';
  if (s.toLowerCase() === 'voice_opt_out') return 'Voice Opt-out';
  return s
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b[a-z]/g, (char) => char.toUpperCase());
}


