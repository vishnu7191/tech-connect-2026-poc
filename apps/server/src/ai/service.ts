import { z } from 'zod';
import type {
  AiRequest,
  AiResponse,
  AiStructured,
  AiTask,
  ModelConfig,
  TaskModelAssignment,
} from '@lenz/shared';
import { CapabilityError, validationFailed } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { AiConfig, getAiConfig, type ResolvedProvider } from './config.js';
import { openAiCompatibleAdapter, type AdapterRequest } from './adapters/openai-compatible.js';

/**
 * The ONLY entry point feature code uses for AI.
 *
 * Callers name a TASK, never a model (ADR-0007). Changing which model performs
 * a task is a configuration edit, not a code change.
 */

export interface AiCallTelemetry {
  task: AiTask;
  providerId: string;
  modelId: string;
  latencyMs: number;
  usage: AiResponse['usage'];
  structuredValid?: boolean;
  repairAttempts?: number;
  outcome: 'ok' | 'error';
  error?: string;
}

export type TelemetrySink = (t: AiCallTelemetry) => void;

/** Total base64 image bytes allowed in one model call. */
export const MAX_IMAGE_PAYLOAD_BYTES = 12 * 1024 * 1024;

export class AiService {
  private readonly adapters = { 'openai-compatible': openAiCompatibleAdapter };

  constructor(
    private readonly config: AiConfig = getAiConfig(),
    private readonly onTelemetry: TelemetrySink = () => {},
  ) {}

  getConfig(): AiConfig {
    return this.config;
  }

