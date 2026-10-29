/**
 * Where resume records live in browser storage, and the one thing that clears all of them.
 *
 * WHY THIS IS ITS OWN MODULE, AND WHY THE ENTRY IMPORTS IT
 *
 * A resume record holds a signed WRITE credential for one storage path, good for about two
 * hours. That is account-scoped state, so it belongs in the logout sweep `storeReset.ts`
 * runs — and the registry's own rule for who registers is a module side effect:
 *
 *   "Only modules that have actually been imported register, which is exactly right — a
 *    store nobody loaded holds nothing to leak."
 *
 * True of a Zustand singleton, whose state is born and dies with the module. FALSE here, and
 * that difference is the entire reason this file exists. `localStorage` OUTLIVES the page
 * load: a record written yesterday is still there today, while the module that would clear it
 * has not been imported yet. Registering from `resumableTransport.ts` therefore armed the
 * sweep only in sessions that had already loaded the transport, and the transport sits in a
 * lazy route chunk reached from the job, lead and invoice detail pages. Sign in, work on the
 * dashboard, sign out — never loaded, never swept, credential still there for the next person
 * on a shared tablet. Which is the exact scenario the sweep was written for.
 *
 * So the registration has to happen in a module the ENTRY loads, and `main.tsx` imports this
 * one for that side effect alone. It is deliberately tiny and deliberately free of any
 * transport import: pulling `resumableTransport` in here would drag the chunked upload client
 * into the initial bundle of every page load to arm a cleanup. `upload-resume-record-logout
 * .test.ts` pins all of it — that the entry imports this, that this alone arms the sweep, and
 * that no transport comes with it.
 */
import { registerStoreReset } from '@/lib/storeReset';

/**
 * The storage prefix. Defined HERE and imported by the transport rather than restated there:
 * two copies of it is two chances for the sweep to miss what the writer wrote.
 */
export const RESUME_RECORD_KEY_PREFIX = 'servwave:upload-resume:';

/**
 * Drop every resume record.
 *
 * Two jobs, both load-bearing.
 *
 * ACCOUNT SCOPE — the credential above must not outlive the session that minted it.
 *
 * GARBAGE COLLECTION — nothing else walks these keys. `readResumeRecord` ages out only the
 * one key it is asked about, so a record for a file nobody ever re-picks is never looked at
 * again and stays for good. This is the only thing that collects them.
 *
 * Scoped to the prefix, never `localStorage.clear()`: other subsystems keep their own
 * per-viewer preferences in there and none of them are ours to drop.
 */
export function clearAllResumeRecords(): void {
  try {
    // Collected first, then removed: removing during the walk reindexes the store underneath
    // `key(i)` and silently skips entries.
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(RESUME_RECORD_KEY_PREFIX)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    // Storage blocked or unavailable. Nothing was stored either, so nothing leaked.
  }
}

// Self-registering, which is the point of the registry: the next person to add
// account-scoped state cannot forget to tell logout about it from the other side.
registerStoreReset(clearAllResumeRecords);
