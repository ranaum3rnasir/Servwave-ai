import { useState, type FormEvent } from 'react';

import { useSetMailboxAddress } from '@/lib/api/users';
import { namePartProblem } from '@/lib/mailboxNamePart';
import { extractApiError } from '@/lib/utils';
import { Button } from '@/ui-kit/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/ui-kit/components/ui/dialog';
import { Input } from '@/ui-kit/components/ui/input';

import { Field } from './field';

/**
 * Set or change a person's mailbox address, from the Users & Teams row and from their Permissions page.
 *
 * The admin types only the NAME PART; the company part and the domain are fixed and shown beside the field as plain
 * text, and the server builds the address from all three. It is the address customers write to, never the email the
 * person signs in with. A name part that cannot be one is explained as it is typed, with the same rule the server
 * applies; the server's answer is the one that counts, and a taken name part (or any other refusal) is shown under the
 * field in the server's words while the dialog stays open. A change leaves the old address delivering to the same
 * mailbox, and the dialog says so.
 */

interface MailboxAddressDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  person: { id: string; name: string };
  /** "set": the person has no address yet ("Address needed"). "change": they have one. */
  mode: 'set' | 'change';
  /** Their current address, for a change. */
  currentAddress: string | null;
  /** What follows the name part: `.company@domain`. */
  suffix: string;
}

export function MailboxAddressDialog(props: MailboxAddressDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent intent="form" className="max-w-md">
        {/* Mounted only while the dialog is open, so each opening starts clean. */}
        <MailboxAddressForm {...props} onClose={() => props.onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function MailboxAddressForm({
  person, mode, currentAddress, suffix, onClose,
}: MailboxAddressDialogProps & { onClose: () => void }) {
  const setAddress = useSetMailboxAddress();
  const [namePart, setNamePart] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const problem = namePartProblem(namePart, suffix);
  const message = refusal ?? problem;
  const ready = namePart.trim() !== '' && !problem;
  const title = mode === 'set' ? 'Set address' : 'Change address';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || setAddress.isPending) return;
    setRefusal(null);
    try {
      await setAddress.mutateAsync({ id: person.id, namePart: namePart.trim().toLowerCase() });
      onClose();
    } catch (err) {
      setRefusal(extractApiError(err, 'Could not save the address. Try again in a moment.'));
    }
  };

  return (
    <form noValidate onSubmit={(e) => void submit(e)} className="contents">
      <DialogHeader>
        <DialogTitle>
          {title} for {person.name}
        </DialogTitle>
        <DialogDescription>
          {mode === 'set'
            ? `${person.name} has no email address yet. Once you set one they can send email, and customers can write to it.`
            : `Customers will write to the new address. The old address keeps delivering to ${person.name}'s mailbox.`}{' '}
          This is the address customers write to, not the email {person.name} signs in with.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-3">
        {mode === 'change' && currentAddress && (
          <p className="text-muted-foreground text-sm">
            Now: <span className="text-foreground font-medium break-all">{currentAddress}</span>
          </p>
        )}
        <Field label="Address" htmlFor="mailbox-name-part">
          <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
            <Input
              id="mailbox-name-part"
              className="min-w-0 flex-1 basis-40"
              value={namePart}
              onChange={(e) => {
                setNamePart(e.target.value);
                setRefusal(null);
              }}
              placeholder="jane.smith"
              maxLength={64}
              autoComplete="off"
              aria-invalid={message ? true : undefined}
              aria-describedby={message ? 'mailbox-name-part-error' : undefined}
            />
            <span className="text-muted-foreground text-sm break-all">{suffix}</span>
          </div>
          {message && (
            <p id="mailbox-name-part-error" role="alert" className="text-destructive mt-1 text-xs">
              {message}
            </p>
          )}
        </Field>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!ready || setAddress.isPending}>
          {mode === 'set' ? 'Set address' : 'Change address'}
        </Button>
      </DialogFooter>
    </form>
  );
}
