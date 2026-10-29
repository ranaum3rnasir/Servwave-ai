import { Prisma, PrismaClient } from '@prisma/client';
import { logger } from './logger';

type Entity =
  | 'lead'
  | 'estimate'
  | 'job'
  | 'invoice'
  | 'customer'
  | 'service_plan'
  | 'task'
  | 'purchase_order'
  | 'logistic_order';

type EntityFields = {
  next: string;
  prefix: string;
  firstIssued: string;
  table: string;
  numberCol: string;
  /**
   * Extra SQL predicate ANDed into the self-heal subquery, aliased `t`.
   *
   * Only entities whose number column holds MORE than the flat sequence need this.
   * Today that is `logistic_order`: anchored numbers (`LO-J00042-7`) share the
   * `number` column with flat ones (`LO00003`), and their trailing digits are a
   * per-anchor seq, not a document sequence — without the filter the self-heal MAX
   * reads `7` and jumps the flat counter to `LO00008` (gaps, never collisions).
   *
   * The discriminator is `t.seq IS NULL`, which is the SCHEMA's own definition of
   * "flat" (seq is NULL for standalone numbers, NOT NULL for anchored ones). It is
   * unenforced by design — no CHECK ties `seq` to the anchor FKs, because a flat LO
   * that is re-linked later keeps its flat number AND its NULL seq, which is exactly
   * where this filter wants it. See the "DELIBERATELY NO CHECK" note in
   * 20260720120000_logistic_orders_foundations. It deliberately is NOT the
   * string heuristic `t.number NOT LIKE '%-%'`: hyphens are legal in org prefixes
   * (PREFIX_REGEX = /^[A-Za-z0-9-]{1,10}$/, organization.controller.ts), so an org
   * with `logistic_order_prefix = 'LO-'` renders every FLAT number as `LO-00001`,
   * which that heuristic would exclude — silently turning the self-heal into a no-op
   * and re-opening the exact counter drift it exists to prevent.
   *
   * Like every other identifier here, this is a literal in this closed constant and
   * is spliced with `Prisma.raw` — never caller input.
   */
  selfHealFilter?: string;
  /**
   * Gate for the entire custom-number skip/fallback path in `allocateNumber` (see the
   * "Custom numbers" section of that function's doc comment). Only `lead` / `estimate` /
   * `job` / `invoice` / `customer` carry the `number_is_custom` column — set `true` ONLY
   * on those five. Every other entity leaves this absent (falsy), which keeps its
   * `allocateNumber` behavior byte-identical to before this property existed: no new
   * query, no reference to a column that table doesn't have. Like `selfHealFilter`, this
   * is a literal in this closed constant, never caller input — never widen it to a
   * request-derived boolean.
   */
  supportsCustomNumbers?: boolean;
};

const FIELDS: Record<Entity, EntityFields> = {
  lead:           { next: 'lead_next_number',           prefix: 'lead_prefix',           firstIssued: 'lead_first_issued_at',           table: 'leads',           numberCol: 'lead_number',    supportsCustomNumbers: true },
  estimate:       { next: 'estimate_next_number',       prefix: 'estimate_prefix',       firstIssued: 'estimate_first_issued_at',       table: 'estimates',       numberCol: 'estimate_number', supportsCustomNumbers: true },
  job:            { next: 'job_next_number',            prefix: 'job_prefix',            firstIssued: 'job_first_issued_at',            table: 'jobs',            numberCol: 'job_number',      supportsCustomNumbers: true },
  invoice:        { next: 'invoice_next_number',        prefix: 'invoice_prefix',        firstIssued: 'invoice_first_issued_at',        table: 'invoices',        numberCol: 'invoice_number',  supportsCustomNumbers: true },
  customer:       { next: 'customer_next_number',       prefix: 'customer_prefix',       firstIssued: 'customer_first_issued_at',       table: 'customers',       numberCol: 'customer_number', supportsCustomNumbers: true },
  service_plan:   { next: 'service_plan_next_number',   prefix: 'service_plan_prefix',   firstIssued: 'service_plan_first_issued_at',   table: 'service_plans',   numberCol: 'service_plan_number' },
  task:           { next: 'task_next_number',           prefix: 'task_prefix',           firstIssued: 'task_first_issued_at',           table: 'tasks',           numberCol: 'task_number' },
  purchase_order: { next: 'purchase_order_next_number', prefix: 'purchase_order_prefix', firstIssued: 'purchase_order_first_issued_at', table: 'purchase_orders', numberCol: 'po_number' },
  logistic_order: { next: 'logistic_order_next_number', prefix: 'logistic_order_prefix', firstIssued: 'logistic_order_first_issued_at', table: 'logistic_orders', numberCol: 'number', selfHealFilter: 't.seq IS NULL' },
};

