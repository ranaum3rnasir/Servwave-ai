/**
 * Mints single-use ephemeral tokens for the browser's Gemini Live voice session.
 *
 * The GEMINI_API_KEY never leaves the server. Instead we ask Gemini for a
 * short-lived token (`authTokens.create`, v1alpha) scoped to one new session;
 * the browser connects to Gemini Live directly with that token. This is the
 * partner-app pattern (shuli) and the reason voice survives the free tier:
 * Live is metered on concurrent sessions, not requests/day.
 *
 * Isolated so the controller can be unit-tested with this mocked.
 */
import { GoogleGenAI } from '@google/genai';
import { env } from '../../config/env';
import { GeminiNotConfiguredError } from './gemini-generate';

export interface LiveToken {
  /** The token name string the browser passes as the apiKey to ai.live.connect. */
  token: string;
  /** ISO timestamp after which the token (and therefore the session) is dead. */
  expireTime: string;
}

/**
 * Create a one-use ephemeral token. `sessionMinutes` caps how long the resulting
 * Live session may stay open; a session must be STARTED within `newSessionMs`
 * (60s) of minting. Throws GeminiNotConfiguredError when no key is set.
 */
export async function mintLiveToken(sessionMinutes = env.COPILOT_SESSION_MINUTES): Promise<LiveToken> {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) throw new GeminiNotConfiguredError();

  const expireTime = new Date(Date.now() + sessionMinutes * 60 * 1000).toISOString();
  const ai = new GoogleGenAI({ apiKey });
  const token = await ai.authTokens.create({
    config: {
      uses: 1,
      expireTime,
      newSessionExpireTime: new Date(Date.now() + 60 * 1000).toISOString(),
      httpOptions: { apiVersion: 'v1alpha' },
    },
  });

  if (!token.name) throw new Error('Gemini returned an empty ephemeral token');
  return { token: token.name, expireTime };
}
