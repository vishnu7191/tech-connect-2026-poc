import type {
  FastifyInstance,
  FastifyReply,
  FastifyTypeProviderDefault,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { Logger } from 'pino';

/**
 * Fastify's generics narrow when a custom pino instance is supplied, so route
 * modules share this alias rather than each re-deriving the instance type.
 */
export type LenzApp = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  Logger,
  FastifyTypeProviderDefault
>;
import { z } from 'zod';
import { AI_TASKS, AiTask, ERROR_CODES } from '@lenz/shared';
import { AppError, notFound, validationFailed } from '../core/errors.js';
import { parseFigmaUrl } from '../figma/url.js';
import { analyzeGraph } from '../graph/analyze.js';
import { getAiConfig } from '../ai/config.js';
import type { Repositories } from '../db/repositories.js';
import type { JobQueue } from '../jobs/queue.js';
import { runDiscovery } from '../services/discovery.js';
import { registerPersonaRoutes } from './personas.js';
import { registerTestPlanRoutes } from './testplans.js';
import { registerExecutionRoutes } from './executions.js';
import { registerAiRoutes } from './ai.js';

export interface RouteDeps {
  repos: Repositories;
  jobs: JobQueue;
}

/** Parse a request body with Zod, converting failures to a 400 AppError. */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) {
    throw validationFailed('Request body is invalid', {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

export async function registerRoutes(app: LenzApp, deps: RouteDeps): Promise<void> {
  const { repos, jobs } = deps;

  /* ---------------- health ---------------- */

  app.get('/api/v1/health', async () => ({ status: 'ok', time: new Date().toISOString() }));

  app.get('/api/v1/health/dependencies', async () => {
    // Each dependency is reported independently so a partial outage is visible
    // rather than hidden behind one boolean.
    const cfg = getAiConfig();
    const { env, hasFigmaToken } = await import('../config/env.js');
    return {
      figma: { configured: hasFigmaToken(), note: hasFigmaToken() ? null : 'FIGMA_ACCESS_TOKEN not set' },
      ai: {
        providers: cfg.providers.map((p) => ({
          id: p.id,
          enabled: p.enabled,
          hasApiKey: Boolean(p.apiKey),
        })),
      },
      browser: { headless: env.HEADLESS },
    };
  });

  app.get('/api/v1/dashboard', async () => repos.dashboardStats());

  /* ---------------- figma url parsing ---------------- */

  app.post('/api/v1/figma/parse-url', async (req) => {
    const { url } = parseBody(z.object({ url: z.string() }), req.body);
    const parsed = parseFigmaUrl(url);
    return {
      ...parsed,
      // Explain to the user which discovery path this URL will take.
      scenario:
        parsed.kind === 'make'
          ? 'C'
          : parsed.kind === 'proto'
            ? parsed.hasExplicitStartPoint
              ? 'A'
              : 'B'
            : 'D',
    };
  });

  /** Everything Lenz accepts, so the UI can explain the options up front. */
  app.get('/api/v1/figma/supported-links', async () => {
    return {
      links: [
        { segment: '/proto/', label: 'Prototype', support: 'full', note: 'Full workflow: discovery, personas, test plans, browser-verified execution and UX analysis.' },
        { segment: '/make/', label: 'Figma Make app', support: 'browser-only', note: 'Browser-driven discovery of UI states in the live application.' },
        { segment: '/design/', label: 'Design file', support: 'structural', note: 'Screen inventory only - a design link has no prototype flows.' },
        { segment: '/file/', label: 'Design file (legacy)', support: 'structural', note: 'Screen inventory only.' },
        { segment: '/board/', label: 'FigJam board', support: 'structural', note: 'Structure only; not an interactive product surface.' },
        { segment: '/slides/', label: 'Figma Slides', support: 'structural', note: 'Structure only; slides are linear content.' },
        { segment: '/deck/', label: 'Slides (presentation)', support: 'structural', note: 'Structure only.' },
      ],
      notAccepted: [
        { what: 'Community links (/community/...)', why: 'A community listing is not a file you own. Duplicate it to your drafts first, then paste that link.' },
        { what: 'Private or sign-in-required prototypes', why: 'Lenz runs anonymously. Set sharing to "Anyone with the link can view".' },
      ],
    };
  });

  /* ---------------- projects ---------------- */

  app.post('/api/v1/projects', async (req, reply) => {
    const body = parseBody(
      z.object({
        name: z.string().min(1).max(200),
        figmaUrl: z.string().min(1),
        description: z.string().max(2000).nullable().optional(),
      }),
      req.body,
    );
    const parsed = parseFigmaUrl(body.figmaUrl);
    const project = repos.createProject({
      name: body.name,
      description: body.description ?? null,
      figmaUrl: body.figmaUrl,
      urlKind: parsed.kind,
      fileKey: parsed.fileKey,
      fileName: parsed.fileName,
      startNodeId: parsed.startNodeId,
    });
    reply.code(201);
    return project;
  });

  app.get('/api/v1/projects', async () =>
    repos.listProjects().map((p) => {
      const run = repos.getLatestDiscoveryRun(p.id);
      return {
        ...p,
        screenCount: run?.screens_discovered ?? 0,
        executionCount: repos.listExecutions(p.id).length,
        findingCount: repos.listFindings({ projectId: p.id }).length,
      };
    }),
  );

  app.get('/api/v1/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    const project = repos.getProject(id);
    if (!project) throw notFound('Project');
    const run = repos.getLatestDiscoveryRun(id);
    return {
      ...project,
      discovery: run
        ? {
            runId: run.id,
            mode: run.mode,
            screensDiscovered: run.screens_discovered,
            componentsExcluded: run.components_excluded,
            ambiguousCount: run.ambiguous_count,
            screensReachable: run.screens_reachable,
            disconnectedCount: run.disconnected_count,
            interactionsFound: run.interactions_found,
            screenEdges: run.screen_edges,
            uiStateEdges: run.ui_state_edges,
            overlayEdges: run.overlay_edges,
            unsupportedInteractions: run.unsupported_interactions,
            confirmedEntryPoints: run.confirmed_entry_points,
            inferredEntryPoints: run.inferred_entry_points,
            flowCount: run.flow_count,
            warnings: JSON.parse(run.warnings ?? '[]'),
            startedAt: run.started_at,
            finishedAt: run.finished_at,
          }
        : null,
      coverage: repos.getCoverage(id, null),
    };
  });

  app.patch('/api/v1/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    if (!repos.getProject(id)) throw notFound('Project');
    const body = parseBody(
      z.object({
        name: z.string().min(1).optional(),
        description: z.string().nullable().optional(),
        autoApprovePlans: z.boolean().optional(),
      }),
      req.body,
    );
    repos.updateProject(id, body);
    return repos.getProject(id);
  });

  app.delete('/api/v1/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!repos.getProject(id)) throw notFound('Project');
    const { getStorage } = await import('../core/storage.js');
    await getStorage().removeDirectory(id).catch(() => undefined);
    repos.deleteProject(id);
    reply.code(204);
    return null;
  });

  /* ---------------- discovery ---------------- */

  app.post('/api/v1/projects/:id/discovery', async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = repos.getProject(id);
    if (!project) throw notFound('Project');
    const opts = parseBody(
      z.object({
        captureScreenshots: z.boolean().optional(),
        maxScreensToCapture: z.number().int().min(1).max(60).optional(),
        fetchDesignReferences: z.boolean().optional(),
      }),
      req.body ?? {},
    );

    const job = jobs.enqueue('discovery', id, (ctx) => runDiscovery(repos, project, ctx, opts));
    reply.code(202);
    return { jobId: job.id };
  });

  app.get('/api/v1/projects/:id/discovery', async (req) => {
    const { id } = req.params as { id: string };
    const run = repos.getLatestDiscoveryRun(id);
    if (!run) throw notFound('Discovery run');
    return { ...run, warnings: JSON.parse(run.warnings ?? '[]') };
  });

  app.get('/api/v1/projects/:id/screens', async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { classification?: string; reachable?: string };
    return repos.listScreens(id, {
      classification: q.classification,
      reachable: q.reachable === undefined ? undefined : q.reachable === 'true',
    });
  });

  app.get('/api/v1/projects/:id/graph', async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { kind?: string };
    const screens = repos.listScreens(id).filter((s) => s.classification !== 'component');
    const edges = repos.listEdges(id, q.kind);
    return { nodes: screens, edges };
  });

  app.get('/api/v1/projects/:id/flows', async (req) => {
    const { id } = req.params as { id: string };
    const screens = repos.listScreens(id);
    const edges = repos.listEdges(id);
    const analysis = analyzeGraph({
      screens: screens.map(toGraphNode),
      edges: edges.map(toGraphEdge),
      flows: [],
      urlStartNodeId: null,
      selectedEntryNodeIds: repos.listEntryPoints(id).filter((e) => e.selected).map((e) => e.nodeId),
    });
    const byId = new Map(screens.map((s) => [s.nodeId, s]));
    return analysis.flows.map((nodeIds, i) => ({
      index: i,
      size: nodeIds.length,
      screens: nodeIds.map((n) => ({ nodeId: n, name: byId.get(n)?.name ?? n })),
    }));
  });

  app.get('/api/v1/projects/:id/entry-points', async (req) => {
    const { id } = req.params as { id: string };
    return repos.listEntryPoints(id);
  });

  app.post('/api/v1/projects/:id/entry-points/select', async (req) => {
    const { id } = req.params as { id: string };
    const { nodeIds } = parseBody(z.object({ nodeIds: z.array(z.string()).min(1) }), req.body);
    repos.selectEntryPoints(id, nodeIds);

    // Reachability depends on the selection, so recompute it immediately.
    const screens = repos.listScreens(id);
    const edges = repos.listEdges(id);
    const analysis = analyzeGraph({
      screens: screens.map(toGraphNode),
      edges: edges.map(toGraphEdge),
      flows: [],
      urlStartNodeId: null,
      selectedEntryNodeIds: nodeIds,
    });
    const reasons = new Map<string, string>();
    for (const s of screens) {
      if (!analysis.reachable.has(s.nodeId)) {
        reasons.set(
          s.nodeId,
          analysis.disconnected.includes(s.nodeId) ? 'disconnected-canvas' : 'no-incoming-navigate-edge',
        );
      }
    }
    repos.setScreenReachability(id, analysis.reachable, reasons);
    return { reachable: analysis.reachable.size, unreachable: analysis.unreachable.length };
  });

  app.get('/api/v1/projects/:id/coverage', async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { executionId?: string };
    return repos.getCoverage(id, q.executionId ?? null);
  });

  /* ---------------- jobs ---------------- */

  app.get('/api/v1/jobs/:id', async (req) => {
    const { id } = req.params as { id: string };
    const job = repos.getJob(id);
    if (!job) throw notFound('Job');
    return job;
  });

  /**
   * Jobs belonging to a project, newest first.
   *
   * A job runs on the server and keeps running when the browser navigates
   * away - closing the progress stream never cancels it. What was missing was
   * any way back IN: leaving a page and returning left the work invisible, so
   * a run still in flight looked like one that had silently stopped. A page can
   * now ask what is active for the project and re-attach to its stream.
   */
  app.get('/api/v1/projects/:id/jobs', async (req) => {
    const { id } = req.params as { id: string };
    if (!repos.getProject(id)) throw notFound('Project');
    const q = req.query as { status?: string; kind?: string };
    let jobs = repos.listJobs(id);
    if (q.status) {
      const wanted = new Set(q.status.split(',').filter(Boolean));
      jobs = jobs.filter((j) => wanted.has(j.status));
    }
    if (q.kind) {
      const wanted = new Set(q.kind.split(',').filter(Boolean));
      jobs = jobs.filter((j) => wanted.has(j.kind));
    }
    return jobs;
  });

  app.post('/api/v1/jobs/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    if (!repos.getJob(id)) throw notFound('Job');
    const wasRunning = jobs.cancel(id);
    return { cancelled: true, wasRunning };
  });

  /** SSE progress stream. Paired with GET /jobs/:id for late joiners. */
  app.get('/api/v1/jobs/:id/events', async (req, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const job = repos.getJob(id);
    if (!job) throw notFound('Job');

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Replay current state so a late subscriber is immediately consistent.
    send('progress', {
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      message: job.message,
      phase: job.phase,
    });

    if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') {
      send('done', { jobId: job.id, status: job.status, result: job.result, error: job.error });
      reply.raw.end();
      return reply;
    }

    const unsubscribe = jobs.subscribe(id, (e) => {
      send('progress', e);
      if (e.status === 'succeeded' || e.status === 'failed' || e.status === 'cancelled') {
        const latest = repos.getJob(id);
        send('done', {
          jobId: id,
          status: e.status,
          result: latest?.result ?? null,
          error: latest?.error ?? null,
        });
        unsubscribe();
        reply.raw.end();
      }
    });

    const keepAlive = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
    req.raw.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
    });

    return reply;
  });

  /* ---------------- feature modules ---------------- */

  await registerPersonaRoutes(app, deps);
  await registerTestPlanRoutes(app, deps);
  await registerExecutionRoutes(app, deps);
  await registerAiRoutes(app, deps);

  /* ---------------- error handling ---------------- */

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      // internalDetail is logged but never serialized to the client.
      if (err.internalDetail) app.log.error({ code: err.code, detail: err.internalDetail }, err.message);
      return reply.code(err.statusCode).send(err.toResponse());
    }
    if ((err as { validation?: unknown }).validation) {
      return reply.code(400).send({
        error: { code: ERROR_CODES.VALIDATION_FAILED, message: 'Request validation failed' },
      });
    }
    app.log.error({ err }, 'Unhandled error');
    return reply.code(500).send({
      error: { code: ERROR_CODES.INTERNAL, message: 'An internal error occurred' },
    });
  });

  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ error: { code: ERROR_CODES.NOT_FOUND, message: 'Route not found' } }),
  );
}

/* ---------------- mappers between persisted rows and graph inputs ---------------- */

export const toGraphNode = (s: {
  nodeId: string; name: string; canvasId: string; canvasName: string;
  classification: string; deviceClass: string; width: number; height: number; absX: number; absY: number;
}) => ({
  nodeId: s.nodeId,
  name: s.name,
  canvasId: s.canvasId,
  canvasName: s.canvasName,
  classification: s.classification as 'screen' | 'component' | 'ambiguous',
  deviceClass: s.deviceClass,
  width: s.width,
  height: s.height,
  absX: s.absX,
  absY: s.absY,
});

export const toGraphEdge = (e: {
  fromScreenId: string; toScreenId: string; kind: string; supported: boolean;
}) => ({
  fromNodeId: e.fromScreenId,
  toNodeId: e.toScreenId,
  kind: e.kind as 'screen' | 'overlay' | 'ui-state',
  supported: e.supported,
});

export const ALL_AI_TASKS = AI_TASKS;
export type { AiTask };
