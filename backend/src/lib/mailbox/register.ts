/**
 * The mailbox address register (PRD 10, M11a), database half: every address ever issued, globally
 * unique, never deleted. The pure rules (what a company part may be, how a variant is picked, what a
 * domain is) live in address-core.ts; this file applies them to the real tables.
 *
 * One interface: create a company together with its main mailbox, change a company's part, look an
 * address up, ask whether an address is free, list a mailbox's addresses, read a company's main address,
 * keep a purged company's addresses as keyed hashes, and (S10.3) issue a user's mailbox and
 * first.last.company address.
 *
 * Every write that issues an address runs in one transaction that first takes a database-wide advisory
 * lock (the idiom lib/numbering.ts and lib/tasks/categoryWrites.ts use), so two requests claiming one
 * part at the same moment are serialised: the second sees the first and takes the next free variant
 * (creation) or is told the part is taken (a change), never a server error. The unique indexes on the
 * register's `local_part` and on `organizations.email_sender_local_part` stay as the last line of
 * defence against a writer that skipped the lock.
 *
 * The register spans every company, so a caller running with the DB tenant guard on must wrap it in
 * runUnscoped. Nothing here reads or writes anything but addresses, parts and mailbox rows.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { env } from '../../config/env';
import { logger } from '../logger';
import {
  buildMailboxAddress,
  buildUserLocalPart,
  buildUserNamePart,
  checkCompanyPart,
  checkUserNamePart,
  hashLocalPart,
  isReservedLocalPart,
  mailboxDomainFrom,
  namePartOfLocalPart,
  nextFreeCompanyPart,
  parseMailboxAddress,
  slugCompanyPart,
} from './address-core';

type Tx = Prisma.TransactionClient;
type TransactionDb = Pick<PrismaClient, '$transaction'>;

/** The domain this environment issues and receives addresses on (the MAILBOX_DOMAIN setting). */
export function mailboxDomain(): string {
  return mailboxDomainFrom(env);
}

/** One lock for the whole register: issuing an address is rare, and a part must be unique across companies. */
export async function lockRegister(tx: Tx): Promise<void> {
  // $executeRaw: pg_advisory_xact_lock returns void, which the raw-query deserializer cannot map.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('mailbox_address_register', 0))`;
}

/** Shortest hash key accepted: a 256-bit hash is only as strong as the secret it is keyed with. */
const MIN_HASH_KEY_LENGTH = 32;

/** The key purged addresses are hashed under, read from configuration outside the database; null when unset. */
function configuredHashKey(): string | null {
  const key = env.MAILBOX_ADDRESS_HASH_KEY?.trim() ?? '';
  return key.length >= MIN_HASH_KEY_LENGTH ? key : null;
}

/** The key, or a loud failure: what a purge needs, since it must never keep a readable address instead. */
function requireHashKey(): string {
  const key = configuredHashKey();
  if (!key) {
    throw new Error(
      `The mailbox address hash key is not configured (MAILBOX_ADDRESS_HASH_KEY, at least ${MIN_HASH_KEY_LENGTH} characters)`,
    );
  }
  return key;
}

/** What answers "is this part taken": plain parts scanned by prefix, plus the purged companies' hashes. */
interface TakenParts {
  has(part: string): boolean;
}

/**
 * Every part, starting with `prefix`, that is not free for company `exceptOrgId` (or for a company that
 * does not exist yet, when it is omitted): addresses in the register (issued, reserved, or whose company
 * is gone), the frozen part of any other company, and the part a company that predates the register
 * would derive from its name today (its effective part, chosen or derived). A purged company's
 * addresses are held only as hashes, which a prefix cannot scan, so a candidate is hashed and looked up
 * instead.
 */
async function takenParts(tx: Tx, prefix: string, exceptOrgId?: string): Promise<TakenParts> {
  const issued = await tx.mailboxAddress.findMany({
    where: {
      local_part: { startsWith: prefix },
      ...(exceptOrgId ? { OR: [{ organization_id: null }, { organization_id: { not: exceptOrgId } }] } : {}),
    },
    select: { local_part: true },
  });
  const frozen = await tx.organization.findMany({
    where: { email_sender_local_part: { startsWith: prefix }, ...(exceptOrgId ? { id: { not: exceptOrgId } } : {}) },
    select: { email_sender_local_part: true },
  });
  const unfrozen = await tx.organization.findMany({
    where: { email_sender_local_part: null, ...(exceptOrgId ? { id: { not: exceptOrgId } } : {}) },
    select: { name: true },
  });
  const taken = new Set<string>();
  for (const row of issued) taken.add(row.local_part);
  for (const row of frozen) if (row.email_sender_local_part) taken.add(row.email_sender_local_part);
  for (const row of unfrozen) taken.add(slugCompanyPart(row.name));
  const isPurged = await purgedAddressCheck(tx);
  return { has: (part) => taken.has(part) || isPurged(part) };
}

