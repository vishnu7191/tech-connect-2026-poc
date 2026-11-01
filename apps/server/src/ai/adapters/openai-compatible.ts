import type { AiMessage, AiResponse, AiUsage, ModelConfig } from '@lenz/shared';
import type { ResolvedProvider } from '../config.js';
import {
  ProviderAuthError,
  ProviderError,
  ProviderRateLimitError,
  TruncatedResponseError,
} from '../../core/errors.js';
import { logger } from '../../core/logger.js';

/**
 * Adapter for OpenAI-shaped chat-completions endpoints (NVIDIA NIM today).
 *
 * ADR-0007: ALL provider- and model-specific behaviour lives here. Feature code
 * never learns that a model reasons, that it reports reasoning tokens, or that
 * it can truncate.
 */

export interface AdapterRequest {
  messages: AiMessage[];
  temperature: number;
  maxOutputTokens: number;
  timeoutMs: number;
  /**
   * Reasoning mode for models that support it. Sent as
   * chat_template_kwargs.thinking - verified working on NVIDIA NIM, where
   * false drops reasoning_tokens to 0.
   */
  thinking?: boolean;
  /** Structured output mode, when the model declares support. */
  responseFormat?:
    | { type: 'json_object' }
    | { type: 'json_schema'; json_schema: { name: string; schema: unknown; strict?: boolean } };
}

interface ChatChoice {
  index: number;
  message: { role: string; content: string | null; reasoning_content?: string | null };
  finish_reason: string;
}

interface ChatResponse {
  id?: string;
  model?: string;
  choices?: ChatChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number | null } | null;
  };
  error?: { message?: string; type?: string } | string;
  detail?: unknown;
}

