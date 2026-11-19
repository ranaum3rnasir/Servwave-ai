/**
 * Jev AI Call Transcript & Summary Outcome Classifier
 *
 * Direct integration with TypeSafe AI's "System One" decision model (Jev).
 * Evaluates unstructured call transcripts and summaries directly against
 * typed schema questions (choice and noul primitives).
 *
 * Output:
 *  - Primary Outcome
 *  - All Applicable Outcomes
 *  - Customer Sentiment
 *  - Confidence
 *  - Latency (ms)
 *  - Analysis Cost ($ calculated from exact token usage)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// Automatically load .env file if present in working directory or backend root
function loadEnvFile() {
  try {
    const candidatePaths = [
      path.resolve(process.cwd(), '.env'),
      path.resolve(process.cwd(), 'backend/.env'),
      path.resolve(__dirname, '../../../../.env'),
      path.resolve(__dirname, '../../../../../.env')
    ];

    for (const envPath of candidatePaths) {
      if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf-8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx !== -1) {
            const key = trimmed.slice(0, eqIdx).trim();
            let val = trimmed.slice(eqIdx + 1).trim();
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
              val = val.slice(1, -1);
            }
            if (!process.env[key]) {
              process.env[key] = val;
            }
          }
        }
      }
    }
  } catch {
    // Ignore if unable to read .env
  }
}
loadEnvFile();

export type CallOutcome =
  | 'INTERESTED_WARRANTY'
  | 'INTERESTED_NEW_WORK'
  | 'CALLBACK_REQUESTED'
  | 'HANDOFF_HUMAN'
  | 'COMPLAINT'
  | 'NOT_INTERESTED'
  | 'ALREADY_COVERED'
  | 'DNC_REQUESTED'
  | 'WRONG_NUMBER'
  | 'OTHER'
  | 'NO_ANSWER'
  | 'NEEDS_REVIEW';

export const MEANINGFUL_BUSINESS_OUTCOMES: ReadonlySet<CallOutcome> = new Set([
  'INTERESTED_WARRANTY',
  'INTERESTED_NEW_WORK',
  'CALLBACK_REQUESTED',
  'HANDOFF_HUMAN',
  'COMPLAINT',
  'NOT_INTERESTED',
  'ALREADY_COVERED',
  'DNC_REQUESTED',
  'WRONG_NUMBER',
]);

export type JevClassificationStatus =
  | 'NOT_REQUIRED'
  | 'PENDING'
  | 'SUCCESS'
  | 'SUCCESS_NO_MATCH'
  | 'FAILED'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE';

export type SentimentOutcome = 'POSITIVE' | 'NEUTRAL' | 'HESITANT' | 'ANGRY_OR_FRUSTRATED';

export interface TranscriptTurn {
  speaker: 'agent' | 'customer' | string;
  time?: string;
  text: string;
}

export function formatTranscriptToText(turns: TranscriptTurn[]): string {
  return turns
    .map((t) => {
      const timePart = t.time ? ` [${t.time}]` : '';
      return `${t.speaker.toUpperCase()}${timePart}: ${t.text}`;
    })
    .join('\n');
}

export type ClassifierInput =
  | string
  | TranscriptTurn[]
  | {
      transcript?: string | TranscriptTurn[];
      summary?: string;
      notes?: string;
      callId?: string;
      tenantId?: string;
    };

export interface JevOutcomeClassification {
  /** The dominant business outcome */
  primaryOutcome: CallOutcome;
  /** All applicable outcomes detected for this call (concurrent multi-outcomes) */
  applicableOutcomes: CallOutcome[];
  /** Overall customer tone */
  sentiment: SentimentOutcome;
  /** Classification confidence score (0.0 to 1.0) */
  confidence: number;
  /** Round-trip inference latency in milliseconds */
  latencyMs: number;
  /** Exact analysis cost in dollars ($) calculated per token */
  analysisCost: string;
}

/**
 * Question Schema defined for Jev System One engine.
 * Jev evaluates all questions in parallel over the transcript in a single forward pass.
 */
