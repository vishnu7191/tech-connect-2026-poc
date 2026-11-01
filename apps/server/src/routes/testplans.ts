import { z } from 'zod';
import { StepActionType } from '@lenz/shared';
import { notFound, validationFailed } from '../core/errors.js';
import { generateTestPlans } from '../services/testplans.js';
import { parseBody, type LenzApp, type RouteDeps } from './index.js';

const StepInput = z.object({
  index: z.number().int().min(0),
  description: z.string().min(1).max(1000),
  actionType: StepActionType,
  targetHint: z.string().max(300).nullable().optional(),
  expectedOutcome: z.string().max(1000).default(''),
  expectedScreenId: z.string().max(64).nullable().optional(),
  expectedScreenName: z.string().max(200).nullable().optional(),
});

export async function registerTestPlanRoutes(app: LenzApp, deps: RouteDeps): Promise<void> {
  const { repos, jobs } = deps;

  app.post('/api/v1/projects/:id/test-plans/generate', async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = repos.getProject(id);
    if (!project) throw notFound('Project');
    const body = parseBody(
      z.object({
        personaId: z.string(),
        count: z.number().int().min(1).max(4).default(1),
        objective: z.string().max(1000).nullable().optional(),
      }),
      req.body,
    );
    const persona = repos.getPersona(body.personaId);
    if (!persona) throw notFound('Persona');

    const job = jobs.enqueue('testPlanGeneration', id, async (ctx) => {
      ctx.progress(0.1, 'Generating test plans from the discovered graph', 'ai');
      const plans = await generateTestPlans(repos, project, persona, body.count, body.objective ?? null);
      ctx.progress(1, `${plans.length} plan(s) created`, 'done');
      return { planIds: plans.map((p) => p.id) };
    });
    reply.code(202);
    return { jobId: job.id };
  });

  app.post('/api/v1/projects/:id/test-plans', async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = repos.getProject(id);
    if (!project) throw notFound('Project');
    const body = parseBody(
      z.object({
        personaId: z.string(),
        name: z.string().min(1).max(200),
        objective: z.string().max(1000).default(''),
        scenario: z.string().max(3000).default(''),
        preconditions: z.string().max(1000).nullable().optional(),
        startScreenId: z.string().nullable().optional(),
        successCriteria: z.array(z.string().max(400)).default([]),
        frictionPoints: z.array(z.string().max(400)).default([]),
        steps: z.array(StepInput).min(1).max(40),
      }),
      req.body,
    );
    if (!repos.getPersona(body.personaId)) throw notFound('Persona');

    const screens = repos.listScreens(id);
    const nameOf = new Map(screens.map((s) => [s.nodeId, s.name]));

    const plan = repos.createPlan(
      {
        projectId: id,
        personaId: body.personaId,
        name: body.name,
        objective: body.objective,
        scenario: body.scenario,
        preconditions: body.preconditions ?? null,
        startScreenId: body.startScreenId ?? null,
        startScreenName: body.startScreenId ? (nameOf.get(body.startScreenId) ?? null) : null,
        screensInvolved: [
          ...new Set(
            [body.startScreenId, ...body.steps.map((s) => s.expectedScreenId)].filter(Boolean) as string[],
          ),
        ],
        successCriteria: body.successCriteria,
        frictionPoints: body.frictionPoints,
        status: 'draft',
        approvedAt: null,
        origin: 'manual',
        generatedByModel: null,
      },
      body.steps.map((s) => ({
        index: s.index,
        description: s.description,
        actionType: s.actionType,
        targetHint: s.targetHint ?? null,
        expectedOutcome: s.expectedOutcome,
        expectedScreenId: s.expectedScreenId ?? null,
        expectedScreenName: s.expectedScreenId ? (nameOf.get(s.expectedScreenId) ?? null) : null,
      })),
    );
    reply.code(201);
    return plan;
  });

  app.get('/api/v1/projects/:id/test-plans', async (req) => {
    const { id } = req.params as { id: string };
    return repos.listPlans(id);
  });

  app.get('/api/v1/test-plans/:id', async (req) => {
    const { id } = req.params as { id: string };
    const plan = repos.getPlan(id);
    if (!plan) throw notFound('Test plan');
    return plan;
  });

  app.patch('/api/v1/test-plans/:id', async (req) => {
    const { id } = req.params as { id: string };
    const plan = repos.getPlan(id);
    if (!plan) throw notFound('Test plan');
    const body = parseBody(
      z.object({
        name: z.string().min(1).max(200).optional(),
        objective: z.string().max(1000).optional(),
        scenario: z.string().max(3000).optional(),
        preconditions: z.string().max(1000).nullable().optional(),
        startScreenId: z.string().nullable().optional(),
        successCriteria: z.array(z.string().max(400)).optional(),
        frictionPoints: z.array(z.string().max(400)).optional(),
        steps: z.array(StepInput).min(1).max(40).optional(),
      }),
      req.body,
    );

    // Editing an approved plan returns it to draft: the human gate must be
    // re-passed, otherwise approval could be bypassed by editing after the fact.
    const statusPatch = plan.status === 'approved' ? { status: 'draft' as const, approvedAt: null } : {};
    const screens = repos.listScreens(plan.projectId);
    const nameOf = new Map(screens.map((s) => [s.nodeId, s.name]));

    repos.updatePlan(
      id,
      { ...body, ...statusPatch } as never,
      body.steps?.map((s) => ({
        index: s.index,
        description: s.description,
        actionType: s.actionType,
        targetHint: s.targetHint ?? null,
        expectedOutcome: s.expectedOutcome,
        expectedScreenId: s.expectedScreenId ?? null,
        expectedScreenName: s.expectedScreenId ? (nameOf.get(s.expectedScreenId) ?? null) : null,
      })),
    );
    return repos.getPlan(id);
  });

  app.post('/api/v1/test-plans/:id/approve', async (req) => {
    const { id } = req.params as { id: string };
    const plan = repos.getPlan(id);
    if (!plan) throw notFound('Test plan');
    if (plan.steps.length === 0) {
      throw validationFailed('A plan must have at least one step before it can be approved.');
    }
    repos.approvePlan(id);
    return repos.getPlan(id);
  });
}
