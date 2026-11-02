import { useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Card, Field, SectionTitle } from '../components/ui';
import { HeatmapPanel } from '../components/HeatmapPanel';
import { ScrollAnalytics, type ScrollReportDto } from '../components/ScrollAnalytics';

/**
 * Heat map — where the personas pressed, and how far they scrolled.
 *
 * Filters narrow which runs contribute; they never change how a contributing
 * event is placed. The grouping by screen and viewport geometry happens on the
 * server and cannot be overridden here, because merging coordinates recorded at
 * different widths would produce a map that describes neither layout (ADR-0010).
 */
export default function HeatMapPage() {
  const { id = '' } = useParams();
  // The plan filter is held in the URL so a link from a plan card lands here
  // already filtered, and so a filtered view can be shared or bookmarked.
  const [params, setParams] = useSearchParams();
  const planId = params.get('planId') ?? '';
  const personaId = params.get('personaId') ?? '';

  const setFilter = (key: 'planId' | 'personaId', value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const plans = useQuery({
    queryKey: ['plans', id],
    queryFn: () => api.get<any[]>(`/projects/${id}/test-plans`),
  });
  const personas = useQuery({
    queryKey: ['personas', id],
    queryFn: () => api.get<any[]>(`/personas?projectId=${id}`),
  });

  const scroll = useQuery({
    queryKey: ['scroll', id, personaId],
    queryFn: () =>
      api.get<ScrollReportDto>(
        `/projects/${id}/scroll${personaId ? `?personaId=${personaId}` : ''}`,
      ),
  });

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Heat map"
        subtitle="Where the personas pressed during their test runs, and how far down each screen they got."
      />

      <Card>
        <SectionTitle
          title="Filters"
          subtitle="Narrow which runs contribute to the analytics below."
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-2xl">
          <Field label="Test plan">
            <select className="input" value={planId} onChange={(e) => setFilter('planId', e.target.value)}>
              <option value="">All test plans</option>
              {plans.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Persona">
            <select className="input" value={personaId} onChange={(e) => setFilter('personaId', e.target.value)}>
              <option value="">All personas</option>
              {personas.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Card>

      <Card>
        <SectionTitle
          title={
            planId
              ? `Click & tap heatmap — ${plans.data?.find((p) => p.id === planId)?.name ?? 'selected plan'}`
              : 'Click & tap heatmap — all test plans'
          }
          subtitle="Grouped by screen and viewport size — coordinates recorded at different widths are never merged."
        />
        <HeatmapPanel projectId={id} planId={planId || undefined} personaId={personaId || undefined} />
      </Card>

      <ScrollAnalytics
        report={scroll.data}
        title="Scroll depth"
        subtitle="How far down each screen the personas actually got, measured from recorded scroll positions."
      />
    </div>
  );
}
