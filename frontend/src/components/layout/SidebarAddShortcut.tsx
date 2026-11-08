import { useMemo, useState } from 'react';
import { useAppAbility } from '@/contexts/AbilityContext';
import { useIsDemoOrg } from '@/lib/useIsDemoOrg';
import { useAuthStore } from '@/stores/auth.store';
import { NAV_REGISTRY, isDemoDestUnlockedForOrg } from './nav-registry';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** keys already on the sidebar (excluded from the picker) */
  current: string[];
  onAdd: (key: string) => void;
}

export default function SidebarAddShortcut({ open, onOpenChange, current, onAdd }: Props) {
  const ability = useAppAbility();
  const isDemoOrg = useIsDemoOrg();
  const orgId = useAuthStore((s) => s.user?.organization_id);
  const [q, setQ] = useState('');

  const available = useMemo(() => {
    const term = q.trim().toLowerCase();
    return NAV_REGISTRY.filter(
      (d) =>
        !current.includes(d.key) &&
        ability.can(d.action, d.subject) &&
        // Demo-only surfaces (e.g. Marketing) aren't pinnable by real orgs — the
        // page is mock-only and its route is blocked for them.
        (isDemoOrg || !d.demoOnly || isDemoDestUnlockedForOrg(d, orgId)) &&
        d.label.toLowerCase().includes(term)
    );
  }, [q, current, ability, isDemoOrg, orgId]);

  const pages = available.filter((d) => !d.home.startsWith('Reports'));
  const reports = available.filter((d) => d.home.startsWith('Reports'));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add shortcut</DialogTitle>
        </DialogHeader>
        <p className="-mt-2 text-sm text-text-secondary">
          Pin any page or report. Removing it later only unpins the shortcut — the page
          stays in its home.
        </p>
        <Input
          autoFocus
          placeholder="Search all pages & reports…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="max-h-80 overflow-y-auto">
          {available.length === 0 && (
            <p className="py-6 text-center text-sm text-text-secondary">
              Nothing left to add.
            </p>
          )}
          {[
            { title: 'Pages', items: pages },
            { title: 'Reports', items: reports },
          ].map(
            (group) =>
              group.items.length > 0 && (
                <div key={group.title}>
                  <p className="mb-1 mt-3 px-1 text-xs font-semibold uppercase tracking-widest text-text-secondary/70">
                    {group.title}
                  </p>
                  {group.items.map((d) => (
                    <div
                      key={d.key}
                      className="flex items-center gap-2 border-b border-border py-2"
                    >
                      <d.icon className="h-4 w-4 text-text-secondary" />
                      <span className="flex-1 text-sm">
                        {d.label}{' '}
                        <span className="text-xs text-text-secondary">· {d.home}</span>
                      </span>
                      {/* Raw by design: an outline/brand-toned pill has no minted cell
                          (the outline structure only carries neutral/danger tones today);
                          outline/neutral would add an unwanted idle bg-surface-light fill
                          and lose the primary border/text this row depends on. */}
                      <button
                        type="button"
                        onClick={() => onAdd(d.key)}
                        className="rounded-md border border-primary px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary-subtle"
                      >
                        + Add
                      </button>
                    </div>
                  ))}
                </div>
              )
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
