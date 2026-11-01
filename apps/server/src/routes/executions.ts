import fs from 'node:fs';
import { z } from 'zod';
import { notFound, planNotApproved } from '../core/errors.js';
import { analyzeExecution } from '../services/analysis.js';
import {
  isPaused,
  pauseExecution,
  resumeExecution,
  runExecution,
} from '../services/execution.js';
import { parseBody, type LenzApp, type RouteDeps } from './index.js';

export async function registerExecutionRoutes(app: LenzApp, deps: RouteDeps): Promise<void> {
  const { repos, jobs } = deps;

  app.post('/api/v1/test-plans/:id/execute', async (req, reply) => {
    const { id } = req.params as { id: string };
    const plan = repos.getPlan(id);
    if (!plan) throw notFound('Test plan');
    const project = repos.getProject(plan.projectId);
    if (!project) throw notFound('Project');
    const persona = repos.getPersona(plan.personaId);
    if (!persona) throw notFound('Persona');

    // The approval gate. Only an explicit project setting bypasses it.
    if (plan.status !== 'approved' && !project.autoApprovePlans) throw planNotApproved();

    const execution = repos.createExecution(project.id, plan.id, persona.id, 'live');
    repos.updateProject(project.id, { status: 'testing' });

    const job = jobs.enqueue('execution', project.id, (ctx) =>
      runExecution(repos, project, plan, persona, execution.id, ctx),
    );
    reply.code(202);
    return { jobId: job.id, executionId: execution.id };
  });

  app.get('/api/v1/projects/:id/executions', async (req) => {
    const { id } = req.params as { id: string };
    return repos.listExecutions(id);
  });

  app.get('/api/v1/executions/:id', async (req) => {
    const { id } = req.params as { id: string };
    const execution = repos.getExecution(id);
    if (!execution) throw notFound('Execution');
    return { ...execution, paused: isPaused(id) };
  });

  app.get('/api/v1/executions/:id/actions', async (req) => {
    const { id } = req.params as { id: string };
    if (!repos.getExecution(id)) throw notFound('Execution');
    return repos.listActions(id);
  });

  /** Timeline joins actions, screenshots and video offsets for the Recap view. */
  app.get('/api/v1/executions/:id/timeline', async (req) => {
    const { id } = req.params as { id: string };
    const execution = repos.getExecution(id);
    if (!execution) throw notFound('Execution');
    const shots = new Map(repos.listScreenshots({ executionId: id }).map((s) => [s.id, s]));
    return {
      execution,
      video: repos.getVideoForExecution(id),
      actions: repos.listActions(id).map((a) => ({
        ...a,
        screenshot: a.screenshotId ? (shots.get(a.screenshotId) ?? null) : null,
      })),
    };
  });

  for (const op of ['pause', 'resume', 'stop'] as const) {
    app.post(`/api/v1/executions/:id/${op}`, async (req) => {
      const { id } = req.params as { id: string };
      const execution = repos.getExecution(id);
      if (!execution) throw notFound('Execution');

      if (op === 'pause') {
        pauseExecution(id);
        repos.updateExecution(id, { status: 'paused' });
      } else if (op === 'resume') {
        resumeExecution(id);
        repos.updateExecution(id, { status: 'running' });
      } else {
        resumeExecution(id);
        // Cancel the owning job so the browser is released promptly.
        const job = repos.listJobs(execution.projectId).find((j) => j.kind === 'execution' && j.status === 'running');
        if (job) jobs.cancel(job.id);
        repos.updateExecution(id, { status: 'cancelled', endedAt: new Date().toISOString() });
      }
      return repos.getExecution(id);
    });
  }

  app.post('/api/v1/executions/:id/retry', async (req, reply) => {
    const { id } = req.params as { id: string };
    const previous = repos.getExecution(id);
    if (!previous) throw notFound('Execution');
    const plan = repos.getPlan(previous.planId);
    const project = repos.getProject(previous.projectId);
    const persona = repos.getPersona(previous.personaId);
    if (!plan || !project || !persona) throw notFound('Execution context');

    const execution = repos.createExecution(project.id, plan.id, persona.id, 'live');
    const job = jobs.enqueue('execution', project.id, (ctx) =>
      runExecution(repos, project, plan, persona, execution.id, ctx),
    );
    reply.code(202);
    return { jobId: job.id, executionId: execution.id };
  });

  /* ---------------- evidence ---------------- */

  app.get('/api/v1/projects/:id/screenshots', async (req) => {
    const { id } = req.params as { id: string };
    return repos.listScreenshots({ projectId: id });
  });

  app.get('/api/v1/executions/:id/screenshots', async (req) => {
    const { id } = req.params as { id: string };
    return repos.listScreenshots({ executionId: id });
  });

  app.get('/api/v1/screenshots/:id/file', async (req, reply) => {
    const { id } = req.params as { id: string };
    const shot = repos.getScreenshot(id);
    if (!shot || shot.status !== 'valid' || !shot.path) throw notFound('Screenshot file');
    if (!fs.existsSync(shot.path)) throw notFound('Screenshot file');
    return reply.type('image/png').send(fs.createReadStream(shot.path));
  });

  app.get('/api/v1/executions/:id/video', async (req) => {
    const { id } = req.params as { id: string };
    const video = repos.getVideoForExecution(id);
    if (!video) throw notFound('Video');
    return video;
  });

  /** Range-request streaming, required for seeking in the Recap player. */
  app.get('/api/v1/executions/:id/video/file', async (req, reply) => {
    const { id } = req.params as { id: string };
    const video = repos.getVideoForExecution(id);
    if (!video || !video.path || !fs.existsSync(video.path)) throw notFound('Video file');

    const total = fs.statSync(video.path).size;
    const range = req.headers.range;

    if (!range) {
      return reply
        .header('Content-Length', total)
        .header('Accept-Ranges', 'bytes')
        .type('video/webm')
        .send(fs.createReadStream(video.path));
    }

    const match = /bytes=(\d*)-(\d*)/.exec(range);
    const start = match?.[1] ? Number(match[1]) : 0;
    const end = match?.[2] ? Number(match[2]) : total - 1;
    if (start >= total) {
      return reply.code(416).header('Content-Range', `bytes */${total}`).send();
    }
    return reply
      .code(206)
      .header('Content-Range', `bytes ${start}-${end}/${total}`)
      .header('Accept-Ranges', 'bytes')
      .header('Content-Length', end - start + 1)
      .type('video/webm')
      .send(fs.createReadStream(video.path, { start, end }));
  });

  /* ---------------- UX analysis ---------------- */

  app.post('/api/v1/executions/:id/analysis', async (req, reply) => {
    const { id } = req.params as { id: string };
    const execution = repos.getExecution(id);
    if (!execution) throw notFound('Execution');
    const project = repos.getProject(execution.projectId);
    const plan = repos.getPlan(execution.planId);
    const persona = repos.getPersona(execution.personaId);
    if (!project || !plan || !persona) throw notFound('Execution context');

    const job = jobs.enqueue('analysis', project.id, async (ctx) => {
      const findings = await analyzeExecution(repos, project, execution, plan, persona, ctx);
      repos.updateProject(project.id, { status: 'analyzed' });
      return { findingIds: findings.map((f) => f.id), count: findings.length };
    });
    reply.code(202);
    return { jobId: job.id };
  });

  app.get('/api/v1/executions/:id/findings', async (req) => {
    const { id } = req.params as { id: string };
    return repos.listFindings({ executionId: id });
  });

  app.get('/api/v1/projects/:id/findings', async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { severity?: string; category?: string; evidenceType?: string };
    let findings = repos.listFindings({ projectId: id });
    if (q.severity) findings = findings.filter((f) => f.severity === q.severity);
    if (q.category) findings = findings.filter((f) => f.category === q.category);
    if (q.evidenceType) findings = findings.filter((f) => f.evidenceType === q.evidenceType);
    return findings;
  });

  /**
   * Project report.
   *
   * There is deliberately no single "UX score": the brief forbids arbitrary or
   * unexplained scoring, and no defensible scoring methodology has been
   * established for this data. The report instead reports severity counts,
   * evidence quality and coverage, each of which IS defensible.
   */
  app.post('/api/v1/projects/:id/report', async (req) => {
    const { id } = req.params as { id: string };
    const project = repos.getProject(id);
    if (!project) throw notFound('Project');
    const findings = repos.listFindings({ projectId: id });
    const executions = repos.listExecutions(id);

    const count = (pred: (f: (typeof findings)[number]) => boolean) => findings.filter(pred).length;

    return {
      project,
      generatedAt: new Date().toISOString(),
      scoring: {
        available: false,
        reason:
          'Lenz does not publish a single UX score. A score would require a documented, validated methodology; severity counts, evidence quality and coverage are reported instead.',
      },
      findings: {
        total: findings.length,
        bySeverity: {
          critical: count((f) => f.severity === 'critical'),
          high: count((f) => f.severity === 'high'),
          medium: count((f) => f.severity === 'medium'),
          low: count((f) => f.severity === 'low'),
          info: count((f) => f.severity === 'info'),
        },
        byEvidence: {
          observed: count((f) => f.evidenceType === 'observed'),
          potential: count((f) => f.evidenceType === 'potential'),
          heuristic: count((f) => f.evidenceType === 'heuristic'),
          needsHumanValidation: count((f) => f.evidenceType === 'needs-human-validation'),
        },
        items: findings,
      },
      executions: executions.map((e) => ({
        id: e.id,
        status: e.status,
        planName: e.planName,
        personaName: e.personaName,
        actionCount: e.actionCount,
      })),
      coverage: {
        discovery: repos.getCoverage(id, null),
        byExecution: executions.map((e) => ({
          executionId: e.id,
          metrics: repos.getCoverage(id, e.id),
        })),
      },
    };
  });

  app.get('/api/v1/projects/:id/report', async (req) => {
    const { id } = req.params as { id: string };
    if (!repos.getProject(id)) throw notFound('Project');
    // Reports are computed on demand; GET mirrors POST for convenience.
    return app.inject({ method: 'POST', url: `/api/v1/projects/${id}/report` }).then((r) => r.json());
  });

  /* keeps zod import used for future query validation */
  void z;
}
