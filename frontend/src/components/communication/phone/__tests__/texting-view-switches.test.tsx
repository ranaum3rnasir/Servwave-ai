// Roles & Permissions S08.20: the Text page's Settings tab follows switches. Message templates are written with
// Edit communication records (the communication "update" grant); the Automations sub-tab shows to holders of View
// automations and its create, edit (including the on/off toggle) and delete controls follow Create, Edit and Delete
// automations. Rendered with real abilities, never a role name.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const TEMPLATES = [
  {
    id: "tpl_preset", name: "Appointment confirmation", info: "Sent on booking", body: "See you {{job_date}}",
    defaultBody: "See you {{job_date}}", fields: ["job_date"], audience: "customer", kind: "preset",
  },
  {
    id: "tpl_custom", name: "Thanks for your visit", info: "Custom template you created.", body: "Thank you",
    defaultBody: "Thank you", fields: ["first_name"], audience: "customer", kind: "custom",
  },
];
const AUTOMATIONS = [
  { id: "au_1", name: "Day-before text", trigger: "job_booked", templateId: "tpl_preset", timing: "24 hours before", audience: "customer", enabled: true },
];

vi.mock("@/lib/api/communication", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/api/communication")>()),
  useTextTemplates: () => ({ data: TEMPLATES }),
  useTextAutomations: () => ({ data: AUTOMATIONS }),
  useSaveTemplate: () => ({ mutate: vi.fn() }),
  useSaveAutomation: () => ({ mutate: vi.fn() }),
}));

import { AbilityProvider } from "@/contexts/AbilityContext";
import { buildAbility, type AbilityRule } from "@/lib/ability";
import { TextingView } from "../TextingView";

const READ_COMMUNICATION: AbilityRule = { action: "read", subject: "Communication" };
const EDIT_COMMUNICATION_RECORDS: AbilityRule = { action: "update", subject: "Communication" };
const VIEW_AUTOMATIONS: AbilityRule = { action: "read", subject: "Automation" };
const CREATE_AUTOMATIONS: AbilityRule = { action: "create", subject: "Automation" };
const EDIT_AUTOMATIONS: AbilityRule = { action: "update", subject: "Automation" };
const DELETE_AUTOMATIONS: AbilityRule = { action: "delete", subject: "Automation" };

function renderView(...rules: AbilityRule[]) {
  return render(
    <AbilityProvider ability={buildAbility([READ_COMMUNICATION, ...rules])}>
      <TextingView onToast={vi.fn()} />
    </AbilityProvider>,
  );
}

describe("message templates follow Edit communication records", () => {
  it("shows New template, Reset to default and Delete, and an editable body, with the switch on", () => {
    renderView(EDIT_COMMUNICATION_RECORDS);
    expect(screen.getByRole("button", { name: /new template/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reset to default/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^delete$/i })).toBeInTheDocument();
    for (const box of screen.getAllByRole("textbox", { name: "" }).filter((el) => el.tagName === "TEXTAREA")) {
      expect(box).not.toHaveAttribute("readonly");
    }
  });

  it("hides New template, Reset to default and Delete, and makes every body read-only, with the switch off", () => {
    // Contact customers (create) and Delete communication records (delete) do not let a person change a template.
    renderView({ action: "create", subject: "Communication" }, { action: "delete", subject: "Communication" });
    expect(screen.queryByRole("button", { name: /new template/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reset to default/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^delete$/i })).not.toBeInTheDocument();
    const bodies = document.querySelectorAll("textarea");
    expect(bodies.length).toBe(TEMPLATES.length);
    bodies.forEach((box) => expect(box).toHaveAttribute("readonly"));
  });
});

describe("the Automations sub-tab follows View automations", () => {
  it("is absent without View automations, even with Create, Edit and Delete automations", () => {
    renderView(CREATE_AUTOMATIONS, EDIT_AUTOMATIONS, DELETE_AUTOMATIONS);
    expect(screen.queryByRole("button", { name: /automations/i })).not.toBeInTheDocument();
  });

  it("is present with View automations", () => {
    renderView(VIEW_AUTOMATIONS);
    expect(screen.getByRole("button", { name: /automations/i })).toBeInTheDocument();
  });
});

describe("the automation controls follow Create, Edit and Delete automations", () => {
  async function openAutomations(...rules: AbilityRule[]) {
    renderView(VIEW_AUTOMATIONS, ...rules);
    await userEvent.click(screen.getByRole("button", { name: /automations/i }));
  }

  it("shows no control to a holder of View automations alone, and the on/off toggle cannot be flipped", async () => {
    // Edit communication records and Contact customers do not stand in for the Automations switches.
    await openAutomations(EDIT_COMMUNICATION_RECORDS, { action: "create", subject: "Communication" });
    expect(screen.getByText("Day-before text")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /new automation/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^edit$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete automation/i })).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /toggle day-before text/i })).toBeDisabled();
  });

  it("shows New automation with Create automations only", async () => {
    await openAutomations(CREATE_AUTOMATIONS);
    expect(screen.getByRole("button", { name: /new automation/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^edit$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete automation/i })).not.toBeInTheDocument();
  });

  it("shows Edit and an enabled on/off toggle with Edit automations only", async () => {
    await openAutomations(EDIT_AUTOMATIONS);
    expect(screen.getByRole("button", { name: /^edit$/i })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /toggle day-before text/i })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /new automation/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete automation/i })).not.toBeInTheDocument();
  });

  it("shows Delete with Delete automations only", async () => {
    await openAutomations(DELETE_AUTOMATIONS);
    expect(screen.getByRole("button", { name: /delete automation/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /new automation/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^edit$/i })).not.toBeInTheDocument();
  });
});
