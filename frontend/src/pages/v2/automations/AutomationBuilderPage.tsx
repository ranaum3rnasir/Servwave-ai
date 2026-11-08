import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { formatDistanceToNow } from 'date-fns';
import { FlaskConical, History, PencilLine, Sparkles, Trash2 } from 'lucide-react';

import { Button } from '@/ui-kit/components/ui/button';
import { Heading } from '@/ui-kit/components/ui/heading';
import { Input } from '@/ui-kit/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/ui-kit/components/ui/sheet';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';
import { toast } from '@/ui-kit/components/ui/sonner';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/ui-kit/components/ui/tooltip';
import { useConfirm } from '@/hooks/useConfirm';
import { deleteWorkflowPrompt } from '@/lib/confirmPrompts';
import {
  useWorkflow,
  useWorkflowCatalog,
  useCreateWorkflow,
  usePatchWorkflow,
  usePublishWorkflow,
  useToggleWorkflow,
  useDeleteWorkflow,
  type ApiWorkflow,
} from '@/lib/api/workflows';
import { describeWorkflow } from '@/lib/workflows/describeWorkflow';
import { useWorkflowDraft, draftToInput } from '@/components/workflows/useWorkflowDraft';

import { v2Path } from '../uiV2';
import { BackLink } from '../_shared/backLink';
import BuilderSpine from './components/builderSpine';
import PublishControl from './components/publishControl';
import StepConfigDrawer from './components/stepConfigDrawer';
import TestWorkflowDialog from './components/testWorkflowDialog';
import WorkflowActivity from './components/workflowActivity';
import { ELLIPSIS, EM_DASH, MIDDOT } from './components/glyphs';
import { useRecordVisit } from '../pageBreadcrumbs';

/**
 * /v2/automations/new and /v2/automations/:id - the builder, on the CRM UI kit.
 *
 * One component serves both routes; `useParams` distinguishes them.
 *
 * THE AUTOSAVE IS THE WHOLE COMMIT MECHANISM. There is no submit button
 * anywhere in this module: every form propagates its parsed config into the
 * draft and the debounce below is what persists it. Four interlocking pieces
 * carry that, and all four are reproduced here unchanged from the legacy page
 * because getting any of them wrong silently loses user data:
 *
 *   1. a 3s debounce keyed on `[state.dirty, state.revision]`;
 *   2. an unmount flush, with an EMPTY dep array so it fires on true unmount
 *      only;
 *   3. a blur flush on the header name input;
 *   4. a revision compare inside `markSaved`, which clears `dirty` only when no
 *      edit landed during the round trip.
 *
 * `flushRef` is not indirection for its own sake. TanStack mutation RESULT
 * objects change identity every render, so `flush` is recreated per render;
 * depending on it directly would re-run both effects every render, turning the
 * unmount cleanup into a save-per-keystroke flood and an unbounded retry loop
 * whenever the server keeps failing.
 *
 * `useWorkflowDraft` and `draftToInput` are IMPORTED from the legacy module,
 * never forked. They are the draft state machine, they are unit-tested there,
 * and a second copy is exactly the failure the "never fork business logic" rule
 * exists to prevent.
 *
 * Position is array index everywhere: the draft holds an ordered step list and
 * every save renumbers positions from that order (server contract).
 */

const AUTOSAVE_DELAY_MS = 3000;

function savedStamp(lastSavedAt: number | null): string {
  if (lastSavedAt == null) return '';
  const secs = (Date.now() - lastSavedAt) / 1000;
  if (secs < 45) return 'Saved just now';
  return `Saved ${formatDistanceToNow(lastSavedAt, { addSuffix: true })}`;
}