/**
 * Window size for the fast-path skip query in `allocateNumber` — bounded so a single
 * `generate_series` scan stays a fast, single-statement check, NOT because exceeding it
 * is an error condition: when every candidate in the window is taken, the fallback tier
 * (COALESCE(MAX(...))+1, scanning the whole table) engages instead and always succeeds.
 * 1000 consecutive custom-number collisions in one org is already an extreme edge case.
 */
const SKIP_WINDOW = 1000;

/**
 * THE formatter for an org's record numbers — `L00001`, `BG-0042`, `698854`.
 *
 * Every caller that needs the string form of an allocated number goes through here, and no
 * other code — in TypeScript or in SQL — may render one. A record number is only ever compared
 * against, or written as, the output of this function, so "the number we checked was free" and
 * "the number we inserted" are the same string by construction.
 *
 * Note `padStart` never truncates: an org whose series has outgrown `number_padding` (padding
 * 5, six-digit imported ids) simply renders wider than the padding, which is correct and is
 * the case that the previous SQL-side `lpad` rendering got wrong. See `allocateNumber`.
 */
export function formatRecordNumber(prefix: string, padding: number, n: number): string {
  return `${prefix}${String(n).padStart(padding, '0')}`;
}

/**
 * Atomically allocate the next number for `entity` in `orgId`.
 *
 * Single UPDATE ... RETURNING: increments counter + COALESCE-sets first_issued_at.
 * Postgres holds an exclusive row-level lock on the org row until commit, so
 * concurrent allocations against the same org serialize and each sees its own
 * incremented value via RETURNING.
 *
 * `Prisma.raw()` is ONLY called with table/column names from the closed FIELDS constant
 * (type-safe `entity: 'lead' | 'estimate' | 'job' | 'invoice' | 'customer' | 'service_plan'`).
 * `orgId` is parameterized, never interpolated.
 *
 * Self-healing: the counter is advanced to GREATEST(stored, max-existing-number + 1) before
 * being consumed, so a counter that has drifted *behind* reality (e.g. rows inserted on the
 * shared staging DB by another branch without bumping it) can never hand back an already-used
 * number → no more unique-violation 500s on create. On a consistent DB the GREATEST picks the
 * stored value, so behaviour is unchanged (the max-suffix subquery is a small per-org scan;
 * fine at current scale — revisit if an entity table grows very large).
 *
 * For `supportsCustomNumbers` entities, the self-heal ALSO excludes rows where
 * `number_is_custom` is true: a single hand-typed number (e.g. a Workiz-imported "698637")
 * must never drag the whole org's automatic series up into that range — the counter should
 * only ever self-heal off numbers the allocator itself issued. This exclusion is also what
 * keeps the self-heal's `::int` cast safe from a Postgres 22003 integer-overflow error: this
 * cast reads a row's trailing digit-run as an `int` (max 2147483647), and an unbounded custom
 * id (e.g. an 11+ digit hand-typed number) would raise 22003 and 500 every create in the org
 * if such a row were included here. (The fallback tier below DOES read custom rows; it casts
 * to `bigint` behind a length guard for the same reason.) The complementary defense-in-depth
 * — a 9-digit cap on custom numeric ids at the API validation layer — has since shipped as
 * `MAX_NUMERIC_DIGITS` in lib/record-renumber.ts; excluding custom rows from THIS cast is what
 * keeps the allocator immune independently of it.
 *
 * Custom numbers (`supportsCustomNumbers` entities only): after the counter-derived candidate
 * is computed, a hand-typed number elsewhere in the org may already occupy it. The candidate
 * is therefore probed against the table and skipped forward until a free one is found.
 *
 * EVERY candidate string in every tier below is produced by `formatRecordNumber` — the single
 * formatter this module exports — and handed to SQL as a bound parameter. SQL never renders a
 * number itself. That is a correctness requirement, not a style choice: the previous
 * implementation rendered candidates a second time in SQL with `lpad(n::text, padding, '0')`,
 * and Postgres `lpad` TRUNCATES when the string is longer than the target width while JS
 * `padStart` does not. For any org whose numbers had outgrown `number_padding` (a Workiz
 * import: `number_padding` 5, six-digit ids) the two disagreed — `lpad('698854',5,'0')` is
 * `'69885'` — so the probe compared a string that could never match, always reported "free",
 * and the allocator handed back an already-taken number. Every create in that org then 500'd
 * on the unique violation, and because the counter increment rolls back with the failed
 * transaction it re-issued the SAME number forever. One formatter, no second rendering, and
 * that whole class of drift cannot recur.
 *
 * Three tiers, cheapest first:
 *   1. Probe — one indexed equality check on the counter-derived candidate. This is the whole
 *      cost in the common case (nothing collides), and it is a single bound parameter.
 *   2. Window skip — engages only when tier 1 collided. One query with the next `SKIP_WINDOW`
 *      candidates as a bound `text[]`; returns which are taken, and the lowest free one wins.
 *   3. Fallback — engages only if that whole window was taken (an extreme edge case). Scans the
 *      WHOLE table, custom rows included, for `MAX(trailing digits) + 1` — strictly greater
 *      than every existing row's trailing digits, so it cannot collide with anything, "free by
 *      construction". The digit-run is cast to `bigint` behind a length guard rather than
 *      `int`, so an 11+ digit hand-typed id cannot raise 22003 here and 500 every create in the
 *      org. This does NOT write back to the org's `*_next_number` counter: the resulting gap in
 *      the raw-number series is a property of which numbers get handed out over time, not a
 *      persisted counter jump, and the counter continues to reflect only non-custom rows via
 *      the self-heal above on every future call. Logged at `warn` so the jump is
 *      visible/greppable in prod.
 *
 * The counter is never left stuck behind a custom number: the row this call goes on to create
 * is an ALLOCATOR-issued one (`number_is_custom` false), so the self-heal above picks it up on
 * the very next call and the series advances normally from there.
 *
 * Entities without `supportsCustomNumbers` skip all of this and return exactly as before —
 * same number of queries, same SQL shape.
 *
 * Returns the formatted number string, e.g. "L00001" or "BG-0042".
 */
