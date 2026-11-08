/**
 * WorkflowSettings — the Settings tab. A simple card stack: the automation
 * name (redundant with the header's inline name — fine, it's the expected
 * place to look) and the danger zone. Deleting requires an explicit confirm
 * naming the consequences, then navigates back to the list — there is nothing
 * left here to look at.
 *
 * The per-automation "When can it send?" window used to live here. It was
 * removed along with the trigger-surface copy: with the timing builder now
 * expressing send time concretely (N before/after a date), a second, separate
 * "but only during these hours" rule was a hidden qualifier on every sentence
 * the builder renders. Nothing replaced it — automations send when their
 * timing says they send. `send_window` survives in the DB/API for old rows
 * (and `enrollment.ts` still honours whatever a published version froze), but
 * nothing in the app writes it any more, and every recipe ships `ANYTIME`.
 *
 * Quiet hours must come back as ONE org-level setting before SMS unlocks
 * (#743) — a 2am email is harmless, a 2am text is not.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Heading } from '@/components/ui/heading';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useDeleteWorkflow } from '@/lib/api/workflows';

export interface WorkflowSettingsProps {
  id: string | undefined;
  name: string;
  onSetName: (name: string) => void;
}

export default function WorkflowSettings({ id, name, onSetName }: WorkflowSettingsProps) {
  const navigate = useNavigate();
  const remove = useDeleteWorkflow();
  const [confirmOpen, setConfirmOpen] = useState(false);

  function handleDelete() {
    if (!id) return;
    remove.mutate(id, { onSuccess: () => navigate('/automations') });
  }

  return (
    <div className="max-w-xl space-y-4">
      <section className="space-y-3 rounded-card border border-border bg-surface-light p-5 shadow-card">
        <div>
          <Label tone="strong" htmlFor="settings-name" className="mb-1.5 block text-sm font-semibold">
            Automation name
          </Label>
          <Input
            id="settings-name"
            aria-label="Automation name (Settings)"
            value={name}
            maxLength={120}
            onChange={(e) => onSetName(e.target.value)}
            placeholder="Name this automation"
          />
        </div>
      </section>

      <section className="space-y-2 rounded-card border border-danger/20 bg-danger/5 p-5">
        <Heading level={3} scale="sm" weight="semibold">Danger zone</Heading>
        <p className="text-xs leading-relaxed text-text-secondary">
          Deleting removes this automation for everyone in your organization.
        </p>
        <Button
          type="button"
          variant="outline" tone="danger"
          disabled={!id}
          onClick={() => setConfirmOpen(true)}
        >
          <Trash2 className="mr-1.5 h-4 w-4" aria-hidden />
          Delete this automation
        </Button>
      </section>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete &quot;{name}&quot;?</DialogTitle>
            <DialogDescription>Its activity history is removed too. This can't be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button variant="solid" tone="danger" disabled={remove.isPending} onClick={handleDelete}>
              <Trash2 className="mr-1.5 h-4 w-4" aria-hidden />
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
