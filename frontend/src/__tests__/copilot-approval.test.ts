import { describe, it, expect } from 'vitest';
import { prepareAction, verifyUnchanged, hashPayload, stableStringify } from '@/components/copilot/tools/approval';

const base = {
  capabilityId: 'create_lead',
  toolName: 'create_lead',
  summary: 'Create a lead',
  detail: [{ label: 'Customer', value: 'John Doe' }],
  endpoint: { method: 'POST', path: '/api/leads' },
  payload: { service_request: 'AC not cooling', customer_id: 'c1' },
};

describe('approval hash-pin', () => {
  it('confirms an unchanged payload', () => {
    const action = prepareAction(base);
    expect(action.hash).toBeTruthy();
    expect(verifyUnchanged(action)).toBe(true);
  });

  it('detects drift (mutated payload → aborts)', () => {
    const action = prepareAction(base);
    action.payload.service_request = 'changed!';
    expect(verifyUnchanged(action)).toBe(false);
  });

  it('hash is independent of key order', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
    expect(hashPayload({ a: 1, b: [2, 3] })).toBe(hashPayload({ b: [2, 3], a: 1 }));
  });

  it('different payloads hash differently', () => {
    expect(hashPayload({ x: 1 })).not.toBe(hashPayload({ x: 2 }));
  });
});
