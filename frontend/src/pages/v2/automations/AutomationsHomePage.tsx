import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatDistanceToNow } from 'date-fns';
import {
  Plus,
  CheckCircle2,
  PauseCircle,
  Send,
  Copy,
  Trash2,
  AlertTriangle,
} from 'lucide-react';

import { StatCard, StatCardGroup } from '@/ui-kit/components/data/statCard';
import { PageHeader } from '@/ui-kit/components/layout/pageHeader';
import { Button } from '@/ui-kit/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';
import { Switch } from '@/ui-kit/components/ui/switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/ui-kit/components/ui/tooltip';
import {
  useWorkflows,
  useWorkflowCatalog,
  useToggleWorkflow,
  useDeleteWorkflow,
  useCreateWorkflow,
  type ApiWorkflow,
  type AutomationTemplate,
  type WorkflowCatalog,
} from '@/lib/api/workflows';
import { describeWorkflow, templateToWorkflowBody } from '@/lib/workflows/describeWorkflow';

import { v2Path } from '../uiV2';
import { useRecordVisit } from '../pageBreadcrumbs';
import { EM_DASH, MIDDOT } from './components/glyphs';
import { Pressable } from './components/pressable';
import { CATEGORY_META, CATEGORY_ORDER, FlowTrail, WorkflowStatusChip } from './components/workflowVisuals';

/**
 * /v2/automations - the Automations landing page on the CRM UI kit.
 *
 * Templates are the front door: a blank canvas is never shown. Composition,
 * top to bottom, is the legacy page's:
 *   1. header, with the primary "New automation";
 *   2. stat band, rendered only once any workflow exists;
 *   3. "My automations", same;
 *   4. the templates gallery, ALWAYS shown.
 *
 * Every query, mutation and derived counter below is the legacy page's,
 * imported or copied verbatim. Only the components changed.
 */

const fmt = (n: number) => new Intl.NumberFormat('en-US').format(n);