  /** Plain text (or free-form) completion for a task. */
  async complete(task: AiTask, req: AiRequest): Promise<AiResponse> {
    const { provider, model } = this.resolve(task, req.override);
    this.assertCapabilities(model, req);
    const adapterReq = this.buildAdapterRequest(provider, model, req, this.thinkingFor(task, req));

    try {
      const res = await this.adapters[provider.adapter].complete(provider, model, adapterReq);
      this.onTelemetry({
        task,
        providerId: provider.id,
        modelId: model.id,
        latencyMs: res.latencyMs,
        usage: res.usage,
        outcome: 'ok',
      });
      return res;
    } catch (err) {
      this.onTelemetry({
        task,
        providerId: provider.id,
        modelId: model.id,
        latencyMs: 0,
        usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0 },
        outcome: 'error',
        error: (err as Error).message,
      });
      throw err;
    }
  }

  /**
   * Structured completion validated against a Zod schema.
   *
   * ADR-0008: this is the boundary where untrusted model output stops being
   * trusted. Nothing reaches the browser engine or the database unvalidated.
   */
  async completeStructured<T>(
    task: AiTask,
    req: AiRequest,
    schema: z.ZodType<T>,
    opts: { schemaName?: string; maxRepairs?: number } = {},
  ): Promise<AiStructured<T>> {
    const { provider, model } = this.resolve(task, req.override);
    this.assertCapabilities(model, req);

    const schemaName = opts.schemaName ?? 'result';
    const maxRepairs = opts.maxRepairs ?? 1;

    // Prefer native json_schema; fall back to json_object + prompt instruction.
    let responseFormat: AdapterRequest['responseFormat'];
    if (model.supportsStructuredOutput) {
      try {
        responseFormat = {
          type: 'json_schema',
          json_schema: { name: schemaName, schema: z.toJSONSchema(schema), strict: false },
        };
      } catch {
        responseFormat = { type: 'json_object' };
      }
    }

    const messages = [...req.messages];
    let repairAttempts = 0;
    let lastError = '';
    let lastResponse: AiResponse | null = null;

    for (let attempt = 0; attempt <= maxRepairs; attempt++) {
      const adapterReq = this.buildAdapterRequest(provider, model, { ...req, messages }, this.thinkingFor(task, req));
      adapterReq.responseFormat = responseFormat;

      const res = await this.adapters[provider.adapter].complete(provider, model, adapterReq);
      lastResponse = res;

      const extracted = extractJson(res.content);
      if (extracted !== null) {
        const parsed = schema.safeParse(extracted);
        if (parsed.success) {
          this.onTelemetry({
            task,
            providerId: provider.id,
            modelId: model.id,
            latencyMs: res.latencyMs,
            usage: res.usage,
            structuredValid: true,
            repairAttempts,
            outcome: 'ok',
          });
          return { ...res, data: parsed.data, structuredValid: true, repairAttempts };
        }
        lastError = parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ');
      } else {
        lastError = 'Response did not contain parseable JSON.';
      }

      if (attempt < maxRepairs) {
        repairAttempts++;
        // Feed the validation error back as a correction hint.
        messages.push({ role: 'assistant', content: res.content.slice(0, 2000) });
        messages.push({
          role: 'user',
          content:
            `That response was not valid. Problem: ${lastError}\n\n` +
            `Reply again with ONLY a JSON object matching the required schema. No prose, no code fences.`,
        });
        logger.warn(
          { task, modelId: model.id, error: lastError },
          'Structured output failed validation; attempting repair',
        );
      }
    }

    this.onTelemetry({
      task,
      providerId: provider.id,
      modelId: model.id,
      latencyMs: lastResponse?.latencyMs ?? 0,
      usage: lastResponse?.usage ?? {
        promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0,
      },
      structuredValid: false,
      repairAttempts,
      outcome: 'error',
      error: lastError,
    });

    throw validationFailed(
      `Model "${model.id}" did not return output matching the ${schemaName} schema.`,
      { reason: lastError, repairAttempts },
    );
  }

  /** Task-level thinking preference, unless the caller overrode it. */
  private thinkingFor(task: AiTask, req: AiRequest): boolean | undefined {
    if (req.thinking !== undefined) return req.thinking;
    const assignment = req.override ?? this.config.getTaskAssignments()[task];
    return assignment?.thinking;
  }

  private resolve(
    task: AiTask,
    override?: TaskModelAssignment,
  ): { provider: ResolvedProvider; model: ModelConfig } {
    return override
      ? this.config.resolveAssignment(override, `override for task "${task}"`)
      : this.config.resolveTask(task);
  }

  /**
   * Capabilities are declared per model and must not be assumed uniform across
   * providers. Raising a precise error beats sending a request destined to fail.
   */
  private assertCapabilities(model: ModelConfig, req: AiRequest): void {
    const needsVision = req.messages.some(
      (m) => m.role === 'user' && Array.isArray(m.images) && m.images.length > 0,
    );
    if (needsVision && !model.supportsVision) {
      throw new CapabilityError(model.id, 'image input (vision)');
    }
    if (!model.enabled) {
      throw new CapabilityError(model.id, 'use while disabled');
    }

    /**
     * Guard the request size before sending it.
     *
     * Screenshots are large (a full Rosella page is ~460 KB, ~613 KB as base64)
     * and a handful of them will silently exceed a provider's limits, producing
     * an opaque 400 or a timeout. Failing here instead names the real cause.
     */
    let imageBytes = 0;
    let imageCount = 0;
    for (const m of req.messages) {
      if (m.role !== 'user' || !m.images) continue;
      for (const img of m.images) {
        imageCount++;
        imageBytes += img.base64.length;
      }
    }
    if (imageBytes > MAX_IMAGE_PAYLOAD_BYTES) {
      throw validationFailed(
        `This request carries ${imageCount} image(s) totalling ${(imageBytes / 1_048_576).toFixed(1)} MB, ` +
          `which exceeds the ${(MAX_IMAGE_PAYLOAD_BYTES / 1_048_576).toFixed(0)} MB limit for a single model call. ` +
          `Reduce the number of screenshots included as evidence.`,
        { imageCount, imageBytes },
      );
    }
  }

  private buildAdapterRequest(
    provider: ResolvedProvider,
    model: ModelConfig,
    req: AiRequest,
    taskThinking?: boolean,
  ): AdapterRequest {
    const defaults = this.config.defaults;
    let maxOutputTokens = req.maxOutputTokens ?? defaults.maxOutputTokens;

    // A reasoning model spends output tokens on its trace before answering, so
    // enforce a floor derived from observed behaviour - but only when the trace
    // is actually enabled, otherwise the budget is wasted.
    const thinking = req.thinking ?? taskThinking;
    const traceEnabled = model.isReasoningModel && thinking !== false;
    if (traceEnabled) {
      maxOutputTokens = Math.max(maxOutputTokens, defaults.reasoningOutputFloor);
    }

    return {
      messages: req.messages,
      temperature: req.temperature ?? defaults.temperature,
      maxOutputTokens: Math.min(maxOutputTokens, model.maxOutputTokens),
      timeoutMs: req.timeoutMs ?? provider.timeoutMs,
      ...(thinking !== undefined ? { thinking } : {}),
    };
  }
}

/**
 * Pull a JSON value out of a model response that may be wrapped in prose or
 * code fences. Defensive by design - models embed JSON in explanations.
 */
export function extractJson(content: string): unknown | null {
  const text = content.trim();
  if (!text) return null;

  const direct = tryParse(text);
  if (direct !== undefined) return direct;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) {
    const v = tryParse(fenced[1].trim());
    if (v !== undefined) return v;
  }

  // Fall back to the outermost balanced {...} or [...] span.
  for (const [open, close] of [['{', '}'], ['[', ']']] as const) {
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    if (start !== -1 && end > start) {
      const v = tryParse(text.slice(start, end + 1));
      if (v !== undefined) return v;
    }
  }
  return null;
}

function tryParse(s: string): unknown | undefined {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

let singleton: AiService | null = null;
export function getAiService(): AiService {
  if (!singleton) singleton = new AiService();
  return singleton;
}
export function resetAiServiceForTests(s: AiService | null = null): void {
  singleton = s;
}
