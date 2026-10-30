/**
 * Roles & Permissions S09.13 - one spelling of the Schedule's "No crew" address on both sides.
 *
 * The server sends the address the dashboard's Missing crew tile and Needs Attention item open
 * (`backend/src/lib/dashboard/clickTargets.ts`); the Schedule page reads the filter back from the same address
 * (`lib/scheduleFilter.ts`). If the two ever spell it differently, the link opens an ordinary Schedule that
 * shows every visit. This reads the server's spelling out of its source and holds it to the page's.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { SCHEDULE_NO_CREW_PATH } from '@/lib/scheduleFilter';

const SERVER = readFileSync(resolve(__dirname, '../../../backend/src/lib/dashboard/clickTargets.ts'), 'utf8');

describe('the Schedule "No crew" address', () => {
  it('is spelled the same by the server that sends it and the page that reads it', () => {
    const path = /^\s*schedule: \{ path: '([^']+)'/m.exec(SERVER)?.[1];
    const query = /NO_CREW_SCHEDULE_QUERY = '([^']+)'/.exec(SERVER)?.[1];
    expect(path).toBeDefined();
    expect(query).toBeDefined();
    expect(`${path}${query}`).toBe(SCHEDULE_NO_CREW_PATH);
  });
});
