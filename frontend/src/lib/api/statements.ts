/**
 * Statement endpoints (entity-redesign §9 — read-only ledger projection).
 *
 * JSON variant returns a Statement (lines + running balance + totals). The ?format=pdf
 * variant streams a PDF; callers receive a Blob. The statement PAGE/rendering is Phase 8;
 * this module only provides the client functions + the Statement type lives in
 * @/types/entities.
 *
 * Routes verified against backend/src/routes/statement.routes.ts.
 */
import api from '@/lib/axios';
import type { Statement } from '@/types/entities';

interface StatementOpts {
  format?: 'pdf';
}

/** GET /api/statements/job/:jobId — JSON statement, or a PDF Blob when format='pdf'. */
export function getJobStatement(jobId: string): Promise<Statement>;
export function getJobStatement(jobId: string, opts: { format: 'pdf' }): Promise<Blob>;
export function getJobStatement(jobId: string, opts?: StatementOpts): Promise<Statement | Blob> {
  if (opts?.format === 'pdf') {
    return api
      .get(`/api/statements/job/${jobId}`, { params: { format: 'pdf' }, responseType: 'blob' })
      .then((r) => r.data as Blob);
  }
  return api.get(`/api/statements/job/${jobId}`).then((r) => r.data as Statement);
}

/** GET /api/statements/customer/:customerId — JSON statement, or a PDF Blob when format='pdf'. */
export function getCustomerStatement(customerId: string): Promise<Statement>;
export function getCustomerStatement(customerId: string, opts: { format: 'pdf' }): Promise<Blob>;
export function getCustomerStatement(
  customerId: string,
  opts?: StatementOpts,
): Promise<Statement | Blob> {
  if (opts?.format === 'pdf') {
    return api
      .get(`/api/statements/customer/${customerId}`, {
        params: { format: 'pdf' },
        responseType: 'blob',
      })
      .then((r) => r.data as Blob);
  }
  return api.get(`/api/statements/customer/${customerId}`).then((r) => r.data as Statement);
}
