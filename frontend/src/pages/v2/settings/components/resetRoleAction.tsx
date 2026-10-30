import { useState } from 'react';
import { RotateCcw } from 'lucide-react';

import { useResetRole, type RoleSummary } from '@/lib/api/roles';
import { refusalMessage } from '@/lib/api/permissionSwitches';
import { toast } from '@/components/ui/use-toast';
import { Button } from '@/ui-kit/components/ui/button';
import { ConfirmDialog } from '@/ui-kit/components/ui/confirmDialog';

/**
 * Reset to default for the role picked on the Roles page.
 *
 * Like Rename and Archive it belongs to the role shown in the detail, not to a row of the list, so a company with a
 * hundred roles carries one control. The confirm says what the role goes back to before anything is sent: the preset of
 * the built-in role it starts from, or all off for a role made from a blank start. People on the role follow the reset,
 * except where a person holds their own value for a switch. The server's plain reason for a refusal is shown inside the confirm, and the role stays as it was.
 */

interface ResetRoleActionProps {
  role: RoleSummary;
  /** What the role resets to, from `resetTarget`. */
  target: string;
  /** The editor holds edits that were never saved: a reset replaces them with the starting values. */
  hasUnsavedEdits: boolean;
  /** Called once the role is reset, so the page can drop the edits the reset replaced. */
  onReset: () => void;
}

export function ResetRoleAction({ role, target, hasUnsavedEdits, onReset }: ResetRoleActionProps) {
  const [open, setOpen] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const resetRole = useResetRole();
  const confirmLabel = `Reset to ${target}`;

  const confirm = async () => {
    setRefusal(null);
    try {
      await resetRole.mutateAsync(role.role);
      setOpen(false);
      onReset();
      toast({ title: `${role.label} reset`, description: `Its switches are back to ${target}.` });
    } catch (err) {
      setRefusal(refusalMessage(err, 'Could not reset the role. Try again in a moment.'));
    }
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <RotateCcw />
        Reset to default
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          // Each opening asks afresh, without the last refusal.
          if (!next) setRefusal(null);
          setOpen(next);
        }}
        title={`${confirmLabel}?`}
        description={
          <>
            Every switch on {role.label} goes back to {target}. People on the role follow, except where a person holds their own value for a switch.
            {hasUnsavedEdits && ' Your unsaved changes to this role will be discarded.'}
          </>
        }
        destructive
        confirmLabel={confirmLabel}
        isPending={resetRole.isPending}
        onConfirm={() => void confirm()}
      >
        {refusal && (
          <p role="alert" className="text-destructive text-sm">
            {refusal}
          </p>
        )}
      </ConfirmDialog>
    </>
  );
}