export async function allocateNumber(
  tx: Prisma.TransactionClient | PrismaClient,
  entity: Entity,
  orgId: string,
): Promise<string> {
  const f = FIELDS[entity];
  // Literal from the closed FIELDS constant, never caller input (see EntityFields.selfHealFilter
  // and EntityFields.supportsCustomNumbers).
  const filters: string[] = [];
  if (f.selfHealFilter) filters.push(f.selfHealFilter);
  if (f.supportsCustomNumbers) filters.push('NOT t.number_is_custom');
  const selfHealFilter = filters.length
    ? Prisma.raw(`AND (${filters.join(') AND (')})`)
    : Prisma.empty;
  const rows = await tx.$queryRaw<Array<{ next_value: number; prefix: string; padding: number }>>`
    UPDATE organizations
    SET ${Prisma.raw(f.next)} = GREATEST(
          ${Prisma.raw(f.next)},
          COALESCE((
            SELECT MAX((substring(t.${Prisma.raw(f.numberCol)} FROM '[0-9]+$'))::int)
            FROM ${Prisma.raw(f.table)} t
            WHERE t.organization_id = organizations.id ${selfHealFilter}
          ), 0) + 1
        ) + 1,
        ${Prisma.raw(f.firstIssued)} = COALESCE(${Prisma.raw(f.firstIssued)}, NOW())
    WHERE id = ${orgId}::uuid
    RETURNING ${Prisma.raw(f.next)} AS next_value,
              ${Prisma.raw(f.prefix)} AS prefix,
              number_padding AS padding
  `;
  if (rows.length === 0) {
    throw new Error(`Organization ${orgId} not found when allocating ${entity} number`);
  }
  const { next_value, prefix, padding } = rows[0];
  // next_value is post-increment; the allocated number is next_value - 1.
  const allocated = Number(next_value) - 1;

  const pad = Number(padding);
  const candidate = (n: number) => formatRecordNumber(prefix, pad, n);

  if (!f.supportsCustomNumbers) {
    return candidate(allocated);
  }

  // Tier 1 — probe the counter-derived candidate. Bound parameter, hits the
  // (organization_id, <number_col>) unique index, and is the entire cost when nothing collides.
  const probe = await tx.$queryRaw<Array<{ taken: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM ${Prisma.raw(f.table)} t
      WHERE t.organization_id = ${orgId}::uuid
        AND t.${Prisma.raw(f.numberCol)} = ${candidate(allocated)}
    ) AS taken
  `;
  if (!probe[0]?.taken) {
    return candidate(allocated);
  }

  // Tier 2 — the candidate is taken by a hand-typed number. Skip forward over a bounded window.
  // The candidates are rendered HERE (never in SQL) and bound as a text[]; the query reports
  // only which of them exist, so the lowest free one is picked from the very strings that will
  // be inserted.
  const window = Array.from({ length: SKIP_WINDOW }, (_, i) => candidate(allocated + i + 1));
  const takenRows = await tx.$queryRaw<Array<{ n: string }>>`
    SELECT t.${Prisma.raw(f.numberCol)} AS n FROM ${Prisma.raw(f.table)} t
    WHERE t.organization_id = ${orgId}::uuid
      AND t.${Prisma.raw(f.numberCol)} = ANY(${window}::text[])
  `;
  const taken = new Set(takenRows.map((r) => r.n));
  const free = window.find((n) => !taken.has(n));
  if (free !== undefined) {
    return free;
  }

  // Tier 3 — fallback. The whole SKIP_WINDOW was taken (extreme edge case); never a failure.
  // Scans ALL rows (custom included, no exclusion) so the result is strictly greater than
  // every existing row's trailing digits — free by construction. Deliberately does NOT write
  // back to organizations.<next_col>; see doc comment above. The length guard keeps the
  // bigint cast total: a digit-run longer than 15 characters cannot be a number this series
  // needs to clear, and including it would risk an overflow that 500s every create in the org.
  const fallbackRows = await tx.$queryRaw<Array<{ next_free: bigint }>>`
    SELECT COALESCE(MAX((substring(${Prisma.raw(f.numberCol)} FROM '[0-9]+$'))::bigint), 0) + 1 AS next_free
    FROM ${Prisma.raw(f.table)}
    WHERE organization_id = ${orgId}::uuid
      AND length(substring(${Prisma.raw(f.numberCol)} FROM '[0-9]+$')) <= 15
  `;
  const nextFree = Number(fallbackRows[0]?.next_free ?? allocated);
  logger.warn('allocateNumber: skip window exhausted, fell back to full-table scan', {
    orgId,
    entity,
    jumpedTo: nextFree,
  });
  return candidate(nextFree);
}

// ============================================================================
// Container numbering - `L00005-1` / `C00010-1` / `J00007-1`  (SERV10X-61)
// ============================================================================

/**
 * The three anchor containers a NEW estimate can be numbered within, plus the human-number
 * column read off the LOCKED container row. All literals in a closed constant - spliced with
 * `Prisma.raw`, never caller input (identical safety posture to `ANCHORS` above).
 */
const ESTIMATE_CONTAINERS = {
  lead:     { table: 'leads',     numberColumn: 'lead_number' },
  customer: { table: 'customers', numberColumn: 'customer_number' },
  job:      { table: 'jobs',      numberColumn: 'job_number' },
} as const satisfies Record<string, { table: string; numberColumn: string }>;

export type EstimateContainer = keyof typeof ESTIMATE_CONTAINERS;

/** Prisma enum value recorded on `Estimate.container_kind` for each container. */
const CONTAINER_KIND = {
  lead: 'LEAD',
  customer: 'CUSTOMER',
  job: 'JOB',
} as const satisfies Record<EstimateContainer, string>;

export type EstimateContainerKind = (typeof CONTAINER_KIND)[EstimateContainer];

/**
 * THE formatter for a container estimate number - `L00005-1`, `699063-2`.
 *
 * Same rule `formatRecordNumber` establishes for the flat series (see its doc comment and the
 * #1873 outage it came out of): one renderer, never a second one in SQL, so the string that is
 * checked for freeness and the string that is inserted are equal by construction. The container
 * number is read off the LOCKED container row and the seq is appended un-padded - `number_padding`
 * shapes the container's OWN number, never this suffix.
 */
export function formatContainerEstimateNumber(containerNumber: string, seq: number): string {
  return `${containerNumber}-${seq}`;
}

/**
 * Escape a value for use inside a bound Postgres regex (`~`) pattern, so a container number
 * containing a regex metacharacter matches literally. Org prefixes allow `-` today
 * (PREFIX_REGEX = /^[A-Za-z0-9-]{1,10}$/), and hand-typed numbers are not guaranteed to stay
 * inside that alphabet, so the escape is unconditional rather than an assumption about content.
 */
function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The longest trailing digit-run this allocator will read as a seq. Same guard, same reason, as
 * `allocateNumber`'s tier-3 scan: an absurdly long hand-typed suffix must not be able to raise a
 * Postgres 22003 overflow and 500 every estimate create in the org. A seq that long is not a
 * number this per-container series will ever need to clear.
 */
const CONTAINER_SEQ_DIGIT_GUARD = 15;

/**
 * What a container allocation yields: the number to insert AND the two columns that record which
 * container minted it. Deliberately named exactly as the `estimates` columns so a create site
 * spreads the whole thing into `data` (`...allocated`) and cannot persist the number while
 * silently dropping the provenance - which is precisely what all three create paths did before
 * (SERV10X-61 follow-up 2b). `computeRenumber` selects its cascade targets by
 * `container_kind` + anchor FK + `number_is_custom = false`, so an estimate created without these
 * columns is invisible to a container rename and keeps a stale number for ever.
 */
export interface ContainerEstimateNumber {
  estimate_number: string;
  container_kind: EstimateContainerKind;
  container_seq: number;
}

/**
 * Allocate a per-container estimate number - `L00005-1`, `C00010-1`, `J00007-1` (spec §5.7).
 *
 * SERV10X-61 numbers each NEW estimate within its anchor container (lead / customer / job)
 * instead of the flat org-wide `E00001` series. The first statement is `UPDATE <container> SET
 * estimate_seq = estimate_seq + 1 … RETURNING estimate_seq, <number_col>`: a plain UPDATE takes an
 * implicit `FOR NO KEY UPDATE` row lock on the container row held until commit, so concurrent
 * allocations against the SAME container serialize and each RETURNING sees its own incremented
 * value - the same discipline `allocateNumber` applies to the organizations row. The
 * `organization_id` predicate keeps it tenant-scoped even though `id` is globally unique.
 *
 * MUST be called with the transaction client as part of the create transaction, so a failed
 * estimate insert releases both locks and rolls the counter increment back with them. Passing a
 * bare `PrismaClient` autocommits each statement, which drops the locks before the caller's insert
 * and silently gives up the cross-container guarantee below (all three estimate create paths pass
 * a `tx`).
 *
 * SELF-HEAL + SKIP (follow-up 2a). This function used to return the counter's value verbatim,
 * arguing that a collision was impossible because "every legacy estimate uses the flat `E…`
 * series, which can never collide with `<container_number>-<seq>`". That argument died when
 * estimate numbers became hand-typeable: an estimate renamed to `01287-3` sits exactly in this
 * series' domain. Reproduced against a real DB - a lead at `estimate_seq = 2` whose container
 * already holds `01287-3` returned `01287-3`, the insert died with P2002, and because the seq
 * bump rolls back with the failed transaction the next attempt minted the identical number. A
 * retry cannot break that loop; only a skip can. This is the same permanent pin #1873 fixed for
 * the flat allocator, reached by a different route.
 *
 * The repair is modelled on `allocateAnchoredNumber`, which derives its seq from the rows that
 * exist rather than trusting a counter alone:
 *
 *   healed = GREATEST(counter, MAX(seq of ALLOCATOR-ISSUED rows in this container) + 1)
 *   final  = the first seq at or above `healed` that no row in this container holds
 *
 * The two halves answer two different rules, and both are required:
 *
 *   - The MAX self-heal reads only `number_is_custom = false` rows, mirroring `allocateNumber`'s
 *     self-heal exclusion. Renaming ONE estimate to `01287-900` must not drag the container's
 *     whole series up to 901 (product rule: a far-off rename does not move the sequence).
 *   - The skip therefore reads ALL rows, custom included, because a hand-typed number the
 *     sequence deliberately did not chase is still a number that is TAKEN. Skipping it is what
 *     makes "record creation must never fail because of numbering" true.
 *
 * Note this is a skip, not a retry, and the distinction is the whole point: a retry re-runs the
 * same derivation and re-derives the SAME number, so the P2002 above repeats for ever. The
 * P2002 retry backstop that wraps the flat allocator's call sites cannot rescue this function;
 * only deriving past the taken number can.
 *
 * The result is free by construction rather than merely probed-free, and TWO locks are needed for
 * that claim to be true:
 *
 *   - the container-row lock from the UPDATE above, which serializes allocations against the same
 *     container, and
 *   - a transaction-scoped ADVISORY lock keyed on `(organization_id, container_number)`, because
 *     the uniqueness that must hold is keyed on the NUMBER, not on the row. Two DIFFERENT
 *     containers can carry the same human number - a lead `555555` and a job `555555` - and they
 *     take DIFFERENT row locks. Proven: two concurrent transactions in exactly that shape both
 *     minted `555555-1`, and the second insert would have died P2002. Reachable only because
 *     numbers became hand-editable, which is the premise of this whole workstream.
 *
 * With both held, `@@unique([organization_id, estimate_number])` is org-wide and any row holding
 * `<container_number>-<final>` necessarily matches the pattern this function just read, so it is
 * in the taken set - and a concurrent allocator that could mint the same string is made to wait
 * until this transaction COMMITS, so its own read sees the row.
 *
 * SCOPE of that claim: concurrent ALLOCATIONS, not every writer of this number space.
 * `applyRenumber`'s container-estimate cascade (lib/record-renumber.ts) writes `<parent>-<seq>`
 * strings directly and does NOT take this advisory lock, so a rename cascading onto container
 * number N, concurrent with an allocation on the container numbered N, can still collide - and
 * which side takes the P2002 depends on ordering. Pre-existing and out of scope here; closing it
 * means having the cascade take the same lock on each container number it touches.
 *
 * The healed value is NOT written back to `estimate_seq`. It does not need to be - the row this
 * call goes on to create is allocator-issued (`number_is_custom` false), so the MAX self-heal
 * above picks it up on the very next call and the series advances from there. Leaving the counter
 * alone is also what keeps a custom rename from moving the sequence permanently, exactly as
 * `allocateNumber`'s tier-3 deliberately does not write its jump back.
 *
 * Returns the number AND its provenance columns; see `ContainerEstimateNumber`.
 */
export async function allocateContainerEstimateNumber(
  tx: Prisma.TransactionClient | PrismaClient,
  container: EstimateContainer,
  containerId: string,
  orgId: string,
): Promise<ContainerEstimateNumber> {
  const c = ESTIMATE_CONTAINERS[container];
  const rows = await tx.$queryRaw<Array<{ seq: number; container_number: string }>>`
    UPDATE ${Prisma.raw(c.table)}
    SET estimate_seq = estimate_seq + 1
    WHERE id = ${containerId}::uuid AND organization_id = ${orgId}::uuid
    RETURNING estimate_seq AS seq, ${Prisma.raw(c.numberColumn)} AS container_number
  `;
  if (rows.length === 0) {
    throw new Error(
      `Container ${container}/${containerId} not found in organization ${orgId} when allocating estimate number`,
    );
  }
  const containerNumber = rows[0].container_number;
  const counterSeq = Number(rows[0].seq);

  // The lock that matches what must be unique. See "TWO locks" above: the container-row lock is
  // keyed on the ROW, uniqueness is keyed on the NUMBER, and two containers can share a number.
  // xact-scoped, so commit or rollback releases it and there is no unlock path to forget. A
  // hash collision between two unrelated (org, number) pairs costs a needless wait, never a wrong
  // answer. Taken AFTER the container UPDATE because the container's number is only known from
  // that RETURNING - and before the read below, which is the part that must not race.
  // $executeRaw, not $queryRaw: pg_advisory_xact_lock returns `void`, which Prisma's raw-query
  // deserializer cannot map to a column type.
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${orgId} || ':' || ${containerNumber}, 0))
  `;

  // Every estimate in the org whose number belongs to THIS container's series. Anchored on the
  // container's own number (read off the locked row) rather than on the estimate's FK: an
  // estimate may carry several FKs at once, and only the container that minted the number shapes
  // it. The pattern is a bound parameter - the container number is never spliced into SQL - and
  // it is a full-string regex, not a `LIKE '<n>-%'`, so `01287-3-1` cannot be misread as seq 1.
  const pattern = `^${escapeRegexLiteral(containerNumber)}-[0-9]+$`;
  const existing = await tx.$queryRaw<Array<{ seq: bigint; is_custom: boolean }>>`
    SELECT (substring(estimate_number FROM '[0-9]+$'))::bigint AS seq,
           number_is_custom AS is_custom
    FROM estimates
    WHERE organization_id = ${orgId}::uuid
      AND estimate_number ~ ${pattern}
      AND length(substring(estimate_number FROM '[0-9]+$')) <= ${CONTAINER_SEQ_DIGIT_GUARD}
  `;

  const taken = new Set<number>();
  let maxIssued = 0;
  for (const row of existing) {
    const seq = Number(row.seq);
    taken.add(seq);
    if (!row.is_custom && seq > maxIssued) maxIssued = seq;
  }

  let seq = Math.max(counterSeq, maxIssued + 1);
  while (taken.has(seq)) seq += 1;

  if (seq !== counterSeq) {
    logger.warn('allocateContainerEstimateNumber: counter healed/skipped past taken numbers', {
      orgId,
      container,
      containerId,
      counterSeq,
      issuedSeq: seq,
    });
  }

  return {
    estimate_number: formatContainerEstimateNumber(containerNumber, seq),
    container_kind: CONTAINER_KIND[container],
    container_seq: seq,
  };
}

