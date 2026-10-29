import { describe, it, expect } from 'vitest';
import { subject } from '@casl/ability';
import { defineAbilityFor } from '../defineAbility';
import { DEFAULT_GRANTS } from '../defaultGrants';

describe('Notification CASL ability', () => {
  it('SALES can read only own notification rows', () => {
    const grants = DEFAULT_GRANTS.filter(g => g.role === 'SALES' && g.subject === 'Notification');
    const ability = defineAbilityFor({ id: 'u1', role: 'SALES' } as any, grants);
    expect(ability.can('read', 'Notification')).toBe(true);
    const rule = ability.rules.find(r => r.subject === 'Notification' && r.action === 'read');
    // {{userId}} substituted into the corrected relation shape (#925).
    expect(rule?.conditions).toEqual({ recipients: { some: { recipient_id: 'u1' } } });
  });

  it('ADMIN manage all still covers Notification (admin path is hard-filtered in controller)', () => {
    const ability = defineAbilityFor({ id: 'a1', role: 'ADMIN' } as any, []);
    expect(ability.can('read', 'Notification')).toBe(true);
  });

  /**
   * #925 AC #1 — measured before/after `can('read', 'Notification', row)`. No production call
   * site ever passes a row instance (routes only call the type-level `canDo('read','Notification')`
   * middleware; notification.controller.ts scopes by hand against `notificationRecipient`), so
   * this is dormant either way. Recorded so the change is made on evidence, not assumption.
   *
   * BEFORE (`{ recipient_id: '{{userId}}' }`, pinned here — DO NOT "fix" this expectation):
   *   - a real Notification row (no `recipient_id` field) correctly evaluates to false, but for
   *     the wrong reason — the condition is comparing against a field that doesn't exist, not
   *     testing group membership. Any object that happened to carry a `recipient_id` field would
   *     match regardless of whether the current user is an actual recipient.
   *
   * AFTER (`{ recipients: { some: { recipient_id: '{{userId}}' } } }`):
   *   - correctly evaluates against the real `recipients` relation: true when the row's loaded
   *     recipients include the current user, false otherwise. No throw — unlike the nested
   *     to-one-then-to-many shapes (`Estimate.lead.lead_assignees`) enforce.ts documents as
   *     throwing "equals does not support comparison of arrays and objects"; this is a single-hop
   *     to-many, which @casl/prisma's instance matcher does support directly.
   */
  it('BEFORE (historical shape, pinned — not the live grant): denies a real row, but by accident', () => {
    const historicalGrant = [{ role: 'SALES', action: 'read', subject: 'Notification', conditions: { recipient_id: '{{userId}}' } }];
    const ability = defineAbilityFor({ id: 'u1', role: 'SALES' } as any, historicalGrant as any);

    // A real Notification row has no `recipient_id` field, so the comparison is against
    // `undefined` and denies — correctly, but not because it checked ownership.
    const realRow = subject('Notification', { id: 'n1', recipients: [{ id: 'r1', recipient_id: 'u1' }] });
    expect(ability.can('read', realRow as any)).toBe(false);

    // Proves the denial above was coincidental, not ownership-aware: any object that happens
    // to carry a bare `recipient_id` field matches, whether or not it is actually this user's.
    const coincidentalMatch = subject('Notification', { id: 'n2', recipient_id: 'u1' });
    expect(ability.can('read', coincidentalMatch as any)).toBe(true);
  });

  it('AFTER (live grant): instance-level check against a realistically-shaped Notification row', () => {
    const grants = DEFAULT_GRANTS.filter(g => g.role === 'SALES' && g.subject === 'Notification');
    const ability = defineAbilityFor({ id: 'u1', role: 'SALES' } as any, grants);

    const own = subject('Notification', {
      id: 'n1',
      recipients: [{ id: 'r1', recipient_id: 'u1' }],
    });
    const notOwn = subject('Notification', {
      id: 'n2',
      recipients: [{ id: 'r2', recipient_id: 'someone-else' }],
    });

    expect(ability.can('read', own as any)).toBe(true);
    expect(ability.can('read', notOwn as any)).toBe(false);
  });
});
