import { useMemo, useState } from 'react';
import { Loader2, Pencil, Trash2, Plus, Send } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { Separator } from '@/components/ui/separator';
import { useUsers, useDeactivateUser, useSendInvite, type UserRow } from '@/lib/api/users';
import { StaffFormDialog } from './StaffFormDialog';
import { useConfirm } from '@/hooks/useConfirm';

const ROLE_LABEL: Record<string, string> = {
  ADMIN: 'Admin',
  SALES: 'Sales',
  DISPATCHER: 'Dispatcher',
  TECHNICIAN: 'Technician',
};

export function StaffSection({ canEdit }: { canEdit: boolean }) {
  const { confirm, confirmDialog } = useConfirm();
  const { data: users, isLoading } = useUsers();
  const deactivate = useDeactivateUser();
  const sendInvite = useSendInvite();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<UserRow | null>(null);

  const active = useMemo(() => (users ?? []).filter((u) => u.is_active), [users]);

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (u: UserRow) => {
    setEditing(u);
    setFormOpen(true);
  };

  const onDelete = async (u: UserRow) => {
    // The old prompt packed both halves into one string separated by blank lines; the dialog has
    // real title/description slots, so the second half becomes the description verbatim.
    const ok = await confirm({
      title: `Remove ${u.first_name} ${u.last_name}?`,
      description: "They'll no longer appear in assignment dropdowns. Existing assignments are kept.",
      confirmLabel: 'Remove',
      tone: 'danger',
    });
    if (ok) deactivate.mutate(u.id);
  };

  return (
    <div className="bg-surface-light rounded-xl p-6 shadow-card border border-border space-y-4">
      <div className="flex items-center justify-between">
        <Heading level={2} scale="lg">Users</Heading>
        {canEdit && (
          <Button size="sm" onClick={openCreate}>
            <Plus className="h-4 w-4 mr-1" />
            Invite User
          </Button>
        )}
      </div>
      <Separator />
      <p className="text-xs text-text-secondary">
        Invite technicians, sales reps, dispatchers, or admins. Each person gets an
        email to set a password — or they can sign in with Google using that address.
      </p>

      {isLoading ? (
        <Loader2 className="h-4 w-4 animate-spin text-text-secondary" />
      ) : active.length === 0 ? (
        <p className="text-sm text-text-secondary italic">No staff yet.</p>
      ) : (
        <div className="divide-y divide-border">
          {active.map((u) => (
            <div key={u.id} className="flex items-center justify-between py-2 text-sm">
              <div className="flex-1 min-w-0">
                <div className="font-medium text-text-primary truncate flex items-center gap-2">
                  <span>{u.first_name} {u.last_name}</span>
                  {u.has_login && (
                    <span className="text-[10px] uppercase tracking-wide bg-info-surface text-info-text px-1.5 py-0.5 rounded">
                      Login
                    </span>
                  )}
                </div>
                <div className="text-xs text-text-secondary truncate">{u.email}</div>
              </div>
              <div className="flex items-center gap-4 text-xs text-text-secondary shrink-0">
                <span className="w-20 text-right">{ROLE_LABEL[u.role] ?? u.role}</span>
                <span className="w-32 text-right truncate">{u.department?.name ?? '—'}</span>
                {canEdit && (
                  <div className="flex items-center gap-2">
                    {!u.has_login && (
                      <button
                        type="button"
                        onClick={() => void sendInvite.mutateAsync(u.id)}
                        disabled={sendInvite.isPending}
                        className="text-primary hover:text-primary-light disabled:opacity-50"
                        aria-label="Send invite"
                        title="Send invite — emails a set-password link; they can also sign in with Google"
                      >
                        <Send className="h-4 w-4" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => openEdit(u)}
                      className="text-text-secondary hover:text-text-primary"
                      aria-label="Edit"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(u)}
                      className="text-text-secondary hover:text-danger"
                      aria-label="Delete"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <StaffFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        mode={editing ? 'edit' : 'create'}
        initial={editing}
      />
      {confirmDialog}
    </div>
  );
}
