import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useWorkflowDraft, moveStep, draftToInput, type WorkflowDraftState } from './useWorkflowDraft';
import type { ApiWorkflow } from '@/lib/api/workflows';

// ── moveStep (pure) ───────────────────────────────────────────────────────────

describe('moveStep', () => {
  it('moves an item forward', () => {
    expect(moveStep(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
  });
  it('moves an item backward', () => {
    expect(moveStep(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
  });
  it('is a no-op when from === to', () => {
    const arr = ['a', 'b', 'c'];
    expect(moveStep(arr, 1, 1)).toBe(arr);
  });
  it('returns the array unchanged for out-of-range indices', () => {
    const arr = ['a', 'b', 'c'];
    expect(moveStep(arr, -1, 1)).toBe(arr);
    expect(moveStep(arr, 0, 5)).toBe(arr);
  });
  it('does not mutate the input', () => {
    const arr = ['a', 'b', 'c'];
    moveStep(arr, 0, 2);
    expect(arr).toEqual(['a', 'b', 'c']);
  });
});

// ── fixtures ──────────────────────────────────────────────────────────────────

function makeWorkflow(overrides: Partial<ApiWorkflow> = {}): ApiWorkflow {
  return {
    id: 'wf-1',
    name: 'Review request follow-up',
    status: 'PUBLISHED',
    is_enabled: true,
    trigger_type: 'JOB_COMPLETED',
    trigger_config: null,
    send_window: 'ANYTIME',
    template_key: null,
    legacy_rule_id: null,
    published_at: '2026-07-01T00:00:00.000Z',
    last_triggered_at: null,
    trigger_count: 0,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    steps: [
      { id: 's1', position: 0, step_type: 'WAIT', config: { duration_minutes: 1440 } },
      { id: 's2', position: 1, step_type: 'SEND_TEXT', config: { recipient: 'customer', body: 'hi' } },
    ],
    issues: [],
    has_unpublished_changes: false,
    published_version: { version: 1, published_at: '2026-07-01T00:00:00.000Z' },
    ...overrides,
  };
}

// ── the hook ──────────────────────────────────────────────────────────────────

describe('useWorkflowDraft', () => {
  it('starts blank and not dirty (create flow)', () => {
    const { result } = renderHook(() => useWorkflowDraft());
    expect(result.current.state.steps).toHaveLength(0);
    expect(result.current.state.dirty).toBe(false);
    expect(result.current.state.server.id).toBeUndefined();
    // a valid create body: name + trigger_type are always present
    const body = draftToInput(result.current.state);
    expect(body.name.length).toBeGreaterThan(0);
    expect(body.trigger_type).toBe('JOB_COMPLETED');
  });

  // A brand-new draft's trigger_type is a required-but-unseen placeholder
  // (the create body always needs one), NOT a real pick — triggerConfigured
  // is what the trigger UI actually keys off to tell the two apart.
  it('a brand-new draft is NOT triggerConfigured; setTrigger and hydrate both flip it true', () => {
    const { result } = renderHook(() => useWorkflowDraft());
    expect(result.current.state.triggerConfigured).toBe(false);

    act(() => result.current.setTrigger('BEFORE_JOB_START', { offset_minutes: 720 }));
    expect(result.current.state.triggerConfigured).toBe(true);
  });

  it('hydrating a saved workflow is triggerConfigured, even one on a legacy/unmapped trigger', () => {
    const { result } = renderHook(() => useWorkflowDraft());
    act(() => result.current.hydrate(makeWorkflow({ trigger_type: 'BEFORE_JOB_START', trigger_config: { offset_minutes: 60 } })));
    expect(result.current.state.triggerConfigured).toBe(true);
  });

  it('setName marks the draft dirty and bumps the revision', () => {
    const { result } = renderHook(() => useWorkflowDraft());
    const rev0 = result.current.state.revision;
    act(() => result.current.setName('My flow'));
    expect(result.current.state.name).toBe('My flow');
    expect(result.current.state.dirty).toBe(true);
    expect(result.current.state.revision).toBe(rev0 + 1);
  });

  it('addStep inserts at the given index, selects the new node, and seeds a default config', () => {
    const { result } = renderHook(() => useWorkflowDraft());
    let firstUid = '';
    act(() => {
      firstUid = result.current.addStep('SEND_TEXT');
    });
    act(() => {
      result.current.addStep('WAIT', 0); // insert before the SEND_TEXT
    });
    expect(result.current.state.steps.map((s) => s.step_type)).toEqual(['WAIT', 'SEND_TEXT']);
    // the most-recently-added node is selected
    expect(result.current.state.selectedUid).toBe(result.current.state.steps[0]!.uid);
    expect(firstUid).not.toBe('');
    // WAIT seeded to a sensible 1-day default (immediately reads "Wait 1 day")
    expect(result.current.state.steps[0]!.config).toEqual({ duration_minutes: 1440 });
  });

  // Spec C slice 8: a text step used to be seeded `recipient: 'customer'`, which was a real
  // pre-selection rather than a placeholder - an admin who added the step, wrote the copy and
  // published sent to the customer without ever having been asked. Now that a text can reach
  // any audience, the step starts with nobody chosen and the server flags it "needs setup".
  it('seeds a new text step with no recipient chosen', () => {
    const { result } = renderHook(() => useWorkflowDraft());
    act(() => void result.current.addStep('SEND_TEXT'));
    expect(result.current.state.steps[0]!.config).toEqual({ recipients: [], body: '' });
  });

  // The email channel's half of the same rule, and the BLOCKER it was hiding. SEND_EMAIL kept
  // the `recipient: 'customer'` seed through slice 8; Spec B's `task` is the first entity whose
  // audience map has no `customer` key, so on a task trigger the seed named an audience the
  // picker never renders - un-untickable - and `normalizeRecipientFields` folded it into the
  // array beside the admin's own pick, yielding `["customer","assignees"]` and a publish that
  // 400s for ever. The seed must be an EMPTY ARRAY, not a missing key: the array is what earns
  // the server's "Choose who this email goes to" instead of zod's "Required".
  it('seeds a new email step with no recipient chosen', () => {
    const { result } = renderHook(() => useWorkflowDraft());
    act(() => void result.current.addStep('SEND_EMAIL'));
    expect(result.current.state.steps[0]!.config).toEqual({ recipients: [], subject: '', body: '' });
    // The singular key is what folded; its ABSENCE is the fix, so pin it separately from the
    // toEqual above - a future seed of `{ recipients: [], recipient: 'customer', ... }` would
    // reintroduce the whole defect while still carrying an empty array.
    expect(result.current.state.steps[0]!.config).not.toHaveProperty('recipient');
  });

  // The shape that actually leaves the browser. `draftToInput` is the create/patch body, so
  // this is the assertion that a task-trigger email step is publishable the moment an audience
  // is ticked: nothing rides along that the trigger's audience map would reject.
  it('the body a fresh email step saves carries recipients: [] and no singular recipient', () => {
    const { result } = renderHook(() => useWorkflowDraft());
    act(() => result.current.setTrigger('TASK_CREATED', null));
    act(() => void result.current.addStep('SEND_EMAIL'));

    const body = draftToInput(result.current.state as WorkflowDraftState);
    expect(body.trigger_type).toBe('TASK_CREATED');
    expect(body.steps?.[0]!.config).toEqual({ recipients: [], subject: '', body: '' });

    // Once the admin picks, the emitted array holds ONLY what they picked - the QA repro was
    // `["customer","assignees"]` on exactly this trigger.
    const uid = result.current.state.steps[0]!.uid;
    act(() => result.current.updateStepConfig(uid, { recipients: ['assignees'], subject: 'Ready', body: 'Take a look' }));
    const published = draftToInput(result.current.state as WorkflowDraftState);
    expect(published.steps?.[0]!.config).toEqual({ recipients: ['assignees'], subject: 'Ready', body: 'Take a look' });
  });

  // REGRESSION. Retiring the seed must not touch what STORAGE already holds: pre-v2.1 rows
  // carry the singular `recipient`, and every fold that reads them (the picker's
  // normalizeRecipientFields, the bubble + recipe sentences, the backend's
  // normalizeMessagingConfig) keys off that field still being there. `hydrate` must hand it
  // back verbatim, and `draftToInput` must re-send it untouched, so opening a saved
  // customer-email automation and pressing publish is a no-op rather than a rewrite.
  it('hydrates a stored singular { recipient: "customer" } email step and round-trips it unchanged', () => {
    const { result } = renderHook(() => useWorkflowDraft());
    const storedConfig = { recipient: 'customer', subject: 'Thanks!', body: 'Thanks for your business.' };
    act(() =>
      result.current.hydrate(
        makeWorkflow({
          trigger_type: 'JOB_COMPLETED',
          steps: [{ id: 's1', position: 0, step_type: 'SEND_EMAIL', config: storedConfig }],
        }),
      ),
    );

    expect(result.current.state.steps[0]!.config).toEqual(storedConfig);
    const body = draftToInput(result.current.state as WorkflowDraftState);
    expect(body.steps?.[0]!.config).toEqual(storedConfig);
    expect(result.current.state.dirty).toBe(false);
  });

  it('seeds no config for a step type that is no longer authorable', () => {
    // Storage keeps the retired in-app label so historic rows still resolve, but
    // the default-config factory is an authoring surface: it hands back nothing
    // rather than minting a fresh config for a step nothing will accept.
    const { result } = renderHook(() => useWorkflowDraft());
    act(() => void result.current.addStep('NOTIFY_TEAM'));
    expect(result.current.state.steps[0]!.config).toEqual({});
  });

  it('moveStep reorders the draft steps', () => {
    const { result } = renderHook(() => useWorkflowDraft());
    act(() => void result.current.addStep('WAIT'));
    act(() => void result.current.addStep('SEND_TEXT'));
    act(() => result.current.moveStep(0, 1));
    expect(result.current.state.steps.map((s) => s.step_type)).toEqual(['SEND_TEXT', 'WAIT']);
    expect(result.current.state.dirty).toBe(true);
  });

  it('removeStep deletes the step and clears the selection when it was selected', () => {
    const { result } = renderHook(() => useWorkflowDraft());
    let uid = '';
    act(() => {
      uid = result.current.addStep('WAIT');
    });
    expect(result.current.state.selectedUid).toBe(uid);
    act(() => result.current.removeStep(uid));
    expect(result.current.state.steps).toHaveLength(0);
    expect(result.current.state.selectedUid).toBeNull();
  });

  it('updateStepConfig replaces a step config', () => {
    const { result } = renderHook(() => useWorkflowDraft());
    let uid = '';
    act(() => {
      uid = result.current.addStep('SEND_TEXT');
    });
    act(() => result.current.updateStepConfig(uid, { recipient: 'customer', body: 'Thanks!' }));
    expect(result.current.state.steps[0]!.config).toEqual({ recipient: 'customer', body: 'Thanks!' });
  });

  it('selecting a node does NOT mark the draft dirty', () => {
    const { result } = renderHook(() => useWorkflowDraft());
    act(() => result.current.selectTrigger());
    expect(result.current.state.selectedUid).toBe('trigger');
    expect(result.current.state.dirty).toBe(false);
  });

  it('hydrate loads a server workflow, assigns client uids, and is not dirty', () => {
    const { result } = renderHook(() => useWorkflowDraft());
    act(() => result.current.hydrate(makeWorkflow()));
    expect(result.current.state.name).toBe('Review request follow-up');
    expect(result.current.state.steps.map((s) => s.step_type)).toEqual(['WAIT', 'SEND_TEXT']);
    expect(result.current.state.steps.every((s) => typeof s.uid === 'string' && s.uid.length > 0)).toBe(true);
    expect(result.current.state.dirty).toBe(false);
    expect(result.current.state.server.id).toBe('wf-1');
    expect(result.current.state.server.status).toBe('PUBLISHED');
  });

  it('markSaved clears dirty when nothing changed since the save, and keeps it when an edit landed mid-save', () => {
    const { result } = renderHook(() => useWorkflowDraft());
    act(() => result.current.setName('A'));
    const revAtSave = result.current.state.revision;

    // no edits between capturing the revision and markSaved → clean
    act(() => result.current.markSaved(revAtSave, makeWorkflow({ id: 'wf-9', issues: [] })));
    expect(result.current.state.dirty).toBe(false);
    expect(result.current.state.server.id).toBe('wf-9');
    expect(result.current.state.lastSavedAt).not.toBeNull();

    // an edit lands, THEN a stale markSaved arrives → stays dirty
    act(() => result.current.setName('B'));
    const staleRev = revAtSave; // pretend the in-flight save captured the old revision
    act(() => result.current.markSaved(staleRev, makeWorkflow({ id: 'wf-9' })));
    expect(result.current.state.dirty).toBe(true);
  });

  it('markSaved refreshes server issues (needs-setup source of truth)', () => {
    const { result } = renderHook(() => useWorkflowDraft());
    const rev = result.current.state.revision;
    act(() =>
      result.current.markSaved(
        rev,
        makeWorkflow({ issues: [{ step_index: 1, path: 'body', message: 'Add a message' }] }),
      ),
    );
    expect(result.current.issuesByStepIndex.get(1)).toHaveLength(1);
    expect(result.current.issuesByStepIndex.has(0)).toBe(false);
  });

  it('draftToInput always includes trigger_type alongside trigger_config and array-ordered steps', () => {
    const { result } = renderHook(() => useWorkflowDraft());
    act(() => result.current.setTrigger('BEFORE_JOB_START', { offset_minutes: 720 }));
    act(() => void result.current.addStep('WAIT'));
    act(() => void result.current.addStep('SEND_TEXT'));
    const body = draftToInput(result.current.state as WorkflowDraftState);
    expect(body.trigger_type).toBe('BEFORE_JOB_START');
    expect(body.trigger_config).toEqual({ offset_minutes: 720 });
    expect(body.steps?.map((s) => s.step_type)).toEqual(['WAIT', 'SEND_TEXT']);
  });

  // Spec A - AC7's "still editable" clause has a client half nothing else covers.
  // The API accepts a legacy in-app step on a draft save precisely SO the other
  // steps stay editable, and that only helps if the builder actually re-sends the
  // step it hydrated: `hydrate` and `draftToInput` are the whole round trip, and
  // PATCH REPLACES the steps array. A filter dropping non-authorable steps from
  // either one would look like tidying up - `defaultConfig` and `stepSentence`
  // next door both narrow through `isAuthorableStepType` - and would instead
  // DELETE the admin's step on the next autosave, silently, with every backend
  // test still green. Losing the row would also lose the only issue telling them
  // why the automation would not publish.
  it('re-sends a legacy in-app step verbatim when a sibling step is edited', () => {
    const { result } = renderHook(() => useWorkflowDraft());
    const legacyConfig = { recipient: 'all_admins', body: 'New job booked' };
    act(() =>
      result.current.hydrate(
        makeWorkflow({
          steps: [
            { id: 's1', position: 0, step_type: 'SEND_TEXT', config: { recipient: 'customer', body: 'hi' } },
            { id: 's2', position: 1, step_type: 'NOTIFY_TEAM', config: legacyConfig },
          ],
        }),
      ),
    );

    const textUid = result.current.state.steps[0]!.uid;
    act(() => result.current.updateStepConfig(textUid, { recipient: 'customer', body: 'on our way' }));

    const body = draftToInput(result.current.state as WorkflowDraftState);
    expect(body.steps?.map((s) => s.step_type)).toEqual(['SEND_TEXT', 'NOTIFY_TEAM']);
    expect(body.steps?.[0]!.config).toEqual({ recipient: 'customer', body: 'on our way' });
    // Verbatim: the retired step's stored config is neither trimmed nor reseeded.
    expect(body.steps?.[1]!.config).toEqual(legacyConfig);
  });

  // The escape hatch, from the client side: deleting the retired step is a normal
  // removeStep, so the very next save writes an array without it and the same
  // automation publishes with no other change.
  it('deleting the legacy in-app step leaves a body the rest of the draft can publish', () => {
    const { result } = renderHook(() => useWorkflowDraft());
    act(() =>
      result.current.hydrate(
        makeWorkflow({
          steps: [
            { id: 's1', position: 0, step_type: 'SEND_TEXT', config: { recipient: 'customer', body: 'hi' } },
            { id: 's2', position: 1, step_type: 'NOTIFY_TEAM', config: { recipient: 'all_admins', body: 'x' } },
          ],
        }),
      ),
    );
    const legacyUid = result.current.state.steps[1]!.uid;
    act(() => result.current.removeStep(legacyUid));

    const body = draftToInput(result.current.state as WorkflowDraftState);
    expect(body.steps?.map((s) => s.step_type)).toEqual(['SEND_TEXT']);
    expect(result.current.state.dirty).toBe(true);
  });

  // Task B7: trigger_config was widened from `{ offset_minutes } | null` to
  // also accept the Part-B date-anchored shape (`{ anchor, direction,
  // offset_minutes }`) — proves the hook actually holds/round-trips that
  // shape, not just that the TYPE annotation compiles.
  it('setTrigger also accepts a date-anchored trigger_config, and hydrate/draftToInput round-trip it verbatim', () => {
    const { result } = renderHook(() => useWorkflowDraft());
    const anchoredConfig = { anchor: 'invoice.due_date' as const, direction: 'after' as const, offset_minutes: 4320 };

    act(() => result.current.setTrigger('INVOICE_DATE_ANCHORED', anchoredConfig));
    expect(result.current.state.trigger_config).toEqual(anchoredConfig);
    expect(draftToInput(result.current.state as WorkflowDraftState).trigger_config).toEqual(anchoredConfig);

    act(() =>
      result.current.hydrate(
        makeWorkflow({ trigger_type: 'JOB_DATE_ANCHORED', trigger_config: { anchor: 'job.scheduled_start', direction: 'before', offset_minutes: 60 } }),
      ),
    );
    expect(result.current.state.trigger_config).toEqual({ anchor: 'job.scheduled_start', direction: 'before', offset_minutes: 60 });
  });
});
