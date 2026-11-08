import { describe, it, expect } from 'vitest';
import {
  runWithOrg,
  runUnscoped,
  getTenantContext,
  tenantConfigValues,
} from '../lib/tenant-context';

describe('tenant-context', () => {
  it('has no context by default → fail-closed config values', () => {
    expect(getTenantContext()).toBeUndefined();
    expect(tenantConfigValues()).toEqual({ orgId: '', bypass: '' });
  });

  it('runWithOrg scopes to the org and leaves bypass off', () => {
    runWithOrg('org-1', () => {
      expect(getTenantContext()).toEqual({ orgId: 'org-1', unscoped: false });
      expect(tenantConfigValues()).toEqual({ orgId: 'org-1', bypass: '' });
    });
  });

  it('runUnscoped sets the controlled bypass flag', () => {
    runUnscoped(() => {
      expect(tenantConfigValues()).toEqual({ orgId: '', bypass: 'on' });
    });
  });

  it('context does not leak outside the run scope', () => {
    runWithOrg('org-1', () => {
      /* inside */
    });
    expect(getTenantContext()).toBeUndefined();
  });

  it('a nested runUnscoped overrides an outer org scope, then restores it', () => {
    runWithOrg('org-1', () => {
      runUnscoped(() => {
        expect(tenantConfigValues()).toEqual({ orgId: '', bypass: 'on' });
      });
      expect(tenantConfigValues()).toEqual({ orgId: 'org-1', bypass: '' });
    });
  });
});
