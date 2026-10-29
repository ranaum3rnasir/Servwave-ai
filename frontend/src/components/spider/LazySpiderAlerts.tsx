import { lazy, Suspense, useEffect } from 'react';
import { clearRetiredSpiderStorage, useSpiderAvailable } from '@/lib/spider/gate';

const SpiderAlertsHost = lazy(() => import('./SpiderAlertsHost'));

/**
 * The one Spider mount in the staff shell (#2619). Tiny on purpose: the popup, the red frame and
 * every Spider request load only for a company that passes the Spider gate. Every other company
 * gets nothing but the one-time removal of the browser keys an earlier Spider left behind.
 */
export function LazySpiderAlerts() {
  const available = useSpiderAvailable();
  useEffect(() => {
    clearRetiredSpiderStorage();
  }, []);
  if (!available) return null;
  return (
    <Suspense fallback={null}>
      <SpiderAlertsHost />
    </Suspense>
  );
}
