/**
 * Bee agent: conversation-flow schema, validation and prompt compiler (backend).
 *
 * Deterministically compiles an AgentFlow JSON structure into the complete
 * system prompt for Voice Calling Engines (Vapi, etc.).
 */

export type VarKey =
  | "customer.first_name" | "customer.last_name" | "customer.email" | "customer.phone"
  | "agent.name" | "company.name"
  | "job.number" | "job.type" | "job.equipment" | "job.service_address"
  | "job.completed_date" | "job.assigned_team"
  | "warranty.plan_name" | "warranty.end_date" | "warranty.days_left"
  | "offer.early_discount"
  | "invoice.date" | "invoice.total";

export interface VarDef {
  key: VarKey;
  label: string;
  group: "Customer" | "Agent" | "Company" | "Job" | "Warranty" | "Offer" | "Invoice";
  example: string;
  internal?: boolean;
}

export const VARIABLES: VarDef[] = [
  { key: "customer.first_name", label: "Customer first name", group: "Customer", example: "Umer" },
  { key: "customer.last_name", label: "Customer last name", group: "Customer", example: "Nasir" },
  { key: "customer.email", label: "Customer email", group: "Customer", example: "umer@example.com" },
  { key: "customer.phone", label: "Customer phone", group: "Customer", example: "+92 300 0000000" },
  { key: "agent.name", label: "Agent name", group: "Agent", example: "Sarah" },
  { key: "company.name", label: "Company name", group: "Company", example: "ServWave" },
  { key: "job.number", label: "Job number", group: "Job", example: "J00187" },
  { key: "job.type", label: "Job type", group: "Job", example: "HVAC Service" },
  { key: "job.equipment", label: "Equipment", group: "Job", example: "HVAC split system" },
  { key: "job.service_address", label: "Service address", group: "Job", example: "14 Garden Road" },
  { key: "job.completed_date", label: "Visit date", group: "Job", example: "March 4" },
  { key: "job.assigned_team", label: "Assigned team", group: "Job", example: "Team North" },
  { key: "warranty.plan_name", label: "Warranty plan name", group: "Warranty", example: "Basic Parts" },
  { key: "warranty.end_date", label: "Warranty end date", group: "Warranty", example: "December 2" },
  { key: "warranty.days_left", label: "Days until warranty ends", group: "Warranty", example: "14" },
  { key: "offer.early_discount", label: "Early renewal discount", group: "Offer", example: "10%" },
  { key: "invoice.date", label: "Invoice date", group: "Invoice", example: "March 6" },
  { key: "invoice.total", label: "Invoice total", group: "Invoice", example: "$240" },
];
export const VAR_KEYS = new Set<string>(VARIABLES.map(v => v.key));

export type Outcome =
  | { type: "next" }
  | { type: "goto"; stepId: string }
  | { type: "objection"; objectionId: string }
  | { type: "callback" }
  | { type: "transfer" }
  | { type: "do_not_call" }
  | { type: "end_call" };

export interface Branch {
  id: string;
  when: string;
  outcome: Outcome;
}

export interface Step {
  id: string;
  title: string;
  goal: string;
  line: string;
  mode: "exact" | "guide";
  attachPlans?: boolean;
  branches: Branch[];
}

export interface Objection {
  id: string;
  name: string;
  examples: string[];
  reply: string;
  after: Outcome;
}

export const RETURN = "__return__";

export type GuardrailId =
  | "short_replies"
  | "only_linked_prices"
  | "honor_stop"
  | "disclose_ai"
  | "handoff_upset"
  | "hide_internal";

export interface AgentFlow {
  version: 1;
  persona: { agentName: string; tone: string; language: string };
  steps: Step[];
  objections: Objection[];
  guardrails: Record<GuardrailId, boolean>;
  customRules: string[];
}

export const GUARDRAIL_TEXT: Record<GuardrailId, string> = {
  short_replies: "Speak in one or two short sentences, then stop and let the customer respond.",
  only_linked_prices:
    "Only mention prices, discounts and dates that appear in OFFERABLE PLANS or CUSTOMER CONTEXT. Never invent or estimate them.",
  honor_stop:
    "If the customer asks not to be called again, apologise, confirm, trigger do_not_call and end the call.",
  disclose_ai:
    "If asked whether you are a person or an AI, say honestly that you are an AI assistant calling for the company.",
  handoff_upset:
    "If the customer is angry or upset, stop selling, apologise and trigger transfer.",
  hide_internal: "Never mention internal costs, margins or notes.",
};

