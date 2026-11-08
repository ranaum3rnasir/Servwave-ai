import {
  Archive, Forward, Inbox as InboxIcon, Mail, PanelLeftClose, PenLine, Send, Settings2, Star,
  Users,
} from 'lucide-react';

import { NO_MAILBOX_LABEL } from '@/lib/api/communication';
import type {
  EmailGroup, ForwardRule, TeamMember,
} from '@/lib/api/communication';

import { Avatar } from '@/ui-kit/components/ui/avatar';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { cn } from '@/ui-kit/lib/utils';

import { EM_DASH } from './glyphs';

export type Folder = 'inbox' | 'starred' | 'sent' | 'drafts' | 'archive';

export const FOLDERS: {
  id: Folder;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { id: 'inbox', label: 'Inbox', icon: InboxIcon },
  { id: 'starred', label: 'Starred', icon: Star },
  { id: 'sent', label: 'Sent', icon: Send },
  { id: 'drafts', label: 'Drafts', icon: PenLine },
  { id: 'archive', label: 'Archive', icon: Archive },
];

export interface InboxRailProps {
  folder: Folder;
  onFolder: (f: Folder) => void;
  countFor: (f: Folder) => number;
  members: TeamMember[];
  groups: EmailGroup[];
  forwards: ForwardRule[];
  memberName: (id: string) => string | undefined;
  onManage: (tab: 'members' | 'groups' | 'forwarding') => void;
  onEmailMember: (m: TeamMember) => void;
  onEmailGroup: (g: EmailGroup) => void;
  onCollapse: () => void;
}

/**
 * The Inbox's left rail: folders, the team directory, email groups, the
 * connected mailbox and the forwarding rules.
 *
 * Deliberately NOT ability-gated, matching the legacy page: only the message
 * LIST swaps to "You don't have access to the inbox." for a user without
 * `read Communication`, while this rail keeps rendering the roster, the groups
 * and the forwarding rules. That is a real leak and it is logged in the ledger
 * rather than closed here - tightening it would change who sees what, which is
 * a behaviour change and not this branch's call to make.
 */
export function InboxRail({
  folder, onFolder, countFor, members, groups, forwards, memberName, onManage, onEmailMember,
  onEmailGroup, onCollapse,
}: InboxRailProps) {
  return (
    <div className="bg-kit-card flex w-52 flex-none flex-col overflow-y-auto border-r p-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-muted-foreground px-1 text-[10px] font-semibold uppercase tracking-wider">
          Menu
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          title="Collapse menu"
          aria-label="Collapse menu"
          onClick={onCollapse}
        >
          <PanelLeftClose />
        </Button>
      </div>

      <ul className="space-y-0.5">
        {FOLDERS.map((f) => {
          const active = folder === f.id;
          const count = countFor(f.id);
          return (
            <li key={f.id}>
              <Button
                variant={active ? 'secondary' : 'ghost'}
                size="sm"
                aria-pressed={active}
                onClick={() => onFolder(f.id)}
                className={cn('w-full justify-start gap-2.5', active && 'font-semibold')}
              >
                <f.icon />
                <span className="flex-1 text-left">{f.label}</span>
                {count > 0 && (
                  <Badge variant={active ? 'blue' : 'softNeutral'} size="sm">
                    {count}
                  </Badge>
                )}
              </Button>
            </li>
          );
        })}
      </ul>

      {/* Team directory - email a teammate directly. */}
      <div className="mt-5 px-1">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-muted-foreground text-[10px] font-semibold uppercase tracking-wider">
            Team
          </p>
          <Button variant="link" size="sm" className="h-auto p-0" onClick={() => onManage('members')}>
            Directory
          </Button>
        </div>
        <ul className="space-y-0.5">
          {members.map((m) => (
            <li key={m.id}>
              <Button
                variant="ghost"
                size="sm"
                title={`Email ${m.email}`}
                onClick={() => onEmailMember(m)}
                className="h-auto w-full justify-start gap-2 px-1.5 py-1.5 text-left"
              >
                <Avatar name={m.name} size="xs" />
                <span className="min-w-0 flex-1">
                  <span className="text-foreground block truncate text-[12px] font-medium">
                    {m.name}
                  </span>
                  <span className="block truncate text-[10px] font-normal">{m.role}</span>
                </span>
                <Mail />
              </Button>
            </li>
          ))}
        </ul>
      </div>

      {/* Email groups - one click to message a whole team. */}
      <div className="mt-5 px-1">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-muted-foreground text-[10px] font-semibold uppercase tracking-wider">
            Groups
          </p>
          <Button variant="link" size="sm" className="h-auto p-0" onClick={() => onManage('groups')}>
            <Settings2 /> Manage
          </Button>
        </div>
        <ul className="space-y-0.5">
          {groups.map((g) => (
            <li key={g.id}>
              <Button
                variant="ghost"
                size="sm"
                title={`Email ${g.name}`}
                onClick={() => onEmailGroup(g)}
                className="h-auto w-full justify-start gap-2 px-1.5 py-1.5 text-left"
              >
                <Users />
                <span className="text-foreground min-w-0 flex-1 truncate text-[12px] font-medium">
                  {g.name}
                </span>
                <Badge variant="softNeutral" size="sm">
                  {g.memberIds.length}
                </Badge>
              </Button>
            </li>
          ))}
        </ul>
      </div>

      {/* No "Connected account" block: the Gmail inbox mirror and its connect
          surface were deleted upstream, so there is no mailbox to connect or
          report on. */}

      {/* Forwarding - route incoming mail to the right person/team. */}
      <div className="mt-5 px-1">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-muted-foreground text-[10px] font-semibold uppercase tracking-wider">
            Forwarding
          </p>
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0"
            onClick={() => onManage('forwarding')}
          >
            <Settings2 /> Manage
          </Button>
        </div>
        <ul className="space-y-1.5">
          {forwards.map((r) => {
            const target = r.toGroupId
              ? groups.find((g) => g.id === r.toGroupId)?.name
              : memberName(r.toMemberId ?? '');
            return (
              <li key={r.id} className="flex items-center gap-2">
                <Forward
                  className={cn(
                    'size-3.5 flex-none',
                    r.enabled ? 'text-status-green' : 'text-subtle-foreground',
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="text-foreground block truncate text-[11px] font-medium">
                    {r.from}
                  </span>
                  <span className="text-muted-foreground block truncate text-[10px]">
                    → {target ?? EM_DASH}
                  </span>
                </span>
                {!r.enabled && (
                  <Badge variant="softNeutral" size="sm">
                    off
                  </Badge>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
