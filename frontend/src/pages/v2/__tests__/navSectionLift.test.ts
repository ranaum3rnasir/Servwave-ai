import { describe, expect, it } from 'vitest';
import { Boxes } from 'lucide-react';

import {
  DEFAULT_LAYOUT_KEYS, getDestination, type NavDestination,
} from '@/components/layout/nav-registry';

import { buildNavSections } from '../buildNavSections';
import { NAV_SECTIONS } from '../navSections';

/**
 * The v2 sidebar renders a nav group (Inventory, Communication) as a
 * disclosure: the parent row toggles, and its children hang off it. Those
 * children have to carry the parent's entitlement, and once they did not:
 * `NavChild` has no `feature` of its own, so every child read as unlocked
 * whatever the org owned. On a Starter org it put six clickable rows in the
 * sidebar - Purchase Orders, Vendors, WhatsApp, Email, Text -
 * underneath two greyed-out locked parents. The route gate still held, so each
 * bounced to /upgrade on click, but the sidebar was advertising modules the org
 * does not own, and nav-registry.ts records the same defect being fixed once
 * already for the Price Book row.
 *
 * The children used to be LIFTED to flat siblings here, because the kit's nav
 * had no disclosure control; they are nested under the parent now that it does.
 * The rule these tests pin is unchanged and is the one that broke twice - a
 * locked parent produces no children, and an unlocked one hands each child its
 * gating - so they still assert it, over `item.children` rather than over the
 * flat list.
 *
 * These run against the REAL registry and the REAL section map, so the Starter
 * case below is the exact scenario from the bug report rather than a
 * re-statement of it in fixtures. Only the two org-shaped inputs are injected:
 * what the user may do (`can`) and what the org owns (`isLocked`).
 */

/** Every role can see everything, unless a test narrows it. */
const canAll = () => true;

/**
 * A Starter org: no inventory, no phone, and not a demo org. It DOES hold
 * `email` - that entitlement is `minPlan: 'STARTER'`, and the catalog is
 * explicit that `phone` (Pro+) can never be its gate.
 *
 * `feature` became `string | string[]` when Communication was re-declared as
 * `['phone','email']`, so the entitlement test is OR over the keys, matching
 * `hasNavFeature`. Written out here rather than imported so the fixture stays
 * the org-shaped input this file injects.
 */
const STARTER_LOCKED = new Set(['inventory', 'phone']);
const starterFeatureLock = (dest: NavDestination) => {
  if (dest.feature === undefined) return false;
  const keys = Array.isArray(dest.feature) ? dest.feature : [dest.feature];
  if (keys.length === 0) return false;
  return !keys.some((key) => !STARTER_LOCKED.has(key));
};
const starterLock = (dest: NavDestination) => starterFeatureLock(dest) || !!dest.demoOnly;

const nothingLocked = () => false;

/** Every row the sidebar can put on screen: parents and their children. */
function rowsFor(sections: ReturnType<typeof buildNavSections>) {
  return sections.flatMap((s) => s.items.flatMap((item) => [item, ...(item.children ?? [])]));
}

function build(overrides: Partial<Parameters<typeof buildNavSections>[0]> = {}) {
  return buildNavSections({
    keys: DEFAULT_LAYOUT_KEYS,
    sections: NAV_SECTIONS,
    getDestination,
    can: canAll,
    isLocked: nothingLocked,
    isFeatureLocked: nothingLocked,
    ...overrides,
  });
}

/** The Starter case, wired the way the sidebar wires it. */
const starterBuild = () =>
  build({ isLocked: starterLock, isFeatureLocked: starterFeatureLock });

