import { z } from 'zod';
import { TechnicalProficiency } from '@lenz/shared';
import { notFound } from '../core/errors.js';
import { generatePersonas } from '../services/personas.js';
import { parseBody, type LenzApp, type RouteDeps } from './index.js';

const PersonaInput = z.object({
  projectId: z.string().nullable().optional(),
  name: z.string().min(1).max(120),
  ageRange: z.string().max(40).nullable().optional(),
  background: z.string().max(2000).default(''),
  technicalProficiency: TechnicalProficiency.default('medium'),
  digitalExperience: z.string().max(2000).default(''),
  goals: z.array(z.string().max(300)).default([]),
  motivations: z.array(z.string().max(300)).default([]),
  frustrations: z.array(z.string().max(300)).default([]),
  accessibilityNeeds: z.array(z.string().max(300)).default([]),
  behavioralCharacteristics: z.array(z.string().max(300)).default([]),
  expectations: z.array(z.string().max(300)).default([]),
});

export async function registerPersonaRoutes(app: LenzApp, deps: RouteDeps): Promise<void> {
  const { repos, jobs } = deps;

  app.post('/api/v1/personas', async (req, reply) => {
    const body = parseBody(PersonaInput, req.body);
    const persona = repos.createPersona({
      ...body,
      projectId: body.projectId ?? null,
      ageRange: body.ageRange ?? null,
      origin: 'manual',
      generatedByModel: null,
    });
    reply.code(201);
    return persona;
  });

  app.post('/api/v1/projects/:id/personas/generate', async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = repos.getProject(id);
    if (!project) throw notFound('Project');
    const body = parseBody(
      z.object({
        count: z.number().int().min(1).max(6).default(3),
        guidance: z.string().max(1000).nullable().optional(),
      }),
      req.body ?? {},
    );

    const job = jobs.enqueue('personaGeneration', id, async (ctx) => {
      ctx.progress(0.1, 'Generating personas', 'ai');
      const personas = await generatePersonas(repos, project, body.count, body.guidance ?? null);
      ctx.progress(1, `${personas.length} personas created`, 'done');
      return { personaIds: personas.map((p) => p.id) };
    });
    reply.code(202);
    return { jobId: job.id };
  });

  app.get('/api/v1/personas', async (req) => {
    const q = req.query as { projectId?: string };
    return repos.listPersonas(q.projectId);
  });

  app.get('/api/v1/personas/:id', async (req) => {
    const { id } = req.params as { id: string };
    const persona = repos.getPersona(id);
    if (!persona) throw notFound('Persona');
    return persona;
  });

  app.patch('/api/v1/personas/:id', async (req) => {
    const { id } = req.params as { id: string };
    if (!repos.getPersona(id)) throw notFound('Persona');
    repos.updatePersona(id, parseBody(PersonaInput.partial(), req.body) as never);
    return repos.getPersona(id);
  });

  app.delete('/api/v1/personas/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!repos.getPersona(id)) throw notFound('Persona');
    repos.deletePersona(id);
    reply.code(204);
    return null;
  });
}
