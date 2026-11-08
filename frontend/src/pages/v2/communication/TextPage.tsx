import { useEffect, useState } from 'react';
import { Inbox as InboxIcon, Settings } from 'lucide-react';

import { useAppAbility } from '@/contexts/AbilityContext';
import { useMessageThreads } from '@/lib/api/communication';
import type { MessageThread } from '@/lib/api/communication';
import { SmsInboxView } from '@/components/communication/phone/SmsInboxView';
import { TextingView } from '@/components/communication/phone/TextingView';
// The seed/local merge is business logic, and the legacy page already exports
// it. Importing it keeps ONE convergent implementation - a copy here would be
// free to drift, and the drift would only show up as duplicated conversations
// after a poll.
import { mergeServerThreads } from '@/lib/communication/mergeServerThreads';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { PageHeader } from '@/ui-kit/components/layout/pageHeader';
import { toast } from '@/ui-kit/components/ui/sonner';

import { TabStrip } from '../_shared/tabs';
import { ModuleTabPanel, useRoutedTab } from './components/routedTabs';
import { useRecordVisit } from '../pageBreadcrumbs';

type TextTab = 'inbox' | 'settings';

const TAB_KEYS: readonly TextTab[] = ['inbox', 'settings'];

/**
 * /v2/communication/text - the SMS shell on the kit.
 *
 * A shell, exactly as the legacy page is: the two texting surfaces
 * (`SmsInboxView`, `TextingView`) are reused whole, because the kit has no
 * three-pane messenger and no templates/automations/compliance editor to
 * replace them with. What changed is the frame - PageHeader, the kit tab strip,
 * and sonner in place of the app toaster.
 *
 * The CASL gate, the thread lift and the URL tab mechanism are the legacy
 * page's, including the search-param write that the path param then overrides
 * (see `components/routedTabs.tsx`).
 */
export default function TextPage() {
  useRecordVisit('comm-text');
  const ability = useAppAbility();
  const canRead = ability.can('read', 'Communication');

  const onToast = (m: string) => toast(m);

  const { active, goToTab } = useRoutedTab<TextTab>(TAB_KEYS, 'inbox');

  const { data: seedThreads = [] } = useMessageThreads();
  const [threads, setThreads] = useState<MessageThread[]>([]);

  // Seed-merge, NOT wholesale clobber: with live polling a refetch would
  // otherwise wipe optimistic local-only threads. The empty-seed early return
  // keeps the effect loop-free when data is [].
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the merge takes the PREVIOUS local threads as an input, so it cannot be expressed as a value derived from the query alone; removing it loses the optimistic local-only threads on every poll
    if (seedThreads.length) setThreads((prev) => mergeServerThreads(prev, seedThreads));
  }, [seedThreads]);

  // Coarse module gate - returned BEFORE any JSX, exactly as the legacy page
  // does, so the queries above still fire for a denied user and the 403 burst
  // is unchanged.
  if (!canRead) {
    return <EmptyState title="You don't have access to the Text module." />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        className="mb-3 shrink-0"
        title="Text"
      />

      <TabStrip
        className="shrink-0"
        value={active}
        onValueChange={(next) => goToTab(next as TextTab)}
        tabs={[
          {
            value: 'inbox',
            label: (
              <span className="flex items-center gap-1.5">
                <InboxIcon /> Inbox
              </span>
            ),
          },
          {
            value: 'settings',
            label: (
              <span className="flex items-center gap-1.5">
                <Settings /> Settings
              </span>
            ),
          },
        ]}
      />

      <ModuleTabPanel value="inbox" activeValue={active} className="overflow-hidden">
        <SmsInboxView threads={threads} setThreads={setThreads} onToast={onToast} />
      </ModuleTabPanel>
      <ModuleTabPanel value="settings" activeValue={active} className="overflow-y-auto">
        <TextingView onToast={onToast} />
      </ModuleTabPanel>
    </div>
  );
}
