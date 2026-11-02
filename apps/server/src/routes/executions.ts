import fs from 'node:fs';
import { z } from 'zod';
import { DeviceSelection } from '@lenz/shared';
import { notFound, planNotApproved } from '../core/errors.js';
import { listDeviceProfiles, resolveDevice } from '../browser/devices.js';
import { analyzeExecution } from '../services/analysis.js';
import {
  isPaused,
  pauseExecution,
  resumeExecution,
  runExecution,
} from '../services/execution.js';
import { buildHeatmap, buildScrollReport } from '../services/heatmap.js';
import { buildResponsiveComparison } from '../services/responsive.js';
import { buildReportHtml, loadImages, renderPdf } from '../services/report.js';
import { seekOffsetForAction } from '../services/interaction-recorder.js';
import { parseBody, type LenzApp, type RouteDeps } from './index.js';

/** Device selection may be sent on its own or nested, so accept both shapes. */
const ExecuteBody = DeviceSelection.extend({
  device: DeviceSelection.nullable().optional(),
});

export async function registerExecutionRoutes(app: LenzApp, deps: RouteDeps): Promise<void> {
  const { repos, jobs } = deps;

  /**
   * The device catalogue.
   *
   * Served from the server rather than hard-coded in the UI because the
   * geometry is reconciled against the installed Playwright build - the
   * selector must offer what will actually run, not what was true when the
   * frontend was written.
   */
  app.get('/api/v1/devices', async () => ({
    devices: listDeviceProfiles(),
    defaultDeviceId: resolveDevice(null).profile.id,
    note: 'Every profile is browser emulation in Chromium. Viewport, device pixel ratio, touch input and user agent are reproduced; a physical device’s browser engine, performance, network and OS gestures are not.',
  }));

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

    const body = parseBody(ExecuteBody, req.body ?? {});
    const { profile } = resolveDevice(body.device ?? body);

    // The profile is stored BEFORE the run starts, so the recorded device and
    // the device that ran can never disagree.
    const execution = repos.createExecution(project.id, plan.id, persona.id, 'live', profile);
    repos.updateProject(project.id, { status: 'testing' });

    const job = jobs.enqueue('execution', project.id, (ctx) =>
      runExecution(repos, project, plan, persona, execution.id, ctx),
    );
    reply.code(202);
    return { jobId: job.id, executionId: execution.id, device: profile };
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
    const video = repos.getVideoForExecution(id);
    const interactions = repos.listInteractionEvents({ executionId: id });

    return {
      execution,
      video,
      /**
       * How to convert an action offset into a video time.
       *
       * Both the action offsets and the interaction offsets are measured from
       * the execution clock; the recording starts later, when the browser page
       * exists. `videoStartOffsetMs` is that gap. A recording made before this
       * was tracked has none, and `timingExact` is false so the player can say
       * the alignment is approximate instead of quietly showing it as precise.
       */
      videoStartOffsetMs: video?.startOffsetMs ?? null,
      timingExact: video?.startOffsetMs !== null && video?.startOffsetMs !== undefined,
      interactions,
      actions: repos.listActions(id).map((a) => {
        const mine = interactions.filter((e) => e.actionId === a.id);
        // See seekOffsetForAction: the action's own offset is stamped when the
        // step finishes, which is seconds after the click it describes.
        const seekOffsetMs = seekOffsetForAction(
          a.offsetMs,
          mine.map((e) => e.elapsedMs),
        );
        return {
          ...a,
          screenshot: a.screenshotId ? (shots.get(a.screenshotId) ?? null) : null,
          /** Interactions recorded while this action ran, for the video markers. */
          interactions: mine,
          seekOffsetMs,
        };
      }),
    };
  });

  /* ---------------- interaction tracking ---------------- */

  app.get('/api/v1/executions/:id/interactions', async (req) => {
    const { id } = req.params as { id: string };
    if (!repos.getExecution(id)) throw notFound('Execution');
    const q = req.query as { type?: string };
    return repos.listInteractionEvents({
      executionId: id,
      types: q.type ? q.type.split(',').filter(Boolean) : undefined,
    });
  });

  app.get('/api/v1/executions/:id/scroll', async (req) => {
    const { id } = req.params as { id: string };
    const execution = repos.getExecution(id);
    if (!execution) throw notFound('Execution');
    const samples = repos.listScrollSamples({ executionId: id });
    return buildScrollReport({ projectId: execution.projectId, samples });
  });

  /**
   * Click/tap heatmap for a project.
   *
   * Aggregation is deterministic and runs over recorded coordinates only; see
   * services/heatmap.ts. Filters narrow which runs contribute - they never
   * change how a contributing event is placed.
   */
  app.get('/api/v1/projects/:id/heatmap', async (req) => {
    const { id } = req.params as { id: string };
    if (!repos.getProject(id)) throw notFound('Project');
    const q = req.query as {
      executionIds?: string;
      screenId?: string;
      deviceId?: string;
      personaId?: string;
      planId?: string;
    };
    const executionIds = q.executionIds?.split(',').filter(Boolean);
    const events = repos.listInteractionEvents({
      projectId: id,
      executionIds,
      screenId: q.screenId,
      deviceId: q.deviceId,
      personaId: q.personaId,
      planId: q.planId,
    });
    return buildHeatmap({
      projectId: id,
      events,
      screenshots: repos.listScreenshots({ projectId: id }),
    });
  });

  app.get('/api/v1/projects/:id/scroll', async (req) => {
    const { id } = req.params as { id: string };
    if (!repos.getProject(id)) throw notFound('Project');
    const q = req.query as {
      executionIds?: string;
      screenId?: string;
      deviceId?: string;
      personaId?: string;
    };
    const samples = repos.listScrollSamples({
      projectId: id,
      executionIds: q.executionIds?.split(',').filter(Boolean),
      screenId: q.screenId,
      deviceId: q.deviceId,
      personaId: q.personaId,
    });
    return buildScrollReport({ projectId: id, samples });
  });

  /**
   * Responsive comparison across device runs of the same plan.
   *
   * Defaults to the most recent run per device so the common case - run the
   * plan on three devices, compare - needs no parameters.
   */
  app.get('/api/v1/projects/:id/responsive', async (req) => {
    const { id } = req.params as { id: string };
    if (!repos.getProject(id)) throw notFound('Project');
    const q = req.query as { planId?: string; executionIds?: string };

    const all = repos.listExecutions(id);
    const explicit = q.executionIds?.split(',').filter(Boolean);

    let chosen = all;
    if (explicit && explicit.length > 0) {
      const wanted = new Set(explicit);
      chosen = all.filter((e) => wanted.has(e.id));
    } else {
      const planId = q.planId ?? all.find((e) => e.device !== null)?.planId ?? all[0]?.planId;
      const ofPlan = all.filter((e) => e.planId === planId);
      // listExecutions is newest-first, so the first entry per device wins.
      const seen = new Set<string>();
      chosen = ofPlan.filter((e) => {
        const key = e.device?.id ?? 'unrecorded';
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    const plan = chosen[0] ? repos.getPlan(chosen[0].planId) : null;
    return buildResponsiveComparison({
      projectId: id,
      plan,
      runs: chosen.map((execution) => ({
        execution,
        actions: repos.listActions(execution.id),
        interactions: repos.listInteractionEvents({ executionId: execution.id }),
        scrollSamples: repos.listScrollSamples({ executionId: execution.id }),
        screenshots: repos.listScreenshots({ executionId: execution.id }),
      })),
    });
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

    // A retry re-runs the same conditions unless the caller asks otherwise;
    // changing the device silently would make the two runs incomparable.
    const body = parseBody(ExecuteBody, req.body ?? {});
    const requested = body.device ?? body;
    const device =
      requested.presetId || requested.custom
        ? resolveDevice(requested).profile
        : (previous.device ?? resolveDevice(null).profile);

    const execution = repos.createExecution(project.id, plan.id, persona.id, 'live', device);
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
        device: e.device,
        interactionCount: repos.listInteractionEvents({ executionId: e.id }).length,
      })),
      /**
       * Device-specific evidence for the report.
       *
       * Heatmaps are grouped by screen AND viewport geometry, so a report can
       * show a mobile map beside a desktop one without implying the two sets of
       * coordinates are comparable.
       */
      interactionAnalytics: {
        heatmap: buildHeatmap({
          projectId: id,
          events: repos.listInteractionEvents({ projectId: id }),
          screenshots: repos.listScreenshots({ projectId: id }),
        }),
        scroll: buildScrollReport({
          projectId: id,
          samples: repos.listScrollSamples({ projectId: id }),
        }),
      },
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

  /* ---------------- printable report ---------------- */

  /**
   * Gather everything one report needs.
   *
   * `executionId` narrows it to a single session; without it the report covers
   * the whole project. Both produce the same document structure, so a reader
   * never has to learn two layouts.
   */
  const gatherReport = async (projectId: string, executionId?: string) => {
    const project = repos.getProject(projectId);
    if (!project) throw notFound('Project');

    const allExecutions = repos.listExecutions(projectId);
    const chosen = executionId
      ? allExecutions.filter((e) => e.id === executionId)
      : allExecutions;

    const executions = chosen.map((execution) => ({
      execution,
      plan: repos.getPlan(execution.planId),
      persona: repos.getPersona(execution.personaId),
      actions: repos.listActions(execution.id),
      coverage: repos.getCoverage(projectId, execution.id),
      interactionCount: repos.listInteractionEvents({ executionId: execution.id }).length,
    }));

    const findings = executionId
      ? repos.listFindings({ executionId })
      : repos.listFindings({ projectId });

    const screenshots = executionId
      ? repos.listScreenshots({ executionId })
      : repos.listScreenshots({ projectId });

    const events = executionId
      ? repos.listInteractionEvents({ executionId })
      : repos.listInteractionEvents({ projectId });

    const samples = executionId
      ? repos.listScrollSamples({ executionId })
      : repos.listScrollSamples({ projectId });

    const heatmap = buildHeatmap({ projectId, events, screenshots });
    const scroll = buildScrollReport({ projectId, samples });

    // Embed only what the report actually shows: evidence attached to a
    // finding, plus the backgrounds the heatmaps draw over.
    const wanted = new Set<string>();
    for (const f of findings) if (f.screenshotId) wanted.add(f.screenshotId);
    for (const g of heatmap.groups) if (g.screenshotId) wanted.add(g.screenshotId);
    const toEmbed = screenshots.filter((s) => wanted.has(s.id));
    const { images, omitted } = await loadImages(toEmbed);

    // A responsive comparison only makes sense across several device runs.
    const byDevice = new Set(allExecutions.map((e) => e.device?.id ?? 'unrecorded'));
    let responsive = null;
    if (!executionId && byDevice.size > 1) {
      const planId = allExecutions[0]?.planId;
      const seen = new Set<string>();
      const runs = allExecutions
        .filter((e) => e.planId === planId)
        .filter((e) => {
          const key = e.device?.id ?? 'unrecorded';
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      if (runs.length > 1) {
        responsive = buildResponsiveComparison({
          projectId,
          plan: repos.getPlan(runs[0]!.planId),
          runs: runs.map((execution) => ({
            execution,
            actions: repos.listActions(execution.id),
            interactions: repos.listInteractionEvents({ executionId: execution.id }),
            scrollSamples: repos.listScrollSamples({ executionId: execution.id }),
            screenshots: repos.listScreenshots({ executionId: execution.id }),
          })),
        });
      }
    }

    return {
      project,
      generatedAt: new Date().toISOString(),
      executions,
      findings,
      screenshotsById: new Map(screenshots.map((s) => [s.id, s])),
      imagesById: images,
      omittedImages: omitted,
      discoveryCoverage: repos.getCoverage(projectId, null),
      heatmap,
      scroll,
      responsive,
      screenCount: repos.listScreens(projectId).filter((s) => s.classification !== 'component').length,
    };
  };

  const safeFileName = (name: string): string =>
    name.replace(/[^a-zA-Z0-9-_ ]/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'report';

  app.get('/api/v1/projects/:id/report.pdf', async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = await gatherReport(id);
    const pdf = await renderPdf(buildReportHtml(data), {
      title: `${data.project.name} — UX validation report`,
    });
    const date = new Date().toISOString().slice(0, 10);
    return reply
      .type('application/pdf')
      .header(
        'Content-Disposition',
        `attachment; filename="${safeFileName(data.project.name)}-ux-report-${date}.pdf"`,
      )
      .send(pdf);
  });

  /** The same document as HTML, for a quick look without downloading a file. */
  app.get('/api/v1/projects/:id/report.html', async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = await gatherReport(id);
    return reply.type('text/html; charset=utf-8').send(buildReportHtml(data));
  });

  app.get('/api/v1/executions/:id/report.pdf', async (req, reply) => {
    const { id } = req.params as { id: string };
    const execution = repos.getExecution(id);
    if (!execution) throw notFound('Execution');
    const data = await gatherReport(execution.projectId, id);
    const pdf = await renderPdf(buildReportHtml(data), {
      title: `${data.project.name} — session report`,
    });
    const date = new Date().toISOString().slice(0, 10);
    return reply
      .type('application/pdf')
      .header(
        'Content-Disposition',
        `attachment; filename="${safeFileName(data.project.name)}-session-${date}.pdf"`,
      )
      .send(pdf);
  });

  app.get('/api/v1/executions/:id/report.html', async (req, reply) => {
    const { id } = req.params as { id: string };
    const execution = repos.getExecution(id);
    if (!execution) throw notFound('Execution');
    const data = await gatherReport(execution.projectId, id);
    return reply.type('text/html; charset=utf-8').send(buildReportHtml(data));
  });

  /* keeps zod import used for future query validation */
  void z;
}
