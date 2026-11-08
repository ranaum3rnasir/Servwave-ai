// Phone module — Texting view.
//
// Ported from Emanuel's PhonePage monolith (region L8413–9312). The Texting
// tab: messaging compliance (Caller ID), messaging settings (forwarding + job
// closing), editable text templates with merge-field chips and custom-template
// creation, texting automations (triggered sends), and a plain-English
// SMS-compliance panel. PHONE-SYSTEM-PRD §14.19.
//
// Cut-and-reskin notes:
//   • Tokens swapped indigo/slate → ALPHA design tokens. emerald/amber/rose/
//     sky/violet status tints are kept verbatim.
//   • Data comes from the `@/lib/api/communication` seam: useTextTemplates /
//     useTextAutomations seed the editable local state; useSaveTemplate /
//     useSaveAutomation are the (mock) paid-action hooks fired on save. Label
//     maps + merge fields (MERGE_FIELDS, mergeLabel, TEXT_TRIGGERS,
//     TIMING_OPTIONS, SMS_COMPLIANCE, OPT_OUT_FOOTER, SMS_LEGAL_DISCLAIMER) are
//     plain values from the seam.
//   • CASL gates write affordances (New template / New automation / Save) behind
//     manage Communication; the view requires read (coarse subject), mirroring
//     NumbersView. The `onToast` prop is preserved (the shell wires it).
//   • The monolith's portaled `CleanSelect` helper is now the shared kernel
//     copy (`@/components/communication/phone/shared`) — deduped with the
//     near-identical copy that lived in CallMaskingView.tsx, tone="info" to
//     preserve this view's original accent color.
//   • The module-scope mutable id counters + nextCustomTplId / nextAutomationId
//     stay file-local consts (they only mint mock ids).
//   • NewTemplateModal / AutomationModal now compose the shared `ui/modal`
//     primitive instead of a hand-rolled createPortal overlay.

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Info,
  MessageSquare,
  Plus,
  RotateCw,
  Shield,
  ShieldCheck,
  Sparkles,
  Trash2,
  Zap,
} from "lucide-react";
import {
  useTextTemplates,
  useTextAutomations,
  useSaveTemplate,
  useSaveAutomation,
  MERGE_FIELDS,
  mergeLabel,
  TEXT_TRIGGERS,
  TIMING_OPTIONS,
  SMS_COMPLIANCE,
  OPT_OUT_FOOTER,
  SMS_LEGAL_DISCLAIMER,
} from "@/lib/api/communication";
import type {
  TextTemplate,
  TextAutomation,
  TextTrigger,
  TextAudience,
} from "@/lib/api/communication";
import { useAppAbility } from "@/contexts/AbilityContext";
import { useAuthStore } from "@/stores/auth.store";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/ui/empty-state";
import { Modal } from "@/components/ui/modal";
import { CleanSelect } from "@/components/communication/phone/shared";

/* ─────────────────── Mock id minting (TextingView-local) ───────────────────
 * Module-scope mutable counters — these only generate mock client ids for
 * newly-created templates/automations and never touch the seam. */
let customTplSeq = 0;
const nextCustomTplId = () => `tpl_custom_${Date.now()}_${customTplSeq++}`;
let automationSeq = 0;
const nextAutomationId = () => `au_custom_${Date.now()}_${automationSeq++}`;

/* ─────────────────── Small presentational helpers ─────────────────── */

function InfoDot({ text }: { text: string }) {
  return (
    <span
      title={text}
      className="inline-flex h-4 w-4 cursor-help items-center justify-center text-text-secondary"
    >
      <Info className="h-3.5 w-3.5" />
    </span>
  );
}

function AudienceBadge({ audience }: { audience: TextAudience }) {
  const customer = audience === "customer";
  return (
    <span
      className={[
        "rounded-full px-2 py-0.5 text-[10px] font-semibold",
        customer ? "bg-info/10 text-info" : "bg-primary/10 text-primary",
      ].join(" ")}
    >
      {customer ? "To customer" : "To team"}
    </span>
  );
}

