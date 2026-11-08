import * as React from "react";

import { cn } from "@/ui-kit/lib/utils";

/**
 * The visual vocabulary of a board card.
 *
 * Three rules hold this together, and they are what make a column scannable
 * rather than readable:
 *
 * 1. Work type is a *filled* block, never a tinted outline. At 16px a solid
 *    shape is identifiable in peripheral vision; an outline is not, and a board
 *    is scanned, not read.
 * 2. Priority encodes direction as well as colour, so it survives contact with
 *    anyone who can't separate red from green.
 * 3. Labels are dark text on a light tint. White-on-colour loses legibility
 *    around 11px, which is exactly the size a label chip wants to be.
 */

export type WorkType = "emergency" | "maintenance" | "installation" | "inspection";
export type Priority = "highest" | "high" | "medium" | "low";

export const WORK_TYPES: Record<WorkType, { label: string; color: string }> = {
  emergency: { label: "Emergency callout", color: "rgb(var(--worktype-emergency))" },
  maintenance: { label: "Maintenance", color: "rgb(var(--worktype-maintenance))" },
  installation: { label: "Installation", color: "rgb(var(--worktype-installation))" },
  inspection: { label: "Inspection", color: "rgb(var(--worktype-inspection))" },
};

const TYPE_GLYPH: Record<WorkType, React.ReactNode> = {
  emergency: <path d="M13 2 3 14h8l-1 8 10-12h-8l1-8Z" fill="white" />,
  maintenance: (
    <path d="M4 12.5 9.5 18 20 6.5" stroke="white" strokeWidth={3.2} fill="none" strokeLinecap="round" strokeLinejoin="round" />
  ),
  installation: <path d="M12 5v14M5 12h14" stroke="white" strokeWidth={3.2} strokeLinecap="round" />,
  inspection: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" stroke="white" strokeWidth={2} fill="none" />
      <circle cx="12" cy="12" r="3.4" fill="white" />
    </>
  ),
};

export function WorkTypeIcon({ type, size = 16, className }: {
  type: WorkType; size?: number; className?: string;
}) {
  const meta = WORK_TYPES[type];
  return (
    <span
      role="img"
      aria-label={meta.label}
      title={meta.label}
      style={{ background: meta.color, width: size, height: size }}
      className={cn("grid shrink-0 place-items-center rounded-[3px]", className)}
    >
      <svg viewBox="0 0 24 24" width={size - 4} height={size - 4}>{TYPE_GLYPH[type]}</svg>
    </span>
  );
}

export const PRIORITIES: Record<Priority, { label: string; color: string }> = {
  highest: { label: "Highest priority", color: "rgb(var(--priority-highest))" },
  high: { label: "High priority", color: "rgb(var(--priority-high))" },
  medium: { label: "Medium priority", color: "rgb(var(--priority-medium))" },
  low: { label: "Low priority", color: "rgb(var(--priority-low))" },
};

const PRIORITY_GLYPH: Record<Priority, React.ReactNode> = {
  highest: <path d="M12 3 5 11h4v10h6V11h4L12 3Z" />,
  high: <path d="M12 5 6 13h4v6h4v-6h4L12 5Z" />,
  medium: <path d="M5 9h14M5 15h14" strokeWidth={3} strokeLinecap="round" fill="none" />,
  low: <path d="M12 19 6 11h4V5h4v6h4l-6 8Z" />,
};

export function PriorityIcon({ level, size = 15, className }: {
  level: Priority; size?: number; className?: string;
}) {
  const meta = PRIORITIES[level];
  return (
    <svg
      viewBox="0 0 24 24" width={size} height={size}
      fill={meta.color} stroke={meta.color}
      role="img" aria-label={meta.label} className={cn("shrink-0", className)}
    >
      {PRIORITY_GLYPH[level]}
    </svg>
  );
}

export interface LabelTone { bg: string; fg: string; label: string }

/** Extend per project; keep to dark-on-tint so 11px stays readable. */
export const CARD_LABELS: Record<string, LabelTone> = {
  warranty: { bg: "rgb(var(--label-warranty-bg))", fg: "rgb(var(--label-warranty-fg))", label: "Warranty" },
  contract: { bg: "rgb(var(--label-contract-bg))", fg: "rgb(var(--label-contract-fg))", label: "Service contract" },
  parts: { bg: "rgb(var(--label-parts-bg))", fg: "rgb(var(--label-parts-fg))", label: "Needs parts" },
  callback: { bg: "rgb(var(--label-callback-bg))", fg: "rgb(var(--label-callback-fg))", label: "Callback" },
  afterHours: { bg: "rgb(var(--label-afterhours-bg))", fg: "rgb(var(--label-afterhours-fg))", label: "After hours" },
};

export function CardLabel({ id, className }: { id: string; className?: string }) {
  const tone = CARD_LABELS[id];
  if (!tone) return null;
  return (
    <span
      style={{ background: tone.bg, color: tone.fg }}
      className={cn(
        "inline-flex h-[17px] items-center rounded-[3px] px-1.5 text-[10.5px] font-bold whitespace-nowrap",
        className,
      )}
    >
      {tone.label}
    </span>
  );
}
