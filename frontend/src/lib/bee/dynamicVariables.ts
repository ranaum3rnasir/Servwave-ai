/**
 * Dynamic Variables definitions, parser, and validation engine for Bee AI Agents.
 */

export interface DynamicVariableDefinition {
  key: string;
  label: string;
  token: string;
  category: 'job_context' | 'core';
  description: string;
  sensitive?: boolean;
}

// ── 1. Job Info Dynamic Context Variables (Extracted from Job Data) ──
export const JOB_CONTEXT_VARIABLES: DynamicVariableDefinition[] = [
  {
    key: 'assigned_team',
    label: 'Assigned Team',
    token: '{{assigned_team}}',
    category: 'job_context',
    description: 'Technicians, dispatcher & salesperson on the job',
  },
  {
    key: 'job_notes',
    label: 'Job Notes',
    token: '{{job_notes}}',
    category: 'job_context',
    description: 'Scope notes, completion notes & estimate notes',
  },
  {
    key: 'invoice_sent',
    label: 'Invoice Sent',
    token: '{{invoice_sent}}',
    category: 'job_context',
    description: 'Invoice #, status, sent/paid dates, billed & balance due',
  },
  {
    key: 'line_items',
    label: 'Line Items',
    token: '{{line_items}}',
    category: 'job_context',
    description: 'Itemized qty, description, unit price, discount & total',
  },
  {
    key: 'total_costs',
    label: 'Total Costs',
    token: '{{total_costs}}',
    category: 'job_context',
    description: 'Subtotal, discounts, tax rate/amount & grand total',
  },
  {
    key: 'internal_costs',
    label: 'Internal Costs',
    token: '{{internal_costs}}',
    category: 'job_context',
    description: 'Internal unit costs, labor hours & overhead metrics',
    sensitive: true,
  },
  {
    key: 'visits',
    label: 'Visits',
    token: '{{visits}}',
    category: 'job_context',
    description: 'Visit history, dates, status, techs & visit notes',
  },
  {
    key: 'communication_history',
    label: 'Communication History',
    token: '{{communication_history}}',
    category: 'job_context',
    description: 'Recent SMS, emails, prior call logs & timeline events',
  },
];

// ── 2. Core Customer & Job Identifiers ──
export const CORE_DYNAMIC_VARIABLES: DynamicVariableDefinition[] = [
  {
    key: 'customer_name',
    label: 'Customer Name',
    token: '{{customer_name}}',
    category: 'core',
    description: 'Full name of the customer being called',
  },
  {
    key: 'customer_phone',
    label: 'Customer Phone',
    token: '{{customer_phone}}',
    category: 'core',
    description: 'Phone number dialed for the customer',
  },
  {
    key: 'company_name',
    label: 'Company Name',
    token: '{{company_name}}',
    category: 'core',
    description: 'Your organization or company trading name',
  },
  {
    key: 'agent_persona',
    label: 'Agent Persona',
    token: '{{agent_persona}}',
    category: 'core',
    description: 'Voice persona name (e.g. Sarah, Rachel, Adam)',
  },
  {
    key: 'job_number',
    label: 'Job #',
    token: '{{job_number}}',
    category: 'core',
    description: 'Identifier of the serviced job (e.g. #J00090)',
  },
  {
    key: 'job_type',
    label: 'Job Type',
    token: '{{job_type}}',
    category: 'core',
    description: 'Trade or category of work completed',
  },
  {
    key: 'service_request',
    label: 'Service Request',
    token: '{{service_request}}',
    category: 'core',
    description: 'Original service request or scope description',
  },
  {
    key: 'service_address',
    label: 'Service Address',
    token: '{{service_address}}',
    category: 'core',
    description: 'Physical location where the service was delivered',
  },
  {
    key: 'warranty_end_date',
    label: 'Warranty Expiry',
    token: '{{warranty_end_date}}',
    category: 'core',
    description: 'Original warranty coverage expiration date',
  },
  {
    key: 'warranty_status',
    label: 'Warranty Status',
    token: '{{warranty_status}}',
    category: 'core',
    description: 'Current coverage status (Active, Expiring Soon, Expired)',
  },
  {
    key: 'renewal_plans',
    label: 'Renewal Plans',
    token: '{{renewal_plans}}',
    category: 'core',
    description: 'List of early renewal protection packages offered',
  },
  {
    key: 'renewal_discount',
    label: 'Renewal Discount',
    token: '{{renewal_discount}}',
    category: 'core',
    description: 'Early renewal incentive discount or promo offer',
  },
  // Supported Aliases
  {
    key: 'first_name',
    label: 'First Name',
    token: '{{first_name}}',
    category: 'core',
    description: "Customer's first name",
  },
  {
    key: 'customer_first_name',
    label: 'Customer First Name',
    token: '{{customer_first_name}}',
    category: 'core',
    description: "Customer's first name",
  },
  {
    key: 'appointment_date',
    label: 'Appointment Date',
    token: '{{appointment_date}}',
    category: 'core',
    description: 'Scheduled visit or appointment date',
  },
  {
    key: 'agent_tone',
    label: 'Agent Tone',
    token: '{{agent_tone}}',
    category: 'core',
    description: 'Selected conversational tone style',
  },
  {
    key: 'agent_language',
    label: 'Agent Language',
    token: '{{agent_language}}',
    category: 'core',
    description: 'Selected spoken language',
  },
];

// Single source of truth for all available variable keys
export const ALL_DYNAMIC_VARIABLES: DynamicVariableDefinition[] = [
  ...JOB_CONTEXT_VARIABLES,
  ...CORE_DYNAMIC_VARIABLES,
];

