// Parsing/formatting for the typeable DatePicker/TimeCombobox controls (components/form).
// Native <input type="date"/"datetime-local"> renders in the BROWSER's locale (often
// DD/MM/YYYY), ignoring the org's own date_format preference entirely - that mismatch is
// what these controls replace. Display + parsing both honor the org's configured pattern,
// defaulting to US MM/DD/YYYY when unset (org-format.ts's own CompanyProfilePage default).

import { format } from 'date-fns';
import { getOrgDateFormat } from './org-format';

export type DateInputPattern = 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD';

/** The active numeric date pattern for editable inputs. Unlike the format-date renderers'
 *  long-form fallback (a read-only display concern), an editable field always gets
 *  a numeric pattern - MM/DD/YYYY unless the org opted into a different one. */
export function getDateInputPattern(): DateInputPattern {
  const pattern = getOrgDateFormat();
  return pattern === 'DD/MM/YYYY' || pattern === 'YYYY-MM-DD' ? pattern : 'MM/DD/YYYY';
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 'YYYY-MM-DD' -> pattern-formatted display text, e.g. '08/15/2026'. '' -> ''. */
export function formatDateForInput(isoDay: string, pattern: DateInputPattern = getDateInputPattern()): string {
  if (!isoDay) return '';
  const [y, m, d] = isoDay.split('-');
  if (!y || !m || !d) return '';
  switch (pattern) {
    case 'DD/MM/YYYY':
      return `${d}/${m}/${y}`;
    case 'YYYY-MM-DD':
      return `${y}-${m}-${d}`;
    default:
      return `${m}/${d}/${y}`;
  }
}

function normalizeYear(raw: string): number {
  const n = Number(raw);
  if (raw.length >= 4) return n;
  return n < 70 ? 2000 + n : 1900 + n;
}

function toISOIfValid(year: number, month: number, day: number): string | null {
  if (!year || !month || !day) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day);
  // Catches overflow (e.g. Feb 30 rolling into March) that the range checks above miss.
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/**
 * Lenient parse of typed text -> 'YYYY-MM-DD', or null if unparseable/invalid.
 * Accepts 1-2 digit day/month, 2 or 4 digit year, '/', '-', or '.' separators, and a
 * literal ISO 'YYYY-MM-DD' regardless of pattern (always available as an escape hatch).
 */
export function parseDateInputText(raw: string, pattern: DateInputPattern = getDateInputPattern()): string | null {
  const text = raw.trim();
  if (!text) return null;

  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return toISOIfValid(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const m = text.match(/^(\d{1,4})[/\-.](\d{1,2})[/\-.](\d{1,4})$/);
  if (!m) return null;
  const [, p1, p2, p3] = m;

  let year: number, month: number, day: number;
  if (pattern === 'YYYY-MM-DD') {
    year = Number(p1);
    month = Number(p2);
    day = Number(p3);
  } else if (pattern === 'DD/MM/YYYY') {
    day = Number(p1);
    month = Number(p2);
    year = normalizeYear(p3 ?? '');
  } else {
    month = Number(p1);
    day = Number(p2);
    year = normalizeYear(p3 ?? '');
  }
  return toISOIfValid(year, month, day);
}

/** Local calendar-day Date (midnight local) for a 'YYYY-MM-DD' string - avoids the UTC
 *  shift `new Date('YYYY-MM-DD')` applies, which can land on the wrong day near midnight. */
export function isoDayToLocalDate(isoDay: string): Date | undefined {
  if (!isoDay) return undefined;
  const [y, m, d] = isoDay.split('-').map(Number);
  if (!y || !m || !d) return undefined;
  return new Date(y, m - 1, d);
}

/** Local Date -> 'YYYY-MM-DD', from local calendar parts (not toISOString, which shifts to UTC). */
export function localDateToIsoDay(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// ─── Time ────────────────────────────────────────────────────────────────────

/** 'HH:MM' (24h) -> '' | 'h:mm a' display, e.g. '3:00 PM'. */
export function formatTimeForInput(hhmm: string): string {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return '';
  return format(new Date(2000, 0, 1, h, m), 'h:mm a');
}

/**
 * Lenient parse of typed text -> 'HH:MM' (24h), or null. Accepts "3", "3p", "3pm",
 * "3:00", "3:00pm", "15:00", "1500", "300pm" - the shorthands people actually type.
 */
export function parseTimeInputText(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return null;

  let hh: number, mm: number, ampm: string | undefined;

  const colonMatch = s.match(/^(\d{1,2}):(\d{2})(am|pm|a|p)?$/);
  const shortMatch = !colonMatch && s.match(/^(\d{1,2})(am|pm|a|p)$/);
  const compactMatch = !colonMatch && !shortMatch && s.match(/^(\d{3,4})(am|pm|a|p)?$/);

  if (colonMatch) {
    hh = Number(colonMatch[1]);
    mm = Number(colonMatch[2]);
    ampm = colonMatch[3];
  } else if (shortMatch) {
    hh = Number(shortMatch[1]);
    mm = 0;
    ampm = shortMatch[2];
  } else if (compactMatch) {
    const digits = compactMatch[1] ?? '';
    hh = Number(digits.length === 3 ? digits.slice(0, 1) : digits.slice(0, 2));
    mm = Number(digits.slice(-2));
    ampm = compactMatch[2];
  } else {
    return null;
  }

  if (Number.isNaN(hh) || Number.isNaN(mm) || mm > 59) return null;
  if (ampm) {
    if (hh < 1 || hh > 12) return null;
    const isPM = ampm.startsWith('p');
    if (hh === 12) hh = isPM ? 12 : 0;
    else if (isPM) hh += 12;
  }
  if (hh > 23) return null;
  return `${pad2(hh)}:${pad2(mm)}`;
}

/** Alternate string forms a 15-min-grid option can be typed as, for prefix filtering. */
function timeCandidates(hh24: number, mm: number): string[] {
  const hh12 = hh24 % 12 === 0 ? 12 : hh24 % 12;
  const ampmLetter = hh24 < 12 ? 'a' : 'p';
  const mm2 = pad2(mm);
  const candidates = [
    `${hh24}${mm2}`,
    `${pad2(hh24)}${mm2}`,
    `${hh12}${mm2}${ampmLetter}`,
  ];
  if (mm === 0) candidates.push(`${hh12}${ampmLetter}`);
  return candidates;
}

/** Whether a 'HH:MM' option matches a typed query under any of its shorthand forms. */
export function timeOptionMatchesQuery(hh24: number, mm: number, query: string): boolean {
  const q = query.trim().toLowerCase().replace(/[\s:]/g, '');
  if (!q) return true;
  return timeCandidates(hh24, mm).some((c) => c.startsWith(q));
}
