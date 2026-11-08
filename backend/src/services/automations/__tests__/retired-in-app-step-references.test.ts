/**
 * The inventory guard for the retired in-app step (ADR 0005).
 *
 * Spec A slice 7 asks a human to run a repo-wide grep for the retired step-type
 * name and check that every surviving hit is either on a short allowlist or
 * explained by a comment. A grep a person is asked to run once is a grep nobody
 * runs again, and the failure mode is silent: a new file starts naming the
 * retired step, or an old explanation goes stale, and the ADR quietly becomes a
 * document that contradicts the code. That is the exact drift this slice exists
 * to end, so the grep is executed here instead of described.
 *
 * Three things are pinned:
 *  1. WHICH non-test source files may name the retired step, with the reason.
 *  2. That each of them explains itself in prose a grepper can read.
 *  3. That the Automation Center has exactly ONE door into the bell - the Test
 *     dialog's receipt - which is what makes "a workflow RUN cannot notify
 *     in-app" true, in the ADR, in the scenarios reference and in VERB_RULES.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ACTIONS } from '../catalog';
import { retiredInAppStepMessage } from '../workflowValidation';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const RETIRED_STEP = 'NOTIFY_TEAM';

/** Non-test source files that may name the retired step, and why each one may. */
const ALLOWED_SOURCE_REFERENCES: Record<string, string> = {
  // The narrowing itself. Storage is permanently wider than the authoring
  // surface, so the authorable type is written as an Exclude of this label.
  'backend/src/services/automations/workflowValidation.ts':
    'defines AuthorableStepType by excluding the retired label',
  'frontend/src/lib/api/workflows.ts':
    'mirrors the storage union and excludes the retired label from the authorable one',

  // The legacy-rule migrator. It reads rows written before the retirement.
  'backend/src/services/automations/migrateRules.ts':
    'maps a legacy AutomationRule action onto its historic step label',

  // The run path, which now skips the step instead of dispatching it.
  'backend/src/services/automations/enrollment.ts':
    'skips a published-but-retired step and records the admin-facing copy',

  // The Test dialog, the third surface an admin meets the retired step on.
  'backend/src/controllers/workflow.controller.ts':
    'gives the retired step the same explanation as publish and the config drawer',

  // The served catalogue, which no longer carries the retired action at all. It
  // names the label only to Exclude it, the same shape as the step-type narrowing.
  'backend/src/services/automations/catalog.ts':
    'defines AuthorableActionType by excluding the retired label',

  // The bell verb the Test receipt still uses.
  'backend/src/services/notifications/templates.ts':
    'records that the retired step is no longer what emits automation.message',

  // The rendering maps, one pair per frontend tree. A past run still shows a
  // label and an icon rather than a bare enum name.
  'frontend/src/components/workflows/WorkflowActivity.tsx':
    'renders a stored step type in the Activity tab',
  'frontend/src/components/workflows/workflow-visuals.tsx':
    'renders a stored step type as a label and icon',
  'frontend/src/pages/v2/automations/components/workflowActivity.tsx':
    'renders a stored step type in the Activity tab',
  'frontend/src/pages/v2/automations/components/workflowVisuals.tsx':
    'renders a stored step type as a label and icon',

  // Two more surfaces that describe a STORED step rather than offering one.
  'frontend/src/components/workflows/StepConfigDrawer.tsx':
    'shows the retired-step notice instead of a config form',
  'frontend/src/pages/v2/automations/components/stepConfigDrawer.tsx':
    'shows the retired-step notice instead of a config form',
  'frontend/src/lib/workflows/describeWorkflow.ts':
    'describes a stored step in the recipe sentence',
};

/** Prisma files that may name it: the schema and the two frozen migrations. */
const ALLOWED_PRISMA_REFERENCES = [
  'backend/prisma/schema.prisma',
  'backend/prisma/migrations/20260703164043_automation_center/migration.sql',
  'backend/prisma/migrations/20260710120000_workflow_builder_tables/migration.sql',
  'backend/prisma/migrations/20260710130000_workflow_backfill_rules/migration.sql',
];

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, exts, out);
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