/**
 * Whether a local part is one a purged company held, by hash. Nothing is purged yet: always false. Rows
 * exist but the key is not configured: the hashes cannot be compared, so this logs the gap and answers
 * false, since refusing every address would stop all onboarding over a missing setting (the purge, which
 * is what creates these rows, already refuses to run without the key).
 */
async function purgedAddressCheck(
  db: Pick<PrismaClient, 'mailboxAddress'>,
): Promise<(localPart: string) => boolean> {
  const rows = await db.mailboxAddress.findMany({ where: { kind: 'purged' }, select: { local_part: true } });
  if (rows.length === 0) return () => false;
  const key = configuredHashKey();
  if (!key) {
    logger.error('Mailbox address hash key is not configured; purged addresses cannot be checked');
    return () => false;
  }
  const hashes = new Set(rows.map((r) => r.local_part));
  return (localPart) => hashes.has(hashLocalPart(localPart, key));
}

/** The part a company called `name` gets: the name's own when free, else the next free variant. */
async function claimPart(tx: Tx, name: string, exceptOrgId?: string): Promise<string> {
  const wanted = slugCompanyPart(name);
  const usable = wanted !== '' && !isReservedLocalPart(wanted);
  // Variants are the stem plus a number, cut to stay inside the length cap, so they all share the stem's
  // first 30 characters.
  const taken = await takenParts(tx, (usable ? wanted : 'company').slice(0, 30), exceptOrgId);
  return nextFreeCompanyPart(wanted, (part) => taken.has(part));
}

/** Make `part` the primary address of the company's main mailbox, creating the mailbox if it has none. */
async function makePrimary(tx: Tx, orgId: string, part: string): Promise<void> {
  const mailbox =
    (await tx.mailbox.findFirst({ where: { organization_id: orgId, kind: 'main' }, select: { id: true } })) ??
    (await tx.mailbox.create({
      data: { organization_id: orgId, kind: 'main', status: 'active' },
      select: { id: true },
    }));
  // Demote first: the partial unique index allows one primary address per mailbox.
  await tx.mailboxAddress.updateMany({
    where: { mailbox_id: mailbox.id, is_primary: true, NOT: { local_part: part } },
    data: { is_primary: false },
  });
  const existing = await tx.mailboxAddress.findUnique({ where: { local_part: part }, select: { id: true } });
  if (existing) {
    await tx.mailboxAddress.update({
      where: { id: existing.id },
      data: { is_primary: true, mailbox_id: mailbox.id, organization_id: orgId },
    });
  } else {
    await tx.mailboxAddress.create({
      data: { local_part: part, kind: 'issued', organization_id: orgId, mailbox_id: mailbox.id, is_primary: true },
    });
  }
}

/** A unique-index loss on the register or on the company's part: someone claimed the part without our lock. */
function lostRaceForPart(err: unknown): boolean {
  const e = err as { code?: string; meta?: { target?: unknown } };
  return e?.code === 'P2002' && /local_part/.test(JSON.stringify(e.meta?.target ?? ''));
}

export type NewCompany = Omit<Prisma.OrganizationUncheckedCreateInput, 'email_sender_local_part'>;

/**
 * Create a company and, in the same transaction, freeze its company part (the name's own, else the next
 * free variant) and issue its main mailbox and main address. Either all of it happens or none of it.
 */
export async function createCompanyWithMainMailbox(db: TransactionDb, data: NewCompany) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await db.$transaction(async (tx) => {
        await lockRegister(tx);
        const part = await claimPart(tx, data.name);
        const org = await tx.organization.create({ data: { ...data, email_sender_local_part: part } });
        await makePrimary(tx, org.id, part);
        return org;
      });
    } catch (err) {
      if (attempt >= 3 || !lostRaceForPart(err)) throw err;
    }
  }
}

