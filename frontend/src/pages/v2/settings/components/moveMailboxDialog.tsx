import { useState } from 'react';

import type { UserRow } from '@/lib/api/users';
import { Button } from '@/ui-kit/components/ui/button';
import { Dialog, DialogContent, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/ui-kit/components/ui/dialog';

import { MAIN_MAILBOX_VALUE, MailboxHandoverPicker } from './mailboxHandoverPicker';

/**
 * Move a leaver's mailbox on later (PRD 10, S10.22): to another person or to the main mailbox, from their row on Users &
 * Teams. The same picker as the deactivate dialog, starting on where the mailbox is now, so Move stays off until a
 * different answer is picked. The server carries the conversations and the addresses along and the previous holder loses
 * the mailbox on their next request.
 */

interface MoveMailboxDialogProps {
  /** The deactivated person whose mailbox moves; the dialog is open while this is set. */
  person: UserRow | null;
  people: UserRow[];
  pending: boolean;
  onCancel: () => void;
  /** `handoverTo` is "main" or a person's id. */
  onConfirm: (handoverTo: string) => void;
}

/** Where the mailbox is now, in the picker's own terms. */
const currentTarget = (person: UserRow): string =>
  person.mailbox_handover?.to === 'person' ? person.mailbox_handover.user_id : MAIN_MAILBOX_VALUE;

export function MoveMailboxDialog(props: MoveMailboxDialogProps) {
  const { person, onCancel } = props;
  return (
    <Dialog open={person !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent intent="form">
        {/* Mounted per person, so each opening starts on where the mailbox is now. */}
        {person && <MoveMailboxForm key={person.id} {...props} person={person} />}
      </DialogContent>
    </Dialog>
  );
}

function MoveMailboxForm({
  person, people, pending, onCancel, onConfirm,
}: MoveMailboxDialogProps & { person: UserRow }) {
  const now = currentTarget(person);
  const [target, setTarget] = useState(now);
  return (
    <>
      <DialogHeader>
        <DialogTitle>Move {person.first_name} {person.last_name}&rsquo;s mailbox</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <MailboxHandoverPicker person={person} people={people} value={target} onValueChange={setTarget} />
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={() => onConfirm(target)} disabled={pending || target === now}>
          Move mailbox
        </Button>
      </DialogFooter>
    </>
  );
}
