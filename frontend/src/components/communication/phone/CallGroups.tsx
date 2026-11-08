// Call Groups — the "Call groups" tab of the Phone module. A call group rings
// several people/devices together (or one-at-a-time) when a call flow forwards
// to it, so calls get answered faster (PHONE-SYSTEM-PRD §14.20). Modeled on the
// owner-supplied reference (Workiz "create group").
//
// Faithful cut from Emanuel's CallGroups prototype. Behavior is verbatim; only
// these classes of change were made:
//   1. Tailwind tokens swapped indigo/slate -> ALPHA design tokens (primary /
//      text-primary / text-secondary / border / background-light). emerald,
//      amber, rose are kept verbatim (status colors).
//   2. Domain data, types and label helpers come from the `@/lib/api/communication`
//      seam: the seed flows in via the shell's `useCallGroups()` and lands on the
//      controlled `groups`/`setGroups` props; the modal's member roster is built
//      from seam hooks (`usePhoneAgents` + `useTeamMembers`) plus the signed-in
//      owner, NOT from module-scope `currentUser`/`phoneAgents`/`techs` imports.
//   3. The three current-user gates collapse to a coarse CASL check
//      (`ability.can('manage','Communication')`) + the real signed-in user from
//      the auth store. Owner appears in the roster only when allowed to manage.
//
// The ring-all vs round-robin selector and the hand-rolled create/edit overlay
// are kept as-is (token-swap only) — comms dialogs never used a Modal abstraction.
import { useMemo, useState } from "react";
import { Phone, Plus, Smartphone, Trash2, Users } from "lucide-react";
import {
  ringLabel,
  type CallGroup,
  type CallGroupMember,
  type RingStrategy,
  type GroupDevice,
} from "@/lib/api/communication";
import { usePhoneAgents, useTeamMembers } from "@/lib/api/communication";
import { useAppAbility } from "@/contexts/AbilityContext";
import { useAuthStore } from "@/stores/auth.store";
import { EmptyState } from "@/components/ui/empty-state";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { useScheduleTimezone, formatInstant } from '@/lib/schedule-tz';

/* ─────────────────────────── Roster helpers ─────────────────────────── */

type GroupPerson = { id: string; name: string; subtitle: string };

const memberKey = (personId: string, device: GroupDevice) => `${personId}|${device}`;

let _seq = 0;
function newId(prefix: string): string {
  _seq += 1;
  return `${prefix}_${Date.now().toString(36)}${_seq}`;
}

/* ─────────────────────────── List view ─────────────────────────── */