// ============================================================================
// Anchored numbering — `LO-J00042-1`
// ============================================================================

/**
 * Anchor kinds in numbering-precedence order: most specific wins.
 *
 * A document may link to several anchors at once; only the FIRST one present here
 * shapes its number, the rest stay plain links (spec §11 build note a). The number
 * is minted once at creation and is immutable — re-linking never renumbers.
 */
export const ANCHOR_PRECEDENCE = ['job', 'invoice', 'estimate', 'lead', 'customer', 'service_plan'] as const;

export type AnchorKind = (typeof ANCHOR_PRECEDENCE)[number];

/**
 * The closed allowlist. Every identifier interpolated into anchored-numbering SQL
 * comes from here — `Prisma.raw` is never handed a caller-supplied string.
 *
 * `numberColumn` is the anchor's own human-number column, read off the LOCKED row so
 * the minted string can never disagree with the row the lock and the sequence domain
 * key off (all six verified against schema.prisma).
 */
export const ANCHORS = {
  job:          { table: 'jobs',          column: 'job_id',          numberColumn: 'job_number' },
  invoice:      { table: 'invoices',      column: 'invoice_id',      numberColumn: 'invoice_number' },
  estimate:     { table: 'estimates',     column: 'estimate_id',     numberColumn: 'estimate_number' },
  lead:         { table: 'leads',         column: 'lead_id',         numberColumn: 'lead_number' },
  customer:     { table: 'customers',     column: 'customer_id',     numberColumn: 'customer_number' },
  service_plan: { table: 'service_plans', column: 'service_plan_id', numberColumn: 'service_plan_number' },
} as const satisfies Record<AnchorKind, { table: string; column: string; numberColumn: string }>;