function toWireMessages(messages: AiMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'user' && m.images && m.images.length > 0) {
      return {
        role: 'user',
        content: [
          { type: 'text', text: m.content },
          ...m.images.map((img) => ({
            type: 'image_url',
            image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
          })),
        ],
      };
    }
    return { role: m.role, content: m.content };
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class OpenAiCompatibleAdapter {
  readonly id = 'openai-compatible';

  async complete(
    provider: ResolvedProvider,
    model: ModelConfig,
    req: AdapterRequest,
  ): Promise<AiResponse> {
    const maxRetries = provider.maxRetries ?? 2;
    let attempt = 0;
    let budget = req.maxOutputTokens;
    let lastError: unknown;

    while (attempt <= maxRetries) {
      try {
        return await this.callOnce(provider, model, { ...req, maxOutputTokens: budget });
      } catch (err) {
        lastError = err;
        attempt++;

        // Truncation: the reasoning trace ate the budget. Retry with more room.
        // Observed live with max_tokens=300 -> content:null, finish_reason:length.
        if (err instanceof TruncatedResponseError && attempt <= maxRetries) {
          if (budget >= model.maxOutputTokens) {
            // Already at the configured ceiling, so a retry would be identical.
            // Say so explicitly rather than burning attempts on the same call.
            throw new ProviderError(
              provider.id,
              `Model "${model.id}" exhausted its entire configured output budget (${model.maxOutputTokens} tokens) on reasoning without producing an answer. ` +
                `Raise maxOutputTokens for this model in config/ai-providers.json, or simplify the request.`,
            );
          }
          budget = Math.min(Math.ceil(budget * 2.5), model.maxOutputTokens);
          logger.warn(
            { providerId: provider.id, modelId: model.id, newBudget: budget },
            'Response truncated before an answer was produced; retrying with a larger output budget',
          );
          continue;
        }

        // Transient: rate limit / 5xx / network. Back off with jitter.
        const transient =
          err instanceof ProviderRateLimitError ||
          (err instanceof ProviderError && /\b(5\d\d|network|timeout|aborted)\b/i.test(err.message));
        if (transient && attempt <= maxRetries) {
          const base =
            err instanceof ProviderRateLimitError && err.retryAfterMs
              ? err.retryAfterMs
              : 500 * 2 ** (attempt - 1);
          const delay = base + Math.random() * 250;
          logger.warn(
            { providerId: provider.id, attempt, delay: Math.round(delay) },
            'Transient provider error; retrying',
          );
          await sleep(delay);
          continue;
        }

        // Auth and validation errors are never retried.
        throw err;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new ProviderError(provider.id, 'Request failed after retries');
  }

  private async callOnce(
    provider: ResolvedProvider,
    model: ModelConfig,
    req: AdapterRequest,
  ): Promise<AiResponse> {
    if (!provider.apiKey) {
      throw new ProviderAuthError(provider.id, 'No API key resolved for provider');
    }

    // Reasoning models spend output tokens on the trace before answering, so a
    // modest answer budget can starve the answer entirely.
    const effectiveMax = model.isReasoningModel
      ? Math.max(req.maxOutputTokens, 1)
      : req.maxOutputTokens;

    const body: Record<string, unknown> = {
      model: model.id,
      messages: toWireMessages(req.messages),
      temperature: req.temperature,
      max_tokens: Math.min(effectiveMax, model.maxOutputTokens),
    };
    if (req.responseFormat) body.response_format = req.responseFormat;
    // Only meaningful for reasoning models; harmless to omit otherwise.
    if (req.thinking !== undefined && model.isReasoningModel) {
      body.chat_template_kwargs = { thinking: req.thinking };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs);
    const startedAt = Date.now();

    let res: Response;
    try {
      res = await fetch(`${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const e = err as Error;
      const reason = e.name === 'AbortError' ? `timeout after ${req.timeoutMs}ms` : `network: ${e.message}`;
      throw new ProviderError(provider.id, reason, e.message);
    } finally {
      clearTimeout(timer);
    }

    const latencyMs = Date.now() - startedAt;
    const text = await res.text();

    if (!res.ok) {
      const detail = text.slice(0, 500);
      if (res.status === 401 || res.status === 403) {
        throw new ProviderAuthError(provider.id, detail);
      }
      if (res.status === 429) {
        const ra = res.headers.get('retry-after');
        throw new ProviderRateLimitError(provider.id, ra ? Number(ra) * 1000 : null, detail);
      }
      throw new ProviderError(provider.id, `HTTP ${res.status}`, detail);
    }

    let json: ChatResponse;
    try {
      json = JSON.parse(text) as ChatResponse;
    } catch {
      throw new ProviderError(provider.id, 'Response was not valid JSON', text.slice(0, 300));
    }

    if (json.error) {
      const msg = typeof json.error === 'string' ? json.error : (json.error.message ?? 'unknown error');
      throw new ProviderError(provider.id, msg);
    }

    const choice = json.choices?.[0];
    if (!choice) {
      throw new ProviderError(provider.id, 'Response contained no choices');
    }

    const content = choice.message?.content ?? '';
    const reasoning = choice.message?.reasoning_content ?? null;
    const finishReason = choice.finish_reason ?? 'unknown';

    // The signature failure mode of a reasoning model under a tight budget.
    if (finishReason === 'length' && content.trim().length === 0) {
      throw new TruncatedResponseError(model.id, Number(body.max_tokens));
    }

    const usage = normalizeUsage(json.usage);
    return {
      content,
      reasoning,
      usage,
      providerId: provider.id,
      modelId: model.id,
      latencyMs,
      finishReason,
      mode: 'live',
      estimatedCost: estimateCost(model, usage),
    };
  }
}

function normalizeUsage(u: ChatResponse['usage']): AiUsage {
  const prompt = u?.prompt_tokens ?? 0;
  const completion = u?.completion_tokens ?? 0;
  const reasoning = u?.completion_tokens_details?.reasoning_tokens ?? 0;
  return {
    promptTokens: prompt,
    completionTokens: completion,
    reasoningTokens: reasoning ?? 0,
    totalTokens: u?.total_tokens ?? prompt + completion,
  };
}

function estimateCost(model: ModelConfig, usage: AiUsage): number | null {
  if (model.costPer1kInput == null || model.costPer1kOutput == null) return null;
  return (
    (usage.promptTokens / 1000) * model.costPer1kInput +
    (usage.completionTokens / 1000) * model.costPer1kOutput
  );
}

export const openAiCompatibleAdapter = new OpenAiCompatibleAdapter();