export type CompanyPartChange =
  | {
      ok: true;
      part: string;
      address: string;
      derivedFromName: boolean;
      /** The part the company held before this call; null when it had none frozen yet. */
      previousPart: string | null;
      /** False when the company already held this part and nothing was written. */
      changed: boolean;
      /** How many user mailboxes got a new primary address. */
      usersMoved: number;
    }
  | { ok: false; reason: 'invalid' | 'reserved' | 'taken' | 'too_long' };

/** Longest local part a mailbox address may have (RFC 5321). */
const MAX_LOCAL_PART = 64;

/**
 * List, in a temporary table, the user mailboxes of the company that need a new primary address under `part`, and say
 * whether they can have one. A person keeps the name part they have now (the part of their primary address before its
 * last dot), so a name changed on the Users page carries across. A person in "address needed" has no primary address
 * and is not listed; neither is one already on `part`. The list is a table, not a variable, because the swap that
 * follows (applyUserAddressMoves) demotes the old primaries first and still needs it afterwards: a mailbox may hold
 * only one primary address at a time. Writes nothing but the temporary table, so a refusal leaves the register alone.
 */
async function planUserAddressMoves(
  tx: Tx,
  orgId: string,
  part: string,
): Promise<{ ok: true } | { ok: false; reason: 'too_long' | 'taken' }> {
  await tx.$executeRaw`CREATE TEMPORARY TABLE company_part_move (mailbox_id uuid, old_id uuid, new_local_part text) ON COMMIT DROP`;
  await tx.$executeRaw`
    INSERT INTO company_part_move (mailbox_id, old_id, new_local_part)
    SELECT m.id, a.id, regexp_replace(a.local_part, '\\.[^.]*$', '') || '.' || ${part}::text
    FROM mailboxes m
    JOIN mailbox_addresses a ON a.mailbox_id = m.id AND a.is_primary
    WHERE m.organization_id = ${orgId}::uuid AND m.kind = 'user' AND m.status <> 'merged'
      AND a.local_part <> regexp_replace(a.local_part, '\\.[^.]*$', '') || '.' || ${part}::text`;
  const [problems] = await tx.$queryRaw<{ too_long: number; held: number }[]>`
    SELECT
      count(*) FILTER (WHERE length(t.new_local_part) > ${MAX_LOCAL_PART}::int)::int AS too_long,
      count(*) FILTER (WHERE x.id IS NOT NULL AND x.mailbox_id IS DISTINCT FROM t.mailbox_id)::int AS held
    FROM company_part_move t
    LEFT JOIN mailbox_addresses x ON x.local_part = t.new_local_part`;
  if (problems && problems.too_long > 0) return { ok: false, reason: 'too_long' };
  // An address under the new part that somebody else already holds can only mean the part was not free after all.
  if (problems && problems.held > 0) return { ok: false, reason: 'taken' };
  return { ok: true };
}

/**
 * Give each listed mailbox its new primary address and keep the old one on it, in three statements however many
 * people there are. A row the mailbox already holds under the new part (the company is taking an earlier part back)
 * becomes primary again instead of a duplicate. Returns how many mailboxes now have the new address as primary.
 */
async function applyUserAddressMoves(tx: Tx, orgId: string): Promise<number> {
  // The new rows first, not primary yet.
  await tx.$executeRaw`
    INSERT INTO mailbox_addresses (id, local_part, kind, organization_id, mailbox_id, is_primary, issued_at)
    SELECT gen_random_uuid(), t.new_local_part, 'issued', ${orgId}::uuid, t.mailbox_id, false, now()
    FROM company_part_move t
    ON CONFLICT (local_part) DO NOTHING`;
  await tx.$executeRaw`
    UPDATE mailbox_addresses SET is_primary = false WHERE id IN (SELECT old_id FROM company_part_move)`;
  return tx.$executeRaw`
    UPDATE mailbox_addresses a SET is_primary = true
    FROM company_part_move t
    WHERE a.local_part = t.new_local_part AND a.mailbox_id = t.mailbox_id`;
}

