import type { StorybookConfig } from "@storybook/react-vite"

/* =============================================================================
   Storybook 8 - Vite builder configuration.

   Stories are globbed from FIVE component roots: components/ui (the
   primitives, phase 8/9), components/patterns (the composition layer,
   phase 10 / 11.6), components/charts (the chart primitives, phase 12
   chart-stories pass), components/data (KpiTile/KpiStrip, same pass), and
   components/jobs/overview (SectionCard/SectionLabel, phase 12a). The last
   one is a single-file exception to the "one shared root per layer"
   shape the first four follow - SectionCard is a widely-shared primitive
   (17 real call sites outside the jobs feature at the time this was
   written) that happens to live inside a feature directory rather than a
   shared components/ root, and moving it is its own structural edit (see
   phase 12b), not something phase 12a's job of retiring DesignSystemPage
   should do as a side effect. A future consolidation may collapse this
   list to one recursive glob covering the whole components tree instead
   of enumerating roots one at a time - this is the second time in the
   program a story has existed on disk undiscovered because its directory
   was not yet in this list (see phase 12.1 for the first), which is
   worth noticing as a pattern rather than patching one directory at a
   time forever. Not done here, to keep this PR's diff to what retiring
   DesignSystemPage actually requires.
   Patterns/charts/data were each left out of earlier globs because the
   layer did not exist yet or had no story; every one of those additions
   exists because a component a designer cannot open in Storybook is a
   component they cannot discover - the program plan's own corollary 2
   ("if a variant exists in code but not in Storybook, the designer cannot
   discover it, so it does not exist"). The chart/data addition closes the
   exact same class of gap the patterns addition closed: `DesignSystemPage`
   was the only place any of the 10 chart primitives, `ChartCard` or
   `KpiTile` rendered, and it is scheduled for retirement (phase 12a) -
   retiring it before these stories existed and were globbed would have
   deleted their only designer-facing documentation with nothing to
   replace it.

   ONE ASYMMETRY WORTH KNOWING BEFORE WRITING A PATTERN STORY.
   component-api-guard.test.ts's `targetFiles()` excludes `components/ui/**`
   wholesale, so a story under components/ui may write any className it
   likes. It does NOT exclude `.stories.tsx` by name, so a story under
   components/patterns IS scanned - and that directory carries
   `DIR_CEILINGS['components/patterns'] = 0`, zero appearance tokens on any
   tag. Pattern stories therefore build their scaffolding from primitives
   and layout-only classes (no colour, background, radius, border, shadow or
   padding class anywhere - spelled in words rather than as hyphenated class
   stems, because unresolved-classes-guard tokenises comment text too), which
   is why they read differently from the ui/ ones. That is
   deliberate: it keeps the ceiling honest instead of carving out an
   exemption for documentation.

   Vite auto-discovers the nearest vite.config.ts from the project root, so
   Storybook's own Vite build picks up the app's config (frontend/vite.config.ts)
   even though nothing here references it. Confirmed by an actual
   `storybook build` run: the app's `vite-plugin-pwa` plugin came along for
   the ride and emitted a real service worker (sw.js/sw.mjs), a
   manifest.webmanifest, and a ~7MB precache manifest into storybook-static -
   none of which a component catalog needs or wants. `@sentry/vite-plugin`
   does not need the same treatment: it already resolves to a documented
   no-op ("sentry-noop-plugin") whenever SENTRY_AUTH_TOKEN is unset (see
   vite.config.ts), which is true for a local/CI storybook build with no
   Sentry env configured for this target - but it is filtered out here too,
   defensively, so a storybook build never uploads source maps even if that
   env var happens to be set in some CI context.

   Fix: drop both plugin families in viteFinal before Storybook's Vite build
   runs. Everything else from the app config (resolve.alias, etc.) still
   merges in normally - only these two plugin families are excluded.
   ============================================================================= */
const config: StorybookConfig = {
  stories: [
    "../src/components/ui/**/*.stories.@(ts|tsx)",
    "../src/components/patterns/**/*.stories.@(ts|tsx)",
    "../src/components/charts/**/*.stories.@(ts|tsx)",
    "../src/components/jobs/overview/**/*.stories.@(ts|tsx)",
    "../src/components/data/**/*.stories.@(ts|tsx)",
    // SRVW-243 - schedule was never globbed, so a story here would have existed on
    // disk and been invisible in Storybook (the recurring phase-12 trap).
    "../src/components/schedule/**/*.stories.@(ts|tsx)",
  ],
  addons: ["@storybook/addon-essentials"],
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  core: {
    disableTelemetry: true,
  },
  async viteFinal(viteConfig) {
    const excluded = ["vite-plugin-pwa", "sentry"]
    const isExcluded = (plugin: unknown): boolean => {
      if (!plugin || typeof plugin !== "object" || !("name" in plugin)) return false
      const name = String((plugin as { name: unknown }).name)
      return excluded.some((needle) => name.includes(needle))
    }
    // Manual flatten instead of `.flat(Infinity)` - the built-in overload
    // infers an unbounded recursive FlatArray type from a non-literal depth
    // and TS blows up with "Type instantiation is excessively deep" the
    // moment this file is type-checked (esbuild strips types at build time
    // so `storybook build` never notices, but a real tsc pass would).
    const flatten = (items: unknown): unknown[] =>
      Array.isArray(items) ? items.flatMap((item) => flatten(item)) : [items]
    const plugins = flatten(viteConfig.plugins ?? []).filter((plugin) => !isExcluded(plugin))
    return {
      ...viteConfig,
      plugins: plugins as typeof viteConfig.plugins,
    }
  },
}

export default config