export interface Issue {
  level: "error" | "warning";
  where: string;
  message: string;
}

const TOKEN_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g;

export function tokensIn(text: string): string[] {
  const matches: string[] = [];
  const re = new RegExp(TOKEN_RE.source, TOKEN_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) matches.push(m[1]);
  }
  return matches;
}

export function validateFlow(flow: AgentFlow): Issue[] {
  const issues: Issue[] = [];
  const stepIds = new Set(flow.steps.map(s => s.id));
  const objIds = new Set(flow.objections.map(o => o.id));
  const internal = new Set(VARIABLES.filter(v => v.internal).map(v => v.key));

  if (flow.steps.length === 0) issues.push({ level: "error", where: "flow", message: "Add at least one step." });
  if (stepIds.size !== flow.steps.length) issues.push({ level: "error", where: "flow", message: "Two steps share the same id." });

  const checkText = (text: string, where: string) => {
    for (const t of tokensIn(text)) {
      if (!VAR_KEYS.has(t)) issues.push({ level: "error", where, message: `"${t}" isn't a known customer or job detail.` });
      else if (internal.has(t as VarKey)) issues.push({ level: "error", where, message: `"${t}" is internal and can't be spoken.` });
    }
    const stray = text.replace(TOKEN_RE, "").match(/\{|\}/);
    if (stray) issues.push({ level: "error", where, message: "Has a broken {{ }} placeholder." });
  };

  const checkOutcome = (o: Outcome, where: string, isLast: boolean) => {
    if (o.type === "goto" && o.stepId !== RETURN && !stepIds.has(o.stepId))
      issues.push({ level: "error", where, message: `Goes to a step that no longer exists (${o.stepId}).` });
    if (o.type === "objection" && !objIds.has(o.objectionId))
      issues.push({ level: "error", where, message: `Uses an objection that no longer exists (${o.objectionId}).` });
    if (o.type === "next" && isLast)
      issues.push({ level: "error", where, message: `"Next step" on the last step. Choose End call instead.` });
  };

  flow.steps.forEach((s, i) => {
    const where = `Step ${i + 1} · ${s.title}`;
    if (!s.goal.trim()) issues.push({ level: "warning", where, message: "Add a goal so Bee can recover when the customer goes off-script." });
    if (!s.line.trim()) issues.push({ level: "error", where, message: "Bee has nothing to say here." });
    checkText(s.line, where);
    if (s.branches.length === 0) issues.push({ level: "error", where, message: "Add at least one customer answer." });
    s.branches.forEach(b => checkOutcome(b.outcome, `${where} → "${b.when}"`, i === flow.steps.length - 1));
  });

  const reached = new Set<string>();
  const queue = flow.steps.length > 0 && flow.steps[0] ? [flow.steps[0].id] : [];
  const objById = new Map(flow.objections.map(o => [o.id, o]));
  const follow = (o: Outcome, fromIdx: number) => {
    if (o.type === "next" && flow.steps[fromIdx + 1]) queue.push(flow.steps[fromIdx + 1]!.id);
    if (o.type === "goto" && o.stepId !== RETURN) queue.push(o.stepId);
    if (o.type === "objection") {
      const ob = objById.get(o.objectionId);
      if (ob && ob.after.type !== "objection") follow(ob.after, fromIdx);
    }
  };
  while (queue.length) {
    const id = queue.shift()!;
    if (!id || reached.has(id)) continue;
    reached.add(id);
    const idx = flow.steps.findIndex(s => s.id === id);
    if (idx >= 0 && flow.steps[idx]) flow.steps[idx]!.branches.forEach(b => follow(b.outcome, idx));
  }
  flow.steps.forEach((s, i) => {
    if (!reached.has(s.id)) issues.push({ level: "warning", where: `Step ${i + 1} · ${s.title}`, message: "No answer leads here, so Bee will never reach it." });
  });

  flow.objections.forEach(o => {
    const where = `Objection · ${o.name}`;
    checkText(o.reply, where);
    if (o.after.type === "objection") issues.push({ level: "error", where, message: "An objection can't lead to another objection." });
    else checkOutcome(o.after, where, false);
  });
  return issues;
}

export interface Plan {
  name: string;
  price: string;
  term: string;
  includes: string;
}

const stepLabel = (flow: AgentFlow, id: string) => {
  if (id === RETURN) return "return to the step you were on";
  const i = flow.steps.findIndex(s => s.id === id);
  return i < 0 ? id : `go to STEP ${i + 1} [${id}]`;
};

