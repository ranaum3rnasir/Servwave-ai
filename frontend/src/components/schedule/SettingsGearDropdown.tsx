import { Settings, Check } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { EVENT_TYPE_META, type EventType } from "./scheduleModel";

interface SettingsGearDropdownProps {
  roleFilter: string;
  onRoleFilterChange: (value: string) => void;
  isGroupedView: boolean;
}

// Type accents — token classes only (job=info, walkthrough=warning, service-plan=ai).
// Literal class names (Tailwind JIT can't expand dynamic fragments); labels from the META.
const TYPE_SWATCH: Record<EventType, string> = {
  job: "bg-info",
  walkthrough: "bg-warning",
  "service-plan": "bg-ai",
  // Dead v1 fork (no importer outside its own test) - added only to satisfy
  // Record<EventType, ...> after slice 03 widened EventType. Not wired into any live surface.
  "calendar-entry": "bg-event",
};
const EVENT_TYPES: EventType[] = ["job", "walkthrough", "service-plan", "calendar-entry"];

const STAFF_FILTERS = [
  { label: "All Staff", value: "all" },
  { label: "Technicians", value: "TECHNICIAN" },
  { label: "Sales", value: "SALES" },
] as const;

const SHORTCUTS = [
  { key: "T", label: "Today" },
  { key: "1", label: "Day view" },
  { key: "2", label: "Week view" },
  { key: "3", label: "Month view" },
  { key: "S", label: "Standard view" },
  { key: "G", label: "Member view" },
] as const;

const sectionHeaderClass =
  "text-[10px] font-semibold text-text-secondary tracking-wider uppercase mb-2";

export function SettingsGearDropdown({
  roleFilter,
  onRoleFilterChange,
  isGroupedView,
}: SettingsGearDropdownProps) {
  return (
    <Popover>
      {/* Raw by design: no outline cell matches - outline/neutral carries a real
          idle bg-surface-light fill (documented TRAP in button.tsx) that this
          control does not have (its border is idle, the background only
          appears on hover). */}
      <PopoverTrigger asChild>
        <button
          className="h-7 w-7 rounded-md border border-border text-text-secondary hover:text-text-primary hover:bg-background-light flex items-center justify-center"
          aria-label="Schedule settings"
        >
          <Settings className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="end">
        {/* Legend — token classes only, no hexes */}
        <div className="px-4 py-3 border-b border-border">
          <p className={sectionHeaderClass}>Legend</p>
          <div className="space-y-1.5">
            {/* Event-type accents (left-bar) */}
            {EVENT_TYPES.map((t) => (
              <div key={t} className="flex items-center gap-2">
                <span className={`h-4 w-1.5 rounded-sm flex-shrink-0 ${TYPE_SWATCH[t]}`} />
                <span className="text-xs text-text-primary">{EVENT_TYPE_META[t].label}</span>
              </div>
            ))}
            {/* The two reds (D7 + §3.8 state 4) */}
            <div className="flex items-center gap-2">
              <span className="h-4 w-4 rounded-sm flex-shrink-0 bg-danger" />
              <span className="text-xs text-text-primary">Needs crew (unstaffed)</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="h-4 w-4 rounded-sm flex-shrink-0 border-2 border-danger bg-surface-light" />
              <span className="text-xs text-text-primary">Double-booked</span>
            </div>
            {/* Terminal */}
            <div className="flex items-center gap-2">
              <span className="h-4 w-4 rounded-sm flex-shrink-0 bg-text-soft" />
              <span className="text-xs text-text-primary">Completed</span>
            </div>
          </div>
        </div>

        {/* Staff Filter — only when grouped view */}
        {isGroupedView && (
          <div className="px-4 py-3 border-b border-border">
            <p className={sectionHeaderClass}>Staff Filter</p>
            <div className="space-y-0.5">
              {/* Raw by design: a selectable filter list, the dropdown-menu-item shape. */}
              {STAFF_FILTERS.map(({ label, value }) => {
                const isActive = roleFilter === value;
                return (
                  <button
                    key={value}
                    onClick={() => onRoleFilterChange(value)}
                    className={`w-full flex items-center justify-between px-2 py-1.5 rounded text-xs transition-colors ${
                      isActive
                        ? "bg-primary/10 text-primary font-medium"
                        : "text-text-secondary hover:bg-background-light"
                    }`}
                  >
                    <span>{label}</span>
                    {isActive && <Check className="h-3 w-3" />}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Keyboard Shortcuts */}
        <div className="px-4 py-3">
          <p className={sectionHeaderClass}>Shortcuts</p>
          <div className="space-y-1.5">
            {SHORTCUTS.map(({ key, label }) => (
              <div key={key} className="flex items-center justify-between">
                <span className="text-xs text-text-secondary">{label}</span>
                <kbd className="text-[10px] text-text-soft bg-neutral-surface border border-border px-1.5 py-0.5 rounded font-mono">
                  {key}
                </kbd>
              </div>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
