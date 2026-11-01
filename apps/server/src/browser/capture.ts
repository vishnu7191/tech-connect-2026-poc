import type { Page } from 'playwright';
import type { NavigationVerdict, ScreenshotVerification, UnreachableReason } from '@lenz/shared';
import { logger } from '../core/logger.js';
import { buildPrototypeUrl, extractNodeIdFromViewerUrl } from '../figma/url.js';
import type { BrowserSession } from './session.js';

/**
 * Screenshot capture with verification, and URL-based destination checking.
 *
 * ADR-0004: the Figma viewer reflects the current frame in its URL, which makes
 * "did this interaction go where it was supposed to?" a cheap, deterministic
 * assertion rather than a brittle visual diff.
 */

export interface CaptureResult {
  buffer: Buffer | null;
  width: number;
  height: number;
  bytes: number;
  verification: ScreenshotVerification;
  ok: boolean;
  failureReason: UnreachableReason | null;
  actualNodeId: string | null;
}

/**
 * Blankness heuristic, calibrated against measured values.
 *
 * PNG size per pixel is a cheap proxy for rendered entropy, and avoids pulling
 * in a decoder purely to compute pixel variance. Measurements taken on this
 * project at a 1440x900 viewport:
 *
 *   solid-colour fill (the true "blank" floor) .... 5,934 B   0.00458 bpp
 *   "search" frame, 390x30, sparse but rendered ... 7,597 B   0.00586 bpp
 *   "LoginPhone" frame, 195x380 .................. 11,993 B   0.00925 bpp
 *   "Home" full page ............................ 462,558 B   0.35691 bpp
 *
 * The important conclusion is that bytes-per-pixel CANNOT cleanly separate a
 * genuinely sparse screen from an unpainted one: a small frame on a large
 * viewport sits only ~28% above the solid-fill floor.
 *
 * So rather than pick an arbitrary cutoff and silently fail real screens, the
 * check does two things:
 *   - BLANK below 1.2x the solid-fill floor, which only catches a page that
 *     genuinely never painted.
 *   - SPARSE between that and a comfortable content threshold: still a valid
 *     capture, but flagged so the UI and the analysis stage know the evidence
 *     is thin.
 *
 * Reporting "sparse" is more honest than converting uncertainty into a
 * pass/fail verdict the measurement cannot actually support.
 */
export const SOLID_FILL_BYTES_PER_PIXEL = 0.00458;
export const BLANK_BYTES_PER_PIXEL = SOLID_FILL_BYTES_PER_PIXEL * 1.2; // 0.0055
export const SPARSE_BYTES_PER_PIXEL = 0.02;

export function assessBlankness(bytes: number, width: number, height: number) {
  const pixels = Math.max(1, width * height);
  const bpp = bytes / pixels;
  return {
    blanknessScore: bpp,
    nonBlank: bpp >= BLANK_BYTES_PER_PIXEL,
    sparse: bpp >= BLANK_BYTES_PER_PIXEL && bpp < SPARSE_BYTES_PER_PIXEL,
  };
}

export interface WaitOptions {
  settleMs?: number;
  timeoutMs?: number;
}

/** Wait for the prototype to paint and stop changing. */
export async function waitForStability(page: Page, opts: WaitOptions = {}): Promise<boolean> {
  const settleMs = opts.settleMs ?? 2500;
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: opts.timeoutMs ?? 30_000 });
    // The Figma viewer renders to canvas after load; networkidle is a better
    // signal than load, but must not be fatal when long-polling keeps it busy.
    await page
      .waitForLoadState('networkidle', { timeout: opts.timeoutMs ?? 15_000 })
      .catch(() => undefined);
    await page.waitForTimeout(settleMs);
    return true;
  } catch {
    return false;
  }
}

export interface CaptureOptions {
  expectNodeId?: string | null;
  settleMs?: number;
  retries?: number;
  fullPage?: boolean;
}

/**
 * Capture a screenshot and verify it.
 *
 * A capture is not trusted until it passes validation: a failed capture is
 * recorded WITH A REASON rather than dropped, and never counted as captured.
 */
export async function captureVerified(
  session: BrowserSession,
  opts: CaptureOptions = {},
): Promise<CaptureResult> {
  const page = session.getPage();
  const retries = opts.retries ?? 2;
  let last: CaptureResult | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    // Each retry waits longer - most blank captures are simply too early.
    const settled = await waitForStability(page, { settleMs: (opts.settleMs ?? 2500) + attempt * 2000 });
    // Banners reappear after navigation, so re-check on every attempt.
    await session.dismissBanners();

    let buffer: Buffer | null = null;
    try {
      buffer = await page.screenshot({ fullPage: opts.fullPage ?? false, timeout: 30_000 });
    } catch (err) {
      logger.warn({ err: (err as Error).message, attempt }, 'Screenshot attempt failed');
    }

    const viewport = page.viewportSize() ?? { width: 0, height: 0 };
    const bytes = buffer?.length ?? 0;
    const { blanknessScore, nonBlank, sparse } = assessBlankness(bytes, viewport.width, viewport.height);
    const actualNodeId = extractNodeIdFromViewerUrl(page.url());
    const nodeMatches = opts.expectNodeId ? actualNodeId === opts.expectNodeId : null;

    const verification: ScreenshotVerification = {
      fileExists: bytes > 0,
      readable: bytes > 0 && isPng(buffer),
      nonBlank,
      blanknessScore,
      nodeMatches,
      settled,
      sparse,
    };

    const ok =
      verification.fileExists &&
      verification.readable &&
      verification.nonBlank &&
      nodeMatches !== false;

    last = {
      buffer,
      width: viewport.width,
      height: viewport.height,
      bytes,
      verification,
      ok,
      failureReason: ok ? null : failureReasonFor(verification),
      actualNodeId,
    };

    if (ok) return last;

    if (attempt < retries) {
      logger.debug(
        { attempt, reason: last.failureReason, expected: opts.expectNodeId, actual: actualNodeId },
        'Capture failed verification; retrying',
      );
      // A reload clears a half-painted canvas more reliably than waiting.
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
    }
  }

  return last!;
}

