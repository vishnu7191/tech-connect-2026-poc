import { ERROR_CODES, type ErrorCode } from '@lenz/shared';

/**
 * All errors crossing the API boundary are AppErrors. Internal details stay in
 * `internalDetail` (logged, never serialized) so stack traces and secrets never
 * reach the frontend.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: unknown;
  readonly internalDetail: string | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { statusCode?: number; details?: unknown; internalDetail?: string } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = opts.statusCode ?? 500;
    this.details = opts.details;
    this.internalDetail = opts.internalDetail;
  }

  toResponse() {
    return {
      error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) },
    };
  }
}

export const notFound = (what: string) =>
  new AppError(ERROR_CODES.NOT_FOUND, `${what} not found`, { statusCode: 404 });

export const invalidUrl = (message: string, details?: unknown) =>
  new AppError(ERROR_CODES.INVALID_URL, message, { statusCode: 400, details });

export const validationFailed = (message: string, details?: unknown) =>
  new AppError(ERROR_CODES.VALIDATION_FAILED, message, { statusCode: 400, details });

export const planNotApproved = () =>
  new AppError(
    ERROR_CODES.PLAN_NOT_APPROVED,
    'Test plan must be approved before execution. Approve it, or enable auto-approval on the project.',
    { statusCode: 409 },
  );

/* ---------- AI provider errors (normalized by the adapter) ---------- */

export class ProviderAuthError extends AppError {
  constructor(providerId: string, detail?: string) {
    super(ERROR_CODES.PROVIDER_AUTH, `Authentication failed for provider "${providerId}"`, {
      statusCode: 502,
      internalDetail: detail,
    });
  }
}

export class ProviderRateLimitError extends AppError {
  readonly retryAfterMs: number | null;
  constructor(providerId: string, retryAfterMs: number | null, detail?: string) {
    super(ERROR_CODES.PROVIDER_RATE_LIMIT, `Rate limited by provider "${providerId}"`, {
      statusCode: 429,
      internalDetail: detail,
    });
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * The reasoning trace consumed the output budget (finish_reason=length with empty
 * content). Retryable with a larger budget - see doc/findings section 4.
 */
export class TruncatedResponseError extends AppError {
  constructor(modelId: string, budget: number) {
    super(
      ERROR_CODES.PROVIDER_TRUNCATED,
      `Model "${modelId}" exhausted its ${budget}-token output budget before producing an answer.`,
      { statusCode: 502 },
    );
  }
}

export class CapabilityError extends AppError {
  constructor(modelId: string, capability: string) {
    super(
      ERROR_CODES.CAPABILITY_UNSUPPORTED,
      `Model "${modelId}" does not declare support for ${capability}.`,
      { statusCode: 400 },
    );
  }
}

export class ProviderError extends AppError {
  constructor(providerId: string, message: string, detail?: string) {
    super(ERROR_CODES.PROVIDER_ERROR, `Provider "${providerId}": ${message}`, {
      statusCode: 502,
      internalDetail: detail,
    });
  }
}

export class FigmaForbiddenError extends AppError {
  readonly httpStatus: number;

  constructor(fileKey: string, httpStatus = 403) {
    // Figma returns 404 both for a file that does not exist and for one this
    // token cannot see, so it is impossible to tell them apart from the API
    // alone. This message stays factual; the browser access probe supplies the
    // actionable explanation.
    super(
      ERROR_CODES.FIGMA_FORBIDDEN,
      httpStatus === 404
        ? `Figma returned "not found" for file "${fileKey}". Figma reports this both for files that do not exist and for files this token cannot see.`
        : `Figma denied access to file "${fileKey}".`,
      { statusCode: httpStatus },
    );
    this.httpStatus = httpStatus;
  }
}

export class BrowserError extends AppError {
  constructor(message: string, detail?: string) {
    super(ERROR_CODES.BROWSER_ERROR, message, { statusCode: 502, internalDetail: detail });
  }
}

export class CancelledError extends AppError {
  constructor() {
    super(ERROR_CODES.JOB_CANCELLED, 'Operation was cancelled', { statusCode: 499 });
  }
}
