/* =============================================================================
   Payments go-live slice 09 - the demo seed's wipe deletes disputes before payments.

   A dispute names its invoice and its payment, both ON DELETE RESTRICT, so a wipe that deletes
   payments first fails as soon as the demo org holds one dispute. The seed is a staging-only
   script that runs on import (it refuses without SEED_DEMO_ALPHA and a demo org full of users), so
   its FK-safe wipe order is read from the source: the dispute delete must come before the payment
   delete, and the refund delete (which also names the payment).
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const source = readFileSync(join(__dirname, '..', 'seed-demo-org.ts'), 'utf8');

describe('seed-demo-org wipe order', () => {
  it('deletes the org\'s disputes before its payments', () => {
    const dispute = source.indexOf('prisma.dispute.deleteMany(');
    const payment = source.indexOf('prisma.payment.deleteMany(');
    expect(dispute).toBeGreaterThan(-1);
    expect(payment).toBeGreaterThan(-1);
    expect(dispute).toBeLessThan(payment);
  });
});
