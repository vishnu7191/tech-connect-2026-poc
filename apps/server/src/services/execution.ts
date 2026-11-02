import path from 'node:path';
import fsp from 'node:fs/promises';
import {
  AiActionProposal,
  type DeviceProfile,
  type ExecutionAction,
  type InteractionResult as InteractionOutcome,
  type NavigationVerdict,
  type Persona,
  type Project,
  type Screenshot,
  type TestPlan,
  type TestStep,
} from '@lenz/shared';
import { paths } from '../config/env.js';
import { logger } from '../core/logger.js';
import { getStorage } from '../core/storage.js';
import type { Repositories } from '../db/repositories.js';
import { getAiService } from '../ai/service.js';
import { parseFigmaUrl } from '../figma/url.js';
import { BrowserSession } from '../browser/session.js';
import { defaultDeviceProfile } from '../browser/devices.js';
import {
  captureVerified,
  clickAndVerify,
  mapToViewport,
  navigateToNode,
  readViewportState,
  scrollViewport,
} from '../browser/capture.js';
import type { JobContext } from '../jobs/queue.js';
import { sanitize } from './personas.js';
import { computeExecutionCoverage } from './coverage.js';
import { ExecutionClock, InteractionRecorder } from './interaction-recorder.js';

/* ------------------------------------------------------------------ *
 * Safety limits (section 10)
 * ------------------------------------------------------------------ */

export const LIMITS = {
  maxActions: 40,
  maxNavigations: 25,
  actionTimeoutMs: 20_000,
  executionTimeoutMs: 10 * 60_000,
  /** Repeats of the same (state, action) pair before we declare a loop. */
  loopThreshold: 3,
};

/** Pause/resume is cooperative, checked between actions. */
const paused = new Set<string>();
export function pauseExecution(id: string): void {
  paused.add(id);
}
export function resumeExecution(id: string): void {
  paused.delete(id);
}
export function isPaused(id: string): boolean {
  return paused.has(id);
}

export interface ExecutionResult {
  executionId: string;
  status: 'succeeded' | 'failed' | 'cancelled';
  actions: number;
  videoPath: string | null;
  device: string;
  interactionEvents: number;
  scrollSamples: number;
}

/**
 * Map a verified navigation verdict onto an interaction outcome.
 *
 * A MISMATCH counts as a failed interaction here even though the click itself
 * worked: on a heatmap the useful question is "did pressing there do what the
 * persona wanted", and arriving on the wrong screen did not. The verdict is
 * preserved separately on the action row, so nothing is lost by this mapping.
 */
export function outcomeForVerdict(verdict: NavigationVerdict): InteractionOutcome {
  switch (verdict) {
    case 'match':
      return 'success';
    case 'mismatch':
    case 'no-navigation':
    case 'timeout':
      return 'failure';
    default:
      return 'unverified';
  }
}

