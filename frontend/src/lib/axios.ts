import axios from 'axios';
import { supabase, getAccessToken } from './supabase';
import { toast } from '@/components/ui/use-toast';
import { handle429 } from './handle429';
import { handle402 } from './handle402';
import { handle500 } from './handle500';

declare module 'axios' {
  interface AxiosRequestConfig {
    /** A request the person did not ask for (a background refresh) whose
     *  failure must stay invisible: the response interceptor shows none of its
     *  rate-limit, plan or server-error toasts for it. The caller still gets
     *  the rejection and handles it quietly. A 401 still refreshes the session. */
    silentErrors?: boolean;
  }
}

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '',
  headers: { 'Content-Type': 'application/json' },
});

// Attach JWT to every request — synchronous, no async penalty per request
api.interceptors.request.use((config) => {
  const token = getAccessToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Handle 401 responses: try refreshing the token once
let isRefreshing = false;

// A 401 from one of these means "this auth attempt failed", not "your
// session expired" — there is no session to refresh, so the refresh/redirect
// branch below must not run for them. /api/auth/me is deliberately excluded
// from this list: an expired-but-refreshable session 401ing there is exactly
// what the refresh branch exists to handle.
const AUTH_ATTEMPT_PATHS = ['/api/auth/login', '/api/auth/mfa/verify', '/api/auth/mfa/resend', '/api/auth/logout'];

// A no-op if we're already there — otherwise a straggling authenticated
// request that 401s right after logout (session already torn down client-side,
// ProtectedRoute already navigated here) forces a second, hard reload on top
// of the page the user is already looking at.
function redirectToLogin(): void {
  if (window.location.pathname !== '/login') {
    window.location.href = '/login';
  }
}

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    const isAuthAttempt = AUTH_ATTEMPT_PATHS.some((path) => originalRequest.url?.startsWith(path));

    if (error.response?.status === 401 && !isAuthAttempt && !originalRequest._retry && !isRefreshing) {
      originalRequest._retry = true;
      isRefreshing = true;

      try {
        const { error: refreshError } = await supabase.auth.refreshSession();
        isRefreshing = false;

        if (refreshError) {
          redirectToLogin();
          return Promise.reject(error);
        }

        // Retry the original request with the new token (cache updated by onAuthStateChange)
        const token = getAccessToken();
        if (token) {
          originalRequest.headers.Authorization = `Bearer ${token}`;
        }
        return api(originalRequest);
      } catch {
        isRefreshing = false;
        redirectToLogin();
        return Promise.reject(error);
      }
    }

    // A background request the person did not ask for fails silently.
    if (originalRequest?.silentErrors) {
      return Promise.reject(error);
    }

    if (error.response?.status === 429) {
      handle429(error, toast, Date.now);
    }

    // 402 = plan gate (requireFeature). Distinct from 403 on purpose: a plan
    // block must never be misread as a permissions bug. Handled WITHOUT
    // navigating: this used to redirect to /upgrade on ANY 402, so one
    // background call to a higher-plan module tore down the page the user was
    // on (a Pro org could not open a job). Only <RequireFeature> - an actual
    // navigation into a gated module - renders the upgrade page now.
    if (error.response?.status === 402) {
      handle402(error, toast, Date.now);
    }

    if (error.response?.status === 500) {
      handle500(error, toast, Date.now);
    }

    return Promise.reject(error);
  }
);

export default api;
