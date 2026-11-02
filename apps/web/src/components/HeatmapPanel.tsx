import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Skeleton } from './ui';
import {
  ClickHeatmap,
  HeatmapEmpty,
  type HeatmapMode,
  type HeatmapReportDto,
} from './ClickHeatmap';

/**
 * A heatmap for one slice of a project's recorded interactions.
 *
 * Shared by the project-wide Heat Map page and the per-plan panel on Test
 * Plans, so both render identically and neither can drift into its own idea of
 * how a heatmap should look. Filtering happens on the server; the grouping by
 * screen and viewport geometry is not overridable from here (ADR-0010).
 */
export function HeatmapPanel({
  projectId,
  planId,
  personaId,
  executionIds,
  compact = false,
}: {
  projectId: string;
  planId?: string;
  personaId?: string;
  executionIds?: string[];
  /** Trims the surrounding notes for an embedded panel. */
  compact?: boolean;
}) {
  const [mode, setMode] = useState<HeatmapMode>('density');

  const params = new URLSearchParams();
  if (planId) params.set('planId', planId);
  if (personaId) params.set('personaId', personaId);
  if (executionIds?.length) params.set('executionIds', executionIds.join(','));
  const suffix = params.toString() ? `?${params}` : '';

  const heatmap = useQuery({
    queryKey: ['heatmap', projectId, planId ?? '', personaId ?? '', executionIds?.join(',') ?? ''],
    queryFn: () => api.get<HeatmapReportDto>(`/projects/${projectId}/heatmap${suffix}`),
  });

  if (heatmap.isLoading) return <Skeleton className="h-56" />;
  if (!heatmap.data || heatmap.data.groups.length === 0) {
    return <HeatmapEmpty report={heatmap.data} />;
  }

  return (
    <div className={compact ? 'space-y-5' : 'space-y-7'}>
      {!compact && (
        <p className="text-2xs text-ink-500 leading-relaxed">{heatmap.data.dataNote}</p>
      )}
      {heatmap.data.groups.map((g) => (
        <ClickHeatmap key={g.key} group={g} mode={mode} onModeChange={setMode} />
      ))}
      {heatmap.data.exclusions.length > 0 && (
        <div className="pt-3 border-t border-surface-800">
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
      {compact && <p className="text-2xs text-ink-500 leading-relaxed">{heatmap.data.dataNote}</p>}
    </div>
  );
}
