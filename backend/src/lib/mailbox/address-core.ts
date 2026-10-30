/**
 * The mailbox address register's pure core (PRD 10, M11a): building and checking a candidate company
 * part or address from plain values. No database, no environment, no clock, so every rule here is
 * tested without either.
 *
 * Vocabulary: the "company part" is the org's frozen string in `first.last.company` and in the main
 * address (`company@<mailbox domain>`). A "local part" is anything before the `@`.
 */

import { createHmac } from 'node:crypto';

/** Local parts that are never issued to anyone, as a company part or as an address. `postmaster` and
 *  `abuse` are owed to the internet (RFC 2142), `bounce`/`bounces` is where return-path traffic belongs,
 *  and `no-reply`/`noreply` is the platform's own sender. */
export const RESERVED_LOCAL_PARTS: readonly string[] = [
  'postmaster',
  'abuse',
  'bounce',
  'bounces',
  'no-reply',
  'noreply',
];

/** Longest company part we will build or accept. Well inside RFC 5321's 64-octet local-part limit even
 *  with a `first.last.` in front of it, and short enough that the address still reads as a name. */
export const MAX_COMPANY_PART_LENGTH = 40;

/** The neutral word a generated company part is built on when the name gives nothing usable. */
const NEUTRAL_COMPANY_PART = 'company';

const reserved = new Set(RESERVED_LOCAL_PARTS);

/** RFC 5321's limit on the local part of an address, in octets; every character we issue is one octet. */
export const MAX_LOCAL_PART_LENGTH = 64;

export function isReservedLocalPart(localPart: string): boolean {
  return reserved.has(localPart.trim().toLowerCase());
}

/**
 * A company name as a company part: only `[a-z0-9]` survives, capped at 40. An allowlist, not a
 * blocklist: the name is user-controlled and lands in a From header, so a permissive rule that happened
 * to let a CR through would be an injected `Bcc:` on every send. Empty when nothing usable survives.
 */
export function slugCompanyPart(name: string | null | undefined): string {
  return (name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, MAX_COMPANY_PART_LENGTH);
}

/**
 * One name (a first or a last) as part of a user address: only `[a-z0-9]` survives. The allow-list runs on
 * the raw text and the lowercasing after it, so a letter that only lowercases into ASCII (the Kelvin sign,
 * a dotted capital I) is dropped rather than turned into one, and the same rule can be written in SQL
 * without depending on a database locale. Accents, emoji, non-Latin scripts, dots, spaces, CR/LF and angle
 * brackets all fall away; the name is user-controlled and lands in a From header. Empty when nothing
 * usable survives.
 */
