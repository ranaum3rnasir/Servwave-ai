import { describe, it, expect } from 'vitest';
import { resolveSpiderAlertRecipients } from '../services/notifications/spiderAlerts';
import { resolveRecipients } from '../services/notifications/resolveRecipients';

describe('Spider Alert Backend Recipient Resolution', () => {
  const roleHolders = {
    ADMIN: ['usr-admin-1', 'usr-admin-2'],
    SALES: ['usr-sales-1', 'usr-sales-2'],
    DISPATCHER: ['usr-dispatcher-1'],
    TECHNICIAN: ['usr-tech-1', 'usr-tech-2'],
  };

  const lead = {
    id: 'lead-101',
    assigned_to: 'usr-sales-owner',
    lead_number: 'LD-101',
  };

  it('sends alerts only to selected Admin roles when only Admin roles are chosen', () => {
    const recipients = resolveSpiderAlertRecipients({
      assignments: {
        adminRoles: ['ADMIN', 'SALES'],
        owner: false,
      },
      lead,
      roleHolders,
    });

    expect(recipients).toContain('usr-admin-1');
    expect(recipients).toContain('usr-admin-2');
    expect(recipients).toContain('usr-sales-1');
    expect(recipients).toContain('usr-sales-2');
    // Lead owner should NOT be included since owner is false
    expect(recipients).not.toContain('usr-sales-owner');
    // Dispatcher & Technician roles are not selected
    expect(recipients).not.toContain('usr-dispatcher-1');
    expect(recipients).not.toContain('usr-tech-1');
  });

  it('sends alerts only to the lead owner when only Owner is chosen', () => {
    const recipients = resolveSpiderAlertRecipients({
      assignments: {
        adminRoles: [],
        owner: true,
      },
      lead,
      roleHolders,
    });

    // Alert goes specifically to the owner of the lead
    expect(recipients).toEqual(['usr-sales-owner']);
    expect(recipients).not.toContain('usr-admin-1');
    expect(recipients).not.toContain('usr-sales-1');
  });

  it('sends alerts to BOTH Admin roles and the lead owner when both are selected', () => {
    const recipients = resolveSpiderAlertRecipients({
      assignments: {
        adminRoles: ['ADMIN', 'DISPATCHER'],
        owner: true,
      },
      lead,
      roleHolders,
    });

    // Contains both Admin roles + Dispatcher + Lead Owner
    expect(recipients).toContain('usr-admin-1');
    expect(recipients).toContain('usr-admin-2');
    expect(recipients).toContain('usr-dispatcher-1');
    expect(recipients).toContain('usr-sales-owner');
    expect(recipients.length).toBe(4);
  });

  it('de-duplicates recipients when the lead owner is also a member of the selected Admin role', () => {
    const leadWithOwnerInAdmin = {
      id: 'lead-102',
      assigned_to: 'usr-admin-1', // lead owner is an Admin
      lead_number: 'LD-102',
    };

    const recipients = resolveSpiderAlertRecipients({
      assignments: {
        adminRoles: ['ADMIN'],
        owner: true,
      },
      lead: leadWithOwnerInAdmin,
      roleHolders,
    });

    expect(recipients).toContain('usr-admin-1');
    expect(recipients).toContain('usr-admin-2');
    // De-duplicated: exactly 2 distinct user IDs
    expect(recipients.length).toBe(2);
  });

  it('returns empty list when neither Admin roles nor Owner is selected', () => {
    const recipients = resolveSpiderAlertRecipients({
      assignments: {
        adminRoles: [],
        owner: false,
      },
      lead,
      roleHolders,
    });

    expect(recipients).toEqual([]);
  });

  it('resolves spider.alert verb through resolveRecipients pipeline correctly', () => {
    // 1. Admin roles only
    const resAdminOnly = resolveRecipients({
      verb: 'spider.alert',
      organizationId: 'org-1',
      actorId: null,
      entity: {
        admin_roles: ['ADMIN'],
        owner: false,
        lead_owner_id: 'usr-sales-owner',
      },
      roleHolders,
    });
    expect(resAdminOnly.map(r => r.userId)).toEqual(['usr-admin-1', 'usr-admin-2']);

    // 2. Owner only
    const resOwnerOnly = resolveRecipients({
      verb: 'spider.alert',
      organizationId: 'org-1',
      actorId: null,
      entity: {
        admin_roles: [],
        owner: true,
        lead_owner_id: 'usr-sales-owner',
      },
      roleHolders,
    });
    expect(resOwnerOnly.map(r => r.userId)).toEqual(['usr-sales-owner']);

    // 3. Both Admin roles and Owner
    const resBoth = resolveRecipients({
      verb: 'spider.alert',
      organizationId: 'org-1',
      actorId: null,
      entity: {
        admin_roles: ['ADMIN', 'TECHNICIAN'],
        owner: true,
        lead_owner_id: 'usr-sales-owner',
      },
      roleHolders,
    });
    const ids = resBoth.map(r => r.userId);
    expect(ids).toContain('usr-admin-1');
    expect(ids).toContain('usr-admin-2');
    expect(ids).toContain('usr-tech-1');
    expect(ids).toContain('usr-tech-2');
    expect(ids).toContain('usr-sales-owner');
    expect(ids.length).toBe(5);
  });
});
