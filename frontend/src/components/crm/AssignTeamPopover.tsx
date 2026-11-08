import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { EmptyState } from '@/components/ui/empty-state';
import { useAssignableUsers, type AssignableUser, type AssigneePurpose } from '@/lib/api/users';
import { cn, extractApiError, getInitials } from '@/lib/utils';

function titleCase(str?: string | null): string {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

function subtitleOf(user: AssignableUser): string {
  return [user.department?.name, titleCase(user.role)].filter(Boolean).join(' ');
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type NotifyChannel = 'in_app' | 'email';

interface AssignTeamPopoverProps {
  /** single → exactly one pick (lead owner); multi → checkbox crew replace. */
  mode: 'single' | 'multi';
  /** Selection seeded each time the popover opens. */
  initialSelected: string[];
  /** Which notify toggles to offer (all default-checked). SMS is always shown disabled. */
  channels: NotifyChannel[];
  onAssign: (ids: string[], notify: { in_app: boolean; email?: boolean }) => Promise<void>;
  /**
   * Which roster this popover is asking for, and therefore which grant scopes it.
   *
   * Shared component, two very different writes. `AssignLeadPopover` sets the lead's OWNER
   * through `POST /api/leads/:id/assign`, which never consults the assignee pool - so it is a
   * `directory` list, scoped by `read User`. `AssignJobCrewPopover` sets job CREW, which the
   * pool does govern, so it asks for `jobCrew`. Getting this wrong is silent: the list simply
   * narrows, and the API goes on accepting people the picker stopped offering.
   */
  purpose: AssigneePurpose;
  /** The anchor button — the panel drops down anchored to it (no overlay). */
  trigger: ReactNode;
  disabled?: boolean;
  /** Optional controlled open state (for menu-item-launched flows). Uncontrolled when omitted. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

const CHANNEL_LABELS: Record<NotifyChannel, string> = {
  in_app: 'In app',
  email: 'By email',
};

/**
 * Workiz-style anchored team-member dropdown (#361): search + avatar rows +
 * notify-channel toggles. Deliberately NO eligibleFor param and NO client-side
 * role filtering — the server pool (GET /api/users/assignable, widened to all
 * active users by #366) is the single source of truth; server eligibility
 * (validateCrew / isOwnerEligible) stays the enforcement point.
 */
export function AssignTeamPopover({
  mode,
  initialSelected,
  channels,
  onAssign,
  purpose,
  trigger,
  disabled,
  open: controlledOpen,
  onOpenChange,
}: AssignTeamPopoverProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [notifyOn, setNotifyOn] = useState<Record<NotifyChannel, boolean>>({ in_app: true, email: true });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: users = [] } = useAssignableUsers({ purpose, enabled: open });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => `${u.first_name} ${u.last_name}`.toLowerCase().includes(q));
  }, [users, search]);

  const handleOpenChange = (next: boolean) => {
    if (controlledOpen === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  // Seed selection + reset transient state each time the popover opens — keyed on
  // the DERIVED open so it runs in both controlled and uncontrolled modes.
  useEffect(() => {
    if (open) {
      setSelected(initialSelected);
      setSearch('');
      setNotifyOn({ in_app: true, email: true });
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed on open-edge only; initialSelected is a fresh array literal each parent render
  }, [open]);

  const toggle = (id: string) => {
    if (mode === 'single') {
      setSelected([id]);
    } else {
      setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
    }
  };

  const handleAssign = async () => {
    setPending(true);
    setError(null);
    try {
      const notify: { in_app: boolean; email?: boolean } = { in_app: notifyOn.in_app };
      if (channels.includes('email')) notify.email = notifyOn.email;
      await onAssign(selected, notify);
      handleOpenChange(false);
    } catch (err) {
      setError(extractApiError(err, 'Failed to assign'));
    } finally {
      setPending(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild disabled={disabled}>
        {trigger}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-3">
        <div className="space-y-3">
          <Input
            placeholder="Search team members..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />

          <div className="max-h-64 overflow-y-auto -mx-1 px-1" role="listbox" aria-multiselectable={mode === 'multi'}>
            {filtered.length === 0 ? (
              <EmptyState density="compact" title="No team members found" />
            ) : (
              filtered.map((u) => {
                const fullName = [u.first_name, u.last_name].filter(Boolean).join(' ');
                const isSelected = selected.includes(u.id);
                return (
                  // Listbox option row (role="option"), not Button-shaped - left raw.
                  <button
                    key={u.id}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => toggle(u.id)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-primary-subtle/60',
                      isSelected && 'bg-primary-subtle/40',
                    )}
                  >
                    {mode === 'multi' && (
                      <Checkbox
                        checked={isSelected}
                        tabIndex={-1}
                        aria-hidden="true"
                        className="pointer-events-none shrink-0"
                      />
                    )}
                    <Avatar className="h-8 w-8 shrink-0">
                      {u.avatar_url && (
                        <AvatarImage src={u.avatar_url} alt={fullName} loading="lazy" decoding="async" className="object-cover" />
                      )}
                      <AvatarFallback tone="solid" className="text-[10px] font-semibold">
                        {getInitials(fullName)}
                      </AvatarFallback>
                    </Avatar>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-text-primary">{fullName}</span>
                      {subtitleOf(u) && (
                        <span className="block truncate text-xs text-text-secondary">{subtitleOf(u)}</span>
                      )}
                    </span>
                    {mode === 'single' && isSelected && (
                      <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                    )}
                  </button>
                );
              })
            )}
          </div>

          {/* Notify channels */}
          <div className="border-t border-border pt-3">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-text-secondary mb-2">Notify</p>
            {/* Not converted to FormField: each label WRAPS a Checkbox + its own text (and the
                disabled SMS row below), not a caption above the control - outside FormField's
                shape. */}
            <div className="space-y-2">
              {channels.map((ch) => (
                <label key={ch} className="flex items-center gap-2 text-sm text-text-primary cursor-pointer">
                  <Checkbox
                    checked={notifyOn[ch]}
                    onCheckedChange={(v) => setNotifyOn((prev) => ({ ...prev, [ch]: v === true }))}
                    aria-label={CHANNEL_LABELS[ch]}
                  />
                  {CHANNEL_LABELS[ch]}
                </label>
              ))}
              {/* SMS infra is unbuilt (Step 9D / #229) — visible but disabled. */}
              <label className="flex items-center gap-2 text-sm text-text-secondary cursor-not-allowed">
                <Checkbox checked={false} disabled aria-label="By SMS" />
                By SMS
                <span className="text-xs text-text-secondary">Coming soon</span>
              </label>
            </div>
          </div>

          {error && <p className="text-sm text-danger">{error}</p>}

          <Button
            className="w-full"
            onClick={handleAssign}
            disabled={pending || (mode === 'single' && selected.length === 0)}
          >
            {pending ? 'Assigning...' : 'Assign'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
