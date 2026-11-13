// The env every backend test file sees (setup.ts mocks ../config/env with it). Kept in its own
// module so a file that needs one value changed can mock env as this object plus that value,
// instead of copying it (spider-api-db.test.ts points DATABASE_URL at the test database).
export const testEnv = {
  PORT: 3000,
  NODE_ENV: 'test',
  FRONTEND_URL: 'http://localhost:5173',
  TAX_RATE: 0.0875,
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  // Copilot (Servy) — key present by default; the controller test mocks the
  // gemini-generate service directly, so the SDK is never actually called.
  GEMINI_API_KEY: 'test-gemini-key',
  GEMINI_TEXT_MODEL: 'gemini-2.5-flash',
  GEMINI_LIVE_MODEL: 'gemini-2.5-flash-native-audio-preview-12-2025',
  COPILOT_VOICE_NAME: 'Puck',
  COPILOT_SESSION_MINUTES: 30,
  COPILOT_RATELIMIT_CAPACITY: 30,
  COPILOT_RATELIMIT_REFILL_PER_MIN: 15,
  // Email slice 6 - the inbound reply domain. Deliberately NOT the production
  // default (reply.servwave.com): a test asserting against the real value
  // would pass just as happily if the code hardcoded the domain instead of
  // reading it from config.
  EMAIL_REPLY_DOMAIN: 'reply.test.com',
  // Mobile slice 21 - the bridge ring-first switch, at its real default (off),
  // so every click-to-call suite keeps sending today's exact body.
  CTM_BRIDGE_RING_CALLER: 'off',
  CTM_BRIDGE_AGENT_IDS: new Map(),
  // PRD 10 - the key a company purge hashes its mailbox addresses under. Present by default so a purge
  // run against a stub transaction works; the suite that proves a missing key fails the purge takes it
  // away itself.
  MAILBOX_ADDRESS_HASH_KEY: 'test-mailbox-hash-key-0123456789abcdef',
  // PRD 10 (S10.11) - the domain a person's own address is built on, so a hand-written email has an address to go out from.
  MAILBOX_DOMAIN: 'mail.test.com',
  // #3472 - the server-wide cap on open live lines, at its real default.
  LIVE_LINES_MAX: 2000,
};
