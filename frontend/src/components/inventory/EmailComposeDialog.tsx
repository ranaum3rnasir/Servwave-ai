import { useEffect, useMemo, useState } from "react";
import { Mail, Send, X } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { FormField } from "@/components/patterns/FormField";
import {
  useTechs,
  useEmailStagePickup,
  type JobStage,
} from "@/lib/api/inventory";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type Props = {
  open: boolean;
  onClose: () => void;
  stage: JobStage | null;
  shipToBranchId?: string;
  lockEscape?: boolean;
  onSent: (payload: { to: string[]; subject: string; body: string }) => void;
};

export function EmailComposeDialog({
  open,
  onClose,
  stage,
  lockEscape,
  onSent,
}: Props) {
  // ─── Seam data ───
  const { data: allTechs = [] } = useTechs();
  const emailMut = useEmailStagePickup();

  const tech = useMemo(
    () =>
      stage?.assignedTechId
        ? allTechs.find((t) => t.id === stage.assignedTechId)
        : undefined,
    [stage?.assignedTechId, allTechs],
  );

  // Suggested recipient = the assigned tech's REAL inbox (server-resolved from
  // the user directory). No fabricated aliases — add anyone else by typing.
  const recipientSuggestions = useMemo(() => {
    const out: { label: string; email: string }[] = [];
    if (tech?.email) {
      out.push({ label: `${tech.name} (Assigned Tech)`, email: tech.email });
    }
    return out;
  }, [tech]);

  const [to, setTo] = useState<string[]>([]);
  const [cc, setCc] = useState<string[]>([]);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [toInput, setToInput] = useState("");
  const [ccInput, setCcInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Reset + pre-fill whenever opened with a stage. The body is a short note; the
  // server renders the authoritative line-item table + job/site/notes.
  useEffect(() => {
    if (!open || !stage) return;
    setTo(recipientSuggestions[0]?.email ? [recipientSuggestions[0].email] : []);
    setCc([]);
    setToInput("");
    setCcInput("");
    setSubject(
      `Pickup Ticket · ${stage.jobNumber} · ${stage.customer} (${stage.items.length} line${stage.items.length === 1 ? "" : "s"})`,
    );
    setBody(
      [
        `Hi ${tech?.name?.split(" ")[0] ?? "team"},`,
        ``,
        `The pickup for ${stage.jobNumber} (${stage.customer}) is ready — the full item list is below.`,
        `Reply to this email to acknowledge.`,
      ].join("\n"),
    );
    setError(null);
  }, [open, stage?.id, tech?.id]);

  if (!open || !stage) return null;

  function addRecipient(field: "to" | "cc", raw: string) {
    const value = raw.trim().replace(/[,;]+$/, "");
    if (!value) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setError(`"${value}" isn't a valid email address.`);
      return;
    }
    setError(null);
    if (field === "to") {
      setTo((cur) => (cur.includes(value) ? cur : [...cur, value]));
      setToInput("");
    } else {
      setCc((cur) => (cur.includes(value) ? cur : [...cur, value]));
      setCcInput("");
    }
  }

  function removeRecipient(field: "to" | "cc", email: string) {
    if (field === "to") setTo((cur) => cur.filter((e) => e !== email));
    else setCc((cur) => cur.filter((e) => e !== email));
  }

  async function send() {
    if (to.length === 0) {
      setError("Add at least one recipient in the To field.");
      return;
    }
    if (!subject.trim()) {
      setError("Subject is required.");
      return;
    }
    setError(null);
    try {
      await emailMut.mutateAsync({
        stageId: stage!.id,
        to,
        cc: cc.length > 0 ? cc : undefined,
        subject: subject.trim(),
        message: body,
      });
      onSent({ to, subject: subject.trim(), body });
      onClose();
    } catch (e) {
      const msg =
        (e as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        "Couldn't send the pickup ticket. Please try again.";
      setError(msg);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Email Pickup Ticket · ${stage.jobNumber}`}
      subtitle="Sends a formatted pickup ticket to the selected recipients."
      size="lg"
      lockEscape={lockEscape}
      footer={
        <>
          <Button variant="outline" size="sm"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button size="sm"
            onClick={send}
            disabled={emailMut.isPending}
            className="disabled:opacity-60"
          >
            <Send className="h-4 w-4" />
            {emailMut.isPending
              ? "Sending…"
              : `Send Email (${to.length} recipient${to.length === 1 ? "" : "s"})`}
          </Button>
        </>
      }
    >
      {error && (
        <div className="mb-3 rounded-md border border-danger/20 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-3">
        {/* Quick-add chips */}
        {recipientSuggestions.length > 0 && (
          <div className="rounded-md border border-primary/30 bg-primary-subtle/40 px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-primary">
              Suggested recipients
            </div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {recipientSuggestions.map((r) => {
                const already = to.includes(r.email) || cc.includes(r.email);
                return (
                  // Raw by design: a toggleable suggestion chip with a
                  // success-toned "already added" state — segmented
                  // toggle-control shape, not Button-shaped.
                  <button
                    key={r.email}
                    type="button"
                    onClick={() => {
                      if (!already) {
                        setTo((cur) =>
                          cur.includes(r.email) ? cur : [...cur, r.email],
                        );
                      }
                    }}
                    className={[
                      "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition",
                      already
                        ? "cursor-not-allowed border-success/20 bg-success/10 text-success"
                        : "border-border bg-surface-light text-text-secondary hover:border-primary/30 hover:bg-primary-subtle",
                    ].join(" ")}
                    title={r.email}
                    disabled={already}
                  >
                    <Mail className="h-2.5 w-2.5" />
                    {r.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* To */}
        <FormField label="To" required>
          <RecipientField
            recipients={to}
            input={toInput}
            onInput={setToInput}
            onAdd={(v) => addRecipient("to", v)}
            onRemove={(e) => removeRecipient("to", e)}
          />
        </FormField>

        {/* Cc */}
        <FormField label="Cc">
          <RecipientField
            recipients={cc}
            input={ccInput}
            onInput={setCcInput}
            onAdd={(v) => addRecipient("cc", v)}
            onRemove={(e) => removeRecipient("cc", e)}
          />
        </FormField>

        {/* Subject */}
        <FormField label="Subject" required>
          <Input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="px-2.5 py-1.5"
          />
        </FormField>

        {/* Body — a short note; the item table renders server-side */}
        <FormField label="Message">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={8}
            className="px-2.5 py-1.5"
          />
        </FormField>
      </div>
    </Modal>
  );
}

function RecipientField({
  recipients,
  input,
  onInput,
  onAdd,
  onRemove,
  id,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
}: {
  recipients: string[];
  input: string;
  onInput: (v: string) => void;
  onAdd: (v: string) => void;
  onRemove: (email: string) => void;
  /** FormField's generated id - lands on the recipient text input, the
   *  labelable element in this compound chip-input. */
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-md border border-border px-1.5 py-1 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20">
      {recipients.map((email) => (
        <span
          key={email}
          className="inline-flex items-center gap-1 rounded-full bg-primary-subtle px-2 py-0.5 text-[11px] font-medium text-primary ring-1 ring-primary/30"
        >
          {email}
          {/* Raw by design: a small close-X affordance inside a chip - the
              explicit never-force-into-Button shape. */}
          <button
            type="button"
            onClick={() => onRemove(email)}
            className="rounded-full p-0.5 text-primary hover:bg-primary-subtle"
            aria-label={`Remove ${email}`}
          >
            <X className="h-2.5 w-2.5" />
          </button>
        </span>
      ))}
      <Input
        id={id}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        value={input}
        onChange={(e) => onInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "," || e.key === ";") {
            e.preventDefault();
            onAdd(input);
          } else if (e.key === "Backspace" && !input && recipients.length > 0) {
            onRemove(recipients[recipients.length - 1]!);
          }
        }}
        onBlur={() => {
          if (input.trim()) onAdd(input);
        }}
        placeholder="Type email + Enter…"
        className="flex-1 px-1 py-0.5"
      />
    </div>
  );
}