/** A clickable merge-field chip — inserts `{{token}}` at the caret. */
function MergeChip({ token, onClick }: { token: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Insert {{${token}}}`}
      className="rounded bg-primary px-2 py-0.5 text-[12px] font-medium text-on-fill transition hover:bg-primary-dark"
    >
      {mergeLabel(token)}
    </button>
  );
}

function TemplateCard({
  tpl,
  onChange,
  onReset,
  onDelete,
}: {
  tpl: TextTemplate;
  onChange: (id: string, patch: Partial<TextTemplate>) => void;
  onReset: (id: string) => void;
  onDelete?: (id: string) => void;
}) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  function insert(token: string) {
    const ins = `{{${token}}}`;
    const ta = taRef.current;
    const start = ta ? ta.selectionStart : tpl.body.length;
    const end = ta ? ta.selectionEnd : tpl.body.length;
    const next = tpl.body.slice(0, start) + ins + tpl.body.slice(end);
    onChange(tpl.id, { body: next });
    requestAnimationFrame(() => {
      if (ta) {
        const pos = start + ins.length;
        ta.focus();
        ta.setSelectionRange(pos, pos);
      }
    });
  }

  return (
    <Card padding="sm" flat>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold text-text-primary">{tpl.name}</p>
          <InfoDot text={tpl.info} />
          <AudienceBadge audience={tpl.audience} />
          {tpl.kind === "custom" && (
            <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-semibold text-warning">
              Custom
            </span>
          )}
        </div>
        {tpl.kind === "preset" ? (
          <button
            type="button"
            onClick={() => onReset(tpl.id)}
            className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-primary hover:text-primary/90"
          >
            <RotateCw className="h-4 w-4" /> Reset to default
          </button>
        ) : (
          onDelete && (
            <button
              type="button"
              onClick={() => onDelete(tpl.id)}
              className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-danger hover:text-danger"
            >
              <Trash2 className="h-4 w-4" /> Delete
            </button>
          )
        )}
      </div>

      <textarea
        ref={taRef}
        value={tpl.body}
        onChange={(e) => onChange(tpl.id, { body: e.target.value })}
        rows={tpl.body.split("\n").length + 1}
        className="w-full rounded-md border border-border bg-surface-light p-3 text-[13px] leading-relaxed text-text-secondary focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
      />

      {tpl.id === "tpl_job" && (
        <p className="mt-1.5 text-[12px] text-text-secondary">
          Clicking “Send Job” will apply this template. Appointment time will only
          be displayed for future jobs.
        </p>
      )}

      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {tpl.fields.map((token) => (
          <MergeChip key={token} token={token} onClick={() => insert(token)} />
        ))}
      </div>

      {tpl.notifyToggle && (
        <label className="mt-3 flex cursor-pointer items-center gap-2 text-[13px] text-text-secondary">
          <input
            type="checkbox"
            checked={!!tpl.notifyOn}
            onChange={(e) => onChange(tpl.id, { notifyOn: e.target.checked })}
            className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
          />
          Notify me when tech sends this message
        </label>
      )}
    </Card>
  );
}

function NewTemplateModal({
  onClose,
  onAdd,
}: {
  onClose: () => void;
  onAdd: (name: string, body: string, audience: TextAudience) => void;
}) {
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [audience, setAudience] = useState<TextAudience>("customer");
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  function insert(token: string) {
    const ins = `{{${token}}}`;
    const ta = taRef.current;
    const start = ta ? ta.selectionStart : body.length;
    const end = ta ? ta.selectionEnd : body.length;
    const next = body.slice(0, start) + ins + body.slice(end);
    setBody(next);
    requestAnimationFrame(() => {
      if (ta) {
        const pos = start + ins.length;
        ta.focus();
        ta.setSelectionRange(pos, pos);
      }
    });
  }

  const canAdd = name.trim() && body.trim();

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title="New text template"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border bg-surface-light px-3 py-2 text-[13px] font-semibold text-text-secondary hover:bg-background-light"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canAdd}
            onClick={() => onAdd(name.trim(), body, audience)}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-[13px] font-semibold text-on-fill hover:bg-primary/90 disabled:opacity-40"
          >
            <Plus className="h-4 w-4" /> Add template
          </button>
        </>
      }
    >
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-[12px] font-semibold text-text-secondary">Template name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Quote follow-up"
              autoFocus
              className="w-full rounded-md border border-border bg-surface-light px-3 py-2 text-[13px] focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
          <div>
            <label className="mb-1 block text-[12px] font-semibold text-text-secondary">Sends to</label>
            <CleanSelect
              value={audience}
              onChange={(v) => setAudience(v as TextAudience)}
              options={[
                { value: "customer", label: "Customer" },
                { value: "team", label: "Team / dispatch" },
              ]}
              ariaLabel="Template audience"
              widthClass="inline-block min-w-[180px]"
              tone="info"
            />
          </div>
          <div>
            <label className="mb-1 block text-[12px] font-semibold text-text-secondary">Message</label>
            <textarea
              ref={taRef}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={5}
              placeholder="Write your message — tap a field below to insert customer/job details."
              className="w-full rounded-md border border-border bg-surface-light p-3 text-[13px] leading-relaxed text-text-secondary focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {MERGE_FIELDS.map((f) => (
                <MergeChip key={f.token} token={f.token} onClick={() => insert(f.token)} />
              ))}
            </div>
          </div>
        </div>
    </Modal>
  );
}

function AutomationModal({
  initial,
  templates,
  onClose,
  onSave,
}: {
  initial: TextAutomation | null;
  templates: TextTemplate[];
  onClose: () => void;
  onSave: (a: TextAutomation, composed?: { name: string; body: string; audience: TextAudience }) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [trigger, setTrigger] = useState<TextTrigger>(initial?.trigger ?? "job_booked");
  const [mode, setMode] = useState<"template" | "compose">("template");
  const [templateId, setTemplateId] = useState(initial?.templateId ?? templates[0]?.id ?? "");
  const [composed, setComposed] = useState("");
  const [timing, setTiming] = useState(initial?.timing ?? TIMING_OPTIONS[0]!);
  const [audience, setAudience] = useState<TextAudience>(initial?.audience ?? "customer");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  function insert(token: string) {
    const ins = `{{${token}}}`;
    const ta = taRef.current;
    const start = ta ? ta.selectionStart : composed.length;
    const end = ta ? ta.selectionEnd : composed.length;
    const next = composed.slice(0, start) + ins + composed.slice(end);
    setComposed(next);
    requestAnimationFrame(() => {
      if (ta) {
        const pos = start + ins.length;
        ta.focus();
        ta.setSelectionRange(pos, pos);
      }
    });
  }

  const canSave =
    name.trim() && (mode === "template" ? !!templateId : !!composed.trim());

  function save() {
    const base: TextAutomation = {
      id: initial?.id ?? nextAutomationId(),
      name: name.trim(),
      trigger,
      templateId,
      timing,
      audience,
      enabled,
    };
    if (mode === "compose") {
      onSave(base, { name: `${name.trim()} message`, body: composed, audience });
    } else {
      onSave(base);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={initial ? "Edit automation" : "New texting automation"}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border bg-surface-light px-3 py-2 text-[13px] font-semibold text-text-secondary hover:bg-background-light"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSave}
            onClick={save}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-[13px] font-semibold text-on-fill hover:bg-primary/90 disabled:opacity-40"
          >
            {initial ? "Save automation" : "Create automation"}
          </button>
        </>
      }
    >
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-[12px] font-semibold text-text-secondary">Automation name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. 1-hour reminder"
              autoFocus
              className="w-full rounded-md border border-border bg-surface-light px-3 py-2 text-[13px] focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>

          <div>
            <label className="mb-1 block text-[12px] font-semibold text-text-secondary">When this happens</label>
            <CleanSelect
              value={trigger}
              onChange={(v) => setTrigger(v as TextTrigger)}
              options={TEXT_TRIGGERS.map((t) => ({ value: t.value, label: t.label }))}
              ariaLabel="Trigger"
              widthClass="inline-block min-w-[240px]"
              tone="info"
            />
            <p className="mt-1 text-[12px] text-text-secondary">
              {TEXT_TRIGGERS.find((t) => t.value === trigger)?.desc}
            </p>
          </div>

          <div>
            <label className="mb-1.5 block text-[12px] font-semibold text-text-secondary">Send this message</label>
            <div className="mb-2 inline-flex rounded-md border border-border p-0.5">
              <button
                type="button"
                onClick={() => setMode("template")}
                className={[
                  "rounded px-3 py-1 text-[12px] font-semibold",
                  mode === "template" ? "bg-primary text-on-fill" : "text-text-secondary",
                ].join(" ")}
              >
                Use a template
              </button>
              <button
                type="button"
                onClick={() => setMode("compose")}
                className={[
                  "inline-flex items-center gap-1 rounded px-3 py-1 text-[12px] font-semibold",
                  mode === "compose" ? "bg-primary text-on-fill" : "text-text-secondary",
                ].join(" ")}
              >
                <Sparkles className="h-3.5 w-3.5" /> Write from scratch
              </button>
            </div>
            {mode === "template" ? (
              <CleanSelect
                value={templateId}
                onChange={setTemplateId}
                options={templates.map((t) => ({ value: t.id, label: t.name }))}
                ariaLabel="Template"
                widthClass="block w-full"
                menuWidthClass="w-full"
                tone="info"
              />
            ) : (
              <div>
                <textarea
                  ref={taRef}
                  value={composed}
                  onChange={(e) => setComposed(e.target.value)}
                  rows={4}
                  placeholder="Compose a new message — it'll be saved as a template you can reuse."
                  className="w-full rounded-md border border-border bg-surface-light p-3 text-[13px] leading-relaxed text-text-secondary focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {MERGE_FIELDS.slice(0, 14).map((f) => (
                    <MergeChip key={f.token} token={f.token} onClick={() => insert(f.token)} />
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-[12px] font-semibold text-text-secondary">Timing</label>
              <CleanSelect
                value={timing}
                onChange={setTiming}
                options={TIMING_OPTIONS.map((t) => ({ value: t, label: t }))}
                ariaLabel="Timing"
                widthClass="block w-full"
                menuWidthClass="w-full"
                tone="info"
              />
            </div>
            <div>
              <label className="mb-1 block text-[12px] font-semibold text-text-secondary">Audience</label>
              <CleanSelect
                value={audience}
                onChange={(v) => setAudience(v as TextAudience)}
                options={[
                  { value: "customer", label: "Customer" },
                  { value: "team", label: "Team / dispatch" },
                ]}
                ariaLabel="Audience"
                widthClass="block w-full"
                menuWidthClass="w-full"
                tone="info"
              />
            </div>
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-[13px] font-medium text-text-secondary">
            <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enabled" />
            {enabled ? "Active" : "Paused"}
          </label>
        </div>
    </Modal>
  );
}

function TextSubTab({
  active,
  onClick,
  label,
  icon: Icon,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition",
        active ? "border-primary text-primary" : "border-transparent text-text-secondary hover:text-text-primary",
      ].join(" ")}
    >
      <Icon className="h-4 w-4" />
      {label}
      {count != null && (
        <span
          className={[
            "rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
            active ? "bg-primary/10 text-primary" : "bg-background-light text-text-secondary",
          ].join(" ")}
        >
          {count}
        </span>
      )}
    </button>
  );
}

export function TextingView({ onToast }: { onToast: (m: string) => void }) {
  const ability = useAppAbility();
  const canManage = ability.can("manage", "Communication");
  // Identity is available for the shell; reserved for future per-user settings.
  useAuthStore((s) => s.user);

  // Seam-fed seeds — the editable local state is initialised from these.
  const { data: templateSeed = [] } = useTextTemplates();
  const { data: automationSeed = [] } = useTextAutomations();
  const saveTemplate = useSaveTemplate();
  const saveAutomation = useSaveAutomation();

  const [tab, setTab] = useState<"templates" | "automations" | "compliance">("templates");

  // Messaging compliance + settings
  const [callerId, setCallerId] = useState("ServWave");
  const [forwards, setForwards] = useState<string[]>([""]);
  const [jobClosing, setJobClosing] = useState(true);

  // Templates (seeded once from the seam, then edited locally)
  const [templates, setTemplates] = useState<TextTemplate[]>([]);
  const [templatesSeeded, setTemplatesSeeded] = useState(false);
  const [newTplOpen, setNewTplOpen] = useState(false);

  // Automations (seeded once from the seam, then edited locally)
  const [automations, setAutomations] = useState<TextAutomation[]>([]);
  const [automationsSeeded, setAutomationsSeeded] = useState(false);
  const [autoModal, setAutoModal] = useState<{ open: boolean; editing: TextAutomation | null }>({
    open: false,
    editing: null,
  });

  // Compliance settings
  const [optOutOn, setOptOutOn] = useState(true);
  const [optOutFooter, setOptOutFooter] = useState(OPT_OUT_FOOTER);
  const [quietHoursOn, setQuietHoursOn] = useState(true);

  useEffect(() => {
    if (!templatesSeeded && templateSeed.length) {
      setTemplates(templateSeed.map((t) => ({ ...t })));
      setTemplatesSeeded(true);
    }
  }, [templateSeed, templatesSeeded]);

  useEffect(() => {
    if (!automationsSeeded && automationSeed.length) {
      setAutomations(automationSeed.map((a) => ({ ...a })));
      setAutomationsSeeded(true);
    }
  }, [automationSeed, automationsSeeded]);

  const tplName = (id: string) => templates.find((t) => t.id === id)?.name ?? "—";

  function updateTemplate(id: string, patch: Partial<TextTemplate>) {
    setTemplates((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }
  function resetTemplate(id: string) {
    setTemplates((ts) => ts.map((t) => (t.id === id ? { ...t, body: t.defaultBody } : t)));
    onToast("↺ Template reset to default");
  }
  function deleteTemplate(id: string) {
    setTemplates((ts) => ts.filter((t) => t.id !== id));
    onToast("Template deleted");
  }
  function addTemplate(name: string, body: string, audience: TextAudience) {
    const t: TextTemplate = {
      id: nextCustomTplId(),
      name,
      info: "Custom template you created.",
      body,
      defaultBody: body,
      audience,
      fields: MERGE_FIELDS.map((f) => f.token),
      kind: "custom",
    };
    setTemplates((ts) => [...ts, t]);
    saveTemplate.mutate(t);
    setNewTplOpen(false);
    onToast(`✓ Template “${name}” added`);
  }

  function saveAutomationHandler(
    a: TextAutomation,
    composed?: { name: string; body: string; audience: TextAudience },
  ) {
    let linked = a;
    if (composed) {
      const t: TextTemplate = {
        id: nextCustomTplId(),
        name: composed.name,
        info: "Created from an automation.",
        body: composed.body,
        defaultBody: composed.body,
        audience: composed.audience,
        fields: MERGE_FIELDS.map((f) => f.token),
        kind: "custom",
      };
      setTemplates((ts) => [...ts, t]);
      saveTemplate.mutate(t);
      linked = { ...a, templateId: t.id };
    }
    setAutomations((as) => {
      const exists = as.some((x) => x.id === linked.id);
      return exists ? as.map((x) => (x.id === linked.id ? linked : x)) : [...as, linked];
    });
    saveAutomation.mutate(linked);
    setAutoModal({ open: false, editing: null });
    onToast(autoModal.editing ? "✓ Automation saved" : `✓ Automation “${linked.name}” created`);
  }
  function toggleAutomation(id: string) {
    setAutomations((as) => as.map((a) => (a.id === id ? { ...a, enabled: !a.enabled } : a)));
  }
  function deleteAutomation(id: string) {
    setAutomations((as) => as.filter((a) => a.id !== id));
    onToast("Automation deleted");
  }

  return (
    <div className="space-y-6 p-6 pb-24">
      {/* Intro */}
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold text-text-primary">Texting</h2>
        <p className="mt-1 text-sm text-text-secondary">
          Two-way SMS from your business number — compliance, templates, and
          automated messages that go out the moment something happens on a job.
        </p>
      </div>

      {/* Sub-tabs */}
      <div className="flex items-center gap-1 border-b border-border">
        <TextSubTab active={tab === "templates"} onClick={() => setTab("templates")} label="Templates & settings" icon={MessageSquare} count={templates.length} />
        <TextSubTab active={tab === "automations"} onClick={() => setTab("automations")} label="Automations" icon={Zap} count={automations.length} />
        <TextSubTab active={tab === "compliance"} onClick={() => setTab("compliance")} label="Compliance & legal" icon={ShieldCheck} />
      </div>

      {tab === "templates" && (
        <div className="space-y-8">
          {/* Messaging compliance */}
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <h3 className="text-base font-bold text-text-primary">Messaging compliance</h3>
              <span className="inline-flex items-center gap-1 rounded-md bg-success px-2 py-0.5 text-[12px] font-bold text-on-fill">
                Verified <Info className="h-3 w-3" />
              </span>
            </div>
            <div className="max-w-2xl">
              <p className="text-[13px] font-semibold text-text-secondary">Caller ID</p>
              <p className="text-[13px] text-text-secondary">
                Displays a verified Caller ID to clients, reducing the chance of being marked as “Spam Likely.”
              </p>
              <div className="mt-2">
                <label className="mb-1 block text-[11px] font-medium text-text-secondary">Caller ID</label>
                <input
                  value={callerId}
                  onChange={(e) => setCallerId(e.target.value)}
                  className="w-full rounded-md border border-border bg-surface-light px-3 py-2.5 text-[14px] focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
                <p className="mt-1 text-[12px] text-text-secondary">
                  Caller name display relies on external carriers, so we can’t guarantee it will appear.
                </p>
              </div>
            </div>
          </section>

          <div className="border-t border-border" />

          {/* Messaging settings */}
          <section className="space-y-4">
            <h3 className="text-base font-bold text-text-primary">Messaging settings</h3>
            <div className="max-w-2xl">
              <p className="text-[13px] font-semibold text-text-secondary">Forward incoming messages</p>
              <p className="text-[13px] text-text-secondary">Forward incoming text messages to external numbers.</p>
              <div className="mt-2 space-y-2">
                {forwards.map((num, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <div className="flex-1">
                      <label className="mb-1 block text-[11px] font-medium text-text-secondary">Phone number</label>
                      <input
                        value={num}
                        onChange={(e) =>
                          setForwards((f) => f.map((x, j) => (j === i ? e.target.value : x)))
                        }
                        placeholder="(555) 555-5555"
                        className="w-full rounded-md border border-border bg-surface-light px-3 py-2.5 text-[14px] focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                      />
                    </div>
                    {forwards.length > 1 && (
                      <button
                        type="button"
                        onClick={() => setForwards((f) => f.filter((_, j) => j !== i))}
                        className="mt-5 text-text-secondary hover:text-danger"
                        aria-label="Remove number"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setForwards((f) => [...f, ""])}
                className="mt-2 inline-flex items-center gap-1.5 text-[14px] font-semibold text-primary hover:text-primary/90"
              >
                <Plus className="h-4 w-4" /> Add number
              </button>
            </div>

            <label className="flex max-w-2xl cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={jobClosing}
                onChange={(e) => setJobClosing(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-border text-primary focus:ring-primary"
              />
              <span>
                <span className="text-[14px] text-text-primary">Enable Job Closing</span>
                <span className="block text-[13px] text-text-secondary">
                  This will allow your techs to add payments and move the job to the “Done Pending Approval” status via a link.
                </span>
              </span>
            </label>
          </section>

          <div className="border-t border-border" />

          {/* Text templates */}
          <section className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-bold text-text-primary">Text templates</h3>
                <p className="text-[13px] text-text-secondary">Set up text templates that are sent to you and your customers.</p>
              </div>
              {canManage && (
                <button
                  type="button"
                  onClick={() => setNewTplOpen(true)}
                  className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-md bg-primary px-3.5 py-2 text-sm font-semibold text-on-fill shadow-sm hover:bg-primary/90"
                >
                  <Plus className="h-4 w-4" /> New template
                </button>
              )}
            </div>
            <div className="space-y-4">
              {templates.map((tpl) => (
                <TemplateCard
                  key={tpl.id}
                  tpl={tpl}
                  onChange={updateTemplate}
                  onReset={resetTemplate}
                  onDelete={deleteTemplate}
                />
              ))}
            </div>
          </section>
        </div>
      )}

      {tab === "automations" && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <p className="max-w-2xl text-[13px] text-text-secondary">
              Send a text automatically when something happens on a job — pick a
              trigger and a template, or write a brand-new message. Automations
              respect the opt-out and quiet-hours rules on the Compliance tab.
            </p>
            {canManage && (
              <button
                type="button"
                onClick={() => setAutoModal({ open: true, editing: null })}
                className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-md bg-primary px-3.5 py-2 text-sm font-semibold text-on-fill shadow-sm hover:bg-primary/90"
              >
                <Plus className="h-4 w-4" /> New automation
              </button>
            )}
          </div>

          {automations.length === 0 ? (
            <EmptyState
              variant="card"
              icon={Zap}
              title="No automations yet"
              description="Create one to text customers automatically at the right moment."
            />
          ) : (
            <div className="space-y-2.5">
              {automations.map((a) => {
                const trig = TEXT_TRIGGERS.find((t) => t.value === a.trigger);
                return (
                  <div
                    key={a.id}
                    className="flex flex-wrap items-center gap-3 rounded-card border border-border bg-surface-light p-3.5"
                  >
                    <Switch checked={a.enabled} onCheckedChange={() => toggleAutomation(a.id)} aria-label={`Toggle ${a.name}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-text-primary">{a.name}</p>
                        <AudienceBadge audience={a.audience} />
                        {!a.enabled && (
                          <span className="rounded-full bg-background-light px-2 py-0.5 text-[10px] font-semibold text-text-secondary">Paused</span>
                        )}
                      </div>
                      <p className="mt-0.5 text-[12px] text-text-secondary">
                        <span className="inline-flex items-center gap-1">
                          <Zap className="h-3 w-3 text-warning" /> {trig?.label ?? a.trigger}
                        </span>
                        {"  ·  "}
                        sends <span className="font-medium text-text-secondary">{tplName(a.templateId)}</span>
                        {"  ·  "}
                        {a.timing}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setAutoModal({ open: true, editing: a })}
                        className="rounded-md border border-border bg-surface-light px-2.5 py-1.5 text-[12px] font-semibold text-text-secondary hover:bg-background-light"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteAutomation(a.id)}
                        className="rounded-md p-1.5 text-text-secondary hover:text-danger"
                        aria-label="Delete automation"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tab === "compliance" && (
        <div className="max-w-3xl space-y-5">
          {/* A2P status */}
          <div className="flex items-start gap-3 rounded-card border border-success/20 bg-success/10 p-4">
            <ShieldCheck className="mt-0.5 h-5 w-5 flex-shrink-0 text-success" />
            <div>
              <p className="text-sm font-semibold text-success">A2P 10DLC — Verified</p>
              <p className="mt-0.5 text-[13px] text-success">
                Your brand and campaign are registered with The Campaign Registry, so carriers won’t block your business texts. Keep your use-case and opt-in details current.
              </p>
            </div>
          </div>

          {/* Opt-out footer */}
          <section className="rounded-card border border-border bg-surface-light p-4">
            <label className="flex cursor-pointer items-center justify-between gap-3">
              <span>
                <span className="text-sm font-semibold text-text-primary">Auto opt-out footer</span>
                <span className="block text-[13px] text-text-secondary">Appended to marketing texts so recipients can always opt out.</span>
              </span>
              <Switch checked={optOutOn} onCheckedChange={setOptOutOn} aria-label="Opt-out footer" />
            </label>
            {optOutOn && (
              <input
                value={optOutFooter}
                onChange={(e) => setOptOutFooter(e.target.value)}
                className="mt-3 w-full rounded-md border border-border bg-surface-light px-3 py-2 text-[13px] text-text-secondary focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            )}
          </section>

          {/* Quiet hours */}
          <section className="rounded-card border border-border bg-surface-light p-4">
            <label className="flex cursor-pointer items-center justify-between gap-3">
              <span>
                <span className="text-sm font-semibold text-text-primary">Respect quiet hours (8 AM–9 PM local)</span>
                <span className="block text-[13px] text-text-secondary">Holds non-urgent texts until they’re allowed in the recipient’s time zone.</span>
              </span>
              <Switch checked={quietHoursOn} onCheckedChange={setQuietHoursOn} aria-label="Quiet hours" />
            </label>
          </section>

          {/* Legal panel */}
          <section className="rounded-card border border-border bg-surface-light p-4">
            <div className="mb-3 flex items-center gap-2">
              <Shield className="h-4 w-4 text-text-secondary" />
              <h3 className="text-sm font-bold text-text-primary">What the law requires</h3>
            </div>
            <ol className="space-y-3">
              {SMS_COMPLIANCE.map((c, i) => (
                <li key={i} className="flex gap-3">
                  <span className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-bold text-primary">
                    {i + 1}
                  </span>
                  <div>
                    <p className="text-[13px] font-semibold text-text-primary">{c.title}</p>
                    <p className="text-[13px] leading-snug text-text-secondary">{c.body}</p>
                  </div>
                </li>
              ))}
            </ol>
            <div className="mt-4 flex items-start gap-2 rounded-md bg-warning/10 p-3 text-[12px] text-warning">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>{SMS_LEGAL_DISCLAIMER}</span>
            </div>
          </section>
        </div>
      )}

      {/* Sticky save bar */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface-light/90 px-6 py-3 backdrop-blur">
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => onToast("✓ Texting settings saved")}
            className="rounded-full bg-warning px-8 py-2.5 text-sm font-bold text-text-primary shadow-sm hover:bg-warning/90"
          >
            Save Settings
          </button>
        </div>
      </div>

      {newTplOpen && <NewTemplateModal onClose={() => setNewTplOpen(false)} onAdd={addTemplate} />}
      {autoModal.open && (
        <AutomationModal
          initial={autoModal.editing}
          templates={templates}
          onClose={() => setAutoModal({ open: false, editing: null })}
          onSave={saveAutomationHandler}
        />
      )}
    </div>
  );
}
