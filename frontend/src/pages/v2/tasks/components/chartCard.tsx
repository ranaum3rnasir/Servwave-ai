import type { ReactNode } from 'react';

import { Card, CardContent, CardHeader, CardTitle } from '@/ui-kit/components/ui/card';

/**
 * A titled panel for a chart.
 *
 * The kit ships no chart component and no chart frame, and charts are a
 * no-touch boundary in this migration - `recharts` and the
 * `design-system/tokens.ts` accessors stay exactly as they are, because a
 * colour inside a chart carries meaning. Only the frame around it moves onto
 * the kit, which is all this is: kit `Card` plus the title the legacy
 * `components/charts/ChartCard` rendered.
 */
export function ChartCard({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}