/**
 * Change the company part: the main mailbox AND every user mailbox get a new primary address, and each keeps its old
 * addresses, which stay in the register for good and are never issued to anyone else. `wanted` null goes back to the
 * part the company's current name gives (or its next free variant). A company's own earlier parts count as free for
 * it; every other company's (chosen or derived), every reserved part and every issued or purged address counts as
 * taken, and a refusal never says whose. One transaction under the register's lock, every query on its client; two
 * companies claiming one part at once: the second is told it is taken, and so is a writer that lost to the unique
 * index without the lock.
 *
 * `dryRun` runs every one of those checks and writes nothing: the answer is what the change would have been, so a
 * screen can refuse a part before it warns that everyone's address is about to change (the checks are these, not a copy).
 */
export async function changeCompanyPart(
  db: TransactionDb,
  orgId: string,
  wanted: string | null,
  options: { dryRun?: boolean } = {},
): Promise<CompanyPartChange> {
  try {
    return await db.$transaction(async (tx) => {
      await lockRegister(tx);
      const org = await tx.organization.findUniqueOrThrow({
        where: { id: orgId },
        select: { name: true, email_sender_local_part: true },
      });
      let part: string;
      if (wanted === null) {
        part = await claimPart(tx, org.name, orgId);
      } else {
        const candidate = wanted.trim().toLowerCase();
        const taken = await takenParts(tx, candidate, orgId);
        const checked = checkCompanyPart(candidate, (p) => taken.has(p));
        if (!checked.ok) return checked;
        part = checked.part;
      }
      const previousPart = org.email_sender_local_part;
      const fits = await planUserAddressMoves(tx, orgId, part);
      if (!fits.ok) return fits;
      if (options.dryRun) {
        return {
          ok: true,
          part,
          address: buildMailboxAddress(part, mailboxDomain()),
          derivedFromName: part === slugCompanyPart(org.name),
          previousPart,
          changed: previousPart !== part,
          usersMoved: 0,
        };
      }
      await makePrimary(tx, orgId, part);
      await tx.organization.update({ where: { id: orgId }, data: { email_sender_local_part: part } });
      const usersMoved = await applyUserAddressMoves(tx, orgId);
      return {
        ok: true,
        part,
        address: buildMailboxAddress(part, mailboxDomain()),
        derivedFromName: part === slugCompanyPart(org.name),
        previousPart,
        changed: previousPart !== part,
        usersMoved,
      };
    });
  } catch (err) {
    if (lostRaceForPart(err)) return { ok: false, reason: 'taken' };
    throw err;
  }
}

/** The company's current main address, or null for a company that has not been through the register. */
export async function mainAddressOf(
  db: Pick<PrismaClient, 'mailboxAddress'>,
  orgId: string,
): Promise<string | null> {
  const row = await db.mailboxAddress.findFirst({
    where: { is_primary: true, mailbox: { organization_id: orgId, kind: 'main' } },
    select: { local_part: true },
  });
  return row ? buildMailboxAddress(row.local_part, mailboxDomain()) : null;
}

export interface AddressRecord {
  localPart: string;
  kind: string;
  organizationId: string | null;
  mailboxId: string | null;
  isPrimary: boolean;
}

/** What the register knows about `address`; null when it is not on this environment's domain or was never issued. */
export async function lookupAddress(
  db: Pick<PrismaClient, 'mailboxAddress'>,
  address: string,
): Promise<AddressRecord | null> {
  const localPart = parseMailboxAddress(address, mailboxDomain());
  if (!localPart) return null;
  const row = await db.mailboxAddress.findUnique({ where: { local_part: localPart } });
  if (!row) return null;
  return {
    localPart: row.local_part,
    kind: row.kind,
    organizationId: row.organization_id,
    mailboxId: row.mailbox_id,
    isPrimary: row.is_primary,
  };
}

/**
 * Whether `address` can still be issued to anyone, as a company part or as a user address: it is on
 * this environment's domain, is not reserved, was never issued, and is not one a purged company held
 * (compared by hash).
 */
export async function isAddressFree(
  db: Pick<PrismaClient, 'mailboxAddress'>,
  address: string,
): Promise<boolean> {
  const localPart = parseMailboxAddress(address, mailboxDomain());
  if (!localPart) return false;
  return localPartIsFree(db, localPart);
}

/** Whether a local part can still be issued: not reserved, never issued, and not one a purged company held. */
async function localPartIsFree(db: Pick<PrismaClient, 'mailboxAddress'>, localPart: string): Promise<boolean> {
  if (isReservedLocalPart(localPart)) return false;
  if (await db.mailboxAddress.findUnique({ where: { local_part: localPart }, select: { id: true } })) return false;
  return !(await purgedAddressCheck(db))(localPart);
}

