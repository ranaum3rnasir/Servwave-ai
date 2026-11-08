import { describe, it, expect } from 'vitest';
import { PERMISSION_CATALOG } from '../lib/permissions/catalog';
import { USER_CAPABILITIES } from '../lib/permissions/userCapabilities';

// Scheduling-notifications slice 07: the milestone reads "on the way" everywhere a user sees it.
// The permission KEY stays `en_route Job` (routes, grants and conditions are keyed on it); only
// the words the roles editor and the per-user Permissions page show change.
describe('permission vocabulary - the on-the-way verb', () => {
  it('describes `en_route Job` as "Mark on the way" in the catalog', () => {
    const entry = PERMISSION_CATALOG.find((e) => e.action === 'en_route' && e.subject === 'Job');
    expect(entry?.description).toBe('Mark on the way');
  });

  it('never says "en route" in any catalog description', () => {
    for (const e of PERMISSION_CATALOG) {
      expect(e.description, `${e.action} ${e.subject}`).not.toMatch(/en[ -]route/i);
    }
  });

  it('never says "en route" in any per-user capability label or description', () => {
    for (const cap of USER_CAPABILITIES) {
      expect(cap.label, `${cap.action} ${cap.subject} label`).not.toMatch(/en[ -]route/i);
      expect(cap.description, `${cap.action} ${cap.subject} description`).not.toMatch(/en[ -]route/i);
    }
  });
});
