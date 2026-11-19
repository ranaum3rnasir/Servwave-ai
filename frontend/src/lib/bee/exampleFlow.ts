import { type AgentFlow, RETURN } from "./agentFlow";

export const warrantyFlow: AgentFlow = {
  version: 1,
  persona: { agentName: "Sarah", tone: "warm, consultative, empathetic", language: "English (US)" },
  steps: [
    {
      id: "opening", title: "Opening", mode: "exact",
      goal: "Introduce yourself, say why you are calling, and get permission to continue.",
      line: "Hi {{customer.first_name}}, this is {{agent.name}} from {{company.name}}. I'm calling about the {{job.equipment}} we serviced at {{job.service_address}}. Do you have a quick minute?",
      branches: [
        { id: "b1", when: "Says yes or sure", outcome: { type: "next" } },
        { id: "b2", when: "Is busy right now", outcome: { type: "callback" } },
        { id: "b3", when: "Is not the account holder", outcome: { type: "end_call" } },
      ],
    },
    {
      id: "checkin", title: "Check-in", mode: "guide",
      goal: "Make sure the last job is still working before talking about money.",
      line: "Before anything else, is everything from our visit on {{job.completed_date}} still working well for you?",
      branches: [
        { id: "b1", when: "Says all good", outcome: { type: "next" } },
        { id: "b2", when: "Reports a problem", outcome: { type: "transfer" } },
      ],
    },
    {
      id: "offer", title: "Warranty offer", mode: "guide", attachPlans: true,
      goal: "Explain that coverage is ending and offer the renewal plans.",
      line: "Your parts and labor coverage on the {{job.equipment}} ends on {{warranty.end_date}}. If you renew before then, you get {{offer.early_discount}} off. Can I walk you through the two options?",
      branches: [
        { id: "b1", when: "Picks a plan", outcome: { type: "goto", stepId: "wrap" } },
        { id: "b2", when: "Needs time to think", outcome: { type: "objection", objectionId: "needs_time" } },
        { id: "b3", when: "Is not interested", outcome: { type: "next" } },
      ],
    },
    {
      id: "newwork", title: "New work", mode: "guide",
      goal: "Find any other equipment or projects the office should quote.",
      line: "While I have you, is there any other equipment or project at the property you'd like our technicians to look at?",
      branches: [
        { id: "b1", when: "Mentions a project", outcome: { type: "next" } },
        { id: "b2", when: "Says nothing right now", outcome: { type: "next" } },
      ],
    },
    {
      id: "wrap", title: "Wrap-up", mode: "exact",
      goal: "Confirm next steps and end the call warmly.",
      line: "Perfect. I'll send the details to {{customer.email}} and someone from our office will confirm by tomorrow. Thanks, {{customer.first_name}}!",
      branches: [{ id: "b1", when: "Says goodbye", outcome: { type: "end_call" } }],
    },
  ],
  objections: [
    { id: "too_expensive", name: "Too expensive", examples: ["that's a lot", "can't afford it"],
      reply: "Mention the monthly option and that one repair visit usually costs more than a year of coverage.",
      after: { type: "goto", stepId: RETURN } },
    { id: "needs_time", name: "Needs time", examples: ["I'll think about it", "need to talk to my wife"],
      reply: "No pressure. Offer to email the plan details and mention the early discount ends on {{warranty.end_date}}.",
      after: { type: "goto", stepId: "newwork" } },
    { id: "has_coverage", name: "Already has coverage", examples: ["I have a home warranty"],
      reply: "Thank them, ask which provider, and do not push further.",
      after: { type: "goto", stepId: "wrap" } },
    { id: "stop_calling", name: "Stop calling me", examples: ["take me off your list"],
      reply: "Apologise and confirm they won't be called again.",
      after: { type: "do_not_call" } },
  ],
  guardrails: { short_replies: true, only_linked_prices: true, honor_stop: true, disclose_ai: true, handoff_upset: true, hide_internal: true },
  customRules: ["Never call before 9am or after 7pm customer time."],
};
