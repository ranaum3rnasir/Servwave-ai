import { useCallback } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import { useIsBelow } from '@/ui-kit/hooks/useMediaQuery';

/**
 * Which pane a two-pane messenger shows on a phone (mobile slice 69, PRD module 9).
 *
 * Text messages and chat are a list beside a thread from md up. Below md there is room for one of
 * them, so the page shows the list or the thread, and WHICH is a fact about the URL, not about
 * component state: the open conversation is a search param (`?threadId=` for texts, `?chatId=` for
 * chat), so the browser's Back button returns to the list, a reload keeps the thread, and a link to
 * a conversation (the notification bell's `?threadId=`) lands on it.
 *
 * One small hook shared by both pages, so they cannot disagree about how Back works.
 *
 *  - Only a phone writes the URL. From md up both panes are always on screen and a selection is
 *    plain state, exactly as it was; a stale param there is never read.
 *  - Opening a conversation PUSHES a history entry, flagged with the param it was opened from. The
 *    on-screen back control then pops that entry (`navigate(-1)`), so it and the browser's Back
 *    button are the same move and never leave a ping-pong of list/thread entries behind. When the
 *    page was ENTERED on a conversation (a deep link, a reload) there is no list entry to pop to, so
 *    the back control replaces the entry with the list instead of leaving the app.
 */
const OPENED_FROM = 'comm-pane-opened-from';

export interface RoutedPane {
  /** True below md: one pane at a time. */
  isPhone: boolean;
  /** The conversation id in the URL, or null when the list is showing. Read on a phone only. */
  paneId: string | null;
  /** Show this conversation (a phone only; from md up it does nothing, both panes are on screen). */
  open: (id: string, opts?: { replace?: boolean }) => void;
  /** Return to the list. `replace` skips the history pop (used when the id in the URL is stale). */
  back: (opts?: { replace?: boolean }) => void;
}

export function useRoutedPane(param: string): RoutedPane {
  const isPhone = useIsBelow('md');
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const paneId = isPhone ? searchParams.get(param) || null : null;
  const openedFromList =
    (location.state as Record<string, unknown> | null)?.[OPENED_FROM] === param;

  const open = useCallback(
    (id: string, opts?: { replace?: boolean }) => {
      if (!isPhone) return;
      const next = new URLSearchParams(searchParams);
      next.set(param, id);
      // A replaced entry is not "opened from the list", so Back will not pretend there is one.
      setSearchParams(next, opts?.replace ? { replace: true } : { state: { [OPENED_FROM]: param } });
    },
    [isPhone, param, searchParams, setSearchParams],
  );

  const back = useCallback(
    (opts?: { replace?: boolean }) => {
      if (openedFromList && !opts?.replace) {
        navigate(-1);
        return;
      }
      const next = new URLSearchParams(searchParams);
      next.delete(param);
      setSearchParams(next, { replace: true });
    },
    [openedFromList, param, navigate, searchParams, setSearchParams],
  );

  return { isPhone, paneId, open, back };
}