export function slugNamePart(name: string | null | undefined): string {
  return (name ?? '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

/**
 * The name part of a user address, `first.last`: each name through the allow-list, a user with no usable
 * last name giving the first alone and one with no usable first name the last alone. Null for a user with
 * neither: that user gets no address. The part is capped so `<name part>.<company part>` stays inside 64
 * characters: when both names do not fit, a short name keeps all of itself and the other gives way, and
 * when both are long they share what is left (the first name taking the smaller half). Never ends on a dot.
 */
export function buildUserNamePart(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
  companyPart: string,
): string | null {
  const cap = MAX_LOCAL_PART_LENGTH - 1 - companyPart.length;
  if (cap < 1) return null;
  const first = slugNamePart(firstName);
  const last = slugNamePart(lastName);
  if (!first && !last) return null;
  if (!first || !last) return (first || last).slice(0, cap);
  const budget = cap - 1; // the dot between the names
  if (first.length + last.length <= budget) return `${first}.${last}`;
  if (budget < 2) return first.slice(0, cap);
  const keptFirst = Math.min(first.length, Math.max(Math.floor(budget / 2), budget - last.length));
  const keptLast = Math.min(last.length, budget - keptFirst);
  return `${first.slice(0, keptFirst)}.${last.slice(0, keptLast)}`;
}

/** The local part of a user address: the name part, a dot, the company's frozen part. */
export function buildUserLocalPart(namePart: string, companyPart: string): string {
  return `${namePart}.${companyPart}`;
}

/**
 * The name part of a user address, read back from its local part: everything before the last dot. A
 * company part never holds a dot, so the last dot always sits in front of it. Null for a local part with
 * no dot (a company's main address).
 */
export function namePartOfLocalPart(localPart: string): string | null {
  const dot = localPart.lastIndexOf('.');
  return dot > 0 ? localPart.slice(0, dot) : null;
}

export type UserNamePartCheck =
  | { ok: true; namePart: string }
  | { ok: false; reason: 'invalid' | 'reserved' };

/**
 * Whether `candidate`, typed by an admin, can be the name part of a user address within company part
 * `companyPart`. The same allow-list the register builds a name part from: lowercase letters and digits, with a
 * single dot allowed between words (`jane.smith`, `jsmith`); nothing else survives, so no space, separator or
 * header-breaking character reaches a From line. The whole local part (`<name part>.<company part>`) has to stay
 * inside the 64-character limit, and a reserved local part is refused. Whether the name part is still free is the
 * register's question, not this one's: this is pure.
 */
export function checkUserNamePart(candidate: string, companyPart: string): UserNamePartCheck {
  const namePart = candidate.trim().toLowerCase();
  if (!/^[a-z0-9]+(\.[a-z0-9]+)*$/.test(namePart)) return { ok: false, reason: 'invalid' };
  if (buildUserLocalPart(namePart, companyPart).length > MAX_LOCAL_PART_LENGTH) return { ok: false, reason: 'invalid' };
  if (isReservedLocalPart(namePart) || isReservedLocalPart(buildUserLocalPart(namePart, companyPart))) {
    return { ok: false, reason: 'reserved' };
  }
  return { ok: true, namePart };
}

export type CompanyPartCheck =
  | { ok: true; part: string }
  | { ok: false; reason: 'invalid' | 'reserved' | 'taken' };

/**
 * Whether `candidate` can be some company's part. `isTaken` answers for the whole register: every
 * company's part (chosen or derived), every address ever issued. Reserved is answered before taken so a
 * reserved part never reads as another company's.
 */
export function checkCompanyPart(
  candidate: string,
  isTaken: (part: string) => boolean,
): CompanyPartCheck {
  const part = candidate.trim().toLowerCase();
  if (!/^[a-z0-9]+$/.test(part) && !reserved.has(part)) return { ok: false, reason: 'invalid' };
  if (part.length > MAX_COMPANY_PART_LENGTH) return { ok: false, reason: 'invalid' };
  if (reserved.has(part)) return { ok: false, reason: 'reserved' };
  if (isTaken(part)) return { ok: false, reason: 'taken' };
  return { ok: true, part };
}

/**
 * The part a company gets when it wants `wanted`: `wanted` itself when it is free, else the first free
 * variant with a number added (`acme2`, `acme3`, ...). A wanted part that is empty or reserved gets a
 * generated neutral one (`company1`, `company2`, ...). Never returns a reserved part.
 */
export function nextFreeCompanyPart(wanted: string, isTaken: (part: string) => boolean): string {
  const base = wanted.trim().toLowerCase();
  const usable = /^[a-z0-9]+$/.test(base) && !reserved.has(base);
  if (usable && !isTaken(base)) return base;
  const stem = usable ? base : NEUTRAL_COMPANY_PART;
  for (let n = usable ? 2 : 1; ; n += 1) {
    const suffix = String(n);
    const candidate = stem.slice(0, MAX_COMPANY_PART_LENGTH - suffix.length) + suffix;
    if (!reserved.has(candidate) && !isTaken(candidate)) return candidate;
  }
}

/** `local@domain`, lowercase. Throws on an empty domain: an address with no domain is not an address. */
export function buildMailboxAddress(localPart: string, domain: string): string {
  const host = domain.trim().toLowerCase();
  if (!host) throw new Error('A mailbox domain is required to build an address');
  return `${localPart.trim().toLowerCase()}@${host}`;
}

/**
 * The local part of `address` when it is a bare address on `domain` (the environment's own mailbox
 * domain), else null. This is how "the register only issues, and only resolves, its own environment's
 * domain" is enforced: another environment's address, or any foreign domain, gives null.
 */
export function parseMailboxAddress(address: string, domain: string): string | null {
  const host = domain.trim().toLowerCase();
  const match = /^([a-z0-9._-]+)@([a-z0-9.-]+)$/i.exec(address.trim());
  if (!match || !host) return null;
  return match[2]!.toLowerCase() === host ? match[1]!.toLowerCase() : null;
}

/**
 * The domain this environment issues and receives mailbox addresses on: the `MAILBOX_DOMAIN` setting
 * (`staging.mail.servwave.com` on staging, `mail.servwave.com` in production) or, when it is not set,
 * the domain of the shared sending address, which is what every environment sent from before the
 * register existed. Empty when neither is a bare domain (the sending address can legitimately be a
 * full `Name <local@domain>` identity), and an empty domain issues nothing.
 */
export function mailboxDomainFrom(source: {
  MAILBOX_DOMAIN?: string | null;
  EMAIL_FROM_BUSINESS?: string | null;
}): string {
  const chosen = source.MAILBOX_DOMAIN?.trim().toLowerCase();
  if (chosen) return chosen;
  const shared = source.EMAIL_FROM_BUSINESS?.trim() ?? '';
  if (!shared || /[<>\s]/.test(shared)) return '';
  const at = shared.lastIndexOf('@');
  return at < 0 ? '' : shared.slice(at + 1).toLowerCase();
}

/** What a purged address is stored behind. A colon is not legal in a mailbox local part here, so no
 *  address anyone can offer (or receive mail on) can equal a stored hash. */
export const PURGED_ADDRESS_PREFIX = 'purged:';

/**
 * The one-way, keyed form a purged company's address is kept as: the marker plus the hex HMAC-SHA256 of
 * the lowercase local part under `key`. The address carries a person's name and the company's name, and
 * neither may outlive a purge, yet the address must stay unissuable, so "is this free" hashes the
 * candidate the same way and looks for it. The key lives outside the database; with no key there is no
 * hash, and this throws rather than fall back to anything readable.
 */
export function hashLocalPart(localPart: string, key: string): string {
  if (!key) throw new Error('A hash key is required to keep a purged address');
  const digest = createHmac('sha256', key).update(localPart.trim().toLowerCase()).digest('hex');
  return `${PURGED_ADDRESS_PREFIX}${digest}`;
}
