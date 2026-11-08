import { describe, it, expect } from 'vitest';
import { putRolePermissionsSchema } from '../controllers/role.controller';

// F-47 — the role-permission PUT body must be a proper object so a malformed payload is a
// 400 at the validation layer, not a 500 deep inside viewModelToGrants.
describe('F-47 role-permission body validation', () => {
  it('rejects an array body', () => {
    expect(putRolePermissionsSchema.safeParse([1, 2, 3]).success).toBe(false);
  });

  it('rejects a string body', () => {
    expect(putRolePermissionsSchema.safeParse('nope').success).toBe(false);
  });

  it('rejects a number body', () => {
    expect(putRolePermissionsSchema.safeParse(42).success).toBe(false);
  });

  it('accepts a permissions surface object', () => {
    expect(putRolePermissionsSchema.safeParse({ Estimate: { read: true, update: false } }).success).toBe(true);
  });

  it('accepts an empty object', () => {
    expect(putRolePermissionsSchema.safeParse({}).success).toBe(true);
  });
});