/**
 * Every name part ever issued to anyone in the company, past or present: the part of each user-mailbox address row
 * before its last dot. The name part is not stored; this reads it back, so a leaver's, a deleted user's and an old
 * (replaced) address's name part all count as taken, and so does one issued under an earlier company part.
 */
async function takenNameParts(tx: Tx, orgId: string): Promise<Set<string | null>> {
  const held = await tx.mailboxAddress.findMany({
    where: { organization_id: orgId, mailbox: { kind: 'user' } },
    select: { local_part: true },
  });
  return new Set(held.map((row) => namePartOfLocalPart(row.local_part)));
}

export interface IssuedUserMailbox {
  mailboxId: string;
  /** "active" with an address, or "address_needed" with none. */
  status: 'active' | 'address_needed';
  /** The primary address's local part; null while the mailbox is in "address needed". */
  localPart: string | null;
  /** False when the user already had a live mailbox and nothing was written. */
  created: boolean;
}

/**
 * Issue a user's mailbox and `first.last.company` address (PRD 10, "No duplicate mailboxes, ever"). Run it
 * inside the transaction that creates the user, passing that transaction's client: every query here goes
 * through `tx`, because the hosted pool holds one connection and a query on the global client would wait
 * for a second one that never comes. Either the user and the mailbox both exist afterwards or neither does.
 *
 * A name part already issued to anyone in the company, past or present (a leaver's stays taken: the address
 * rows are never deleted), is taken, and so is a name part held under an earlier company part. The register
 * never adds a number or an initial to make a name fit: the user then gets a mailbox in "address needed"
 * with no address, for an Admin to set later. So does a user with no usable name and a
 * company with no frozen part. The register-wide lock serialises two namesakes created at the same moment,
 * so the second sees the first; the unique index on `local_part` is the last line of defence.
 *
 * A user who already has a live (not merged) mailbox gets that one back and nothing is written.
 */
export async function issueUserMailbox(
  tx: Tx,
  user: { id: string; organization_id: string; first_name: string; last_name: string },
): Promise<IssuedUserMailbox> {
  await lockRegister(tx);
  const existing = await tx.mailbox.findFirst({
    where: { kind: 'user', user_id: user.id, status: { not: 'merged' } },
    select: { id: true, status: true, addresses: { where: { is_primary: true }, take: 1, select: { local_part: true } } },
  });
  if (existing) {
    return {
      mailboxId: existing.id,
      status: existing.status === 'active' ? 'active' : 'address_needed',
      localPart: existing.addresses[0]?.local_part ?? null,
      created: false,
    };
  }

  const org = await tx.organization.findUnique({
    where: { id: user.organization_id },
    select: { email_sender_local_part: true },
  });
  const companyPart = org?.email_sender_local_part ?? null;
  const namePart = companyPart ? buildUserNamePart(user.first_name, user.last_name, companyPart) : null;

  let localPart: string | null = null;
  if (companyPart && namePart) {
    const taken = await takenNameParts(tx, user.organization_id);
    const candidate = buildUserLocalPart(namePart, companyPart);
    if (!taken.has(namePart) && (await localPartIsFree(tx, candidate))) localPart = candidate;
  }

  const mailbox = await tx.mailbox.create({
    data: {
      organization_id: user.organization_id,
      kind: 'user',
      user_id: user.id,
      holder_user_id: user.id,
      status: localPart ? 'active' : 'address_needed',
    },
    select: { id: true },
  });
  if (localPart) {
    await tx.mailboxAddress.create({
      data: {
        local_part: localPart,
        kind: 'issued',
        organization_id: user.organization_id,
        mailbox_id: mailbox.id,
        is_primary: true,
      },
    });
  }
  return { mailboxId: mailbox.id, status: localPart ? 'active' : 'address_needed', localPart, created: true };
}

export type UserAddressSet =
  | {
      ok: true;
      mailboxId: string;
      /** The new primary address in full. */
      address: string;
      /** The primary address it replaced, in full; null when the mailbox had none ("address needed"). */
      previousAddress: string | null;
      /** True when the mailbox was in "address needed" and this made it active. */
      activated: boolean;
    }
  | {
      ok: false;
      reason:
        | 'invalid'
        | 'reserved'
        | 'taken'
        | 'user_not_found'
        | 'no_mailbox'
        | 'no_company_part'
        | 'no_domain';
    };

