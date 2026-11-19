import React, { useState, useRef, useEffect } from 'react';
import { Branch, Outcome, Step, Objection } from '@/lib/bee/agentFlow';
import { cn } from '@/lib/utils';
import { ArrowRight, ChevronDown, Trash2 } from 'lucide-react';

export interface BeeFlowBranchRowProps {
  branch: Branch;
  stepIndex: number;
  allSteps: Step[];
  objections: Objection[];
  onChange: (updated: Branch) => void;
  onDelete: () => void;
}

export const BeeFlowBranchRow: React.FC<BeeFlowBranchRowProps> = ({
  branch,
  stepIndex,
  allSteps,
  objections,
  onChange,
  onDelete,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const getOutcomeDetails = (outcome: Outcome) => {
    switch (outcome.type) {
      case 'next': {
        const nextStep = allSteps[stepIndex + 1];
        return {
          label: nextStep ? `Go to: ${nextStep.title}` : 'Go to: Next step',
          style: 'bg-[#EFF6FF] border-[#BFDBFE] text-[#1E3A8A] hover:bg-blue-100/70',
        };
      }
      case 'goto': {
        const target = allSteps.find((s) => s.id === outcome.stepId);
        return {
          label: target ? `Go to: ${target.title}` : `Go to: ${outcome.stepId}`,
          style: 'bg-[#EFF6FF] border-[#BFDBFE] text-[#1E3A8A] hover:bg-blue-100/70',
        };
      }
      case 'objection': {
        const obj = objections.find((o) => o.id === outcome.objectionId);
        return {
          label: obj ? `Objection: ${obj.name}` : `Objection: ${outcome.objectionId}`,
          style: 'bg-[#FFF7ED] border-[#FED7AA] text-[#9A3412] hover:bg-orange-100/70',
        };
      }
      case 'callback':
        return {
          label: 'Book a callback, end call',
          style: 'bg-[#F1F5F9] border-[#CBD5E1] text-[#334155] hover:bg-slate-200/70',
        };
      case 'transfer':
        return {
          label: 'Transfer to office',
          style: 'bg-[#F0FDF4] border-[#BBF7D0] text-[#166534] hover:bg-emerald-100/70',
        };
      case 'do_not_call':
        return {
          label: 'Add to DNC, end call',
          style: 'bg-[#FEF2F2] border-[#FECACA] text-[#991B1B] hover:bg-red-100/70',
        };
      case 'end_call':
        return {
          label: 'End call',
          style: 'bg-[#F1F5F9] border-[#CBD5E1] text-[#334155] hover:bg-slate-200/70',
        };
    }
  };

  const outcomeDetails = getOutcomeDetails(branch.outcome);

  const selectOutcome = (outcome: Outcome) => {
    onChange({ ...branch, outcome });
    setMenuOpen(false);
  };

  return (
    <div ref={containerRef} className="relative flex items-center gap-2 group">
      {/* Customer intent input */}
      <div className="flex-1 min-w-0">
        <input
          type="text"
          value={branch.when}
          onChange={(e) => onChange({ ...branch, when: e.target.value })}
          placeholder="e.g. Says yes / sure"
          className="w-full min-h-[42px] px-3 text-[14px] font-semibold text-[#0F172A] bg-[#F8FAFC] border border-[#E2E8F0] rounded-[10px] outline-none focus:bg-white focus:border-[#0F172A] transition-all placeholder:font-normal placeholder:text-slate-400"
        />
      </div>

      {/* Arrow icon */}
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="#475569"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="shrink-0"
      >
        <path d="M5 12h14M13 6l6 6-6 6" />
      </svg>

      {/* Outcome Selector Button */}
      <div className="flex-1 min-w-0 relative">
        <button
          type="button"
          onClick={() => setMenuOpen((prev) => !prev)}
          className={cn(
            'w-full min-h-[42px] px-3 rounded-[10px] border text-[13px] font-bold flex items-center justify-between gap-2 transition-all text-left shadow-2xs',
            outcomeDetails.style
          )}
        >
          <span className="truncate">{outcomeDetails.label}</span>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="shrink-0 opacity-70"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>

        {/* Dropdown Menu */}
        {menuOpen && (
          <div
            className="absolute left-0 top-[46px] z-50 w-72 max-h-72 bg-white border border-[#E2E8F0] rounded-[14px] shadow-xl overflow-y-auto p-1 divide-y divide-slate-100 animate-in fade-in zoom-in-95 duration-100"
            style={{ boxShadow: '0 12px 32px rgba(15,23,42,.15)' }}
          >
            {/* Steps navigation */}
            <div className="py-1">
              <div className="px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wider text-slate-400">
                Steps
              </div>
              <button
                type="button"
                onClick={() => selectOutcome({ type: 'next' })}
                className="w-full text-left px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-700 hover:bg-slate-100 transition-colors"
              >
                Go to next step
              </button>
              {allSteps.map((s, idx) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => selectOutcome({ type: 'goto', stepId: s.id })}
                  className="w-full text-left px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-700 hover:bg-slate-100 transition-colors truncate"
                >
                  Go to: {idx + 1}. {s.title}
                </button>
              ))}
            </div>

            {/* Objections */}
            {objections.length > 0 && (
              <div className="py-1">
                <div className="px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wider text-slate-400">
                  Handle Objection
                </div>
                {objections.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => selectOutcome({ type: 'objection', objectionId: o.id })}
                    className="w-full text-left px-2.5 py-1.5 rounded-lg text-xs font-medium text-amber-900 hover:bg-amber-50 transition-colors truncate"
                  >
                    Objection: {o.name}
                  </button>
                ))}
              </div>
            )}

            {/* Call ending actions */}
            <div className="py-1">
              <div className="px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wider text-slate-400">
                Call Actions
              </div>
              <button
                type="button"
                onClick={() => selectOutcome({ type: 'callback' })}
                className="w-full text-left px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-700 hover:bg-slate-100 transition-colors"
              >
                Book a callback, end call
              </button>
              <button
                type="button"
                onClick={() => selectOutcome({ type: 'transfer' })}
                className="w-full text-left px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-700 hover:bg-slate-100 transition-colors"
              >
                Transfer to office
              </button>
              <button
                type="button"
                onClick={() => selectOutcome({ type: 'do_not_call' })}
                className="w-full text-left px-2.5 py-1.5 rounded-lg text-xs font-medium text-rose-700 hover:bg-rose-50 transition-colors"
              >
                Add to DNC, end call
              </button>
              <button
                type="button"
                onClick={() => selectOutcome({ type: 'end_call' })}
                className="w-full text-left px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-700 hover:bg-slate-100 transition-colors"
              >
                End call
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Delete button */}
      <button
        type="button"
        onClick={onDelete}
        className="p-2 text-slate-400 hover:text-rose-600 transition-colors rounded-lg hover:bg-rose-50 shrink-0"
        title="Remove this branch"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
};

export default BeeFlowBranchRow;
