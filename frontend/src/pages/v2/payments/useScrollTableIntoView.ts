import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

/**
 * A page change in a long table brings the top of that table into view, so the new page starts where its first row is
 * (the approved screen does the same). Only a person choosing a page does this: `request()` is called from the table's
 * `onPageChange`, never from a reset to page 1 or from the first render. Put `ref` on the element around the table.
 */
export function useScrollTableIntoView(): { ref: RefObject<HTMLDivElement | null>; request: () => void } {
  const ref = useRef<HTMLDivElement>(null);
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    if (asked > 0) ref.current?.scrollIntoView({ block: 'start' });
  }, [asked]);
  const request = useCallback(() => setAsked((n) => n + 1), []);
  return { ref, request };
}