describe('a locked nav group has no children to expand', () => {
  it('keeps the entitlement-locked rows out of a Starter sidebar', () => {
    const labels = rowsFor(starterBuild()).map((r) => r.dest.label);

    // The rows the defect leaked. Named individually rather than counted, so a
    // partial regression cannot pass on an arithmetic accident.
    //
    // "Email" is NOT in this list any more, and that is the point: `email` is
    // `minPlan: 'STARTER'` and the entitlement catalog is explicit that `phone`
    // (Pro+) can never be its gate, so a Starter org holds it. Communication was
    // re-declared `feature: ['phone','email']` (OR), which unlocks the group for
    // that org - and its phone-gated children must still be dropped, which is
    // what the rest of this list pins.
    for (const leaked of ['Purchase Orders', 'Vendors', 'WhatsApp', 'Text']) {
      expect(labels, `"${leaked}" is not entitled and must not render`)
        .not.toContain(leaked);
    }
  });

  it('renders the email row a Starter org IS entitled to', () => {
    // The mirror of the case above. Dropping every child of a partially
    // entitled group would hide a module the org actually bought.
    const labels = rowsFor(starterBuild()).map((r) => r.dest.label);
    expect(labels).toContain('Email');
  });

  it('still renders the parent itself, as one row', () => {
    // The group does not vanish - the legacy sidebar shows a locked one greyed
    // with a plan badge, which is how a Starter org learns the module exists.
    const rows = rowsFor(starterBuild());

    expect(rows.filter((r) => r.dest.key === 'inventory')).toHaveLength(1);
    expect(rows.filter((r) => r.dest.key === 'communication')).toHaveLength(1);
  });

  it('exposes no child of a fully locked group under any section', () => {
    const inventory = getDestination('inventory')!;
    const inventoryChildKeys = new Set((inventory.children ?? []).map((c) => c.key));

    const exposed = rowsFor(starterBuild())
      .map((r) => r.key)
      .filter((key) => inventoryChildKeys.has(key));

    expect(exposed, 'child rows reachable under a locked group').toEqual([]);

    // And the locked parent is a plain row, not an expandable one - a
    // disclosure that opens onto nothing is worse than no disclosure.
    const parents = rowsFor(starterBuild());
    expect(parents.find((r) => r.key === 'inventory')?.children).toBeUndefined();
  });

  it('drops only the unentitled children of a partially entitled group', () => {
    const communication = rowsFor(starterBuild()).find((r) => r.key === 'communication');
    // Entitled on `email`, so the group opens - but only onto what it owns.
    expect(communication?.children?.map((c) => c.key)).toEqual(['comm-email']);
  });
});