export type AnchorTable = (typeof ANCHORS)[AnchorKind]['table'];
export type AnchorColumn = (typeof ANCHORS)[AnchorKind]['column'];

/**
 * Tables that carry an anchored `number` + int `seq` pair. Generic on purpose: the
 * estimate-renumbering effort adds `'estimates'` here and passes `documentPrefix: 'E'`
 * rather than re-implementing the allocator (spec §11 build note c).
 */
const DOCUMENT_TABLES = ['logistic_orders'] as const;
export type DocumentTable = (typeof DOCUMENT_TABLES)[number];

const ANCHOR_TABLES = new Set<string>(ANCHOR_PRECEDENCE.map((k) => ANCHORS[k].table));
const ANCHOR_COLUMNS = new Set<string>(ANCHOR_PRECEDENCE.map((k) => ANCHORS[k].column));
const ANCHOR_BY_TABLE = new Map<string, (typeof ANCHORS)[AnchorKind]>(
  ANCHOR_PRECEDENCE.map((k) => [ANCHORS[k].table, ANCHORS[k]]),
);

/**
 * Escape a value for use inside a bound SQL `LIKE` pattern. Postgres' default LIKE
 * escape character is backslash, so the wildcards and the escape char itself must be
 * neutralised before they are concatenated into the pattern.
 */
