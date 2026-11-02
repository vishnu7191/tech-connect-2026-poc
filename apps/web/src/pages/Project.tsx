import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, screenshotUrl } from '../lib/api';
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
  STATUS_TONE,
} from '../components/ui';
import { CoveragePanel, type CoverageMetric } from '../components/Coverage';
import { GraphView } from '../components/GraphView';

type TabId = 'overview' | 'screens' | 'graph' | 'entry' | 'coverage';

export default function ProjectPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const [tab, setTab] = useState<TabId>('overview');

  const project = useQuery({ queryKey: ['project', id], queryFn: () => api.get<any>(`/projects/${id}`) });
  const screens = useQuery({ queryKey: ['screens', id], queryFn: () => api.get<any[]>(`/projects/${id}/screens`) });
  const graph = useQuery({ queryKey: ['graph', id], queryFn: () => api.get<any>(`/projects/${id}/graph`) });
  const entries = useQuery({ queryKey: ['entries', id], queryFn: () => api.get<any[]>(`/projects/${id}/entry-points`) });
  const shots = useQuery({ queryKey: ['shots', id], queryFn: () => api.get<any[]>(`/projects/${id}/screenshots`) });

  const job = useActiveJob(id, ['discovery'], [['project', id], ['screens', id], ['graph', id], ['entries', id], ['shots', id]]);

  const discover = useMutation({
    mutationFn: () =>
      api.post<{ jobId: string }>(`/projects/${id}/discovery`, {
        captureScreenshots: true,
        maxScreensToCapture: 8,
        fetchDesignReferences: false,
      }),
    onSuccess: (r) => job.watch(r.jobId),
  });

  const selectEntries = useMutation({
    mutationFn: (nodeIds: string[]) => api.post(`/projects/${id}/entry-points/select`, { nodeIds }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['entries', id] });
      void qc.invalidateQueries({ queryKey: ['screens', id] });
      void qc.invalidateQueries({ queryKey: ['project', id] });
    },
  });

  const d = project.data?.discovery;
  const realScreens = useMemo(
    () => (screens.data ?? []).filter((s) => s.classification !== 'component'),
    [screens.data],
  );

  if (project.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (project.error) return <ErrorState error={project.error} retry={() => project.refetch()} />;

  const p = project.data;

  return (
    <div className="space-y-6">
      {/* header */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-semibold text-ink-100 truncate">{p.name}</h1>
            <Badge tone={STATUS_TONE[p.status] ?? 'neutral'}>{p.status}</Badge>
            <Badge tone="neutral">{p.urlKind}</Badge>
          </div>
          <a
            href={p.figmaUrl}
            target="_blank"
            rel="noreferrer"
            className="text-2xs text-ink-500 font-mono hover:text-accent-400 break-all"
          >
            {p.figmaUrl}
          </a>
        </div>
        <div className="flex gap-2 shrink-0">
          <Link to={`/projects/${id}/personas`} className="btn-ghost">
            Personas
          </Link>
          <button className="btn-primary" disabled={job.isActive || discover.isPending} onClick={() => discover.mutate()}>
            {job.isActive ? 'Discovering…' : d ? 'Re-run discovery' : 'Start discovery'}
          </button>
        </div>
      </div>

      {/* live job progress */}
      {job.jobId && job.status !== 'idle' && (
        <Card className="animate-fade-in">
          <div className="flex items-center justify-between gap-4 mb-2">
            <div className="flex items-center gap-2.5 min-w-0">
              <Badge tone={STATUS_TONE[job.status] ?? 'accent'}>{job.status}</Badge>
              <span className="text-sm text-ink-200 truncate">{job.message}</span>
            </div>
            <span className="text-sm tabular-nums text-ink-400 shrink-0">
              {Math.round(job.progress * 100)}%
            </span>
          </div>
          <Progress value={job.progress} tone={job.status === 'failed' ? 'bad' : 'accent'} />
          {job.error && <p className="text-sm text-bad-400 mt-2">{job.error}</p>}
        </Card>
      )}

      {discover.error && <ErrorState error={discover.error} />}

      {!d && !job.isActive && (
        <Card pad={false}>
          <Empty
            title="Nothing discovered yet"
            description="Run discovery to read the Figma document, build the navigation graph, and capture verified browser screenshots."
            action={
              <button className="btn-primary" onClick={() => discover.mutate()}>
                Start discovery
              </button>
            }
          />
        </Card>
      )}

      {d && (
        <>
          <Tabs<TabId>
            tabs={[
              { id: 'overview', label: 'Overview' },
              { id: 'screens', label: 'Screens', count: realScreens.length },
              { id: 'graph', label: 'Navigation graph', count: d.screenEdges },
              { id: 'entry', label: 'Entry points', count: entries.data?.length },
              { id: 'coverage', label: 'Coverage' },
            ]}
            active={tab}
            onChange={setTab}
          />

          {tab === 'overview' && (
            <div className="space-y-5">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <Stat label="Screens" value={d.screensDiscovered} hint={`${d.componentsExcluded} components excluded`} />
                <Stat
                  label="Reachable"
                  value={d.screensReachable}
                  hint={`${d.disconnectedCount} disconnected`}
                  tone={d.screensReachable < d.screensDiscovered ? 'warn' : 'ok'}
                />
                <Stat label="Interactions" value={d.interactionsFound} hint={`${d.unsupportedInteractions} unsupported`} />
                <Stat label="Flows" value={d.flowCount} hint="independent components" />
              </div>

              {/* Typed-edge breakdown: the distinction that keeps the graph meaningful */}
              <Card>
                <SectionTitle
                  title="Interaction types"
                  subtitle="Only NAVIGATE transitions move between screens. Variant swaps and overlays are tracked as in-screen state, so they never inflate reachability."
                />
                <div className="grid grid-cols-3 gap-4">
                  {[
                    { label: 'Screen transitions', value: d.screenEdges, tone: 'accent' as const, note: 'NAVIGATE' },
                    { label: 'UI state changes', value: d.uiStateEdges, tone: 'info' as const, note: 'CHANGE_TO / SCROLL_TO' },
                    { label: 'Overlays', value: d.overlayEdges, tone: 'warn' as const, note: 'OVERLAY / SWAP' },
                  ].map((x) => (
                    <div key={x.label} className="rounded-lg bg-surface-850 p-3.5">
                      <p className="text-2xl font-semibold tabular-nums text-ink-100">{x.value}</p>
                      <p className="text-sm text-ink-300 mt-0.5">{x.label}</p>
                      <p className="text-2xs text-ink-500 font-mono mt-1">{x.note}</p>
                    </div>
                  ))}
                </div>
              </Card>

              {d.warnings?.length > 0 && (
                <Card>
                  <SectionTitle title="Discovery notes" subtitle="Every gap is reported with its reason." />
                  <ul className="space-y-2">
                    {d.warnings.map((w: any, i: number) => (
                      <li key={i} className="flex items-start gap-3 rounded-lg bg-surface-850 px-3.5 py-2.5">
                        <Badge tone={w.severity === 'error' ? 'bad' : w.severity === 'warning' ? 'warn' : 'info'}>
                          {w.severity}
                        </Badge>
                        <div className="min-w-0">
                          <p className="text-sm text-ink-200">{w.message}</p>
                          <p className="text-2xs text-ink-500 font-mono mt-0.5">{w.code}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
            </div>
          )}

          {tab === 'screens' && <ScreenGallery screens={screens.data ?? []} shots={shots.data ?? []} />}

          {tab === 'graph' && (
            <Card>
              <SectionTitle
                title="Navigation graph"
                subtitle="Screen-level transitions only, laid out by how deep into a journey each screen sits. Screens nothing navigates to appear in the final UNREACHED column."
              />
              {graph.data ? <GraphView nodes={graph.data.nodes} edges={graph.data.edges} /> : <Skeleton className="h-96" />}
            </Card>
          )}

          {tab === 'entry' && (
            <EntryPoints
              entries={entries.data ?? []}
              onSelect={(ids) => selectEntries.mutate(ids)}
              pending={selectEntries.isPending}
            />
          )}

          {tab === 'coverage' && <CoveragePanel metrics={(p.coverage ?? []) as CoverageMetric[]} />}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ScreenGallery({ screens, shots }: { screens: any[]; shots: any[] }) {
  const [filter, setFilter] = useState<'all' | 'screen' | 'ambiguous' | 'component' | 'unreachable'>('all');

  const shotByNode = useMemo(() => {
    const m = new Map<string, any>();
    for (const s of shots) {
      if (s.source === 'browser' && s.status === 'valid' && s.nodeId && !m.has(s.nodeId)) m.set(s.nodeId, s);
    }
    return m;
  }, [shots]);

  const filtered = screens.filter((s) => {
    if (filter === 'all') return s.classification !== 'component';
    if (filter === 'unreachable') return s.classification !== 'component' && !s.reachable;
    return s.classification === filter;
  });

  const counts = {
    all: screens.filter((s) => s.classification !== 'component').length,
    screen: screens.filter((s) => s.classification === 'screen').length,
    ambiguous: screens.filter((s) => s.classification === 'ambiguous').length,
    component: screens.filter((s) => s.classification === 'component').length,
    unreachable: screens.filter((s) => s.classification !== 'component' && !s.reachable).length,
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {(['all', 'screen', 'ambiguous', 'unreachable', 'component'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`btn text-xs py-1.5 ${filter === f ? 'bg-accent-600 text-white' : 'bg-surface-800 text-ink-300 hover:bg-surface-700'}`}
          >
            {f === 'all' ? 'All screens' : f} <span className="tabular-nums opacity-70">{counts[f]}</span>
          </button>
        ))}
      </div>

      {filter === 'component' && (
        <p className="text-xs text-ink-500 rounded-lg bg-surface-850 px-3.5 py-2.5">
          These nodes were classified as design-system components and excluded from the screen inventory. Exclusion is
          correct behaviour, not a coverage gap — expand a card to see exactly which signals produced the verdict.
        </p>
      )}

      {filtered.length === 0 ? (
        <Card pad={false}>
          <Empty title="Nothing here" description="No screens match this filter." />
        </Card>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map((s) => (
            <ScreenCard key={s.nodeId} screen={s} shot={shotByNode.get(s.nodeId)} />
          ))}
        </div>
      )}
    </div>
  );
}

function ScreenCard({ screen, shot }: { screen: any; shot: any }) {
  const [open, setOpen] = useState(false);
  return (
    <Card pad={false} className="overflow-hidden flex flex-col">
      <div className="relative aspect-[16/10] bg-surface-850 border-b border-surface-800">
        {shot ? (
          <img
            src={screenshotUrl(shot.id)}
            alt={screen.name}
            loading="lazy"
            className="h-full w-full object-cover object-top"
          />
        ) : screen.figmaImageUrl ? (
          <>
            <img src={screen.figmaImageUrl} alt={screen.name} loading="lazy" className="h-full w-full object-cover object-top opacity-80" />
            {/* ADR-0003: a Figma render is a design reference, never browser evidence. */}
            <span className="absolute bottom-1.5 left-1.5 chip bg-surface-950/80 text-ink-400">design reference</span>
          </>
        ) : (
          <div className="h-full grid place-items-center text-2xs text-ink-500">no capture</div>
        )}
        {shot?.verification?.sparse && (
          <span className="absolute top-1.5 right-1.5 chip bg-surface-950/80 text-warn-400" title="Rendered, but with very little content">
            sparse
          </span>
        )}
      </div>

      <div className="p-3.5 flex-1 flex flex-col">
        <div className="flex items-start justify-between gap-2">
          <h4 className="text-sm font-medium text-ink-100 truncate">{screen.name}</h4>
          <Badge tone={screen.classification === 'screen' ? 'ok' : screen.classification === 'ambiguous' ? 'warn' : 'neutral'}>
            {screen.classification}
          </Badge>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
          <span className="text-2xs font-mono text-ink-500">{screen.nodeId}</span>
          <span className="text-2xs text-ink-500">·</span>
          <span className="text-2xs text-ink-500">{screen.deviceClass}</span>
          <span className="text-2xs text-ink-500">·</span>
          <span className="text-2xs text-ink-500">{Math.round(screen.width)}×{Math.round(screen.height)}</span>
        </div>

        <div className="flex items-center gap-1.5 mt-2">
          {screen.isEntryPoint && <Badge tone="accent">entry</Badge>}
          {screen.classification !== 'component' &&
            (screen.reachable ? (
              <Badge tone="ok">reachable</Badge>
            ) : (
              <Badge tone="bad" title={screen.unreachableReason ?? undefined}>
                {screen.unreachableReason ?? 'unreachable'}
              </Badge>
            ))}
        </div>

        <button className="text-2xs text-accent-400 hover:text-accent-300 mt-2.5 text-left" onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide' : 'Why this classification?'}
        </button>
        {open && (
          <ul className="mt-1.5 space-y-1">
            {(screen.classificationSignals ?? []).map((sig: any, i: number) => (
              <li key={i} className="text-2xs flex items-start gap-1.5">
                <span className={`font-mono tabular-nums shrink-0 ${sig.weight >= 0 ? 'text-ok-400' : 'text-bad-400'}`}>
                  {sig.weight > 0 ? '+' : ''}
                  {sig.weight}
                </span>
                <span className="text-ink-400">{sig.detail ?? sig.signal}</span>
              </li>
            ))}
            <li className="text-2xs text-ink-500 pt-1 border-t border-surface-800">
              total score {Math.round(screen.classificationScore)}
            </li>
          </ul>
        )}
      </div>
    </Card>
  );
}

function EntryPoints({
  entries,
  onSelect,
  pending,
}: {
  entries: any[];
  onSelect: (ids: string[]) => void;
  pending: boolean;
}) {
  const [selected, setSelected] = useState<string[]>(() => entries.filter((e) => e.selected).map((e) => e.nodeId));
  const confirmed = entries.filter((e) => e.kind === 'confirmed');
  const inferred = entries.filter((e) => e.kind === 'inferred');

  const toggle = (nodeId: string) =>
    setSelected((s) => (s.includes(nodeId) ? s.filter((x) => x !== nodeId) : [...s, nodeId]));

  const Row = ({ e }: { e: any }) => {
    const [open, setOpen] = useState(false);
    const isOn = selected.includes(e.nodeId);
    return (
      <div className={`rounded-lg p-3.5 transition-colors ${isOn ? 'bg-accent-600/10 ring-1 ring-accent-600/40' : 'bg-surface-850'}`}>
        <div className="flex items-start gap-3">
          <input type="checkbox" checked={isOn} onChange={() => toggle(e.nodeId)} className="mt-1 accent-violet-500" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium text-ink-100">{e.screenName}</span>
              <Badge tone={e.kind === 'confirmed' ? 'ok' : 'warn'}>{e.kind}</Badge>
              {e.flowName && <Badge tone="info">{e.flowName}</Badge>}
            </div>
            <p className="text-2xs text-ink-500 font-mono mt-0.5">
              {e.nodeId} · {e.source} · score {Math.round(e.score)}
            </p>
            <button className="text-2xs text-accent-400 hover:text-accent-300 mt-1.5" onClick={() => setOpen((o) => !o)}>
              {open ? 'Hide evidence' : 'Why?'}
            </button>
            {open && (
              <ul className="mt-1.5 space-y-1">
                {(e.signals ?? []).map((s: any, i: number) => (
                  <li key={i} className="text-2xs text-ink-400">
                    <span className={`font-mono ${s.weight >= 0 ? 'text-ok-400' : 'text-bad-400'}`}>
                      {s.weight > 0 ? '+' : ''}
                      {s.weight}
                    </span>{' '}
                    {s.detail ?? s.signal}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-5">
      <Card>
        <SectionTitle
          title="Confirmed entry points"
          subtitle="Declared by Figma itself — a prototype start node or a flow starting point. These are facts, not inferences."
          actions={
            <button className="btn-primary" disabled={pending || selected.length === 0} onClick={() => onSelect(selected)}>
              {pending ? 'Applying…' : `Explore from ${selected.length} selected`}
            </button>
          }
        />
        {confirmed.length === 0 ? (
          <p className="text-sm text-ink-400 rounded-lg bg-surface-850 px-3.5 py-3">
            This file declares no starting point at all. Lenz has ranked candidates below — pick one or more to define
            what "reachable" means for this project.
          </p>
        ) : (
          <div className="space-y-2">{confirmed.map((e) => <Row key={e.nodeId} e={e} />)}</div>
        )}
      </Card>

      {inferred.length > 0 && (
        <Card>
          <SectionTitle
            title={`Candidate entry points (${inferred.length})`}
            subtitle="Inferred by Lenz, never promoted automatically. These are screens nothing navigates to — including disconnected frames, which are ranked rather than discarded."
          />
          <div className="space-y-2 max-h-[30rem] overflow-y-auto pr-1">
            {inferred.map((e) => <Row key={e.nodeId} e={e} />)}
          </div>
        </Card>
      )}
    </div>
  );
}