function describeOutcome(flow: AgentFlow, o: Outcome, idx: number): string {
  switch (o.type) {
    case "next": return stepLabel(flow, flow.steps[idx + 1]?.id ?? "");
    case "goto": return stepLabel(flow, o.stepId);
    case "objection": return `handle objection [${o.objectionId}]`;
    case "callback": return "ask for a good time, call schedule_callback, then end the call";
    case "transfer": return "call transfer_to_office";
    case "do_not_call": return "call add_to_do_not_call, then end the call";
    case "end_call": return "say goodbye and call end_call";
  }
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

export function compilePrompt(flow: AgentFlow, plans: Plan[]): string {
  const errors = validateFlow(flow).filter(i => i.level === "error");
  if (errors.length) {
    // If there are soft errors during execution, log and proceed with available steps instead of crashing
    console.warn("[BeeAgentFlow] Flow validation errors:", errors.map(e => `${e.where}: ${e.message}`));
  }

  const out: string[] = [];
  const p = flow.persona || { agentName: "Emma", tone: "Warm, helpful, and consultative", language: "English (US)" };
  out.push(
    "# ROLE",
    `You are ${p.agentName}, calling on behalf of {{company.name}} about an expiring equipment warranty.`,
    `Tone: ${p.tone}. Language: ${p.language}.`,
    "This is a phone call: no lists, no markdown, no reading out symbols or IDs.",
    "",
    "# HOW TO USE THE CALL FLOW",
    "Work through the steps in order, starting at STEP 1.",
    "In each step, say the Line, then listen. Match the customer's reply to a Branch and do what it says.",
    'Mode "exact": say the Line word for word. Mode "guide": say it naturally in your own words but keep every fact.',
    "If the reply matches no branch, answer briefly using the step Goal, then repeat the question.",
    "Objections can come up at any step; handle them with the OBJECTIONS section.",
    "Replace every {{placeholder}} with its value from CUSTOMER CONTEXT. If a value is missing, rephrase without it; never say the placeholder.",
    "",
    "# CALL FLOW",
  );

  flow.steps.forEach((s, i) => {
    out.push("", `## STEP ${i + 1} [${s.id}] ${s.title}`, `Goal: ${s.goal}`, `Line (${s.mode}): "${s.line}"`);
    if (s.attachPlans) {
      out.push("Offerable plans (only these):");
      plans.forEach(pl => out.push(`- ${pl.name}: ${pl.price}, ${pl.term}. Includes ${pl.includes}.`));
    }
    out.push("Branches:");
    s.branches.forEach(b => out.push(`- If the customer ${lowerFirst(b.when)}: ${describeOutcome(flow, b.outcome, i)}.`));
  });

  if (flow.objections && flow.objections.length) {
    out.push("", "# OBJECTIONS");
    flow.objections.forEach(o => {
      out.push(
        "",
        `## [${o.id}] ${o.name}`,
        `Sounds like: ${o.examples.map(e => `"${e}"`).join(", ")}`,
        `Respond: ${o.reply}`,
        `Then: ${describeOutcome(flow, o.after, -1)}.`,
      );
    });
  }

  out.push("", "# RULES (always apply, override everything above)");
  const guardrails = flow.guardrails || ({} as Record<GuardrailId, boolean>);
  (Object.keys(GUARDRAIL_TEXT) as GuardrailId[]).forEach(g => {
    if (guardrails[g]) out.push(`- ${GUARDRAIL_TEXT[g]}`);
  });
  if (Array.isArray(flow.customRules)) {
    flow.customRules.filter(r => r && r.trim()).forEach(r => out.push(`- ${r.trim()}`));
  }

  out.push("", "# CUSTOMER CONTEXT", "{{__context__}}");
  return out.join("\n");
}

export function buildContext(values: Partial<Record<VarKey, string | null | undefined>>): string {
  return VARIABLES.filter(v => !v.internal)
    .map(v => `${v.key}: ${values[v.key] ?? "(unknown, do not guess)"}`)
    .join("\n");
}

export function finalPrompt(compiled: string, values: Partial<Record<VarKey, string | null | undefined>>): string {
  return compiled.replace("{{__context__}}", buildContext(values));
}

/**
 * Interpolates tokens directly in a line or string for spoken firstMessage.
 */
export function interpolateLine(line: string, values: Record<string, string>): string {
  return line.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_match, key) => {
    return values[key] !== undefined && values[key] !== null ? values[key] : "";
  }).replace(/\s{2,}/g, " ").trim();
}
