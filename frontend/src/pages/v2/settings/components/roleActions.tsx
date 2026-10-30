import { useState, type FormEvent } from 'react';
import { Archive, Pencil } from 'lucide-react';

import { useArchiveRole, useRenameRole, type RoleSummary } from '@/lib/api/roles';
import { refusalMessage } from '@/lib/api/permissionSwitches';
import { Button } from '@/ui-kit/components/ui/button';
import { ConfirmDialog } from '@/ui-kit/components/ui/confirmDialog';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/ui-kit/components/ui/dialog';
import { Input } from '@/ui-kit/components/ui/input';

import { Field } from './field';

/**
 * Rename and Archive for the custom role picked on the Roles page.
 *
 * They belong to the role shown in the detail, not to a row of the list: a company can hold a hundred roles, and the
 * detail is on screen at every width (the list is a side column from xl and a picker below it). Built-in roles never
 * get them - the page does not draw this for a role whose type is not custom. The server's plain reason for a refusal (a
 * name that is a built-in role's or another role's; people still on the role) is shown inside the dialog that asked, and
 * the role stays as it was.
 */

interface RoleActionsProps {
  role: RoleSummary;
  /** Called once the role is archived and gone from the list, so the page can leave it. */
  onArchived: () => void;
}

export function RoleActions({ role, onArchived }: RoleActionsProps) {
  const [renaming, setRenaming] = useState(false);
  const [archiving, setArchiving] = useState(false);
  return (
    <div className="contents">
      <Button variant="outline" size="sm" onClick={() => setRenaming(true)}>
        <Pencil />
        Rename
      </Button>
      <Button variant="outline" size="sm" onClick={() => setArchiving(true)}>
        <Archive />
        Archive
      </Button>
      <RenameRoleDialog open={renaming} onOpenChange={setRenaming} role={role} />
      <ArchiveRoleDialog open={archiving} onOpenChange={setArchiving} role={role} onArchived={onArchived} />
    </div>
  );
}

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  role: RoleSummary;
}

function RenameRoleDialog({ open, onOpenChange, role }: DialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent intent="form" className="max-w-md">
        {/* Mounted only while open, so each opening starts from the role's saved name and description. */}
        <RenameRoleForm role={role} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function RenameRoleForm({ role, onClose }: { role: RoleSummary; onClose: () => void }) {
  const renameRole = useRenameRole();
  const [name, setName] = useState(role.label);
  const [description, setDescription] = useState(role.description ?? '');
  const [refusal, setRefusal] = useState<string | null>(null);
  const changed = name.trim() !== role.label || description !== (role.description ?? '');
  const ready = name.trim() !== '' && changed;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || renameRole.isPending) return;
    setRefusal(null);
    try {
      await renameRole.mutateAsync({ role: role.role, label: name.trim(), description });
      onClose();
    } catch (err) {
      setRefusal(refusalMessage(err, 'Could not rename the role. Try again in a moment.'));
    }
  };

  return (
    <form noValidate onSubmit={(e) => void submit(e)} className="contents">
      <DialogHeader>
        <DialogTitle>Rename role</DialogTitle>
        <DialogDescription>People on the role and the role&rsquo;s switches stay as they are.</DialogDescription>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
        </Field>
        <Field label="Description">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
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
        <Button type="submit" disabled={!ready || renameRole.isPending}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}

function ArchiveRoleDialog({ open, onOpenChange, role, onArchived }: DialogProps & { onArchived: () => void }) {
  const archiveRole = useArchiveRole();
  const [refusal, setRefusal] = useState<string | null>(null);

  const confirm = async () => {
    setRefusal(null);
    try {
      await archiveRole.mutateAsync(role.role);
      onOpenChange(false);
      onArchived();
    } catch (err) {
      setRefusal(refusalMessage(err, 'Could not archive the role. Try again in a moment.'));
    }
  };

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        // Each opening asks afresh, without the last refusal.
        if (!next) setRefusal(null);
        onOpenChange(next);
      }}
      title={`Archive ${role.label}?`}
      description="It leaves the list of roles and can no longer be given to anyone. A role with people on it cannot be archived."
      destructive
      confirmLabel="Archive role"
      isPending={archiveRole.isPending}
      onConfirm={() => void confirm()}
    >
      {refusal && (
        <p role="alert" className="text-destructive text-sm">
          {refusal}
        </p>
      )}
    </ConfirmDialog>
  );
}
