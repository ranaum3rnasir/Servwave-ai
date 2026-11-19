import React from 'react';
import { Step, Objection, Branch } from '@/lib/bee/agentFlow';
import { BeeScriptEditor } from './BeeScriptEditor';
import { BeeFlowBranchRow } from './BeeFlowBranchRow';
import { cn } from '@/lib/utils';
import {
  ChevronDown,
  ChevronUp,
  ArrowUp,
  ArrowDown,
  Trash2,
  Plus,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface BeeFlowStepCardProps {
  step: Step;
  index: number;
  isExpanded: boolean;
  allSteps: Step[];
  objections: Objection[];
  onToggle: () => void;
  onUpdate: (updated: Step) => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}

export const BeeFlowStepCard: React.FC<BeeFlowStepCardProps> = ({
  step,
  index,
  isExpanded,
  allSteps,
  objections,
  onToggle,
  onUpdate,
  onDelete,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
}) => {
  const handleAddBranch = () => {
    const newBranch: Branch = {
      id: `b_${Date.now()}`,
      when: '',
      outcome: { type: 'next' },
    };
    onUpdate({
      ...step,
      branches: [...step.branches, newBranch],
    });
  };

  const handleUpdateBranch = (branchIndex: number, updated: Branch) => {
    const newBranches = [...step.branches];
    newBranches[branchIndex] = updated;
    onUpdate({
      ...step,
      branches: newBranches,
    });
  };

  const handleDeleteBranch = (branchIndex: number) => {
    onUpdate({
      ...step,
      branches: step.branches.filter((_, idx) => idx !== branchIndex),
    });
  };

  if (!isExpanded) {
    return (
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left border border-[#E2E8F0] bg-white rounded-[14px] px-[18px] py-[14px] flex items-center justify-between gap-3 cursor-pointer hover:border-slate-300 transition-all text-[#0F172A]"
      >
        <span className="flex flex-col gap-1 min-w-0">
          <span className="text-[15px] font-bold text-[#0F172A] truncate">
            {step.title || `Step ${index + 1}`}
          </span>
          <span className="text-[13px] text-[#475569] truncate max-w-[480px]">
            {step.goal || step.line || 'Click to edit step details and customer answers'}
          </span>
        </span>

        <span className="flex items-center gap-2.5 shrink-0">
          <span className="text-[12px] font-semibold text-[#475569] bg-[#F1F5F9] rounded-full px-2.5 py-1">
            {step.branches.length} {step.branches.length === 1 ? 'answer' : 'answers'}
          </span>
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#475569"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </button>
    );
  }

  return (
    <div className="border-[1.5px] border-[#0F172A] bg-white rounded-[16px] p-5 flex flex-col gap-[18px]">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <input
          value={step.title}
          onChange={(e) => onUpdate({ ...step, title: e.target.value })}
          placeholder={`Step ${index + 1} title`}
          className="text-[18px] font-extrabold text-[#0F172A] border-0 outline-none focus:ring-0 bg-transparent p-0 flex-1 min-w-0"
        />

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            disabled={!canMoveUp}
            onClick={onMoveUp}
            className="w-9 h-9 rounded-[10px] border border-[#E2E8F0] bg-white text-[#475569] hover:bg-slate-50 flex items-center justify-center disabled:opacity-30 disabled:pointer-events-none transition-colors"
            title="Move step up"
          >
            <ArrowUp className="h-4 w-4" />
          </button>
          <button
            type="button"
            disabled={!canMoveDown}
            onClick={onMoveDown}
            className="w-9 h-9 rounded-[10px] border border-[#E2E8F0] bg-white text-[#475569] hover:bg-slate-50 flex items-center justify-center disabled:opacity-30 disabled:pointer-events-none transition-colors"
            title="Move step down"
          >
            <ArrowDown className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="w-9 h-9 rounded-[10px] border border-[#E2E8F0] bg-white text-[#475569] hover:bg-rose-50 hover:text-rose-600 hover:border-rose-200 flex items-center justify-center transition-colors"
            title="Delete step"
          >
            <Trash2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onToggle}
            className="w-9 h-9 rounded-[10px] border border-[#E2E8F0] bg-white text-[#475569] hover:bg-slate-50 flex items-center justify-center transition-colors"
            title="Collapse step"
          >
            <ChevronUp className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Goal of this step */}
      <div className="flex flex-col gap-1.5">
        <label className="text-[13px] font-bold text-[#0F172A] block">Goal of this step</label>
        <input
          value={step.goal}
          onChange={(e) => onUpdate({ ...step, goal: e.target.value })}
          placeholder="One sentence. Bee uses it to stay on track if the customer goes off-script."
          className="h-11 px-3 border border-[#CBD5E1] rounded-[10px] text-[14px] text-[#0F172A] bg-white outline-none focus:border-[#0F172A] transition-colors"
        />
        <span className="text-[12px] text-[#475569]">
          One sentence. Bee uses it to stay on track if the customer goes off-script.
        </span>
      </div>

      {/* What Bee says */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <span className="text-[13px] font-bold text-[#0F172A]">What Bee says</span>
          {/* Mode switch */}
          <div
            role="radiogroup"
            aria-label="How closely to follow"
            className="flex p-[3px] bg-[#F1F5F9] rounded-[10px]"
          >
            <button
              type="button"
              role="radio"
              aria-checked={step.mode === 'exact'}
              onClick={() => onUpdate({ ...step, mode: 'exact' })}
              className={cn(
                'h-[30px] px-2.5 rounded-[7px] border-none text-[12px] font-bold transition-all',
                step.mode === 'exact'
                  ? 'bg-white text-[#0F172A] shadow-xs'
                  : 'bg-transparent text-[#475569] hover:text-[#0F172A]'
              )}
            >
              Say it exactly
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={step.mode === 'guide'}
              onClick={() => onUpdate({ ...step, mode: 'guide' })}
              className={cn(
                'h-[30px] px-2.5 rounded-[7px] border-none text-[12px] font-bold transition-all',
                step.mode === 'guide'
                  ? 'bg-white text-[#0F172A] shadow-xs'
                  : 'bg-transparent text-[#475569] hover:text-[#0F172A]'
              )}
            >
              Use as a guide
            </button>
          </div>
        </div>

        {/* Script Editor */}
        <BeeScriptEditor
          value={step.line}
          onChange={(line) => onUpdate({ ...step, line })}
          placeholder="Write what Bee should say..."
          rows={3}
        />

        {/* Linked Plans (if attached) */}
        {step.attachPlans && (
          <div className="border border-dashed border-[#CBD5E1] rounded-[12px] p-[12px] px-[14px] flex flex-col gap-2.5 mt-1 bg-white">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <span className="text-[13px] font-bold text-[#0F172A]">Plans Bee can offer</span>
              <a href="#" className="text-[13px] font-semibold text-[#1D4ED8] hover:text-[#1E3A8A]">
                Manage in Warranty Plans
              </a>
            </div>
            <div className="flex flex-wrap gap-2">
              <span className="text-[13px] font-semibold border border-[#E2E8F0] bg-[#F8FAFC] text-[#0F172A] rounded-[8px] px-2.5 py-1.5">
                1-Year Extension · $199/yr or $19/mo
              </span>
              <span className="text-[13px] font-semibold border border-[#E2E8F0] bg-[#F8FAFC] text-[#0F172A] rounded-[8px] px-2.5 py-1.5">
                2-Year Complete Protection · $349
              </span>
              <span className="text-[13px] font-semibold border border-[#FDE68A] bg-[#FFFBEB] text-[#92400E] rounded-[8px] px-2.5 py-1.5">
                Early renewal: 10% off
              </span>
            </div>
            <span className="text-[12px] text-[#475569]">
              Pulled live from Warranty Plans, so prices are never typed twice.
            </span>
          </div>
        )}
      </div>

      {/* When the customer... */}
      <div className="flex flex-col gap-2 pt-1">
        <span className="text-[13px] font-bold text-[#0F172A]">When the customer…</span>

        <div className="space-y-2">
          {step.branches.map((branch, bi) => (
            <BeeFlowBranchRow
              key={branch.id || bi}
              branch={branch}
              stepIndex={index}
              allSteps={allSteps}
              objections={objections}
              onChange={(updated) => handleUpdateBranch(bi, updated)}
              onDelete={() => handleDeleteBranch(bi)}
            />
          ))}
        </div>

        <button
          type="button"
          onClick={handleAddBranch}
          className="self-start h-9 px-3 rounded-[8px] border border-dashed border-[#94A3B8] bg-white hover:bg-slate-50 text-[#334155] text-[13px] font-semibold flex items-center gap-1.5 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          <span>Add an answer</span>
        </button>
      </div>
    </div>
  );
};

export default BeeFlowStepCard;
