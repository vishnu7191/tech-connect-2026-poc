import fsp from 'node:fs/promises';
import path from 'node:path';
import { ERROR_CODES } from '@lenz/shared';
import { paths } from '../config/env.js';
import { AppError, FigmaForbiddenError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import type { FigmaFileResponse, FigmaImagesResponse } from './types.js';

const FIGMA_MAX_RETRIES = 3;
const FIGMA_API = 'https://api.figma.com';

export interface FigmaMe {
  id: string;
  email: string;
  handle: string;
  img_url: string;
}

/**
 * Figma REST client.
 *
 * The full Rosella document is ~8.67 MB and takes ~6 s to fetch. Interaction
 * data lives on deep descendants, so depth-limited responses cannot be used for
 * graph construction - only for cheap structural previews.
 */
export class FigmaClient {
  constructor(
    private readonly token: string,
    private readonly timeoutMs = 90_000,
  ) {}

  /**
   * Figma rate-limits bursts of requests (observed as HTTP 429 while re-running
   * discovery during development). Retry transient failures with backoff before
   * surfacing them; 403/404 are permission problems and are never retried.
   */
  private async request<T>(path: string, label: string, attempt = 0): Promise<T> {
    try {
      return await this.requestOnce<T>(path, label);
    } catch (err) {
      const retryable =
        err instanceof AppError &&
        err.code === ERROR_CODES.FIGMA_UNAVAILABLE &&
        attempt < FIGMA_MAX_RETRIES;
      if (!retryable) throw err;
      const delay = 1500 * 2 ** attempt + Math.random() * 500;
      logger.warn({ path: label, attempt: attempt + 1, delay: Math.round(delay) }, 'Figma request failed; retrying');
      await new Promise((r) => setTimeout(r, delay));
      return this.request<T>(path, label, attempt + 1);
    }
  }

  private async requestOnce<T>(path: string, label: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const startedAt = Date.now();

    let res: Response;
    try {
      res = await fetch(`${FIGMA_API}${path}`, {
        headers: { 'X-Figma-Token': this.token },
        signal: controller.signal,
      });
    } catch (err) {
      const e = err as Error;
      throw new AppError(
        ERROR_CODES.FIGMA_UNAVAILABLE,
        e.name === 'AbortError'
          ? `Figma request timed out after ${this.timeoutMs}ms (${label})`
          : `Could not reach Figma (${label})`,
        { statusCode: 502, internalDetail: e.message },
      );
    } finally {
      clearTimeout(timer);
    }

    const elapsed = Date.now() - startedAt;

    if (res.status === 401) {
      // A bad or expired token is a configuration problem, not a transient one.
      throw new AppError(
        ERROR_CODES.FIGMA_FORBIDDEN,
        'Figma rejected the access token. Check FIGMA_ACCESS_TOKEN in .env - it may be expired or mistyped.',
        { statusCode: 401 },
      );
    }
    if (res.status === 403 || res.status === 404) {
      // Not fatal to discovery - the caller degrades to browser-only.
      const key = /\/files\/([^/?]+)/.exec(path)?.[1] ?? 'unknown';
      throw new FigmaForbiddenError(key, res.status);
    }
    if (res.status === 429) {
      /**
       * Figma applies a quota to file reads, and it can be long: a
       * `retry-after` of ~393,000 s (4.5 days) was observed after repeatedly
       * fetching an 8.67 MB document during development. Retrying is pointless
       * at that scale, so a long window is reported as a distinct, final error
       * telling the operator when access returns.
       */
      const retryAfterSec = Number(res.headers.get('retry-after') ?? '0');
      if (retryAfterSec > 120) {
        const resumesAt = new Date(Date.now() + retryAfterSec * 1000);
        throw new AppError(
          ERROR_CODES.FIGMA_FORBIDDEN, // non-retryable by the caller
          `Figma has rate-limited file reads for this token until ${resumesAt.toISOString()} ` +
            `(~${Math.round(retryAfterSec / 3600)}h). Cached documents still work; new files cannot be fetched until then.`,
          { statusCode: 429 },
        );
      }
      throw new AppError(ERROR_CODES.FIGMA_UNAVAILABLE, 'Figma rate limit exceeded', {
        statusCode: 429,
      });
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new AppError(ERROR_CODES.FIGMA_UNAVAILABLE, `Figma returned HTTP ${res.status}`, {
        statusCode: 502,
        internalDetail: body.slice(0, 400),
      });
    }

    const json = (await res.json()) as T;
    logger.debug({ path: label, elapsed }, 'Figma request completed');
    return json;
  }

  getMe(): Promise<FigmaMe> {
    return this.request<FigmaMe>('/v1/me', 'me');
  }

  /**
   * Full document - required for interactions.
   *
   * This payload is large (8.67 MB for Rosella, ~6 s) and Figma rate-limits
   * repeated requests; a 429 was hit during development by re-running discovery
   * several times in quick succession. It is therefore cached on disk per file
   * key, which also makes repeated discovery runs fast and keeps development
   * usable while offline.
   */
  async getFile(fileKey: string, opts: { maxAgeMs?: number } = {}): Promise<FigmaFileResponse> {
    const maxAge = opts.maxAgeMs ?? FILE_CACHE_TTL_MS;
    const cached = await readCache(fileKey, maxAge);
    if (cached) {
      logger.debug({ fileKey }, 'Figma document served from cache');
      return cached;
    }
    const file = await this.request<FigmaFileResponse>(
      `/v1/files/${encodeURIComponent(fileKey)}`,
      `files/${fileKey}`,
    );
    await writeCache(fileKey, file);
    return file;
  }

  /** Cheap structural probe: canvases and their top-level children only. */
  getFileShallow(fileKey: string, depth = 2): Promise<FigmaFileResponse> {
    return this.request<FigmaFileResponse>(
      `/v1/files/${encodeURIComponent(fileKey)}?depth=${depth}`,
      `files/${fileKey}?depth=${depth}`,
    );
  }

  /**
   * Server-rendered node images.
   *
   * ADR-0003: these are DESIGN REFERENCES. They are never stored or presented
   * as browser screenshots - only Playwright output counts as runtime evidence.
   */
  async getNodeImages(
    fileKey: string,
    nodeIds: string[],
    opts: { scale?: number; format?: 'png' | 'jpg' | 'svg' } = {},
  ): Promise<Record<string, string | null>> {
    if (nodeIds.length === 0) return {};
    const out: Record<string, string | null> = {};
    // Figma caps ids per request; batch conservatively.
    const BATCH = 40;
    for (let i = 0; i < nodeIds.length; i += BATCH) {
      const batch = nodeIds.slice(i, i + BATCH);
      const params = new URLSearchParams({
        ids: batch.join(','),
        format: opts.format ?? 'png',
        scale: String(opts.scale ?? 1),
      });
      const res = await this.request<FigmaImagesResponse>(
        `/v1/images/${encodeURIComponent(fileKey)}?${params.toString()}`,
        `images/${fileKey}`,
      );
      if (res.err) {
        logger.warn({ fileKey, err: res.err }, 'Figma image render reported an error');
      }
      Object.assign(out, res.images ?? {});
    }
    return out;
  }
}

/* ------------------------------------------------------------------ *
 * On-disk document cache
 *
 * Keyed by file key. Figma's `version` changes when the file is edited, but
 * detecting that needs a request anyway, so a TTL is the pragmatic trade-off:
 * long enough to avoid rate limits during repeated runs, short enough that a
 * design change is picked up the same working day.
 * ------------------------------------------------------------------ */

const FILE_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

function cachePath(fileKey: string): string {
  const safe = fileKey.replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(paths.data, 'figma-cache', `${safe}.json`);
}

async function readCache(fileKey: string, maxAgeMs: number): Promise<FigmaFileResponse | null> {
  try {
    const file = cachePath(fileKey);
    const stat = await fsp.stat(file);
    if (Date.now() - stat.mtimeMs > maxAgeMs) return null;
    return JSON.parse(await fsp.readFile(file, 'utf8')) as FigmaFileResponse;
  } catch {
    return null;
  }
}

async function writeCache(fileKey: string, file: FigmaFileResponse): Promise<void> {
  try {
    const target = cachePath(fileKey);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, JSON.stringify(file));
  } catch (err) {
    // A cache write failure must never fail discovery.
    logger.warn({ fileKey, err: (err as Error).message }, 'Could not cache the Figma document');
  }
}
