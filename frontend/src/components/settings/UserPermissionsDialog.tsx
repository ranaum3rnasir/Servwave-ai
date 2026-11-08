import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  useUserPermissions,
  useUpdateUserPermissions,
  type OverrideState,
  type UserCapability,
} from '@/lib/api/users';

interface Props {
  userId: string | null;
  userName: string;
  onClose: () => void;
}

type ButtonStructure = 'outline' | 'solid';
type ButtonTone = 'business' | 'danger' | 'neutral';
const OPTIONS: { value: OverrideState; label: string }[] = [
  { value: 'inherit', label: 'Inherit' },
  { value: 'allow', label: 'Allow' },
  { value: 'deny', label: 'Deny' },
];

// Group the API-returned capabilities by subject so the list stays readable as
// the managed set grows from 1 → N. Insertion order of subjects is preserved
// (the API already returns capabilities in a sensible order).
function groupBySubject(capabilities: UserCapability[]): [string, UserCapability[]][] {
  const groups = new Map<string, UserCapability[]>();
  for (const c of capabilities) {
    const bucket = groups.get(c.subject);
    if (bucket) bucket.push(c);
    else groups.set(c.subject, [c]);
  }
  return [...groups.entries()];
}

// Per-user permission overrides (RBAC Phase 2). Tri-state per curated capability:
// Inherit (follow the role) / Allow (grant beyond the role) / Deny (revoke from the role).
export default function UserPermissionsDialog({ userId, userName, onClose }: Props) {
  const { data, isLoading } = useUserPermissions(userId);
  const update = useUpdateUserPermissions();
  const [state, setState] = useState<Record<string, OverrideState>>({});

  // Re-seed local state whenever fresh server data arrives.
  useEffect(() => {
    if (!data) return;
    const next: Record<string, OverrideState> = {};
    for (const c of data.capabilities) next[`${c.action}:${c.subject}`] = c.override;
    setState(next);
  }, [data]);

  const dirty = data
    ? data.capabilities.some((c) => (state[`${c.action}:${c.subject}`] ?? 'inherit') !== c.override)
    : false;

  const save = () => {
    if (!userId || !data) return;
    const overrides = data.capabilities
      .map((c) => ({ c, val: state[`${c.action}:${c.subject}`] ?? 'inherit' }))
      .filter((x): x is { c: typeof x.c; val: 'allow' | 'deny' } => x.val === 'allow' || x.val === 'deny')
      .map((x) => ({ action: x.c.action, subject: x.c.subject, effect: x.val }));
    update.mutate({ id: userId, overrides }, { onSuccess: onClose });
  };

  return (
    <Dialog open={userId !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Permissions — {userName}</DialogTitle>
          <DialogDescription>
            Override individual capabilities for this user. <strong>Inherit</strong> follows their
            role; <strong>Allow</strong> grants it even if the role doesn’t; <strong>Deny</strong>{' '}
            removes it.
          </DialogDescription>
        </DialogHeader>

        {isLoading && <p className="py-6 text-sm text-text-secondary">Loading…</p>}

        {data && !data.editable && (
          <p className="py-6 text-sm text-text-secondary">
            Administrators have full access, which can’t be overridden.
          </p>
        )}

        {data && data.editable && (
          <div className="max-h-[60vh] space-y-6 overflow-y-auto py-2">
            {groupBySubject(data.capabilities).map(([subject, caps]) => (
              <div key={subject} className="space-y-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                  {subject}
                </div>
                {caps.map((c) => {
                  const key = `${c.action}:${c.subject}`;
                  const val = state[key] ?? 'inherit';
                  return (
                    <div key={key} className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-text-primary">{c.label}</div>
                        <div className="text-xs text-text-secondary">{c.description}</div>
                        <div className="mt-0.5 text-xs text-text-secondary">
                          Role default:{' '}
                          {c.roleDefault === 'allowed' ? 'Allowed by role' : 'Not in role'}
                        </div>
                      </div>
                      <div
                        className="flex shrink-0 gap-1"
                        role="group"
                        aria-label={`Override for ${c.label}`}
                      >
                        {OPTIONS.map((opt) => {
                          const active = val === opt.value;
                          const variant: ButtonStructure = active ? 'solid' : 'outline';
                          const tone: ButtonTone | undefined = !active
                            ? undefined
                            : opt.value === 'allow'
                              ? 'business'
                              : opt.value === 'deny'
                                ? 'danger'
                                : 'neutral';
                          return (
                            <Button
                              key={opt.value}
                              type="button"
                              size="sm"
                              variant={variant}
                              tone={tone}
                              aria-pressed={active}
                              onClick={() => setState((s) => ({ ...s, [key]: opt.value }))}
                            >
                              {opt.label}
                            </Button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!dirty || update.isPending || !data?.editable}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
