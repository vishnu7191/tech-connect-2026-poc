import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, screenshotUrl } from '../lib/api';
import {
  Badge,
  Card,
  Empty,
  ErrorState,
  SectionTitle,
  Skeleton,
  Stat,
  Tabs,
  STATUS_TONE,
  type Tone,
} from '../components/ui';
import { seekTimeFor } from '../lib/overlay';
import { CoveragePanel, type CoverageMetric } from '../components/Coverage';
import { RecapVideo, type InteractionEventDto } from '../components/RecapVideo';
import { DeviceChip } from '../components/DeviceSelector';
import {
  ClickHeatmap,
  HeatmapEmpty,
  type HeatmapMode,
  type HeatmapReportDto,
} from '../components/ClickHeatmap';
import { ScrollAnalytics, type ScrollReportDto } from '../components/ScrollAnalytics';

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
  const navigate = useNavigate();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [active, setActive] = useState<number | null>(null);
  const [evidenceTab, setEvidenceTab] = useState<'coverage' | 'heatmap' | 'scroll'>('coverage');
  const [heatmapMode, setHeatmapMode] = useState<HeatmapMode>('density');

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

  // Heatmap and scroll analytics are scoped to THIS run on the recap page, so
  // the numbers always describe the session the video is showing.
  const heatmap = useQuery({
    queryKey: ['exec-heatmap', projectId, id],
    queryFn: () =>
      api.get<HeatmapReportDto>(`/projects/${projectId}/heatmap?executionIds=${id}`),
    enabled: Boolean(projectId) && execution?.status !== 'running',
  });

  const scroll = useQuery({
    queryKey: ['exec-scroll', id],
    queryFn: () => api.get<ScrollReportDto>(`/executions/${id}/scroll`),
    enabled: execution?.status !== 'running',
  });

  const control = useMutation({
    mutationFn: (op: 'pause' | 'resume' | 'stop' | 'retry') => api.post(`/executions/${id}/${op}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['timeline', id] }),
  });

  /**
   * Starting UX analysis hands the user over to the UX Analysis page.
   *
   * The job id travels in the URL so that page can attach to the same job and
   * show its progress. Previously the job was fired here with no subscription
   * at all, so pressing the button produced no visible change whatsoever -
   * a run still thinking looked exactly like one that had already failed.
   */
  const analyze = useMutation({
    mutationFn: () => api.post<{ jobId: string }>(`/executions/${id}/analysis`),
    onSuccess: (r) => {
      if (projectId) navigate(`/projects/${projectId}/findings?job=${r.jobId}&from=${id}`);
    },
  });

  const videoStartOffsetMs: number | null = timeline.data?.videoStartOffsetMs ?? null;

  /**
   * Seek the recap video to the moment an action occurred.
   *
   * Two corrections, both measured rather than assumed:
   *
   *  - The caller passes `seekOffsetMs`, the time of the step's FIRST recorded
   *    interaction, not the time the step finished. The two differ by 1.8s on
   *    desktop and 5.5s on mobile, which is enough to land on the next screen.
   *  - Offsets are on the execution clock, which starts before the recording
   *    does; subtracting the recording's own start offset aligns them.
   *
   * Playwright's webm reports a duration ~4.6% longer than the wall time it
   * covers, but its frame timestamps are real-time: a ground-truth measurement
   * (tools/probe/verify-video-sync.mts) put every sampled seek inside the
   * correct frame. So the mapping is a plain subtraction, with no rescaling —
   * rescaling by the reported duration was measured to be three times worse.
   */
  const seekTo = (offsetMs: number, index: number) => {
    setActive(index);
    const v = videoRef.current;
    if (v && Number.isFinite(offsetMs)) {
      v.currentTime = seekTimeFor(offsetMs, videoStartOffsetMs);
      void v.play().catch(() => undefined);
    }
  };

  if (timeline.isLoading) return <Skeleton className="h-96" />;
  if (timeline.error) return <ErrorState error={timeline.error} retry={() => timeline.refetch()} />;

  const actions = timeline.data?.actions ?? [];
  const video = timeline.data?.video;
  const interactions: InteractionEventDto[] = timeline.data?.interactions ?? [];
  const isLive = execution?.status === 'running' || execution?.status === 'paused';
  const positionedCount = interactions.filter(
    (e) => e.coordinateStatus === 'recorded' && (e.type === 'click' || e.type === 'tap'),
  ).length;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-semibold text-ink-100">Recap Test</h1>
            <Badge tone={STATUS_TONE[execution?.status] ?? 'neutral'}>{execution?.status}</Badge>
            <DeviceChip device={execution?.device ?? null} />
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
                {analyze.isPending
                  ? 'Starting…'
                  : findings.data?.length
                    ? 'Re-analyze UX'
                    : 'Analyze UX'}
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

      {analyze.error && <ErrorState error={analyze.error} />}

      <div className="grid grid-cols-1 xl:grid-cols-5 gap-5">
        {/* video */}
        <div className="xl:col-span-3 space-y-4">
          <Card>
            <SectionTitle
              title="Session recording"
              subtitle="The actual browser session, recorded start to finish — not a slideshow of screenshots. Markers show where each click or tap landed."
            />
            <RecapVideo
              executionId={id}
              videoRef={videoRef}
              video={video ?? null}
              interactions={interactions}
              videoStartOffsetMs={videoStartOffsetMs}
              timingExact={Boolean(timeline.data?.timingExact)}
              deviceLabel={execution?.device?.label ?? null}
            />
          </Card>

          <Card pad={false}>
            <div className="px-5 pt-4">
              <Tabs
                tabs={[
                  { id: 'coverage' as const, label: 'Coverage', count: coverage.data?.length },
                  { id: 'heatmap' as const, label: 'Click heatmap', count: positionedCount },
                  {
                    id: 'scroll' as const,
                    label: 'Scroll depth',
                    count: scroll.data?.summaries.length,
                  },
                ]}
                active={evidenceTab}
                onChange={setEvidenceTab}
              />
            </div>

            <div className="p-5">
              {evidenceTab === 'coverage' &&
                (coverage.data && coverage.data.length > 0 ? (
                  <CoveragePanel
                    metrics={coverage.data}
                    title="Execution coverage"
                    subtitle="What this specific test session covered. A single plan is not expected to exercise every interaction."
                  />
                ) : (
                  <Empty
                    title="No coverage recorded"
                    description="Coverage is computed when a run finishes."
                  />
                ))}

              {evidenceTab === 'heatmap' &&
                (heatmap.data && heatmap.data.groups.length > 0 ? (
                  <div className="space-y-6">
                    <p className="text-2xs text-ink-500 leading-relaxed">
                      {heatmap.data.dataNote}
                    </p>
                    {heatmap.data.groups.map((g) => (
                      <ClickHeatmap
                        key={g.key}
                        group={g}
                        mode={heatmapMode}
                        onModeChange={setHeatmapMode}
                      />
                    ))}
                    {heatmap.data.exclusions.length > 0 && (
                      <div>
                        <p className="label mb-1.5">Events that could not contribute</p>
                        <ul className="space-y-0.5">
                          {heatmap.data.exclusions.map((x, i) => (
                            <li key={i} className="text-2xs text-ink-500">
                              · {x.count} × {x.reason}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                ) : (
                  <HeatmapEmpty report={heatmap.data} />
                ))}

              {evidenceTab === 'scroll' && (
                <ScrollAnalytics
                  bare
                  report={scroll.data}
                  title="Scroll depth for this session"
                  subtitle="Measured from recorded scroll positions during this run."
                />
              )}
            </div>
          </Card>
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
                      onClick={() => seekTo(a.seekOffsetMs ?? a.offsetMs, i)}
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

                      {/* What was actually recorded for this step, including the
                          reason when no position exists. */}
                      {a.interactions?.length > 0 && (
                        <ul className="mt-1.5 space-y-0.5">
                          {a.interactions.map((e: InteractionEventDto) => (
                            <li key={e.id} className="text-2xs text-ink-500 flex items-start gap-1.5">
                              <span className="font-mono shrink-0">{e.type}</span>
                              <span className="truncate">
                                {e.coordinateStatus === 'recorded' ? (
                                  <span className="tabular-nums">
                                    @ {Math.round(e.viewportX ?? 0)},{Math.round(e.viewportY ?? 0)}
                                  </span>
                                ) : (
                                  <span className="italic" title={e.coordinateNote ?? undefined}>
                                    no position recorded
                                  </span>
                                )}
                                {e.label ? ` · ${e.label}` : ''}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}

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

    </div>
  );
}

export function FindingRow({ f }: { f: any }) {
  const [open, setOpen] = useState(false);
  const [zoom, setZoom] = useState(false);
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

          {/* Evidence is shown immediately, not hidden behind a toggle: the
              screenshot is usually the fastest way to understand the finding,
              and object-contain shows the whole screen rather than cropping
              off the half that happens not to fit. */}
          {f.screenshotId && (
            <figure className="mt-2.5">
              <button
                type="button"
                onClick={() => setZoom((z) => !z)}
                className="block w-full text-left"
                title={zoom ? 'Click to shrink' : 'Click to enlarge'}
              >
                <img
                  src={screenshotUrl(f.screenshotId)}
                  alt={`Screen evidence for: ${f.title}`}
                  loading="lazy"
                  className={`rounded border border-surface-700 bg-surface-950 w-auto max-w-full object-contain transition-[max-height] ${
                    zoom ? 'max-h-[42rem]' : 'max-h-64'
                  }`}
                />
              </button>
              <figcaption className="text-2xs text-ink-500 mt-1">
                Evidence from the recorded session
                {f.screenName ? ` · ${f.screenName}` : ''} ·{' '}
                <span className="text-accent-400">{zoom ? 'click to shrink' : 'click to enlarge'}</span>
              </figcaption>
            </figure>
          )}

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
              {!f.screenshotId && (
                <p className="text-2xs text-ink-500">
                  No screenshot is linked to this finding, so it is not recorded as directly
                  observed.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
