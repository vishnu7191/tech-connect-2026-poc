import fs from 'node:fs';
import {
  AiProvidersFile,
  type AiTask,
  type ModelConfig,
  type ProviderConfig,
  type PublicProvider,
  type TaskModelAssignment,
} from '@lenz/shared';
import { paths } from '../config/env.js';
import { logger } from '../core/logger.js';

/**
 * Centralized AI provider configuration.
 *
 * The JSON file holds `${ENV_VAR}` placeholders only - never literal keys. This
 * module resolves them once at startup and fails fast, so Lenz refuses to boot
 * half-configured rather than failing mysteriously on the first AI call.
 */

const ENV_PLACEHOLDER = /^\$\{([A-Z0-9_]+)\}$/;

export interface ResolvedProvider extends Omit<ProviderConfig, 'apiKey'> {
  /** Resolved secret. Never serialized, never logged, never sent to the client. */
  apiKey: string | null;
  apiKeyEnvVar: string | null;
}

export class AiConfig {
  private constructor(
    readonly providers: ResolvedProvider[],
    private taskModels: Record<AiTask, TaskModelAssignment>,
    readonly defaults: { temperature: number; maxOutputTokens: number; reasoningOutputFloor: number },
  ) {}

  static load(filePath: string = paths.aiProviders, env: NodeJS.ProcessEnv = process.env): AiConfig {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      throw new Error(
        `Could not read AI provider configuration at ${filePath}: ${(err as Error).message}`,
      );
    }

    const parsed = AiProvidersFile.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
        .join('\n');
      throw new Error(`Invalid AI provider configuration:\n${issues}`);
    }

    const providers: ResolvedProvider[] = [];
    const failures: string[] = [];

    for (const p of parsed.data.providers) {
      const match = ENV_PLACEHOLDER.exec(p.apiKey.trim());
      let apiKey: string | null = null;
      let envVar: string | null = null;

      if (match) {
        envVar = match[1]!;
        const value = env[envVar]?.trim();
        apiKey = value && value.length > 0 ? value : null;
        // Only an ENABLED provider with an unresolved key is fatal.
        if (!apiKey && p.enabled) {
          failures.push(
            `Provider "${p.id}" is enabled but environment variable ${envVar} is not set. ` +
              `Set it in .env, or disable the provider in ${filePath}.`,
          );
        }
      } else {
        // A literal key in the committed config is a secret-leak hazard.
        failures.push(
          `Provider "${p.id}" has a literal apiKey. Use a \${ENV_VAR} placeholder instead - ` +
            `this file is committed to source control.`,
        );
      }

      const { apiKey: _discard, ...rest } = p;
      providers.push({ ...rest, apiKey, apiKeyEnvVar: envVar });
    }

    if (failures.length > 0) {
      throw new Error(`AI provider configuration is not usable:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
    }

    const cfg = new AiConfig(
      providers,
      parsed.data.taskModels as Record<AiTask, TaskModelAssignment>,
      parsed.data.defaults,
    );
    cfg.validateTaskAssignments();
    return cfg;
  }

  /** Every task must point at a model that actually exists and is enabled. */
  private validateTaskAssignments(): void {
    const problems: string[] = [];
    for (const [task, assignment] of Object.entries(this.taskModels)) {
      const provider = this.providers.find((p) => p.id === assignment.providerId);
      if (!provider) {
        problems.push(`Task "${task}" references unknown provider "${assignment.providerId}".`);
        continue;
      }
      const model = provider.models.find((m) => m.id === assignment.modelId);
      if (!model) {
        problems.push(
          `Task "${task}" references unknown model "${assignment.modelId}" on provider "${assignment.providerId}".`,
        );
        continue;
      }
      if (!provider.enabled) {
        problems.push(`Task "${task}" is assigned to disabled provider "${provider.id}".`);
      }
    }
    if (problems.length > 0) {
      throw new Error(`AI task assignments are invalid:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    }
  }

  getProvider(providerId: string): ResolvedProvider | undefined {
    return this.providers.find((p) => p.id === providerId);
  }

  getModel(providerId: string, modelId: string): ModelConfig | undefined {
    return this.getProvider(providerId)?.models.find((m) => m.id === modelId);
  }

  /** Resolve a TASK to a concrete provider+model. Features never do this themselves. */
  resolveTask(task: AiTask): { provider: ResolvedProvider; model: ModelConfig } {
    const assignment = this.taskModels[task];
    if (!assignment) throw new Error(`No model assigned to AI task "${task}".`);
    return this.resolveAssignment(assignment, `task "${task}"`);
  }

  resolveAssignment(
    assignment: TaskModelAssignment,
    context = 'assignment',
  ): { provider: ResolvedProvider; model: ModelConfig } {
    const provider = this.getProvider(assignment.providerId);
    if (!provider) throw new Error(`Unknown provider "${assignment.providerId}" for ${context}.`);
    const model = provider.models.find((m) => m.id === assignment.modelId);
    if (!model) {
      throw new Error(
        `Unknown model "${assignment.modelId}" on provider "${assignment.providerId}" for ${context}.`,
      );
    }
    return { provider, model };
  }

  getTaskAssignments(): Record<AiTask, TaskModelAssignment> {
    return { ...this.taskModels };
  }

  /** Runtime reassignment from the Model Lab. Validated before being applied. */
  setTaskAssignment(task: AiTask, assignment: TaskModelAssignment): void {
    this.resolveAssignment(assignment, `task "${task}"`);
    this.taskModels[task] = assignment;
    logger.info({ task, ...assignment }, 'AI task reassigned');
  }

  setModelEnabled(providerId: string, modelId: string, enabled: boolean): void {
    const model = this.getModel(providerId, modelId);
    if (!model) throw new Error(`Unknown model "${modelId}" on provider "${providerId}".`);
    model.enabled = enabled;
  }

  /**
   * Redacted view for the frontend. Returns capability metadata and whether a
   * key resolved - NEVER the key itself, and never a credential-bearing URL.
   */
  toPublic(): PublicProvider[] {
    return this.providers.map((p) => ({
      id: p.id,
      displayName: p.displayName,
      adapter: p.adapter,
      enabled: p.enabled,
      hasApiKey: Boolean(p.apiKey),
      baseUrlHost: safeHost(p.baseUrl),
      models: p.models.map((m) => ({
        id: m.id,
        name: m.name,
        maxInputTokens: m.maxInputTokens,
        maxOutputTokens: m.maxOutputTokens,
        supportsToolCalling: m.supportsToolCalling,
        supportsVision: m.supportsVision,
        supportsStructuredOutput: m.supportsStructuredOutput,
        isReasoningModel: m.isReasoningModel,
        enabled: m.enabled,
        costPer1kInput: m.costPer1kInput,
        costPer1kOutput: m.costPer1kOutput,
        notes: m.notes ?? null,
      })),
    }));
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown';
  }
}

let cached: AiConfig | null = null;

export function getAiConfig(): AiConfig {
  if (!cached) cached = AiConfig.load();
  return cached;
}

export function resetAiConfigForTests(cfg: AiConfig | null = null): void {
  cached = cfg;
}
