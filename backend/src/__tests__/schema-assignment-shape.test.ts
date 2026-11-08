import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SQL = readFileSync(
  join(__dirname, '../../prisma/migrations/20260610120000_assignment_m2m_additive/migration.sql'),
  'utf8',
);

describe('assignment M2M additive migration', () => {
  it('creates all three join tables idempotently', () => {
    for (const t of ['job_assignees', 'lead_assignees', 'lead_walkthrough_performers']) {
      expect(SQL).toContain(`CREATE TABLE IF NOT EXISTS "${t}"`);
    }
  });
  it('adds commission_owner_id + both email-sent flags + the 3 org defaults, all guarded', () => {
    expect(SQL).toContain('ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "commission_owner_id"');
    expect(SQL).toContain('ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "customer_scheduled_email_sent_at"');
    expect(SQL).toContain('ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "walkthrough_customer_email_sent_at"');
    expect(SQL).toContain('ADD COLUMN IF NOT EXISTS "default_job_duration_min"');
  });
  it('contains NO destructive DROP of the legacy FK columns (those live in the later drop migration)', () => {
    expect(SQL).not.toMatch(/DROP COLUMN[^;]*assigned_to/i);
  });
});
