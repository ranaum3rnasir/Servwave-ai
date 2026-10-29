/**
 * The unsaved-work signal: a tiny shared store answering "does anything on screen hold work the
 * user has not saved?". A dirty overlay registers itself while it is dirty (see `useDirtyGuard`);
 * drafts will register the same way. The app's update prompt reads it so a new version never
 * reloads the page under half-filled work.
 *
 * Plain module state with a subscribe function, so it works from React (`useHasUnsavedWork`)
 * and from code that is not (`hasUnsavedWork`).
 */
import { useSyncExternalStore } from "react";

const holders = new Set<string>();
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

/** Mark `id` as holding unsaved work. Returns the function that clears it. */
export function registerUnsavedWork(id: string): () => void {
  holders.add(id);
  emit();
  return () => {
    if (holders.delete(id)) emit();
  };
}

/** True while at least one overlay or draft holds unsaved work. */
export function hasUnsavedWork(): boolean {
  return holders.size > 0;
}

export function subscribeUnsavedWork(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useHasUnsavedWork(): boolean {
  return useSyncExternalStore(subscribeUnsavedWork, hasUnsavedWork, () => false);
}