export function CallGroupsView({
  groups,
  setGroups,
  onToast,
}: {
  groups: CallGroup[];
  setGroups: React.Dispatch<React.SetStateAction<CallGroup[]>>;
  onToast: (m: string) => void;
}) {
  const tz = useScheduleTimezone();
  const [editing, setEditing] = useState<CallGroup | null>(null);
  const [creating, setCreating] = useState(false);

  function saveGroup(g: CallGroup) {
    setGroups((prev) => {
      const exists = prev.some((x) => x.id === g.id);
      return exists ? prev.map((x) => (x.id === g.id ? g : x)) : [g, ...prev];
    });
    onToast(`✓ Saved “${g.name}”`);
    setEditing(null);
    setCreating(false);
  }

  function deleteGroup(id: string) {
    setGroups((prev) => prev.filter((g) => g.id !== id));
    onToast("Call group deleted");
  }

  const modalGroup = creating || editing ? editing : null;

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-text-secondary">
          Ring multiple people together — all at once or round-robin — so calls get
          answered faster. Route a call flow to a group and everyone selected rings.
        </p>
        <button
          onClick={() => {
            setEditing(null);
            setCreating(true);
          }}
          className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-md bg-primary px-3.5 py-2 text-sm font-semibold text-on-fill shadow-sm hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          Create group
        </button>
      </div>

      {groups.length === 0 ? (
        <EmptyState
          variant="card"
          icon={Users}
          title="No call groups yet"
          description="Create a group so a call flow can ring several people at once."
          action={
            <button
              onClick={() => setCreating(true)}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3.5 py-2 text-sm font-semibold text-on-fill hover:bg-primary/90"
            >
              <Plus className="h-4 w-4" /> Create group
            </button>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-card border border-border bg-surface-light">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-background-light text-[10px] uppercase tracking-wide text-text-secondary">
              <tr>
                <th className="px-4 py-2.5 text-left">Group</th>
                <th className="px-4 py-2.5 text-left">Ring</th>
                <th className="px-4 py-2.5 text-left">Members</th>
                <th className="px-4 py-2.5 text-left">Updated</th>
                <th className="px-4 py-2.5 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {groups.map((g) => (
                <tr
                  key={g.id}
                  onClick={() => {
                    setCreating(false);
                    setEditing(g);
                  }}
                  className="cursor-pointer align-middle hover:bg-primary/10"
                >
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-2 font-semibold text-text-primary">
                      <Users className="h-4 w-4 text-primary" />
                      {g.name}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-text-secondary">{ringLabel(g.ring)}</td>
                  <td className="px-4 py-3 text-text-secondary">
                    {g.members.length === 0 ? (
                      <span className="text-text-secondary">None</span>
                    ) : (
                      <span className="text-[12px]">
                        {g.members.length} device{g.members.length === 1 ? "" : "s"} ·{" "}
                        {Array.from(new Set(g.members.map((m) => m.name))).join(", ")}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-[12px] text-text-secondary">
                    {formatInstant(g.updatedAt, tz, { month: "short", day: "numeric" })}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteGroup(g.id);
                      }}
                      aria-label={`Delete ${g.name}`}
                      className="rounded-md p-1.5 text-text-secondary transition hover:bg-danger/10 hover:text-danger"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(creating || editing) && (
        <GroupModal
          initial={modalGroup}
          onClose={() => {
            setEditing(null);
            setCreating(false);
          }}
          onSave={saveGroup}
        />
      )}
    </div>
  );
}

/* ─────────────────────────── Create / edit modal ─────────────────────────── */

function GroupModal({
  initial,
  onClose,
  onSave,
}: {
  initial: CallGroup | null;
  onClose: () => void;
  onSave: (g: CallGroup) => void;
}) {
  // Roster comes from the seam (signed-in owner + phone agents + team members),
  // replacing the prototype's module-scope currentUser/phoneAgents/techs.
  const ability = useAppAbility();
  const user = useAuthStore((s) => s.user);
  const { data: agents = [] } = usePhoneAgents();
  const { data: team = [] } = useTeamMembers();

  const people: GroupPerson[] = useMemo(() => {
    const roster: GroupPerson[] = [];
    if (user && ability.can("manage", "Communication")) {
      roster.push({
        id: user.id,
        name: `${user.first_name} ${user.last_name}`.trim() || user.email,
        subtitle: "Owner",
      });
    }
    for (const a of agents) {
      if (a.kind === "human") roster.push({ id: a.id, name: a.name, subtitle: a.role });
    }
    for (const t of team) {
      roster.push({ id: t.id, name: t.name, subtitle: t.role });
    }
    // De-dupe by personId (owner may already appear as a team member).
    const seen = new Set<string>();
    return roster.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
  }, [ability, user, agents, team]);

  const [name, setName] = useState(initial?.name ?? "");
  const [ring, setRing] = useState<RingStrategy>(initial?.ring ?? "all");
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set((initial?.members ?? []).map((m) => memberKey(m.personId, m.device))),
  );

  function toggle(personId: string, device: GroupDevice) {
    const key = memberKey(personId, device);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const selectedCount = selected.size;

  function save() {
    const members: CallGroupMember[] = [];
    for (const p of people) {
      for (const device of ["cell", "softphone"] as GroupDevice[]) {
        if (selected.has(memberKey(p.id, device))) {
          members.push({ personId: p.id, name: p.name, device });
        }
      }
    }
    onSave({
      id: initial?.id ?? newId("grp"),
      name: name.trim() || "Untitled group",
      ring,
      members,
      updatedAt: new Date().toISOString(),
    });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={initial ? "Edit group" : "Create group"}
      size="lg"
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <span className="text-[12px] text-text-secondary">
            {selectedCount} device{selectedCount === 1 ? "" : "s"} selected
          </span>
          <span className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={save}>Save</Button>
          </span>
        </div>
      }
    >
        <div className="space-y-5">
          {/* Group name */}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Group name"
            className="w-full rounded-md border border-border px-3.5 py-2.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-subtle"
          />

          {/* Ring strategy */}
          <div>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
              When a call comes in
            </p>
            <div className="flex gap-1">
              {(["all", "round_robin"] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRing(r)}
                  className={[
                    "flex-1 rounded-md px-3 py-2 text-[13px] font-semibold transition",
                    ring === r
                      ? "bg-primary text-on-fill"
                      : "bg-background-light text-text-secondary hover:bg-border",
                  ].join(" ")}
                >
                  {ringLabel(r)}
                </button>
              ))}
            </div>
          </div>

          {/* Members */}
          <div>
            <p className="text-sm font-semibold text-text-primary">Members in group</p>
            <p className="mt-0.5 text-[12px] leading-snug text-text-secondary">
              {ring === "all"
                ? "Calls forwarded to this group ring all selected users/devices at once."
                : "Calls forwarded to this group ring members one at a time until answered."}{" "}
              Softphones ring if open and the user is logged in.
            </p>

            <div className="mt-3 space-y-2">
              {people.map((p) => (
                <div
                  key={p.id}
                  className="flex flex-col gap-2 rounded-card border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-background-light text-text-secondary">
                      <Users className="h-4 w-4" />
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-[13px] font-semibold text-text-primary">
                        {p.name}
                      </span>
                      <span className="truncate text-[11px] text-text-secondary">{p.subtitle}</span>
                    </span>
                  </span>
                  <span className="flex flex-shrink-0 gap-2">
                    <DeviceToggle
                      icon={Phone}
                      label="Cell"
                      on={selected.has(memberKey(p.id, "cell"))}
                      onClick={() => toggle(p.id, "cell")}
                    />
                    <DeviceToggle
                      icon={Smartphone}
                      label="Softphone"
                      on={selected.has(memberKey(p.id, "softphone"))}
                      onClick={() => toggle(p.id, "softphone")}
                    />
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
    </Modal>
  );
}

function DeviceToggle({
  icon: Icon,
  label,
  on,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={[
        "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] font-semibold transition",
        on
          ? "border-primary bg-primary/10 text-primary"
          : "border-border text-text-secondary hover:bg-background-light",
      ].join(" ")}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
      <span
        className={[
          "flex h-3.5 w-3.5 items-center justify-center rounded-sm border",
          on ? "border-primary bg-primary text-on-fill" : "border-border",
        ].join(" ")}
      >
        {on && <span className="text-[9px] leading-none">✓</span>}
      </span>
    </button>
  );
}
