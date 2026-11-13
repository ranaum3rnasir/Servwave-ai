import { useSpiderLiveUpdates, useSpiderUnreadAlerts } from '@/lib/api/spider';
import { BrowserAutomationIndicator } from './BrowserAutomationIndicator';
import { SpiderNotificationPopup } from './SpiderNotificationPopup';

/**
 * Spider's alert surfaces in the staff shell (#2619): the contractor's red frame and his
 * notifications popup (Ran, 15 Oct), driven ONLY by the server's list of the signed-in person's
 * unread Spider alerts. Nothing is kept in the browser, so both survive a reload and a sign-in on
 * another computer. Mounted lazily by LazySpiderAlerts, behind the Spider gate, where his were
 * mounted ungated in the layout.
 *
 * - The red frame shows while the company's Red Frame is on and the person has an open Spider alert:
 *   an in-app one, or, with in-app alerts off, the sweep's red-frame-only record (his Red Frame works
 *   on its own). It goes away on its own once the lead leaves the stage (the server stops counting
 *   it at once and its sweep marks it read), or the alert is read.
 * - The popup shows while there is at least one unread in-app alert, as his did: with in-app alerts
 *   off there is none to list, so the frame shows without the button.
 * - Both follow the live line (#3472): a new or ended alert shows or goes within seconds, with the 30-second check as
 *   the fallback whenever the line is not open.
 */
export default function SpiderAlertsHost() {
  useSpiderLiveUpdates();
  const { data } = useSpiderUnreadAlerts();
  if (!data) return null;
  // The server says when the frame shows (Red Frame on, with an open in-app alert or, in-app off, a
  // red-frame-only record); an older server that does not say leaves it to the in-app alerts.
  const showFrame = data.frame ?? (data.red_frame && data.alerts.length > 0);

  return (
    <>
      {showFrame && <BrowserAutomationIndicator />}
      <SpiderNotificationPopup data={data} />
    </>
  );
}
