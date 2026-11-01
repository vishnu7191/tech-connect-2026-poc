import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import {
  Badge,
  Card,
  Empty,
  ErrorState,
  SectionTitle,
  SkeletonCard,
  Stat,
  STATUS_TONE,
} from '../components/ui';

interface ProjectSummary {
  id: string;
  name: string;
  description: string | null;
  figmaUrl: string;
  urlKind: string;
  status: string;
  screenCount: number;
  executionCount: number;
  findingCount: number;
  createdAt: string;
}

export default function Dashboard() {
  const stats = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<Record<string, number>>('/dashboard'),
  });
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<ProjectSummary[]>('/projects'),
  });

  return (
    <div className="space-y-7">
      <div>
        <h1 className="text-2xl font-semibold text-ink-100">Dashboard</h1>
        <p className="text-sm text-ink-400 mt-1">
          Evidence-backed usability validation for Figma prototypes and Make applications.
        </p>
      </div>

      {stats.isLoading ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      ) : stats.data ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Stat label="Projects" value={stats.data.projects} />
          <Stat
            label="Screens discovered"
            value={stats.data.screens}
            hint="design-system components excluded"
          />
          <Stat
            label="Test sessions"
            value={stats.data.executions}
            hint={`${stats.data.executionsSucceeded} succeeded · ${stats.data.executionsFailed} failed`}
            tone={stats.data.executionsFailed > 0 ? 'warn' : 'neutral'}
          />
          <Stat
            label="UX findings"
            value={stats.data.findings}
            tone={stats.data.findings > 0 ? 'accent' : 'neutral'}
          />
        </div>
      ) : null}

      {stats.data && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Stat label="Personas" value={stats.data.personas} />
          <Stat
            label="Verified screenshots"
            value={stats.data.screenshots}
            hint="browser-captured and validated"
          />
        </div>
      )}

      <div>
        <SectionTitle
          title="Projects"
          subtitle="Each project is one Figma URL and everything discovered from it."
          actions={
            <Link to="/projects/new" className="btn-primary">
              New project
            </Link>
          }
        />

        {projects.isLoading && (
          <div className="space-y-3">
            <SkeletonCard />
            <SkeletonCard />
          </div>
        )}

        {projects.error && <ErrorState error={projects.error} retry={() => projects.refetch()} />}

        {projects.data?.length === 0 && (
          <Card pad={false}>
            <Empty
              title="No projects yet"
              description="Paste a Figma prototype or Figma Make URL to discover its screens, generate personas and run an autonomous usability test."
              action={
                <Link to="/projects/new" className="btn-primary">
                  Create your first project
                </Link>
              }
            />
          </Card>
        )}

        <div className="space-y-2.5">
          {projects.data?.map((p) => (
            <Link key={p.id} to={`/projects/${p.id}`} className="block group">
              <Card className="transition-shadow group-hover:shadow-lift">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2.5">
                      <h3 className="font-medium text-ink-100 truncate">{p.name}</h3>
                      <Badge tone={STATUS_TONE[p.status] ?? 'neutral'}>{p.status}</Badge>
                      <Badge tone="neutral">{p.urlKind}</Badge>
                    </div>
                    {p.description && (
                      <p className="text-sm text-ink-400 mt-1 line-clamp-1">{p.description}</p>
                    )}
                    <p className="text-2xs text-ink-500 mt-1.5 font-mono truncate">{p.figmaUrl}</p>
                  </div>
                  <div className="flex items-center gap-6 shrink-0 text-right">
                    <div>
                      <p className="text-lg font-semibold tabular-nums text-ink-100">{p.screenCount}</p>
                      <p className="text-2xs text-ink-500">screens</p>
                    </div>
                    <div>
                      <p className="text-lg font-semibold tabular-nums text-ink-100">{p.executionCount}</p>
                      <p className="text-2xs text-ink-500">tests</p>
                    </div>
                    <div>
                      <p className="text-lg font-semibold tabular-nums text-ink-100">{p.findingCount}</p>
                      <p className="text-2xs text-ink-500">findings</p>
                    </div>
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
