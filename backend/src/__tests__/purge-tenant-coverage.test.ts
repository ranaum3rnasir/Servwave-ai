/**
 * Purge tenant-coverage drift guard (#869).
 *
 * The defect class: a model that carries a tenant column but has NO foreign key to
 * `organizations` is neither deleted by `purgeOrganization` nor cascaded by the DB, so a
 * SUCCESSFUL purge silently leaves its rows behind, pointing at an organization id that no
 * longer exists. The app can never reach them again (the workflow/copilot tables are RLS
 * ENABLE+FORCE on `organization_id`, so an orphan row is invisible to the app connection),
 * which means only raw SQL can ever clean them up.
 *
 * This guard is the part that stops the NEXT such table from regressing. For every model with
 * an `organization_id` or `org_id` column it requires one of:
 *   (a) purgeOrganization / purgeCustomerSubtree actually writes to the model, or
 *   (b) the model is transitively reached by a REQUIRED `onDelete: Cascade` chain rooted at a
 *       model in (a) or at `Organization` itself, or
 *   (c) the model is listed in PURGE_EXEMPT with a written reason.
 *
 * `org_id` matters as much as `organization_id`: `audit_logs` uses the former, so a naive
 * `organization_id` scan misses it entirely.
 *
 * Coverage in (a) is measured by RUNNING the purge against a recording proxy, not by grepping
 * purge.ts. A source scan would pass on a `tx.workflow.deleteMany` sitting in dead code or
 * behind a condition; only the real call sequence proves the row is actually deleted.
 */
import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';

import { purgeOrganization, PURGE_EXEMPT } from '../lib/purge';

const MODELS = Prisma.dmmf.datamodel.models;
const TENANT_COLUMNS = ['organization_id', 'org_id'];
const WRITE_OPS = new Set(['delete', 'deleteMany', 'update', 'updateMany']);

/** Every model carrying a tenant column - the population a purge is responsible for. */
function tenantModels(): string[] {
  return MODELS.filter((m) =>
    m.fields.some((f) => f.kind === 'scalar' && TENANT_COLUMNS.includes(f.name)),
  ).map((m) => m.name);
}

/**
 * Run the real purge against a proxy that records which models it writes to.
 *
 * `findMany` yields exactly one stub row so the per-customer subtree branch executes and its
 * models are recorded too - returning [] would silently under-report purgeCustomerSubtree's
 * whole surface and let this guard pass on a purge that never touches a customer.
 */
async function modelsWrittenByPurge(): Promise<Set<string>> {
  const written = new Set<string>();
  const tx: any = new Proxy(
    {},
    {
      get(_t, modelKey: string) {
        const model = String(modelKey);
        const pascal = model[0].toUpperCase() + model.slice(1);
        return new Proxy(
          {},
          {
            get(_t2, op: string) {
              if (WRITE_OPS.has(String(op))) {
                return async () => {
                  written.add(pascal);
                  return { count: 0 };
                };
              }
              if (op === 'findUnique' || op === 'findFirst') {
                return async () => ({ id: 'org-guard', name: 'e2e-qa-guard' });
              }
              if (op === 'findMany') return async () => [{ id: 'stub-id' }];
              if (op === 'count') return async () => 0;
              return async () => null;
            },
          },
        );
      },
    },
  );

  await purgeOrganization(tx, 'org-guard', 'e2e-qa-');
  return written;
}

/**
 * Close the written set over REQUIRED `onDelete: Cascade` edges, rooted at the written models
 * plus `Organization` (whose row purge deletes outright).
 *
 * `isRequired` is load-bearing: an OPTIONAL cascade parent means some rows have no parent at
 * all, so those rows are not reached and the model is NOT covered.
 */
function cascadeClosure(seed: Set<string>): Set<string> {
  const covered = new Set([...seed, 'Organization']);
  for (;;) {
    let grew = false;
    for (const m of MODELS) {
      if (covered.has(m.name)) continue;
      const cascadesFromCovered = m.fields.some(
        (f) =>
          f.kind === 'object' &&
          !f.isList &&
          f.isRequired &&
          f.relationOnDelete === 'Cascade' &&
          covered.has(f.type),
      );
      if (cascadesFromCovered) {
        covered.add(m.name);
        grew = true;
      }
    }
    if (!grew) return covered;
  }
}

describe('purge tenant-coverage drift guard (#869)', () => {
  it('leaves no tenant-scoped model unpurged, uncascaded and unexempted', async () => {
    const covered = cascadeClosure(await modelsWrittenByPurge());
    const gaps = tenantModels().filter((m) => !covered.has(m) && !(m in PURGE_EXEMPT));

    expect(
      gaps,
      `These models carry a tenant column but are neither purged, nor cascaded from a purged ` +
        `parent, nor exempted. Either delete them in purgeOrganization or add them to ` +
        `PURGE_EXEMPT with a written reason:\n  ${gaps.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every PURGE_EXEMPT entry names a real model', () => {
    const known = new Set(MODELS.map((m) => m.name));
    const unknown = Object.keys(PURGE_EXEMPT).filter((m) => !known.has(m));
    // A stale entry is how an allowlist rots into a place where real gaps hide.
    expect(unknown, `PURGE_EXEMPT references models that no longer exist: ${unknown.join(', ')}`).toEqual([]);
  });

  it('every PURGE_EXEMPT entry carries a real written reason, never a placeholder', () => {
    const bad = Object.entries(PURGE_EXEMPT).filter(
      ([, reason]) => reason.trim().length < 20 || /^(todo|tbd|fixme|\?+)/i.test(reason.trim()),
    );
    expect(
      bad.map(([m]) => m),
      'An exemption without a reason is an undocumented data-retention decision.',
    ).toEqual([]);
  });

  it('does not exempt any model purge actually covers (dead exemptions rot the list)', async () => {
    const covered = cascadeClosure(await modelsWrittenByPurge());
    const redundant = Object.keys(PURGE_EXEMPT).filter((m) => covered.has(m));
    expect(redundant, `Now covered by purge - remove from PURGE_EXEMPT: ${redundant.join(', ')}`).toEqual([]);
  });

  it('holds audit_logs and terms_acceptances as an explicit PENDING DECISION, not an accident', () => {
    // These two are the open question on #869: delete on purge (erasure) or retain (contract
    // evidence / append-only history). Today they survive by accident with no decision recorded
    // either way. Exempting them makes the non-decision visible instead of invisible.
    expect(PURGE_EXEMPT.AuditLog).toMatch(/PENDING DECISION/);
    expect(PURGE_EXEMPT.TermsAcceptance).toMatch(/PENDING DECISION/);
  });

  it('recognises org_id, not just organization_id (audit_logs uses org_id)', () => {
    // Pins the scan itself: an organization_id-only sweep reports AuditLog as out of scope and
    // the guard goes quietly green on a table holding 3,361 rows on staging.
    expect(tenantModels()).toContain('AuditLog');
  });
});
