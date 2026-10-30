import { useState, type FormEvent } from 'react';

import { refusalMessage, useSavePersonAsRole } from '@/lib/api/permissionSwitches';
import { Button } from '@/ui-kit/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/ui-kit/components/ui/dialog';
import { Input } from '@/ui-kit/components/ui/input';

import { Field } from './field';

/**
 * The Save as role dialog on a person's Permissions page: a name for the new role.
 *
 * The server makes the role from the person's saved switches, records the role they were based on as its source, and
 * moves the person onto it, so they keep every value and show no changes afterwards. Its plain reason for a refusal (a
 * name that is a built-in role's or another role's) is shown under the name, and the dialog stays open.
 */

interface SaveAsRoleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  personName: string;
}

export function SaveAsRoleDialog({ open, onOpenChange, userId, personName }: SaveAsRoleDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent intent="form" className="max-w-md">
        {/* The form is mounted only while the dialog is open, so each opening starts clean. */}
        <SaveAsRoleForm userId={userId} personName={personName} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function SaveAsRoleForm({ userId, personName, onClose }: { userId: string; personName: string; onClose: () => void }) {
  const saveAsRole = useSavePersonAsRole();
  const [name, setName] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const ready = name.trim() !== '';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || saveAsRole.isPending) return;
    setRefusal(null);
    try {
      await saveAsRole.mutateAsync({ userId, label: name.trim() });
      onClose();
    } catch (err) {
      setRefusal(refusalMessage(err, 'Could not save the role. Try again in a moment.'));
    }
  };

  return (
    <form noValidate onSubmit={(e) => void submit(e)} className="contents">
      <DialogHeader>
        <DialogTitle>Save as role</DialogTitle>
        <DialogDescription>
          Makes a role from {personName}&rsquo;s switches and moves them onto it. They keep every setting they have now.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Office manager" maxLength={100} />
        </Field>
        {refusal && (
          <p role="alert" className="text-destructive text-sm">
            {refusal}
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!ready || saveAsRole.isPending}>
          Create role
        </Button>
      </DialogFooter>
    </form>
  );
}
