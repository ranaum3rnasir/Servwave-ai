/**
 * WorkflowBuilderPage — THE hero screen. A guided vertical spine of movable
 * bubbles (BuilderSpine) with a right config drawer, a 4-state publish control,
 * and autosave. Handles both `/automations/:id` (loads the workflow) and
 * `/automations/new` (create-on-first-save: an unsaved local draft until the
 * first debounced autosave POSTs createWorkflow, then the URL is swapped to the
 * real id via navigate replace — no reload, no lost edits).
 *
 * Position is array index everywhere: the draft holds an ordered step list, and
 * every save renumbers positions from that order (server contract).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { ArrowLeft, FlaskConical, ListChecks, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/components/ui/use-toast';
import { formatDistanceToNow } from 'date-fns';
import {
  useWorkflow,
  useWorkflowCatalog,
  useCreateWorkflow,
  usePatchWorkflow,
  usePublishWorkflow,
  useToggleWorkflow,
  type ApiWorkflow,
} from '@/lib/api/workflows';
import { describeWorkflow } from '@/lib/workflows/describeWorkflow';
import { useWorkflowDraft, draftToInput } from '@/components/workflows/useWorkflowDraft';
import BuilderSpine from '@/components/workflows/BuilderSpine';
import StepConfigDrawer from '@/components/workflows/StepConfigDrawer';
import PublishControl from '@/components/workflows/PublishControl';
import WorkflowActivity from '@/components/workflows/WorkflowActivity';
import WorkflowSettings from '@/components/workflows/WorkflowSettings';
import TestWorkflowDialog from '@/components/workflows/TestWorkflowDialog';

const AUTOSAVE_DELAY_MS = 3000;

function savedStamp(lastSavedAt: number | null): string {
  if (lastSavedAt == null) return '';
  const secs = (Date.now() - lastSavedAt) / 1000;
  if (secs < 45) return 'Saved just now';
  return `Saved ${formatDistanceToNow(lastSavedAt, { addSuffix: true })}`;
}

export default function WorkflowBuilderPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data: workflow, isLoading: workflowLoading, isError: workflowError, refetch: refetchWorkflow } = useWorkflow(id);
  const { data: catalog } = useWorkflowCatalog();

  const create = useCreateWorkflow();
  const patch = usePatchWorkflow();
  const publish = usePublishWorkflow();
  const toggle = useToggleWorkflow();

  const draft = useWorkflowDraft();
  const {
    state,
    setName,
    setTrigger,
    addStep,
    moveStep,
    removeStep,
    updateStepConfig,
    selectStep,
    selectTrigger,
    clearSelection,
    hydrate,
    markSaved,
    issuesByStepIndex,
  } = draft;

  const [tab, setTab] = useState('builder');
  const [tidyKey, setTidyKey] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [testOpen, setTestOpen] = useState(false);

  // Refs keep the debounced timer + unmount flush reading the LATEST draft.
  const stateRef = useRef(state);
  stateRef.current = state;
  const savingRef = useRef(false);
  const hydratedRef = useRef(false);

  // ── first-load hydration (once) ──────────────────────────────────────────────
  useEffect(() => {
    if (hydratedRef.current) return;
    if (id) {
      if (workflow) {
        hydrate(workflow);
        hydratedRef.current = true;
      }
    } else {
      hydratedRef.current = true; // /new — the blank draft is already in state
    }
  }, [id, workflow, hydrate]);

  // ── autosave ─────────────────────────────────────────────────────────────────
  const flush = useCallback(async () => {
    const s = stateRef.current;
    if (!s.dirty || savingRef.current) return;
    const rev = s.revision;
    const body = draftToInput(s);
    savingRef.current = true;
    setIsSaving(true);
    let savedOk = false;
    try {
      let saved: ApiWorkflow;
      if (!s.server.id) {
        saved = await create.mutateAsync(body);
        navigate(`/automations/${saved.id}`, { replace: true });
      } else {
        saved = await patch.mutateAsync({ id: s.server.id, data: body });
      }
      // markSaved clears dirty only when no edit landed during the round-trip
      // (revision unchanged). If one did, dirty stays true and the debounce
      // effect below re-arms to persist it — no synchronous re-flush needed
      // (reading stateRef right after a setState would see a stale value).
      markSaved(rev, saved);
    } catch {
      // The mutation hooks surface the error toast; the draft stays dirty so the
      // next edit (or an explicit publish) retries.
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  }, [create, patch, markSaved, navigate]);

  // TanStack mutation RESULT objects change identity every render, so `flush`
  // is re-created per render. Effects must therefore reach it through a ref —
  // depending on `flush` directly would re-run them every render, turning the
  // unmount cleanup into a save-per-keystroke flood (and an unbounded retry
  // loop when the server keeps failing).
  const flushRef = useRef(flush);
  flushRef.current = flush;

  // Debounce: (re)arm 3s after each edit while dirty.
  useEffect(() => {
    if (!state.dirty) return;
    const t = setTimeout(() => void flushRef.current(), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(t);
  }, [state.dirty, state.revision]);

  // Flush any pending edit on TRUE unmount only.
  useEffect(() => () => void flushRef.current(), []);

  // ── publish / toggle ─────────────────────────────────────────────────────────
  // Both fold the mutation RESPONSE back into the draft's server snapshot via
  // markSaved — the header's 4-state control derives from that snapshot, and the
  // page hydrates only once, so without this the Live state would appear only
  // after a full reload.
  const handlePublish = useCallback(async () => {
    // Save the current draft first so we publish exactly what's on screen.
    await flush();
    const s = stateRef.current;
    if (!s.server.id || s.server.issues.length > 0) return;
    try {
      const published = await publish.mutateAsync({ id: s.server.id, enable: true });
      markSaved(stateRef.current.revision, published);
      toast({ title: 'Live — this automation is now running', description: published.name });
    } catch {
      // usePublishWorkflow's onError already toasts; the control stays on Draft.
    }
  }, [flush, publish, markSaved]);

  const handleToggle = useCallback(
    async (enabled: boolean) => {
      const wfId = stateRef.current.server.id;
      if (!wfId) return;
      try {
        const updated = await toggle.mutateAsync({ id: wfId, is_enabled: enabled });
        markSaved(stateRef.current.revision, updated);
      } catch {
        // useToggleWorkflow's onError already toasts; the switch shows server truth.
      }
    },
    [toggle, markSaved],
  );

  function handleTidyUp() {
    setTidyKey((k) => k + 1);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    toast({ title: 'All tidy ✨', description: 'Your steps are lined up top to bottom.' });
  }

  // ── drawer wiring ────────────────────────────────────────────────────────────
  const selectedStep = useMemo(
    () => (state.selectedUid && state.selectedUid !== 'trigger' ? state.steps.find((s) => s.uid === state.selectedUid) : undefined),
    [state.selectedUid, state.steps],
  );
  const drawerMode: 'trigger' | 'step' | null =
    state.selectedUid === 'trigger' ? 'trigger' : selectedStep ? 'step' : null;

  const sentence = state.triggerConfigured
    ? describeWorkflow(state.trigger_type, state.trigger_config, state.steps, catalog)
    : 'Choose what starts this automation to get going.';
  const stamp = isSaving ? 'Saving…' : state.dirty ? 'Unsaved changes' : savedStamp(state.lastSavedAt);
  const testDisabled = state.dirty || !state.server.id;

  // Dry-run steps are index-aligned with the draft's steps (both walk the same
  // saved order), so "Fix it" just opens that index's node in the drawer.
  function handleFixStep(stepIndex: number) {
    const step = state.steps[stepIndex];
    if (step) selectStep(step.uid);
  }

  if (id && workflowLoading && !hydratedRef.current) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-[520px] w-full" />
      </div>
    );
  }

  // A real id that failed to load must NEVER fall through to the blank draft —
  // the first edit there would CREATE a duplicate workflow. Fail loudly instead.
  if (id && !hydratedRef.current && (workflowError || (!workflowLoading && !workflow))) {
    return (
      <div className="space-y-4">
        <Link to="/automations" className="inline-flex items-center gap-1 text-sm text-primary underline-offset-2 hover:underline">
          <ArrowLeft className="h-4 w-4" aria-hidden /> Automations
        </Link>
        <div className="rounded-card border border-border bg-surface-light p-8 text-center shadow-card">
          <p className="text-base font-semibold text-text-primary">Couldn&rsquo;t load this automation</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-text-secondary">
            It may have been deleted, or the connection dropped. Nothing was changed.
          </p>
          <div className="mt-4 flex justify-center gap-3">
            <Button variant="outline" onClick={() => void refetchWorkflow()}>Try again</Button>
            <Button onClick={() => navigate('/automations')}>Back to Automations</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Link to="/automations" className="inline-flex items-center gap-1 text-sm text-primary underline-offset-2 hover:underline">
        <ArrowLeft className="h-4 w-4" aria-hidden /> Automations
      </Link>

      {/* Header */}
      <div className="flex flex-col gap-4 border-b border-border pb-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <input
            aria-label="Automation name"
            value={state.name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void flush()}
            maxLength={120}
            placeholder="Name this automation"
            className="w-full max-w-xl truncate rounded border border-transparent bg-transparent px-1 py-0.5 text-2xl font-bold tracking-tight text-text-primary outline-none transition-colors hover:border-border focus:border-primary"
          />
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 px-1">
            <p className="max-w-xl truncate text-sm text-text-secondary">{sentence}</p>
            {stamp && <span className="text-xs text-text-secondary/80">· {stamp}</span>}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          {testDisabled ? (
            <TooltipProvider delayDuration={0}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0} className="inline-flex">
                    <Button variant="outline" disabled aria-disabled>
                      <FlaskConical className="mr-1.5 h-4 w-4" aria-hidden /> Test
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>Save your changes first</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : (
            <Button variant="outline" onClick={() => setTestOpen(true)}>
              <FlaskConical className="mr-1.5 h-4 w-4" aria-hidden /> Test
            </Button>
          )}
          <PublishControl
            status={state.server.status}
            hasUnpublishedChanges={state.server.has_unpublished_changes}
            dirty={state.dirty}
            issues={
              // A never-saved empty draft has no server verdict yet — synthesize
              // the one issue that matters so Publish is honestly disabled
              // (instead of enabled-but-silently-doing-nothing).
              !state.server.id && state.steps.length === 0
                ? [{ step_index: -1, path: 'steps', message: 'Add at least one step' }]
                : state.server.issues
            }
            isEnabled={state.server.is_enabled}
            onPublish={handlePublish}
            onToggleEnabled={handleToggle}
            isPublishing={publish.isPending || isSaving}
            isToggling={toggle.isPending}
          />
        </div>
      </div>

      {/* Tabs */}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="builder">Builder</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="builder">
          {/* Canvas — cool app surface so the white bubbles pop */}
          <div className="rounded-card border border-border bg-background-light">
            <div className="flex flex-col gap-2 border-b border-border px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between">
              <p className="flex items-center gap-2 text-xs text-text-secondary">
                <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden />
                <span>
                  <b className="font-semibold text-text-primary">Guided flow</b> — drag a bubble to reorder, tap + to
                  insert a step. Everything stays on the line.
                </span>
              </p>
              <Button variant="outline" size="sm" onClick={handleTidyUp}>
                <ListChecks className="mr-1.5 h-4 w-4" aria-hidden /> Tidy up
              </Button>
            </div>
            <div key={tidyKey} className="animate-in fade-in-0 slide-in-from-top-1 px-4 py-6 duration-300">
              <BuilderSpine
                draft={state}
                catalog={catalog}
                issuesByStepIndex={issuesByStepIndex}
                onSelectTrigger={selectTrigger}
                onSelectStep={selectStep}
                onAddStep={addStep}
                onMoveStep={moveStep}
                onRemoveStep={removeStep}
              />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="activity">
          <WorkflowActivity
            id={state.server.id}
            status={state.server.status}
            isEnabled={state.server.is_enabled}
          />
        </TabsContent>
        <TabsContent value="settings">
          <WorkflowSettings id={state.server.id} name={state.name} onSetName={setName} />
        </TabsContent>
      </Tabs>

      <StepConfigDrawer
        open={drawerMode !== null}
        onOpenChange={(open) => !open && clearSelection()}
        mode={drawerMode}
        step={selectedStep}
        triggerType={state.trigger_type}
        triggerConfig={state.trigger_config}
        triggerConfigured={state.triggerConfigured}
        stepCount={state.steps.length}
        catalog={catalog}
        onUpdateStepConfig={updateStepConfig}
        onSetTrigger={setTrigger}
        onRemoveStep={removeStep}
      />

      <TestWorkflowDialog
        open={testOpen}
        onOpenChange={setTestOpen}
        workflowId={state.server.id}
        onFixStep={handleFixStep}
      />
    </div>
  );
}
