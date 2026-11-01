import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Badge, Card, Empty, ErrorState, SectionTitle, Skeleton, Stat } from '../components/ui';
import { FindingRow } from './Execution';

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
const EVIDENCE = ['observed', 'potential', 'heuristic', 'needs-human-validation'] as const;

export default function Findings() {
  const { id = '' } = useParams();
  const [severity, setSeverity] = useState<string>('all');
  const [evidence, setEvidence] = useState<string>('all');

  const findings = useQuery({
    queryKey: ['findings', id],
    queryFn: () => api.get<any[]>(`/projects/${id}/findings`),
  });

  const report = useQuery({
    queryKey: ['report', id],
    queryFn: () => api.post<any>(`/projects/${id}/report`),
  });

  const filtered = useMemo(
    () =>
      (findings.data ?? []).filter(
        (f) => (severity === 'all' || f.severity === severity) && (evidence === 'all' || f.evidenceType === evidence),
      ),
    [findings.data, severity, evidence],
  );

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const f of findings.data ?? []) {
      c[f.severity] = (c[f.severity] ?? 0) + 1;
      c[f.evidenceType] = (c[f.evidenceType] ?? 0) + 1;
    }
    return c;
  }, [findings.data]);

  if (findings.isLoading) return <Skeleton className="h-96" />;
  if (findings.error) return <ErrorState error={findings.error} retry={() => findings.refetch()} />;

  return (
    <div className="space-y-6">
      <SectionTitle
        title="UX analysis"
        subtitle="Findings produced from captured evidence, prioritised by severity."
      />

      {findings.data?.length === 0 ? (
        <Card pad={false}>
          <Empty
            title="No findings yet"
            description="Run a test plan and then analyse the session. Findings are always tied to a screenshot or a recorded action."
          />
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
            {SEVERITIES.map((s) => (
              <Stat
                key={s}
                label={s}
                value={counts[s] ?? 0}
                tone={s === 'critical' || s === 'high' ? 'bad' : s === 'medium' ? 'warn' : 'neutral'}
              />
            ))}
          </div>

          {/* The product deliberately does not publish a single UX score. */}
          {report.data?.scoring && !report.data.scoring.available && (
            <Card>
              <div className="flex items-start gap-3">
                <span className="text-ink-500 mt-0.5">ⓘ</span>
                <div>
                  <p className="text-sm font-medium text-ink-200">No overall UX score is shown</p>
                  <p className="text-sm text-ink-400 mt-1 leading-relaxed">{report.data.scoring.reason}</p>
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
                <div key={e} className="rounded-lg bg-surface-850 p-3.5">
                  <p className="text-xl font-semibold tabular-nums text-ink-100">{counts[e] ?? 0}</p>
                  <p className="text-xs text-ink-400 mt-0.5">{e}</p>
                </div>
              ))}
            </div>
          </Card>

          <div className="flex flex-wrap gap-2">
            <select className="input w-auto" value={severity} onChange={(e) => setSeverity(e.target.value)}>
              <option value="all">All severities</option>
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <select className="input w-auto" value={evidence} onChange={(e) => setEvidence(e.target.value)}>
              <option value="all">All evidence types</option>
              {EVIDENCE.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <Badge tone="neutral">{filtered.length} shown</Badge>
          </div>

          <div className="space-y-2.5">
            {filtered.map((f) => (
              <FindingRow key={f.id} f={f} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
