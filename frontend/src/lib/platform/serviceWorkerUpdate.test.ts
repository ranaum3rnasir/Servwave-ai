import { describe, expect, it, vi } from 'vitest';

import {
  createUpdateController,
  shouldApplyUpdateNow,
  shouldReloadForUpdate,
  type UpdateControllerDeps,
} from './serviceWorkerUpdate';

/**
 * Mobile slice 67 (PWA-03). A waiting update is applied on the user's tap, or by itself at a
 * safe moment, and NEVER while the shared unsaved-work signal is set.
 */
describe('shouldApplyUpdateNow', () => {
  const base = { updateWaiting: true, applyRequested: false, hasUnsavedWork: false, pageHidden: false };

  it('never applies while work is unsaved, whatever else is true', () => {
    for (const applyRequested of [false, true]) {
      for (const pageHidden of [false, true]) {
        expect(shouldApplyUpdateNow({ ...base, hasUnsavedWork: true, applyRequested, pageHidden })).toBe(false);
      }
    }
  });

  it('applies on the user tap when nothing is unsaved', () => {
    expect(shouldApplyUpdateNow({ ...base, applyRequested: true })).toBe(true);
  });

  it('applies by itself when nothing is unsaved and the page is in the background', () => {
    expect(shouldApplyUpdateNow({ ...base, pageHidden: true })).toBe(true);
  });

  it('waits for the user while the page is on screen and no tap was made', () => {
    expect(shouldApplyUpdateNow(base)).toBe(false);
  });

  it('does nothing when no update is waiting', () => {
    expect(shouldApplyUpdateNow({ ...base, updateWaiting: false, applyRequested: true, pageHidden: true })).toBe(false);
  });
});

describe('shouldReloadForUpdate', () => {
  it('reloads once the worker has changed and nothing is unsaved', () => {
    expect(shouldReloadForUpdate({ controllerChanged: true, hasUnsavedWork: false })).toBe(true);
  });
  it('never reloads under unsaved work', () => {
    expect(shouldReloadForUpdate({ controllerChanged: true, hasUnsavedWork: true })).toBe(false);
  });
  it('does not reload before the worker has changed', () => {
    expect(shouldReloadForUpdate({ controllerChanged: false, hasUnsavedWork: false })).toBe(false);
  });
});

function setup(initial: { unsaved?: boolean; hidden?: boolean } = {}) {
  let unsaved = initial.unsaved ?? false;
  let hidden = initial.hidden ?? false;
  const signalListeners = new Set<() => void>();
  const deps: UpdateControllerDeps = {
    hasUnsavedWork: () => unsaved,
    subscribeUnsavedWork: (l) => {
      signalListeners.add(l);
      return () => signalListeners.delete(l);
    },
    isPageHidden: () => hidden,
    activateWaitingWorker: vi.fn(),
    reload: vi.fn(),
  };
  const controller = createUpdateController(deps);
  return {
    controller,
    deps,
    setUnsaved(next: boolean) {
      unsaved = next;
      signalListeners.forEach((l) => l());
    },
    setHidden(next: boolean) {
      hidden = next;
      controller.pageVisibilityChanged();
    },
  };
}

describe('update controller', () => {
  it('is idle until an update is waiting, then offers it', () => {
    const { controller, deps } = setup();
    expect(controller.getStatus()).toBe('idle');
    controller.markUpdateWaiting();
    expect(controller.getStatus()).toBe('available');
    expect(deps.activateWaitingWorker).not.toHaveBeenCalled();
  });

  it('applies on tap, then reloads when the new worker has taken over', () => {
    const { controller, deps } = setup();
    controller.markUpdateWaiting();
    controller.requestApply();
    expect(deps.activateWaitingWorker).toHaveBeenCalledTimes(1);
    expect(controller.getStatus()).toBe('applying');
    expect(deps.reload).not.toHaveBeenCalled();
    controller.controllerChanged();
    expect(deps.reload).toHaveBeenCalledTimes(1);
  });

  it('applies automatically when clean and the page is in the background', () => {
    const { controller, deps, setHidden } = setup();
    controller.markUpdateWaiting();
    setHidden(true);
    expect(deps.activateWaitingWorker).toHaveBeenCalledTimes(1);
  });

  it('never applies while unsaved work is set, even on tap or in the background', () => {
    const { controller, deps, setHidden } = setup({ unsaved: true });
    controller.markUpdateWaiting();
    controller.requestApply();
    setHidden(true);
    expect(deps.activateWaitingWorker).not.toHaveBeenCalled();
    expect(deps.reload).not.toHaveBeenCalled();
    expect(controller.getStatus()).toBe('blocked-by-unsaved-work');
  });

  it('remembers a tap made over unsaved work and applies the moment the work is gone', () => {
    const { controller, deps, setUnsaved } = setup({ unsaved: true });
    controller.markUpdateWaiting();
    controller.requestApply();
    expect(deps.activateWaitingWorker).not.toHaveBeenCalled();
    setUnsaved(false);
    expect(deps.activateWaitingWorker).toHaveBeenCalledTimes(1);
  });

  it('does not reload under unsaved work after another tab applied the update', () => {
    const { controller, deps, setUnsaved } = setup({ unsaved: true });
    controller.markUpdateWaiting();
    controller.controllerChanged();
    expect(deps.reload).not.toHaveBeenCalled();
    setUnsaved(false);
    expect(deps.reload).toHaveBeenCalledTimes(1);
  });

  it('applies and reloads at most once however often it is poked', () => {
    const { controller, deps, setHidden, setUnsaved } = setup();
    controller.markUpdateWaiting();
    controller.requestApply();
    controller.requestApply();
    setHidden(true);
    controller.controllerChanged();
    controller.controllerChanged();
    setUnsaved(false);
    expect(deps.activateWaitingWorker).toHaveBeenCalledTimes(1);
    expect(deps.reload).toHaveBeenCalledTimes(1);
  });

  it('notifies subscribers when the status changes, and stops after unsubscribe', () => {
    const { controller } = setup();
    const listener = vi.fn();
    const off = controller.subscribe(listener);
    controller.markUpdateWaiting();
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    controller.requestApply();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
