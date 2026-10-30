import { useMemo, useState } from 'react';

import { SelectField } from '@/components/form/SelectField';
import { useAuthStore } from '@/stores/auth.store';
import { useDeactivationSummary, type ReassignModuleKey, type UserRow } from '@/lib/api/users';
import { Button } from '@/ui-kit/components/ui/button';
import { Dialog, DialogContent, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/ui-kit/components/ui/dialog';

import { Field } from './field';
import { MAIN_MAILBOX_VALUE, MailboxHandoverPicker } from './mailboxHandoverPicker';

export const LEAVE_AS_THEY_ARE = 'leave';

/** The open records an Admin chose to move to someone else when deactivating, if any. */
export interface ReassignChoice {
  toUserId: string;
  modules: ReassignModuleKey[];
}

/**
 * The deactivate confirmation on Users & Teams.
 *
 * With the Email plan feature on it also asks who should get the leaver's email (PRD 10): "Main mailbox" (the default) or
 * any other active person, through the picker the later move uses too (`MailboxHandoverPicker`). The choice is sent as
 * "main" or the person's id; the server hands the mailbox over in the same write that deactivates, and the mail is kept
 * either way.
 *
 * Deactivating changes no record (P19): the person's name stays on everything and is marked Deactivated. The dialog says how
 * many open tasks, leads and jobs still name them and, for an Admin, offers to move those to someone else first. Leaving them
 * as they are is the default.
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
  /**
   * `handoverTo` is "main" or a person's id; undefined when the picker is not shown (the server then uses the main mailbox).
   * `reassign` is set only when an Admin chose someone to take over the person's open records.
   */
  onConfirm: (handoverTo: string | undefined, reassign?: ReassignChoice) => void;
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
  const [heir, setHeir] = useState(LEAVE_AS_THEY_ARE);
  const isAdmin = useAuthStore((s) => s.user?.is_admin === true);
  const { data: summary } = useDeactivationSummary(person.id);
  const open = summary?.modules?.filter((m) => m.open > 0) ?? [];
  const heirOptions = useMemo(
    () => [
      { value: LEAVE_AS_THEY_ARE, label: 'Leave them as they are' },
      ...people
        .filter((p) => p.is_active && p.id !== person.id)
        .map((p) => ({ value: p.id, label: `${p.first_name} ${p.last_name}`.trim() }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    ],
    [people, person.id],
  );
  const confirm = () =>
    onConfirm(
      showMailboxChoice ? target : undefined,
      heir !== LEAVE_AS_THEY_ARE && open.length > 0 ? { toUserId: heir, modules: open.map((m) => m.key) } : undefined,
    );

  return (
    <>
      <DialogHeader>
        <DialogTitle>Deactivate {person.first_name} {person.last_name}?</DialogTitle>
        <DialogDescription>
          They&rsquo;ll be signed out and their login removed - reactivating later won&rsquo;t restore it, you&rsquo;ll need to
          re-invite them. Their account and history are kept, and they&rsquo;re removed from new assignments.
        </DialogDescription>
      </DialogHeader>
      {(showMailboxChoice || open.length > 0) && (
        <DialogBody>
          {open.length > 0 && (
            <div className="space-y-3">
              <p role="status" className="text-sm">
                {person.first_name} still has {open.map((m) => `${m.open} open ${(m.open === 1 ? m.label.slice(0, -1) : m.label).toLowerCase()}`).join(', ')}. Their name stays on
                them, marked Deactivated.
              </p>
              {isAdmin && (
                <Field label="Move their open records to">
                  <SelectField value={heir} onValueChange={setHeir} options={heirOptions} />
                </Field>
              )}
            </div>
          )}
          {showMailboxChoice && <MailboxHandoverPicker person={person} people={people} value={target} onValueChange={setTarget} />}
        </DialogBody>
      )}
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="destructive" onClick={confirm} disabled={pending}>
          Deactivate
        </Button>
      </DialogFooter>
    </>
  );
}
