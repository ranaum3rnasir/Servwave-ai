# AI Node Expansion + Auto-Status Rollup

## Context
The tree is currently static after PRD import. Users need to break features down into sub-tasks as they work ("epic → backlog items"). Two features are needed:
1. **AI Node Expansion** — click a node, AI suggests sub-features, user accepts, child nodes appear
2. **Auto-Status Rollup** — when all children are "done", parent auto-marks "done"

Implementation order: Status Rollup first (simpler, no backend), then AI Expansion.

---

## Feature 1: Auto-Status Rollup

When a node's status changes, walk up the tree and recompute each ancestor's status:
- All children `done` → parent becomes `done`
- Any child `error` → parent becomes `error`
- Any child `in_progress` → parent becomes `in_progress`
- Otherwise → `not_started`

Only applies to nodes **that have children**. Leaf nodes are unaffected.

### Files to create
- `webview-ui/src/lib/status-rollup.ts` — pure function `applyStatusRollup(nodes, changedNodeId) → nodes[]`

### Files to modify
- `webview-ui/src/store/treeStore.ts` — call `applyStatusRollup()` inside `updateNode()` and `changeStatus()` after the node change, before saving. Include rollup changes in the same history entry.

---

## Feature 2: AI Node Expansion (with Preview)

User selects a node → clicks "Break Down with AI" → AI generates sub-features → **preview panel** shows suggestions → user can accept all, remove individual items, or cancel → accepted nodes are added to tree.

### Flow
1. User clicks "Break Down with AI" on a selected node
2. Loading overlay: "Generating sub-features..."
3. Backend returns suggested children
4. **Preview modal** appears showing the proposed child nodes (label + description)
   - Each suggestion has a checkbox (all checked by default)
   - User can uncheck ones they don't want
   - "Accept" button adds the checked nodes to the tree
   - "Cancel" button discards all suggestions
5. Accepted nodes appear under the parent, tree re-layouts

### New message types
In both `src/types/messages.ts` and `webview-ui/src/types.ts`:
```
WebviewMessage:
  | { type: 'node:expand'; payload: { nodeId: string; provider: LLMProvider } }
  | { type: 'node:acceptExpansion'; payload: { parentId: string; accepted: TreeNode[] } }

ExtensionMessage:
  | { type: 'node:expandPreview'; payload: { parentId: string; suggestions: TreeNode[] } }
```

### Backend

**Create `treext-backend/lib/node-expander.ts`**
- Reuses `callLLM()` from `treext-backend/lib/llm.ts`
- Prompt: "Given this feature and PRD context, break it into 3-5 sub-features"
- Input: node label, description, prdExcerpt, full PRD markdown
- Output: array of child node objects (same shape as prd-parser output)

**Create `treext-backend/api/projects/[id]/nodes/[nodeId]/expand.ts`**
- POST endpoint, `withAuth`
- Fetches node from DB + project's `prd_markdown` for context
- Calls `expandNode()`
- Maps LLM string IDs → UUIDs (reuse pattern from `parse-prd.ts`)
- Does NOT save to DB yet (preview only) — returns suggestions
- DB insert happens when user accepts (via the existing `tree:save` debounce)

**Add route to `treext-backend/dev-server.ts`**
- `POST /api/projects/:id/nodes/:nodeId/expand`

### Extension host
**Modify `src/TreextPanel.ts`**
- Add `case 'node:expand'` — calls backend, returns `node:expandPreview` with suggestions
- No `case 'node:acceptExpansion'` needed — accepted nodes are added to store client-side, saved via existing `tree:save` debounce

### Frontend

**Modify `webview-ui/src/store/treeStore.ts`**
- Add `expanding: boolean` state (like `importing`)
- Add `pendingSuggestions: { parentId: string; suggestions: TreeNode[] } | null`
- Add `setExpanding(v)`, `setPendingSuggestions(...)`, `clearSuggestions()`
- Add `acceptExpansion(parentId, acceptedNodes[])` — bulk inserts nodes, pushes history, triggers save

**Create `webview-ui/src/components/ExpansionPreview.tsx`**
- Modal/overlay showing suggested nodes with checkboxes
- Each row: checkbox + label + description (editable)
- "Accept Selected" and "Cancel" buttons
- On accept: calls `acceptExpansion()` with checked nodes

**Modify `webview-ui/src/components/NodeEditor.tsx`**
- Add "Break Down with AI" button below "Add Child"
- Sends `node:expand` message via vscodeApi
- Button shows loading state while `expanding` is true

**Modify `webview-ui/src/App.tsx`**
- Handle `node:expandPreview` → sets `pendingSuggestions` in store, clears expanding
- Render `<ExpansionPreview />` when `pendingSuggestions` is not null

---

## Files Summary

| Action | File |
|--------|------|
| Create | `webview-ui/src/lib/status-rollup.ts` |
| Create | `treext-backend/lib/node-expander.ts` |
| Create | `treext-backend/api/projects/[id]/nodes/[nodeId]/expand.ts` |
| Create | `webview-ui/src/components/ExpansionPreview.tsx` |
| Modify | `webview-ui/src/store/treeStore.ts` (rollup + expanding + suggestions + acceptExpansion) |
| Modify | `webview-ui/src/components/NodeEditor.tsx` (Break Down button) |
| Modify | `webview-ui/src/App.tsx` (expandPreview handler + preview rendering) |
| Modify | `src/types/messages.ts` (new message types) |
| Modify | `webview-ui/src/types.ts` (new message types) |
| Modify | `src/TreextPanel.ts` (node:expand handler) |
| Modify | `treext-backend/dev-server.ts` (new route) |

## Verification
1. **Status rollup:** Change all children of a parent to "done" → parent auto-becomes "done". Change one child back → parent reverts. Undo works.
2. **AI expansion:** Select a node → click "Break Down with AI" → loading overlay → preview modal shows suggestions → uncheck one → accept → only checked nodes appear in tree. Cancel discards all. Undo removes accepted children.
3. `npm run build:all` passes with no errors.