export const AVAILABLE_DYNAMIC_VARIABLE_SET = new Set<string>(
  ALL_DYNAMIC_VARIABLES.map((v) => v.key.toLowerCase())
);

export interface VariableValidationResult {
  isValid: boolean;
  errors: string[];
  validVariables: string[];
  invalidVariables: string[];
}

/**
 * Strict parser and validator for dynamic variable syntax across agent scripts.
 * Validates syntax:
 *   - Correct: `{{variable_name}}` where variable_name is registered in AVAILABLE_DYNAMIC_VARIABLE_SET.
 *   - Empty: `{{}}` or `{{   }}` -> flagged.
 *   - Missing closing brace: `{{variable_name}` -> flagged.
 *   - Missing opening brace: `{variable_name}}` -> flagged.
 *   - Incomplete / unclosed: `{{variable_name` -> flagged.
 *   - Undefined variable: `{{unknown_var}}` -> flagged.
 */
export function validateScriptVariables(
  scriptText: string,
  availableVariables: Set<string> = AVAILABLE_DYNAMIC_VARIABLE_SET
): VariableValidationResult {
  const errors: string[] = [];
  const validVariables: string[] = [];
  const invalidVariables: string[] = [];

  if (!scriptText || !scriptText.trim()) {
    return { isValid: true, errors, validVariables, invalidVariables };
  }

  // 1. Detect empty double braces: {{}} or {{   }}
  const emptyRegex = /\{\{\s*\}\}/g;
  if (emptyRegex.test(scriptText)) {
    errors.push('Empty dynamic variable reference "{{}}" is not allowed.');
    invalidVariables.push('{{}}');
  }

  // 2. Detect missing closing brace: {{word} not followed by }
  // (e.g. "{{first_name}" but exclude valid "{{first_name}}")
  const missingClosingRegex = /\{\{([a-zA-Z0-9_]+)\}(?!\})/g;
  let mcMatch: RegExpExecArray | null;
  while ((mcMatch = missingClosingRegex.exec(scriptText)) !== null) {
    const raw = mcMatch[0];
    const name = mcMatch[1];
    errors.push(`Incomplete dynamic variable reference: "${raw}". Missing closing brace "}".`);
    invalidVariables.push(raw);
  }

  // 3. Detect missing opening brace: {word}} not preceded by {
  // (e.g. "{first_name}}" but exclude valid "{{first_name}}")
  const missingOpeningRegex = /(?<!\{)\{([a-zA-Z0-9_]+)\}\}/g;
  let moMatch: RegExpExecArray | null;
  while ((moMatch = missingOpeningRegex.exec(scriptText)) !== null) {
    const raw = moMatch[0];
    errors.push(`Incomplete dynamic variable reference: "${raw}". Missing opening brace "{".`);
    invalidVariables.push(raw);
  }

  // 4. Detect unclosed {{word without any closing }} before the next {{ or line/string end
  const unclosedRegex = /\{\{([^{}\r\n]*)(?=\{\{|\r?\n|$)/g;
  let unMatch: RegExpExecArray | null;
  while ((unMatch = unclosedRegex.exec(scriptText)) !== null) {
    const raw = unMatch[0].trim();
    if (raw) {
      errors.push(`Incomplete dynamic variable reference: "${raw}". Please close with "}}".`);
      invalidVariables.push(raw);
    }
  }

  // 5. Detect and validate all well-formed {{...}} tokens
  const wellFormedRegex = /\{\{\s*([^{}]+?)\s*\}\}/g;
  let wfMatch: RegExpExecArray | null;
  while ((wfMatch = wellFormedRegex.exec(scriptText)) !== null) {
    const fullToken = wfMatch[0];
    const inner = (wfMatch[1] || '').trim();

    if (!inner) continue; // Handled by empty check above

    // Check variable name characters (letters, numbers, underscores)
    if (!/^[a-zA-Z0-9_]+$/.test(inner)) {
      errors.push(
        `Invalid dynamic variable name "${inner}" in "${fullToken}". Variable names may only contain letters, numbers, and underscores.`
      );
      invalidVariables.push(fullToken);
      continue;
    }

    const normalized = inner.toLowerCase();
    if (!availableVariables.has(normalized)) {
      errors.push(`"{{${inner}}}" is not an available dynamic variable.`);
      invalidVariables.push(`{{${inner}}}`);
    } else {
      validVariables.push(normalized);
    }
  }

  return {
    isValid: errors.length === 0,
    errors: Array.from(new Set(errors)),
    validVariables: Array.from(new Set(validVariables)),
    invalidVariables: Array.from(new Set(invalidVariables)),
  };
}

/**
 * Checks whether a variable token or key is actively used in the provided script text.
 */
export function isVariableUsedInText(scriptText: string, tokenOrKey: string): boolean {
  if (!scriptText) return false;
  const token = tokenOrKey.startsWith('{{') ? tokenOrKey : `{{${tokenOrKey}}}`;
  const key = tokenOrKey.replace(/^\{\{\s*|\s*\}\}$/g, '').toLowerCase();

  // Check direct token match or whitespace-tolerant regex match
  if (scriptText.includes(token)) return true;

  const regex = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'i');
  return regex.test(scriptText);
}

/**
 * Extracts all Job Context variable keys used across an agent's conversation flow.
 */
export function getUsedJobContextKeys(conversationFlow: Record<string, string | undefined>): string[] {
  const used = new Set<string>();
  const allTexts = Object.values(conversationFlow).filter(Boolean).join(' ');

  for (const def of JOB_CONTEXT_VARIABLES) {
    if (isVariableUsedInText(allTexts, def.key)) {
      used.add(def.key);
    }
  }

  return Array.from(used);
}
