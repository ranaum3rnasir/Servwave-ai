import { useState } from 'react';

import type { UserRow } from '@/lib/api/users';
import { Button } from '@/ui-kit/components/ui/button';
import { Dialog, DialogContent, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/ui-kit/components/ui/dialog';

import { MAIN_MAILBOX_VALUE, MailboxHandoverPicker } from './mailboxHandoverPicker';

/**
 * The deactivate confirmation on Users & Teams.
 *
 * With the Email plan feature on it also asks who should get the leaver's email (PRD 10): "Main mailbox" (the default) or
 * any other active person, through the picker the later move uses too (`MailboxHandoverPicker`). The choice is sent as
 * "main" or the person's id; the server hands the mailbox over in the same write that deactivates, and the mail is kept
 * either way.
 */

interface DeactivateUserDialogProps {
  /** The person being deactivated; the dialog is open while this is set. */
  person: UserRow | null;
  /** Everyone on the Users page: the picker offers the active ones other than the person leaving. */
  people: UserRow[];
  /** The Email plan feature: without it there are no mailboxes to speak of and the picker is left out. */
  showMailboxChoice: boolean;
  pending: boolean;
  onCancel: () => void;
  /** `handoverTo` is "main" or a person's id; undefined when the picker is not shown (the server then uses the main mailbox). */
  onConfirm: (handoverTo: string | undefined) => void;
}

export function DeactivateUserDialog(props: DeactivateUserDialogProps) {
  const { person, onCancel } = props;
  return (
    <Dialog open={person !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent intent="form">
        {/* Mounted per person, so each opening starts on "Main mailbox". */}
        {person && <DeactivateUserForm key={person.id} {...props} person={person} />}
      </DialogContent>
    </Dialog>
  );
}

function DeactivateUserForm({
  person, people, showMailboxChoice, pending, onCancel, onConfirm,
}: DeactivateUserDialogProps & { person: UserRow }) {
  const [target, setTarget] = useState(MAIN_MAILBOX_VALUE);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Deactivate {person.first_name} {person.last_name}?</DialogTitle>
        <DialogDescription>
          They&rsquo;ll be signed out and their login removed - reactivating later won&rsquo;t restore it, you&rsquo;ll need to
          re-invite them. Their account and history are kept, and they&rsquo;re removed from new assignments.
        </DialogDescription>
      </DialogHeader>
      {showMailboxChoice && (
        <DialogBody>
          <MailboxHandoverPicker person={person} people={people} value={target} onValueChange={setTarget} />
        </DialogBody>
      )}
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="destructive" onClick={() => onConfirm(showMailboxChoice ? target : undefined)} disabled={pending}>
          Deactivate
        </Button>
      </DialogFooter>
    </>
  );
}
