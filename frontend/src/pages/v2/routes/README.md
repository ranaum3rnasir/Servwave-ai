# Registering a module

This directory IS the app's route table. `App.tsx` declares no page route of its own -
it splices in `v2Routes()` and adds the `*` catch-all, and that is all. Every path the
app serves is declared here, by the module that owns it, exactly once.

Registration is **additive only**: a module registers by adding two files here and
editing nothing that another module also edits.

## Do not edit these

`V2Routes.tsx` · `routes/index.tsx` · `routes/paths.ts` · `uiV2.ts` · `navSections.ts`

Every module would touch the same lines in them, and every merge after the first would
conflict. They are already written to need no per-module change.

## Add these two

### 1. `routes/<module>.paths.ts`

Every path the module claims. Plain paths - there is no prefix.

```ts
export const ESTIMATES_V2_PATHS = [
  '/estimates',
  '/estimates/new',
  '/estimates/:id',
] as const;
```

React must never be imported here. `uiV2.ts` reads the collected paths and is itself
imported by every page, so if this file reached a page the app would have an import
cycle. That is the only reason paths and routes are two files instead of one.

### 2. `routes/<module>.routes.tsx`

The `<Route>` block, exported from a function. Child paths are written ABSOLUTE, so the
tests can see the literals.

```tsx
export function estimatesV2Routes() {
  return (
    <Route element={<ProtectedRoute allowedRoles={[...]} />}>
      <Route element={<V2AppLayout />}>
        <Route element={<RequireFeature feature="estimates" />}>
          <Route path="/estimates" element={<EstimatesPage />} />
        </Route>
      </Route>
    </Route>
  );
}
```

Both files are picked up by `import.meta.glob`. Nothing imports them by name.

## Rules the tests enforce

`__tests__/uiV2.test.ts`:

- a module ships one file without the other (routes with no paths means `hasV2Page`
  denies a page that exists; paths with no routes means the registry describes a page the
  router cannot serve)
- a registered path has no matching `<Route>`
- a path is registered by two modules
- a path is written with a `/v2` prefix, or with a trailing slash
- the glob matches nothing at all

`__tests__/routeUniqueness.test.ts` - **the one to read before adding a path**:

- ANY path is declared twice, anywhere across `App.tsx` and every module file. There is
  no second route table to hide a collision in any more, so two `<Route>`s for one path
  means React Router picks the winner by ranking and one of the two pages becomes
  unreachable at random. This is why the `/v2` prefix could be dropped safely.
- two parameterised patterns overlap, which no declaration order can fix
- more than one file declares a `*` catch-all

`__tests__/guardStacks.test.ts` - every route's guard stack, pinned per path.

`__tests__/settingsTabs.test.ts` - every settings tab is both routed AND in the shell's
nav, since nothing else in the app links to a settings page.

## Guards are copied, not designed

The `ProtectedRoute` roles, the `RequireFeature` key and the route ORDER are the ones the
original route table carried. `/leads/:id/edit` is declared before `/leads/:id` because
otherwise `edit` is captured as an id. Guards decide who may reach a page; this migration
only changed what frames it. Changing a guard is a behaviour change, not a restyle - and
`guardStacks.test.ts` will make you say so out loud.