/**
 * Set or change the NAME PART of a user's mailbox address (PRD 10, "Changing a name part"), inside the caller's
 * transaction and through its client only (the hosted pool holds one connection). The address is built from the
 * name part, the company's frozen company part and this environment's mailbox domain; the admin types only the name
 * part. A name part anyone in the company has ever held, a leaver included, is taken, and so is an address already
 * issued to anyone or kept by a purged company. A taken, malformed or reserved name part writes nothing.
 *
 * On a mailbox in "address needed" the new address becomes its primary and the mailbox becomes active. On an active
 * mailbox the new address becomes the primary and the old one stays in the register, pointing at the same mailbox,
 * so it keeps delivering (the register never deletes). Takes the register-wide lock first, so two requests claiming
 * one name part at the same moment are serialised: the second is told it is taken.
 */
export async function setUserNamePartInTransaction(
  tx: Tx,
  args: { organizationId: string; userId: string; namePart: string },
): Promise<UserAddressSet> {
  await lockRegister(tx);
  const user = await tx.user.findFirst({
    where: { id: args.userId, organization_id: args.organizationId },
    select: { id: true },
  });
  if (!user) return { ok: false, reason: 'user_not_found' };
  const mailbox = await tx.mailbox.findFirst({
    where: { kind: 'user', user_id: user.id, status: { not: 'merged' } },
    select: { id: true, status: true, addresses: { where: { is_primary: true }, take: 1, select: { id: true, local_part: true } } },
  });
  if (!mailbox) return { ok: false, reason: 'no_mailbox' };
  const org = await tx.organization.findUnique({
    where: { id: args.organizationId },
    select: { email_sender_local_part: true },
  });
  const companyPart = org?.email_sender_local_part ?? null;
  if (!companyPart) return { ok: false, reason: 'no_company_part' };
  const domain = mailboxDomain();
  if (!domain) return { ok: false, reason: 'no_domain' };

  const checked = checkUserNamePart(args.namePart, companyPart);
  if (!checked.ok) return checked;
  const localPart = buildUserLocalPart(checked.namePart, companyPart);
  const taken = await takenNameParts(tx, args.organizationId);
  if (taken.has(checked.namePart) || !(await localPartIsFree(tx, localPart))) return { ok: false, reason: 'taken' };

  const previous = mailbox.addresses[0] ?? null;
  // Demote first: the partial unique index allows one primary address per mailbox.
  if (previous) await tx.mailboxAddress.update({ where: { id: previous.id }, data: { is_primary: false } });
  await tx.mailboxAddress.create({
    data: { local_part: localPart, kind: 'issued', organization_id: args.organizationId, mailbox_id: mailbox.id, is_primary: true },
  });
  // Only a mailbox waiting for an address becomes active: one handed to a person (S10.21) stays handed.
  const activated = mailbox.status === 'address_needed';
  if (activated) await tx.mailbox.update({ where: { id: mailbox.id }, data: { status: 'active' } });
  return {
    ok: true,
    mailboxId: mailbox.id,
    address: buildMailboxAddress(localPart, domain),
    previousAddress: previous ? buildMailboxAddress(previous.local_part, domain) : null,
    activated,
  };
}

/** `setUserNamePartInTransaction` in a transaction of its own. A lost race on the unique index reads as taken. */
export async function setUserNamePart(
  db: TransactionDb,
  args: { organizationId: string; userId: string; namePart: string },
): Promise<UserAddressSet> {
  try {
    return await db.$transaction((tx) => setUserNamePartInTransaction(tx, args));
  } catch (err) {
    if (lostRaceForPart(err)) return { ok: false, reason: 'taken' };
    throw err;
  }
}

export interface OwnMailbox {
  mailboxId: string;
  status: string;
  /** The primary address in full; null in "address needed", or when this environment has no mailbox domain. */
  address: string | null;
}

/**
 * The mailbox issued to this person and not merged away: their own address, as the Email page and their profile
 * show it. Null when they have none (an inactive user, or a person created before the mailboxes were issued).
 */
