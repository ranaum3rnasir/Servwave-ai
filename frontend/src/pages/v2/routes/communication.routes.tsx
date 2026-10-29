import { lazy } from 'react';
import { Route } from 'react-router-dom';

import DemoOnlyRoute from '@/components/DemoOnlyRoute';
import ProtectedRoute from '@/components/ProtectedRoute';
import RequireCommunicationCreate from '@/components/RequireCommunicationCreate';
import RequireCommunicationSection from '@/components/RequireCommunicationSection';
import RequireFeature from '@/components/RequireFeature';

import V2AppLayout from '../V2AppLayout';

const PhonePage = lazy(() => import('../communication/PhonePage'));
const InboxPage = lazy(() => import('../communication/InboxPage'));
const WhatsAppPage = lazy(() => import('../communication/WhatsAppPage'));
const TextPage = lazy(() => import('../communication/TextPage'));
const PhoneTabPage = lazy(() => import('../communication/PhoneTabPage'));

/**
 * Module 12 - Communication.
 *
 * The two blocks below use two DIFFERENT guards for a deliberate reason:
 *
 *   /communication/*   ProtectedRoute (auth only) > RequireCommunicationSection >
 *                      V2AppLayout > RequireFeature("phone")
 *   /phone             ProtectedRoute (auth only) > RequireCommunicationCreate,
 *                      and deliberately OUTSIDE V2AppLayout
 *
 * `/communication/*` is the org-wide Communication SECTION (the sidebar group's
 * own pages: inbox, call log, WhatsApp, phone settings) - gated on the ability
 * grant `access_inbox Communication`, never a role list, so `RequireCommunicationSection`
 * sits BETWEEN `ProtectedRoute` and `V2AppLayout`: the only placement that mounts
 * neither the shell nor the page, and fires no `/api/communication/*` request, on a
 * denied deep link.
 *
 * `phone` is the master entitlement switch for the ENTIRE Communication module -
 * calls, SMS, WhatsApp, email, number provisioning and the softphone. Its `minPlan`
 * is PRO and `/onboard-org` writes `feature_overrides: {"phone": false}` for every
 * new org whatever its plan, so it is not decoration on these routes: without it an
 * org that must not see the module at all would reach every page in it.
 *
 * Both blocks enforce it. The first does so directly, after the section gate above.
 * The second does so through `RequireCommunicationCreate`, a DIFFERENT and narrower
 * gate: it checks `useFeature('phone')` AND the shared-baseline `create Communication`
 * CASL grant every role that may compose or dial already holds, and redirects to "/"
 * when either fails - it is not the section gate, because `/phone` is the single
 * softphone device owner the record tabs' Call button hands off to, and taking that
 * away from whoever may compose was never decided here.
 *
 * `/phone` keeps its own auth-only ProtectedRoute (access is decided purely by the
 * gate below it) and its position outside the app chrome. It is a standalone tab the
 * user keeps open alongside the app - putting it inside V2AppLayout would give it a
 * sidebar, a topbar and a SECOND GlobalDialer, and the architecture allows exactly one
 * device-owning softphone surface.
 *
 * The CHROME is the only substitution: V2AppLayout stands in for the app's
 * AppLayout, on the routes that had AppLayout. Guards decide who may enter, the
 * layout only decides what frames the page, so swapping the second changes no
 * permission.
 */
export function communicationV2Routes() {
  return (
    <>
      <Route element={<ProtectedRoute />}>
        <Route element={<RequireCommunicationSection />}>
          <Route element={<V2AppLayout />}>
            <Route element={<RequireFeature feature="phone" />}>
              <Route path="/communication/phone" element={<PhonePage />} />
              <Route path="/communication/phone/:tab" element={<PhonePage />} />
              <Route path="/communication/text" element={<TextPage />} />
              <Route path="/communication/text/:tab" element={<TextPage />} />
              {/* WhatsApp is demo-locked ON TOP OF phone: no WhatsApp Business
                  connection exists in the schema, so for a non-demo org the page
                  is theatre even though the URL resolves. Matches the legacy
                  nesting exactly (App.tsx: DemoOnlyRoute inside the phone gate). */}
              <Route element={<DemoOnlyRoute />}>
                <Route path="/communication/whatsapp" element={<WhatsAppPage />} />
              </Route>
            </Route>
            {/* Email is its OWN entitlement key, not part of phone - every plan
                may send email, so an email-only org must reach the inbox while
                the phone-gated pages above stay shut. Sharing the phone gate was
                the port's mistake and locked the inbox for those orgs. */}
            <Route element={<RequireFeature feature="email" />}>
              <Route path="/communication/inbox" element={<InboxPage />} />
            </Route>
          </Route>
        </Route>
      </Route>

      {/* The dedicated softphone tab - auth-only ProtectedRoute, no app layout. */}
      <Route element={<ProtectedRoute />}>
        <Route element={<RequireCommunicationCreate />}>
          <Route path="/phone" element={<PhoneTabPage />} />
        </Route>
      </Route>
    </>
  );
}
