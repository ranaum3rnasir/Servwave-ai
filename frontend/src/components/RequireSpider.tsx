import { Navigate, Outlet } from 'react-router-dom';
import { useSpiderAvailable } from '@/lib/spider/gate';

/**
 * Route guard for Spider's page (#2619): the `spider` feature AND, while the launch is demo-only,
 * a demo company. Anyone else is sent to the dashboard, so the page cannot be reached by typing
 * the URL - the same shape as DemoOnlyRoute. The server answers 404 on every Spider endpoint for
 * them anyway.
 */
export default function RequireSpider() {
  if (!useSpiderAvailable()) return <Navigate to="/" replace />;
  return <Outlet />;
}
