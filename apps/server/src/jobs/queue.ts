import { EventEmitter } from 'node:events';
import type { Job, JobKind, JobProgressEvent } from '@lenz/shared';
import { AppError, CancelledError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import type { Repositories } from '../db/repositories.js';

/**
 * In-process background job queue.
 *
 * Long operations (discovery, execution, analysis) must never run inside a
 * request. Progress is persisted so a client that reconnects can recover state,
 * and cancellation is cooperative so a stop request releases the browser
 * promptly rather than after the whole run.
 */

export interface JobContext {
  jobId: string;
  /** Report progress; also persists so late subscribers can catch up. */
  progress(fraction: number, message: string, phase?: string): void;
  /** Throws CancelledError if a stop was requested. Call between steps. */
  throwIfCancelled(): void;
  isCancelled(): boolean;
}

type JobHandler = (ctx: JobContext) => Promise<unknown>;

export class JobQueue {
  private readonly emitter = new EventEmitter();
  private readonly running = new Map<string, { cancelled: boolean }>();

  constructor(private readonly repos: Repositories) {
    // Many clients may watch one job; avoid a spurious leak warning.
    this.emitter.setMaxListeners(100);
  }

  /** Create a job and start it. Returns immediately - the caller responds 202. */
  enqueue(kind: JobKind, projectId: string | null, handler: JobHandler): Job {
    const job = this.repos.createJob(kind, projectId);
    const state = { cancelled: false };
    this.running.set(job.id, state);

    const ctx: JobContext = {
      jobId: job.id,
      progress: (fraction, message, phase) => {
        const clamped = Math.max(0, Math.min(1, fraction));
        this.repos.updateJob(job.id, {
          progress: clamped,
          message,
          phase: phase ?? null,
          status: 'running',
        });
        this.emit({ jobId: job.id, status: 'running', progress: clamped, message, phase: phase ?? null });
      },
      isCancelled: () => state.cancelled || this.isCancelRequested(job.id),
      throwIfCancelled: () => {
        if (state.cancelled || this.isCancelRequested(job.id)) throw new CancelledError();
      },
    };

    this.repos.updateJob(job.id, { status: 'running', message: 'Starting', progress: 0 });
    this.emit({ jobId: job.id, status: 'running', progress: 0, message: 'Starting', phase: null });

    // Deliberately not awaited: the job runs in the background.
    void (async () => {
      try {
        const result = await handler(ctx);
        this.repos.updateJob(job.id, {
          status: 'succeeded',
          progress: 1,
          message: 'Completed',
          result,
        });
        this.emit({ jobId: job.id, status: 'succeeded', progress: 1, message: 'Completed', phase: null });
      } catch (err) {
        const cancelled = err instanceof CancelledError;
        const message = toUserFacingError(err, kind);
        this.repos.updateJob(job.id, {
          status: cancelled ? 'cancelled' : 'failed',
          message: cancelled ? 'Cancelled' : 'Failed',
          error: message,
        });
        this.emit({
          jobId: job.id,
          status: cancelled ? 'cancelled' : 'failed',
          progress: 0,
          message: cancelled ? 'Cancelled' : message,
          phase: null,
        });
        if (!cancelled) {
          // Full technical detail goes to the log; the user gets the normalized text.
          logger.error(
            { jobId: job.id, kind, err: (err as Error)?.message, stack: (err as Error)?.stack },
            'Job failed',
          );
        }
      } finally {
        this.running.delete(job.id);
      }
    })();

    return job;
  }

  cancel(jobId: string): boolean {
    const state = this.running.get(jobId);
    this.repos.updateJob(jobId, { cancelRequested: true });
    if (state) state.cancelled = true;
    return Boolean(state);
  }

  private isCancelRequested(jobId: string): boolean {
    return this.repos.getJob(jobId)?.cancelRequested ?? false;
  }

  private emit(event: JobProgressEvent): void {
    this.emitter.emit(event.jobId, event);
    this.emitter.emit('*', event);
  }

  subscribe(jobId: string, listener: (e: JobProgressEvent) => void): () => void {
    this.emitter.on(jobId, listener);
    return () => this.emitter.off(jobId, listener);
  }
}

let queue: JobQueue | null = null;
export function getJobQueue(repos: Repositories): JobQueue {
  if (!queue) queue = new JobQueue(repos);
  return queue;
}
export function resetJobQueueForTests(): void {
  queue = null;
}

/**
 * Turn any thrown value into something a user can act on.
 *
 * An unexpected internal error must never reach the UI as a raw message. A
 * real example: a null entry in Figma's interaction payload surfaced to the
 * user as "Cannot read properties of null (reading 'type')", which tells them
 * nothing and looks like the product is broken rather than the input being
 * unusual.
 *
 * AppErrors are written for humans and pass through; everything else is
 * replaced with a job-specific explanation while the stack goes to the log.
 */
export function toUserFacingError(err: unknown, kind: JobKind): string {
  if (err instanceof CancelledError) return 'Cancelled';
  if (err instanceof AppError) return err.message;

  const fallback: Record<JobKind, string> = {
    discovery:
      'Discovery failed unexpectedly while reading this Figma file. The file may use a structure Lenz has not seen before. The technical details have been logged.',
    execution:
      'The test run failed unexpectedly. The browser session has been cleaned up; you can retry the run. The technical details have been logged.',
    analysis:
      'UX analysis failed unexpectedly. The captured evidence is still available, so you can retry the analysis. The technical details have been logged.',
    experiment:
      'The model comparison failed unexpectedly. The technical details have been logged.',
    personaGeneration:
      'Persona generation failed unexpectedly. This is usually a temporary model error - try again. The technical details have been logged.',
    testPlanGeneration:
      'Test plan generation failed unexpectedly. This is usually a temporary model error - try again. The technical details have been logged.',
  };

  return fallback[kind] ?? 'This job failed unexpectedly. The technical details have been logged.';
}
