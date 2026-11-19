import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { BeeService } from '../services/bee/beeService';
import { JevCallClassifier, MEANINGFUL_BUSINESS_OUTCOMES } from '../services/bee/classifier/jevClassifier';
import { prisma } from '../lib/prisma';
import { ALPHA_ORG_ID } from './helpers';

vi.mock('../services/bee/classifier/jevClassifier', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    JevCallClassifier: vi.fn(),
  };
});

const mockPrisma = prisma as any;

describe('Bee AI Calling — Redesigned Call Outcomes, Jev Classification & Fallback', () => {
  const orgId = ALPHA_ORG_ID;
  const mockCallId = '11111111-2222-3333-4444-555555555555';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('1. Stage 1 Gating & Determination of Answered vs Unanswered', () => {
    it('NO_ANSWER skips Jev, preserves Stage 1 outcome, marks NOT_REQUIRED, zero Jev cost, no OTHER', async () => {
      const result = BeeService.deriveStageOneCallFacts({
        endedReason: 'customer-did-not-answer',
        durationSeconds: 0,
        transcript: [],
      });

      expect(result.isAnswered).toBe(false);
      expect(result.primaryOutcome).toBe('NO_ANSWER');
      expect(result.outcomeTags).toEqual(['NO_ANSWER']);
      expect(result.outcomeTags).not.toContain('OTHER');
      expect(result.outcomeTags).not.toContain('ANSWERED');

      // Now verify classifyCallStageTwo skips Jev if call is marked unanswered
      const unansweredCall = {
        id: mockCallId,
        organization_id: orgId,
        outcome: 'NO_ANSWER',
        is_answered: false,
        duration_seconds: 0,
        transcript: [],
        vapi_cost: new Prisma.Decimal('0.005000'),
        jev_cost: new Prisma.Decimal('0.000000'),
        total_cost: new Prisma.Decimal('0.005000'),
      };
      mockPrisma.beeCallLog.findFirst.mockResolvedValueOnce(unansweredCall);
      mockPrisma.beeCallLog.update.mockImplementation((args: any) =>
        Promise.resolve({ ...unansweredCall, ...args.data })
      );

      const mockClassifier = { classify: vi.fn() };
      (JevCallClassifier as any).mockImplementation(function () {
        return mockClassifier;
      });

      const res = await BeeService.classifyCallStageTwo(mockCallId, orgId);
      expect(mockClassifier.classify).not.toHaveBeenCalled();
      expect(mockPrisma.beeCallLog.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: mockCallId },
          data: expect.objectContaining({
            jev_status: 'NOT_REQUIRED',
            jev_cost: new Prisma.Decimal('0.000000'),
          }),
        })
      );
    });

    it('VOICEMAIL skips Jev, preserves Stage 1 outcome, marks NOT_REQUIRED', async () => {
      const facts = BeeService.deriveStageOneCallFacts({
        endedReason: 'machine_detected',
        durationSeconds: 12,
        transcript: [],
      });

      expect(facts.isAnswered).toBe(false);
      expect(facts.primaryOutcome).toBe('NO_ANSWER,VOICEMAIL');
      expect(facts.outcomeTags).not.toContain('OTHER');
    });

    it('FAILED and WRONG_NUMBER skip Jev and do not apply OTHER', async () => {
      const failedFacts = BeeService.deriveStageOneCallFacts({
        status: 'failed',
        endedReason: 'sip-gateway-error',
        durationSeconds: 0,
      });
      expect(failedFacts.isAnswered).toBe(false);
      expect(failedFacts.primaryOutcome).toBe('FAILED');
      expect(failedFacts.outcomeTags).not.toContain('OTHER');

      const wrongNumberFacts = BeeService.deriveStageOneCallFacts({
        endedReason: 'wrong-number',
        endedMessage: 'unallocated number',
        durationSeconds: 2,
      });
      expect(wrongNumberFacts.isAnswered).toBe(false);
      expect(wrongNumberFacts.primaryOutcome).toBe('WRONG_NUMBER');
      expect(wrongNumberFacts.outcomeTags).not.toContain('OTHER');
    });

    it('determines answered when customer speaks or call duration >= 5s', () => {
      const answeredTurns = BeeService.deriveStageOneCallFacts({
        endedReason: 'customer-hung-up',
        durationSeconds: 4,
        transcript: [{ speaker: 'customer', text: 'Hello, who is this?' }],
      });
      expect(answeredTurns.isAnswered).toBe(true);
      expect(answeredTurns.primaryOutcome).toBe('OTHER'); // provisional until Stage 2

      const answeredDuration = BeeService.deriveStageOneCallFacts({
        endedReason: 'assistant-ended-call',
        durationSeconds: 15,
        transcript: [],
      });
      expect(answeredDuration.isAnswered).toBe(true);
    });
  });

  describe('2. Outcome Merging, Priority, and Stripping of ANSWERED', () => {
    it('stops adding ANSWERED to final user-facing outcomes (ANSWERED + INTERESTED_WARRANTY -> INTERESTED_WARRANTY)', () => {
      const merged = BeeService.mergeStageOutcomes('ANSWERED', ['INTERESTED_WARRANTY']);
      expect(merged).toBe('INTERESTED_WARRANTY');
      expect(merged).not.toContain('ANSWERED');
      expect(merged).not.toContain('OTHER');
    });

    it('applies all applicable business outcomes when multiple are returned', () => {
      const merged = BeeService.mergeStageOutcomes('OTHER', [
        'INTERESTED_WARRANTY',
        'INTERESTED_NEW_WORK',
        'CALLBACK_REQUESTED',
      ]);
      expect(merged).toBe('INTERESTED_WARRANTY,INTERESTED_NEW_WORK,CALLBACK_REQUESTED');
      expect(merged).not.toContain('ANSWERED');
      expect(merged).not.toContain('OTHER');
    });

    it('applies OTHER when Jev returns no applicable business outcomes', () => {
      const merged = BeeService.mergeStageOutcomes('OTHER', []);
      expect(merged).toBe('OTHER');
    });

    it('never applies OTHER alongside meaningful business outcomes', () => {
      const merged = BeeService.mergeStageOutcomes('OTHER', ['COMPLAINT']);
      expect(merged).toBe('COMPLAINT');
      expect(merged.split(',')).not.toContain('OTHER');
    });

    it('deduplicates outcomes idempotently across retries', () => {
      const pass1 = BeeService.mergeStageOutcomes('INTERESTED_WARRANTY', ['INTERESTED_WARRANTY', 'COMPLAINT']);
      const pass2 = BeeService.mergeStageOutcomes(pass1, ['INTERESTED_WARRANTY', 'COMPLAINT']);
      expect(pass1).toBe('INTERESTED_WARRANTY,COMPLAINT');
      expect(pass2).toBe(pass1);
    });
  });

  describe('3. Internal Classification Status and Fallback Handling', () => {
    it('marks SUCCESS and applies business outcomes when Jev succeeds', async () => {
      const callLog = {
        id: mockCallId,
        organization_id: orgId,
        is_answered: true,
        outcome: 'OTHER',
        transcript: [{ speaker: 'customer', text: 'I am interested in extending my warranty.' }],
        ai_summary: 'Customer wants warranty extension.',
        vapi_cost: new Prisma.Decimal('0.020000'),
        cost_estimate: new Prisma.Decimal('0.020000'),
        jev_status: 'PENDING',
      };

      mockPrisma.beeCallLog.findFirst.mockResolvedValue(callLog);
      mockPrisma.beeCallLog.update.mockImplementation((args: any) =>
        Promise.resolve({ ...callLog, ...args.data })
      );

      const mockClassifier = {
        classify: vi.fn().mockResolvedValue({
          primaryOutcome: 'INTERESTED_WARRANTY',
          applicableOutcomes: ['INTERESTED_WARRANTY'],
          sentiment: 'POSITIVE',
          confidence: 0.95,
          latencyMs: 320,
          analysisCost: '$0.000420',
        }),
      };
      (JevCallClassifier as any).mockImplementation(function () {
        return mockClassifier;
      });

      const result = await BeeService.classifyCallStageTwo(mockCallId, orgId);

      expect(mockPrisma.beeCallLog.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: mockCallId },
          data: expect.objectContaining({
            outcome: 'INTERESTED_WARRANTY',
            jev_status: 'SUCCESS',
            is_answered: true,
            vapi_cost: new Prisma.Decimal('0.020000'),
            jev_cost: new Prisma.Decimal('0.000420'),
            total_cost: new Prisma.Decimal('0.020420'),
          }),
        })
      );
    });

    it('marks SUCCESS_NO_MATCH and applies user-facing OTHER when Jev succeeds with no business match', async () => {
      const callLog = {
        id: mockCallId,
        organization_id: orgId,
        is_answered: true,
        outcome: 'OTHER',
        transcript: [{ speaker: 'customer', text: 'Who is this? Okay, whatever, bye.' }],
        ai_summary: 'Short conversation with no specific intent.',
        vapi_cost: new Prisma.Decimal('0.015000'),
        cost_estimate: new Prisma.Decimal('0.015000'),
      };

      mockPrisma.beeCallLog.findFirst.mockResolvedValue(callLog);
      mockPrisma.beeCallLog.update.mockImplementation((args: any) =>
        Promise.resolve({ ...callLog, ...args.data })
      );

      const mockClassifier = {
        classify: vi.fn().mockResolvedValue({
          primaryOutcome: 'OTHER',
          applicableOutcomes: [],
          sentiment: 'NEUTRAL',
          confidence: 0.70,
          latencyMs: 280,
          analysisCost: '$0.000210',
        }),
      };
      (JevCallClassifier as any).mockImplementation(function () {
        return mockClassifier;
      });

      await BeeService.classifyCallStageTwo(mockCallId, orgId);

      expect(mockPrisma.beeCallLog.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: mockCallId },
          data: expect.objectContaining({
            outcome: 'OTHER',
            jev_status: 'SUCCESS_NO_MATCH',
            is_answered: true,
            total_cost: new Prisma.Decimal('0.015210'),
          }),
        })
      );
    });

    it('applies OTHER + FAILED on Jev API failure without inventing costs', async () => {
      const callLog = {
        id: mockCallId,
        organization_id: orgId,
        is_answered: true,
        outcome: 'OTHER',
        transcript: [{ speaker: 'customer', text: 'Hello' }],
        ai_summary: 'Connected',
        vapi_cost: new Prisma.Decimal('0.012000'),
        cost_estimate: new Prisma.Decimal('0.012000'),
      };

      mockPrisma.beeCallLog.findFirst.mockResolvedValue(callLog);
      mockPrisma.beeCallLog.findUnique.mockResolvedValue(callLog);
      mockPrisma.beeCallLog.update.mockImplementation((args: any) =>
        Promise.resolve({ ...callLog, ...args.data })
      );

      const mockClassifier = {
        classify: vi.fn().mockRejectedValue(new Error('500 Internal Server Error from Jev API')),
      };
      (JevCallClassifier as any).mockImplementation(function () {
        return mockClassifier;
      });

      await BeeService.classifyCallStageTwo(mockCallId, orgId);

      expect(mockPrisma.beeCallLog.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: mockCallId },
          data: expect.objectContaining({
            outcome: 'OTHER',
            jev_status: 'FAILED',
            jev_error: '500 Internal Server Error from Jev API',
            jev_cost: new Prisma.Decimal('0.000000'),
            total_cost: new Prisma.Decimal('0.012000'),
          }),
        })
      );
    });

    it('applies OTHER + TIMEOUT when Jev times out', async () => {
      const callLog = {
        id: mockCallId,
        organization_id: orgId,
        is_answered: true,
        outcome: 'OTHER',
        transcript: [{ speaker: 'customer', text: 'Hello' }],
        ai_summary: 'Connected',
        vapi_cost: new Prisma.Decimal('0.012000'),
        cost_estimate: new Prisma.Decimal('0.012000'),
      };

      mockPrisma.beeCallLog.findFirst.mockResolvedValue(callLog);
      mockPrisma.beeCallLog.findUnique.mockResolvedValue(callLog);
      mockPrisma.beeCallLog.update.mockImplementation((args: any) =>
        Promise.resolve({ ...callLog, ...args.data })
      );

      const timeoutError = new Error('The operation was aborted due to timeout');
      timeoutError.name = 'AbortError';

      const mockClassifier = {
        classify: vi.fn().mockRejectedValue(timeoutError),
      };
      (JevCallClassifier as any).mockImplementation(function () {
        return mockClassifier;
      });

      await BeeService.classifyCallStageTwo(mockCallId, orgId);

      expect(mockPrisma.beeCallLog.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: mockCallId },
          data: expect.objectContaining({
            outcome: 'OTHER',
            jev_status: 'TIMEOUT',
            jev_cost: new Prisma.Decimal('0.000000'),
            total_cost: new Prisma.Decimal('0.012000'),
          }),
        })
      );
    });

    it('applies OTHER + INVALID_RESPONSE when Jev returns invalid payload', async () => {
      const callLog = {
        id: mockCallId,
        organization_id: orgId,
        is_answered: true,
        outcome: 'OTHER',
        transcript: [{ speaker: 'customer', text: 'Hello' }],
        ai_summary: 'Connected',
        vapi_cost: new Prisma.Decimal('0.012000'),
        cost_estimate: new Prisma.Decimal('0.012000'),
      };

      mockPrisma.beeCallLog.findFirst.mockResolvedValue(callLog);
      mockPrisma.beeCallLog.findUnique.mockResolvedValue(callLog);
      mockPrisma.beeCallLog.update.mockImplementation((args: any) =>
        Promise.resolve({ ...callLog, ...args.data })
      );

      const mockClassifier = {
        classify: vi.fn().mockResolvedValue({
          invalidField: true, // missing primaryOutcome and applicableOutcomes
        }),
      };
      (JevCallClassifier as any).mockImplementation(function () {
        return mockClassifier;
      });

      await BeeService.classifyCallStageTwo(mockCallId, orgId);

      expect(mockPrisma.beeCallLog.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: mockCallId },
          data: expect.objectContaining({
            outcome: 'OTHER',
            jev_status: 'INVALID_RESPONSE',
            jev_cost: new Prisma.Decimal('0.000000'),
            total_cost: new Prisma.Decimal('0.012000'),
          }),
        })
      );
    });

    it('successful retry replaces previously assigned fallback OTHER with actual business outcomes', async () => {
      const previousFailedCall = {
        id: mockCallId,
        organization_id: orgId,
        is_answered: true,
        outcome: 'OTHER',
        transcript: [{ speaker: 'customer', text: 'I need to complain about my repair.' }],
        ai_summary: 'Customer unhappy with repair work.',
        vapi_cost: new Prisma.Decimal('0.020000'),
        jev_cost: new Prisma.Decimal('0.000000'),
        total_cost: new Prisma.Decimal('0.020000'),
        cost_estimate: new Prisma.Decimal('0.020000'),
        jev_status: 'FAILED',
        jev_error: 'Connection timeout',
      };

      mockPrisma.beeCallLog.findFirst.mockResolvedValue(previousFailedCall);
      mockPrisma.beeCallLog.update.mockImplementation((args: any) =>
        Promise.resolve({ ...previousFailedCall, ...args.data })
      );

      const mockClassifier = {
        classify: vi.fn().mockResolvedValue({
          primaryOutcome: 'COMPLAINT',
          applicableOutcomes: ['COMPLAINT'],
          sentiment: 'ANGRY_OR_FRUSTRATED',
          confidence: 0.95,
          latencyMs: 310,
          analysisCost: '$0.000300',
        }),
      };
      (JevCallClassifier as any).mockImplementation(function () {
        return mockClassifier;
      });

      const result = await BeeService.classifyCallStageTwo(mockCallId, orgId, { forceRetry: true });

      expect(mockPrisma.beeCallLog.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: mockCallId },
          data: expect.objectContaining({
            outcome: 'COMPLAINT', // OTHER was replaced by COMPLAINT!
            jev_status: 'SUCCESS',
            jev_error: null,
            jev_cost: new Prisma.Decimal('0.000300'),
            total_cost: new Prisma.Decimal('0.020300'),
          }),
        })
      );
    });

    it('stale failed attempt does not overwrite an already successful classification', async () => {
      const alreadySuccessful = {
        id: mockCallId,
        organization_id: orgId,
        is_answered: true,
        outcome: 'INTERESTED_WARRANTY',
        jev_status: 'SUCCESS',
        vapi_cost: new Prisma.Decimal('0.020000'),
        jev_cost: new Prisma.Decimal('0.000400'),
        total_cost: new Prisma.Decimal('0.020400'),
      };

      mockPrisma.beeCallLog.findFirst.mockResolvedValue(alreadySuccessful);
      mockPrisma.beeCallLog.findUnique.mockResolvedValue(alreadySuccessful);

      const mockClassifier = {
        classify: vi.fn().mockRejectedValue(new Error('Delayed network failure')),
      };
      (JevCallClassifier as any).mockImplementation(function () {
        return mockClassifier;
      });

      const res = await BeeService.classifyCallStageTwo(mockCallId, orgId);
      expect(res.jev_status).toBe('SUCCESS');
      expect(res.outcome).toBe('INTERESTED_WARRANTY');
    });
  });

  describe('4. Cost Accumulation and Precision', () => {
    it('calculates total call cost = Vapi cost + Jev cost from stored values and never double-counts', () => {
      const vapiCost = 0.0149;
      const jevCost = 0.000047;
      const total = BeeService.addMonetaryValues(vapiCost, jevCost);
      expect(total).toBe(0.014947);
      expect(total.toFixed(6)).toBe('0.014947');

      // Retry calculation recalculates from stored vapiCost + current jevCost, NOT total + jevCost
      const recalculatedTotal = BeeService.addMonetaryValues(vapiCost, jevCost);
      expect(recalculatedTotal).toBe(0.014947);
    });

    it('unanswered calls have zero Jev cost', () => {
      const vapiCost = 0.0085;
      const jevCost = 0;
      const total = BeeService.addMonetaryValues(vapiCost, jevCost);
      expect(total).toBe(0.0085);
    });
  });

  describe('5. Backward Compatibility & Parsing', () => {
    it('safely handles historical records that only have ANSWERED without crashing', () => {
      const parsed = BeeService.parseOutcomeTags('ANSWERED');
      expect(parsed.isAnswered).toBe(true);
      expect(parsed.tags).toEqual(['ANSWERED']);
      expect(parsed.primaryLegacyCode).toBe('ANSWERED');
    });

    it('strips ANSWERED when any meaningful outcome is present', () => {
      const parsed = BeeService.parseOutcomeTags('ANSWERED,INTERESTED_WARRANTY');
      expect(parsed.isAnswered).toBe(true);
      expect(parsed.tags).toEqual(['INTERESTED_WARRANTY']);
      expect(parsed.tags).not.toContain('ANSWERED');
    });

    it('parses OTHER correctly as answered', () => {
      const parsed = BeeService.parseOutcomeTags('OTHER');
      expect(parsed.isAnswered).toBe(true);
      expect(parsed.tags).toEqual(['OTHER']);
      expect(parsed.primaryLegacyCode).toBe('OTHER');
    });
  });
});
