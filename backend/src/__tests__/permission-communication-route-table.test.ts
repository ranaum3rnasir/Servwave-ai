/* =============================================================================
   Roles & Permissions, PRD 8, slice S08.27 - the Communication route-level table is complete.

   Pure: no database. The table's rows (permission-communication-route-rows.ts) are run against a real database by
   permission-communication-route-table-db.test.ts; this file proves the rows are all the routes there are.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { scanRouteGates, communicationRouteGates, isCommunicationGated } from './permission-communication-routes-scan';
import { COMMUNICATION_ROUTE_ROWS } from './permission-communication-route-rows';

const keyOf = (r: { method: string; path: string }) => `${r.method.toUpperCase()} ${r.path}`;

describe('every Communication route has its rows in the table', () => {
  const gates = communicationRouteGates();

  it('finds the routes (guards against a scan that reads nothing and so passes)', () => {
    expect(gates.length).toBeGreaterThan(80);
    expect(gates.map(keyOf)).toEqual(expect.arrayContaining([
      'GET /api/communication/calls', 'GET /api/communication/calls/:id/recording', 'POST /api/communication/phone-access',
      'PATCH /api/communication/sms/:id/job', 'GET /api/jobs/:id/communications', 'GET /api/customers/:id/communications',
    ]));
  });

  it('has a row for every route a Communication switch gates', () => {
    const rowed = new Set(COMMUNICATION_ROUTE_ROWS.map(keyOf));
    expect(gates.map(keyOf).filter((k) => !rowed.has(k))).toEqual([]);
  });

  it('has no row for a route that does not exist', () => {
    const real = new Set(gates.map(keyOf));
    expect(COMMUNICATION_ROUTE_ROWS.map(keyOf).filter((k) => !real.has(k))).toEqual([]);
  });

  it('lists in each row exactly the switches the route\'s guards ask for, so the off row isolates each one', () => {
    const byKey = new Map(gates.map((g) => [keyOf(g), g.switches.slice().sort()] as const));
    const wrong = COMMUNICATION_ROUTE_ROWS
      .filter((r) => byKey.has(keyOf(r)))
      .filter((r) => JSON.stringify(r.needs.slice().sort()) !== JSON.stringify(byKey.get(keyOf(r))))
      .map((r) => `${keyOf(r)}: row ${r.needs.join(',')} / route ${byKey.get(keyOf(r))!.join(',')}`);
    expect(wrong).toEqual([]);
  });

  it('carries every Communication switch that has a server check on at least one row, or says where it is proven instead', () => {
    // Checks that leave a field out of an answer rather than refuse a route are proven by the shape rows of the database table.
    const shapeProven = new Set(['see_call_insights', 'edit_others_logged_communications']);
    const inRows = new Set(COMMUNICATION_ROUTE_ROWS.flatMap((r) => r.needs));
    const missing = SWITCH_CATALOG
      .filter((s) => s.module === 'Communication' && s.serverChecks.length > 0)
      .map((s) => s.key)
      .filter((k) => !inRows.has(k) && !shapeProven.has(k));
    expect(missing).toEqual([]);
  });

  describe('the scan itself', () => {
    it('reads the switches a planted route asks for, and leaves a route no Communication switch gates out of the table', () => {
      const text = [
        `router.get('/probe', canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), canDo('call_flows_tab', 'Communication'), h);`,
        `router.post('/buy', canDo('update', 'Organization'), h);`,
      ].join('\n');
      const planted = scanRouteGates(text, '/api/communication');
      expect(planted[0]).toMatchObject({ method: 'get', path: '/api/communication/probe', switches: ['view_communication', 'access_communication', 'call_flows_tab'] });
      expect(planted.filter(isCommunicationGated).map(keyOf)).toEqual(['GET /api/communication/probe']);
    });
  });
});

describe('no row of the table builds a person from a built-in role name', () => {
  const FILES = [
    'permission-communication-route-rows.ts',
    'permission-communication-routes-scan.ts',
    'permission-communication-route-table.test.ts',
    'permission-communication-route-table-db.test.ts',
  ];
  // A quoted built-in name: a person built "as" Admin, Sales, Dispatcher or Technician.
  const quoted = /['"`](ADMIN|SALES|DISPATCHER|TECHNICIAN)['"`]/;
  const namedIn = (text: string) => text.split('\n').map((line, i) => ({ line: i + 1, text: line })).filter((l) => quoted.test(l.text) && !l.text.includes('planted:'));

  it('names no built-in role in any file of the table', () => {
    const hits = FILES.flatMap((f) => namedIn(readFileSync(join(__dirname, f), 'utf8')).map((l) => `${f}:${l.line} ${l.text.trim()}`));
    expect(hits).toEqual([]);
  });

  it('would fail on a planted name', () => {
    const planted = ['DISP', 'ATCHER'].join('');
    expect(namedIn(`const who = await addUser(org, 'p', '${planted}');`)).toHaveLength(1);
  });
});
