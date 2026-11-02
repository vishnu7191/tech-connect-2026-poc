import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useJob, type JobState } from './useJob';

export interface JobRow {
  id: string;
  kind: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  progress: number;
  message: string;
  phase: string | null;
  error: string | null;
  createdAt: string;
}

/**
 * Track a project's background work, re-attaching after navigation.
 *
 * A job runs on the server; closing its progress stream does not stop it. But
 * the stream is the only thing the UI had, so leaving a page mid-run and coming
 * back showed nothing at all — the work looked like it had died when it was
 * still going. On mount this asks which jobs of the given kinds are still
 * queued or running for the project and subscribes to the newest one, so
 * returning to a page picks the progress back up where it is now.
 *
 * `watch` is still exposed for the case where this page started the job itself
 * and already knows the id, which avoids waiting for the poll.
 */
export function useActiveJob(
  projectId: string | undefined,
  kinds: string[],
  invalidateKeys: string[][] = [],
): JobState & { watch: (jobId: string) => void; isActive: boolean; reset: () => void } {
  const job = useJob(invalidateKeys);
  const { watch } = job;
  const attached = useRef<string | null>(null);

  const kindParam = kinds.join(',');
  const active = useQuery({
    queryKey: ['active-jobs', projectId, kindParam],
    queryFn: () =>
      api.get<JobRow[]>(`/projects/${projectId}/jobs?status=queued,running&kind=${kindParam}`),
    enabled: Boolean(projectId),
    // Only polls while nothing is attached; once subscribed, SSE carries it.
    refetchInterval: (q) => ((q.state.data as JobRow[] | undefined)?.length ? false : 15_000),
  });

  useEffect(() => {
    const running = active.data?.[0];
    if (!running) return;
    // Re-subscribe when the id changes. No ref guard that survives a
    // StrictMode remount would be safe here; `watch` is stable, so depending
    // on it directly is both correct and cheap.
    if (attached.current === running.id && job.status !== 'idle') return;
    attached.current = running.id;
    watch(running.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.data, watch]);

  return job;
}
