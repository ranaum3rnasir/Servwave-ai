// Call-training scenarios — the AI role-play simulations run from the Phone
// module's Training page. A trainee picks their role and a scenario; the matching
// AI trainer bot "calls" them and role-plays a customer against the company
// script. Prototype seed data.

export type TrainingRoleId = "technician" | "office" | "billing" | "dispatch";

export type TrainingDifficulty = "Beginner" | "Intermediate" | "Advanced";

export type TrainingRole = {
  id: TrainingRoleId;
  label: string;
  blurb: string;
};

export const TRAINING_ROLES: TrainingRole[] = [
  {
    id: "office",
    label: "Office / CSR",
    blurb: "Inbound calls — greeting, qualifying, and booking the job.",
  },
  {
    id: "technician",
    label: "Field technician",
    blurb: "On-site conversations, change orders, and scheduling calls.",
  },
  {
    id: "billing",
    label: "Billing",
    blurb: "Payments, overdue invoices, and disputed-charge handling.",
  },
  {
    id: "dispatch",
    label: "Dispatch",
    blurb: "Routing, same-day reschedules, and tech coordination.",
  },
];

/** One exchange in the role-play: the AI customer speaks `customer`, the
 *  trainee answers, and `rep` is the on-script model answer they're practicing.
 *  `cue` is a short coaching nudge shown beneath the model line. */
export type TrainingTurn = {
  /** What the AI customer bot says aloud (spoken via text-to-speech). */
  customer: string;
  /** The model / on-script line the trainee should deliver. */
  rep: string;
  /** Optional one-line coaching cue for this beat. */
  cue?: string;
};

export type TrainingScenario = {
  id: string;
  roleId: TrainingRoleId;
  title: string;
  difficulty: TrainingDifficulty;
  durationMin: number;
  /** Which part of the company script this drills. */
  scriptFocus: string;
  /** The AI trainer bot that places the call. */
  trainerName: string;
  /** The customer the bot role-plays. */
  persona: string;
  /** Guided beats the simulation walks through. */
  steps: string[];
  /** Turn-by-turn role-play script. The AI speaks each `customer` line; the
   *  trainee practices the matching `rep` line. Drives the live voice sim. */
  dialogue: TrainingTurn[];
};

/* ───────────────────────── Training history ─────────────────────────
 * A logged record every time someone completes (or abandons) a simulation.
 * Powers the Training → History tab: who trained, on what, the score, when,
 * and a recording for review. Prototype seed data. */

export type TrainingOutcome = "passed" | "needs_work" | "incomplete";

export type TrainingSession = {
  id: string;
  /** Who took the training. */
  traineeName: string;
  traineeRole: string;
  roleId: TrainingRoleId;
  /** Which scenario was run (matches TrainingScenario.id / title). */
  scenarioId: string;
  scenarioTitle: string;
  difficulty: TrainingDifficulty;
  trainerName: string;
  /** 0–100, or null if the run was abandoned. */
  score: number | null;
  outcome: TrainingOutcome;
  /** Wall-clock length of the simulation. */
  durationSec: number;
  completedAt: string; // ISO
  /** A full call recording is retained for review/coaching. */
  hasRecording: boolean;
  /** One-line AI coaching summary shown in the history row. */
  coachingNote: string;
  /** Turn-by-turn transcript of the simulated call, for review/coaching. */
  transcript?: TranscriptTurn[];
};

/** A single spoken turn in a training-session transcript. */
export type TranscriptTurn = {
  /** "trainee" = the person being trained; "trainer" = the AI playing the other party. */
  speaker: "trainee" | "trainer";
  /** mm:ss offset from the start of the call. */
  at: string;
  text: string;
};

/** Below this, a completed run is flagged "needs work" in the history. */
export const TRAINING_PASS_THRESHOLD = 85;

export const TRAINING_OUTCOME_LABELS: Record<TrainingOutcome, string> = {
  passed: "Passed",
  needs_work: "Needs work",
  incomplete: "Incomplete",
};