export default function AutomationsHomePage() {
  useRecordVisit('automations');
  const navigate = useNavigate();
  const {
    data: workflows,
    isLoading: workflowsLoading,
    isError: workflowsError,
    refetch: refetchWorkflows,
  } = useWorkflows();
  const {
    data: catalog,
    isLoading: catalogLoading,
    isError: catalogError,
    refetch: refetchCatalog,
  } = useWorkflowCatalog();
  const createWorkflow = useCreateWorkflow();
  const [deleteTarget, setDeleteTarget] = useState<ApiWorkflow | null>(null);

  const hasWorkflows = Boolean(workflows && workflows.length > 0);
  const activeCount = (workflows ?? []).filter((w) => w.status === 'PUBLISHED' && w.is_enabled).length;
  const pausedCount = (workflows ?? []).filter((w) => w.status === 'PUBLISHED' && !w.is_enabled).length;
  // trigger_count is a count of RUNS, not of sends (#1882) - which is what this
  // card, and the per-row "Ran N times" below it, have always said.
  const runsAllTime = (workflows ?? []).reduce((sum, w) => sum + w.trigger_count, 0);

  // NOT `useTemplate`, which is what the legacy page calls it. This is a plain
  // async click handler and calls no Hooks, but the `use` prefix makes the hook
  // rules read it as one, so the `onUse={() => ...}` call site below reports as
  // "React Hook cannot be called inside a callback". Named for what it does
  // instead - the alternative is a per-item child component wrapping a handler
  // that was never a Hook to begin with.
  async function applyTemplate(template: AutomationTemplate) {
    const created = await createWorkflow.mutateAsync(templateToWorkflowBody(template));
    navigate(v2Path(`/automations/${created.id}`));
  }

  async function duplicate(workflow: ApiWorkflow) {
    const created = await createWorkflow.mutateAsync({
      name: `${workflow.name} (copy)`,
      trigger_type: workflow.trigger_type,
      trigger_config: workflow.trigger_config,
      // send_window deliberately NOT copied: duplicating one of the few legacy
      // BUSINESS_HOURS rows would otherwise mint a brand-new automation with a
      // deferral rule no screen can show. Copies start ANYTIME like everything
      // else the builder creates.
      steps: workflow.steps.map((s) => ({ step_type: s.step_type, config: s.config })),
    });
    navigate(v2Path(`/automations/${created.id}`));
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Automations"
        description={`Put reminders, follow-ups and team alerts on autopilot ${EM_DASH} start from a recipe below.`}
        actions={
          <Button onClick={() => navigate(v2Path('/automations/new'))}>
            <Plus aria-hidden />
            New automation
          </Button>
        }
      />

      {workflowsLoading ? (
        <div className="grid grid-cols-3 gap-3">
          <Skeleton className="h-[76px] w-full" />
          <Skeleton className="h-[76px] w-full" />
          <Skeleton className="h-[76px] w-full" />
        </div>
      ) : (
        hasWorkflows && (
          <StatCardGroup>
            <StatCard tone="green" label="Active" value={fmt(activeCount)} />
            <StatCard tone="amber" label="Paused" value={fmt(pausedCount)} />
            <StatCard tone="brand" label="Runs all-time" value={fmt(runsAllTime)} />
          </StatCardGroup>
        )
      )}

      {workflowsError ? (
        <ErrorBanner message="Could not load your automations." onRetry={refetchWorkflows} />
      ) : workflowsLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-[92px] w-full" />
          <Skeleton className="h-[92px] w-full" />
        </div>
      ) : (
        hasWorkflows && (
          <div className="space-y-3">
            <p className="text-sm font-semibold">My automations</p>
            <div className="space-y-3">
              {(workflows ?? []).map((workflow) => (
                <WorkflowRow
                  key={workflow.id}
                  workflow={workflow}
                  catalog={catalog}
                  onOpen={() => navigate(v2Path(`/automations/${workflow.id}`))}
                  onDuplicate={() => duplicate(workflow)}
                  onDeleteRequest={() => setDeleteTarget(workflow)}
                />
              ))}
            </div>
          </div>
        )
      )}

      {/* Templates gallery, the front door */}
      <div className="space-y-8">
        {!hasWorkflows && !workflowsLoading && !workflowsError && (
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold">Start from a recipe</p>
            <Button variant="outline" size="sm" onClick={() => navigate(v2Path('/automations/new'))}>
              Start from scratch
            </Button>
          </div>
        )}

        {catalogError ? (
          <ErrorBanner message="Could not load the templates gallery." onRetry={refetchCatalog} />
        ) : catalogLoading ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            <Skeleton className="h-[180px] w-full" />
            <Skeleton className="h-[180px] w-full" />
            <Skeleton className="h-[180px] w-full" />
          </div>
        ) : (
          CATEGORY_ORDER.map((category) => {
            // Texting templates are hidden until this org can actually text: a
            // locked step must not be able to enter a workflow via any door.
            const smsAvailable = Boolean(catalog?.capabilities?.sms_available);
            const group = (catalog?.templates ?? []).filter(
              (t) => t.category === category && !(!smsAvailable && t.action_type === 'SEND_SMS'),
            );
            // A category that ends up empty renders nothing at all, not an
            // empty section header.
            if (group.length === 0) return null;
            const meta = CATEGORY_META[category];
            const Icon = meta.icon;
            return (
              <section key={category}>
                <div className="mb-3 flex items-center gap-2.5">
                  <div className={`flex size-8 items-center justify-center rounded-md ${meta.tile}`}>
                    <Icon className="size-4" aria-hidden />
                  </div>
                  <div>
                    <p className="text-sm font-semibold">{meta.title}</p>
                    <p className="text-muted-foreground text-xs">{meta.blurb}</p>
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {group.map((template) => (
                    <TemplateCard
                      key={template.key}
                      template={template}
                      catalog={catalog}
                      onUse={() => applyTemplate(template)}
                      busy={createWorkflow.isPending}
                    />
                  ))}
                </div>
              </section>
            );
          })
        )}
      </div>

      {/* Delete confirmation. No typed confirmation, no second step. */}
      <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete &quot;{deleteTarget?.name}&quot;?</DialogTitle>
            <DialogDescription>Its activity history is removed too. This can&apos;t be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <DeleteButton workflow={deleteTarget} onDone={() => setDeleteTarget(null)} />
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DeleteButton({ workflow, onDone }: { workflow: ApiWorkflow | null; onDone: () => void }) {
  const remove = useDeleteWorkflow();
  return (
    <Button
      variant="destructive"
      disabled={!workflow || remove.isPending}
      onClick={() => {
        if (!workflow) return;
        remove.mutate(workflow.id, { onSuccess: onDone });
      }}
    >
      <Trash2 aria-hidden />
      Delete
    </Button>
  );
}

function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="border-destructive/20 bg-destructive/5 text-destructive flex items-center justify-between rounded-lg border px-4 py-3 text-sm">
      <span className="flex items-center gap-2">
        <AlertTriangle className="size-4" aria-hidden />
        {message}
      </span>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