function escapeLikeLiteral(value: string): string {
  return value.replace(/([\\%_])/g, '\\$1');
}

function assertAllowlisted(kind: string, value: string, allowed: Set<string>): void {
  if (!allowed.has(value)) {
    throw new Error(`Refusing to build anchored-numbering SQL: ${kind} "${value}" is not in the allowlist`);
  }
}

export interface AnchoredNumberInput {
  organizationId: string;
  /** Anchor's table, e.g. `'jobs'` — allowlisted against ANCHORS. */
  anchorTable: AnchorTable;
  /** Document's FK column pointing at the anchor, e.g. `'job_id'` — allowlisted against ANCHORS. */
  anchorColumn: AnchorColumn;
  anchorId: string;
  /**
   * OPTIONAL assertion, not an input: the number is always taken from the locked
   * anchor row. When supplied it is verified against that row and a mismatch throws,
   * so a stale cache or a wrong lookup fails loudly instead of minting a number from
   * one row while holding the lock on another.
   */
  anchorNumber?: string;
  /** Document prefix; `'LO'` for logistic orders, `'E'` for a future anchored estimate scheme. */
  documentPrefix?: string;
  /** Table holding the `seq` column to read; allowlisted against DOCUMENT_TABLES. */
  documentTable?: DocumentTable;
}