function isTestFile(rel: string): boolean {
  return rel.includes('__tests__') || /\.(test|spec)\.tsx?$/.test(rel);
}

function sourceFilesNaming(token: string): string[] {
  const roots = [path.join(REPO_ROOT, 'backend', 'src'), path.join(REPO_ROOT, 'frontend', 'src')];
  const hits: string[] = [];
  for (const root of roots) {
    for (const file of walk(root, ['.ts', '.tsx'])) {
      const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
      if (isTestFile(rel)) continue;
      if (fs.readFileSync(file, 'utf8').includes(token)) hits.push(rel);
    }
  }
  return hits.sort();
}

describe('the retired in-app step leaves no unexplained references', () => {
  it('is named only by the source files on the allowlist', () => {
    expect(sourceFilesNaming(RETIRED_STEP)).toEqual(Object.keys(ALLOWED_SOURCE_REFERENCES).sort());
  });

  it('explains itself in every file that still names it', () => {
    // "Explained by a comment" made checkable: a reader who greps the label
    // lands in a file that also says the word, so they are one search from the
    // reason rather than left to infer it from a switch case.
    const unexplained = sourceFilesNaming(RETIRED_STEP).filter(
      (rel) => !/retire/i.test(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')),
    );
    expect(unexplained).toEqual([]);
  });

  it('survives in Prisma only as the schema label and the frozen migrations', () => {
    const prismaHits = walk(path.join(REPO_ROOT, 'backend', 'prisma'), ['.prisma', '.sql'])
      .filter((f) => fs.readFileSync(f, 'utf8').includes(RETIRED_STEP))
      .map((f) => path.relative(REPO_ROOT, f).replace(/\\/g, '/'))
      .sort();
    expect(prismaHits).toEqual([...ALLOWED_PRISMA_REFERENCES].sort());
  });
});

describe('the Automation Center has one door into the bell', () => {
  it('emits automation.message from exactly one call site, the Test dialog', () => {
    const emitters = walk(path.join(REPO_ROOT, 'backend', 'src'), ['.ts'])
      .filter((f) => !isTestFile(path.relative(REPO_ROOT, f).replace(/\\/g, '/')))
      .filter((f) => /verb:\s*'automation\.message'/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(REPO_ROOT, f).replace(/\\/g, '/'));

    // One door, not two. The ADR, the scenarios reference and the VERB_RULES
    // exception string all tell the reader this; a second emit site would make
    // all three wrong at once, and the sentence "a run cannot notify in-app"
    // false, without failing any other test in the suite.
    expect(emitters).toEqual(['backend/src/controllers/workflow.controller.ts']);
  });

  it('classifies that one door in the singular', () => {
    const templates = fs.readFileSync(
      path.join(REPO_ROOT, 'backend/src/services/notifications/templates.ts'),
      'utf8',
    );
    const rule = templates.slice(templates.indexOf("'automation.message': {", templates.indexOf('VERB_RULES')));
    const exception = rule.slice(0, rule.indexOf('\n  },'));
    // The engine's emit site is gone, so wording that hedges over several paths
    // ("every path that emits this", "whichever of them fires") now describes a
    // set of one and reads as a contradiction of the reference's "one path, not
    // two". The vocabulary has to match across all three documents.
    expect(exception).not.toMatch(/every path|whichever of them|paths that emit/i);
    expect(exception).toMatch(/sole|only|one/i);
  });
});

const ADR = 'docs/adr/0005-the-bell-is-hardcoded-the-automation-center-owns-email-and-text.md';
const REFERENCE = 'md_files/specs/notifications/notification-scenarios-reference.md';
const VERB_RULES = 'backend/src/services/notifications/templates.ts';
const GLOSSARY = 'CONTEXT.md';

const hasDocs = fs.existsSync(path.join(REPO_ROOT, ADR)) && fs.existsSync(path.join(REPO_ROOT, REFERENCE)) && fs.existsSync(path.join(REPO_ROOT, GLOSSARY));
const suite = hasDocs ? describe : describe.skip;

suite('one vocabulary across the three places a reader can arrive from', () => {
  const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

  it('names the same two axes and the same three families everywhere', () => {
    // CONTEXT.md is the glossary; the other three are where a reader actually
    // lands. If any of them invents a synonym - "notification type", "reminder
    // family", "channel class" - the vocabulary stops being load-bearing and
    // becomes decoration, which is the failure this slice exists to prevent.
    for (const rel of [ADR, REFERENCE, VERB_RULES, GLOSSARY]) {
      const text = read(rel);
      for (const word of ['family', 'timing', 'involvement', 'duty', 'self', 'event', 'time']) {
        expect(text.toLowerCase(), `${rel} is missing the word "${word}"`).toContain(word);
      }
    }
  });

  it('tells one story about how many Automation Center doors reach the bell', () => {
    // Each of the three must send the reader to the same call site, and none of
    // them may claim the Automation Center never writes to the bell. The line
    // number is READ from the controller rather than written here: hardcoding it
    // meant any edit above the emit made three documents wrong and this test
    // right, which is backwards.
    const emitLine =
      read('backend/src/controllers/workflow.controller.ts')
        .split('\n')
        .findIndex((line) => line.includes("verb: 'automation.message'")) + 1;
    expect(emitLine, 'the one door has moved out of the controller entirely').toBeGreaterThan(0);
    const citation = new RegExp(`workflow\\.controller\\.ts:${emitLine}\\b`);

    for (const rel of [ADR, REFERENCE, VERB_RULES]) {
      const text = read(rel);
      expect(text, `${rel} does not name the one door's call site at line ${emitLine}`).toMatch(
        citation,
      );
      expect(text, `${rel} denies a write that really happens`).not.toMatch(
        /never writes to the bell\.|no path from the Automation Center/i,
      );
    }
    // And the count itself is stated, not left to be inferred.
    expect(read(ADR)).toMatch(/exactly one such door/i);
    expect(read(REFERENCE)).toMatch(/one door/i);
  });
});

describe('the served action catalogue', () => {
  // This used to assert that the retired action's admin-facing COPY no longer
  // claimed to deliver anything, which was the best available check while the
  // record was still keyed by the Prisma enum. It is not the check the ADR
  // actually wants: the catalogue is the builder's menu, and an entry on a menu
  // is an offer however carefully the description is worded. Now that ACTIONS is
  // keyed by the authorable union, the stronger claim is checkable directly.
  it('offers only the two channels the Automation Center owns', () => {
    expect(Object.keys(ACTIONS).sort()).toEqual(['SEND_EMAIL', 'SEND_SMS']);
    expect(ACTIONS).not.toHaveProperty(RETIRED_STEP);
  });
});

describe('the retired step says the same thing wherever an admin meets it', () => {
  // Two routes to one message: an admin who opens the step reads the drawer
  // notice, and an admin who hits Publish reads the validation issue. They are
  // written in two packages and can drift without any suite noticing, so the
  // vocabulary is pinned rather than trusted.
  const drawerCopy = fs.readFileSync(
    path.join(REPO_ROOT, 'frontend/src/lib/workflows/retiredStep.ts'),
    'utf8',
  );

  it('sends the admin to the bell and asks for the step to be removed, in both packages', () => {
    const publishCopy = retiredInAppStepMessage(0);
    for (const [where, copy] of [['the publish rejection', publishCopy], ['the drawer notice', drawerCopy]] as const) {
      expect(copy, `${where} does not say where the notifications went`).toMatch(/come from the bell/i);
      expect(copy, `${where} does not say what to do about it`).toMatch(/remove/i);
      expect(copy, `${where} does not say the step is inert`).toMatch(/no longer sends/i);
    }
  });

  it('names the offending step so the admin knows which one to delete', () => {
    expect(retiredInAppStepMessage(0)).toContain('Step 1');
    expect(retiredInAppStepMessage(4)).toContain('Step 5');
  });
});