export async function runExecution(
  repos: Repositories,
  project: Project,
  plan: TestPlan,
  persona: Persona,
  executionId: string,
  ctx: JobContext,
): Promise<ExecutionResult> {
  const parsed = parseFigmaUrl(project.figmaUrl);
  const screens = repos.listScreens(project.id).filter((s) => s.classification !== 'component');
  const edges = repos.listEdges(project.id, 'screen');
  const screenByNode = new Map(screens.map((s) => [s.nodeId, s]));

  // The device was chosen when the run was queued and stored on the execution,
  // so the profile that actually ran is the profile the report describes.
  const stored = repos.getExecution(executionId);
  const device: DeviceProfile = stored?.device ?? defaultDeviceProfile();

  const videoDir = path.join(paths.evidence, project.id, 'videos', executionId);
  await fsp.mkdir(videoDir, { recursive: true });

  const clock = new ExecutionClock();
  const recorder = new InteractionRecorder(
    repos,
    { executionId, projectId: project.id, personaId: persona.id, planId: plan.id },
    device,
    clock,
  );

  const session = new BrowserSession({
    profile: device,
    videoDir,
    onPageInteraction: (event) => recorder.ingestPageEvent(event),
  });

  let actionIndex = 0;
  let navigationCount = 0;
  let status: ExecutionResult['status'] = 'succeeded';
  let failureReason: string | null = null;
  const loopCounter = new Map<string, number>();

  repos.updateExecution(executionId, { status: 'running', startedAt: new Date().toISOString() });

  /** Interaction index at which the current step began. */
  let eventMarker = 0;

  const record = async (
    a: Omit<ExecutionAction, 'id' | 'executionId' | 'index' | 'timestamp' | 'offsetMs'>,
  ): Promise<ExecutionAction> => {
    const firstEventIndex = eventMarker;
    const action = repos.addAction({
      executionId,
      index: actionIndex++,
      timestamp: new Date().toISOString(),
      offsetMs: clock.elapsedMs(),
      ...a,
    });
    // Link every interaction recorded while this step ran to its action row, so
    // the recap timeline and the markers on the video refer to the same thing.
    recorder.attachActionIdSince(firstEventIndex, action.id);
    eventMarker = recorder.nextIndex;
    return action;
  };

  const capture = async (
    label: string,
    nodeId: string | null,
    screenName: string | null,
  ): Promise<Screenshot | null> => {
    const result = await captureVerified(session, { expectNodeId: nodeId, retries: 1, settleMs: 1200 });
    const safe = (nodeId ?? `step${actionIndex}`).replace(/:/g, '-');
    const rel = `${project.id}/executions/${executionId}/${actionIndex}-${safe}.png`;
    const deviceFields = { deviceId: device.id, deviceScaleFactor: device.deviceScaleFactor };
    if (result.ok && result.buffer) {
      const abs = await getStorage().write(rel, result.buffer);
      return repos.addScreenshot({
        projectId: project.id,
        executionId,
        screenId: nodeId,
        uiStateId: null,
        nodeId,
        screenName,
        actionLabel: label,
        path: abs,
        width: result.width,
        height: result.height,
        bytes: result.bytes,
        capturedAt: new Date().toISOString(),
        status: 'valid',
        verification: result.verification,
        failureReason: null,
        source: 'browser',
        ...deviceFields,
      });
    }
    // A failed capture is recorded with its reason, never silently dropped.
    return repos.addScreenshot({
      projectId: project.id,
      executionId,
      screenId: nodeId,
      uiStateId: null,
      nodeId,
      screenName,
      actionLabel: label,
      path: '',
      width: result.width,
      height: result.height,
      bytes: result.bytes,
      capturedAt: new Date().toISOString(),
      status: 'failed',
      verification: result.verification,
      failureReason: result.failureReason,
      source: 'browser',
      ...deviceFields,
    });
  };

  try {
    await session.start();
    recorder.setVideoStart(session.videoStartedAt);

    if (!session.hasPageInstrumentation) {
      logger.warn(
        { executionId },
        'Page-side interaction instrumentation is unavailable; only executor-initiated interactions will be recorded',
      );
    }

    /* ---- Open the starting screen ---- */
    const startNode = plan.startScreenId ?? screens[0]?.nodeId ?? parsed.startNodeId;
    if (!startNode) throw new Error('This plan has no starting screen and none could be inferred.');

    ctx.progress(0.05, `Opening ${plan.startScreenName ?? startNode} on ${device.label}`, 'execution');
    recorder.setContext({ screenId: startNode, screenName: plan.startScreenName, stepId: null });

    await navigateToNode(session, parsed.fileKey, parsed.fileName, startNode);
    await session.refreshInstrumentation();
    navigationCount++;
    let currentNode = startNode;

    recorder.recordPointer({
      type: 'navigation',
      pointer: 'none',
      label: `Opened "${plan.startScreenName ?? startNode}"`,
      coordinateNote: 'Opening a screen by node id is not a pointer interaction.',
      result: 'success',
      url: session.getPage().url(),
    });

    const openShot = await capture('Open starting screen', startNode, plan.startScreenName);
    await record({
      stepId: null,
      description: `Open "${plan.startScreenName ?? startNode}"`,
      actionType: 'navigate',
      screenId: startNode,
      screenName: plan.startScreenName,
      expectedDestinationNode: startNode,
      actualDestinationNode: openShot?.nodeId ?? startNode,
      verdict: 'match',
      screenshotId: openShot?.id ?? null,
      result: openShot?.status === 'valid' ? 'ok' : 'failed',
      error: openShot?.status === 'valid' ? null : `Capture failed: ${openShot?.failureReason}`,
      decidedBy: 'system',
    });

    /* ---- Execute each plan step ---- */

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i]!;

      // Cooperative pause, then cancellation.
      while (isPaused(executionId) && !ctx.isCancelled()) {
        repos.updateExecution(executionId, { status: 'paused' });
        await new Promise((r) => setTimeout(r, 750));
      }
      if (!isPaused(executionId)) repos.updateExecution(executionId, { status: 'running' });
      ctx.throwIfCancelled();

      if (actionIndex >= LIMITS.maxActions) {
        failureReason = `Action limit of ${LIMITS.maxActions} reached`;
        status = 'failed';
        break;
      }
      if (clock.elapsedMs() > LIMITS.executionTimeoutMs) {
        failureReason = 'Execution timeout reached';
        status = 'failed';
        break;
      }

      ctx.progress(
        0.1 + (0.8 * i) / Math.max(1, plan.steps.length),
        `Step ${i + 1}/${plan.steps.length} on ${device.label}: ${step.description.slice(0, 50)}`,
        'execution',
      );

      recorder.setContext({
        stepId: step.id,
        screenId: currentNode,
        screenName: screenByNode.get(currentNode)?.name ?? null,
        actionId: null,
      });

      // Loop prevention on (current state, step).
      const loopKey = `${currentNode}|${step.id}`;
      const seen = (loopCounter.get(loopKey) ?? 0) + 1;
      loopCounter.set(loopKey, seen);
      if (seen > LIMITS.loopThreshold) {
        await record({
          stepId: step.id,
          description: step.description,
          actionType: step.actionType,
          screenId: currentNode,
          screenName: screenByNode.get(currentNode)?.name ?? null,
          expectedDestinationNode: step.expectedScreenId,
          actualDestinationNode: currentNode,
          verdict: 'no-navigation',
          screenshotId: null,
          result: 'skipped',
          error: 'Loop detected - the same step repeated from the same screen',
          decidedBy: 'system',
        });
        continue;
      }

      const outcome = await executeStep({
        session,
        repos,
        project,
        parsed,
        step,
        persona,
        currentNode,
        screenByNode,
        edges,
        capture,
        recorder,
      });

      if (outcome.navigated) navigationCount++;
      currentNode = outcome.currentNode;

      await record({
        stepId: step.id,
        description: step.description,
        actionType: step.actionType,
        screenId: outcome.fromNode,
        screenName: screenByNode.get(outcome.fromNode)?.name ?? null,
        expectedDestinationNode: step.expectedScreenId,
        actualDestinationNode: outcome.actualNode,
        verdict: outcome.verdict,
        screenshotId: outcome.screenshotId,
        result: outcome.result,
        error: outcome.error,
        decidedBy: outcome.decidedBy,
      });

      if (navigationCount >= LIMITS.maxNavigations) {
        failureReason = `Navigation limit of ${LIMITS.maxNavigations} reached`;
        status = 'failed';
        break;
      }
    }

    const actions = repos.listActions(executionId);
    const failed = actions.filter((a) => a.result === 'failed').length;
    if (status === 'succeeded' && failed > 0 && failed === actions.length) {
      status = 'failed';
      failureReason = 'Every action failed';
    }
  } catch (err) {
    const msg = (err as Error).message ?? 'Execution failed';
    status = /cancel/i.test(msg) ? 'cancelled' : 'failed';
    failureReason = msg;
    logger.warn({ executionId, err: msg }, 'Execution ended with an error');
  } finally {
    paused.delete(executionId);
  }

  /* ---- Finalize the recording (must happen before the browser is gone) ---- */

  const videoStartOffsetMs = recorder.videoStartOffsetMs;
  let videoPath: string | null = null;
  try {
    videoPath = await session.finalizeVideo();
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Video finalization failed');
  }
  await session.close();

  // Persist interactions only after the browser is released: late page events
  // can still arrive while the context is closing, and they belong in the run.
  const persisted = recorder.flush();

  if (videoPath) {
    const bytes = await getStorage().size(videoPath);
    repos.addVideo({
      executionId,
      path: videoPath,
      bytes,
      durationMs: clock.elapsedMs(),
      width: device.width,
      height: device.height,
      status: bytes > 0 ? 'complete' : 'incomplete',
      failureReason: bytes > 0 ? null : 'Recording produced an empty file',
      startOffsetMs: videoStartOffsetMs,
      deviceId: device.id,
      createdAt: new Date().toISOString(),
    });
  } else {
    repos.addVideo({
      executionId,
      path: '',
      bytes: 0,
      durationMs: clock.elapsedMs(),
      width: null,
      height: null,
      status: 'failed',
      failureReason: 'Playwright did not produce a recording for this session',
      startOffsetMs: null,
      deviceId: device.id,
      createdAt: new Date().toISOString(),
    });
  }

  const limitations = [
    ...recorder.limitations(),
    ...(session.emulationNote ? [session.emulationNote] : []),
    ...(session.hasPageInstrumentation
      ? []
      : [
          'Page-side interaction instrumentation could not be installed, so only interactions Lenz itself performed were recorded.',
        ]),
  ];
  const combinedFailure = [failureReason, ...limitations].filter(Boolean).join(' · ') || null;

  repos.updateExecution(executionId, {
    status,
    endedAt: new Date().toISOString(),
    actionCount: actionIndex,
    navigationCount,
    failureReason: combinedFailure,
  });

  // Coverage for this execution, stored alongside it.
  const coverage = computeExecutionCoverage({
    plan,
    actions: repos.listActions(executionId),
    edges: repos.listEdges(project.id, 'screen'),
    screenshots: repos.listScreenshots({ executionId }),
    video: repos.getVideoForExecution(executionId),
  });
  repos.replaceCoverage(project.id, executionId, coverage);

  ctx.progress(
    1,
    `Execution ${status} on ${device.label} — ${persisted.events} interaction(s), ${persisted.scrollSamples} scroll sample(s)`,
    'done',
  );
  return {
    executionId,
    status,
    actions: actionIndex,
    videoPath,
    device: device.id,
    interactionEvents: persisted.events,
    scrollSamples: persisted.scrollSamples,
  };
}