/**
 * Allocate the next per-anchor sequence for a document anchored to `anchorId`,
 * returning `{ number: 'LO-J00042-1', seq: 1 }`.
 *
 * Concurrency: `SELECT … FOR NO KEY UPDATE` on the ANCHOR row takes a row-level lock
 * held until commit, so concurrent allocations against the same anchor serialize — the
 * same trick `allocateNumber` plays with the organizations row, just with a narrower
 * lock target. There is deliberately NO retry loop: `@@unique([organization_id,
 * number])` on the document table is the backstop, and a P2002 there means a bug, not a
 * race we should paper over.
 *
 * Why NO KEY, specifically: `FOR UPDATE` conflicts with `FOR KEY SHARE`, which Postgres
 * takes on a referenced row for ANY insert of a row carrying an FK to it. `jobs` is the
 * hottest row in the system and `job` is the default anchor, so plain `FOR UPDATE` here
 * would block every concurrent job_line_item / task / attachment / note / invoice /
 * stock_movement insert against that job — plus any `UPDATE jobs SET status` — for the
 * whole create transaction. `FOR NO KEY UPDATE` still conflicts with ITSELF, so the
 * allocators serialize exactly as intended, but it does not conflict with `FOR KEY
 * SHARE`. (The flat allocator gets this right implicitly: a plain UPDATE takes
 * `FOR NO KEY UPDATE`.)
 *
 * MUST be called with the transaction client and as the first statement of the create
 * transaction, exactly like `allocateNumber` — a failed insert must release the lock and
 * roll the allocation back with it.
 *
 * `seq` is returned as an int and MUST be persisted to the int `seq` column: string sort
 * puts `-10` before `-2`, so ordering can only be done on the number (spec §11 note b).
 * The read self-heals past a NULL `seq` by falling back to the trailing digit-run of
 * `number`, mirroring the flat allocator's GREATEST: without it a single NULL-seq row
 * would make `COALESCE(MAX(seq),0)+1` re-mint an already-used number forever, and the
 * unique index would make that anchor permanently un-creatable.
 *
 * Sequence domain: scoped to the rows this anchor actually SHAPED (`number LIKE
 * '<prefix>-<anchorNumber>-%'`), not merely the rows that link to it. A document may
 * carry several anchors at once — only the precedence winner shapes the number, "the
 * rest stay plain links" — so scoping by the FK column alone lets a job-anchored LO
 * advance its customer's series, and the customer's first LO would be numbered `-2`.
 * That can never collide, so the unique index never surfaces it: it fails silently.
 *
 * Injection: `Prisma.raw` receives only allowlist-checked identifiers; `organizationId`,
 * `anchorId` and the LIKE pattern are bound parameters. The anchor's number is read from
 * the database, never interpolated into SQL.
 */
