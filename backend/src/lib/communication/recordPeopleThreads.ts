import type { PrismaClient } from '@prisma/client';

/**
 * The record conversations that are the person's as one of the RECORD'S PEOPLE (Roles & Permissions PRD 10, S10.9).
 *
 * A record conversation with a customer reply in it joins the Email page of the people on the job or lead it is tied
 * to: a job's Sold By, its crew and its Dispatcher; a lead's Owner, the crew of its walkthroughs and its Dispatcher
 * (`recordPeopleReach`, lib/permissions/recordPeople.ts). The tie is worked out from the record each time it is read
 * (`tieOf`, recordTie.ts): an estimate to its job when it has one, else its lead; an invoice to its own job, else its
 * estimate's job, else its estimate's lead. The Owner of an estimate's lead is also one of its people when the estimate sits
 * on a job (M6's estimate alerts).
 *
 * THE READ STARTS FROM THE PERSON, not from the mail. It finds the jobs and leads the person is on, then the estimates and
 * invoices tied to those, then the conversations about any of them that hold a customer reply. That set is bounded by the
 * person's own work however much mail the company has, and it is one statement, so the Email menu badge, which every open
 * browser polls every 30 seconds on a database that allows one connection, costs a few indexed probes. (Written the other
 * way round, as a filter on every message joined to its record, the same question cost about ten times as much, and
 * schema.prisma carried four relations on `record_id` that no foreign key could ever back.)
 *
 * No copy of the tie or of the people is stored: they are read from the records, so a person taken off a crew, or a lead
 * that becomes a job, changes the answer on the very next request.
 *
 * THE RULES THIS STATEMENT RESTATES ARE `tieOf` AND `recordPeopleReach`, which are written as TypeScript and as Prisma
 * conditions and cannot be asked of a query that starts at the person. permission-email-record-people-sql-db.test.ts
 * proves the two agree, over every way a person can be on a record, so a change to either rule that is not made to both
 * turns that test red.
 *
 * It answers who is a record person and whether the conversation has a customer reply. Whether the person can still OPEN
 * the record (their row scope on it) is asked after, by the caller (`communicationScope.ts`): a person who is on a job but
 * cannot open jobs gets none of its conversations.
 */

/** A record conversation that is the person's as one of the record's people. */
export interface PeopleThread {
  id: string;
  record_type: 'job' | 'lead' | 'estimate' | 'invoice';
  record_id: string;
}

/**
 * The most conversations one person is given this way. A person on more records than this with a customer reply in each
 * (a Dispatcher over a whole company, say) gets the 500 whose customer replied most recently under "Linked to me", which
 * is where unread mail is; the older ones stay on their record's Communication tab and open from there. The id list goes
 * into the Email page's filter, so it must not grow with the company.
 */
export const RECORD_PEOPLE_THREAD_CAP = 500;

/** The narrow part of the database client this reads, so a test can stub it. */
export type PeopleThreadsDb = Pick<PrismaClient, '$queryRaw'>;

/**
 * The person's record conversations, newest customer reply first, at most `limit` of them.
 *
 * A customer reply is an inbound message that joined the conversation. A reply from an address the customer was not mailed
 * at is held with no conversation until someone links it (`inbound_match` is UNMATCHED_SENDER and `thread_id` empty), so the
 * match test only keeps a reply that was linked by hand from counting before its sender is trusted: it is matched then.
 */
export async function recordPeopleThreads(
  db: PeopleThreadsDb,
  args: { organizationId: string; personId: string; limit?: number },
): Promise<PeopleThread[]> {
  const org = args.organizationId;
  const me = args.personId;
  const limit = args.limit ?? RECORD_PEOPLE_THREAD_CAP;
  return db.$queryRaw<PeopleThread[]>`
    WITH my_jobs AS (
      SELECT id FROM jobs WHERE organization_id = ${org}::uuid AND salesperson_id = ${me}::uuid
      UNION SELECT id FROM jobs WHERE organization_id = ${org}::uuid AND dispatcher_id = ${me}::uuid
      UNION SELECT v.job_id FROM visit_assignees a JOIN visits v ON v.id = a.visit_id
        WHERE a.user_id = ${me}::uuid AND v.organization_id = ${org}::uuid AND v.job_id IS NOT NULL
    ), my_leads AS (
      SELECT id FROM leads WHERE organization_id = ${org}::uuid AND commission_owner_id = ${me}::uuid
      UNION SELECT id FROM leads WHERE organization_id = ${org}::uuid AND dispatcher_id = ${me}::uuid
      UNION SELECT v.lead_id FROM visit_assignees a JOIN visits v ON v.id = a.visit_id
        WHERE a.user_id = ${me}::uuid AND v.organization_id = ${org}::uuid AND v.lead_id IS NOT NULL
    ), tied_estimates AS (
      SELECT id FROM estimates WHERE organization_id = ${org}::uuid AND job_id IN (SELECT id FROM my_jobs)
      UNION SELECT id FROM estimates WHERE organization_id = ${org}::uuid AND job_id IS NULL AND lead_id IN (SELECT id FROM my_leads)
    ), people AS (
      SELECT 'job'::text AS record_type, id AS record_id FROM my_jobs
      UNION ALL SELECT 'lead', id FROM my_leads
      UNION ALL SELECT 'estimate', id FROM tied_estimates
      UNION ALL SELECT 'estimate', e.id FROM estimates e JOIN leads l ON l.id = e.lead_id
        WHERE e.organization_id = ${org}::uuid AND l.commission_owner_id = ${me}::uuid
      UNION ALL SELECT 'invoice', id FROM invoices WHERE organization_id = ${org}::uuid AND job_id IN (SELECT id FROM my_jobs)
      UNION ALL SELECT 'invoice', id FROM invoices
        WHERE organization_id = ${org}::uuid AND job_id IS NULL AND estimate_id IN (SELECT id FROM tied_estimates)
    )
    SELECT t.id::text AS id, t.record_type AS record_type, t.record_id::text AS record_id
    FROM (SELECT DISTINCT record_type, record_id FROM people) p
    JOIN email_threads t ON t.record_type = p.record_type AND t.record_id = p.record_id
    CROSS JOIN LATERAL (
      SELECT max(m.ts) AS last_reply FROM emails m
      WHERE m.organization_id = ${org}::uuid AND m.thread_id = t.id AND m.direction = 'in'
        AND (m.inbound_match IS NULL OR m.inbound_match = 'MATCHED')
    ) reply
    WHERE t.organization_id = ${org}::uuid AND t.origin = 'record' AND reply.last_reply IS NOT NULL
    ORDER BY reply.last_reply DESC, t.id
    LIMIT ${limit}::int`;
}
