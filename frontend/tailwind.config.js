import tailwindcssAnimate from 'tailwindcss-animate';

/** One scheduler event type's accent plus the card colours derived from it (see `ev-job` below). */
const evCardColors = (type) => {
  const v = (suffix) => `rgb(var(--ev-${type}${suffix}) / <alpha-value>)`;
  return {
    DEFAULT: v(''),
    surface: v('-surface'),
    text: v('-text'),
    border: v('-border'),
    solid: v('-solid'),
    'on-solid': v('-on-solid'),
  };
};

/** @type {import('tailwindcss').Config} */
export default {
  // Phase 7c (2026-07-28): `darkMode: ['class']` removed. Nothing in the app
  // ever applied the `dark` class - no theme provider, no `classList` write,
  // no `prefers-color-scheme` - so every `dark:` variant compiled to a rule
  // behind an ancestor that never existed. Dark mode is not on the roadmap
  // (Ran, 2026-07-27); phase 9's `Surface tone="dark"` covers the one real
  // need, a dark surface inside a light app, without a global theme switch.
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    // Phase 5c: `colors` and `borderRadius` moved OUT of `extend`. Under
    // `extend` they ADD to Tailwind's stock scale; here they REPLACE it -
    // the only two sections doing that is deliberate, see the sequencing
    // note at the end of this file. Every other section (fontFamily,
    // boxShadow, spacing, keyframes, animation) stays under `extend` below,
    // since those stock scales were never the problem this phase exists to
    // close - they only ADD keys, they never mint a raw-palette-shaped class
    // the token guard has to ban.
    //
    // Colors map to `rgb(var(--token) / <alpha-value>)`. Storing the CSS var as
    // space-separated RGB CHANNELS (in tokens.css) is what keeps opacity
    // modifiers working: bg-primary/10, ring-primary/15, bg-success/10, etc.
    // expand to rgb(var(--primary) / 0.10). Token CLASS NAMES are unchanged -
    // only their definitions moved from hex to var(). Values live in tokens.css.
    colors: {
        // The four keys Tailwind's stock palette carried for free, that
        // `extend` kept alive and non-extend would otherwise silently drop.
        // Real, measured 2026-07-27 consumers, not a defensive guess:
        //   transparent - 75 sites (bg-/border-/border-t-/to-transparent)
        //   current     - 3 sites (text-current, fill-current x2)
        //   white/black - 0 production sites (phase 4c cleared them); the
        //     only remaining uses are this guard's OWN test fixtures
        //     (design-system/__tests__/*.test.ts, which pattern-match the
        //     string and need it to exist as a real class so
        //     check-unresolved-classes.mjs doesn't flag its own fixtures)
        //     and pages/design-system/*MockupPage.tsx, which exist
        //     specifically to render genuine unthemed white/black for
        //     side-by-side comparison against the token surface - both need
        //     the LITERAL colour, not a token that could be retuned later
        //     out from under them.
        //
        // `inherit` was in this list as "never a real Tailwind default key
        // (not in tailwindcss/lib/public/colors.js), zero call sites, not
        // registered". It has one now, and it is a structural one rather than
        // a colour choice: a sticky table cell has to be opaque to occlude the
        // content scrolling under it, but must not name a colour of its own or
        // it stops following the row through hover and selection. `bg-inherit`
        // is the only class that expresses "whatever my row is painting" -
        // see ui-kit/components/ui/table.tsx. Like `transparent` and
        // `current`, it is a CSS keyword, not a palette entry, so it carries
        // none of the drift the token rule exists to prevent.
        transparent: 'transparent',
        current: 'currentColor',
        inherit: 'inherit',
        white: '#ffffff',
        black: '#000000',
        // Calm Intelligence 2.0 — interactive anchor is Deep Ocean (hybrid model)
        primary: {
          DEFAULT: 'rgb(var(--primary) / <alpha-value>)',
          light: 'rgb(var(--primary-light) / <alpha-value>)',
          dark: 'rgb(var(--primary-dark) / <alpha-value>)',
          subtle: 'rgb(var(--primary-subtle) / <alpha-value>)',
          // v2 additions (tokens-v2.css). Additive: no existing class changes.
          foreground: 'rgb(var(--primary-foreground) / <alpha-value>)',
          hover: 'rgb(var(--primary-hover) / <alpha-value>)',
        },
        secondary: {
          DEFAULT: 'rgb(var(--secondary) / <alpha-value>)',
          light: 'rgb(var(--secondary-light) / <alpha-value>)',
          dark: 'rgb(var(--secondary-dark) / <alpha-value>)',
        },
        background: {
          light: 'rgb(var(--background-light) / <alpha-value>)', // canvas
          dark: 'rgb(var(--background-dark) / <alpha-value>)',
        },
        surface: {
          light: 'rgb(var(--surface-light) / <alpha-value>)',
          dark: 'rgb(var(--surface-dark) / <alpha-value>)',
        },
        'text-primary': 'rgb(var(--text-primary) / <alpha-value>)',
        'text-secondary': 'rgb(var(--text-secondary) / <alpha-value>)',
        'text-soft': 'rgb(var(--text-soft) / <alpha-value>)',
        border: 'rgb(var(--border-color) / <alpha-value>)',
        'border-soft': 'rgb(var(--border-soft) / <alpha-value>)',
        // Component surface treatments — retune in tokens.css (one place)
        'table-header': 'rgb(var(--table-header) / <alpha-value>)',
        'card-header': 'rgb(var(--card-header) / <alpha-value>)',
        // Status families carry FOUR roles each. DEFAULT preserves every existing
        // bg-success / text-danger call site unchanged; surface/border/text/strong
        // are the AA-verified set that replaces the raw palette classes.
        // See tokens.css for the contrast proof - do not hand-pick new values.
        success: {
          DEFAULT: 'rgb(var(--success) / <alpha-value>)',
          surface: 'rgb(var(--success-surface) / <alpha-value>)',
          border: 'rgb(var(--success-border) / <alpha-value>)',
          text: 'rgb(var(--success-text) / <alpha-value>)',
          strong: 'rgb(var(--success-strong) / <alpha-value>)',
        },
        danger: {
          DEFAULT: 'rgb(var(--danger) / <alpha-value>)',
          surface: 'rgb(var(--danger-surface) / <alpha-value>)',
          border: 'rgb(var(--danger-border) / <alpha-value>)',
          text: 'rgb(var(--danger-text) / <alpha-value>)',
          strong: 'rgb(var(--danger-strong) / <alpha-value>)',
        },
        warning: {
          DEFAULT: 'rgb(var(--warning) / <alpha-value>)',
          surface: 'rgb(var(--warning-surface) / <alpha-value>)',
          border: 'rgb(var(--warning-border) / <alpha-value>)',
          text: 'rgb(var(--warning-text) / <alpha-value>)',
          strong: 'rgb(var(--warning-strong) / <alpha-value>)',
        },
        info: {
          // status only - #5B6DFF is reserved for AI
          DEFAULT: 'rgb(var(--info) / <alpha-value>)',
          surface: 'rgb(var(--info-surface) / <alpha-value>)',
          border: 'rgb(var(--info-border) / <alpha-value>)',
          text: 'rgb(var(--info-text) / <alpha-value>)',
          strong: 'rgb(var(--info-strong) / <alpha-value>)',
        },
        neutral: {
          surface: 'rgb(var(--neutral-surface) / <alpha-value>)',
          border: 'rgb(var(--neutral-border) / <alpha-value>)',
          text: 'rgb(var(--neutral-text) / <alpha-value>)',
          strong: 'rgb(var(--neutral-strong) / <alpha-value>)',
        },
        // Foreground on a solid semantic fill. Use instead of literal text-white
        // so a re-pointed fill token actually repaints its label.
        'on-fill': 'rgb(var(--text-on-fill) / <alpha-value>)',
        notify: 'rgb(var(--notify) / <alpha-value>)', // notification-count badges ONLY — never a general red
        // Calendar Entry board accent (slice 03, calendar-entries spec §3) — the muted "Event"
        // type accent in scheduleModel.ts's EVENT_TYPE_META, same DEFAULT-only shape as
        // info/warning/ai above (not the badge quartet). border-l-event / bg-event/5 / text-event.
        event: 'rgb(var(--event) / <alpha-value>)',
        // Scheduler board accents, one per EventType. These are what EVENT_TYPE_META and
        // eventStyleGetter paint with now, INSTEAD of info/warning/ai/event directly.
        // The class names are static, so Tailwind still sees them at build time and no
        // safelist is needed; only the VALUE is late-bound, resolved at paint time from the
        // --ev-* custom properties the schedule page sets from the org's saved colours.
        // Defaults alias the same status tokens as before, so an uncustomised board is
        // pixel-identical. Do NOT reach for these outside the scheduler - elsewhere an org's
        // "Job = green" would read as a success state.
        //
        // The nested keys are the card colours DERIVED from each accent (tokens.css, and
        // lib/schedule/useScheduleEventColorVars for an org's own picks): `bg-ev-job-surface`,
        // `text-ev-job-text`, `border-l-ev-job-border`, `bg-ev-job-solid` + `text-ev-job-on-solid`.
        // A CARD paints those, never the bare accent: the accent on a tint of itself is what failed
        // AA. The bare `ev-job` stays for swatches that show the picked colour as a colour.
        'ev-job': evCardColors('job'),
        'ev-walkthrough': evCardColors('walkthrough'),
        'ev-service-plan': evCardColors('service-plan'),
        'ev-calendar-entry': evCardColors('calendar-entry'),
        'ev-in-progress': {
          solid: 'rgb(var(--ev-in-progress-solid) / <alpha-value>)',
          'on-solid': 'rgb(var(--ev-in-progress-on-solid) / <alpha-value>)',
        },
        'ev-completed': {
          solid: 'rgb(var(--ev-completed-solid) / <alpha-value>)',
          'on-solid': 'rgb(var(--ev-completed-on-solid) / <alpha-value>)',
        },
        // The scheduler's needs-crew notch (NeedsCrewMark). Scheduler-only, like ev-* above.
        understaffed: 'rgb(var(--understaffed) / <alpha-value>)',
        // Modal backdrop. Use `bg-scrim/80` instead of `bg-black/80` so how much
        // the app dims behind an overlay is one decision, not a per-overlay guess.
        scrim: 'rgb(var(--scrim) / <alpha-value>)',
        // Brand foundation (chrome)
        ocean: {
          900: 'rgb(var(--ocean-900) / <alpha-value>)',
          800: 'rgb(var(--ocean-800) / <alpha-value>)',
          700: 'rgb(var(--ocean-700) / <alpha-value>)',
        },
        // Business / operations / progress
        sage: {
          50: 'rgb(var(--sage-50) / <alpha-value>)',
          200: 'rgb(var(--sage-200) / <alpha-value>)',
          500: 'rgb(var(--sage-500) / <alpha-value>)',
          700: 'rgb(var(--sage-700) / <alpha-value>)',
        },
        // ---------------------------------------------------------------
        // v2 presentation layer (CRM UI kit). Values in tokens-v2.css.
        // Every key below is NEW - none of these class names resolved to
        // anything before, so no existing page changes appearance. Delete
        // this block plus tokens-v2.css to roll the v2 layer back.
        // ---------------------------------------------------------------
        foreground: 'rgb(var(--foreground) / <alpha-value>)',
        app: 'rgb(var(--app) / <alpha-value>)',
        column: {
          DEFAULT: 'rgb(var(--column) / <alpha-value>)',
          active: 'rgb(var(--column-active) / <alpha-value>)',
        },
        // `kit-` prefixed, and it matters. `card` and `popover` are ALREADY
        // boxShadow keys below. Tailwind's boxShadow and boxShadowColor core
        // plugins both own the `shadow-` namespace, so registering a COLOUR of
        // the same name emits a second `.shadow-card` rule that wins and
        // rewrites the shadow's colour. It happens to be inert while
        // --shadow-card is an opaque var() Tailwind cannot decompose, but it
        // would turn every card shadow white the moment anyone inlines a
        // literal there. `kit-background` is prefixed only for symmetry with
        // these two - the app's `background` key has no DEFAULT and minting one
        // would have been safe, since bare `bg-background` has zero call sites.
        // See tokens-v2.css.
        'kit-background': 'rgb(var(--kit-background) / <alpha-value>)',
        'kit-card': {
          DEFAULT: 'rgb(var(--card) / <alpha-value>)',
          foreground: 'rgb(var(--card-foreground) / <alpha-value>)',
        },
        'kit-popover': {
          DEFAULT: 'rgb(var(--popover) / <alpha-value>)',
          foreground: 'rgb(var(--popover-foreground) / <alpha-value>)',
        },
        muted: {
          DEFAULT: 'rgb(var(--muted) / <alpha-value>)',
          foreground: 'rgb(var(--muted-foreground) / <alpha-value>)',
        },
        'subtle-foreground': 'rgb(var(--subtle-foreground) / <alpha-value>)',
        // The disabled palette. Flat rather than nested under `disabled.*`
        // because `disabled:` is also a Tailwind VARIANT prefix, and
        // `disabled:bg-disabled-border` has to stay unambiguous.
        disabled: 'rgb(var(--disabled) / <alpha-value>)',
        'disabled-foreground': 'rgb(var(--disabled-foreground) / <alpha-value>)',
        'disabled-border': 'rgb(var(--disabled-border) / <alpha-value>)',
        accent: {
          DEFAULT: 'rgb(var(--accent) / <alpha-value>)',
          foreground: 'rgb(var(--accent-foreground) / <alpha-value>)',
        },
        destructive: {
          DEFAULT: 'rgb(var(--destructive) / <alpha-value>)',
          foreground: 'rgb(var(--destructive-foreground) / <alpha-value>)',
          hover: 'rgb(var(--destructive-hover) / <alpha-value>)',
        },
        brand: {
          DEFAULT: 'rgb(var(--brand) / <alpha-value>)',
          foreground: 'rgb(var(--brand-foreground) / <alpha-value>)',
          subtle: 'rgb(var(--brand-subtle) / <alpha-value>)',
          emphasis: 'rgb(var(--brand-emphasis) / <alpha-value>)',
        },
        tonal: {
          DEFAULT: 'rgb(var(--tonal) / <alpha-value>)',
          foreground: 'rgb(var(--tonal-foreground) / <alpha-value>)',
          hover: 'rgb(var(--tonal-hover) / <alpha-value>)',
        },
        input: {
          DEFAULT: 'rgb(var(--input) / <alpha-value>)',
          hover: 'rgb(var(--input-hover) / <alpha-value>)',
        },
        ring: 'rgb(var(--ring) / <alpha-value>)',
        selected: 'rgb(var(--selected) / <alpha-value>)',
        status: {
          green: 'rgb(var(--status-green) / <alpha-value>)',
          blue: 'rgb(var(--status-blue) / <alpha-value>)',
          amber: 'rgb(var(--status-amber) / <alpha-value>)',
          red: 'rgb(var(--status-red) / <alpha-value>)',
          purple: 'rgb(var(--status-purple) / <alpha-value>)',
          slate: 'rgb(var(--status-slate) / <alpha-value>)',
          teal: 'rgb(var(--status-teal) / <alpha-value>)',
          indigo: 'rgb(var(--status-indigo) / <alpha-value>)',
          'green-subtle': 'rgb(var(--status-green-subtle) / <alpha-value>)',
          'blue-subtle': 'rgb(var(--status-blue-subtle) / <alpha-value>)',
          'amber-subtle': 'rgb(var(--status-amber-subtle) / <alpha-value>)',
          'red-subtle': 'rgb(var(--status-red-subtle) / <alpha-value>)',
          'purple-subtle': 'rgb(var(--status-purple-subtle) / <alpha-value>)',
          'slate-subtle': 'rgb(var(--status-slate-subtle) / <alpha-value>)',
          'green-emphasis': 'rgb(var(--status-green-emphasis) / <alpha-value>)',
          'blue-emphasis': 'rgb(var(--status-blue-emphasis) / <alpha-value>)',
          'amber-emphasis': 'rgb(var(--status-amber-emphasis) / <alpha-value>)',
          'red-emphasis': 'rgb(var(--status-red-emphasis) / <alpha-value>)',
          'purple-emphasis': 'rgb(var(--status-purple-emphasis) / <alpha-value>)',
          'slate-emphasis': 'rgb(var(--status-slate-emphasis) / <alpha-value>)',
        },
        sidebar: {
          foreground: 'rgb(var(--sidebar-foreground) / <alpha-value>)',
          'muted-foreground': 'rgb(var(--sidebar-muted-foreground) / <alpha-value>)',
          'subtle-foreground': 'rgb(var(--sidebar-subtle-foreground) / <alpha-value>)',
          // --sidebar-accent is authored as a composed rgb() with its own alpha,
          // so it cannot go through the rgb(var(--x) / <alpha-value>) mapping.
          accent: 'var(--sidebar-accent)',
        },
        // AI / intelligence (reserved for AI moments)
        ai: {
          DEFAULT: 'rgb(var(--ai-600) / <alpha-value>)',
          50: 'rgb(var(--ai-50) / <alpha-value>)',
          200: 'rgb(var(--ai-200) / <alpha-value>)',
          500: 'rgb(var(--ai-500) / <alpha-value>)',
          600: 'rgb(var(--ai-600) / <alpha-value>)',
          surface: 'rgb(var(--ai-surface) / <alpha-value>)',
          border: 'rgb(var(--ai-border) / <alpha-value>)',
          text: 'rgb(var(--ai-text) / <alpha-value>)',
          strong: 'rgb(var(--ai-strong) / <alpha-value>)',
          300: 'rgb(var(--ai-300) / <alpha-value>)',
          'gradient-to': 'rgb(var(--ai-gradient-to) / <alpha-value>)',
          'night-top': 'rgb(var(--ai-night-top) / <alpha-value>)',
          'night-bottom': 'rgb(var(--ai-night-bottom) / <alpha-value>)',
        },
        // Text ON the dark copilot surface. The -text roles are AA-tuned for a
        // LIGHT surface and are unreadable there, so these are distinct roles.
        'danger-on-dark': 'rgb(var(--danger-on-dark) / <alpha-value>)',
        'warning-on-dark': 'rgb(var(--warning-on-dark) / <alpha-value>)',
        // NOTE: --amber-900 is deliberately NOT exposed as a Tailwind colour.
        // Registering it would mint `bg-amber-900`, which the token guard reads
        // as a raw palette class - a token spelled exactly like the thing the
        // guard exists to ban. It is consumed as `rgb(var(--amber-900))` inside
        // CSS strings instead.
        // Dark-surface chrome - phase 5b. Only the roles that DON'T already
        // auto-flip under `.dark` (see tokens.css). Always used behind a
        // `dark:` variant, e.g. `dark:border-chrome-dark`, `dark:text-on-dark`.
        'chrome-dark': 'rgb(var(--chrome-dark) / <alpha-value>)',
        'on-dark': 'rgb(var(--on-dark) / <alpha-value>)',
        'on-dark-muted': 'rgb(var(--on-dark-muted) / <alpha-value>)',
        'focus-dark': 'rgb(var(--focus-dark) / <alpha-value>)',
        // Third-party channel brand. Deliberately NOT part of the theme.
        whatsapp: {
          DEFAULT: 'rgb(var(--channel-whatsapp) / <alpha-value>)',
          dark: 'rgb(var(--channel-whatsapp-dark) / <alpha-value>)',
          bubble: 'rgb(var(--channel-whatsapp-bubble) / <alpha-value>)',
          canvas: 'rgb(var(--channel-whatsapp-canvas) / <alpha-value>)',
        },
    },
    // Radii live in tokens.css. ServWave = 6px "crisp" everywhere except buttons (14px, intentional); icon tiles 5px.
    //
    // Phase 5a: `md`/`lg`/`2xl`/`none`/`full` below are Tailwind DEFAULT scale
    // keys, not project tokens - they used to reach the tree only because
    // `theme.extend` kept the stock scale alive underneath our own keys.
    // Closing the hatch (phase 5c) drops any default key not registered here
    // explicitly, silently: Tailwind exits 0 and the element renders square.
    // Registering them by NAME, pointed at the correct primitive, is the
    // "convert" step for the ~1500 call sites using them - no site edit
    // needed, since the class string becomes a first-class token reference
    // the moment its key is registered here instead of inherited.
    borderRadius: {
        DEFAULT: 'var(--radius-control)', // 6px — inputs, textareas, general controls
        sm: 'var(--radius-control)', // 6px — inputs
        md: 'var(--radius-control)', // 6px - value-preserving: Tailwind's own default md is 0.375rem = 6px
        control: 'var(--radius-control)', // 6px — explicit role name for DEFAULT; 20 sites already used it while it was unregistered (rendering no radius at all)
        card: 'var(--radius-card)', // 6px — cards
        lg: 'var(--radius-card)', // 6px - repoints Tailwind's default lg (0.5rem = 8px) down to the crisp
        // rule, same move already made for xl below. 323 sites sampled are cards, dropdown
        // panels, textareas and dialogs - the card role, not a distinct size.
        xl: 'var(--radius-card)', // 6px — app's de-facto card radius (rounded-xl)
        '2xl': 'var(--radius-bubble)', // 16px - value-preserving: Tailwind's default 2xl is 1rem = 16px.
        // Every 2xl site sampled is a chat/SMS message bubble, the compose panel, or the
        // legacy floating LineItemRow row - consistently bigger than card on purpose.
        none: '0px', // explicit zero-radius: full-screen mobile dialog, ResizableTable's flat
        // variant, and WhatsApp's pointed-bubble-tail corners - all intentional, not drift.
        ic: 'var(--radius-ic)', // 5px — icon tiles
        button: 'var(--radius-button)', // 14px — buttons only, deliberately softer
        bubble: 'var(--radius-bubble)', // 16px - explicit name for the 2xl primitive above
        pill: '9999px', // notify-count / avatar / switch only
        full: '9999px', // general "fully rounded" utility (avatars, dots, circular icon buttons,
        // status chips) - same value as pill, deliberately kept as a separate key so pill's
        // narrower documented role is not overloaded onto every circular element in the tree.
    },
    // Tailwind's own default preset derives `borderColor` from `colors` with
    // one override: `DEFAULT: theme('colors.gray.200', 'currentColor')` -
    // the colour Preflight applies to `*, ::before, ::after` and the colour
    // a bare `border` utility (no explicit border-{color}) resolves to.
    // Replacing `colors` above with a non-extend object that has no `gray`
    // family made that fallback silently resolve to `currentColor` instead
    // (verified by diffing compiled Preflight output against HEAD - #e5e7eb
    // before, currentColor after). Re-declaring `borderColor` explicitly,
    // spreading the same `colors` theme back in so every `border-{token}`
    // utility keeps working, and pointing DEFAULT at this project's own
    // border token instead of Tailwind's stock gray-200 is the fix.
    borderColor: ({ theme }) => ({
      ...theme('colors'),
      DEFAULT: 'rgb(var(--border-color) / <alpha-value>)',
    }),
    extend: {
      // Everything below still ADDS to Tailwind's stock scale rather than
      // replacing it - fontFamily/boxShadow/spacing/keyframes/animation were
      // never the escape hatch; only colors and borderRadius (above) were.
      fontFamily: {
        sans: ['Manrope', 'system-ui', 'sans-serif'],
      },
      /**
       * The stacking order for things that float, named once.
       *
       * Every layer used to be a bare number chosen at the call site, and the
       * numbers stopped agreeing: the kit's Select, DropdownMenu and Popover
       * all sat at z-50, while the Schedule module had grown its own scale on
       * top of them - menus at 50, the quick-schedule card at 60, its confirm
       * modals at 70. A time picker opened from that card therefore rendered
       * BEHIND the card that opened it, which is the reported "the times
       * dropdown goes behind the new-event window".
       *
       * `floating` is the top of the stack and belongs to menus, selects,
       * popovers and tooltips - the transient things a user opens FROM
       * something else. They must outrank every surface, including whichever
       * one spawned them, because there is no case where the answer to "which
       * should be on top, the menu or the panel it belongs to" is the panel.
       */
      zIndex: {
        // Page-level panels and scrims: dialogs, drawers, the schedule's own
        // popup surfaces.
        surface: '50',
        // A surface raised over another surface - a confirm over a dialog.
        'surface-raised': '70',
        // Menus, selects, popovers, tooltips.
        floating: '100',
      },
      // Phase 7 (2026-07-28): the 10px rung gets a NAME so components can stop
      // writing it as an arbitrary bracket value. Measured 2026-07-27: 484
      // occurrences across 120 files, the largest single bracket font size in
      // the tree. Registering is a rename, not a restyle; snapping those 484 to
      // the stock 12px key would be a 2px type change on 120 files.
      //
      // THE VALUE IS A BARE STRING, DELIBERATELY. Tailwind's stock keys ship a
      // [size, { lineHeight }] tuple whose line height is an absolute LENGTH
      // (stock 14px key = 0.875rem / 1.25rem, verified against tailwindcss
      // 3.4.19 defaultTheme). An arbitrary bracket font size emits font-size
      // ONLY and inherits its ancestor's line-height as a length. So pairing
      // this key with a UNITLESS 1.5 would not preserve today's rendering: the
      // one live call site, the voided marker in InvoiceDetailPage's payment
      // ledger, sits inside a table whose root sets the stock 14px key, so it
      // inherits a 20px line box today and a tuple with 1.5 would collapse that
      // to 15px. A 5px geometry change under a byte-identical-rendering
      // constraint. Bare string emits font-size only, so the rendered output is
      // identical to the bracket value it replaces.
      //
      // ONLY this one key is registered. The other 15 measured bracket sizes
      // (1,618 occurrences in total across the guard's 413 target files) each
      // need their own ancestor line-height audit before they can be named, and
      // that migration belongs to W4, not here.
      fontSize: {
        '3xs': '10px',
      },
      boxShadow: {
        card: 'var(--shadow-card)',
        soft: 'var(--shadow-soft)',
        hover: 'var(--shadow-hover)',
        inset: 'var(--shadow-inset)',
        // v2 elevations (tokens-v2.css). `card` above stays the app's.
        // `xs` is a Tailwind v4 stock key; the kit was authored against v4 and
        // uses shadow-xs in 11 places, so on v3 it has to be registered or
        // every kit button, input, select, switch and textarea ships flat.
        xs: 'var(--elevation-xs)',
        'card-hover': 'var(--elevation-card-hover)',
        canvas: 'var(--elevation-canvas)',
        popover: 'var(--elevation-popover)',
        modal: 'var(--elevation-modal)',
        rail: 'var(--elevation-rail)',
      },
      spacing: {
        sidebar: '240px',
        header: '56px',
        // v2 (CRM UI kit). The kit was authored for Tailwind v4, whose spacing
        // scale is generated from a base unit, so any multiple of 0.25rem is a
        // valid class. v3 ships a fixed scale that stops half-steps at 3.5, so
        // these all emitted NOTHING: the switch thumb never moved, avatars had
        // no size, the sidebar had no width. Values are the v4 arithmetic,
        // n * 0.25rem. Additive - `extend` cannot disturb the app's scale.
        4.5: '1.125rem',
        5.5: '1.375rem',
        6.5: '1.625rem',
        8.5: '2.125rem',
        9.5: '2.375rem',
        11.5: '2.875rem',
        15: '3.75rem',
        19: '4.75rem',
        58: '14.5rem',
        63: '15.75rem',
        95: '23.75rem',
      },
      // v2: sidebar.tsx uses duration-250, absent from v3's fixed scale.
      //
      // The named `fast`/`panel` keys are the v2 motion scale (tokens-v2.css),
      // and a NAMED key is the only spelling that works here. An arbitrary one
      // (a bracketed value on `duration`) matches both Tailwind's own
      // transition-duration plugin and tailwindcss-animate's animation-duration
      // one, so Tailwind calls it ambiguous and emits NOTHING for it - a silent
      // dead class - which is what the two bracketed durations in
      // components/ui/switch.tsx are today. Check the compiled sheet, not the
      // warning: the build still exits 0.
      //
      // The trade-off is that tailwind-merge validates its duration group on a
      // number or an arbitrary value, so it does not recognise a named key and
      // cannot drop a competing `duration-150` from a kit component - both land
      // in the DOM and the later RULE wins. `extend` keys are emitted after the
      // default scale, so the named key is the later rule (verified in the
      // compiled CSS: .duration-150 then .duration-fast).
      transitionDuration: {
        250: '250ms',
        fast: 'var(--motion-duration-fast)',
        panel: 'var(--motion-duration-panel)',
      },
      transitionTimingFunction: {
        'out-soft': 'var(--motion-ease-out)',
      },
      // Servy copilot "alive" animations (AI lavender moments only)
      keyframes: {
        // v2 tab panel enter. TabPanel unmounts the outgoing panel outright,
        // so the incoming one always mounts fresh and an enter-only keyframe is
        // the whole animation - there is nothing left on screen to exit.
        //
        // TWO keyframes, not one, because the travel and the fade run for
        // different lengths of time - see the `tab-panel-in` animation below.
        // The alternative (one keyframe with an intermediate `60%` stop that
        // lands opacity early) puts a keyframe boundary in the middle of the
        // transform's interval, and the timing function is re-applied per
        // interval: the glide would ease twice and stutter at the seam.
        'tab-panel-glide': {
          from: { transform: 'translateY(var(--motion-travel-panel))' },
          to: { transform: 'translateY(0)' },
        },
        'tab-panel-fade': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        // General-purpose loading indicator (ocean/neutral) — distinct from
        // the servy-dot family below, which is reserved for AI-only moments.
        'loader-jump': {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-30px)' },
        },
        'servy-in': {
          from: { opacity: '0', transform: 'translateY(8px) scale(0.98)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        'servy-rotate': {
          from: { transform: 'rotate(0deg)' },
          to: { transform: 'rotate(360deg)' },
        },
        'servy-breathe': {
          '0%, 100%': { transform: 'scale(1)', opacity: '0.85' },
          '50%': { transform: 'scale(1.07)', opacity: '1' },
        },
        'servy-ripple': {
          from: { transform: 'scale(0.6)', opacity: '0.45' },
          to: { transform: 'scale(1.45)', opacity: '0' },
        },
        'servy-dot': {
          '0%, 60%, 100%': { transform: 'translateY(0)', opacity: '0.45' },
          '30%': { transform: 'translateY(-4px)', opacity: '1' },
        },
      },
      animation: {
        // Two animations under one class, the way the shell splits a move: the
        // sidebar travels for 0.46s while its labels fade for 0.3s, so the
        // content is fully opaque with a third of the travel still to run and
        // what you watch is the glide, not a wash. Run at one length instead
        // and 460ms of fade is just slow. Both properties are compositor-only
        // (transform, opacity), same reason .nav-rail moves on transform
        // rather than `top`.
        //
        // No fill-mode, unlike servy-in's `both`. `both` would hold the `to`
        // frame forever, and a settled `transform: translateY(0)` is still a
        // transform: it makes the panel a containing block for every
        // position:fixed descendant, which is how the popovers and dropdown
        // menus inside a tab panel are positioned. Without a fill-mode the
        // transform is gone the moment the animation ends, and with no delay
        // there is nothing to fill in at the start either. `will-change:
        // transform` is out for the same reason - it creates that containing
        // block too, and permanently.
        //
        // The durations are var()s inside the animation SHORTHAND, which is
        // only safe because these tokens are defined at `:root` in
        // tokens-v2.css and that file is imported globally from index.css. A
        // var() that fails to resolve makes the whole shorthand invalid at
        // computed-value time, and the symptom is a silent
        // `animation-duration: 0s`, not a build error. Verified in the browser:
        // 460ms / 300ms, not 0s.
        'tab-panel-in':
          'tab-panel-glide var(--motion-duration-panel) var(--motion-ease-out), ' +
          'tab-panel-fade var(--motion-duration-panel-fade) var(--motion-ease-out)',
        'loader-jump': 'loader-jump 1s ease-in-out infinite',
        'servy-in': 'servy-in 0.25s ease-out both',
        'servy-rotate': 'servy-rotate 6s linear infinite',
        'servy-rotate-fast': 'servy-rotate 1.4s linear infinite',
        'servy-breathe': 'servy-breathe 2.8s ease-in-out infinite',
        'servy-ripple': 'servy-ripple 1.6s ease-out infinite',
        'servy-dot': 'servy-dot 1.2s ease-in-out infinite',
      },
    },
  },
  // Imported at the top rather than require()'d here: this file is ESM
  // (`export default`, and the package is "type": "module"), and Node has no
  // `require` in an ES module - it threw
  // `ReferenceError: require is not defined` and took `vite build` with it.
  plugins: [tailwindcssAnimate],
};