describe('an unlocked nav group nests children that carry its gating', () => {
  it("gives every child the parent's feature", () => {
    const inventory = getDestination('inventory')!;
    const rows = rowsFor(build());

    // Price Book is deduped against the top-level `pricebook` row, so match on
    // key rather than asserting the full child list.
    const nested = rows.filter((r) => r.key.startsWith('inv-'));
    expect(nested.length, 'inventory children nested under the group').toBeGreaterThan(0);

    for (const row of nested) {
      expect(row.dest.feature, `${row.dest.label} must inherit the group's entitlement`)
        .toBe(inventory.feature);
    }
  });

  it('locks those children once the parent is locked - the two rules agree', () => {
    // The inherited `feature` is only worth carrying if the lock function then
    // sees it. Building with an unlocked parent and re-running the lock proves
    // the row would grey rather than render live, which is what the sidebar
    // does with the value.
    const nested = rowsFor(build()).filter((r) => r.key.startsWith('inv-'));

    for (const row of nested) {
      expect(starterLock(row.dest), `${row.dest.label} must lock on a Starter org`).toBe(true);
    }
  });

  it("carries comingSoon down, and lets the child's own value win", () => {
    const comms = rowsFor(build()).filter((r) => r.key.startsWith('comm-'));
    const byKey = new Map(comms.map((r) => [r.key, r.dest]));

    // WhatsApp and Email are flagged on the child; Phone and Text are not, and
    // the parent does not flag them either.
    expect(byKey.get('comm-whatsapp')?.comingSoon).toBe(true);
    expect(byKey.get('comm-email')?.comingSoon).toBe(true);
    expect(byKey.get('comm-text')?.comingSoon).toBe(false);
  });

  it("falls back to the parent's comingSoon when the child declares none", () => {
    // No registry group is shaped this way today, so this is the one synthetic
    // case: the fallback is a real branch and would otherwise be untested.
    const parent: NavDestination = {
      key: 'group', label: 'Group', icon: Boxes, href: '/group',
      action: 'read', subject: 'Inventory', home: 'Page', comingSoon: true,
      children: [
        { key: 'child', label: 'Child', icon: Boxes, href: '/group/child', action: 'read', subject: 'Inventory' },
      ],
    };

    const rows = rowsFor(buildNavSections({
      keys: ['group'],
      sections: [{ section: 'Only', keys: ['group'] }],
      getDestination: (key) => (key === 'group' ? parent : undefined),
      can: canAll,
      isLocked: nothingLocked,
    }));

    expect(rows.find((r) => r.key === 'child')?.dest.comingSoon).toBe(true);
  });

  it('still drops a child the user has no ability for', () => {
    // Nesting a row must not nest its permission with it. Deny Communication
    // and the group's four children go, while Inventory's stay.
    const rows = rowsFor(build({
      can: (_action, subject) => subject !== 'Communication',
    }));

    expect(rows.filter((r) => r.key.startsWith('comm-'))).toEqual([]);
    expect(rows.filter((r) => r.key.startsWith('inv-')).length).toBeGreaterThan(0);
  });

  it('renders one row per destination when a child repeats a top-level entry', () => {
    // Price Book is both its own registry entry and an Inventory child.
    // Counted over the rows that NAVIGATE: a group's parent is a toggle, and
    // its own page is reached through the child that carries the same href
    // (Inventory -> Stock), which is the one duplication that has to stay.
    const hrefs = rowsFor(build()).filter((r) => !r.children).map((r) => r.dest.href);
    const duplicated = hrefs.filter((href, i) => hrefs.indexOf(href) !== i);

    expect([...new Set(duplicated)], 'destinations rendered twice in the sidebar').toEqual([]);
    expect(
      rowsFor(build()).filter((r) => r.key === 'inv-pricebook'),
      'Price Book is already pinned as its own row',
    ).toEqual([]);
  });

  it('keeps the child that carries the group\'s own href', () => {
    // The parent no longer navigates, so dropping Stock as a duplicate of
    // Inventory would make /inventory unreachable from the sidebar.
    const inventory = rowsFor(build()).find((r) => r.key === 'inventory');
    const stock = inventory?.children?.find((c) => c.key === 'inv-stock');

    expect(stock?.dest.href).toBe(inventory?.dest.href);
  });

  it('nests the children rather than listing them as siblings', () => {
    const sections = build();
    const topLevel = sections.flatMap((s) => s.items);

    const inventory = topLevel.find((r) => r.key === 'inventory');
    expect(inventory?.children?.map((c) => c.dest.label))
      .toEqual(['Stock', 'Purchase Orders', 'Vendors']);

    // None of them is a row of the section in its own right - that is what the
    // sidebar's disclosure depends on.
    expect(topLevel.filter((r) => r.key.startsWith('inv-'))).toEqual([]);
    expect(topLevel.filter((r) => r.key.startsWith('comm-'))).toEqual([]);
  });

  it('leaves a leaf destination with no children at all', () => {
    // `children` is the sidebar's test for "render a disclosure", so a plain
    // row must not carry an empty array.
    const rows = build().flatMap((s) => s.items);

    expect(rows.find((r) => r.key === 'leads')?.children).toBeUndefined();
    expect(rows.find((r) => r.key === 'jobs')?.children).toBeUndefined();
  });

  it('drops the disclosure when no child survives the ability check', () => {
    // A group whose children are all denied is a plain row, not an expandable
    // one that opens onto nothing. Inventory's children and its parent share a
    // subject, so this needs a fixture where they differ.
    const parent: NavDestination = {
      key: 'group', label: 'Group', icon: Boxes, href: '/group',
      action: 'read', subject: 'Inventory', home: 'Page',
      children: [
        { key: 'child', label: 'Child', icon: Boxes, href: '/group/child', action: 'read', subject: 'Report' },
      ],
    };

    const rows = buildNavSections({
      keys: ['group'],
      sections: [{ section: 'Only', keys: ['group'] }],
      getDestination: (key) => (key === 'group' ? parent : undefined),
      can: (_action, subject) => subject !== 'Report',
      isLocked: nothingLocked,
    }).flatMap((s) => s.items);

    expect(rows.map((r) => r.key)).toEqual(['group']);
    expect(rows.find((r) => r.key === 'group')?.children).toBeUndefined();
  });
});
