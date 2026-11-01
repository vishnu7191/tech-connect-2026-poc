import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { subscribeToJob, type JobEvent } from './api';

export interface JobState {
  jobId: string | null;
  status: JobEvent['status'] | 'idle';
  progress: number;
  message: string;
  phase: string | null;
  error: string | null;
  result: unknown;
}

const IDLE: JobState = {
  jobId: null,
  status: 'idle',
  progress: 0,
  message: '',
  phase: null,
  error: null,
  result: null,
};

/**
 * Track a background job over SSE.
 *
 * On completion the supplied query keys are invalidated, so the page reflects
 * the job's results without the caller wiring up refetches by hand.
 */
export function useJob(invalidateKeys: string[][] = []) {
  const qc = useQueryClient();
  const [state, setState] = useState<JobState>(IDLE);
  const unsubscribe = useRef<(() => void) | null>(null);
  const keysRef = useRef(invalidateKeys);
  keysRef.current = invalidateKeys;

  const stop = useCallback(() => {
    unsubscribe.current?.();
    unsubscribe.current = null;
  }, []);

  useEffect(() => stop, [stop]);

  const watch = useCallback(
    (jobId: string) => {
      stop();
      setState({ ...IDLE, jobId, status: 'queued', message: 'Starting…' });

      unsubscribe.current = subscribeToJob(jobId, {
        onProgress: (e) =>
          setState((s) => ({
            ...s,
            jobId,
            status: e.status,
            progress: e.progress,
            message: e.message,
            phase: e.phase,
          })),
        onDone: (e) => {
          setState((s) => ({
            ...s,
            status: e.status as JobEvent['status'],
            progress: e.status === 'succeeded' ? 1 : s.progress,
            error: e.error,
            result: e.result,
            message: e.error ?? (e.status === 'succeeded' ? 'Completed' : e.status),
          }));
          for (const key of keysRef.current) void qc.invalidateQueries({ queryKey: key });
        },
        onError: () =>
          setState((s) => ({
            ...s,
            status: 'failed',
            error: 'Lost connection to the progress stream',
          })),
      });
    },
    [qc, stop],
  );

  const reset = useCallback(() => {
    stop();
    setState(IDLE);
  }, [stop]);

  const isActive = state.status === 'queued' || state.status === 'running';

  return { ...state, watch, reset, isActive };
}
