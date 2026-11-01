import { z } from 'zod';

/* ------------------------------------------------------------------ *
 * Tasks - features address models by TASK, never by model id (ADR-0007)
 * ------------------------------------------------------------------ */

export const AiTask = z.enum([
  'screenAnalysis',
  'personaGeneration',
  'testPlanGeneration',
  'autonomousTesting',
  'uxEvaluation',
  'reportGeneration',
]);
export type AiTask = z.infer<typeof AiTask>;

export const AI_TASKS: AiTask[] = [
  'screenAnalysis',
  'personaGeneration',
  'testPlanGeneration',
  'autonomousTesting',
  'uxEvaluation',
  'reportGeneration',
];

export const AI_TASK_LABELS: Record<AiTask, string> = {
  screenAnalysis: 'Screen Analysis',
  personaGeneration: 'Persona Generation',
  testPlanGeneration: 'Test Plan Generation',
  autonomousTesting: 'Autonomous Testing',
  uxEvaluation: 'UX Evaluation',
  reportGeneration: 'Report Generation',
};

/* ------------------------------------------------------------------ *
 * Provider configuration (config/ai-providers.json)
 * ------------------------------------------------------------------ */

export const ModelConfig = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  maxInputTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  supportsToolCalling: z.boolean().default(false),
  supportsVision: z.boolean().default(false),
  supportsStructuredOutput: z.boolean().default(false),
  isReasoningModel: z.boolean().default(false),
  enabled: z.boolean().default(true),
  notes: z.string().optional(),
  costPer1kInput: z.number().optional(),
  costPer1kOutput: z.number().optional(),
});
export type ModelConfig = z.infer<typeof ModelConfig>;

export const ProviderConfig = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  baseUrl: z.string().url(),
  /** `${ENV_VAR}` placeholder in the file; resolved at startup. */
  apiKey: z.string().min(1),
  adapter: z.enum(['openai-compatible']).default('openai-compatible'),
  enabled: z.boolean().default(true),
  timeoutMs: z.number().int().positive().default(120000),
  maxRetries: z.number().int().min(0).max(5).default(2),
  models: z.array(ModelConfig).min(1),
});
export type ProviderConfig = z.infer<typeof ProviderConfig>;

export const TaskModelAssignment = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  /**
   * Reasoning (thinking) mode for models that support it.
   *
   * Measured on nemotron-3.5-super-vl: disabling it cuts output tokens roughly
   * 6x (59-68 vs 264-412) on a structured persona task while still producing
   * schema-valid JSON 3/3. Left ON by default, because judgement-heavy tasks
   * (UX evaluation, autonomous testing) plausibly benefit from the trace - use
   * the Model Lab to decide per task rather than assuming.
   */
  thinking: z.boolean().optional(),
});
export type TaskModelAssignment = z.infer<typeof TaskModelAssignment>;

export const AiDefaults = z.object({
  temperature: z.number().min(0).max(2).default(0.3),
  maxOutputTokens: z.number().int().positive().default(4096),
  /**
   * Minimum output budget for reasoning models. Observed: with max_tokens 300 a
   * vision call returned content:null / finish_reason:"length" because the
   * reasoning trace consumed the entire budget.
   */
  reasoningOutputFloor: z.number().int().positive().default(3000),
});
export type AiDefaults = z.infer<typeof AiDefaults>;

export const AiProvidersFile = z.object({
  providers: z.array(ProviderConfig).min(1),
  taskModels: z.record(AiTask, TaskModelAssignment),
  defaults: AiDefaults.prefault({}),
});
export type AiProvidersFile = z.infer<typeof AiProvidersFile>;

/* ------------------------------------------------------------------ *
 * Redacted view exposed to the frontend - NEVER contains credentials
 * ------------------------------------------------------------------ */

export const PublicModel = ModelConfig.omit({ notes: true }).extend({
  notes: z.string().nullable(),
});
export type PublicModel = z.infer<typeof PublicModel>;

export const PublicProvider = z.object({
  id: z.string(),
  displayName: z.string(),
  adapter: z.string(),
  enabled: z.boolean(),
  /** Whether a key resolved - the key itself never leaves the backend. */
  hasApiKey: z.boolean(),
  /** Host only, so the UI can show where calls go without leaking credentials. */
  baseUrlHost: z.string(),
  models: z.array(PublicModel),
});
export type PublicProvider = z.infer<typeof PublicProvider>;

/* ------------------------------------------------------------------ *
 * Normalized request / response across providers
 * ------------------------------------------------------------------ */

export type AiImageInput = { mimeType: string; base64: string };

export type AiMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string; images?: AiImageInput[] }
  | { role: 'assistant'; content: string };

export interface AiRequest {
  messages: AiMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  /** Explicit override - the only sanctioned bypass, used by the Model Lab. */
  override?: TaskModelAssignment;
  /** Overrides the task-level thinking setting for this one call. */
  thinking?: boolean;
  timeoutMs?: number;
}

export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface AiResponse {
  content: string;
  /** Reasoning trace, kept separate from the answer. Never shown as a finding. */
  reasoning: string | null;
  usage: AiUsage;
  providerId: string;
  modelId: string;
  latencyMs: number;
  finishReason: string;
  mode: 'live' | 'mock';
  estimatedCost: number | null;
}

export interface AiStructured<T> extends AiResponse {
  data: T;
  structuredValid: boolean;
  /** Number of repair attempts needed - a quality signal for the Model Lab. */
  repairAttempts: number;
}

/* ------------------------------------------------------------------ *
 * Experiments
 * ------------------------------------------------------------------ */

export const ExperimentResult = z.object({
  id: z.string(),
  experimentId: z.string(),
  providerId: z.string(),
  modelId: z.string(),
  latencyMs: z.number().nullable(),
  promptTokens: z.number().nullable(),
  completionTokens: z.number().nullable(),
  reasoningTokens: z.number().nullable(),
  estimatedCost: z.number().nullable(),
  structuredValid: z.boolean().nullable(),
  repairAttempts: z.number().nullable(),
  output: z.unknown().nullable(),
  rawContent: z.string().nullable(),
  error: z.string().nullable(),
  humanRating: z.number().min(1).max(5).nullable(),
  humanNotes: z.string().nullable(),
});
export type ExperimentResult = z.infer<typeof ExperimentResult>;

export const Experiment = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  task: AiTask,
  prompt: z.string(),
  screenshotId: z.string().nullable(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  createdAt: z.string(),
  results: z.array(ExperimentResult),
});
export type Experiment = z.infer<typeof Experiment>;
