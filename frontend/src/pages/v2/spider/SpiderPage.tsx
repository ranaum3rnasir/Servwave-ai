import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { PageHeader } from '@/ui-kit/components/layout/pageHeader';
import { Button } from '@/ui-kit/components/ui/button';
import { Card, CardContent } from '@/ui-kit/components/ui/card';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';
import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { AI_AGENTS } from '@/lib/ai-center/agents';
import { useAgentStatus, useAgentSwitchControl } from '@/lib/ai-center/agentStatus';
import { SPIDER_STATUS_KEY } from '@/lib/api/spider';
import { AgentControlRow } from '@/components/ai-center/AgentControls';
import { TabPanel, TabStrip, type TabItem } from '../_shared/tabs';
import { SpiderSettingsForm } from './SpiderSettingsForm';
import { SpiderHistory } from './SpiderHistory';

const TABS: TabItem[] = [
  { value: 'settings', label: 'Settings' },
  { value: 'history', label: 'History' },
];

/**
 * The Settings tab while its form holds edits that are not saved and another tab is open: a small
 * dot, and the same fact in words for a screen reader ("Settings, unsaved changes").
 */
const SETTINGS_UNSAVED_TAB: TabItem = {
  value: 'settings',
  label: (
    <span className="inline-flex items-center gap-1.5">
      Settings
      <span aria-hidden data-spider-unsaved-dot className="size-1.5 shrink-0 rounded-full bg-warning-strong" />
      <span className="sr-only">, unsaved changes</span>
    </span>
  ),
};

const SPIDER = AI_AGENTS.find((a) => a.id === 'spider')!;

/** Leads the turn-off question while the settings form holds changes that are not saved yet. */
const UNSAVED_OFF_WARNING = 'The settings changes you have not saved will be lost.';

/**
 * Spider, the AI Center's lead watcher (#2619). Admin-only, behind the Spider gate (see
 * spider.routes.tsx). Settings and History both come from the server; nothing is kept in the
 * browser.
 *
 * The page follows the agent's three layers (Ran, 14 Oct): the gate keeps a company without Spider
 * out (layer 1); the switch at the top is the same one as in the AI Agentic Farm's pop-up (layer 2);
 * and Settings and History open only while Spider is on (layer 3). While it is off the page still
 * opens, so an Admin can turn it back on right here, but shows a locked panel in their place and
 * asks the server for neither. Switching unlocks or locks the page in place.
 *
 * Edits not saved yet stay as long as the Admin stays on this page (Ran, 14 Oct): the Settings
 * panel stays mounted, hidden, while History is open and there are any, so switching tabs never
 * throws them away.
 * They live only in this page's memory: leaving the page, or turning Spider off (which locks it,
 * after asking), drops them.
 */
export default function SpiderPage() {
  const [tab, setTab] = useState('settings');
  const status = useAgentStatus(SPIDER.id);
  const control = useAgentSwitchControl(SPIDER.id);
  // Turning Spider off locks the page and unmounts the form, so unsaved edits there would go
  // without a word: the switch asks first while there are any, from either tab (the form stays
  // mounted behind History, so its edits are still pending there).
  const [unsaved, setUnsaved] = useState(false);
  const tabs = unsaved && tab !== 'settings' ? [SETTINGS_UNSAVED_TAB, TABS[1]!] : TABS;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <PageHeader
        title="Spider"
        description="Your lead watcher. Spider alerts your team when a lead has stayed in one status too long."
      />
      <AgentControlRow
        agent={SPIDER}
        status={status}
        control={control}
        className="mb-0"
        unsavedWarning={unsaved ? UNSAVED_OFF_WARNING : undefined}
      />
      {status.status === 'on' ? (
        <>
          <TabStrip tabs={tabs} value={tab} onValueChange={setTab} />
          {/* Kept mounted behind History only while it holds a draft: with nothing unsaved there
              is nothing to keep, and a form that is not mounted asks the server for nothing. */}
          <TabPanel value="settings" activeValue={tab} keepMounted={unsaved}>
            <SpiderSettingsForm onUnsavedChange={setUnsaved} />
          </TabPanel>
          <TabPanel value="history" activeValue={tab}>
            {tab === 'history' && <SpiderHistory />}
          </TabPanel>
        </>
      ) : status.status === 'off' ? (
        <SpiderLocked />
      ) : status.status === 'unknown' ? (
        <SpiderStatusError />
      ) : (
        // Until the switch is read: never a flash of the settings, nor of the lock.
        <Skeleton data-spider-page-placeholder aria-hidden className="h-64 w-full rounded-card" />
      )}
    </div>
  );
}

/** Layer 3 while Spider is off: what is behind the lock, and how to open it (the switch above). */
function SpiderLocked() {
  return (
    <Card data-spider-locked>
      <EmptyState
        icon={<Lock aria-hidden />}
        title="Spider is off"
        description="Turn it on to change its settings or see its history."
      />
    </Card>
  );
}

/** The switch could not be read: claim nothing, open nothing, offer to ask again. */
function SpiderStatusError() {
  const qc = useQueryClient();
  return (
    <Card>
      <CardContent className="flex flex-col items-start gap-3 py-6">
        <p role="alert" className="text-sm text-danger-text">
          Could not load whether Spider is on.
        </p>
        <Button variant="outline" onClick={() => qc.invalidateQueries({ queryKey: SPIDER_STATUS_KEY })}>
          Try again
        </Button>
      </CardContent>
    </Card>
  );
}
