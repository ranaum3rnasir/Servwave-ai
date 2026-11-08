import { useEffect, useState } from 'react';

// The capability list is NEVER hardcoded here: it comes from
// GET /api/users/:id/permissions, which the backend builds from
// `backend/src/lib/permissions/userCapabilities.ts` (USER_CAPABILITIES). A copy
// in the UI would go stale the moment a capability is added or removed.
import {
  useUserPermissions,
  useUpdateUserPermissions,
  type OverrideState,
  type UserCapability,
} from '@/lib/api/users';

import { Button } from '@/ui-kit/components/ui/button';
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/ui-kit/components/ui/dialog';

interface Props {
  userId: string | null;
  userName: string;
  onClose: () => void;
}

const OPTIONS: { value: OverrideState; label: string }[] = [
  { value: 'inherit', label: 'Inherit' },
  { value: 'allow', label: 'Allow' },
  { value: 'deny', label: 'Deny' },
];

// Group the API-returned capabilities by subject so the list stays readable as
// the managed set grows from 1 -> N. Insertion order of subjects is preserved
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

/**
 * Per-user permission overrides (RBAC Phase 2). Tri-state per curated capability:
 * Inherit (follow the role) / Allow (grant beyond the role) / Deny (revoke from the role).
 *
 * This is the surface that owns `create Job`, `create Invoice`, `record_payment`
 * and `reschedule` - the four admin-grantable PER-USER toggles that are NOT role
 * defaults. It is deliberately a different vocabulary from RolesPage's binary
 * switches, and it prints each capability's role default inline so the two can
 * never be confused for one another.
 *
 * Three things here are load-bearing and are carried over character for character:
 *   - `role="group"` + `aria-label={`Override for ${c.label}`}` - the whole test
 *     surface selects on that exact template, and there are no data-testids.
 *   - `aria-pressed` on each option button.
 *   - the save shape: only allow/deny are sent; `inherit` is omitted, because
 *     `putPermissions` deletes-then-recreates every managed row and absence IS
 *     inherit.
 *
 * `effective` is returned by the API and deliberately not rendered - showing it
 * would be new behaviour, not a restyle.
 */
function UserPermissionsDialog({ userId, userName, onClose }: Props) {
  const { data, isLoading } = useUserPermissions(userId);
  const update = useUpdateUserPermissions();
  const [state, setState] = useState<Record<string, OverrideState>>({});

  // Re-seed local state whenever fresh server data arrives.
  useEffect(() => {
    if (!data) return;
    const next: Record<string, OverrideState> = {};
    for (const c of data.capabilities) next[`${c.action}:${c.subject}`] = c.override;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate mirror idiom: the toggle draft is re-seeded from server truth on each fetch
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
          <DialogTitle>Permissions - {userName}</DialogTitle>
          <DialogDescription>
            Override individual capabilities for this user. <strong>Inherit</strong> follows their
            role; <strong>Allow</strong> grants it even if the role doesn&rsquo;t;{' '}
            <strong>Deny</strong> removes it.
          </DialogDescription>
        </DialogHeader>

        {isLoading && <p className="text-muted-foreground py-6 text-sm">Loading...</p>}

        {/* Admin exclusion, second of two: the caller already hides the button for
            an ADMIN row, and the backend 400s the PUT. This is the middle layer. */}
        {data && !data.editable && (
          <p className="text-muted-foreground py-6 text-sm">
            Administrators have full access, which can&rsquo;t be overridden.
          </p>
        )}

        {data && data.editable && (
          <DialogBody className="max-h-[60vh] space-y-6 overflow-y-auto py-2">
            {groupBySubject(data.capabilities).map(([subject, caps]) => (
              <div key={subject} className="space-y-3">
                <div className="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
                  {subject}
                </div>
                {caps.map((c) => {
                  const key = `${c.action}:${c.subject}`;
                  const val = state[key] ?? 'inherit';
                  return (
                    <div key={key} className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="text-sm font-medium">{c.label}</div>
                        <div className="text-muted-foreground text-xs">{c.description}</div>
                        {/* Explicit inline provenance, computed server-side from
                            the live role_permissions rows. This is what keeps a
                            per-user grant distinguishable from a role default. */}
                        <div className="text-muted-foreground mt-0.5 text-xs">
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
                          return (
                            <Button
                              key={opt.value}
                              type="button"
                              size="sm"
                              variant={
                                !active
                                  ? 'outline'
                                  : opt.value === 'deny'
                                    ? 'destructive'
                                    : opt.value === 'allow'
                                      ? 'default'
                                      : 'secondary'
                              }
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
          </DialogBody>
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

export default UserPermissionsDialog;
