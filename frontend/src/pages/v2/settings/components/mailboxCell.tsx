import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { cn } from '@/ui-kit/lib/utils';
import { CANT_READ_PERSON_MARK } from '@/lib/api/permissionSwitches';
import type { UserRow } from '@/lib/api/users';
import { CopyAddressButton } from '@/components/communication/MyMailboxAddress';

import { ADDRESS_NEEDED_MARK, showsCantRead } from './mailboxMarks';

/** The mark for a person whose own switches close the Email page to them. */
export function CantReadMark() {
  return (
    <Badge variant="softAmber" size="sm" className="h-auto whitespace-normal">
      {CANT_READ_PERSON_MARK}
    </Badge>
  );
}

/**
 * The Email column of the Users & Teams row (PRD 10). It shows the person's mailbox address, the one customers write
 * to and never the email they sign in with, with Copy and, for an Admin, "Change address". A person
 * with no address is marked "Address needed" with "Set address". A person whose own switches close the Email page is
 * marked "Can't read: Email page is off for this person" beside it.
 *
 * A deactivated person whose mailbox was handed on also says where it is now ("With Jane Smith", "In the main mailbox").
 *
 * In the table the address truncates with the whole of it in a title; on a phone card it wraps under the name instead.
 */
export function MailboxCell({
  user,
  onEdit,
  editOffReason,
  wrap = false,
}: {
  user: UserRow;
  /** Present for an Admin: opens the set or change dialog. */
  onEdit?: (mode: 'set' | 'change') => void;
  /** Why the set or change is off for this viewer (an Admin's mailbox is the Owner's to change, ticket 26). */
  editOffReason?: string;
  wrap?: boolean;
}) {
  const mailbox = user.mailbox;
  const name = `${user.first_name} ${user.last_name}`;
  const canEdit = !!onEdit && !!mailbox?.address_suffix;
  const closed = showsCantRead(user);
  const handover = user.mailbox_handover;
  if (!mailbox && !closed && !handover) return <span className="text-muted-foreground">-</span>;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      {mailbox?.address ? (
        <>
          <span
            title={mailbox.address}
            className={cn('text-muted-foreground min-w-0', wrap ? 'break-all' : 'max-w-[15rem] truncate')}
          >
            {mailbox.address}
          </span>
          <CopyAddressButton address={mailbox.address} label={`Copy address for ${name}`} />
          {canEdit && (
            <Button type="button" variant="ghost" size="sm" disabled={!!editOffReason} disabledReason={editOffReason} onClick={() => onEdit!('change')}>
              Change address
            </Button>
          )}
        </>
      ) : mailbox?.status === 'address_needed' ? (
        <>
          <Badge variant="softAmber" size="sm">
            {ADDRESS_NEEDED_MARK}
          </Badge>
          {canEdit && (
            <Button type="button" variant="ghost" size="sm" disabled={!!editOffReason} disabledReason={editOffReason} onClick={() => onEdit!('set')}>
              Set address
            </Button>
          )}
        </>
      ) : null}
      {closed && <CantReadMark />}
      {/* A leaver's email did not vanish: it sits with a person or in the main mailbox (PRD 10, S10.22). */}
      {handover && (
        <span className="text-muted-foreground basis-full text-xs">
          {handover.to === 'person' ? `With ${handover.name}` : 'In the main mailbox'}
        </span>
      )}
    </div>
  );
}
