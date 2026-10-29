/**
 * Mobile slice 47: the staff layout loads its heavy, rarely used parts on demand.
 *
 * `V2AppLayout` is in the first script every staff page downloads. Anything it imports statically
 * rides along, so the Create New menu used to carry both create dialogs with it, and through the
 * task dialog's file attachments the chunked upload client, and through the date field the date
 * picker. They are now `import()`ed, and this holds the line by walking the layout's static graph.
 */
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { importChain, relativeToSrc, staticImportGraph } from './staticImportGraph';

const SRC = resolve(__dirname, '..');
const graph = staticImportGraph(join(SRC, 'pages/v2/V2AppLayout.tsx'));
const files = [...graph.files].map(relativeToSrc);

describe('the staff layout does not statically import what Create New opens', () => {
  it('walks the real layout: the create menu is in, so the check has teeth', () => {
    expect(files).toContain('pages/v2/V2AppLayout.tsx');
    expect(files).toContain('pages/v2/SidebarCreateMenu.tsx');
    expect(files.length).toBeGreaterThan(40);
  });

  it.each([
    'pages/v2/estimates/components/newEstimateDialog.tsx',
    'pages/v2/tasks/components/createTaskDialog.tsx',
    'lib/attachments/resumableTransport.ts',
    'lib/attachments/uploadAttachment.ts',
    // The date FIELD is small and stays (the phone widget has two); the CALENDAR is the weight.
    'ui-kit/components/ui/calendar.tsx',
  ])('%s is a lazy chunk, not part of the layout', (file) => {
    const hit = [...graph.files].find((f) => relativeToSrc(f) === file);
    expect(hit ? importChain(graph, hit).join(' -> ') : null).toBeNull();
  });

  it.each(['tus-js-client', 'react-day-picker'])('the %s package is not in the layout\'s static graph', (pkg) => {
    expect(graph.packages.has(pkg)).toBe(false);
  });
});
