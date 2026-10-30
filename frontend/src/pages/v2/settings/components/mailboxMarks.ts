import type { UserRow } from '@/lib/api/users';

/** What a person with no address is marked, on their row and in their Permissions page header. */
export const ADDRESS_NEEDED_MARK = 'Address needed';

/**
 * Whether a person is marked "Can't read": the server says their own switches close the Email page to them, and it
 * matters (they have a mailbox, or they are an active person who should have one). A deactivated person with no
 * mailbox is not marked.
 */
export function showsCantRead(user: Pick<UserRow, 'email_page_closed' | 'mailbox' | 'is_active'>): boolean {
  return !!user.email_page_closed && (!!user.mailbox || user.is_active);
}