/* ------------------------------------------------------------------ *
 * Step execution
 * ------------------------------------------------------------------ */

interface StepOutcome {
  fromNode: string;
  currentNode: string;
  actualNode: string | null;
  verdict: NavigationVerdict;
  result: 'ok' | 'failed' | 'skipped';
  error: string | null;
  screenshotId: string | null;
  navigated: boolean;
  decidedBy: ExecutionAction['decidedBy'];
}

async function executeStep(args: {
  session: BrowserSession;
  repos: Repositories;
  project: Project;
  parsed: ReturnType<typeof parseFigmaUrl>;
  step: TestStep;
  persona: Persona;
  currentNode: string;
  screenByNode: Map<string, { nodeId: string; name: string; absX: number; absY: number; width: number; height: number }>;
  edges: Array<{
    fromScreenId: string; toScreenId: string; trigger: string; sourceNodeName: string;
    sourceAbsX: number | null; sourceAbsY: number | null; sourceAbsW: number | null; sourceAbsH: number | null;
    supported: boolean;
  }>;
  capture: (label: string, nodeId: string | null, name: string | null) => Promise<Screenshot | null>;
  recorder: InteractionRecorder;
}): Promise<StepOutcome> {
  const { session, step, currentNode, screenByNode, edges, capture, parsed, recorder } = args;
  const from = currentNode;
  const page = session.getPage();
  const viewport = session.viewport;
  const touch = session.profile.hasTouch;

  const base = {
    fromNode: from,
    currentNode: from,
    actualNode: from,
    verdict: 'not-applicable' as NavigationVerdict,
    result: 'ok' as const,
    error: null as string | null,
    screenshotId: null as string | null,
    navigated: false,
    decidedBy: 'plan-step' as ExecutionAction['decidedBy'],
  };

  switch (step.actionType) {
    case 'wait': {
      await page.waitForTimeout(1500);
      const shot = await capture(step.description, from, screenByNode.get(from)?.name ?? null);
      return { ...base, screenshotId: shot?.id ?? null };
    }

    case 'scroll': {
      // On a touch profile this is a real finger drag; the recorded event says
      // which mechanism was used so the gesture is never overstated.
      const outcome = await scrollViewport(session, 900);
      recorder.recordPointer({
        type: 'scroll',
        pointer: touch ? 'touch' : 'none',
        label: step.description,
        occurredAtMs: outcome.startedAt,
        coordinateNote:
          'A scroll gesture moves the viewport rather than activating a point, so it has no click position.',
        result: outcome.movedPx === null ? 'unverified' : outcome.movedPx !== 0 ? 'success' : 'failure',
        resultNote:
          outcome.error ??
          (outcome.movedPx === null
            ? 'The scroll position could not be read, so the movement is unverified.'
            : outcome.movedPx === 0
              ? 'The gesture was dispatched but the page did not move.'
              : `Performed with ${outcome.method}; the page moved ${outcome.movedPx}px.`),
        url: page.url(),
        deltaY: outcome.movedPx,
        scrollX: outcome.after?.scrollX ?? null,
        scrollY: outcome.after?.scrollY ?? null,
        documentWidth: outcome.after?.documentWidth ?? null,
        documentHeight: outcome.after?.documentHeight ?? null,
      });
      const shot = await capture(step.description, from, screenByNode.get(from)?.name ?? null);
      return { ...base, screenshotId: shot?.id ?? null };
    }

    case 'verify': {
      const shot = await capture(step.description, from, screenByNode.get(from)?.name ?? null);
      return {
        ...base,
        screenshotId: shot?.id ?? null,
        result: shot?.status === 'valid' ? 'ok' : 'failed',
        error: shot?.status === 'valid' ? null : `Could not capture evidence: ${shot?.failureReason}`,
      };
    }

    case 'back': {
      await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
      await page.waitForTimeout(1200);
      await session.refreshInstrumentation();
      const { extractNodeIdFromViewerUrl } = await import('../figma/url.js');
      const actual = extractNodeIdFromViewerUrl(page.url()) ?? from;
      recorder.recordPointer({
        type: 'navigation',
        pointer: 'none',
        label: 'Went back',
        coordinateNote: 'Browser history navigation has no pointer position.',
        result: actual !== from ? 'success' : 'unverified',
        url: page.url(),
      });
      const shot = await capture(step.description, actual, screenByNode.get(actual)?.name ?? null);
      return {
        ...base,
        currentNode: actual,
        actualNode: actual,
        navigated: actual !== from,
        screenshotId: shot?.id ?? null,
      };
    }

    case 'navigate': {
      // Deterministic jump when the plan names a destination in the graph.
      const target = step.expectedScreenId;
      if (!target) {
        return { ...base, result: 'skipped', error: 'Step did not identify a known destination screen' };
      }
      await navigateToNode(session, parsed.fileKey, parsed.fileName, target);
      await session.refreshInstrumentation();
      recorder.setContext({ screenId: target, screenName: screenByNode.get(target)?.name ?? null });
      recorder.recordPointer({
        type: 'navigation',
        pointer: 'none',
        label: `Opened "${screenByNode.get(target)?.name ?? target}"`,
        coordinateNote: 'Opening a screen by node id is not a pointer interaction.',
        result: 'success',
        url: page.url(),
      });
      const shot = await capture(step.description, target, screenByNode.get(target)?.name ?? null);
      return {
        ...base,
        currentNode: target,
        actualNode: target,
        verdict: shot?.verification?.nodeMatches === false ? 'mismatch' : 'match',
        navigated: true,
        screenshotId: shot?.id ?? null,
        decidedBy: 'figma-metadata',
      };
    }

    case 'type': {
      // Synthetic data only; prototypes have no real inputs to submit to.
      const shot = await capture(step.description, from, screenByNode.get(from)?.name ?? null);
      return {
        ...base,
        screenshotId: shot?.id ?? null,
        result: 'skipped',
        error: 'Text entry is not supported in a Figma prototype viewer; step recorded as not executed.',
      };
    }

    case 'click':
    default: {
      /* ---- Deterministic path: find the matching edge from Figma metadata ---- */
      const frame = screenByNode.get(from);
      const candidates = edges.filter((e) => e.fromScreenId === from && e.supported);

      const scored = candidates
        .map((e) => ({ e, score: matchScore(step, e) }))
        .filter((c) => c.score > 0)
        .sort((a, b) => b.score - a.score);

      const chosen = scored[0]?.e;

      if (chosen && frame && chosen.sourceAbsX !== null && chosen.sourceAbsY !== null) {
        const point = mapToViewport({
          frame: { absX: frame.absX, absY: frame.absY, width: frame.width, height: frame.height },
          target: {
            absX: chosen.sourceAbsX,
            absY: chosen.sourceAbsY,
            width: chosen.sourceAbsW ?? 10,
            height: chosen.sourceAbsH ?? 10,
          },
          viewport,
        });

        if (point && point.y <= viewport.height) {
          const res = await clickAndVerify(session, point, chosen.toScreenId);
          const landed = res.actualNodeId ?? from;
          await recordActivation({
            recorder,
            session,
            point,
            edge: chosen,
            scale: point.scale,
            step,
            verdict: res.verdict,
            expected: chosen.toScreenId,
            landed,
            occurredAtMs: res.dispatchedAt,
          });
          const shot = await capture(step.description, landed, screenByNode.get(landed)?.name ?? null);
          return {
            ...base,
            currentNode: landed,
            actualNode: landed,
            verdict: res.verdict,
            navigated: landed !== from,
            screenshotId: shot?.id ?? null,
            // A mismatch is a finding, not an execution error.
            result: res.verdict === 'no-navigation' ? 'failed' : 'ok',
            error:
              res.verdict === 'no-navigation'
                ? 'Click produced no navigation'
                : res.verdict === 'mismatch'
                  ? `Expected ${chosen.toScreenId} but reached ${landed}`
                  : null,
            decidedBy: 'figma-metadata',
          };
        }

        if (point) {
          // Target is below the fold - scroll it into view, then retry once.
          const scroll = await scrollViewport(session, Math.max(0, point.y - viewport.height / 2));
          recorder.recordPointer({
            type: 'scroll',
            pointer: touch ? 'touch' : 'none',
            label: `Scrolled to bring "${chosen.sourceNodeName}" into view`,
            occurredAtMs: scroll.startedAt,
            coordinateNote: 'A scroll gesture has no activation point.',
            result: scroll.movedPx === null ? 'unverified' : scroll.movedPx !== 0 ? 'success' : 'failure',
            resultNote: scroll.error,
            url: page.url(),
            deltaY: scroll.movedPx,
            scrollX: scroll.after?.scrollX ?? null,
            scrollY: scroll.after?.scrollY ?? null,
            documentWidth: scroll.after?.documentWidth ?? null,
            documentHeight: scroll.after?.documentHeight ?? null,
          });

          const retryPoint = { x: point.x, y: viewport.height / 2 };
          const res = await clickAndVerify(session, retryPoint, chosen.toScreenId);
          const landed = res.actualNodeId ?? from;
          await recordActivation({
            recorder,
            session,
            point: retryPoint,
            edge: chosen,
            scale: point.scale,
            step,
            verdict: res.verdict,
            expected: chosen.toScreenId,
            landed,
            occurredAtMs: res.dispatchedAt,
          });
          const shot = await capture(step.description, landed, screenByNode.get(landed)?.name ?? null);
          return {
            ...base,
            currentNode: landed,
            actualNode: landed,
            verdict: res.verdict,
            navigated: landed !== from,
            screenshotId: shot?.id ?? null,
            result: res.verdict === 'no-navigation' ? 'failed' : 'ok',
            error: res.verdict === 'no-navigation' ? 'Click after scrolling produced no navigation' : null,
            decidedBy: 'figma-metadata',
          };
        }
      }

      /* ---- AI vision fallback: the control could not be mapped ---- */
      const aiOutcome = await tryAiVisionClick(args, from);
      if (aiOutcome) return aiOutcome;

      recorder.recordPointer({
        type: touch ? 'tap' : 'click',
        pointer: touch ? 'touch' : 'mouse',
        label: step.description,
        coordinateNote:
          'No interaction on this screen could be mapped to a viewport position, so nothing was activated. A coordinate is deliberately not invented here.',
        result: 'failure',
        resultNote: 'No matching interaction was found and vision could not identify a target.',
        url: page.url(),
      });

      const shot = await capture(step.description, from, screenByNode.get(from)?.name ?? null);
      return {
        ...base,
        screenshotId: shot?.id ?? null,
        result: 'failed',
        error: 'No matching interaction was found on this screen, and vision could not identify a target.',
      };
    }
  }
}

