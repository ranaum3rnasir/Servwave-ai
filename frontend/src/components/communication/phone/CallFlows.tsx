// Phone module — Call flows view.
//
// Ported from Emanuel's CallFlows prototype (the "Call flows" tab of the Phone
// module). Owners build the IVR / routing automations that decide how an inbound
// call is greeted, screened by business hours, and connected to the right
// person. Two starter structures (Basic, Voice Menu); each node is editable via
// a side panel; the shape comes from the chosen template (PHONE-SYSTEM-PRD
// §14.18).
//
// Cut-and-reskin notes:
//   • Tokens swapped indigo/slate → ALPHA design tokens. emerald/amber/rose/sky/
//     violet are kept verbatim (status colors / node accents).
//   • The flow model, seed (CALL_FLOW_SEED) and pure helpers (flowStructureLabel,
//     customFlowOptions, flowNameForId) now live in the `@/lib/api/communication`
//     seam — imported from there, never redefined.
//   • The flow factories (makeBasicFlow / makeVoiceMenuFlow) and the People
//     forward-target list stay view-local but are data-as-param: the monolith's
//     module-scope `currentUser` is now the signed-in user from the auth store,
//     threaded down as an `owner` value; the People roster comes from the
//     usePhoneAgents() seam hook (humans only) composed in the view. The shop's
//     techs roster has no ALPHA seam equivalent yet, so the prototype's `techs`
//     forwarding entries are dropped (owner + phone agents remain).
//   • CASL gates the view (read/manage Communication, coarse subject).
//   • Overlays consolidation: the structure-choice modal now composes ui/modal;
//     the insert-step menu (InsertDot) and MiniSelect now compose ui/popover
//     instead of their former hand-rolled fixed click-catchers. Chrome only —
//     business logic kept verbatim.

import { useMemo, useState } from "react";
import {
  ChevronDown,
  Clock,
  ListOrdered,
  Megaphone,
  Pencil,
  PhoneForwarded,
  PhoneIncoming,
  Play,
  Plus,
  Save,
  Trash2,
  Voicemail,
  Workflow,
  X,
} from "lucide-react";
import {
  flowStructureLabel,
  usePhoneAgents,
} from "@/lib/api/communication";
import type {
  CallFlow,
  FlowNode,
  FlowStructure,
  ForwardTarget,
  MenuOption,
  PhoneAgent,
} from "@/lib/api/communication";
import { useAppAbility } from "@/contexts/AbilityContext";
import { useAuthStore } from "@/stores/auth.store";
import { EmptyState } from "@/components/ui/empty-state";
import { Modal } from "@/components/ui/modal";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { useScheduleTimezone, formatInstant } from '@/lib/schedule-tz';

/* ─────────────────────────── Owner identity ─────────────────────────── */

/** The signed-in user, shaped like the prototype's `currentUser` for the flow
 *  factories + People forward-target list. */
type Owner = { id: string; name: string };

/* ─────────────────────────── Directory ─────────────────────────── */

/** People you can forward a call to: the signed-in owner first, then the human
 *  phone agents. (The prototype also listed field techs; ALPHA has no techs seam
 *  yet, so that branch is dropped.) */
function peopleTargets(owner: Owner, agents: PhoneAgent[]): ForwardTarget[] {
  return [
    { kind: "person", id: owner.id, label: owner.name },
    ...agents
      .filter((a) => a.kind === "human")
      .map<ForwardTarget>((a) => ({ kind: "person", id: a.id, label: a.name })),
  ];
}

function fmtPhone(v: string): string {
  const d = v.replace(/\D/g, "");
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  return v;
}

function targetLabel(t: ForwardTarget): string {
  if (t.kind === "voicemail") return "Voicemail";
  if (t.kind === "number") return t.value ? fmtPhone(t.value) : "a number";
  return t.label;
}

/* ─────────────────────────── Helpers ─────────────────────────── */

let _seq = 0;
function newId(prefix: string): string {
  _seq += 1;
  return `${prefix}_${Date.now().toString(36)}${_seq}`;
}

/* ─────────────────────────── Templates ─────────────────────────── */

function defaultGreeting(): FlowNode {
  return {
    id: newId("nd"),
    type: "greeting",
    message: "Thanks for calling ServWave. One moment while we connect you.",
  };
}