export default function AutomationBuilderPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const {
    data: workflow,
    isLoading: workflowLoading,
    isError: workflowError,
    refetch: refetchWorkflow,
  } = useWorkflow(id);
  const { data: catalog } = useWorkflowCatalog();

  const create = useCreateWorkflow();
  const patch = usePatchWorkflow();
  const publish = usePublishWorkflow();
  const toggle = useToggleWorkflow();
  const remove = useDeleteWorkflow();
  const { confirm, confirmDialog } = useConfirm();

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

  // The layout draws the ONLY breadcrumb (`V2AppLayout` -> `V2Breadcrumbs`), so
  // naming this page for the trail is all a page can contribute. It used to
  // draw a second, hierarchical trail of its own above the title, which put two
  // breadcrumb rows on the same screen saying different things.
  //
  // The name is the record, so it is what the crumb says - but it is also a
  // live, editable input, so an empty or whitespace-only draft would leave a
  // blank crumb. `id` distinguishes an unsaved /new draft from a saved
  // automation whose name the user just cleared.
  useRecordVisit('automations', state.name.trim() || (id ? 'Automation' : 'New automation'));

  const displayName = state.name.trim() || 'Untitled automation';

  // The page has no PageHeader and so no <h1> - see the header docblock below -
  // and no other mechanism in the app sets document.title, so this page owns
  // both. Keyed on displayName, this re-fires per keystroke in the name Input;
  // that is cheap and intentional, not debounced.
  useEffect(() => {
    document.title = `${displayName} - Automations - ServWave`;
    return () => {
      document.title = 'ServWave';
    };
  }, [displayName]);

  const [isSaving, setIsSaving] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);

  // Refs keep the debounced timer and the unmount flush reading the LATEST draft.
  //
  // Assigned during render ON PURPOSE, not in an effect. `handlePublish` below
  // does `await flush()` and then reads `stateRef.current` to pick up the server
  // id `markSaved` just wrote. That read is a microtask continuation, which
  // React runs BEFORE the passive-effect flush, so an effect-time assignment
  // would hand it the pre-save snapshot - publishing a brand-new automation
  // would see no `server.id` and silently return.
  const stateRef = useRef(state);
  // eslint-disable-next-line react-hooks/refs -- see above: an effect-time write lands after the await continuation that reads it
  stateRef.current = state;
  const savingRef = useRef(false);
  const hydratedRef = useRef(false);

  // first-load hydration, exactly once per mount
  useEffect(() => {
    if (hydratedRef.current) return;
    if (id) {
      if (workflow) {
        hydrate(workflow);
        hydratedRef.current = true;
      }
    } else {
      hydratedRef.current = true; // /new, the blank draft is already in state
    }
  }, [id, workflow, hydrate]);

  const flush = useCallback(async () => {
    const s = stateRef.current;
    if (!s.dirty || savingRef.current) return;
    const rev = s.revision;
    const body = draftToInput(s);
    savingRef.current = true;
    setIsSaving(true);
    try {
      let saved: ApiWorkflow;
      if (!s.server.id) {
        // Create-on-first-save. /automations/new has no server id until this
        // lands; the URL is then swapped for the real one with no reload and no
        // lost edits. Do NOT "simplify" this by creating eagerly on mount, that
        // would litter empty drafts.
        saved = await create.mutateAsync(body);
        navigate(v2Path(`/automations/${saved.id}`), { replace: true });
      } else {
        saved = await patch.mutateAsync({ id: s.server.id, data: body });
      }
      // markSaved clears dirty only when no edit landed during the round trip
      // (revision unchanged). If one did, dirty stays true and the debounce
      // effect below re-arms to persist it. No synchronous re-flush: reading
      // stateRef right after a setState would see a stale value.
      markSaved(rev, saved);
    } catch {
      // The mutation hooks surface the error toast; the draft stays dirty so the
      // next edit, or an explicit publish, retries.
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  }, [create, patch, markSaved, navigate]);

  // See the docblock: both effects below reach `flush` through this ref rather
  // than depending on it.
  // Also a render-phase write, for the same reason plus one of its own: the
  // unmount effect's cleanup is the last thing to run, and a commit that
  // re-renders and then unmounts in the same batch would never run an
  // effect-time assignment - the final flush would then call a `flush` closed
  // over stale mutation handles and lose the pending edit.
  const flushRef = useRef(flush);
  // eslint-disable-next-line react-hooks/refs -- see above: the unmount flush must see the newest `flush`, which an effect-time write cannot guarantee
  flushRef.current = flush;

  // Debounce: re-arm 3s after each edit while dirty.
  useEffect(() => {
    if (!state.dirty) return;
    const t = setTimeout(() => void flushRef.current(), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(t);
  }, [state.dirty, state.revision]);

  // Flush any pending edit on TRUE unmount only.
  useEffect(() => () => void flushRef.current(), []);

  // Publish and toggle both fold the mutation RESPONSE back into the draft's
  // server snapshot via markSaved. The header's 4-state control derives from
  // that snapshot and the page hydrates only once, so without this the Live
  // state would appear only after a full reload.
  const handlePublish = useCallback(async () => {
    // Save the current draft first, so we publish exactly what is on screen.
    await flush();
    const s = stateRef.current;
    if (!s.server.id || s.server.issues.length > 0) return;
    try {
      const published = await publish.mutateAsync({ id: s.server.id, enable: true });
      markSaved(stateRef.current.revision, published);
      // `.success`, not a bare `toast`: the bare call is sonner's untyped
      // variant, which carries no icon and no status colour, so a publish
      // confirmation landed as an unmarked grey slab.
      toast.success(`Live ${EM_DASH} this automation is now running`, { description: published.name });
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

  // Delete used to live in the Settings tab's danger zone; it now sits beside
  // Publish in the header. Disabled while `id` is undefined for the same
  // reason it was there: an unsaved /automations/new draft has no server row
  // to delete yet.
  const handleDelete = useCallback(async () => {
    const wfId = stateRef.current.server.id;
    if (!wfId) return;
    if (!(await confirm(deleteWorkflowPrompt(displayName)))) return;
    remove.mutate(wfId, { onSuccess: () => navigate(v2Path('/automations')) });
  }, [confirm, remove, navigate, displayName]);

  const selectedStep = useMemo(
    () =>
      state.selectedUid && state.selectedUid !== 'trigger'
        ? state.steps.find((s) => s.uid === state.selectedUid)
        : undefined,
    [state.selectedUid, state.steps],
  );
  const drawerMode: 'trigger' | 'step' | null =
    state.selectedUid === 'trigger' ? 'trigger' : selectedStep ? 'step' : null;

  const sentence = state.triggerConfigured
    ? describeWorkflow(state.trigger_type, state.trigger_config, state.steps, catalog)
    : 'Choose what starts this automation to get going.';
  const stamp = isSaving ? `Saving${ELLIPSIS}` : state.dirty ? 'Unsaved changes' : savedStamp(state.lastSavedAt);
  const testDisabled = state.dirty || !state.server.id;

  // Dry-run steps are index-aligned with the draft's steps (both walk the same
  // saved order), so "Fix it" just opens that index's node in the drawer.
  function handleFixStep(stepIndex: number) {
    const step = state.steps[stepIndex];
    if (step) selectStep(step.uid);
  }

  // `hydratedRef` is READ during render to pick a branch, so there is no
  // effect-time rewrite that helps: the point is that a refetch after the first
  // successful hydration must not drop the built page back to a skeleton. State
  // would re-render on the flip and reintroduce exactly that flicker.
  // eslint-disable-next-line react-hooks/refs -- render-time branch guard; the value must be readable in the same render that decides
  if (id && workflowLoading && !hydratedRef.current) {
    return (
      <div className="space-y-4">
        {/* Back is real here, not a skeleton: /automations/:id is deep-linkable,
            so this can be the FIRST thing a session renders - a placeholder
            would leave a slow or stalled load with no way out. */}
        <div className="-ml-2">
          <BackLink to={v2Path('/automations')}>Back to Automations</BackLink>
        </div>
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-[520px] w-full" />
      </div>
    );
  }

  // A real id that failed to load must NEVER fall through to the blank draft:
  // the first edit there would CREATE a duplicate workflow. Fail loudly
  // instead. This branch has to stay AHEAD of the normal return below.
  // eslint-disable-next-line react-hooks/refs -- render-time branch guard, same as above: this is the duplicate-workflow guard and has to decide inside this render
  if (id && !hydratedRef.current && (workflowError || (!workflowLoading && !workflow))) {
    return (
      <div className="space-y-4">
        <div className="border-border bg-kit-card shadow-xs rounded-lg border p-8 text-center">
          <p className="text-base font-semibold">Couldn&rsquo;t load this automation</p>
          <p className="text-muted-foreground mx-auto mt-1 max-w-md text-sm">
            It may have been deleted, or the connection dropped. Nothing was changed.
          </p>
          <div className="mt-4 flex justify-center gap-3">
            <Button variant="outline" onClick={() => void refetchWorkflow()}>
              Try again
            </Button>
            <Button onClick={() => navigate(v2Path('/automations'))}>Back to Automations</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header.
          This page cannot use the kit's `PageHeader` - its title is a live,
          editable `Input`, not an `<h1>` - so the back slot is reproduced by
          hand: same `BackLink`, same place (above the title, top left), same
          `mb-1` seam. `-ml-2`, not PageHeader's `-ml-3`: the link Button's own
          `px-3` is cancelled back to the TITLE's text edge, and here the title
          is an Input carrying `px-1`, so the arrow needs to stop 4px in rather
          than at 0.

          It is a `to`, never `navigate(-1)`: both /automations/new and
          /automations/:id are deep-linkable and reachable by redirect - the
          create page REPLACES its own URL with /automations/:id on first
          autosave - so a history pop lands somewhere arbitrary, or back on the
          /new entry that no longer holds this draft. */}
      <div>
        <div className="-ml-2 mb-1">
          <BackLink to={v2Path('/automations')}>Back to Automations</BackLink>
        </div>
        <div className="border-border flex flex-col gap-4 border-b pb-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            {/* The Input above carries the visible title; this is the same name
                for the document outline and the screen-reader heading list
                only, since the raw-tag ratchet forbids an <h1> outside
                src/ui-kit. `sr-only` costs the layout no space. */}
            <Heading level={1} scale="inherit" className="sr-only">
              {displayName}
            </Heading>
            <Input
              aria-label="Automation name"
              value={state.name}
              onChange={(e) => setName(e.target.value)}
              // The blur flush. One of the four autosave edges; do not drop it.
              onBlur={() => void flush()}
              maxLength={120}
              placeholder="Name this automation"
              // Was borderless with no other cue it was a field, so it read as
              // static text (SRVW-216). The pencil is the affordance; it still
              // sits inside Input's own endIcon slot, not a separate element.
              endIcon={<PencilLine aria-hidden />}
              className="hover:border-input h-auto w-full max-w-xl truncate border-transparent bg-transparent py-0.5 pl-1 pr-7 text-2xl font-bold tracking-tight shadow-none"
            />
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 px-1">
              <p className="text-muted-foreground max-w-xl truncate text-sm">{sentence}</p>
              {stamp && <span className="text-subtle-foreground text-xs">{`${MIDDOT} ${stamp}`}</span>}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            {testDisabled ? (
              <TooltipProvider delayDuration={0}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    {/* A disabled button swallows pointer events, so the tooltip
                        listens on a focusable wrapper. This is the only place the
                        user learns WHY Test is blocked. */}
                    <span tabIndex={0} className="inline-flex">
                      <Button variant="outline" disabled aria-disabled>
                        <FlaskConical aria-hidden /> Test
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>Save your changes first</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : (
              <Button variant="outline" onClick={() => setTestOpen(true)}>
                <FlaskConical aria-hidden /> Test
              </Button>
            )}
            <Button variant="outline" onClick={() => setActivityOpen(true)}>
              <History aria-hidden /> Activity
            </Button>
            <Button
              variant="outline"
              className="text-destructive hover:text-destructive"
              disabled={!state.server.id || remove.isPending}
              onClick={() => void handleDelete()}
            >
              <Trash2 aria-hidden /> Delete
            </Button>
            <PublishControl
              status={state.server.status}
              hasUnpublishedChanges={state.server.has_unpublished_changes}
              dirty={state.dirty}
              issues={
                // A never-saved empty draft has no server verdict yet, so
                // synthesize the one issue that matters. Publish is then honestly
                // disabled rather than enabled-but-silently-doing-nothing.
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
      </div>

      {/* Builder canvas. This used to be one of three TabStrip tabs
          (Builder/Activity/Settings); Activity moved to a drawer (SRVW-217)
          and Settings was removed outright (SRVW-216 - its only contents were
          a redundant second name field and the danger-zone Delete, both now
          in the header above), which left a strip with a single tab nobody
          could ever switch away from. A one-item TabStrip is not navigation,
          so the strip itself is gone and this renders unconditionally. */}
      <div className="border-border bg-app rounded-lg border">
        <div className="border-border flex flex-col gap-2 border-b px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-muted-foreground flex items-center gap-2 text-xs">
            <Sparkles className="text-brand size-3.5" aria-hidden />
            <span>
              <b className="text-foreground font-semibold">Guided flow</b>
              {` ${EM_DASH} drag a bubble to reorder, tap + to insert a step. Everything stays on the line.`}
            </span>
          </p>
        </div>
        <div className="animate-in fade-in-0 slide-in-from-top-1 px-4 py-6 duration-300">
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

      <Sheet open={activityOpen} onOpenChange={setActivityOpen}>
        <SheetContent className="flex h-full w-full flex-col gap-0 p-0 sm:max-w-[480px]">
          <SheetHeader className="border-border border-b p-4 text-left">
            <SheetTitle className="text-base font-bold tracking-tight">Activity</SheetTitle>
            <SheetDescription className="sr-only">What this automation has run, newest first.</SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto p-4">
            {/* Radix does not mount SheetContent's subtree until `open` is
                true, so WorkflowActivity - and its `enabled: Boolean(id)`
                query - still never runs on page load. It fires the first time
                this drawer opens, the same laziness the unmounted Activity
                TabPanel gave it before. */}
            <WorkflowActivity id={state.server.id} status={state.server.status} isEnabled={state.server.is_enabled} />
          </div>
        </SheetContent>
      </Sheet>

      {confirmDialog}
    </div>
  );
}
