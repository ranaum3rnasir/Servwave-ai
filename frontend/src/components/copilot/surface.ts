/**
 * The copilot's night surface, in one place.
 *
 * CopilotPanel and CopilotSheet are two presentations of the same assistant, so
 * they must read as the same surface. They carried this gradient as a
 * byte-identical inline literal each, which is two definitions of one thing -
 * and both hardcoded `#0D1330`/`#090E20`, values no token named. Phase 4a added
 * `--ai-night-top` / `--ai-night-bottom` and this module is the single consumer
 * of them.
 *
 * Written as `rgb(var(--...))` rather than through the `token()` helper on
 * purpose: a CSS var inside an inline style is re-resolved by the browser when
 * the theme changes, whereas `token()` reads the computed value once at render
 * and would freeze the surface until React happened to re-render.
 */
export const COPILOT_SURFACE =
  'radial-gradient(900px 420px at 90% -10%, rgb(var(--ai-600) / 0.28), transparent 60%),' +
  ' radial-gradient(700px 380px at -15% 110%, rgb(var(--ai-600) / 0.16), transparent 55%),' +
  ' linear-gradient(180deg, rgb(var(--ai-night-top)) 0%, rgb(var(--ai-night-bottom)) 100%)';