function WorkflowRow({
  workflow,
  catalog,
  onOpen,
  onDuplicate,
  onDeleteRequest,
}: {
  workflow: ApiWorkflow;
  catalog: WorkflowCatalog | undefined;
  onOpen: () => void;
  onDuplicate: () => void;
  onDeleteRequest: () => void;
}) {
  const toggle = useToggleWorkflow();
  const isDraft = workflow.status !== 'PUBLISHED';
  const sentence = describeWorkflow(workflow.trigger_type, workflow.trigger_config, workflow.steps, catalog);
  // Same fallback the builder heading and document title already use (SRVW-249)
  // for a draft whose name is blank or whitespace-only - one placeholder string
  // for "no name yet", not a second one coined here.
  const displayName = workflow.name.trim() || 'Untitled automation';
  const runsLabel = `Ran ${fmt(workflow.trigger_count)} ${workflow.trigger_count === 1 ? 'time' : 'times'}`;
  const lastRunLabel = workflow.last_triggered_at
    ? ` ${MIDDOT} last ${formatDistanceToNow(new Date(workflow.last_triggered_at), { addSuffix: true })}`
    : '';

  const switchEl = (
    <Switch
      checked={workflow.is_enabled}
      disabled={isDraft || toggle.isPending}
      onCheckedChange={(checked) => toggle.mutate({ id: workflow.id, is_enabled: checked })}
      aria-label={workflow.is_enabled ? `Pause ${workflow.name}` : `Turn on ${workflow.name}`}
    />
  );

  return (
    <div className="border-border bg-kit-card shadow-xs hover:border-brand hover:shadow-md group flex items-center gap-4 rounded-lg border p-4 transition-all">
      {/* No aria-label on this click target, on purpose. The name, sentence and
          stats text below IS its accessible name; an aria-label would silently
          swallow all three from screen readers. */}
      <Pressable onPress={onOpen} className="flex min-w-0 flex-1 items-center rounded-md text-left">
        {/* No step-icon trail here (SRVW-215) - it repeated what the sentence
            below already says in words, and it ate the room this text block
            needed. Freed space goes to the name/sentence/stats column, not to
            new whitespace; FlowTrail itself is unchanged and still used by
            TemplateCard below. */}
        <div className="min-w-0 flex-1 space-y-1">
          <p className="truncate text-sm font-semibold tracking-tight">{displayName}</p>
          <p className="text-muted-foreground truncate text-xs">{sentence}</p>
          <p className="text-muted-foreground text-xs">
            {runsLabel}
            {lastRunLabel}
          </p>
        </div>
      </Pressable>

      <div className="flex shrink-0 items-center gap-2">
        <WorkflowStatusChip status={workflow.status} is_enabled={workflow.is_enabled} />
        {isDraft ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                {/* A disabled Switch swallows pointer events, so the tooltip
                    listens on a focusable wrapper. */}
                <span tabIndex={0} className="inline-flex">
                  {switchEl}
                </span>
              </TooltipTrigger>
              <TooltipContent>Publish first</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          switchEl
        )}
        {/* Open dropped: the whole card is already `onOpen`'s click target
            (Pressable above), so a third way to reach the same place was a
            menu click spent on a redundant action. Duplicate and delete are
            the two real actions, so they get direct icon buttons instead. */}
        <Button
          variant="ghost"
          size="icon"
          className="size-11"
          title={`Duplicate ${displayName}`}
          aria-label={`Duplicate ${displayName}`}
          onClick={onDuplicate}
        >
          <Copy aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="text-destructive hover:text-destructive size-11"
          title={`Delete ${displayName}`}
          aria-label={`Delete ${displayName}`}
          onClick={onDeleteRequest}
        >
          <Trash2 aria-hidden />
        </Button>
      </div>
    </div>
  );
}

function TemplateCard({
  template,
  catalog,
  onUse,
  busy,
}: {
  template: AutomationTemplate;
  catalog: WorkflowCatalog | undefined;
  onUse: () => void;
  busy: boolean;
}) {
  const stepType = template.action_type === 'SEND_SMS' ? 'SEND_TEXT' : template.action_type;
  const sentence = describeWorkflow(
    template.trigger_type,
    template.trigger_config ?? null,
    [{ step_type: stepType, config: template.action_config }],
    catalog,
  );

  return (
    <div className="border-border bg-kit-card shadow-xs hover:border-brand hover:shadow-md group flex flex-col rounded-lg border p-4 transition-all">
      <FlowTrail steps={[{ step_type: stepType }]} />
      <p className="mt-3 text-base font-semibold">{template.name}</p>
      <p className="text-muted-foreground mt-1 flex-1 text-[13px]">{template.description}</p>
      <p className="text-muted-foreground mt-2 text-xs">{sentence}</p>
      <Button size="sm" className="mt-3 self-start" onClick={onUse} disabled={busy}>
        Use this
      </Button>
    </div>
  );
}