function failureReasonFor(v: ScreenshotVerification): UnreachableReason {
  if (!v.fileExists || !v.readable) return 'render-failed';
  if (v.nodeMatches === false) return 'destination-mismatch';
  if (!v.nonBlank) return 'blank-screenshot';
  return 'render-failed';
}

function isPng(buf: Buffer | null): boolean {
  if (!buf || buf.length < 8) return false;
  return (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  );
}

/* ------------------------------------------------------------------ *
 * Navigation
 * ------------------------------------------------------------------ */

/**
 * Jump straight to a frame by node id.
 *
 * Verified live. This gives deterministic coverage: every discovered screen can
 * be captured without replaying long click chains, so one broken interaction
 * cannot block capture of everything behind it.
 */
export async function navigateToNode(
  session: BrowserSession,
  fileKey: string,
  fileName: string | null,
  nodeId: string,
): Promise<void> {
  const page = session.getPage();
  // No `scaling` parameter: the viewer's default fits the frame to the viewport
  // WIDTH and allows vertical scrolling. `scaling=contain` was tried and shrank
  // a 1440x5446 page to an unreadable thumbnail - useless as vision-model input.
  const url = buildPrototypeUrl(fileKey, fileName, nodeId);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await session.dismissBanners();
}

export interface InteractionResult {
  verdict: NavigationVerdict;
  actualNodeId: string | null;
  error: string | null;
}

/**
 * Click at viewport coordinates and verify where the prototype actually went.
 *
 * A MISMATCH is a legitimate result, not an error - a prototype whose
 * interaction leads somewhere unexpected is a genuine UX finding, and this is
 * the mechanism that detects it.
 */
export async function clickAndVerify(
  session: BrowserSession,
  point: { x: number; y: number },
  expectedNodeId: string | null,
  opts: { waitMs?: number } = {},
): Promise<InteractionResult> {
  const page = session.getPage();
  const before = extractNodeIdFromViewerUrl(page.url());

  try {
    await page.mouse.click(point.x, point.y);
  } catch (err) {
    return { verdict: 'timeout', actualNodeId: before, error: (err as Error).message };
  }

  const waitMs = opts.waitMs ?? 4000;
  const deadline = Date.now() + waitMs;
  let actual = before;

  // Poll rather than wait a fixed period: most transitions settle quickly.
  while (Date.now() < deadline) {
    await page.waitForTimeout(250);
    actual = extractNodeIdFromViewerUrl(page.url());
    if (expectedNodeId && actual === expectedNodeId) break;
    if (!expectedNodeId && actual !== before) break;
  }

  if (actual === before) {
    return { verdict: 'no-navigation', actualNodeId: actual, error: null };
  }
  if (!expectedNodeId) {
    return { verdict: 'not-applicable', actualNodeId: actual, error: null };
  }
  return {
    verdict: actual === expectedNodeId ? 'match' : 'mismatch',
    actualNodeId: actual,
    error: null,
  };
}

/* ------------------------------------------------------------------ *
 * Coordinate mapping
 * ------------------------------------------------------------------ */

/**
 * Map a node's absolute Figma canvas geometry into viewport coordinates.
 *
 * The viewer scales the active frame to fit, so the transform is derived from
 * the frame's own bounds versus the viewport. Returns null when the target
 * cannot be placed, so the caller records the interaction as unexecutable
 * rather than clicking blindly at the wrong place.
 */
export function mapToViewport(params: {
  frame: { absX: number; absY: number; width: number; height: number };
  target: { absX: number; absY: number; width: number; height: number };
  viewport: { width: number; height: number };
  scaling?: 'contain' | 'fit-width';
}): { x: number; y: number; scale: number } | null {
  const { frame, target, viewport } = params;
  if (frame.width <= 0 || frame.height <= 0) return null;

  // 'contain' scaling never enlarges beyond 1:1 in the Figma viewer.
  const scale = Math.min(viewport.width / frame.width, 1);

  const relX = target.absX - frame.absX;
  const relY = target.absY - frame.absY;
  const centerX = (relX + target.width / 2) * scale;
  const centerY = (relY + target.height / 2) * scale;

  // Horizontal centring when the scaled frame is narrower than the viewport.
  const offsetX = Math.max(0, (viewport.width - frame.width * scale) / 2);
  const x = centerX + offsetX;
  const y = centerY;

  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return null;
  return { x, y, scale };
}