function makeBasicFlow(owner: Owner): CallFlow {
  return {
    id: newId("cf"),
    name: "",
    structure: "basic",
    record: true,
    status: "draft",
    updatedAt: new Date().toISOString(),
    hoursMode: "always",
    openNodes: [
      defaultGreeting(),
      {
        id: newId("nd"),
        type: "forward",
        target: { kind: "person", id: owner.id, label: owner.name },
      },
    ],
    closedNodes: [
      { id: newId("nd"), type: "voicemail", message: "We're closed right now — please leave a message and we'll call you back." },
    ],
  };
}

function makeVoiceMenuFlow(): CallFlow {
  return {
    id: newId("cf"),
    name: "",
    structure: "voice_menu",
    record: true,
    status: "draft",
    updatedAt: new Date().toISOString(),
    hoursMode: "always",
    openNodes: [
      defaultGreeting(),
      {
        id: newId("nd"),
        type: "menu",
        prompt: "Press 1 for new service, 2 for an existing job, or 3 for billing.",
        options: [
          { id: newId("op"), digit: "1", label: "New service", target: { kind: "group", id: "grp_sales", label: "Sales team" } },
          { id: newId("op"), digit: "2", label: "Existing job", target: { kind: "group", id: "grp_dispatch", label: "Dispatch team" } },
          { id: newId("op"), digit: "3", label: "Billing", target: { kind: "voicemail" } },
        ],
      },
    ],
    closedNodes: [
      { id: newId("nd"), type: "voicemail", message: "We're closed right now — please leave a message and we'll call you back." },
    ],
  };
}

/* ─────────────────────────── Node metadata ─────────────────────────── */

const NODE_META: Record<FlowNode["type"], { label: string; icon: React.ComponentType<{ className?: string }>; accent: string }> = {
  greeting: { label: "Greeting", icon: Megaphone, accent: "text-primary" },
  forward: { label: "Forward", icon: PhoneForwarded, accent: "text-success" },
  menu: { label: "Voice Menu", icon: ListOrdered, accent: "text-info" },
  voicemail: { label: "Voicemail", icon: Voicemail, accent: "text-warning" },
};

function nodeSubtitle(n: FlowNode): string {
  switch (n.type) {
    case "greeting":
      return n.message || "No message set";
    case "forward":
      return `→ ${targetLabel(n.target)}`;
    case "menu":
      return `${n.options.length} option${n.options.length === 1 ? "" : "s"}`;
    case "voicemail":
      return "Take a message";
  }
}

/* ─────────────────────────── Top-level view ─────────────────────────── */

type FlowNumber = { id: string; number: string; flowId: string };

