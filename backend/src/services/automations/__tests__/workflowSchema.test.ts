import { describe, it, expect } from 'vitest';
import {
  Prisma,
  WorkflowStatus,
  WorkflowStepType,
  WorkflowEnrollmentStatus,
  WorkflowStepRunStatus,
} from '@prisma/client';
import { AUTHORABLE_STEP_TYPES } from '../workflowValidation';

// Pins the shape of the workflow-builder schema (Workflow, WorkflowStep,
// WorkflowVersion, WorkflowEnrollment, WorkflowStepRun + their enums). No
// engine code here — this only guards against silent drift between
// schema.prisma and the hand-authored migration that creates these tables.

describe('workflow builder schema — enums', () => {
  it('WorkflowStatus is exactly DRAFT + PUBLISHED', () => {
    expect(new Set(Object.values(WorkflowStatus))).toEqual(new Set(['DRAFT', 'PUBLISHED']));
  });

  it('WorkflowStepType is exactly the five step kinds', () => {
    expect(new Set(Object.values(WorkflowStepType))).toEqual(
      new Set(['WAIT', 'SEND_TEXT', 'SEND_EMAIL', 'NOTIFY_TEAM', 'STOP_IF']),
    );
  });

  // The counterpart guard to the assertion above, and the reason that one can
  // stay green: NOTIFY_TEAM keeps its Postgres label so historic step runs and
  // frozen version JSON still resolve, while nothing may author one any more.
  // Widening the authorable union back is caught here; re-adding the retired
  // label to it is caught by tsc, because the list is typed as the enum minus
  // that label.
  it('the authorable step types are exactly wait, text, email and stop-if', () => {
    expect(new Set(AUTHORABLE_STEP_TYPES)).toEqual(
      new Set(['WAIT', 'SEND_TEXT', 'SEND_EMAIL', 'STOP_IF']),
    );
  });

  // Stated as a relationship as well as a list, so a SIXTH storage label added
  // later cannot land as an unauthorable orphan without someone deciding.
  it('the authorable step types are the storage enum minus the retired in-app step', () => {
    expect(new Set(AUTHORABLE_STEP_TYPES)).toEqual(
      new Set(Object.values(WorkflowStepType).filter((t) => t !== 'NOTIFY_TEAM')),
    );
  });

  it('WorkflowEnrollmentStatus is exactly the four enrollment states', () => {
    expect(new Set(Object.values(WorkflowEnrollmentStatus))).toEqual(
      new Set(['ACTIVE', 'COMPLETED', 'STOPPED', 'FAILED']),
    );
  });

  it('WorkflowStepRunStatus is exactly the five step-run outcomes', () => {
    expect(new Set(Object.values(WorkflowStepRunStatus))).toEqual(
      new Set(['SENT', 'SKIPPED', 'FAILED', 'STOPPED', 'CONTINUED']),
    );
  });
});

describe('workflow builder schema — models', () => {
  it('registers all five workflow builder models on Prisma.ModelName', () => {
    expect(Prisma.ModelName.Workflow).toBe('Workflow');
    expect(Prisma.ModelName.WorkflowStep).toBe('WorkflowStep');
    expect(Prisma.ModelName.WorkflowVersion).toBe('WorkflowVersion');
    expect(Prisma.ModelName.WorkflowEnrollment).toBe('WorkflowEnrollment');
    expect(Prisma.ModelName.WorkflowStepRun).toBe('WorkflowStepRun');
  });
});
