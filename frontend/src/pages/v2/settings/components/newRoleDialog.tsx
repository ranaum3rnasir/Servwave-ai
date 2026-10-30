import { useMemo, useState, type FormEvent } from 'react';

import { useCreateRole, type RoleSummary } from '@/lib/api/roles';
import { refusalMessage } from '@/lib/api/permissionSwitches';
import { Button } from '@/ui-kit/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/ui-kit/components/ui/dialog';
import { Input } from '@/ui-kit/components/ui/input';
import { SelectField } from '@/ui-kit/components/form/selectField';

import { Field } from './field';
import { roleOptions } from './roleOrder';

/**
 * The New role dialog: a name and a starting point.
 *
 * The starting point is any role the company has, built-in or custom, or a blank draft with every switch off. It is the
 * design system's select, so a company with a hundred roles finds one by typing part of its name, and it lists the roles
 * in the one order the role list uses. The server creates the role; its plain reason for a refusal (a name that collides
 * with a built-in or an existing role) is shown under the name.
 */

/** The blank draft's value in the picker. It starts with a character a role key cannot hold, so no role can be mistaken for it. */
const BLANK = '!blank';
const BLANK_LABEL = 'Blank (everything off)';

interface NewRoleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roles: RoleSummary[];
  /** Called with the new role's key once it is created and on the list. */
  onCreated: (role: string) => void;
}

export function NewRoleDialog({ open, onOpenChange, roles, onCreated }: NewRoleDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent intent="form" className="max-w-md">
        {/* The form is mounted only while the dialog is open, so each opening starts clean. */}
        <NewRoleForm roles={roles} onCancel={() => onOpenChange(false)} onCreated={onCreated} />
      </DialogContent>
    </Dialog>
  );
}

function NewRoleForm({ roles, onCancel, onCreated }: { roles: RoleSummary[]; onCancel: () => void; onCreated: (role: string) => void }) {
  const createRole = useCreateRole();
  const [name, setName] = useState('');
  const [start, setStart] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const options = useMemo(() => [{ value: BLANK, label: BLANK_LABEL }, ...roleOptions(roles)], [roles]);
  const ready = name.trim() !== '' && start !== '';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || createRole.isPending) return;
    setRefusal(null);
    const label = name.trim();
    try {
      const created = await createRole.mutateAsync(start === BLANK ? { label, blank: true } : { label, clone_grants_from: start });
      onCreated(created.role);
    } catch (err) {
      setRefusal(refusalMessage(err, 'Could not create the role. Try again in a moment.'));
    }
  };

  return (
    <form noValidate onSubmit={(e) => void submit(e)} className="contents">
      <DialogHeader>
        <DialogTitle>New role</DialogTitle>
        <DialogDescription>Name the role and pick what it starts from. You can change any switch afterwards.</DialogDescription>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Office manager" maxLength={100} />
        </Field>
        <Field label="Starting point">
          <SelectField
            aria-label="Starting point"
            value={start}
            onValueChange={setStart}
            options={options}
            placeholder="Choose a starting point"
            searchPlaceholder="Search starting points"
            emptyMessage="No role matches."
          />
        </Field>
        {refusal && (
          <p role="alert" className="text-destructive text-sm">
            {refusal}
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!ready || createRole.isPending}>
          Create role
        </Button>
      </DialogFooter>
    </form>
  );
}
