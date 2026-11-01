import path from 'node:path';
import fsp from 'node:fs/promises';
import {
  AiActionProposal,
  type ExecutionAction,
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
import { BrowserSession, VIEWPORTS } from '../browser/session.js';
import { captureVerified, clickAndVerify, mapToViewport, navigateToNode } from '../browser/capture.js';
import type { JobContext } from '../jobs/queue.js';
import { sanitize } from './personas.js';
import { computeExecutionCoverage } from './coverage.js';

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

  const videoDir = path.join(paths.evidence, project.id, 'videos', executionId);
  await fsp.mkdir(videoDir, { recursive: true });

  const session = new BrowserSession({ device: 'desktop', videoDir });
  const startedAt = Date.now();
  let actionIndex = 0;
  let navigationCount = 0;
  let status: ExecutionResult['status'] = 'succeeded';
  let failureReason: string | null = null;
  const loopCounter = new Map<string, number>();

  repos.updateExecution(executionId, { status: 'running', startedAt: new Date().toISOString() });

  const record = async (
    a: Omit<ExecutionAction, 'id' | 'executionId' | 'index' | 'timestamp' | 'offsetMs'>,
  ): Promise<ExecutionAction> =>
    repos.addAction({
      executionId,
      index: actionIndex++,
      timestamp: new Date().toISOString(),
      offsetMs: Date.now() - startedAt,
      ...a,
    });

  const capture = async (
    label: string,
    nodeId: string | null,
    screenName: string | null,
  ): Promise<Screenshot | null> => {
    const result = await captureVerified(session, { expectNodeId: nodeId, retries: 1, settleMs: 1200 });
    const safe = (nodeId ?? `step${actionIndex}`).replace(/:/g, '-');
    const rel = `${project.id}/executions/${executionId}/${actionIndex}-${safe}.png`;
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
    });
  };

  try {
    await session.start();

    /* ---- Open the starting screen ---- */
    const startNode = plan.startScreenId ?? screens[0]?.nodeId ?? parsed.startNodeId;
    if (!startNode) throw new Error('This plan has no starting screen and none could be inferred.');

    ctx.progress(0.05, `Opening ${plan.startScreenName ?? startNode}`, 'execution');
    await navigateToNode(session, parsed.fileKey, parsed.fileName, startNode);
    navigationCount++;
    let currentNode = startNode;

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
      if (Date.now() - startedAt > LIMITS.executionTimeoutMs) {
        failureReason = 'Execution timeout reached';
        status = 'failed';
        break;
      }

      ctx.progress(
        0.1 + (0.8 * i) / Math.max(1, plan.steps.length),
        `Step ${i + 1}/${plan.steps.length}: ${step.description.slice(0, 60)}`,
        'execution',
      );

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

  let videoPath: string | null = null;
  try {
    videoPath = await session.finalizeVideo();
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Video finalization failed');
  }
  await session.close();

  if (videoPath) {
    const bytes = await getStorage().size(videoPath);
    repos.addVideo({
      executionId,
      path: videoPath,
      bytes,
      durationMs: Date.now() - startedAt,
      width: VIEWPORTS.desktop.width,
      height: VIEWPORTS.desktop.height,
      status: bytes > 0 ? 'complete' : 'incomplete',
      failureReason: bytes > 0 ? null : 'Recording produced an empty file',
      createdAt: new Date().toISOString(),
    });
  } else {
    repos.addVideo({
      executionId,
      path: '',
      bytes: 0,
      durationMs: Date.now() - startedAt,
      width: null,
      height: null,
      status: 'failed',
      failureReason: 'Playwright did not produce a recording for this session',
      createdAt: new Date().toISOString(),
    });
  }

  repos.updateExecution(executionId, {
    status,
    endedAt: new Date().toISOString(),
    actionCount: actionIndex,
    navigationCount,
    failureReason,
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

  ctx.progress(1, `Execution ${status}`, 'done');
  return { executionId, status, actions: actionIndex, videoPath };
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
}): Promise<StepOutcome> {
  const { session, step, currentNode, screenByNode, edges, capture, parsed } = args;
  const from = currentNode;
  const page = session.getPage();

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
      await page.mouse.wheel(0, 900);
      await page.waitForTimeout(900);
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
      const { extractNodeIdFromViewerUrl } = await import('../figma/url.js');
      const actual = extractNodeIdFromViewerUrl(page.url()) ?? from;
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
          viewport: VIEWPORTS[session.device],
        });

        if (point && point.y <= VIEWPORTS[session.device].height) {
          const res = await clickAndVerify(session, point, chosen.toScreenId);
          const landed = res.actualNodeId ?? from;
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
          await page.mouse.wheel(0, Math.max(0, point.y - VIEWPORTS[session.device].height / 2));
          await page.waitForTimeout(800);
          const res = await clickAndVerify(
            session,
            { x: point.x, y: VIEWPORTS[session.device].height / 2 },
            chosen.toScreenId,
          );
          const landed = res.actualNodeId ?? from;
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
  const { session, step, persona, capture, screenByNode } = args;
  try {
    const page = session.getPage();
    const buffer = await page.screenshot({ timeout: 20_000 });
    const viewport = VIEWPORTS[session.device];

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
