/**
 * The contract a tab body plugs into the Payments page frame (P5). The frame owns the title, the period picker,
 * the KPI tiles and the tab strip; a tab body gets the chosen period and a handle on the page's query string for its
 * own state (page, search, filters), so a link and the Back button restore it.
 */
export interface PaymentsTabState {
  /** The page's current query string; a tab reads its own keys from it. */
  params: URLSearchParams;
  /** Set (string) or remove (null) keys of the page's query string. Period and tab keys are the frame's. */
  setParams: (patch: Record<string, string | null>) => void;
}

export interface PaymentsTabProps {
  range: { from: string; to: string };
  tabState: PaymentsTabState;
}
