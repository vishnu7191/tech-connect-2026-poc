import fsp from 'node:fs/promises';
import { z } from 'zod';
import { AiTask, ScreenAnalysis } from '@lenz/shared';
import { notFound, validationFailed } from '../core/errors.js';
import { getAiConfig } from '../ai/config.js';
import { getAiService } from '../ai/service.js';
import { parseBody, type LenzApp, type RouteDeps } from './index.js';

export async function registerAiRoutes(app: LenzApp, deps: RouteDeps): Promise<void> {
  const { repos, jobs } = deps;

  /** Redacted view only - API keys never leave the backend. */
  app.get('/api/v1/ai/providers', async () => getAiConfig().toPublic());

  app.get('/api/v1/ai/tasks', async () => getAiConfig().getTaskAssignments());

  app.put('/api/v1/ai/tasks/:task', async (req) => {
    const { task } = req.params as { task: string };
    const parsedTask = AiTask.safeParse(task);
    if (!parsedTask.success) throw validationFailed(`Unknown AI task "${task}"`);
    const body = parseBody(
      z.object({ providerId: z.string().min(1), modelId: z.string().min(1) }),
      req.body,
    );
    const cfg = getAiConfig();
    try {
      // Validates the assignment before applying it.
      cfg.setTaskAssignment(parsedTask.data, body);
    } catch (err) {
      throw validationFailed((err as Error).message);
    }
    return cfg.getTaskAssignments();
  });

  app.patch('/api/v1/ai/models/:providerId/:modelId', async (req) => {
    const { providerId } = req.params as { providerId: string };
    // Model ids contain slashes, so take the remainder of the path.
    const modelId = decodeURIComponent((req.params as Record<string, string>)['*'] ?? (req.params as Record<string, string>).modelId ?? '');
    const body = parseBody(z.object({ enabled: z.boolean() }), req.body);
    const cfg = getAiConfig();
    try {
      cfg.setModelEnabled(providerId, modelId, body.enabled);
    } catch (err) {
      throw validationFailed((err as Error).message);
    }
    return cfg.toPublic();
  });

  /* ---------------- experiments ---------------- */

  app.post('/api/v1/ai/experiments', async (req, reply) => {
    const body = parseBody(
      z.object({
        task: AiTask,
        prompt: z.string().min(1).max(8000),
        projectId: z.string().nullable().optional(),
        screenshotId: z.string().nullable().optional(),
        models: z
          .array(z.object({ providerId: z.string(), modelId: z.string() }))
          .min(2, 'A comparison needs at least two models')
          .max(5),
        structured: z.boolean().default(false),
      }),
      req.body,
    );

    const experimentId = repos.createExperiment(
      body.task,
      body.prompt,
      body.projectId ?? null,
      body.screenshotId ?? null,
    );

    const job = jobs.enqueue('experiment', body.projectId ?? null, async (ctx) => {
      repos.setExperimentStatus(experimentId, 'running');
      const ai = getAiService();

      // Load the image once; every model receives IDENTICAL input, which is
      // the entire point of a comparison.
      let images: Array<{ mimeType: string; base64: string }> = [];
      if (body.screenshotId) {
        const shot = repos.getScreenshot(body.screenshotId);
        if (shot?.path) {
          try {
            images = [{ mimeType: 'image/png', base64: (await fsp.readFile(shot.path)).toString('base64') }];
          } catch {
            /* reported per-model below if it matters */
          }
        }
      }

      for (let i = 0; i < body.models.length; i++) {
        const m = body.models[i]!;
        ctx.throwIfCancelled();
        ctx.progress((i + 0.5) / body.models.length, `Running ${m.modelId}`, 'experiment');
        try {
          const request = {
            messages: [{ role: 'user' as const, content: body.prompt, ...(images.length ? { images } : {}) }],
            override: m,
            maxOutputTokens: 4000,
          };
          if (body.structured) {
            const res = await ai.completeStructured(body.task, request, ScreenAnalysis, {
              schemaName: 'screenAnalysis',
            });
            repos.addExperimentResult({
              experimentId,
              providerId: res.providerId,
              modelId: res.modelId,
              latencyMs: res.latencyMs,
              promptTokens: res.usage.promptTokens,
              completionTokens: res.usage.completionTokens,
              reasoningTokens: res.usage.reasoningTokens,
              estimatedCost: res.estimatedCost,
              structuredValid: res.structuredValid,
              repairAttempts: res.repairAttempts,
              output: res.data,
              rawContent: res.content.slice(0, 8000),
              error: null,
            });
          } else {
            const res = await ai.complete(body.task, request);
            repos.addExperimentResult({
              experimentId,
              providerId: res.providerId,
              modelId: res.modelId,
              latencyMs: res.latencyMs,
              promptTokens: res.usage.promptTokens,
              completionTokens: res.usage.completionTokens,
              reasoningTokens: res.usage.reasoningTokens,
              estimatedCost: res.estimatedCost,
              structuredValid: null,
              repairAttempts: null,
              output: null,
              rawContent: res.content.slice(0, 8000),
              error: null,
            });
          }
        } catch (err) {
          // A model failing is itself a comparison result, not a job failure.
          repos.addExperimentResult({
            experimentId,
            providerId: m.providerId,
            modelId: m.modelId,
            latencyMs: null,
            promptTokens: null,
            completionTokens: null,
            reasoningTokens: null,
            estimatedCost: null,
            structuredValid: body.structured ? false : null,
            repairAttempts: null,
            output: null,
            rawContent: null,
            error: (err as Error).message.slice(0, 500),
          });
        }
      }
      repos.setExperimentStatus(experimentId, 'succeeded');
      return { experimentId };
    });

    reply.code(202);
    return { jobId: job.id, experimentId };
  });

  app.get('/api/v1/ai/experiments', async () => repos.listExperiments());

  app.get('/api/v1/ai/experiments/:id', async (req) => {
    const { id } = req.params as { id: string };
    const exp = repos.getExperiment(id);
    if (!exp) throw notFound('Experiment');
    return exp;
  });

  app.post('/api/v1/ai/experiments/:id/rate', async (req) => {
    const { id } = req.params as { id: string };
    const body = parseBody(
      z.object({
        resultId: z.string(),
        rating: z.number().int().min(1).max(5),
        notes: z.string().max(2000).nullable().optional(),
      }),
      req.body,
    );
    if (!repos.getExperiment(id)) throw notFound('Experiment');
    repos.rateExperimentResult(body.resultId, body.rating, body.notes ?? null);
    return repos.getExperiment(id);
  });
}
