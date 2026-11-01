import crypto from 'node:crypto';
import type { Frame } from 'playwright';
import type { DiscoveryWarning, ParsedFigmaUrl, Project, Screen } from '@lenz/shared';
import { logger } from '../core/logger.js';
import { getStorage } from '../core/storage.js';
import type { Repositories } from '../db/repositories.js';
import type { JobContext } from '../jobs/queue.js';
import { BrowserSession } from '../browser/session.js';
import { captureVerified } from '../browser/capture.js';

/**
 * Figma Make discovery (Scenario C).
 *
 * Verified live: the top-level page is Figma chrome; the real application runs
 * in a nested iframe on <uuid>-figmacachedpreview.figma.site and is REAL DOM,
 * so semantic element discovery works.
 *
 * There are no Figma node ids here, so state identity is
 * hash(route + normalized DOM signature). A UI state can change WITHOUT a URL
 * change - a dropdown opening or a tab switching is a meaningful new state -
 * which is why URL alone is insufficient.
 */

interface DiscoveredElement {
  index: number;
  role: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface MakeState {
  signature: string;
  route: string;
  title: string;
  elementCount: number;
}

const MAX_STATES = 12;
const MAX_ACTIONS = 18;

/** Controls whose labels suggest a destructive or irreversible effect. */
const UNSAFE_LABEL = /\b(delete|remove|buy|purchase|pay|checkout|submit payment|send|sign out|log ?out|destroy|reset)\b/i;

export async function discoverMakeApplication(
  repos: Repositories,
  project: Project,
  parsed: ParsedFigmaUrl,
  ctx: JobContext,
  warnings: DiscoveryWarning[],
): Promise<{ stats: MakeStats }> {
  const session = new BrowserSession({ device: 'desktop' });
  const states = new Map<string, MakeState>();
  const screens: Array<Omit<Screen, 'id' | 'projectId'>> = [];
  let actionsExecuted = 0;
  let capturedCount = 0;

  try {
    const page = await session.start();
    await page.goto(parsed.originalUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(8000);
    await session.dismissBanners();

    let frame: Frame;
    try {
      frame = await session.resolveMakePreviewFrame();
    } catch (err) {
      warnings.push({
        code: 'make-preview-unavailable',
        message: (err as Error).message,
        severity: 'error',
      });
      return { stats: emptyStats(warnings.length) };
    }

    /**
     * Wait for the app inside the iframe to actually hydrate.
     *
     * A fixed delay was tried and was not enough: the frame reported
     * "Loading Lenz UX Validation Engine…" with zero controls, producing an
     * empty discovery run. Poll for real interactive content instead.
     */
    const hydrated = await waitForHydration(frame, 45_000);
    if (!hydrated) {
      warnings.push({
        code: 'make-app-not-interactive',
        message:
          'The Figma Make application did not finish loading within 45s - no interactive controls appeared inside the preview frame. The initial state was captured, but exploration was skipped.',
        severity: 'warning',
      });
    }
    ctx.progress(0.2, 'Capturing the initial application state', 'make-discovery');

    const visit = async (label: string): Promise<MakeState | null> => {
      const sig = await signatureOf(frame);
      if (!sig) return null;
      if (states.has(sig.signature)) return states.get(sig.signature)!;

      states.set(sig.signature, sig);
      const shot = await captureVerified(session, { settleMs: 1200, retries: 1 });
      const short = sig.signature.slice(0, 10);

      if (shot.ok && shot.buffer) {
        const abs = await getStorage().write(`${project.id}/make/${short}.png`, shot.buffer);
        repos.addScreenshot({
          projectId: project.id,
          executionId: null,
          screenId: short,
          uiStateId: null,
          nodeId: short,
          screenName: sig.title || label,
          actionLabel: label,
          path: abs,
          width: shot.width,
          height: shot.height,
          bytes: shot.bytes,
          capturedAt: new Date().toISOString(),
          status: 'valid',
          verification: shot.verification,
          failureReason: null,
          source: 'browser',
        });
        capturedCount++;
      } else {
        warnings.push({
          code: 'make-capture-failed',
          message: `Could not capture state "${label}": ${shot.failureReason}.`,
          severity: 'warning',
        });
      }

      screens.push({
        nodeId: short,
        // A DOM app usually keeps one document.title across every state, so
        // naming states by the action that produced them is far more useful
        // than eleven identically-named entries.
        name: label === 'Initial state' ? `Initial state${sig.title ? ` · ${sig.title}` : ''}` : label,
        canvasId: 'make',
        canvasName: 'Figma Make application',
        nodeType: 'UI_STATE',
        classification: 'screen',
        classificationScore: 100,
        classificationSignals: [
          { signal: 'browser-discovered-state', weight: 100, detail: `route ${sig.route}` },
        ],
        deviceClass: 'desktop',
        width: 1440,
        height: 900,
        absX: 0,
        absY: 0,
        isEntryPoint: states.size === 1,
        reachable: true,
        unreachableReason: null,
        figmaImageUrl: null,
      });
      return sig;
    };

    await visit('Initial state');

    /* ---- Explore: click safe controls, detect state changes ---- */

    const elements = await discoverElements(frame);
    logger.info({ count: elements.length }, 'Figma Make: interactive elements discovered');

    for (const el of elements) {
      if (actionsExecuted >= MAX_ACTIONS || states.size >= MAX_STATES) break;
      ctx.throwIfCancelled();

      if (UNSAFE_LABEL.test(el.label)) {
        warnings.push({
          code: 'make-unsafe-action-skipped',
          message: `Skipped "${el.label}" - its label suggests a destructive or irreversible action.`,
          severity: 'info',
        });
        continue;
      }

      ctx.progress(
        0.2 + (0.7 * actionsExecuted) / MAX_ACTIONS,
        `Exploring: ${el.label.slice(0, 50)}`,
        'make-discovery',
      );

      try {
        await frame.locator(`:scope >>> nth=${el.index}`).first().click({ timeout: 4000 }).catch(async () => {
          // Fall back to coordinate click inside the frame's element box.
          await frame.page().mouse.click(el.x + el.width / 2, el.y + el.height / 2);
        });
        actionsExecuted++;
        await frame.page().waitForTimeout(1500);
        await visit(`After clicking "${el.label.slice(0, 60)}"`);
      } catch (err) {
        logger.debug({ label: el.label, err: (err as Error).message }, 'Make interaction failed');
      }
    }

    if (states.size >= MAX_STATES) {
      warnings.push({
        code: 'make-state-limit',
        message: `Exploration stopped after ${MAX_STATES} distinct UI states. More states may exist.`,
        severity: 'info',
      });
    }

    // Never return an empty run without saying why - a silent zero is exactly
    // the kind of result this product must not produce.
    if (screens.length === 0) {
      warnings.push({
        code: 'make-no-states-discovered',
        message:
          'No UI states could be captured from this Figma Make application. The preview frame was reachable but never produced inspectable content, so there is nothing to report rather than an implied empty result.',
        severity: 'error',
      });
    }
    if (elements.length === 0 && screens.length > 0) {
      warnings.push({
        code: 'make-no-interactive-elements',
        message:
          'The application rendered, but no enabled, visible interactive controls were found, so no interactions were executed.',
        severity: 'warning',
      });
    }

    repos.replaceScreens(project.id, screens);
    repos.replaceEdges(project.id, []);
    repos.replaceEntryPoints(
      project.id,
      screens.slice(0, 1).map((s) => ({
        screenId: s.nodeId,
        nodeId: s.nodeId,
        screenName: s.name,
        kind: 'confirmed' as const,
        source: 'urlStartNode' as const,
        flowName: null,
        rank: 1,
        score: 1000,
        signals: [
          { signal: 'make-initial-state', weight: 1000, detail: 'The state the application opened in' },
        ],
        selected: true,
      })),
    );

    return {
      stats: {
        screensDiscovered: screens.length,
        componentsExcluded: 0,
        ambiguousCount: 0,
        screensReachable: screens.length,
        disconnectedCount: 0,
        interactionsFound: elements.length,
        screenEdges: 0,
        uiStateEdges: Math.max(0, states.size - 1),
        overlayEdges: 0,
        unsupportedInteractions: 0,
        confirmedEntryPoints: screens.length > 0 ? 1 : 0,
        inferredEntryPoints: 0,
        flowCount: 1,
      },
    };
  } finally {
    await session.close();
  }
}

/**
 * State identity for a DOM application.
 *
 * Combines the route with a normalized structural signature, so a state change
 * with no URL change (dropdown, tab, modal) still registers as a new state.
 */
async function signatureOf(frame: Frame): Promise<MakeState | null> {
  try {
    // NOTE: do NOT declare named functions inside an evaluate body. esbuild
    // (used by tsx) rewrites them with a `__name` helper that does not exist in
    // the page context, which fails at runtime with
    // "ReferenceError: __name is not defined". Keep everything inline.
    const data = await frame.evaluate(() => {
      const parts: string[] = [];
      const nodes = Array.from(document.querySelectorAll('button, a, [role], input, h1, h2, [aria-expanded], [aria-selected]'));
      for (const el of nodes.slice(0, 180)) {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role') ?? '';
        const expanded = el.getAttribute('aria-expanded') ?? '';
        const selected = el.getAttribute('aria-selected') ?? '';
        const text = (el.textContent ?? '').trim().slice(0, 30);
        parts.push(`${tag}:${role}:${expanded}:${selected}:${text}`);
      }
      return {
        route: location.pathname + location.search + location.hash,
        title: document.title || (document.querySelector('h1')?.textContent ?? '').trim(),
        parts,
        count: parts.length,
      };
    });
    const signature = crypto
      .createHash('sha256')
      .update(`${data.route}|${data.parts.join('|')}`)
      .digest('hex');
    return {
      signature,
      route: data.route,
      title: (data.title ?? '').slice(0, 80),
      elementCount: data.count,
    };
  } catch (err) {
    // Log rather than swallow: a silent null here previously turned a real
    // evaluate failure into an empty discovery run with no explanation.
    logger.warn({ err: (err as Error).message }, 'Could not compute a UI state signature');
    return null;
  }
}

async function discoverElements(frame: Frame): Promise<DiscoveredElement[]> {
  try {
    return await frame.evaluate(() => {
      const out: Array<{ index: number; role: string; label: string; x: number; y: number; width: number; height: number }> = [];
      const candidates = Array.from(
        document.querySelectorAll('button, a[href], [role="button"], [role="tab"], [role="menuitem"], input[type="submit"], select'),
      );
      candidates.forEach((el, i) => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return;
        if ((el as HTMLButtonElement).disabled) return;
        const label =
          (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 80) ||
          el.tagName.toLowerCase();
        out.push({
          index: i,
          role: el.getAttribute('role') ?? el.tagName.toLowerCase(),
          label,
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
        });
      });
      return out.slice(0, 40);
    });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Could not discover interactive elements');
    return [];
  }
}

export interface MakeStats {
  screensDiscovered: number;
  componentsExcluded: number;
  ambiguousCount: number;
  screensReachable: number;
  disconnectedCount: number;
  interactionsFound: number;
  screenEdges: number;
  uiStateEdges: number;
  overlayEdges: number;
  unsupportedInteractions: number;
  confirmedEntryPoints: number;
  inferredEntryPoints: number;
  flowCount: number;
}

function emptyStats(_warnings: number): MakeStats {
  return {
    screensDiscovered: 0, componentsExcluded: 0, ambiguousCount: 0, screensReachable: 0,
    disconnectedCount: 0, interactionsFound: 0, screenEdges: 0, uiStateEdges: 0,
    overlayEdges: 0, unsupportedInteractions: 0, confirmedEntryPoints: 0,
    inferredEntryPoints: 0, flowCount: 0,
  };
}

/**
 * Poll until the application inside the preview frame is genuinely interactive.
 * Returns false on timeout so the caller can report the limitation explicitly
 * rather than silently producing an empty run.
 */
async function waitForHydration(frame: Frame, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ready = await frame.evaluate(() => {
        const controls = document.querySelectorAll(
          'button, a[href], [role="button"], [role="tab"], input, select',
        ).length;
        const text = (document.body?.innerText ?? '').trim();
        const stillLoading = /^loading\b/i.test(text) || text.length < 40;
        return controls > 0 && !stillLoading;
      });
      if (ready) return true;
    } catch {
      // Frame may be navigating; keep waiting.
    }
    await frame.page().waitForTimeout(1500);
  }
  return false;
}
