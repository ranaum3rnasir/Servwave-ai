// Texting settings, templates, automations, and SMS-compliance content for the
// Phone module's "Texting" tab. Prototype seed data. Modeled on the reference
// field-service SMS settings page, in our clean module styling — plus owner-
// requested extras: custom template creation, texting automations, and a
// plain-English compliance panel (TCPA · A2P 10DLC · CTIA).

/* ───────────────────────── Merge fields ─────────────────────────
 * Tokens a template can interpolate at send time. Rendered as clickable chips
 * under each template; clicking one inserts `{{token}}` at the caret. */

export type MergeField = { token: string; label: string };

export const MERGE_FIELDS: MergeField[] = [
  { token: "job_id", label: "Job Id" },
  { token: "full_name", label: "Full Name" },
  { token: "first_name", label: "First Name" },
  { token: "last_name", label: "Last Name" },
  { token: "company_name", label: "Company Name" },
  { token: "phone_number", label: "Phone Number" },
  { token: "job_type", label: "Job Type" },
  { token: "client_email", label: "Client Email" },
  { token: "job_date", label: "Job Date" },
  { token: "appointment_time", label: "Appointment Time" },
  { token: "job_end_time", label: "Job End Time" },
  { token: "full_address", label: "Full Address" },
  { token: "address", label: "Address" },
  { token: "city", label: "City" },
  { token: "state", label: "State" },
  { token: "zip_code", label: "Zip Code" },
  { token: "tech_assigned", label: "Tech Assigned" },
  { token: "description", label: "Description" },
  { token: "confirm_link", label: "Confirm Link" },
  { token: "info_link", label: "Info Link" },
  { token: "review_link", label: "Review Link" },
  { token: "payment_link", label: "Payment Link" },
  { token: "ad_group", label: "Ad Group" },
  { token: "late_value", label: "Late Value" },
];

const LABEL_BY_TOKEN = new Map(MERGE_FIELDS.map((f) => [f.token, f.label]));
export function mergeLabel(token: string): string {
  return LABEL_BY_TOKEN.get(token) ?? token;
}

/* ───────────────────────── Text templates ─────────────────────────
 * Preset templates ship with the product and can be reset to default; custom
 * templates are created by the owner ("a new type of texting"). Each carries
 * the subset of merge-field tokens shown as chips beneath its editor. */

export type TextTemplateKind = "preset" | "custom";
export type TextAudience = "customer" | "team";

export type TextTemplate = {
  id: string;
  name: string;
  /** Tooltip / one-line explanation of when this template is used. */
  info: string;
  body: string;
  /** Snapshot used by "Reset to default" (presets only). */
  defaultBody: string;
  /** Merge-field tokens offered as chips under the editor. */
  fields: string[];
  /** Who the message goes to — customer-facing vs. internal team alert. */
  audience: TextAudience;
  /** Show a "Notify me when tech sends this message" checkbox. */
  notifyToggle?: boolean;
  notifyOn?: boolean;
  kind: TextTemplateKind;
};

/* ───────────────────────── Automations ─────────────────────────
 * Triggered texts: when an event fires, send a template (or a one-off message)
 * to the customer or the team. Owner-requested: "create automation for texting." */

export type TextTrigger =
  | "job_booked"
  | "appt_reminder_24h"
  | "appt_reminder_1h"
  | "tech_on_the_way"
  | "job_completed"
  | "missed_call"
  | "invoice_unpaid";

export const TEXT_TRIGGERS: { value: TextTrigger; label: string; desc: string }[] = [
  { value: "job_booked", label: "Job booked", desc: "A new job is created." },
  { value: "appt_reminder_24h", label: "Appointment reminder — 24h", desc: "24 hours before the appointment." },
  { value: "appt_reminder_1h", label: "Appointment reminder — 1h", desc: "1 hour before the appointment." },
  { value: "tech_on_the_way", label: "Tech on the way", desc: "The tech taps \"On my way.\"" },
  { value: "job_completed", label: "Job completed", desc: "The job is marked complete." },
  { value: "missed_call", label: "Missed call", desc: "A call is missed or goes to voicemail." },
  { value: "invoice_unpaid", label: "Invoice unpaid", desc: "An invoice is still unpaid after some days." },
];

export const TIMING_OPTIONS: string[] = [
  "Immediately",
  "1 hour before",
  "24 hours before",
  "30 minutes after",
  "2 hours after",
  "1 day after",
  "3 days after",
];

export type TextAutomation = {
  id: string;
  name: string;
  trigger: TextTrigger;
  /** Template sent when the trigger fires. */
  templateId: string;
  timing: string;
  audience: TextAudience;
  enabled: boolean;
};

/* ───────────────────────── Compliance / legal ─────────────────────────
 * Plain-English summary of the rules that govern business texting in the US.
 * NOT legal advice — shown to help the owner stay on the right side of the law.
 * Sourced from TCPA (federal), CTIA carrier guidelines, and A2P 10DLC. */

export type ComplianceNote = {
  title: string;
  body: string;
};

export const SMS_COMPLIANCE: ComplianceNote[] = [
  {
    title: "Get consent before you text (TCPA)",
    body: "Federal law requires prior express consent before sending marketing texts. Keep a record of when and how each customer opted in (e.g., a checkbox on your booking form). Service/transactional texts about an active job need less, but consent is still best practice.",
  },
  {
    title: "Register your number (A2P 10DLC)",
    body: "Business texting from a 10-digit number must be registered with The Campaign Registry. Since 2025, carriers block unregistered traffic. Your brand + campaign show as \"Verified\" once approved.",
  },
  {
    title: "Always honor opt-out",
    body: "STOP, UNSUBSCRIBE, and QUIT must immediately end messaging, with one confirmation reply allowed. You must also honor opt-outs sent in plain language by any reasonable method, not just keywords.",
  },
  {
    title: "Respect quiet hours",
    body: "No marketing texts before 8 AM or after 9 PM in the recipient's local time. Several states add stricter rules — send time-zone aware and follow the strictest one that applies.",
  },
  {
    title: "Identify yourself & avoid restricted content",
    body: "Say who you are in the message and include opt-out info. No \"SHAFT\" content (sex, hate, alcohol, firearms, tobacco). Penalties run $500–$1,500 per message, so when in doubt, don't send.",
  },
];

/** Auto-appended to outbound marketing texts to satisfy opt-out rules. */
export const OPT_OUT_FOOTER =
  "Reply STOP to opt out, HELP for help. Msg & data rates may apply.";

export const SMS_LEGAL_DISCLAIMER =
  "This is a plain-English summary to help you stay compliant — not legal advice. Rules change and vary by state; confirm with counsel before running campaigns.";
