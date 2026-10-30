import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Panels inside a record's page, named in the page's address (Roles & Permissions, PRD 6, S06.23).
 *
 * A notification may name a panel inside its record ("the review panel of this job"). The name rides in the record's
 * address as `?panel=<name>`, so the page can be bookmarked and shared, and the page opens that panel on load when this
 * person may see it. The address only names a panel: whether it opens is the page's call, from the server's answer for
 * the record, so a person who may not see it lands on the record with no panel and no error. A name the page does not
 * know is ignored.
 */
export const PANEL_PARAM = 'panel';

/** What a panel name looks like in an address; anything else is not a panel name. */
const PANEL_NAME = /^[a-z][a-z0-9_]{0,31}$/;

export const isPanelName = (value: unknown): value is string => typeof value === 'string' && PANEL_NAME.test(value);

/** The record's path with the named panel in its address. A name that is not a panel name leaves the path alone. */
export function withPanel(path: string, panel: unknown): string {
  if (!isPanelName(panel)) return path;
  return `${path}${path.includes('?') ? '&' : '?'}${PANEL_PARAM}=${panel}`;
}

/**
 * The panel the address names, among the ones this page knows, and a setter that writes it into the address (or takes it
 * out with null). The rest of the address is kept. The address is the one place the open panel is kept, so it opens on
 * load, survives a reload and closes on Back to the plain record.
 */
export function useRecordPanel<Name extends string>(known: readonly Name[]) {
  const [params, setParams] = useSearchParams();
  const named = params.get(PANEL_PARAM);
  const panel = known.find((name) => name === named) ?? null;
  const setPanel = useCallback((next: Name | null) => {
    setParams((current) => {
      const updated = new URLSearchParams(current);
      if (next) updated.set(PANEL_PARAM, next);
      else updated.delete(PANEL_PARAM);
      return updated;
    }, { replace: true });
  }, [setParams]);
  return { panel, setPanel };
}
