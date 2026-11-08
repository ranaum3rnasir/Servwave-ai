import { useMemo, useState } from "react";
import { Check, Forward, Mail, Plus, Trash2, Users } from "lucide-react";
import type { TeamMember, EmailGroup, ForwardRule } from "@/lib/api/communication";
import { SelectField } from "@/components/form/SelectField";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { getInitials } from "@/lib/utils";

const AVATAR_TINTS = [
  "bg-primary-subtle text-primary-dark",
  "bg-success-surface text-success-text",
  "bg-info-surface text-info-text",
  "bg-warning-surface text-warning-text",
  "bg-danger-surface text-danger-text",
  "bg-info-surface text-info-text",
];
function tintFor(s: string): string {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_TINTS[h % AVATAR_TINTS.length] ?? AVATAR_TINTS[0]!;
}

// Manage the team directory, email groups, and forwarding rules in one place.
// Opened from the inbox sidebar (Team "Directory", Groups/Forwarding "Manage").
export function ManageDirectoryModal({
  initialTab,
  members,
  groups,
  setGroups,
  forwards,
  setForwards,
  onClose,
  onEmailMember,
  onEmailGroup,
  flash,
}: {
  initialTab: "members" | "groups" | "forwarding";
  members: TeamMember[];
  groups: EmailGroup[];
  setGroups: React.Dispatch<React.SetStateAction<EmailGroup[]>>;
  forwards: ForwardRule[];
  setForwards: React.Dispatch<React.SetStateAction<ForwardRule[]>>;
  onClose: () => void;
  onEmailMember: (m: TeamMember) => void;
  onEmailGroup: (g: EmailGroup) => void;
  flash: (m: string) => void;
}) {
  const [tab, setTab] = useState(initialTab);

  // Two headed sections, expressed as the option type's `group` so the count
  // that decides §4.2's branch is one flat array - a hand-composed
  // <SelectGroup> pair hides it from the primitive entirely.
  const forwardTargetOptions = useMemo(
    () => [
      ...groups.map((g) => ({ value: `g:${g.id}`, label: g.name, group: "Groups" })),
      ...members.map((m) => ({ value: `m:${m.id}`, label: m.name, group: "People" })),
    ],
    [groups, members]
  );

  // ——— Group editing ———
  function addGroup() {
    const g: EmailGroup = { id: `g_${Date.now()}`, name: "New group", memberIds: [] };
    setGroups((gs) => [...gs, g]);
    flash("Group created — add members and rename it");
  }
  function renameGroup(id: string, name: string) {
    setGroups((gs) => gs.map((g) => (g.id === id ? { ...g, name } : g)));
  }
  function deleteGroup(id: string) {
    setGroups((gs) => gs.filter((g) => g.id !== id));
    setForwards((fs) => fs.map((f) => (f.toGroupId === id ? { ...f, toGroupId: undefined } : f)));
  }
  function toggleMember(gid: string, mid: string) {
    setGroups((gs) =>
      gs.map((g) =>
        g.id === gid
          ? {
              ...g,
              memberIds: g.memberIds.includes(mid)
                ? g.memberIds.filter((x) => x !== mid)
                : [...g.memberIds, mid],
            }
          : g,
      ),
    );
  }

  // ——— Forwarding editing ———
  function addForward() {
    const f: ForwardRule = {
      id: `f_${Date.now()}`,
      from: "",
      toGroupId: groups[0]?.id,
      enabled: true,
    };
    setForwards((fs) => [...fs, f]);
  }
  function updateForward(id: string, patch: Partial<ForwardRule>) {
    setForwards((fs) => fs.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }
  function deleteForward(id: string) {
    setForwards((fs) => fs.filter((f) => f.id !== id));
  }
  function setForwardTarget(id: string, value: string) {
    if (value.startsWith("g:")) {
      updateForward(id, { toGroupId: value.slice(2), toMemberId: undefined });
    } else if (value.startsWith("m:")) {
      updateForward(id, { toMemberId: value.slice(2), toGroupId: undefined });
    }
  }

  const TABS: { id: "members" | "groups" | "forwarding"; label: string }[] = [
    { id: "members", label: "Members" },
    { id: "groups", label: "Groups" },
    { id: "forwarding", label: "Forwarding" },
  ];

  return (
    <Modal
      open
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <Users className="h-4 w-4 text-primary" /> Team & groups
        </span>
      }
      size="lg"
      footer={<Button onClick={onClose}>Done</Button>}
    >
      {/* Tabs */}
      <div className="-mx-6 -mt-2 flex gap-1 border-b border-border px-6">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={[
              "border-b-2 px-3 py-2.5 text-[13px] font-semibold transition",
              tab === t.id
                ? "border-primary text-primary"
                : "border-transparent text-text-secondary hover:text-text-primary",
            ].join(" ")}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="max-h-[60vh] min-h-0 overflow-y-auto py-4">
        {/* Members */}
          {tab === "members" && (
            <div className="space-y-1.5">
              <p className="mb-2 text-[12px] text-text-secondary">
                Everyone on your account. Click <span className="font-medium text-text-secondary">Email</span> to start a
                message. The roster itself is managed in Settings → Users.
              </p>
              {members.map((m) => (
                <div key={m.id} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2">
                  <span
                    className={`flex h-8 w-8 flex-none items-center justify-center rounded-full text-[11px] font-semibold ${tintFor(m.name)}`}
                  >
                    {getInitials(m.name)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-semibold text-text-primary">{m.name}</p>
                    <p className="truncate text-[12px] text-text-secondary">
                      {m.role} · {m.email}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onEmailMember(m)}
                    className="inline-flex flex-none items-center gap-1.5 rounded-md border border-neutral-border bg-surface-light px-2.5 py-1.5 text-[12px] font-semibold text-text-secondary hover:bg-background-light"
                  >
                    <Mail className="h-3.5 w-3.5" /> Email
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Groups */}
          {tab === "groups" && (
            <div className="space-y-3">
              <button
                type="button"
                onClick={addGroup}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-[13px] font-semibold text-on-fill hover:bg-primary/90"
              >
                <Plus className="h-4 w-4" /> New group
              </button>
              {groups.map((g) => (
                <div key={g.id} className="rounded-lg border border-border p-3">
                  <div className="flex items-center gap-2">
                    <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-primary/10 text-primary">
                      <Users className="h-3.5 w-3.5" />
                    </span>
                    <input
                      value={g.name}
                      onChange={(e) => renameGroup(g.id, e.target.value)}
                      className="min-w-0 flex-1 rounded-md border border-transparent px-2 py-1 text-[13px] font-semibold text-text-primary hover:border-border focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/10"
                    />
                    <button
                      type="button"
                      onClick={() => onEmailGroup(g)}
                      className="inline-flex flex-none items-center gap-1.5 rounded-md border border-neutral-border bg-surface-light px-2.5 py-1.5 text-[12px] font-semibold text-text-secondary hover:bg-background-light"
                    >
                      <Mail className="h-3.5 w-3.5" /> Email
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteGroup(g.id)}
                      className="flex-none rounded-md p-1.5 text-text-soft hover:text-danger-text"
                      aria-label="Delete group"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  <p className="mb-1.5 mt-2.5 text-[10px] font-semibold uppercase tracking-wide text-text-soft">
                    Members ({g.memberIds.length})
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {members.map((m) => {
                      const inGroup = g.memberIds.includes(m.id);
                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => toggleMember(g.id, m.id)}
                          className={[
                            "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-medium transition",
                            inGroup
                              ? "bg-primary text-on-fill hover:bg-primary/90"
                              : "bg-neutral-surface text-text-secondary hover:bg-neutral-border",
                          ].join(" ")}
                        >
                          {inGroup && <Check className="h-3 w-3" />}
                          {m.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Forwarding */}
          {tab === "forwarding" && (
            <div className="space-y-3">
              <p className="text-[12px] text-text-secondary">
                Route incoming mail to the right person or team so nothing gets missed.
              </p>
              <button
                type="button"
                onClick={addForward}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-[13px] font-semibold text-on-fill hover:bg-primary/90"
              >
                <Plus className="h-4 w-4" /> New rule
              </button>
              {forwards.length === 0 && (
                <p className="rounded-lg border border-dashed border-neutral-border px-3 py-6 text-center text-[12px] text-text-soft">
                  No forwarding rules yet.
                </p>
              )}
              {forwards.map((r) => (
                <div key={r.id} className="space-y-2 rounded-lg border border-border p-3">
                  <div className="flex items-center gap-2">
                    <input
                      value={r.from}
                      onChange={(e) => updateForward(r.id, { from: e.target.value })}
                      placeholder="Incoming mail (address or label)"
                      className="min-w-0 flex-1 rounded-md border border-neutral-border px-2.5 py-1.5 text-[13px] focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/10"
                    />
                    <button
                      type="button"
                      onClick={() => updateForward(r.id, { enabled: !r.enabled })}
                      className={[
                        "flex-none rounded-full px-2.5 py-1 text-[11px] font-semibold transition",
                        r.enabled ? "bg-success-surface text-success-text" : "bg-neutral-surface text-text-secondary",
                      ].join(" ")}
                    >
                      {r.enabled ? "On" : "Off"}
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteForward(r.id)}
                      className="flex-none rounded-md p-1.5 text-text-soft hover:text-danger-text"
                      aria-label="Delete rule"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="flex items-center gap-2 pl-0.5 text-[12px] text-text-secondary">
                    <Forward className="h-3.5 w-3.5 text-text-soft" />
                    <span>Forward to</span>
                    <SelectField
                      value={r.toGroupId ? `g:${r.toGroupId}` : r.toMemberId ? `m:${r.toMemberId}` : ""}
                      onValueChange={(v) => setForwardTarget(r.id, v)}
                      aria-label="Forward to"
                      className="flex-1 border-neutral-border px-2 py-1.5 text-[13px] text-text-secondary focus:border-primary/60 focus:ring-2 focus:ring-primary/10"
                      placeholder="Select…"
                      options={forwardTargetOptions}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
      </div>
    </Modal>
  );
}
