# Plan: Fix Collapsed Sidebar — Icons, Logo, Toggle Placement

## Context
Three issues with the collapsed sidebar:
1. Nav icons invisible — padding doesn't center them in the 64px collapsed width
2. Logo not centered when collapsed
3. Toggle button should be inline with the username, with a more intuitive icon

## File
`frontend/src/components/layout/Sidebar.tsx`

## Fix 1: Center nav icons when collapsed
The nav container has `px-3` and each NavLink has `px-4`. In a `w-16` (64px) sidebar, the icon (20px) with these paddings gets left-aligned. When collapsed, center-align the link by replacing `px-4` with `justify-center px-0` so the 20px icon sits in the center of the 64px width.

Change the NavLink className (line 70):
- When collapsed: `justify-center px-0` (center the icon)
- When expanded: `gap-3 px-4` (current behavior)

Also remove `hover:translate-x-1.5` when collapsed (it shifts the icon sideways).

## Fix 2: Center logo when collapsed
Line 29: Change `px-5` to `px-5` when expanded, `justify-center px-0` when collapsed. Simplest: use `cn('flex h-header items-center gap-2.5', collapsed ? 'justify-center' : 'px-5')`.

## Fix 3: Move toggle inline with footer + better icon
Replace `ChevronsLeft` with `PanelLeftClose` (lucide) — it's a sidebar-specific icon, universally understood as "collapse sidebar panel". When collapsed, rotate it or use `PanelLeftOpen`.

Merge the toggle button into the footer section:
- **Expanded:** Show user name + role on the left, toggle button on the right, in a single row
- **Collapsed:** Show just the toggle button centered (no user info)

```tsx
{/* Footer */}
<Separator />
<div className={cn('flex items-center', collapsed ? 'justify-center p-3' : 'justify-between p-4')}>
  {!collapsed && user && (
    <div className="min-w-0">
      <p className="truncate text-sm font-medium">{user.first_name} {user.last_name}</p>
      <p className="text-xs text-text-secondary">{user.role}</p>
    </div>
  )}
  {onToggle && (
    <button onClick={onToggle} className="...">
      <PanelLeftClose /> or <PanelLeftOpen />
    </button>
  )}
</div>
```

## Verification
- `npx tsc --noEmit`
- Visual: collapsed sidebar shows centered logo, centered nav icons, toggle at bottom
- Visual: expanded sidebar shows user info + toggle button in footer row
