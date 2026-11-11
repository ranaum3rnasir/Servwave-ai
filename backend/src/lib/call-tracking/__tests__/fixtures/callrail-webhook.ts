/**
 * A CallRail Webhooks-integration delivery, shaped key-for-key like the events
 * production received from a real account in 2026-10/11 (issue #3447). Every
 * VALUE here is invented; only the key set, the value formats and the pre/post
 * differences are copied from the wire.
 *
 * Why this file exists: the first fixture was written from the vendor's API
 * description of a call record (`id`, `tracking_phone_number`, `start_time`,
 * `landing_page_url`...). The Webhooks integration sends none of those names,
 * so every real event was acked and ignored for weeks while the suite stayed
 * green. Build call-tracking tests from THIS shape.
 *
 * Wire facts worth knowing:
 *  - The call id is `resource_id`; there is no `id`.
 *  - `datetime` is UTC with no offset ("YYYY-MM-DD HH:MM:SS").
 *  - The pre-call carries `duration` "0", an empty `recording` and an empty
 *    `destinationnum`; the post-call fills all three.
 *  - Every value arrives as a string, empty string for "nothing".
 *  - The same data is ALSO appended to the URL as a query string. That copy is
 *    not covered by the signature, so it is never read.
 */
export const CALLRAIL_WEBHOOK_PRE: Readonly<Record<string, string>> = {
  answered: 'false',
  callercity: 'Trenton',
  callercountry: 'US',
  callername: 'DOE,JANE',
  callernum: '+16095550123',
  callerstate: 'NJ',
  callsource: 'google_ad_extension',
  campaign: '',
  customer_phone_number: '+16095550123',
  datetime: '2026-11-11 14:20:45',
  destinationnum: '',
  device_type: '',
  duration: '0',
  first_call: 'true',
  ga: '',
  gclid: 'Cj0TESTgclid',
  keywords: 'custom kitchen cabinets',
  kissmetrics_id: '',
  landingpage: 'https://www.example.com/showroom/?keyword=custom+kitchen+cabinets',
  recording: '',
  referrer: 'https://www.google.com/',
  referrermedium: 'cpc',
  resource_id: 'CAL0000test0000pre0000000000000001',
  score: '',
  timeline_url:
    'https://app.callrail.com/analytics/a/000000000/events/PER0000test?event_id=CAL0000test0000pre0000000000000001&event_type=call',
  trackingnum: '+18565550100',
  utm_campaign: 'Ads Extension',
  utm_content: '',
  utm_medium: 'cpc',
  utm_source: 'google',
  utm_term: '',
  utma: '',
  utmb: '',
  utmc: '',
  utmv: '',
  utmz: '',
};

export const CALLRAIL_WEBHOOK_POST: Readonly<Record<string, string>> = {
  ...CALLRAIL_WEBHOOK_PRE,
  answered: 'true',
  destinationnum: '+18565550199',
  duration: '230',
  recording:
    'https://example.callreports.com/calls/CAL0000test0000pre0000000000000001/recording/redirect?access_key=test-only',
};
