import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, screenshotUrl, videoUrl } from '../lib/api';
import {
  Badge,
  Card,
  Empty,
  ErrorState,
  SectionTitle,
  Skeleton,
  Stat,
  STATUS_TONE,
  type Tone,
} from '../components/ui';
import { CoveragePanel, type CoverageMetric } from '../components/Coverage';

const VERDICT_TONE: Record<string, Tone> = {
  match: 'ok',
  mismatch: 'bad',
  'no-navigation': 'bad',
  timeout: 'warn',
  'not-applicable': 'neutral',
};

const RESULT_TONE: Record<string, Tone> = { ok: 'ok', failed: 'bad', skipped: 'warn' };

export default function ExecutionPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [active, setActive] = useState<number | null>(null);

  const timeline = useQuery({
    queryKey: ['timeline', id],
    queryFn: () => api.get<any>(`/executions/${id}/timeline`),
    // Poll while a run is in flight so the page is live.
    refetchInterval: (q) => {
      const s = (q.state.data as any)?.execution?.status;
      return s === 'running' || s === 'queued' || s === 'paused' ? 2000 : false;
    },
  });

  const findings = useQuery({
    queryKey: ['exec-findings', id],
    queryFn: () => api.get<any[]>(`/executions/${id}/findings`),
  });

  const execution = timeline.data?.execution;
  const projectId = execution?.projectId;

  const coverage = useQuery({
    queryKey: ['exec-coverage', projectId, id],
    queryFn: () => api.get<CoverageMetric[]>(`/projects/${projectId}/coverage?executionId=${id}`),
    enabled: Boolean(projectId),
  });

  const control = useMutation({
    mutationFn: (op: 'pause' | 'resume' | 'stop' | 'retry') => api.post(`/executions/${id}/${op}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['timeline', id] }),
  });

  const analyze = useMutation({
    mutationFn: () => api.post<{ jobId: string }>(`/executions/${id}/analysis`),
    onSuccess: () => {
      // Analysis is a background job; poll findings until they appear.
      const t = setInterval(() => void qc.invalidateQueries({ queryKey: ['exec-findings', id] }), 3000);
      setTimeout(() => clearInterval(t), 90_000);
    },
  });

  /** Seek the recap video to the moment an action occurred. */
  const seekTo = (offsetMs: number, index: number) => {
    setActive(index);
    const v = videoRef.current;
    if (v && Number.isFinite(offsetMs)) {
      v.currentTime = Math.max(0, offsetMs / 1000);
      void v.play().catch(() => undefined);
    }
  };

  if (timeline.isLoading) return <Skeleton className="h-96" />;
  if (timeline.error) return <ErrorState error={timeline.error} retry={() => timeline.refetch()} />;

  const actions = timeline.data?.actions ?? [];
  const video = timeline.data?.video;
  const isLive = execution?.status === 'running' || execution?.status === 'paused';

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-semibold text-ink-100">Recap Test</h1>
            <Badge tone={STATUS_TONE[execution?.status] ?? 'neutral'}>{execution?.status}</Badge>
            {execution?.mode === 'mock' && <Badge tone="warn">mock mode</Badge>}
          </div>
          <p className="text-sm text-ink-400 mt-1">
            {execution?.planName} · persona <span className="text-ink-200">{execution?.personaName}</span>
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          {projectId && (
            <Link to={`/projects/${projectId}/test-plans`} className="btn-ghost">
              Back to plans
            </Link>
          )}
          {isLive ? (
            <>
              <button className="btn-ghost" onClick={() => control.mutate(execution.status === 'paused' ? 'resume' : 'pause')}>
                {execution.status === 'paused' ? 'Resume' : 'Pause'}
              </button>
              <button className="btn-danger" onClick={() => control.mutate('stop')}>
                Stop
              </button>
            </>
          ) : (
            <>
              <button className="btn-ghost" onClick={() => control.mutate('retry')}>
                Re-run
              </button>
              <button className="btn-primary" disabled={analyze.isPending} onClick={() => analyze.mutate()}>
                {analyze.isPending ? 'Analyzing…' : findings.data?.length ? 'Re-analyze UX' : 'Analyze UX'}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat label="Actions" value={execution?.actionCount ?? 0} />
        <Stat label="Navigations" value={execution?.navigationCount ?? 0} />
        <Stat
          label="Failed steps"
          value={actions.filter((a: any) => a.result === 'failed').length}
          tone={actions.some((a: any) => a.result === 'failed') ? 'bad' : 'ok'}
        />
        <Stat
          label="Destination mismatches"
          value={actions.filter((a: any) => a.verdict === 'mismatch').length}
          tone={actions.some((a: any) => a.verdict === 'mismatch') ? 'bad' : 'ok'}
          hint="expected vs actual screen"
        />
      </div>

      {execution?.failureReason && (
        <div className="rounded-lg border border-bad-600/30 bg-bad-600/10 px-4 py-3">
          <p className="text-sm text-bad-400">{execution.failureReason}</p>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-5 gap-5">
        {/* video */}
        <div className="xl:col-span-3 space-y-4">
          <Card>
            <SectionTitle
              title="Session recording"
              subtitle="The actual browser session, recorded start to finish — not a slideshow of screenshots."
            />
            {video && video.status === 'complete' && video.bytes > 0 ? (
              <>
                <video
                  ref={videoRef}
                  src={videoUrl(id)}
                  controls
                  className="w-full rounded-lg bg-black"
                  preload="metadata"
                />
                <p className="text-2xs text-ink-500 mt-2">
                  {(video.bytes / 1_048_576).toFixed(1)} MB · {Math.round((video.durationMs ?? 0) / 1000)}s ·{' '}
                  {video.width}×{video.height} · click any timeline step to seek
                </p>
              </>
            ) : (
              <div className="rounded-lg bg-surface-850 px-4 py-6 text-center">
                <p className="text-sm text-ink-300">No complete recording for this session</p>
                <p className="text-2xs text-ink-500 mt-1">
                  {video?.failureReason ?? 'The run may still be in progress.'}
                </p>
              </div>
            )}
          </Card>

          {coverage.data && coverage.data.length > 0 && (
            <CoveragePanel
              metrics={coverage.data}
              title="Execution coverage"
              subtitle="What this specific test session covered. A single plan is not expected to exercise every interaction."
            />
          )}
        </div>

        {/* timeline */}
        <div className="xl:col-span-2">
          <Card className="sticky top-5">
            <SectionTitle title="Execution timeline" subtitle="Every action, with its verified destination." />
            {actions.length === 0 ? (
              <Empty title="No actions yet" description="Steps appear here as the persona works through the plan." />
            ) : (
              <ol className="space-y-2 max-h-[34rem] overflow-y-auto pr-1">
                {actions.map((a: any, i: number) => (
                  <li key={a.id}>
                    <button
                      onClick={() => seekTo(a.offsetMs, i)}
                      className={`w-full text-left rounded-lg p-3 transition-colors ${
                        active === i ? 'bg-accent-600/15 ring-1 ring-accent-600/40' : 'bg-surface-850 hover:bg-surface-800'
                      }`}
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-2xs font-mono text-ink-500 tabular-nums">#{a.index}</span>
                        <Badge tone={RESULT_TONE[a.result] ?? 'neutral'}>{a.result}</Badge>
                        <Badge tone={VERDICT_TONE[a.verdict] ?? 'neutral'}>{a.verdict}</Badge>
                        <span className="text-2xs text-ink-500 ml-auto tabular-nums">
                          {(a.offsetMs / 1000).toFixed(1)}s
                        </span>
                      </div>

                      <p className="text-sm text-ink-200 mt-1.5 leading-snug">{a.description}</p>

                      <p className="text-2xs text-ink-500 mt-1">
                        {a.screenName ?? a.screenId ?? '—'}
                        {a.expectedDestinationNode && (
                          <>
                            {' · expected '}
                            <span className="font-mono">{a.expectedDestinationNode}</span>
                            {' → got '}
                            <span className={`font-mono ${a.verdict === 'mismatch' ? 'text-bad-400' : 'text-ink-400'}`}>
                              {a.actualDestinationNode ?? 'none'}
                            </span>
                          </>
                        )}
                      </p>

                      <p className="text-2xs text-ink-500 mt-0.5">
                        decided by <span className="font-mono text-ink-400">{a.decidedBy}</span>
                      </p>

                      {a.error && <p className="text-2xs text-bad-400 mt-1">{a.error}</p>}

                      {a.screenshot?.status === 'valid' && (
                        <img
                          src={screenshotUrl(a.screenshot.id)}
                          alt=""
                          loading="lazy"
                          className="mt-2 w-full rounded border border-surface-700 object-cover object-top max-h-28"
                        />
                      )}
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>
      </div>

      {findings.data && findings.data.length > 0 && (
        <Card>
          <SectionTitle
            title={`UX findings (${findings.data.length})`}
            subtitle="Each finding links to the screenshot and action that evidence it."
          />
          <div className="space-y-2.5">
            {findings.data.map((f) => (
              <FindingRow key={f.id} f={f} />
            ))}
          </div>
        </Card>
      )}

      {analyze.error && <ErrorState error={analyze.error} />}
    </div>
  );
}

export function FindingRow({ f }: { f: any }) {
  const [open, setOpen] = useState(false);
  const sevTone: Tone =
    f.severity === 'critical' || f.severity === 'high' ? 'bad' : f.severity === 'medium' ? 'warn' : 'info';
  return (
    <div className="rounded-lg bg-surface-850 p-3.5">
      <div className="flex items-start gap-3">
        <Badge tone={sevTone}>{f.severity}</Badge>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="text-sm font-medium text-ink-100">{f.title}</h4>
            <Badge tone={STATUS_TONE[f.evidenceType] ?? 'neutral'} title="How strongly this is evidenced">
              {f.evidenceType}
            </Badge>
          </div>
          <p className="text-2xs text-ink-500 mt-0.5">
            {f.category}
            {f.screenName && ` · ${f.screenName}`}
            {` · confidence ${Math.round(f.confidence * 100)}%`}
            {f.generatedByModel ? ` · ${f.generatedByModel.split('/').pop()}` : ' · verified from execution facts'}
          </p>
          <p className="text-sm text-ink-300 mt-2 leading-relaxed">{f.description}</p>

          <button className="text-2xs text-accent-400 hover:text-accent-300 mt-2" onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide detail' : 'Impact & recommendation'}
          </button>

          {open && (
            <div className="mt-2 space-y-2.5">
              <div>
                <p className="label">Impact on persona</p>
                <p className="text-sm text-ink-300 mt-0.5">{f.personaImpact}</p>
              </div>
              <div>
                <p className="label">Recommendation</p>
                <p className="text-sm text-ink-300 mt-0.5">{f.recommendation}</p>
              </div>
              {f.screenshotId && (
                <div>
                  <p className="label mb-1">Evidence</p>
                  <img
                    src={screenshotUrl(f.screenshotId)}
                    alt=""
                    loading="lazy"
                    className="rounded border border-surface-700 max-h-72 object-cover object-top"
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
