#!/usr/bin/env node
/**
 * Prints what test selection (#3257) would do for the checkout in the current folder, and runs no tests.
 * The same decision `npm run test:ci` makes when the selection variable is `shadow` or `on`.
 *
 *   TEST_SELECTION=shadow GITHUB_EVENT_NAME=pull_request GITHUB_BASE_REF=staging PR_HEAD_SHA=<head> node scripts/test-select.mjs [--files]
 *
 * Exit code is always 0: a selector never makes anything red.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectForRun } from './test-select-io.mjs';
import { selectionPhrase } from './test-select-lib.mjs';

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const d = await selectForRun({ frontend });
console.log(`test-select: ${selectionPhrase(d)}${d.detail ? ` (${d.detail})` : ''}`);
if (process.argv.includes('--files')) for (const f of d.files) console.log(f);