/**
 * Record an activation Lenz performed against a mapped Figma interaction.
 *
 * The target's size is scaled from Figma canvas pixels into viewport pixels
 * using the same transform that placed the click. That matters: the viewer fits
 * a frame to the viewport WIDTH, so a 1440-wide frame opened at 390 renders
 * every control at 0.27x. Recording the canvas size would describe a control
 * that is not what the persona was asked to hit.
 */
async function recordActivation(args: {
  recorder: InteractionRecorder;
  session: BrowserSession;
  point: { x: number; y: number };
  edge: { sourceNodeName: string; sourceAbsW: number | null; sourceAbsH: number | null };
  scale: number;
  step: TestStep;
  verdict: NavigationVerdict;
  expected: string | null;
  landed: string;
  /** When the press was dispatched, not when the verdict came back. */
  occurredAtMs: number;
}): Promise<void> {
  const { recorder, session, point, edge, scale, step, verdict, expected, landed, occurredAtMs } = args;
  const page = session.getPage();
  const touch = session.profile.hasTouch;
  const state = await readViewportState(page);

  recorder.recordPointer({
    type: touch ? 'tap' : 'click',
    pointer: touch ? 'touch' : 'mouse',
    label: `${touch ? 'Tapped' : 'Clicked'} ${edge.sourceNodeName}`,
    occurredAtMs,
    x: point.x,
    y: point.y,
    targetRole: 'figma-interaction',
    targetName: edge.sourceNodeName,
    targetSelector: null,
    targetWidth: edge.sourceAbsW !== null ? edge.sourceAbsW * scale : null,
    targetHeight: edge.sourceAbsH !== null ? edge.sourceAbsH * scale : null,
    result: outcomeForVerdict(verdict),
    resultNote:
      verdict === 'mismatch'
        ? `The activation worked but reached ${landed} instead of ${expected}.`
        : verdict === 'no-navigation'
          ? 'The activation was dispatched but the prototype did not move.'
          : null,
    url: page.url(),
    scrollX: state?.scrollX ?? null,
    scrollY: state?.scrollY ?? null,
    documentWidth: state?.documentWidth ?? null,
    documentHeight: state?.documentHeight ?? null,
  });
  void step;
}

