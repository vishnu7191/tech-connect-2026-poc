import { z } from 'zod';

export const JobKind = z.enum([
  'discovery',
  'execution',
  'analysis',
  'experiment',
  'personaGeneration',
  'testPlanGeneration',
]);
export type JobKind = z.infer<typeof JobKind>;

export const JobStatus = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export type JobStatus = z.infer<typeof JobStatus>;

export const Job = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  kind: JobKind,
  status: JobStatus,
  progress: z.number().min(0).max(1),
  message: z.string(),
  phase: z.string().nullable(),
  error: z.string().nullable(),
  cancelRequested: z.boolean(),
  result: z.unknown().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Job = z.infer<typeof Job>;

export const JobProgressEvent = z.object({
  jobId: z.string(),
  status: JobStatus,
  progress: z.number(),
  message: z.string(),
  phase: z.string().nullable(),
});
export type JobProgressEvent = z.infer<typeof JobProgressEvent>;

/** Normalized API error envelope. Never carries stack traces or secrets. */
export const ApiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

export const ERROR_CODES = {
  INVALID_URL: 'INVALID_URL',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  FIGMA_FORBIDDEN: 'FIGMA_FORBIDDEN',
  FIGMA_UNAVAILABLE: 'FIGMA_UNAVAILABLE',
  PROVIDER_AUTH: 'PROVIDER_AUTH',
  PROVIDER_RATE_LIMIT: 'PROVIDER_RATE_LIMIT',
  PROVIDER_TRUNCATED: 'PROVIDER_TRUNCATED',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  CAPABILITY_UNSUPPORTED: 'CAPABILITY_UNSUPPORTED',
  PLAN_NOT_APPROVED: 'PLAN_NOT_APPROVED',
  BROWSER_ERROR: 'BROWSER_ERROR',
  JOB_CANCELLED: 'JOB_CANCELLED',
  INTERNAL: 'INTERNAL',
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
