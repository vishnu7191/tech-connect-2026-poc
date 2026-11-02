import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useActiveJob } from '../lib/useActiveJob';
import {
  Badge,
  Card,
  Empty,
  ErrorState,
  Field,
  Progress,
  SectionTitle,
  Skeleton,
  STATUS_TONE,
} from '../components/ui';
import { DeviceChip } from '../components/DeviceSelector';
import { HeatmapPanel } from '../components/HeatmapPanel';

export default function TestPlans() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const [personaId, setPersonaId] = useState('');
  const [objective, setObjective] = useState('');

  const personas = useQuery({ queryKey: ['personas', id], queryFn: () => api.get<any[]>(`/personas?projectId=${id}`) });
  const plans = useQuery({ queryKey: ['plans', id], queryFn: () => api.get<any[]>(`/projects/${id}/test-plans`) });
  const executions = useQuery({ queryKey: ['executions', id], queryFn: () => api.get<any[]>(`/projects/${id}/executions`) });

  const job = useActiveJob(id, ['testPlanGeneration'], [['plans', id]]);

  const generate = useMutation({
    mutationFn: () =>
      api.post<{ jobId: string }>(`/projects/${id}/test-plans/generate`, {
        personaId: personaId || personas.data?.[0]?.id,
        count: 1,
        objective: objective || null,
      }),
    onSuccess: (r) => job.watch(r.jobId),
  });

  const approve = useMutation({
    mutationFn: (planId: string) => api.post(`/test-plans/${planId}/approve`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['plans', id] }),
  });

  // No device is sent, so the server applies its default desktop profile. The
  // run still records that profile, so the heatmaps and the comparison view
  // have the geometry they need without the user choosing anything here.
  const execute = useMutation({
    mutationFn: (planId: string) => api.post<{ executionId: string }>(`/test-plans/${planId}/execute`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['executions', id] });
      void qc.invalidateQueries({ queryKey: ['plans', id] });
    },
  });

  const noPersonas = personas.data?.length === 0;

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Test plans"
        subtitle="Generated from the real navigation graph, so every step refers to a screen that actually exists."
      />

      <Card>
        <SectionTitle title="Generate a plan" subtitle="Pick a persona and, optionally, what you want to learn." />
        {noPersonas ? (
          <div className="rounded-lg bg-surface-850 px-3.5 py-3">
            <p className="text-sm text-ink-300">
              You need a persona first — a plan is always written for someone.{' '}
              <Link to={`/projects/${id}/personas`} className="text-accent-400 hover:text-accent-300">
                Create one →
              </Link>
            </p>
          </div>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[14rem]">
              <Field label="Persona">
                <select className="input" value={personaId} onChange={(e) => setPersonaId(e.target.value)}>
                  <option value="">Select a persona…</option>
                  {personas.data?.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.technicalProficiency})
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="flex-1 min-w-[18rem]">
              <Field label="Objective (optional)">
                <input
                  className="input"
                  placeholder="e.g. find a dress and add it to the cart"
                  value={objective}
                  onChange={(e) => setObjective(e.target.value)}
                />
              </Field>
            </div>
            <button
              className="btn-primary"
              disabled={job.isActive || generate.isPending || (!personaId && !personas.data?.[0])}
              onClick={() => generate.mutate()}
            >
              {job.isActive ? 'Generating…' : 'Generate plan'}
            </button>
          </div>
        )}

        {job.jobId && job.status !== 'idle' && (
          <div className="mt-4">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-sm text-ink-300">{job.message}</span>
              <span className="text-xs tabular-nums text-ink-500">{Math.round(job.progress * 100)}%</span>
            </div>
            <Progress value={job.progress} tone={job.status === 'failed' ? 'bad' : 'accent'} />
            {job.error && <p className="text-sm text-bad-400 mt-2">{job.error}</p>}
          </div>
        )}
        {generate.error && <div className="mt-3"><ErrorState error={generate.error} /></div>}
      </Card>

      {executions.data && executions.data.length > 0 && (
        <Card>
          <SectionTitle title="Test sessions" subtitle="Each run records screenshots, a timeline and a full video." />
          <div className="space-y-2">
            {executions.data.map((e) => (
              <Link key={e.id} to={`/executions/${e.id}`} className="block">
                <div className="flex items-center justify-between gap-4 rounded-lg bg-surface-850 px-3.5 py-3 hover:bg-surface-800 transition-colors">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-ink-100 truncate">{e.planName}</span>
                      <Badge tone={STATUS_TONE[e.status] ?? 'neutral'}>{e.status}</Badge>
                      <DeviceChip device={e.device ?? null} />
                    </div>
                    <p className="text-2xs text-ink-500 mt-0.5">
                      {e.personaName} · {e.actionCount} actions · {e.navigationCount} navigations
                    </p>
                  </div>
                  <span className="text-accent-400 text-sm shrink-0">Open recap →</span>
                </div>
              </Link>
            ))}
          </div>
        </Card>
      )}

      {plans.isLoading && <Skeleton className="h-40" />}
      {plans.data?.length === 0 && (
        <Card pad={false}>
          <Empty title="No test plans yet" description="Generate one from a persona to begin autonomous testing." />
        </Card>
      )}

      <div className="space-y-4">
        {plans.data?.map((plan) => (
          <Card key={plan.id}>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-medium text-ink-100">{plan.name}</h3>
                  <Badge tone={STATUS_TONE[plan.status] ?? 'neutral'}>{plan.status}</Badge>
                  <Badge tone={plan.origin === 'ai' ? 'accent' : 'neutral'}>{plan.origin}</Badge>
                </div>
                <p className="text-sm text-ink-400 mt-1">{plan.objective}</p>
              </div>
              <div className="flex gap-2 shrink-0">
                {plan.status !== 'approved' ? (
                  <button className="btn-ghost" disabled={approve.isPending} onClick={() => approve.mutate(plan.id)}>
                    Approve
                  </button>
                ) : (
                  <button className="btn-primary" disabled={execute.isPending} onClick={() => execute.mutate(plan.id)}>
                    {execute.isPending ? 'Starting…' : 'Run test'}
                  </button>
                )}
              </div>
            </div>

            {plan.status !== 'approved' && (
              <p className="text-2xs text-warn-400 mt-2">
                Plans must be approved before they can run. Editing an approved plan returns it to draft.
              </p>
            )}

            {plan.scenario && (
              <p className="text-sm text-ink-300 mt-3 italic border-l-2 border-surface-700 pl-3">{plan.scenario}</p>
            )}

            <div className="mt-4">
              <p className="label mb-2">Steps</p>
              <ol className="space-y-1.5">
                {plan.steps.map((s: any) => (
                  <li key={s.id} className="flex items-start gap-3 rounded-lg bg-surface-850 px-3 py-2">
                    <span className="text-2xs font-mono text-ink-500 tabular-nums mt-0.5 w-4 shrink-0">
                      {s.index + 1}
                    </span>
                    <Badge tone="neutral">{s.actionType}</Badge>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-ink-200">{s.description}</p>
                      <p className="text-2xs text-ink-500 mt-0.5">
                        expects: {s.expectedOutcome}
                        {s.expectedScreenName && (
                          <>
                            {' · '}
                            <span className="text-info-400">→ {s.expectedScreenName}</span>
                          </>
                        )}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>

            <div className="grid grid-cols-2 gap-5 mt-4 pt-4 border-t border-surface-800">
              {plan.successCriteria?.length > 0 && (
                <div>
                  <p className="label">Success criteria</p>
                  <ul className="mt-1 space-y-0.5">
                    {plan.successCriteria.map((c: string, i: number) => (
                      <li key={i} className="text-xs text-ink-400">· {c}</li>
                    ))}
                  </ul>
                </div>
              )}
              {plan.frictionPoints?.length > 0 && (
                <div>
                  <p className="label">Predicted friction</p>
                  <ul className="mt-1 space-y-0.5">
                    {plan.frictionPoints.map((c: string, i: number) => (
                      <li key={i} className="text-xs text-warn-400">· {c}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <PlanHeatmap projectId={id} plan={plan} />
          </Card>
        ))}
      </div>

      {execute.error && <ErrorState error={execute.error} />}
    </div>
  );
}

/**
 * This plan's own heatmap, collapsed by default.
 *
 * Scoped to the plan so it answers "where did people press while doing THIS
 * task", which the project-wide map cannot. Collapsed because a page listing
 * several plans should not render several canvases before anyone asks; the
 * panel only fetches once it is opened.
 */
function PlanHeatmap({ projectId, plan }: { projectId: string; plan: any }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-4 pt-4 border-t border-surface-800">
      <div className="flex items-center justify-between gap-3">
        <button
          className="text-2xs text-accent-400 hover:text-accent-300"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? 'Hide heatmap' : 'Heatmap for this plan'}
        </button>
        <Link
          to={`/projects/${projectId}/heatmap?planId=${plan.id}`}
          className="text-2xs text-ink-500 hover:text-ink-300"
        >
          open in Heat Map →
        </Link>
      </div>
      {open && (
        <div className="mt-3">
          <HeatmapPanel projectId={projectId} planId={plan.id} compact />
        </div>
      )}
    </div>
  );
}
