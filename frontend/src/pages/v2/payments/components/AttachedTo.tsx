import { Briefcase, Receipt, User } from 'lucide-react';

import { NewTabLink } from '@/components/ui/new-tab-link';
import type { DocumentRow, DocumentTargetKind } from '@/lib/api/paymentsPage';

import { v2Path } from '../../uiV2';

const KIND_WORD: Record<DocumentTargetKind, string> = { invoice: 'Invoice', job: 'Job', customer: 'Customer' };
const KIND_ICON = { invoice: Receipt, job: Briefcase, customer: User } as const;
const KIND_PATH: Record<DocumentTargetKind, string> = { invoice: '/invoices', job: '/jobs', customer: '/customers' };

/** "Invoice INV-1302" as a link that opens the record in a new tab; a dash when the viewer cannot open the record. */
export function AttachedTo({ to }: { to: DocumentRow['attached_to'] }) {
  if (!to || !to.id || !to.label) return <span className="text-muted-foreground">—</span>;
  const Icon = KIND_ICON[to.kind];
  return (
    <NewTabLink variant="chip" href={v2Path(`${KIND_PATH[to.kind]}/${to.id}`)}>
      <Icon aria-hidden className="mr-1.5 size-3.5 shrink-0" />
      {KIND_WORD[to.kind]} {to.label}
    </NewTabLink>
  );
}
