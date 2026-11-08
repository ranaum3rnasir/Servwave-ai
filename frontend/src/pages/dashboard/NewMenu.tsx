import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, ChevronDown } from 'lucide-react';
import { NewEstimateDialog } from '@/components/estimates/NewEstimateDialog';
import { Button } from '@/components/ui/button';

// `dialog` marks items that open a chooser instead of navigating (and so carry no `to`). New
// Estimate needs an anchor (lead/customer/job), so it opens NewEstimateDialog to pick one; a bare
// `/estimates/new` has nothing to create against and just bounces to the estimates list.
const ITEMS: { label: string; to?: string; dialog?: 'estimate' }[] = [
  { label: 'New Lead', to: '/leads/new' },
  { label: 'New Estimate', dialog: 'estimate' },
  { label: 'New Job', to: '/jobs/new' },
  { label: 'New Task', to: '/tasks?action=new-task' },
  { label: 'New Invoice', to: '/invoices/new' },
  { label: 'Request Payment', to: '/invoices' },
];

export default function NewMenu() {
  const [open, setOpen] = useState(false);
  const [estimateDialogOpen, setEstimateDialogOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <Button
        type="button"
        onClick={() => setOpen((o) => !o)}
        variant="solid"
        tone="brand"
        size={null}
        className="gap-1.5 px-3 py-2 text-xs"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Plus className="h-3.5 w-3.5" /> New <ChevronDown className="h-3 w-3" />
      </Button>
      {open && (
        <div className="absolute right-0 top-11 z-30 w-44 rounded-xl border border-border bg-surface-light p-1.5 shadow-hover" role="menu">
          {ITEMS.map((it) => (
            // Dropdown menu item (role="menuitem" in a custom listbox), not a Button-shaped
            // control - left raw per the program's non-Button-shape carve-out.
            <button
              key={it.label}
              type="button"
              onClick={() => {
                setOpen(false);
                if (it.dialog === 'estimate') { setEstimateDialogOpen(true); return; }
                if (it.to) navigate(it.to);
              }}
              className="block w-full rounded-md px-3 py-2 text-left text-[12.5px] text-text-primary hover:bg-background-light transition-colors"
              role="menuitem"
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
      <NewEstimateDialog open={estimateDialogOpen} onOpenChange={setEstimateDialogOpen} />
    </div>
  );
}