export const JEV_CALL_OUTCOME_QUESTIONS = {
  primary_outcome: {
    type: 'choice',
    instructions: 'Classify the primary business outcome and customer intent of this phone conversation.',
    criteria: {
      INTERESTED_WARRANTY: 'Customer expresses interest in purchasing, renewing, or learning pricing for an extended warranty, equipment protection plan, or annual maintenance agreement.',
      INTERESTED_NEW_WORK: 'Customer wants a quote, estimate, or technician visit for new replacement equipment, installation, or separate service repair job.',
      CALLBACK_REQUESTED: 'Customer is temporarily busy, in a meeting, driving, or explicitly asks to be called back at another time or day.',
      HANDOFF_HUMAN: 'Customer has technical, dispute, or complex questions that require immediate escalation to a human representative, manager, or supervisor.',
      COMPLAINT: 'Customer is angry, dissatisfied, reports damage, water leak, poor service quality, or threatens legal/managerial action.',
      NOT_INTERESTED: 'Customer politely or firmly declines the offer or service without requesting to be placed on a formal DNC list.',
      ALREADY_COVERED: 'Customer states their equipment is already covered under another warranty or contract with a different provider.',
      DNC_REQUESTED: 'Customer explicitly demands to be removed from the calling list, unsubscribed, or never called again (Do Not Call).',
      WRONG_NUMBER: 'Recipient states the agent reached the wrong person, wrong house, or has had the phone number for years and does not know the customer.',
      NO_ANSWER: 'Call reached automated voicemail, answering machine beep, or disconnected before meaningful conversation began.'
    }
  },
  // Multi-outcome parallel indicator questions (noul boolean probabilities):
  is_complaint: {
    type: 'noul',
    instructions: 'Did the customer express dissatisfaction, file a complaint, report damage, leak, poor service, or threaten legal action?'
  },
  needs_human_escalation: {
    type: 'noul',
    instructions: 'Does this conversation require urgent escalation to a human supervisor, manager, or senior specialist?'
  },
  dnc_demanded: {
    type: 'noul',
    instructions: 'Did the customer explicitly instruct the business to stop calling, delete their number, or put them on a Do Not Call (DNC) list?'
  },
  is_warranty_interest: {
    type: 'noul',
    instructions: 'Did the customer express interest in an extended warranty, protection plan, maintenance agreement, or ask for plan pricing/details?'
  },
  is_new_work_estimate: {
    type: 'noul',
    instructions: 'Did the customer ask for a quote, estimate, or technician visit for new installation or equipment replacement?'
  },
  is_callback_requested: {
    type: 'noul',
    instructions: 'Did the customer request to be called back at another specific time or day?'
  },
  is_already_covered: {
    type: 'noul',
    instructions: 'Did the customer state their equipment is already covered under another warranty or contract with a different provider?'
  },
  is_not_interested: {
    type: 'noul',
    instructions: 'Did the customer decline the offer or state they are not interested at this time?'
  },
  is_wrong_number: {
    type: 'noul',
    instructions: 'Did the person state the agent reached the wrong number or wrong contact?'
  },
  customer_sentiment: {
    type: 'choice',
    instructions: 'Assess the overall customer tone and emotional sentiment during the conversation.',
    criteria: {
      POSITIVE: 'Friendly, satisfied, appreciative, agreeable, or eager to proceed.',
      NEUTRAL: 'Matter-of-fact, polite, businesslike, without strong emotion.',
      HESITANT: 'Uncertain, skeptical about price, asking many cautious questions.',
      ANGRY_OR_FRUSTRATED: 'Upset, raising voice, accusatory, threatening, or hostile.'
    }
  }
};

export class JevCallClassifier {
  private apiKey: string;
  private apiEndpoint: string;
  private model: string;

  constructor(options?: {
    apiKey?: string;
    apiEndpoint?: string;
    model?: string;
  }) {
    loadEnvFile();
    const key = options?.apiKey || process.env.TYPESAFE_API_KEY;
    if (!key || key.trim().length === 0) {
      throw new Error(
        'Missing TYPESAFE_API_KEY. Please provide it in options or set it in your .env file.'
      );
    }

    this.apiKey = key.trim();
    this.apiEndpoint = options?.apiEndpoint || process.env.TYPESAFE_API_ENDPOINT || 'https://api.typesafe.ai/v1/systemone';
    this.model = options?.model || process.env.TYPESAFE_MODEL || 'jev-latest';
  }

  /**
   * Universal classifier accepting raw transcript string, summary text, or structured input.
   */
  async classify(input: ClassifierInput): Promise<JevOutcomeClassification> {
    let text = '';
    if (typeof input === 'string') {
      text = input;
    } else if (Array.isArray(input)) {
      text = formatTranscriptToText(input);
    } else {
      const transcriptStr = Array.isArray(input.transcript)
        ? formatTranscriptToText(input.transcript)
        : input.transcript;

      text = [
        input.summary ? `Call Summary: ${input.summary}` : '',
        transcriptStr ? `Call Transcript:\n${transcriptStr}` : '',
        input.notes ? `Agent Notes: ${input.notes}` : ''
      ].filter(Boolean).join('\n\n');
    }

    return this.classifyText(text);
  }

  /**
   * Classify a raw call transcript string (backward compatibility)
   */
  async classifyTranscript(transcriptText: string): Promise<JevOutcomeClassification> {
    return this.classifyText(transcriptText);
  }

