/**
 * Google "G" mark, used on the "Sign in with Google" / "Continue with Google"
 * buttons (LoginPage, AcceptInvitePage). Accepts a `className` so each call
 * site sizes it (`h-5 w-5` today).
 *
 * DESIGN TOKEN EXEMPTION - INTENTIONAL, DO NOT "FIX".
 * The four hex values below are Google's registered brand colours and are
 * deliberately exempt from the design-token layer. They must stay literal hex
 * and must never be re-themed, re-tinted, mapped onto tokens, or swapped for
 * `currentColor` - a recoloured Google "G" misrepresents a third-party brand
 * mark and is a trademark problem, not just a visual one. This is a documented
 * residual, not an oversight: it is the reason the pages that use this icon
 * report zero raw hex while these four values survive here.
 */
interface GoogleIconProps {
  className?: string;
}

export function GoogleIcon({ className }: GoogleIconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.99.66-2.26 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z" />
    </svg>
  );
}
