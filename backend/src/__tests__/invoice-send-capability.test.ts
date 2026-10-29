import { describe, it, expect } from 'vitest';
import { USER_CAPABILITIES } from '../lib/permissions/userCapabilities';

describe('send Invoice is a grantable per-user capability', () => {
  const invoiceCaps = USER_CAPABILITIES.filter((c) => c.subject === 'Invoice');

  it('exposes send alongside create, update and record_payment', () => {
    expect(invoiceCaps.map((c) => c.action).sort())
      .toEqual(['create', 'record_payment', 'send', 'update']);
  });

  it("scopes send to the user's own jobs and implies read, exactly like create", () => {
    const create = invoiceCaps.find((c) => c.action === 'create')!;
    const send = invoiceCaps.find((c) => c.action === 'send')!;
    expect(send.ownCondition).toEqual(create.ownCondition);
    expect(send.impliesRead).toBe(true);
  });
});
