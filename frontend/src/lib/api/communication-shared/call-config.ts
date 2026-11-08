// Call-flow / call-group / phone-plan configuration seed data for the
// Communication hub's Phone settings. Lifted out of the prototype's CallFlows,
// CallGroups, and PhonePage components into a self-contained mock module so the
// data seam owns it. The roster identities Emanuel's components resolved at
// runtime (currentUser / phoneAgents / techs) are inlined here as literal seed
// values so this module has no cross-module or component dependencies.
// Prototype seeds; production reads from the telephony provider's config API.

/* ─────────────────────────── Call-flow model ─────────────────────────── */

export type FlowStructure = "basic" | "voice_menu";

/** Where a Forward / menu option sends the call. */
export type ForwardTarget =
  | { kind: "person"; id: string; label: string }
  | { kind: "group"; id: string; label: string }
  | { kind: "number"; value: string }
  | { kind: "voicemail" };

export type MenuOption = {
  id: string;
  digit: string; // "1".."9", "0"
  label: string; // "Sales", "Service", …
  target: ForwardTarget;
};

/** An editable step in a flow branch. The entry (Incoming) and the Business
 *  Hours split are structural and rendered by the canvas, not stored as nodes. */
export type FlowNode =
  | { id: string; type: "greeting"; message: string }
  | { id: string; type: "forward"; target: ForwardTarget }
  | { id: string; type: "menu"; prompt: string; options: MenuOption[] }
  | { id: string; type: "voicemail"; message: string };

export type CallFlow = {
  id: string;
  name: string;
  structure: FlowStructure;
  record: boolean;
  status: "active" | "draft";
  updatedAt: string; // ISO
  hoursMode: "always" | "schedule";
  /** Open-hours branch (linear chain; a menu node fans out via its options). */
  openNodes: FlowNode[];
  /** Closed-hours branch (typically a single voicemail). */
  closedNodes: FlowNode[];
};

/* ─────────────────────────── Call-flow helpers ─────────────────────────── */

export function flowStructureLabel(s: FlowStructure): string {
  return s === "basic" ? "Basic" : "Voice Menu";
}

/** Options PhonePage feeds into the Phone-numbers FlowSelect ("My flows"). */
export function customFlowOptions(flows: CallFlow[]): { id: string; label: string }[] {
  return flows.map((f) => ({ id: `flow:${f.id}`, label: f.name }));
}

/** Resolve a number's flowId (e.g. "flow:cf_123") back to a flow name. */
export function flowNameForId(flows: CallFlow[], flowId: string): string | undefined {
  if (!flowId.startsWith("flow:")) return undefined;
  return flows.find((f) => `flow:${f.id}` === flowId)?.name;
}

/* ─────────────────────────── Call-group model ─────────────────────────── */

export type RingStrategy = "all" | "round_robin";
export type GroupDevice = "cell" | "softphone";

export type CallGroupMember = {
  personId: string;
  name: string;
  device: GroupDevice;
};

export type CallGroup = {
  id: string;
  name: string;
  ring: RingStrategy;
  members: CallGroupMember[];
  updatedAt: string; // ISO
};

export function ringLabel(r: RingStrategy): string {
  return r === "all" ? "Ring all at once" : "Round-robin";
}

/** Options PhonePage feeds into the flow builder's Forward → Group picker. */
export function groupTargetOptions(groups: CallGroup[]): { id: string; label: string }[] {
  return groups.map((g) => ({ id: g.id, label: g.name }));
}

/* ─────────────────────────── Phone plan / numbers ─────────────────────────── */

export const BUSINESS_NUMBER = "(551) 282-7064";

// Plan usage is no longer seeded here — the Phone header meters read real
// per-cycle usage from GET /api/communication/usage (see lib/comm-usage.ts).

/** One-time price charged per provisioned number (prototype). */
export const NUMBER_PRICE = 2;

export const MASKING_NUMBER = "(646) 718-4893";
