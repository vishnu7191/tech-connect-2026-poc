import type {
  DiscoveryMode,
  DiscoveryWarning,
  EntryPoint,
  GraphEdge,
  Project,
  Screen,
  UnreachableReason,
} from '@lenz/shared';
import { env, hasFigmaToken } from '../config/env.js';
import { FigmaForbiddenError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { getStorage } from '../core/storage.js';
import type { Repositories } from '../db/repositories.js';
import { FigmaClient } from '../figma/client.js';
import { extractFromFile, type ExtractionResult } from '../figma/extract.js';
import { parseFigmaUrl } from '../figma/url.js';
import { analyzeGraph } from '../graph/analyze.js';
import type { JobContext } from '../jobs/queue.js';
import { BrowserSession } from '../browser/session.js';
import { captureVerified, navigateToNode } from '../browser/capture.js';
import { detectViewerBlock } from '../browser/guards.js';
import { probeFigmaAccess } from '../browser/access.js';
import { validateFigmaDocument } from '../figma/validate.js';
import { computeDiscoveryCoverage } from './coverage.js';
import { discoverMakeApplication } from './make-discovery.js';

export interface DiscoveryOptions {
  /** Capture browser screenshots of discovered screens (slow but real evidence). */
  captureScreenshots?: boolean;
  /** Cap on screens to capture, so a 50-screen file does not run for an hour. */
  maxScreensToCapture?: number;
  /** Fetch Figma-rendered design references (never presented as screenshots). */
  fetchDesignReferences?: boolean;
}

export async function runDiscovery(
  repos: Repositories,
  project: Project,
  ctx: JobContext,
  opts: DiscoveryOptions = {},
): Promise<{ mode: DiscoveryMode; warnings: DiscoveryWarning[] }> {
  const parsed = parseFigmaUrl(project.figmaUrl);
  const warnings: DiscoveryWarning[] = [];
  const runId = repos.createDiscoveryRun(project.id, 'rest+browser');

  repos.updateProject(project.id, { status: 'discovering' });

  // Figma Make is an interactive web app - a completely different discovery
  // path, but it feeds the same graph/coverage/UI code.
  if (parsed.kind === 'make') {
    ctx.progress(0.05, 'Opening the Figma Make application', 'make-discovery');
    const result = await discoverMakeApplication(repos, project, parsed, ctx, warnings);
    repos.finishDiscoveryRun(runId, { ...result.stats, mode: 'browser-only', warnings });
    repos.updateProject(project.id, { status: 'discovered' });
    return { mode: 'browser-only', warnings };
  }

  /* ---------------- REST discovery ---------------- */

  let extraction: ExtractionResult | null = null;
  let mode: DiscoveryMode = 'rest+browser';

  if (!parsed.supportsRestDiscovery) {
    warnings.push({
      code: 'rest-not-applicable',
      message: `${parsed.kind} URLs do not expose prototype flows through the REST API.`,
      severity: 'info',
    });
  } else if (!hasFigmaToken()) {
    warnings.push({
      code: 'no-figma-token',
      message:
        'FIGMA_ACCESS_TOKEN is not set, so structural discovery was skipped. Only browser-based discovery is available.',
      severity: 'warning',
    });
    mode = 'browser-only';
  } else {
    ctx.progress(0.05, 'Fetching the Figma document', 'figma-rest');
    const client = new FigmaClient(env.FIGMA_ACCESS_TOKEN!);
    try {
      const file = await client.getFile(parsed.fileKey);
      ctx.throwIfCancelled();
      ctx.progress(0.25, 'Extracting screens and interactions', 'extract');

      // Validate the payload shape BEFORE walking it, so a malformed or
      // unexpected document produces an explanation rather than a TypeError.
      const checked = validateFigmaDocument(file, { fileKey: parsed.fileKey, kind: parsed.kind });
      for (const note of checked.notes) {
        warnings.push({ code: 'document-partially-readable', message: note, severity: 'warning' });
      }

      extraction = extractFromFile(file, { canvases: checked.canvases });

      if (extraction.truncated) {
        warnings.push({
          code: 'document-traversal-truncated',
          message:
            'This file is unusually large or deeply nested, so traversal stopped at a safety limit. The results below are partial.',
          severity: 'warning',
        });
      }

      // A link type that has no prototype flows should say so plainly rather
      // than letting the user wonder why nothing is navigable.
      if (parsed.kind !== 'proto' && extraction.flows.length === 0) {
        warnings.push({
          code: 'no-prototype-flows',
          message: `${parsed.supportNote} No prototype flows were found, so reachability and journey testing are unavailable for this link.`,
          severity: 'info',
        });
      }

      for (const canvas of extraction.canvases) {
        if (!canvas.hasEntryPoint) {
          // The in-file Scenario B case. Not an error - it drives candidate ranking.
          warnings.push({
            code: 'canvas-without-entry-point',
            message: `Canvas "${canvas.name}" declares no prototype start node or flow starting point. Its ${canvas.childCount} top-level nodes are offered as candidate entry points instead.`,
            severity: 'info',
            context: { canvasId: canvas.id, childCount: canvas.childCount },
          });
        }
      }
      if (extraction.deadInteractions.length > 0) {
        // A trigger with no destination is a control that looks clickable but
        // does nothing - a real usability problem, so it is reported rather
        // than quietly dropped.
        const sample = extraction.deadInteractions
          .slice(0, 5)
          .map((d) => `"${d.nodeName}" (${d.trigger})`)
          .join(', ');
        warnings.push({
          code: 'interaction-without-destination',
          message: `${extraction.deadInteractions.length} interaction(s) have a trigger but no destination configured, so they do nothing when clicked. Examples: ${sample}.`,
          severity: 'warning',
          context: { count: extraction.deadInteractions.length },
        });
      }
      if (extraction.unresolvedDestinations > 0) {
        warnings.push({
          code: 'unresolved-destinations',
          message: `${extraction.unresolvedDestinations} interaction destination(s) could not be resolved to a known node and were kept as raw references.`,
          severity: 'warning',
        });
      }
    } catch (err) {
      if (err instanceof FigmaForbiddenError) {
        /**
         * The REST API cannot tell us WHY: Figma returns 404 for both "no such
         * file" and "you cannot see this file", so that file keys cannot be
         * probed. A hedged "may lack permission, or may be private" is not
         * actionable, so ask the browser what a visitor actually sees.
         */
        ctx.progress(0.1, 'Checking whether this file is viewable at all', 'access-probe');
        const probe = await probeFigmaAccess(parsed.fileKey, parsed.fileName, parsed.startNodeId);

        warnings.push({
          code: `figma-${probe.verdict}`,
          message: probe.message,
          severity: probe.verdict === 'public-renders' ? 'warning' : 'error',
          context: { evidence: probe.evidence },
        });

        if (!probe.canUseBrowser) {
          // Nothing can be discovered. Stop cleanly with the real reason
          // rather than running a browser pass that cannot succeed.
          repos.finishDiscoveryRun(runId, {
            mode: 'failed',
            screensDiscovered: 0, componentsExcluded: 0, ambiguousCount: 0, screensReachable: 0,
            disconnectedCount: 0, interactionsFound: 0, screenEdges: 0, uiStateEdges: 0,
            overlayEdges: 0, unsupportedInteractions: 0, confirmedEntryPoints: 0,
            inferredEntryPoints: 0, flowCount: 0, warnings,
          });
          repos.updateProject(project.id, { status: 'discovery-failed' });
          ctx.progress(1, 'Cannot access this file', 'done');
          return { mode: 'failed', warnings };
        }

        mode = 'browser-only';
      } else {
        throw err;
      }
    }
  }

  if (!extraction) {
    // Without REST metadata there is no frame inventory to verify against.
    warnings.push({
      code: 'browser-only-limited',
      message:
        'Browser-only discovery of a Figma prototype can capture the starting screen but cannot enumerate frames or interactions, because that information is only available through the REST API.',
      severity: 'warning',
    });
    repos.finishDiscoveryRun(runId, {
      mode,
      screensDiscovered: 0, componentsExcluded: 0, ambiguousCount: 0, screensReachable: 0,
      disconnectedCount: 0, interactionsFound: 0, screenEdges: 0, uiStateEdges: 0,
      overlayEdges: 0, unsupportedInteractions: 0, confirmedEntryPoints: 0,
      inferredEntryPoints: 0, flowCount: 0, warnings,
    });
    repos.updateProject(project.id, { status: 'discovery-failed' });
    return { mode, warnings };
  }

  /* ---------------- Graph analysis ---------------- */

  ctx.progress(0.35, 'Building the navigation graph', 'graph');
  const analysis = analyzeGraph({
    screens: extraction.screens,
    edges: extraction.edges,
    flows: extraction.flows,
    urlStartNodeId: parsed.startNodeId,
  });

  const screenRows: Array<Omit<Screen, 'id' | 'projectId'>> = extraction.screens.map((s) => ({
    nodeId: s.nodeId,
    name: s.name,
    canvasId: s.canvasId,
    canvasName: s.canvasName,
    nodeType: s.nodeType,
    classification: s.classification,
    classificationScore: s.classificationScore,
    classificationSignals: s.classificationSignals,
    deviceClass: s.deviceClass,
    width: s.width,
    height: s.height,
    absX: s.absX,
    absY: s.absY,
    isEntryPoint: analysis.entryPoints.some((e) => e.nodeId === s.nodeId),
    reachable: analysis.reachable.has(s.nodeId),
    unreachableReason: reasonFor(s.nodeId, s.classification, analysis),
    figmaImageUrl: null,
  }));
  repos.replaceScreens(project.id, screenRows);

  const edgeRows: Array<Omit<GraphEdge, 'id' | 'projectId'>> = extraction.edges.map((e) => ({
    fromScreenId: e.fromNodeId,
    toScreenId: e.toNodeId,
    kind: e.kind,
    figmaNavigation: e.figmaNavigation,
    trigger: e.trigger,
    sourceNodeId: e.sourceNodeId,
    sourceNodeName: e.sourceNodeName,
    sourceAbsX: e.sourceAbsX,
    sourceAbsY: e.sourceAbsY,
    sourceAbsW: e.sourceAbsW,
    sourceAbsH: e.sourceAbsH,
    supported: e.supported,
    unsupportedReason: e.unsupportedReason,
  }));
  repos.replaceEdges(project.id, edgeRows);

  const entryRows: Array<Omit<EntryPoint, 'id' | 'projectId'>> = analysis.entryPoints.map((e) => ({
    screenId: e.nodeId,
    nodeId: e.nodeId,
    screenName: e.name,
    kind: e.kind,
    source: e.source,
    flowName: e.flowName,
    rank: e.rank,
    score: e.score,
    signals: e.signals,
    // Confirmed entries are selected by default; inferred ones require a human choice.
    selected: e.kind === 'confirmed',
  }));
  repos.replaceEntryPoints(project.id, entryRows);

  /* ---------------- Design references (optional) ---------------- */

  if (opts.fetchDesignReferences !== false && hasFigmaToken()) {
    ctx.progress(0.45, 'Fetching Figma design references', 'design-refs');
    try {
      const client = new FigmaClient(env.FIGMA_ACCESS_TOKEN!);
      const ids = screenRows
        .filter((s) => s.classification !== 'component')
        .slice(0, 60)
        .map((s) => s.nodeId);
      const images = await client.getNodeImages(parsed.fileKey, ids, { scale: 1 });
      for (const [nodeId, url] of Object.entries(images)) {
        if (url) repos.setScreenImage(project.id, nodeId, url);
      }
    } catch (err) {
      warnings.push({
        code: 'design-reference-failed',
        message: `Figma design references could not be rendered: ${(err as Error).message}`,
        severity: 'info',
      });
    }
  }

  /* ---------------- Browser verification ---------------- */

  let captured = 0;
  const captureFailures: Array<{ nodeId: string; reason: UnreachableReason }> = [];

  if (opts.captureScreenshots !== false) {
    ctx.progress(0.5, 'Starting the browser', 'browser');
    const targets: typeof screenRows = screenRows
      .filter((s) => s.classification !== 'component')
      .filter((s) => s.reachable || analysis.entryPoints.some((e) => e.nodeId === s.nodeId))
      .slice(0, opts.maxScreensToCapture ?? 12);

    const session = new BrowserSession({ device: 'desktop' });
    try {
      await session.start();

      /**
       * Check the viewer is actually showing the prototype BEFORE capturing
       * anything. A private or deleted prototype renders a perfectly
       * screenshot-able login wall, and capturing that would report it as a
       * discovered screen - confidently wrong, which is worse than failing.
       */
      if (targets[0]) {
        await navigateToNode(session, parsed.fileKey, parsed.fileName, targets[0].nodeId);
        const blocked = await detectViewerBlock(session.getPage());
        if (blocked.block) {
          warnings.push({
            code: `viewer-${blocked.block}`,
            message: blocked.message ?? 'The Figma viewer did not render this prototype.',
            severity: 'error',
            context: { evidence: blocked.evidence },
          });
          logger.warn(
            { projectId: project.id, block: blocked.block },
            'Browser verification skipped: viewer is not showing the prototype',
          );
          // Skip capture entirely; REST results above are still valid and kept.
          targets.length = 0;
        }
      }

      for (let i = 0; i < targets.length; i++) {
        ctx.throwIfCancelled();
        const s = targets[i]!;
        ctx.progress(
          0.5 + (0.45 * i) / Math.max(1, targets.length),
          `Capturing ${s.name} (${i + 1}/${targets.length})`,
          'capture',
        );
        try {
          await navigateToNode(session, parsed.fileKey, parsed.fileName, s.nodeId);
          const result = await captureVerified(session, { expectNodeId: s.nodeId });
          const rel = `${project.id}/discovery/${s.nodeId.replace(/:/g, '-')}.png`;

          if (result.ok && result.buffer) {
            const abs = await getStorage().write(rel, result.buffer);
            repos.addScreenshot({
              projectId: project.id,
              executionId: null,
              screenId: s.nodeId,
              uiStateId: null,
              nodeId: s.nodeId,
              screenName: s.name,
              actionLabel: 'discovery capture',
              path: abs,
              width: result.width,
              height: result.height,
              bytes: result.bytes,
              capturedAt: new Date().toISOString(),
              status: 'valid',
              verification: result.verification,
              failureReason: null,
              source: 'browser',
            });
            captured++;
          } else {
            // Record the failure WITH its reason - never silently skip.
            captureFailures.push({ nodeId: s.nodeId, reason: result.failureReason ?? 'render-failed' });
            repos.addScreenshot({
              projectId: project.id,
              executionId: null,
              screenId: s.nodeId,
              uiStateId: null,
              nodeId: s.nodeId,
              screenName: s.name,
              actionLabel: 'discovery capture',
              path: '',
              width: result.width,
              height: result.height,
              bytes: result.bytes,
              capturedAt: new Date().toISOString(),
              status: 'failed',
              verification: result.verification,
              failureReason: result.failureReason,
              source: 'browser',
            });
            warnings.push({
              code: 'capture-failed',
              message: `Could not capture "${s.name}" (${s.nodeId}): ${result.failureReason}.`,
              severity: 'warning',
            });
          }
        } catch (err) {
          captureFailures.push({ nodeId: s.nodeId, reason: 'render-failed' });
          logger.warn({ nodeId: s.nodeId, err: (err as Error).message }, 'Screen capture failed');
        }
      }
    } finally {
      await session.close();
    }
  }

  /* ---------------- Persist reachability + coverage ---------------- */

  const reasons = new Map<string, string>();
  for (const s of screenRows) {
    if (!analysis.reachable.has(s.nodeId) && s.classification !== 'component') {
      reasons.set(s.nodeId, reasonFor(s.nodeId, s.classification, analysis) ?? 'no-incoming-navigate-edge');
    }
  }
  repos.setScreenReachability(project.id, analysis.reachable, reasons);

  const screens = repos.listScreens(project.id);
  const coverage = computeDiscoveryCoverage({
    screens,
    edges: repos.listEdges(project.id),
    screenshots: repos.listScreenshots({ projectId: project.id, source: 'browser' }),
    totalInteractionActions: extraction.totalInteractionActions,
    deadInteractions: extraction.deadInteractions,
  });
  repos.replaceCoverage(project.id, null, coverage);

  const byKind = (k: string) => extraction!.edges.filter((e) => e.kind === k).length;
  const nonComponent = extraction.screens.filter((s) => s.classification !== 'component');

  repos.finishDiscoveryRun(runId, {
    mode,
    screensDiscovered: nonComponent.length,
    componentsExcluded: extraction.screens.length - nonComponent.length,
    ambiguousCount: extraction.screens.filter((s) => s.classification === 'ambiguous').length,
    screensReachable: analysis.reachable.size,
    disconnectedCount: analysis.disconnected.length,
    interactionsFound: extraction.totalInteractionActions,
    screenEdges: byKind('screen'),
    uiStateEdges: byKind('ui-state'),
    overlayEdges: byKind('overlay'),
    unsupportedInteractions: extraction.edges.filter((e) => !e.supported).length,
    confirmedEntryPoints: analysis.entryPoints.filter((e) => e.kind === 'confirmed').length,
    inferredEntryPoints: analysis.entryPoints.filter((e) => e.kind === 'inferred').length,
    flowCount: analysis.flows.length,
    warnings,
  });

  repos.updateProject(project.id, { status: 'discovered' });
  ctx.progress(1, `Discovered ${nonComponent.length} screens, captured ${captured}`, 'done');
  return { mode, warnings };
}

function reasonFor(
  nodeId: string,
  classification: string,
  analysis: ReturnType<typeof analyzeGraph>,
): UnreachableReason | null {
  if (classification === 'component') return null;
  if (analysis.reachable.has(nodeId)) return null;
  if (analysis.disconnected.includes(nodeId)) return 'disconnected-canvas';
  return 'no-incoming-navigate-edge';
}
