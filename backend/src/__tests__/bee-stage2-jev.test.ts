import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { BeeService } from '../services/bee/beeService';
import { JevCallClassifier } from '../services/bee/classifier/jevClassifier';
import { prisma } from '../lib/prisma';
import { ALPHA_ORG_ID } from './helpers';

vi.mock('../services/bee/classifier/jevClassifier', () => {
  return {
    JevCallClassifier: vi.fn(),
  };
});

const mockPrisma = prisma as any;

describe('Bee Stage 2 Jev Outcome Classifier & Cost Accumulator', () => {
  const orgId = ALPHA_ORG_ID;
  const mockCallId = '11111111-2222-3333-4444-555555555555';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('1. Monetary Parsing and Precision Arithmetic', () => {
    it('accurately parses monetary values from various formats', () => {
      expect(BeeService.parseCost('$0.000420')).toBe(0.00042);
      expect(BeeService.parseCost('0.025000')).toBe(0.025);
      expect(BeeService.parseCost('$12.50')).toBe(12.5);
      expect(BeeService.parseCost(0.045)).toBe(0.045);
      expect(BeeService.parseCost(null)).toBe(0);
      expect(BeeService.parseCost(undefined)).toBe(0);
      expect(BeeService.parseCost('')).toBe(0);
      expect(BeeService.parseCost('invalid')).toBe(0);
    });

    it('accumulates costs via micro-dollars without floating point inaccuracies', () => {
      // AddMonetaryValues precision check
      const total = BeeService.addMonetaryValues(0.025, 0.00042);
      expect(total).toBe(0.02542);
      expect(total.toFixed(6)).toBe('0.025420');

      // Vapi $0.025000 + Jev $0.000420 = total $0.025420
      const promptExample = BeeService.addMonetaryValues(
        BeeService.parseCost('0.025000'),
        BeeService.parseCost('$0.000420')
      );
      expect(promptExample.toFixed(6)).toBe('0.025420');
    });

    it('handles zero or missing Jev cost safely', () => {
      const vapiOnly = BeeService.addMonetaryValues(0.035, 0);
      expect(vapiOnly).toBe(0.035);
      expect(vapiOnly.toFixed(6)).toBe('0.035000');
    });
  });

  describe('2. Outcome Merging and Deduplication', () => {
    it('merges Stage 1 and Jev outcomes cleanly (Prompt Example)', () => {
      // Example from prompt:
      // Stage 1 = ANSWERED; Jev = INTERESTED_WARRANTY, CALLBACK_REQUESTED, COMPLAINT;
      // final = ANSWERED, INTERESTED_WARRANTY, CALLBACK_REQUESTED, COMPLAINT
      const stage1 = 'ANSWERED';
      const jevApplicable = ['INTERESTED_WARRANTY', 'CALLBACK_REQUESTED', 'COMPLAINT'];
      const merged = BeeService.mergeStageOutcomes(stage1, jevApplicable);

      expect(merged).toBe('ANSWERED,INTERESTED_WARRANTY,CALLBACK_REQUESTED,COMPLAINT');
    });

    it('preserves Stage 1 primary outcome at index 0 even when Jev has a different primary outcome', () => {
      const stage1 = 'ANSWERED';
      const jevApplicable = ['COMPLAINT', 'HANDOFF_HUMAN'];
      const merged = BeeService.mergeStageOutcomes(stage1, jevApplicable);

      const tokens = merged.split(',');
      expect(tokens[0]).toBe('ANSWERED');
      expect(tokens).toContain('COMPLAINT');
      expect(tokens).toContain('HANDOFF_HUMAN');
    });

    it('deduplicates outcomes across both stages', () => {
      const stage1 = 'ANSWERED,INTERESTED_WARRANTY';
      const jevApplicable = ['INTERESTED_WARRANTY', 'CALLBACK_REQUESTED'];
      const merged = BeeService.mergeStageOutcomes(stage1, jevApplicable);

      expect(merged).toBe('ANSWERED,INTERESTED_WARRANTY,CALLBACK_REQUESTED');
      const warrantyCount = merged.split(',').filter((t) => t === 'INTERESTED_WARRANTY').length;
      expect(warrantyCount).toBe(1);
    });

    it('is strictly idempotent on repeated merges and retries', () => {
      const stage1 = 'ANSWERED,INTERESTED_WARRANTY,CALLBACK_REQUESTED';
      const jevApplicable = ['INTERESTED_WARRANTY', 'CALLBACK_REQUESTED', 'COMPLAINT'];

      const pass1 = BeeService.mergeStageOutcomes(stage1, jevApplicable);
      const pass2 = BeeService.mergeStageOutcomes(pass1, jevApplicable);
      const pass3 = BeeService.mergeStageOutcomes(pass2, jevApplicable);

      expect(pass1).toBe('ANSWERED,INTERESTED_WARRANTY,CALLBACK_REQUESTED,COMPLAINT');
      expect(pass2).toBe(pass1);
      expect(pass3).toBe(pass1);
    });

    it('handles no extra outcomes when Jev applicable outcomes are empty or identical', () => {
      expect(BeeService.mergeStageOutcomes('ANSWERED', [])).toBe('ANSWERED');
      expect(BeeService.mergeStageOutcomes('NO_ANSWER', ['NO_ANSWER'])).toBe('NO_ANSWER');
    });
  });

  describe('3. Stage 2 Classification Persistence & Idempotency', () => {
    it('successfully classifies, accumulates costs, and persists Jev results', async () => {
      const mockCallLog = {
        id: mockCallId,
        organization_id: orgId,
        customer_id: 'cust-1',
        customer_name: 'John Doe',
        customer_phone: '+15551234567',
        outcome: 'ANSWERED',
        transcript: [
          { speaker: 'agent', text: 'Hi John, calling about your warranty.' },
          { speaker: 'customer', text: 'Yes, I want to renew the warranty and also get a quote for a new AC.' },
        ],
        ai_summary: 'Customer wants warranty renewal and new AC quote.',
        vapi_cost: new Prisma.Decimal('0.025000'),
        total_cost: new Prisma.Decimal('0.025000'),
        cost_estimate: new Prisma.Decimal('0.025000'),
        jev_status: 'pending',
      };

      mockPrisma.beeCallLog.findFirst.mockResolvedValueOnce(mockCallLog);
      mockPrisma.beeCallLog.update.mockImplementationOnce((args: any) =>
        Promise.resolve({ ...mockCallLog, ...args.data })
      );

      const mockClassifierInstance = {
        classify: vi.fn().mockResolvedValue({
          primaryOutcome: 'INTERESTED_WARRANTY',
          applicableOutcomes: ['INTERESTED_WARRANTY', 'INTERESTED_NEW_WORK'],
          sentiment: 'POSITIVE',
          confidence: 0.88,
          latencyMs: 350,
          analysisCost: '$0.000420',
        }),
      };
      (JevCallClassifier as any).mockImplementation(function() {
        return mockClassifierInstance;
      });

      const result = await BeeService.classifyCallStageTwo(mockCallId, orgId);

      expect(result).toBeDefined();
      expect(mockClassifierInstance.classify).toHaveBeenCalledTimes(1);
      expect(mockPrisma.beeCallLog.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: mockCallId },
          data: expect.objectContaining({
            outcome: 'ANSWERED,INTERESTED_WARRANTY,INTERESTED_NEW_WORK',
            jev_primary_outcome: 'INTERESTED_WARRANTY',
            jev_applicable_outcomes: ['INTERESTED_WARRANTY', 'INTERESTED_NEW_WORK'],
            jev_sentiment: 'POSITIVE',
            jev_status: 'completed',
            vapi_cost: new Prisma.Decimal('0.025000'),
            jev_cost: new Prisma.Decimal('0.000420'),
            total_cost: new Prisma.Decimal('0.025420'),
            cost_estimate: new Prisma.Decimal('0.025420'),
          }),
        })
      );
    });

    it('does not re-classify or re-accumulate costs on already completed calls without forceRetry', async () => {
      const completedCallLog = {
        id: mockCallId,
        organization_id: orgId,
        outcome: 'ANSWERED,INTERESTED_WARRANTY',
        jev_status: 'completed',
        vapi_cost: new Prisma.Decimal('0.025000'),
        jev_cost: new Prisma.Decimal('0.000420'),
        total_cost: new Prisma.Decimal('0.025420'),
      };

      mockPrisma.beeCallLog.findFirst.mockResolvedValueOnce(completedCallLog);
      const mockClassifierInstance = { classify: vi.fn() };
      (JevCallClassifier as any).mockImplementation(function() {
        return mockClassifierInstance;
      });

      const result = await BeeService.classifyCallStageTwo(mockCallId, orgId);

      expect(result).toEqual(completedCallLog);
      expect(mockClassifierInstance.classify).not.toHaveBeenCalled();
      expect(mockPrisma.beeCallLog.update).not.toHaveBeenCalled();
    });

    it('gracefully handles missing transcript/summary by marking jev_status as skipped', async () => {
      const emptyCall = {
        id: mockCallId,
        organization_id: orgId,
        outcome: 'NO_ANSWER',
        transcript: [],
        ai_summary: '',
        jev_status: 'pending',
      };

      mockPrisma.beeCallLog.findFirst.mockResolvedValueOnce(emptyCall);
      mockPrisma.beeCallLog.update.mockImplementationOnce((args: any) =>
        Promise.resolve({ ...emptyCall, ...args.data })
      );

      const mockClassifierInstance = { classify: vi.fn() };
      (JevCallClassifier as any).mockImplementation(function() {
        return mockClassifierInstance;
      });

      const result = await BeeService.classifyCallStageTwo(mockCallId, orgId);

      expect(mockClassifierInstance.classify).not.toHaveBeenCalled();
      expect(mockPrisma.beeCallLog.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: mockCallId },
          data: expect.objectContaining({
            jev_status: 'skipped',
          }),
        })
      );
    });

    it('preserves historical calls without Jev data and sets Vapi cost as total', async () => {
      const historicalCall = {
        id: mockCallId,
        organization_id: orgId,
        outcome: 'ANSWERED',
        transcript: [{ speaker: 'customer', text: 'Hello, please remove me from your list.' }],
        ai_summary: 'Customer wants DNC.',
        cost_estimate: new Prisma.Decimal('0.015000'),
        vapi_cost: null,
        jev_cost: null,
        total_cost: null,
        jev_status: null,
      };

      mockPrisma.beeCallLog.findFirst.mockResolvedValueOnce(historicalCall);
      mockPrisma.beeCallLog.update.mockImplementationOnce((args: any) =>
        Promise.resolve({ ...historicalCall, ...args.data })
      );

      const mockClassifierInstance = {
        classify: vi.fn().mockResolvedValue({
          primaryOutcome: 'DNC_REQUESTED',
          applicableOutcomes: ['DNC_REQUESTED'],
          sentiment: 'ANGRY_OR_FRUSTRATED',
          confidence: 0.95,
          latencyMs: 250,
          analysisCost: '$0.000300',
        }),
      };
      (JevCallClassifier as any).mockImplementation(function() {
        return mockClassifierInstance;
      });

      const result = await BeeService.classifyCallStageTwo(mockCallId, orgId);

      expect(mockPrisma.beeCallLog.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: mockCallId },
          data: expect.objectContaining({
            outcome: 'ANSWERED,DNC_REQUESTED',
            vapi_cost: new Prisma.Decimal('0.015000'),
            jev_cost: new Prisma.Decimal('0.000300'),
            total_cost: new Prisma.Decimal('0.015300'),
            cost_estimate: new Prisma.Decimal('0.015300'),
            jev_status: 'completed',
          }),
        })
      );
    });
  });

  describe('4. Reliability, Error Handling & Safe Retries', () => {
    it('retains Stage 1 results, marks jev_status as failed, and does NOT throw on Jev failure', async () => {
      const mockCallLog = {
        id: mockCallId,
        organization_id: orgId,
        outcome: 'ANSWERED',
        transcript: [{ speaker: 'agent', text: 'Hello' }],
        ai_summary: 'Call connected',
        cost_estimate: new Prisma.Decimal('0.020000'),
        vapi_cost: new Prisma.Decimal('0.020000'),
        total_cost: new Prisma.Decimal('0.020000'),
        jev_status: 'pending',
      };

      mockPrisma.beeCallLog.findFirst.mockResolvedValueOnce(mockCallLog);
      mockPrisma.beeCallLog.update.mockImplementationOnce((args: any) =>
        Promise.resolve({ ...mockCallLog, ...args.data })
      );

      const mockClassifierInstance = {
        classify: vi.fn().mockRejectedValue(new Error('Connection timeout to TypeSafe API (15000ms)')),
      };
      (JevCallClassifier as any).mockImplementation(function() {
        return mockClassifierInstance;
      });

      // Should not throw!
      const result = await BeeService.classifyCallStageTwo(mockCallId, orgId);

      expect(result).toBeDefined();
      expect(mockPrisma.beeCallLog.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: mockCallId },
          data: expect.objectContaining({
            jev_status: 'failed',
            jev_error: 'Connection timeout to TypeSafe API (15000ms)',
          }),
        })
      );
      // Outcome and costs were NOT erased or altered
      expect(mockCallLog.outcome).toBe('ANSWERED');
    });

    it('permits safe retry after failure with forceRetry: true', async () => {
      const failedCallLog = {
        id: mockCallId,
        organization_id: orgId,
        outcome: 'ANSWERED',
        transcript: [{ speaker: 'agent', text: 'Hello' }, { speaker: 'customer', text: 'Call me back tomorrow.' }],
        ai_summary: 'Callback requested',
        cost_estimate: new Prisma.Decimal('0.020000'),
        vapi_cost: new Prisma.Decimal('0.020000'),
        total_cost: new Prisma.Decimal('0.020000'),
        jev_status: 'failed',
        jev_error: 'Network glitch',
      };

      mockPrisma.beeCallLog.findFirst.mockResolvedValueOnce(failedCallLog);
      mockPrisma.beeCallLog.update.mockImplementationOnce((args: any) =>
        Promise.resolve({ ...failedCallLog, ...args.data })
      );

      const mockClassifierInstance = {
        classify: vi.fn().mockResolvedValue({
          primaryOutcome: 'CALLBACK_REQUESTED',
          applicableOutcomes: ['CALLBACK_REQUESTED'],
          sentiment: 'NEUTRAL',
          confidence: 0.9,
          latencyMs: 310,
          analysisCost: '$0.000350',
        }),
      };
      (JevCallClassifier as any).mockImplementation(function() {
        return mockClassifierInstance;
      });

      const retried = await BeeService.classifyCallStageTwo(mockCallId, orgId, { forceRetry: true });

      expect(retried).toBeDefined();
      expect(mockClassifierInstance.classify).toHaveBeenCalledTimes(1);
      expect(mockPrisma.beeCallLog.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: mockCallId },
          data: expect.objectContaining({
            outcome: 'ANSWERED,CALLBACK_REQUESTED',
            jev_status: 'completed',
            jev_error: null,
            total_cost: new Prisma.Decimal('0.020350'),
          }),
        })
      );
    });
  });
});
