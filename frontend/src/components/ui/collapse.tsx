import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '@/lib/utils';

// Shared expand/collapse animation for every accordion-style toggle in the
// app (sidebar nav groups, scheduler buckets, card sections, report rows).
// One place to retune duration/easing app-wide.
const TRANSITION = { duration: 0.2, ease: 'easeInOut' } as const;

interface CollapseProps {
  open: boolean;
  children: React.ReactNode;
  className?: string;
}

export function Collapse({ open, children, className }: CollapseProps) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={TRANSITION}
          className={cn('overflow-hidden', className)}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