/** Crude but effective matching of a plan step to a real interaction. */
function matchScore(step: TestStep, edge: { sourceNodeName: string; toScreenId: string }): number {
  const hint = (step.targetHint ?? '').toLowerCase();
  const desc = step.description.toLowerCase();
  const name = edge.sourceNodeName.toLowerCase();
  let score = 1; // any supported edge is weakly plausible

  if (step.expectedScreenId && edge.toScreenId === step.expectedScreenId) score += 50;
  if (hint && name.includes(hint)) score += 30;
  if (hint && hint.includes(name) && name.length > 3) score += 20;
  for (const word of desc.split(/\W+/).filter((w) => w.length > 3)) {
    if (name.includes(word)) score += 4;
  }
  return score;
}

/**
 * Vision fallback.
 *
 * ADR-0008: the model proposes an action from a CLOSED vocabulary and its
 * output is schema-validated. It cannot supply JavaScript or an arbitrary URL,
 * and coordinates are clamped to the viewport before use.
 */
async function tryAiVisionClick(
  args: Parameters<typeof executeStep>[0],
  from: string,
): Promise<StepOutcome | null> {
  const { session, step, persona, capture, screenByNode, recorder } = args;
  try {
    const page = session.getPage();
    const buffer = await page.screenshot({ timeout: 20_000 });
    const viewport = session.viewport;
    const touch = session.profile.hasTouch;

    const res = await getAiService().completeStructured(
      'autonomousTesting',
      {
        messages: [
          {
            role: 'system',
            content:
              'You guide a synthetic persona through a clickable prototype. You may only propose actions from the allowed set. Never propose code, URLs, or destructive actions.',
          },
          {
            role: 'user',
            content: [
              `Persona: ${sanitize(persona.name)} (${persona.technicalProficiency} proficiency)`,
              `Current task: ${sanitize(step.description)}`,
              `They are looking for: ${sanitize(step.targetHint ?? 'the most likely control for this task')}`,
              `They are using a ${session.profile.kind} device: ${sanitize(session.profile.label)}.`,
              `The screenshot is ${viewport.width}x${viewport.height} pixels.`,
              '',
              'Return JSON:',
              '{ "action": { "type": "click", "x": <number>, "y": <number>, "label": "<what you are clicking>" },',
              '  "observation": "<what you see that is relevant>",',
              '  "confidence": <0..1> }',
              '',
              'If no suitable control is visible, use { "action": { "type": "done", "reason": "..." } } instead.',
            ].join('\n'),
          },
        ],
        temperature: 0.2,
        maxOutputTokens: 4000,
      },
      AiActionProposal,
      { schemaName: 'action' },
    );

    const action = res.data.action;
    if (action.type !== 'click') return null;

    // Clamp into the viewport - never trust model coordinates directly.
    const x = Math.max(1, Math.min(action.x, viewport.width - 1));
    const y = Math.max(1, Math.min(action.y, viewport.height - 1));

    const click = await clickAndVerify(session, { x, y }, step.expectedScreenId ?? null);
    const landed = click.actualNodeId ?? from;

    const state = await readViewportState(page);
    recorder.recordPointer({
      type: touch ? 'tap' : 'click',
      pointer: touch ? 'touch' : 'mouse',
      label: `${touch ? 'Tapped' : 'Clicked'} ${action.label}`,
      occurredAtMs: click.dispatchedAt,
      x,
      y,
      // The size of what vision aimed at is genuinely unknown - it identified a
      // position in an image, not an element with a measured box.
      targetRole: 'vision-identified',
      targetName: action.label,
      targetWidth: null,
      targetHeight: null,
      result: outcomeForVerdict(click.verdict),
      resultNote: `Target chosen by vision (confidence ${res.data.confidence.toFixed(2)}); the element's real bounds are unknown.`,
      url: page.url(),
      scrollX: state?.scrollX ?? null,
      scrollY: state?.scrollY ?? null,
      documentWidth: state?.documentWidth ?? null,
      documentHeight: state?.documentHeight ?? null,
    });

    const shot = await capture(step.description, landed, screenByNode.get(landed)?.name ?? null);

    return {
      fromNode: from,
      currentNode: landed,
      actualNode: landed,
      verdict: click.verdict,
      navigated: landed !== from,
      screenshotId: shot?.id ?? null,
      result: click.verdict === 'no-navigation' ? 'failed' : 'ok',
      error:
        click.verdict === 'no-navigation'
          ? `Vision chose "${action.label}" but the click produced no navigation`
          : null,
      decidedBy: 'ai-vision',
    };
  } catch (err) {
    logger.debug({ err: (err as Error).message }, 'Vision fallback failed');
    return null;
  }
}