export async function allocateAnchoredNumber(
  tx: Prisma.TransactionClient | PrismaClient,
  input: AnchoredNumberInput,
): Promise<{ number: string; seq: number }> {
  const {
    organizationId,
    anchorTable,
    anchorColumn,
    anchorId,
    anchorNumber: expectedAnchorNumber,
    documentPrefix = 'LO',
    documentTable = 'logistic_orders',
  } = input;

  assertAllowlisted('anchor table', anchorTable, ANCHOR_TABLES);
  assertAllowlisted('anchor column', anchorColumn, ANCHOR_COLUMNS);
  assertAllowlisted('document table', documentTable, new Set<string>(DOCUMENT_TABLES));

  // Both identifiers are allowlisted, but they must also describe the SAME anchor:
  // `jobs` + `customer_id` would otherwise lock a job and sequence a customer.
  const anchor = ANCHOR_BY_TABLE.get(anchorTable);
  if (!anchor || anchor.column !== anchorColumn) {
    throw new Error(
      `Refusing to build anchored-numbering SQL: anchor column "${anchorColumn}" does not belong to anchor table "${anchorTable}"`,
    );
  }

  // Serialize every allocation against this anchor, prove the anchor is ours, and read
  // the anchor's own number off the LOCKED row — the string we mint must describe the
  // row we hold the lock on, never a caller-supplied number that may disagree with it.
  const locked = await tx.$queryRaw<Array<{ id: string; anchor_number: string }>>`
    SELECT id, ${Prisma.raw(anchor.numberColumn)} AS anchor_number
    FROM ${Prisma.raw(anchorTable)}
    WHERE id = ${anchorId}::uuid AND organization_id = ${organizationId}::uuid
    FOR NO KEY UPDATE
  `;
  if (locked.length === 0) {
    throw new Error(`Anchor ${anchorTable}/${anchorId} not found in organization ${organizationId}`);
  }

  const anchorNumber = locked[0].anchor_number;
  if (expectedAnchorNumber !== undefined && expectedAnchorNumber !== anchorNumber) {
    throw new Error(
      `Anchor number mismatch: caller passed "${expectedAnchorNumber}" but ${anchorTable}/${anchorId} is "${anchorNumber}"`,
    );
  }

  // The rows this anchor actually shaped — see "Sequence domain" above. Bound as a
  // parameter; the anchor number is never spliced into the statement text.
  const numberPattern = `${escapeLikeLiteral(documentPrefix)}-${escapeLikeLiteral(anchorNumber)}-%`;

  // `seq` / `number` are the document-table column names; both are literals here rather
  // than allowlist lookups because DOCUMENT_TABLES is the closed set that must expose
  // exactly this pair (spec §11 build note c).
  const rows = await tx.$queryRaw<Array<{ next_seq: number }>>`
    SELECT GREATEST(
             COALESCE(MAX(seq), 0),
             COALESCE(MAX((substring(number FROM '[0-9]+$'))::int), 0)
           ) + 1 AS next_seq
    FROM ${Prisma.raw(documentTable)}
    WHERE organization_id = ${organizationId}::uuid
      AND ${Prisma.raw(anchorColumn)} = ${anchorId}::uuid
      AND number LIKE ${numberPattern}
  `;
  const seq = Number(rows[0]?.next_seq ?? 1);

  return { number: `${documentPrefix}-${anchorNumber}-${seq}`, seq };
}

/** Anchor FK columns as they appear on a document row / create payload. */
export type AnchorIds = Partial<Record<AnchorColumn, string | null | undefined>>;

/**
 * Pick the anchor that shapes the number, per ANCHOR_PRECEDENCE.
 *
 * Returns `null` when no anchor is set — the caller then falls back to the flat
 * `allocateNumber` (standalone `LO00001`).
 */
export function pickAnchor(
  anchors: AnchorIds,
): { kind: AnchorKind; id: string; table: AnchorTable; column: AnchorColumn } | null {
  for (const kind of ANCHOR_PRECEDENCE) {
    const { table, column } = ANCHORS[kind];
    const id = anchors[column];
    if (id) return { kind, id, table, column };
  }
  return null;
}
