import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useActiveJob } from '../lib/useActiveJob';
import {
  Badge,
  Card,
  Empty,
  ErrorState,
  Progress,
  SectionTitle,
  Skeleton,
  Stat,
  Tabs,
  type Tone,
} from '../components/ui';
import { FindingRow } from './Execution';
import { DeviceChip } from '../components/DeviceSelector';

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
const EVIDENCE = ['observed', 'potential', 'heuristic', 'needs-human-validation'] as const;

/** Plain-language gloss for each evidence type, shown beside its count. */
const EVIDENCE_MEANING: Record<string, string> = {
  observed: 'Seen in a screenshot or recorded as a fact during the run.',
  potential: 'Supported by the evidence but not proven by it alone.',
  heuristic: 'A usability principle applied to what was seen.',
  'needs-human-validation': 'A question a real person would have to answer.',
};

const SEVERITY_MEANING: Record<string, string> = {
  critical: 'The person cannot finish what they came to do.',
  high: 'A significant obstacle; many would struggle or give up.',
  medium: 'Noticeable friction that slows people down.',
  low: 'A small rough edge, worth fixing when convenient.',
  info: 'An observation rather than a problem.',
};

export default function Findings() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const [severity, setSeverity] = useState<string>('all');
  const [evidence, setEvidence] = useState<string>('all');
  const [category, setCategory] = useState<string>('all');
  const [tab, setTab] = useState<'findings' | 'sessions'>('findings');

  const findings = useQuery({
    queryKey: ['findings', id],
    queryFn: () => api.get<any[]>(`/projects/${id}/findings`),
  });

  const report = useQuery({
    queryKey: ['report', id],
    queryFn: () => api.post<any>(`/projects/${id}/report`),
  });

  /**
   * Attach to an analysis job started elsewhere.
   *
   * The Recap page starts the job and sends the user here with its id in the
   * URL, so the work is visible on the page where its results will appear
   * rather than on the page it was triggered from.
   */
  const jobId = params.get('job');
  const fromExecution = params.get('from');
  // Re-attaches to an analysis still running for this project even when the
  // page is opened without a job id in the URL - for instance after navigating
  // away mid-run and coming back.
  const analysisJob = useActiveJob(id, ['analysis'], [
    ['findings', id],
    ['report', id],
  ]);
  const { watch } = analysisJob;

  /**
   * Attach to the job whenever the id changes.
   *
   * Depends only on `jobId` and the stable `watch` callback, and deliberately
   * does NOT guard with a ref. Under React's StrictMode every effect is run,
   * cleaned up and run again on mount; `useJob` unsubscribes in its cleanup, so
   * a ref guard let the second mount skip re-subscribing and the panel sat at
   * "Starting… 0%" forever while the job ran to completion behind it. Letting
   * the effect re-run is what makes the stream survive that.
   *
   * The job id stays in the URL after the job finishes, so a reload re-attaches
   * and the server replays the final state rather than showing nothing.
   */
  useEffect(() => {
    if (jobId) watch(jobId);
  }, [jobId, watch]);

  useEffect(() => {
    if (analysisJob.status === 'succeeded') {
      void qc.invalidateQueries({ queryKey: ['findings', id] });
      void qc.invalidateQueries({ queryKey: ['report', id] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysisJob.status]);

  const filtered = useMemo(
    () =>
      (findings.data ?? []).filter(
        (f) =>
          (severity === 'all' || f.severity === severity) &&
          (evidence === 'all' || f.evidenceType === evidence) &&
          (category === 'all' || f.category === category),
      ),
    [findings.data, severity, evidence, category],
  );

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const f of findings.data ?? []) {
      c[f.severity] = (c[f.severity] ?? 0) + 1;
      c[f.evidenceType] = (c[f.evidenceType] ?? 0) + 1;
    }
    return c;
  }, [findings.data]);

  const categories = useMemo(
    () => [...new Set((findings.data ?? []).map((f) => f.category as string))].sort(),
    [findings.data],
  );

  const executions: any[] = report.data?.executions ?? [];
  const hasFindings = (findings.data?.length ?? 0) > 0;
  const anyFilterActive = severity !== 'all' || evidence !== 'all' || category !== 'all';

  if (findings.isLoading) return <Skeleton className="h-96" />;
  if (findings.error) return <ErrorState error={findings.error} retry={() => findings.refetch()} />;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-ink-100">UX analysis</h1>
          <p className="text-sm text-ink-400 mt-1">
            Findings produced from captured evidence, prioritised by severity.
          </p>
        </div>
        {/* Both are disabled while an analysis is in flight: a report built
            mid-run would omit the findings being produced, and a reader has no
            way to tell an incomplete report from a finished one. */}
        <div className="flex gap-2 shrink-0">
          {analysisJob.isActive ? (
            <>
              <span className="btn-ghost opacity-40 cursor-not-allowed" title="Available once the analysis finishes">
                Preview report
              </span>
              <span className="btn-primary opacity-40 cursor-not-allowed" title="Available once the analysis finishes">
                Download PDF report
              </span>
            </>
          ) : (
            <>
              <a
                className="btn-ghost"
                href={`/api/v1/projects/${id}/report.html`}
                target="_blank"
                rel="noreferrer"
                title="Preview the report in a new tab before downloading it"
              >
                Preview report
              </a>
              <a
                className="btn-primary"
                href={`/api/v1/projects/${id}/report.pdf`}
                title="A complete PDF: every finding, its impact, the recommended change and the screenshot that evidences it"
              >
                Download PDF report
              </a>
            </>
          )}
        </div>
      </div>

      {/* ---- live analysis progress ---- */}
      {analysisJob.jobId && analysisJob.status !== 'idle' && (
        <Card>
          <div className="flex items-center justify-between gap-3 mb-2">
            <div className="flex items-center gap-2 min-w-0 flex-wrap">
              <span className="text-sm font-medium text-ink-100">
                {analysisJob.status === 'succeeded'
                  ? 'Analysis complete'
                  : analysisJob.status === 'failed'
                    ? 'Analysis failed'
                    : 'Analysing the captured evidence…'}
              </span>
              {analysisJob.phase && <Badge tone="neutral">{analysisJob.phase}</Badge>}
              {fromExecution && (
                <Link
                  to={`/executions/${fromExecution}`}
                  className="text-2xs text-accent-400 hover:text-accent-300"
                >
                  back to the recording →
                </Link>
              )}
            </div>
            <span className="text-xs tabular-nums text-ink-500 shrink-0">
              {Math.round(analysisJob.progress * 100)}%
            </span>
          </div>
          <Progress
            value={analysisJob.progress}
            tone={
              analysisJob.status === 'failed'
                ? 'bad'
                : analysisJob.status === 'succeeded'
                  ? 'ok'
                  : 'accent'
            }
          />
          {analysisJob.message && <p className="text-2xs text-ink-400 mt-2">{analysisJob.message}</p>}
          {analysisJob.error && <p className="text-sm text-bad-400 mt-2">{analysisJob.error}</p>}
          {analysisJob.isActive && (
            <p className="text-2xs text-ink-500 mt-2 leading-relaxed">
              Screenshots from the session are being read by the vision model. This usually takes
              20–60 seconds; the findings appear here as soon as it finishes.
            </p>
          )}
          {analysisJob.status === 'succeeded' && !hasFindings && (
            <p className="text-sm text-warn-400 mt-2 leading-relaxed">
              The analysis finished without producing findings. That happens when the session
              captured no validated screenshots — the analysis is evidence-based, so with nothing to
              look at it reports nothing rather than inventing problems.
            </p>
          )}
        </Card>
      )}

      {!hasFindings ? (
        <Card pad={false}>
          <Empty
            title="No findings yet"
            description="Run a test plan, open its recording, then choose “Analyze UX”. Findings are always tied to a screenshot or a recorded action."
            action={
              <Link to={`/projects/${id}/test-plans`} className="btn-primary">
                Go to test plans
              </Link>
            }
          />
        </Card>
      ) : (
        <>
          {/* ---- severity row, clickable as a filter ---- */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
            {SEVERITIES.map((s) => (
              <button
                key={s}
                onClick={() => setSeverity((cur) => (cur === s ? 'all' : s))}
                className={`text-left transition-opacity ${
                  severity !== 'all' && severity !== s ? 'opacity-45' : ''
                }`}
                title={`${SEVERITY_MEANING[s]} Click to ${severity === s ? 'clear the filter' : 'show only these'}.`}
              >
                <Stat
                  label={s}
                  value={counts[s] ?? 0}
                  tone={s === 'critical' || s === 'high' ? 'bad' : s === 'medium' ? 'warn' : 'neutral'}
                  hint={severity === s ? 'filtering — click to clear' : undefined}
                />
              </button>
            ))}
          </div>

          <Tabs
            tabs={[
              { id: 'findings' as const, label: 'Findings', count: findings.data?.length },
              { id: 'sessions' as const, label: 'Sessions analysed', count: executions.length },
            ]}
            active={tab}
            onChange={setTab}
          />

          {tab === 'findings' && (
            <>
              {/* The product deliberately does not publish a single UX score. */}
              {report.data?.scoring && !report.data.scoring.available && (
                <Card>
                  <div className="flex items-start gap-3">
                    <span className="text-ink-500 mt-0.5">ⓘ</span>
                    <div>
                      <p className="text-sm font-medium text-ink-200">No overall UX score is shown</p>
                      <p className="text-sm text-ink-400 mt-1 leading-relaxed">
                        {report.data.scoring.reason}
                      </p>
                    </div>
                  </div>
                </Card>
              )}

              <Card>
                <SectionTitle
                  title="Evidence quality"
                  subtitle="Directly observed problems are separated from heuristic suggestions. A finding with no linked evidence can never be recorded as observed."
                />
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  {EVIDENCE.map((e) => (
                    <button
                      key={e}
                      onClick={() => setEvidence((cur) => (cur === e ? 'all' : e))}
                      className={`text-left rounded-lg bg-surface-850 p-3.5 hover:bg-surface-800 transition-colors ${
                        evidence === e ? 'ring-1 ring-accent-600/50' : ''
                      }`}
                    >
                      <p className="text-xl font-semibold tabular-nums text-ink-100">
                        {counts[e] ?? 0}
                      </p>
                      <p className="text-xs text-ink-300 mt-0.5">{e}</p>
                      <p className="text-2xs text-ink-500 mt-1 leading-snug">
                        {EVIDENCE_MEANING[e]}
                      </p>
                    </button>
                  ))}
                </div>
              </Card>

              <div className="flex flex-wrap items-center gap-2">
                <select
                  className="input w-auto"
                  value={severity}
                  onChange={(e) => setSeverity(e.target.value)}
                >
                  <option value="all">All severities</option>
                  {SEVERITIES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <select
                  className="input w-auto"
                  value={evidence}
                  onChange={(e) => setEvidence(e.target.value)}
                >
                  <option value="all">All evidence types</option>
                  {EVIDENCE.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                {categories.length > 1 && (
                  <select
                    className="input w-auto"
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                  >
                    <option value="all">All categories</option>
                    {categories.map((c) => (
                      <option key={c} value={c}>
                        {c.replace(/-/g, ' ')}
                      </option>
                    ))}
                  </select>
                )}
                <Badge tone="neutral">{filtered.length} shown</Badge>
                {anyFilterActive && (
                  <button
                    className="text-2xs text-accent-400 hover:text-accent-300"
                    onClick={() => {
                      setSeverity('all');
                      setEvidence('all');
                      setCategory('all');
                    }}
                  >
                    clear filters
                  </button>
                )}
              </div>

              {filtered.length === 0 ? (
                <Card pad={false}>
                  <Empty
                    title="Nothing matches these filters"
                    description="Clear one of the filters above to see the findings again."
                  />
                </Card>
              ) : (
                <div className="space-y-2.5">
                  {filtered.map((f) => (
                    <FindingRow key={f.id} f={f} />
                  ))}
                </div>
              )}
            </>
          )}

          {tab === 'sessions' && (
            <Card>
              <SectionTitle
                title="Sessions behind these findings"
                subtitle="Every finding comes from one of these runs. Open a run to watch the recording it was drawn from."
              />
              {executions.length === 0 ? (
                <Empty title="No sessions" description="No test sessions have been recorded yet." />
              ) : (
                <div className="space-y-2">
                  {executions.map((e) => (
                    <Link key={e.id} to={`/executions/${e.id}`} className="block">
                      <div className="flex items-center justify-between gap-4 rounded-lg bg-surface-850 px-3.5 py-3 hover:bg-surface-800 transition-colors">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium text-ink-100 truncate">
                              {e.planName}
                            </span>
                            <Badge tone={(STATUS_FOR as Record<string, Tone>)[e.status] ?? 'neutral'}>
                              {e.status}
                            </Badge>
                            <DeviceChip device={e.device ?? null} />
                          </div>
                          <p className="text-2xs text-ink-500 mt-0.5">
                            {e.personaName} · {e.actionCount} actions
                            {typeof e.interactionCount === 'number'
                              ? ` · ${e.interactionCount} interactions recorded`
                              : ''}
                          </p>
                        </div>
                        <span className="text-accent-400 text-sm shrink-0">Open recap →</span>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </Card>
          )}
        </>
      )}
    </div>
  );
}

const STATUS_FOR: Record<string, Tone> = {
  succeeded: 'ok',
  failed: 'bad',
  running: 'accent',
  queued: 'neutral',
  paused: 'warn',
  cancelled: 'neutral',
};