  /**
   * Direct classification execution against the TypeSafe Jev API
   */
  private async classifyText(inputText: string): Promise<JevOutcomeClassification> {
    const startTime = Date.now();

    const payload = {
      model: this.model,
      state: inputText,
      questions: JEV_CALL_OUTCOME_QUESTIONS
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout

    let res: Response;
    try {
      res = await fetch(this.apiEndpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Jev API error (HTTP ${res.status}): ${errText}`);
    }

    const data = (await res.json()) as any;
    const answers = data.answers || {};

    const primaryAnswer = answers.primary_outcome;
    const sentimentAnswer = answers.customer_sentiment;

    const primaryChoice = (primaryAnswer?.choice || primaryAnswer?.selected || 'NEEDS_REVIEW') as CallOutcome;
    const choiceProbabilities: Record<string, number> = primaryAnswer?.probabilities || {
      [primaryChoice]: primaryAnswer?.confidence ?? 0.95
    };

    // Extract multi-outcome indicators from Jev's parallel noul questions
    const applicableOutcomes: CallOutcome[] = [];
    const outcomeProbabilities: Record<string, number> = { ...choiceProbabilities };

    const checkIndicator = (questionKey: string, outcome: CallOutcome, threshold = 0.40) => {
      const ans = answers[questionKey];
      const prob = ans?.noul ?? ans?.probability ?? (ans?.value ? 0.95 : 0.05);
      outcomeProbabilities[outcome] = prob;
      if (prob >= threshold && !applicableOutcomes.includes(outcome)) {
        applicableOutcomes.push(outcome);
      }
    };

    checkIndicator('is_complaint', 'COMPLAINT', 0.50);
    checkIndicator('needs_human_escalation', 'HANDOFF_HUMAN');
    checkIndicator('dnc_demanded', 'DNC_REQUESTED', 0.45);
    checkIndicator('is_warranty_interest', 'INTERESTED_WARRANTY');
    checkIndicator('is_new_work_estimate', 'INTERESTED_NEW_WORK');
    checkIndicator('is_callback_requested', 'CALLBACK_REQUESTED');
    checkIndicator('is_already_covered', 'ALREADY_COVERED');
    checkIndicator('is_not_interested', 'NOT_INTERESTED');
    checkIndicator('is_wrong_number', 'WRONG_NUMBER');

    // Also include primary choice from choice question
    if (primaryChoice !== 'NEEDS_REVIEW' && !applicableOutcomes.includes(primaryChoice)) {
      applicableOutcomes.unshift(primaryChoice);
    }

    if (applicableOutcomes.length === 0) {
      applicableOutcomes.push(primaryChoice);
    }

    // Priority ranking for primary outcome selection
    const priorityOrder: CallOutcome[] = [
      'DNC_REQUESTED',
      'COMPLAINT',
      'HANDOFF_HUMAN',
      'INTERESTED_NEW_WORK',
      'INTERESTED_WARRANTY',
      'CALLBACK_REQUESTED',
      'ALREADY_COVERED',
      'NOT_INTERESTED',
      'WRONG_NUMBER',
      'OTHER',
      'NEEDS_REVIEW'
    ];

    // Filter applicable outcomes to meaningful business outcomes only (excludes NO_ANSWER, NEEDS_REVIEW, etc.)
    const validBusiness = applicableOutcomes.filter((o) => MEANINGFUL_BUSINESS_OUTCOMES.has(o));

    let primaryOutcome: CallOutcome;
    let finalApplicableOutcomes: CallOutcome[];

    if (validBusiness.length === 0) {
      primaryOutcome = 'OTHER';
      finalApplicableOutcomes = [];
    } else {
      validBusiness.sort((a, b) => {
        const idxA = priorityOrder.indexOf(a);
        const idxB = priorityOrder.indexOf(b);
        return (idxA !== -1 ? idxA : 99) - (idxB !== -1 ? idxB : 99);
      });
      finalApplicableOutcomes = validBusiness;

      const primaryConf = primaryAnswer?.confidence ?? 0;
      const dncProb = answers.dnc_demanded?.noul ?? answers.dnc_demanded?.probability ?? 0;

      if (primaryConf < 0.60 && dncProb >= 0.70 && validBusiness.includes('DNC_REQUESTED')) {
        primaryOutcome = 'DNC_REQUESTED';
      } else if (MEANINGFUL_BUSINESS_OUTCOMES.has(primaryChoice) && validBusiness.includes(primaryChoice)) {
        primaryOutcome = primaryChoice;
      } else {
        primaryOutcome = validBusiness[0]!;
      }
    }

    // Calculate exact analysis cost from token usage:
    // Rate: $0.042 per 1,000,000 input tokens; output tokens are free ($0.00)
    const inputTokens = data.usage?.input_tokens ?? 0;
    const costInDollars = (inputTokens * 0.042) / 1_000_000;
    const analysisCost = `$${costInDollars.toFixed(6)}`;

    const latencyMs = Date.now() - startTime;
    const rawConfidence = primaryAnswer?.confidence ?? outcomeProbabilities[primaryOutcome] ?? 0.95;
    const confidence = Number(rawConfidence.toFixed(2));

    return {
      primaryOutcome,
      applicableOutcomes: finalApplicableOutcomes,
      sentiment: (sentimentAnswer?.choice || sentimentAnswer?.selected || 'NEUTRAL') as SentimentOutcome,
      confidence,
      latencyMs,
      analysisCost
    };
  }
}
