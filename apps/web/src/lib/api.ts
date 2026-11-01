/**
 * Thin API client. The frontend never holds credentials and never talks to
 * Figma or an AI provider directly - everything goes through the backend.
 */

export interface ApiErrorShape {
  error: { code: string; message: string; details?: unknown };
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });

  if (res.status === 204) return null as T;

  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  if (!res.ok) {
    const e = body as ApiErrorShape | null;
    throw new ApiError(
      e?.error?.code ?? 'UNKNOWN',
      e?.error?.message ?? `Request failed (${res.status})`,
      e?.error?.details,
      res.status,
    );
  }
  return body as T;
}

export const api = {
  get: <T>(p: string) => request<T>(p),
  post: <T>(p: string, body?: unknown) =>
    request<T>(p, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  patch: <T>(p: string, body: unknown) =>
    request<T>(p, { method: 'PATCH', body: JSON.stringify(body) }),
  put: <T>(p: string, body: unknown) =>
    request<T>(p, { method: 'PUT', body: JSON.stringify(body) }),
  del: <T>(p: string) => request<T>(p, { method: 'DELETE' }),
};

/* ------------------------------------------------------------------ *
 * Job progress over SSE
 * ------------------------------------------------------------------ */

export interface JobEvent {
  jobId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  progress: number;
  message: string;
  phase: string | null;
}

/**
 * Subscribe to a job's progress stream. The server replays current state on
 * connect, so a late subscriber is immediately consistent.
 */
export function subscribeToJob(
  jobId: string,
  handlers: {
    onProgress?: (e: JobEvent) => void;
    onDone?: (e: { status: string; result: unknown; error: string | null }) => void;
    onError?: () => void;
  },
): () => void {
  const source = new EventSource(`/api/v1/jobs/${jobId}/events`);

  source.addEventListener('progress', (ev) => {
    try {
      handlers.onProgress?.(JSON.parse((ev as MessageEvent).data));
    } catch {
      /* malformed frame - ignore */
    }
  });

  source.addEventListener('done', (ev) => {
    try {
      handlers.onDone?.(JSON.parse((ev as MessageEvent).data));
    } catch {
      /* ignore */
    }
    source.close();
  });

  source.onerror = () => {
    handlers.onError?.();
    source.close();
  };

  return () => source.close();
}

export const screenshotUrl = (id: string) => `/api/v1/screenshots/${id}/file`;
export const videoUrl = (executionId: string) => `/api/v1/executions/${executionId}/video/file`;
