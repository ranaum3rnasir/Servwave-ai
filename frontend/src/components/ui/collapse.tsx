import { AnimatePresence, motion, useReducedMotionConfig } from 'framer-motion';
import { cn } from '@/lib/utils';

// Shared expand/collapse animation for every accordion-style toggle in the
// app (sidebar nav groups, scheduler buckets, card sections, report rows).
// One place to retune duration/easing app-wide.
const TRANSITION = { duration: 0.2, ease: 'easeInOut' } as const;
// Reduced motion (mobile slice 16, A11Y-05): open and close in one step.
// framer-motion's own `reducedMotion` only switches off transform and layout
// animations, and this one animates height and opacity, so it would keep
// sliding for someone who asked the system for less motion.
const INSTANT = { duration: 0 } as const;

interface CollapseProps {
  open: boolean;
  children: React.ReactNode;
  className?: string;
}

export function Collapse({ open, children, className }: CollapseProps) {
  // Reads the app root's <MotionConfig reducedMotion="user">, i.e. the OS setting.
  const reduced = useReducedMotionConfig();
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={reduced ? INSTANT : TRANSITION}
          className={cn('overflow-hidden', className)}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