export function CallFlowsView({
  flows,
  setFlows,
  numbers,
  groupOptions = [],
  onAssignNumbers,
  onToast,
}: {
  flows: CallFlow[];
  setFlows: React.Dispatch<React.SetStateAction<CallFlow[]>>;
  numbers: FlowNumber[];
  groupOptions?: { id: string; label: string }[];
  onAssignNumbers: (flowId: string, numberIds: string[]) => void;
  onToast: (m: string) => void;
}) {
  const ability = useAppAbility();
  const canManage = ability.can("manage", "Communication");
  const tz = useScheduleTimezone();
  const user = useAuthStore((s) => s.user);

  // Signed-in user, shaped like the prototype's `currentUser`. Falls back
  // gracefully when the auth store isn't hydrated yet.
  const owner = useMemo<Owner>(
    () => ({
      id: user?.id ?? "owner",
      name: user ? `${user.first_name} ${user.last_name}`.trim() || "me" : "me",
    }),
    [user],
  );
  const { data: agents = [] } = usePhoneAgents();
  const people = useMemo(() => peopleTargets(owner, agents), [owner, agents]);

  // null = list; "choose" = structure modal; otherwise editing this flow id.
  const [editing, setEditing] = useState<CallFlow | null>(null);
  const [choosing, setChoosing] = useState(false);

  function startNew(structure: FlowStructure) {
    setChoosing(false);
    setEditing(structure === "basic" ? makeBasicFlow(owner) : makeVoiceMenuFlow());
  }

  function saveFlow(flow: CallFlow, assignedNumberIds: string[]) {
    const saved: CallFlow = {
      ...flow,
      name: flow.name.trim() || "Untitled flow",
      status: assignedNumberIds.length ? "active" : "draft",
      updatedAt: new Date().toISOString(),
    };
    setFlows((prev) => {
      const exists = prev.some((f) => f.id === saved.id);
      return exists ? prev.map((f) => (f.id === saved.id ? saved : f)) : [saved, ...prev];
    });
    onAssignNumbers(`flow:${saved.id}`, assignedNumberIds);
    onToast(`✓ Saved “${saved.name}”`);
    setEditing(null);
  }

  function deleteFlow(id: string) {
    setFlows((prev) => prev.filter((f) => f.id !== id));
    onAssignNumbers(`flow:${id}`, []); // detach from any numbers
    onToast("Call flow deleted");
  }

  if (editing) {
    return (
      <CallFlowBuilder
        initial={editing}
        numbers={numbers}
        groupOptions={groupOptions}
        people={people}
        canManage={canManage}
        onCancel={() => setEditing(null)}
        onSave={saveFlow}
      />
    );
  }

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-text-secondary">
          Build the IVR menus and routing rules that decide how incoming calls are
          greeted, screened by business hours, and connected to the right person.
        </p>
        {canManage && (
          <button
            onClick={() => setChoosing(true)}
            className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-md bg-primary px-3.5 py-2 text-sm font-semibold text-on-fill shadow-sm hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            Create Call Flow
          </button>
        )}
      </div>

      {flows.length === 0 ? (
        <EmptyState
          variant="card"
          icon={Workflow}
          title="No call flows yet"
          description="Create your first call flow to start automating how calls are answered."
          action={
            canManage ? (
              <button
                onClick={() => setChoosing(true)}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3.5 py-2 text-sm font-semibold text-on-fill hover:bg-primary/90"
              >
                <Plus className="h-4 w-4" /> Create Call Flow
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="overflow-hidden rounded-card border border-border bg-surface-light">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-background-light text-[10px] uppercase tracking-wide text-text-secondary">
              <tr>
                <th className="px-4 py-2.5 text-left">Flow</th>
                <th className="px-4 py-2.5 text-left">Structure</th>
                <th className="px-4 py-2.5 text-left">Assigned numbers</th>
                <th className="px-4 py-2.5 text-left">Recording</th>
                <th className="px-4 py-2.5 text-left">Status</th>
                <th className="px-4 py-2.5 text-left">Updated</th>
                <th className="px-4 py-2.5 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {flows.map((f) => {
                const assigned = numbers.filter((n) => n.flowId === `flow:${f.id}`);
                return (
                  <tr
                    key={f.id}
                    onClick={() => setEditing(f)}
                    className="cursor-pointer align-middle hover:bg-primary/5"
                  >
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-2 font-semibold text-text-primary">
                        <Workflow className="h-4 w-4 text-primary" />
                        {f.name}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-text-secondary">{flowStructureLabel(f.structure)}</td>
                    <td className="px-4 py-3 text-text-secondary">
                      {assigned.length === 0 ? (
                        <span className="text-text-secondary/60">None</span>
                      ) : (
                        <span className="font-mono text-[12px]">
                          {assigned.map((n) => n.number).join(", ")}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {f.record ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-danger/10 px-2 py-0.5 text-[11px] font-semibold text-danger">
                          <span className="h-1.5 w-1.5 rounded-full bg-danger" /> On
                        </span>
                      ) : (
                        <span className="text-[12px] text-text-secondary/60">Off</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {f.status === "active" ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-semibold text-success">
                          <span className="h-1.5 w-1.5 rounded-full bg-success" /> Active
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-background-light px-2 py-0.5 text-[11px] font-semibold text-text-secondary">
                          Draft
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-[12px] text-text-secondary">
                      {formatInstant(f.updatedAt, tz, { month: "short", day: "numeric" })}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditing(f);
                          }}
                          aria-label={`Edit ${f.name}`}
                          className="rounded-md p-1.5 text-text-secondary/70 transition hover:bg-background-light hover:text-text-primary"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        {canManage && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteFlow(f.id);
                            }}
                            aria-label={`Delete ${f.name}`}
                            className="rounded-md p-1.5 text-text-secondary/70 transition hover:bg-danger/10 hover:text-danger"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {choosing && (
        <StructureChoiceModal onClose={() => setChoosing(false)} onPick={startNew} />
      )}
    </div>
  );
}

/* ─────────────────────── Structure choice modal ─────────────────────── */

function StructureChoiceModal({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (s: FlowStructure) => void;
}) {
  return (
    <Modal open onClose={onClose} title="Choose Your Call Flow Structure" size="lg">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <StructureCard
          title="Basic"
          desc="Greeting → connect → voicemail. A straight line for a single team."
          onClick={() => onPick("basic")}
          diagram={
            <div className="flex items-center justify-center gap-1.5 text-text-secondary/70">
              <Megaphone className="h-5 w-5" />
              <span>—</span>
              <PhoneForwarded className="h-5 w-5" />
              <span>—</span>
              <Voicemail className="h-5 w-5" />
            </div>
          }
        />
        <StructureCard
          title="Voice Menu"
          desc="Greeting → 'press 1, 2, 3…' menu that branches to different teams."
          onClick={() => onPick("voice_menu")}
          diagram={
            <div className="flex items-center justify-center gap-1.5 text-text-secondary/70">
              <Megaphone className="h-5 w-5" />
              <span>—</span>
              <ListOrdered className="h-5 w-5" />
              <span>—</span>
              <span className="flex flex-col text-[10px] font-bold leading-tight">
                <span>1·2·3</span>
              </span>
            </div>
          }
        />
      </div>
    </Modal>
  );
}

function StructureCard({
  title,
  desc,
  diagram,
  onClick,
}: {
  title: string;
  desc: string;
  diagram: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col gap-3 rounded-xl border border-border p-4 text-left transition hover:border-primary hover:shadow-md"
    >
      <div className="flex h-20 items-center justify-center rounded-lg bg-background-light group-hover:bg-primary/10">
        {diagram}
      </div>
      <div>
        <p className="text-sm font-semibold text-text-primary">{title}</p>
        <p className="mt-0.5 text-[12px] text-text-secondary">{desc}</p>
      </div>
    </button>
  );
}

/* ─────────────────────────── Builder ─────────────────────────── */

function CallFlowBuilder({
  initial,
  numbers,
  groupOptions,
  people,
  canManage,
  onCancel,
  onSave,
}: {
  initial: CallFlow;
  numbers: FlowNumber[];
  groupOptions: { id: string; label: string }[];
  people: ForwardTarget[];
  canManage: boolean;
  onCancel: () => void;
  onSave: (flow: CallFlow, assignedNumberIds: string[]) => void;
}) {
  const [draft, setDraft] = useState<CallFlow>(initial);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [assigned, setAssigned] = useState<string[]>(
    numbers.filter((n) => n.flowId === `flow:${initial.id}`).map((n) => n.id),
  );

  const selectedNode = useMemo(() => {
    if (!selectedId) return null;
    return [...draft.openNodes, ...draft.closedNodes].find((n) => n.id === selectedId) ?? null;
  }, [selectedId, draft]);

  function patchNode(id: string, patch: Partial<FlowNode>) {
    setDraft((d) => ({
      ...d,
      openNodes: d.openNodes.map((n) => (n.id === id ? ({ ...n, ...patch } as FlowNode) : n)),
      closedNodes: d.closedNodes.map((n) => (n.id === id ? ({ ...n, ...patch } as FlowNode) : n)),
    }));
  }

  function removeNode(id: string) {
    setDraft((d) => ({
      ...d,
      openNodes: d.openNodes.filter((n) => n.id !== id),
      closedNodes: d.closedNodes.filter((n) => n.id !== id),
    }));
    setSelectedId(null);
  }

  // Insert a new node into the open branch right after `afterIndex` (-1 = start).
  function insertOpen(afterIndex: number, type: "greeting" | "forward") {
    const first = people[0];
    const node: FlowNode =
      type === "greeting"
        ? { id: newId("nd"), type: "greeting", message: "" }
        : {
            id: newId("nd"),
            type: "forward",
            target: first ?? { kind: "voicemail" },
          };
    setDraft((d) => {
      const next = [...d.openNodes];
      next.splice(afterIndex + 1, 0, node);
      return { ...d, openNodes: next };
    });
    setSelectedId(node.id);
  }

  return (
    <div className="flex h-full">
      {/* Canvas */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-border bg-surface-light px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="text-[13px] font-semibold text-text-secondary hover:text-text-primary"
          >
            ← Back to call flows
          </button>
          <span className="text-sm font-semibold text-text-primary">
            {draft.name || "New call flow"} · {flowStructureLabel(draft.structure)}
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-auto bg-background-light px-6 py-8">
          <FlowCanvas
            flow={draft}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onInsertOpen={insertOpen}
          />
        </div>
      </div>

      {/* Right rail — Basic Info or the selected node's editor */}
      <aside className="flex w-80 flex-shrink-0 flex-col border-l border-border bg-surface-light">
        {selectedNode ? (
          <NodeEditorPanel
            node={selectedNode}
            groupOptions={groupOptions}
            people={people}
            onChange={(patch) => patchNode(selectedNode.id, patch)}
            onRemove={() => removeNode(selectedNode.id)}
            onClose={() => setSelectedId(null)}
          />
        ) : (
          <BasicInfoPanel
            flow={draft}
            numbers={numbers}
            assigned={assigned}
            onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
            onToggleNumber={(id) =>
              setAssigned((prev) =>
                prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
              )
            }
          />
        )}

        <div className="mt-auto flex items-center gap-2 border-t border-border p-3">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-md border border-border px-3 py-2 text-sm font-semibold text-text-secondary hover:bg-background-light"
          >
            Cancel
          </button>
          {canManage && (
            <button
              type="button"
              onClick={() => onSave(draft, assigned)}
              className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-on-fill hover:bg-primary/90"
            >
              <Save className="h-4 w-4" /> Save flow
            </button>
          )}
        </div>
      </aside>
    </div>
  );
}

/* ─────────────────────────── Canvas ─────────────────────────── */

function FlowCanvas({
  flow,
  selectedId,
  onSelect,
  onInsertOpen,
}: {
  flow: CallFlow;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onInsertOpen: (afterIndex: number, type: "greeting" | "forward") => void;
}) {
  return (
    <div className="mx-auto flex max-w-3xl flex-col items-center">
      {/* Entry */}
      <NodeShell tone="entry" icon={PhoneIncoming} title="Incoming Call" subtitle="When someone calls" />
      <Connector />
      {/* Business hours split */}
      <NodeShell
        tone="hours"
        icon={Clock}
        title="Business Hours"
        subtitle={flow.hoursMode === "always" ? "Always open" : "On a schedule"}
      />
      <Connector />

      <div className="grid w-full grid-cols-2 gap-6">
        {/* Open branch */}
        <div className="flex flex-col items-center">
          <BranchLabel tone="open">Open</BranchLabel>
          <Connector />
          {flow.openNodes.map((n, i) => (
            <div key={n.id} className="flex w-full flex-col items-center">
              <NodeCard node={n} selected={selectedId === n.id} onSelect={() => onSelect(n.id)} />
              {n.type === "menu" && <MenuBranches options={n.options} />}
              <InsertDot onInsert={(type) => onInsertOpen(i, type)} />
            </div>
          ))}
        </div>

        {/* Closed branch */}
        <div className="flex flex-col items-center">
          <BranchLabel tone="closed">Closed</BranchLabel>
          <Connector />
          {flow.closedNodes.map((n) => (
            <div key={n.id} className="flex w-full flex-col items-center">
              <NodeCard node={n} selected={selectedId === n.id} onSelect={() => onSelect(n.id)} />
              <Connector />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function MenuBranches({ options }: { options: MenuOption[] }) {
  return (
    <div className="mt-1 w-full space-y-1.5 rounded-card border border-dashed border-info/20 bg-info/10 p-2">
      {options.map((o) => (
        <div key={o.id} className="flex items-center gap-2 text-[12px]">
          <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-info text-[10px] font-bold text-on-fill">
            {o.digit}
          </span>
          <span className="font-medium text-text-primary">{o.label}</span>
          <span className="text-text-secondary/70">→ {targetLabel(o.target)}</span>
        </div>
      ))}
    </div>
  );
}

function NodeCard({
  node,
  selected,
  onSelect,
}: {
  node: FlowNode;
  selected: boolean;
  onSelect: () => void;
}) {
  const meta = NODE_META[node.type];
  const Icon = meta.icon;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={[
        "flex w-full items-center gap-2.5 rounded-lg border bg-surface-light px-3 py-2.5 text-left shadow-sm transition",
        selected ? "border-primary ring-2 ring-primary/20" : "border-border hover:border-text-secondary/40",
      ].join(" ")}
    >
      <span className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-background-light ${meta.accent}`}>
        <Icon className="h-4 w-4" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-[13px] font-semibold text-text-primary">{meta.label}</span>
        <span className="truncate text-[11px] text-text-secondary">{nodeSubtitle(node)}</span>
      </span>
    </button>
  );
}

function NodeShell({
  icon: Icon,
  title,
  subtitle,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
  tone: "entry" | "hours";
}) {
  return (
    <div
      className={[
        "flex w-64 items-center gap-2.5 rounded-card border-t-4 bg-surface-light px-3 py-2.5 shadow-sm",
        tone === "entry" ? "border-t-danger border-x border-b border-border" : "border-t-info border-x border-b border-border",
      ].join(" ")}
    >
      <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-background-light text-text-secondary">
        <Icon className="h-4 w-4" />
      </span>
      <span className="flex flex-col">
        <span className="text-[13px] font-semibold text-text-primary">{title}</span>
        <span className="text-[11px] text-text-secondary">{subtitle}</span>
      </span>
    </div>
  );
}

function Connector() {
  return <span className="my-1 block h-5 w-px bg-border" />;
}

function BranchLabel({ children, tone }: { children: React.ReactNode; tone: "open" | "closed" }) {
  return (
    <span
      className={[
        "rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
        tone === "open" ? "bg-success/10 text-success" : "bg-background-light text-text-secondary",
      ].join(" ")}
    >
      {children}
    </span>
  );
}

/** The "+" between steps — opens a tiny menu to insert a Greeting or Forward. */
function InsertDot({ onInsert }: { onInsert: (type: "greeting" | "forward") => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1 flex flex-col items-center">
      <span className="h-2.5 w-px bg-border" />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Add a step"
            className="flex h-5 w-5 items-center justify-center rounded-full border border-dashed border-border bg-surface-light text-text-secondary/70 transition hover:border-primary hover:text-primary"
          >
            <Plus className="h-3 w-3" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="center" className="w-36 p-1">
          <button
            type="button"
            onClick={() => {
              onInsert("greeting");
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-[13px] text-text-primary hover:bg-background-light"
          >
            <Megaphone className="h-3.5 w-3.5 text-primary" /> Greeting
          </button>
          <button
            type="button"
            onClick={() => {
              onInsert("forward");
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-[13px] text-text-primary hover:bg-background-light"
          >
            <PhoneForwarded className="h-3.5 w-3.5 text-success" /> Forward
          </button>
        </PopoverContent>
      </Popover>
      <span className="h-2.5 w-px bg-border" />
    </div>
  );
}

/* ─────────────────────────── Node editor ─────────────────────────── */

function NodeEditorPanel({
  node,
  groupOptions,
  people,
  onChange,
  onRemove,
  onClose,
}: {
  node: FlowNode;
  groupOptions: { id: string; label: string }[];
  people: ForwardTarget[];
  onChange: (patch: Partial<FlowNode>) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const meta = NODE_META[node.type];
  const Icon = meta.icon;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <span className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          <Icon className={`h-4 w-4 ${meta.accent}`} /> {meta.label}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close editor"
          className="rounded-md p-1 text-text-secondary/70 hover:bg-background-light"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-4 p-4">
        {node.type === "greeting" && (
          <Field label="Greeting message">
            <textarea
              value={node.message}
              onChange={(e) => onChange({ message: e.target.value })}
              rows={4}
              placeholder="What the caller hears…"
              className="w-full resize-none rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </Field>
        )}

        {node.type === "voicemail" && (
          <Field label="Voicemail greeting">
            <textarea
              value={node.message}
              onChange={(e) => onChange({ message: e.target.value })}
              rows={4}
              placeholder="Message played before the beep…"
              className="w-full resize-none rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </Field>
        )}

        {node.type === "forward" && (
          <Field label="Connect the call to">
            <TargetEditor
              target={node.target}
              groupOptions={groupOptions}
              people={people}
              onChange={(target) => onChange({ target })}
            />
          </Field>
        )}

        {node.type === "menu" && (
          <>
            <Field label="Menu prompt">
              <textarea
                value={node.prompt}
                onChange={(e) => onChange({ prompt: e.target.value })}
                rows={3}
                className="w-full resize-none rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            </Field>
            <Field label="Options">
              <div className="space-y-2">
                {node.options.map((o) => (
                  <div key={o.id} className="rounded-md border border-border p-2">
                    <div className="flex items-center gap-2">
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-info text-[10px] font-bold text-on-fill">
                        {o.digit}
                      </span>
                      <input
                        value={o.label}
                        onChange={(e) =>
                          onChange({
                            options: node.options.map((x) =>
                              x.id === o.id ? { ...x, label: e.target.value } : x,
                            ),
                          })
                        }
                        placeholder="Option label"
                        className="min-w-0 flex-1 rounded border border-border px-2 py-1 text-[13px] focus:border-primary focus:outline-none"
                      />
                      <button
                        type="button"
                        aria-label="Remove option"
                        onClick={() =>
                          onChange({ options: node.options.filter((x) => x.id !== o.id) })
                        }
                        className="rounded p-1 text-text-secondary/70 hover:bg-danger/10 hover:text-danger"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <div className="mt-2">
                      <TargetEditor
                        target={o.target}
                        groupOptions={groupOptions}
                        people={people}
                        onChange={(target) =>
                          onChange({
                            options: node.options.map((x) =>
                              x.id === o.id ? { ...x, target } : x,
                            ),
                          })
                        }
                      />
                    </div>
                  </div>
                ))}
                {node.options.length < 9 && (
                  <button
                    type="button"
                    onClick={() =>
                      onChange({
                        options: [
                          ...node.options,
                          {
                            id: newId("op"),
                            digit: String(node.options.length + 1),
                            label: "",
                            target: { kind: "voicemail" },
                          },
                        ],
                      })
                    }
                    className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border py-1.5 text-[13px] font-semibold text-primary hover:bg-primary/10"
                  >
                    <Plus className="h-3.5 w-3.5" /> Add option
                  </button>
                )}
              </div>
            </Field>
          </>
        )}

        <button
          type="button"
          onClick={onRemove}
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-danger/20 py-2 text-[13px] font-semibold text-danger hover:bg-danger/10"
        >
          <Trash2 className="h-3.5 w-3.5" /> Remove this step
        </button>
      </div>
    </div>
  );
}

/** Destination picker shared by Forward nodes and menu options. */
function TargetEditor({
  target,
  groupOptions,
  people,
  onChange,
}: {
  target: ForwardTarget;
  groupOptions: { id: string; label: string }[];
  people: ForwardTarget[];
  onChange: (t: ForwardTarget) => void;
}) {
  const kinds: { key: ForwardTarget["kind"]; label: string }[] = [
    { key: "person", label: "Person" },
    { key: "group", label: "Group" },
    { key: "number", label: "Number" },
    { key: "voicemail", label: "Voicemail" },
  ];

  function pickKind(kind: ForwardTarget["kind"]) {
    if (kind === target.kind) return;
    if (kind === "person") onChange(people[0] ?? { kind: "voicemail" });
    else if (kind === "group") {
      const g = groupOptions[0];
      onChange(g ? { kind: "group", id: g.id, label: g.label } : { kind: "voicemail" });
    } else if (kind === "number") onChange({ kind: "number", value: "" });
    else onChange({ kind: "voicemail" });
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {kinds.map((k) => (
          <button
            key={k.key}
            type="button"
            onClick={() => pickKind(k.key)}
            className={[
              "rounded-full px-2.5 py-1 text-[11px] font-semibold transition",
              target.kind === k.key
                ? "bg-primary text-on-fill"
                : "bg-background-light text-text-secondary hover:bg-border",
            ].join(" ")}
          >
            {k.label}
          </button>
        ))}
      </div>

      {target.kind === "person" && (
        <MiniSelect
          value={target.id}
          options={people.map((t) => ({ id: (t as { id: string }).id, label: targetLabel(t) }))}
          onChange={(id) => {
            const t = people.find((x) => (x as { id: string }).id === id);
            if (t) onChange(t);
          }}
        />
      )}
      {target.kind === "group" &&
        (groupOptions.length === 0 ? (
          <p className="rounded-md bg-warning/10 px-3 py-2 text-[12px] text-warning">
            No call groups yet — create one on the Call groups tab.
          </p>
        ) : (
          <MiniSelect
            value={target.id}
            options={groupOptions}
            onChange={(id) => {
              const g = groupOptions.find((x) => x.id === id);
              if (g) onChange({ kind: "group", id: g.id, label: g.label });
            }}
          />
        ))}
      {target.kind === "number" && (
        <input
          value={target.value}
          onChange={(e) => onChange({ kind: "number", value: e.target.value })}
          placeholder="(555) 123-4567"
          className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
      )}
      {target.kind === "voicemail" && (
        <p className="rounded-md bg-background-light px-3 py-2 text-[12px] text-text-secondary">
          The caller is sent to voicemail.
        </p>
      )}
    </div>
  );
}

function MiniSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { id: string; label: string }[];
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.id === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center justify-between gap-2 rounded-md border border-border bg-surface-light px-3 py-2 text-left text-sm hover:border-text-secondary/40"
        >
          <span className="truncate text-text-primary">{selected?.label ?? "Select…"}</span>
          <ChevronDown className={`h-4 w-4 flex-shrink-0 text-text-secondary/70 transition ${open ? "rotate-180" : ""}`} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[--radix-popover-trigger-width] max-h-60 overflow-auto p-1">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            onClick={() => {
              onChange(o.id);
              setOpen(false);
            }}
            className={[
              "block w-full px-3 py-2 text-left text-[13px] transition",
              o.id === value ? "bg-info font-semibold text-on-fill" : "text-text-primary hover:bg-background-light",
            ].join(" ")}
          >
            {o.label}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
        {label}
      </span>
      {children}
    </label>
  );
}

/* ─────────────────────────── Basic Info ─────────────────────────── */

function BasicInfoPanel({
  flow,
  numbers,
  assigned,
  onChange,
  onToggleNumber,
}: {
  flow: CallFlow;
  numbers: FlowNumber[];
  assigned: string[];
  onChange: (patch: Partial<CallFlow>) => void;
  onToggleNumber: (id: string) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="border-b border-border px-4 py-3">
        <span className="text-sm font-semibold text-text-primary">Basic Info</span>
        <p className="mt-0.5 text-[11px] text-text-secondary">Click any step on the left to edit it.</p>
      </div>

      <div className="space-y-4 p-4">
        <Field label="Flow name">
          <input
            value={flow.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="e.g. Main line"
            className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </Field>

        <Field label="Business hours">
          <div className="flex gap-1">
            {(["always", "schedule"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => onChange({ hoursMode: m })}
                className={[
                  "flex-1 rounded-md px-2.5 py-1.5 text-[12px] font-semibold transition",
                  flow.hoursMode === m
                    ? "bg-primary text-on-fill"
                    : "bg-background-light text-text-secondary hover:bg-border",
                ].join(" ")}
              >
                {m === "always" ? "Always open" : "On a schedule"}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Assigned numbers">
          {numbers.length === 0 ? (
            <p className="text-[12px] text-text-secondary/60">No numbers to assign.</p>
          ) : (
            <div className="space-y-1.5">
              {numbers.map((n) => {
                const on = assigned.includes(n.id);
                return (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => onToggleNumber(n.id)}
                    className={[
                      "flex w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm transition",
                      on ? "border-primary bg-primary/10" : "border-border hover:bg-background-light",
                    ].join(" ")}
                  >
                    <span className="font-mono text-[13px] text-text-primary">{n.number}</span>
                    <span
                      className={[
                        "flex h-4 w-4 items-center justify-center rounded border",
                        on ? "border-primary bg-primary text-on-fill" : "border-border",
                      ].join(" ")}
                    >
                      {on && <Play className="h-2.5 w-2.5 rotate-0" />}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          <p className="mt-1 text-[11px] text-text-secondary/60">
            Select the number(s) you want this flow to answer.
          </p>
        </Field>

        <Field label="Recording">
          <button
            type="button"
            onClick={() => onChange({ record: !flow.record })}
            className="flex w-full items-center justify-between rounded-md border border-border px-3 py-2.5"
          >
            <span className="text-[13px] text-text-primary">Record &amp; save calls in this flow</span>
            <span
              className={[
                "relative h-5 w-9 flex-shrink-0 rounded-full transition",
                flow.record ? "bg-success" : "bg-border",
              ].join(" ")}
            >
              <span
                className={[
                  "absolute top-0.5 h-4 w-4 rounded-full bg-on-fill shadow transition",
                  flow.record ? "left-[18px]" : "left-0.5",
                ].join(" ")}
              />
            </span>
          </button>
        </Field>
      </div>
    </div>
  );
}
