import type { Grant } from './defineAbility';

/**
 * The grants that belong to no switch (Roles & Permissions, PRD 1, M1 "Fixed, not switches").
 *
 * Two kinds, and nothing else: anything else the server checks is emitted by exactly one switch in the catalog
 * (`switches/catalog.ts`), and a test fails when a route checks a grant that neither a switch nor this module
 * accounts for.
 *
 * FIXED_GRANTS - held by every signed-in person, because the product cannot work without them and they expose no
 * one else's records: reading one's own notifications, and the reference data a form needs to fill itself in (the
 * company's name and preferences, tax rates, tags, task categories, the app's settings). A person with no switches
 * on still holds them, and no role, person or switch can take them away.
 *
 * ADMIN_BOX_ONLY - actions only the Admin box can take (built-in Admin, no custom role), which holds `manage all`.
 * No switch emits them, so no custom role, however it is set, ever holds them.
 */
// A notification is one of the person's own when they are one of its recipients.
const OWN_NOTIFICATION = { recipients: { some: { recipient_id: '{{userId}}' } } } as const;

export const FIXED_GRANTS: readonly Grant[] = [
  { action: 'read', subject: 'Organization' },
  { action: 'read', subject: 'AppSetting' },
  { action: 'read', subject: 'StateTaxRate' },
  { action: 'read', subject: 'Tag' },
  { action: 'read', subject: 'TaskCategory' },
  { action: 'read', subject: 'Notification', conditions: OWN_NOTIFICATION },
  { action: 'update', subject: 'Notification', conditions: OWN_NOTIFICATION },
  { action: 'delete', subject: 'Notification', conditions: OWN_NOTIFICATION },
];

export const ADMIN_BOX_ONLY: ReadonlyArray<{ action: string; subject: string; why: string }> = [
  { action: 'force_purge', subject: 'Customer', why: 'Erasing a customer for good is the account owner\'s alone.' },
  { action: 'anonymize', subject: 'Customer', why: 'Anonymising a customer is the account owner\'s alone.' },
  { action: 'void_approval', subject: 'Estimate', why: 'Undoing an approval that already moved money and jobs is the account owner\'s alone.' },
];
