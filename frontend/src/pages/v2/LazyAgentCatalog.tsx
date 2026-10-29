import { Suspense, lazy, useState } from 'react';
import { useAiCenterStore } from '@/stores/aiCenterStore';

// The agent catalog is a near-full-screen modal with the whole agent catalog behind it. The staff
// layout mounts it on every screen, so importing it statically put all of that into the first
// download on every phone (mobile slice 61, PERF-01). It loads the first time anything opens it.
const AiCenterModal = lazy(() =>
  import('@/components/ai-center/AiCenterModal').then((m) => ({ default: m.AiCenterModal })),
);

/**
 * Mounts the agent catalog modal once the store has asked for it, and keeps it mounted after that
 * so it can animate closed and re-open without loading again. Until then it renders nothing.
 */
export function LazyAgentCatalog() {
  const open = useAiCenterStore((s) => s.open);
  const [wanted, setWanted] = useState(open);
  if (open && !wanted) setWanted(true);
  if (!wanted) return null;
  return (
    <Suspense fallback={null}>
      <AiCenterModal />
    </Suspense>
  );
}