export async function ownMailboxOf(
  db: Pick<PrismaClient, 'mailbox'>,
  userId: string,
): Promise<OwnMailbox | null> {
  const box = await db.mailbox.findFirst({
    where: { kind: 'user', user_id: userId, status: { not: 'merged' } },
    select: { id: true, status: true, addresses: { where: { is_primary: true }, take: 1, select: { local_part: true } } },
  });
  if (!box) return null;
  const localPart = box.addresses[0]?.local_part;
  const domain = mailboxDomain();
  return { mailboxId: box.id, status: box.status, address: localPart && domain ? buildMailboxAddress(localPart, domain) : null };
}

/**
 * What follows the name part an admin types, in full: `.<company part>@<mailbox domain>`, the company's frozen part
 * and this environment's domain, for the Users page's set and change dialogs to show beside the field. Null when the
 * company has no frozen part or this environment has no mailbox domain (nothing can be issued then).
 */
export async function userAddressSuffix(
  db: Pick<PrismaClient, 'organization'>,
  orgId: string,
): Promise<string | null> {
  const org = await db.organization.findUnique({ where: { id: orgId }, select: { email_sender_local_part: true } });
  const domain = mailboxDomain();
  return org?.email_sender_local_part && domain ? `.${org.email_sender_local_part}@${domain}` : null;
}

/**
 * The live (not merged) user mailbox of each of these people with its primary address in full, in ONE read however many
 * people there are: the Users page's Email column. A person with no live mailbox is absent from the map; one in
 * "address needed" has a null address.
 */
export async function userMailboxesFor(
  db: Pick<PrismaClient, 'mailbox'>,
  userIds: string[],
): Promise<Map<string, OwnMailbox>> {
  const out = new Map<string, OwnMailbox>();
  if (userIds.length === 0) return out;
  const boxes = await db.mailbox.findMany({
    where: { kind: 'user', user_id: { in: userIds }, status: { not: 'merged' } },
    select: { id: true, user_id: true, status: true, addresses: { where: { is_primary: true }, take: 1, select: { local_part: true } } },
  });
  const domain = mailboxDomain();
  for (const box of boxes) {
    const localPart = box.addresses[0]?.local_part;
    out.set(box.user_id!, {
      mailboxId: box.id,
      status: box.status,
      address: localPart && domain ? buildMailboxAddress(localPart, domain) : null,
    });
  }
  return out;
}

/**
 * The company purge's half of the register: every address row of the company (its main address and every
 * user address) becomes a reservation holding only the keyed hash of the address, owned by no company or
 * mailbox, so neither a person's name nor the company's name stays readable and the address is never
 * issued again. Run inside the purge's transaction, before the company is deleted. With rows to convert
 * and no key it throws, which rolls the purge back, rather than keep a readable address.
 */
export async function reservePurgedAddresses(tx: Tx, orgId: string): Promise<void> {
  const rows = await tx.mailboxAddress.findMany({
    where: { OR: [{ organization_id: orgId }, { mailbox: { organization_id: orgId } }] },
    select: { id: true, local_part: true },
  });
  if (rows.length === 0) return;
  const key = requireHashKey();
  for (const row of rows) {
    await tx.mailboxAddress.update({
      where: { id: row.id },
      data: {
        local_part: hashLocalPart(row.local_part, key),
        kind: 'purged',
        organization_id: null,
        mailbox_id: null,
        is_primary: false,
      },
    });
  }
}

/** Every address a mailbox has ever been issued, oldest first, as full addresses. */
export async function listMailboxAddresses(
  db: Pick<PrismaClient, 'mailboxAddress'>,
  mailboxId: string,
): Promise<string[]> {
  const rows = await db.mailboxAddress.findMany({
    where: { mailbox_id: mailboxId },
    orderBy: { issued_at: 'asc' },
    select: { local_part: true },
  });
  return rows.map((r) => buildMailboxAddress(r.local_part, mailboxDomain()));
}

/** Select this on an organization read to get its main address's local part in the same query. */
export const MAIN_ADDRESS_SELECT = {
  mailboxes: {
    where: { kind: 'main' },
    take: 1,
    select: { addresses: { where: { is_primary: true }, take: 1, select: { local_part: true } } },
  },
} satisfies Prisma.OrganizationSelect;

/**
 * The local part the register issued as this company's main address, from an organization read that
 * selected MAIN_ADDRESS_SELECT. Null when the company has none (it predates the register).
 */
export function registeredLocalPart(
  org: { mailboxes?: { addresses: { local_part: string }[] }[] } | null | undefined,
): string | null {
  return org?.mailboxes?.[0]?.addresses?.[0]?.local_part ?? null;
}
