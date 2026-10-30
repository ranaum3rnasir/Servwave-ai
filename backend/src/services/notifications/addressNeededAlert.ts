/**
 * addressNeededAlert.ts - the "address needed" bell (Roles & Permissions, PRD 10, S10.3).
 *
 * A user mailbox created without an address (the user's first.last was already taken, or they have no usable name)
 * rings the new user and, once, every ACTIVE Admin (setting a user's address is user management, the Admin flag's alone since
 * AL-18), never found by a role name. The two get different words, so they go out as two alerts. Each is keyed to the mailbox, so a repeated
 * call writes nothing more. In-app only.
 *
 * Called after the transaction that made the user and the mailbox has committed, never inside it: the alert writer
 * reads the database client of its own. Fire-and-forget: a failure is logged and never reaches the create that landed.
 * The creating admin is not dropped from the list (no actor is passed): they did not know the name was taken.
 */

import { logger } from '../../lib/logger';
import { activeAdmins } from '../../lib/permissions/switchHolders';
import { emit } from './notificationService';

/** Where each bell opens: the new user's own mail page, the Users page for the people who set the address. */
const EMAIL_PAGE_PATH = '/communication/inbox';
const USERS_PAGE_PATH = '/settings/users';

export async function alertAddressNeeded(args: {
  organizationId: string;
  userId: string;
  userName: string;
  mailboxId: string;
}): Promise<void> {
  try {
    const { organizationId, userId, userName, mailboxId } = args;
    await emit({
      verb: 'mailbox.address_needed',
      organizationId,
      actorId: null,
      object: { type: 'USER', id: userId, label: userName },
      entity: { recipient_ids: [userId] },
      data: { link_path: EMAIL_PAGE_PATH },
      dedupKey: `mailbox.address_needed:${mailboxId}`,
    });

    const holders = (await activeAdmins(organizationId)).filter((id) => id !== userId);
    if (!holders.length) return;
    await emit({
      verb: 'mailbox.address_needed_admin',
      organizationId,
      actorId: null,
      object: { type: 'USER', id: userId, label: userName },
      entity: { recipient_ids: holders },
      data: { user_name: userName, link_path: USERS_PAGE_PATH },
      dedupKey: `mailbox.address_needed_admin:${mailboxId}`,
    });
  } catch (err) {
    logger.warn('[addressNeededAlert] could not send the address needed alert', {
      userId: args.userId, error: err instanceof Error ? err.message : String(err),
    });
  }
}
