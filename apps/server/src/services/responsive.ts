import {
  MIN_TOUCH_TARGET_PX,
  type DeviceProfile,
  type Execution,
  type ExecutionAction,
  type InteractionEvent,
  type ResponsiveComparison,
  type ResponsiveDifference,
  type ResponsiveRun,
  type ScrollSample,
  type Screenshot,
  type TestPlan,
  type TouchTargetConcern,
} from '@lenz/shared';
import { defaultDeviceProfile } from '../browser/devices.js';

/**
 * Responsive UX comparison.
 *
 * The guiding rule, taken from the brief and enforced here rather than left to
 * prose: A RESPONSIVE LAYOUT THAT DIFFERS IS NOT A DEFECT. A navigation menu
 * that collapses on mobile, a two-column grid that stacks, a longer page - all
 * of these are the design working. So the comparison separates three things:
 *
 *   - `info`     — a measured difference, presented without judgement.
 *   - `concern`  — a measurement that crosses a PUBLISHED guideline, reported
 *                  with the number and the guideline it was compared against.
 *   - `failure`  — the test itself did not complete on one device and did on
 *                  another. This is the only category Lenz calls a problem
 *                  outright, because it is a recorded fact, not a reading of
 *                  the design.
 *
 * Every entry names the executions it came from, so any claim can be traced
 * back to the evidence.
 */

export const COMPARISON_NOTE =
  'Differences between device runs are reported as measurements, not verdicts. A responsive layout is expected to differ across viewports; only an execution that failed on one device while succeeding on another, or a measurement that crosses a published guideline, is raised above informational.';

export interface ComparisonInput {
  projectId: string;
  plan: TestPlan | null;
  runs: Array<{
    execution: Execution;
    actions: ExecutionAction[];
    interactions: InteractionEvent[];
    scrollSamples: ScrollSample[];
    screenshots: Screenshot[];
  }>;
}

export function buildResponsiveComparison(input: ComparisonInput): ResponsiveComparison {
  const runs = input.runs.map((r) => summarizeRun(r, input.plan));
  return {
    projectId: input.projectId,
    planId: input.plan?.id ?? null,
    planName: input.plan?.name ?? null,
    runs: runs.sort((a, b) => kindRank(a) - kindRank(b) || a.device.width - b.device.width),
    differences: runs.length >= 2 ? compareRuns(runs) : [],
    generatedAt: new Date().toISOString(),
    note:
      runs.length >= 2
        ? COMPARISON_NOTE
        : 'A comparison needs at least two runs of the same plan on different devices. Run the plan again with another device selected.',
  };
}

const kindRank = (r: ResponsiveRun): number =>
  r.device.kind === 'desktop' ? 0 : r.device.kind === 'tablet' ? 1 : 2;

function summarizeRun(
  r: ComparisonInput['runs'][number],
  plan: TestPlan | null,
): ResponsiveRun {
  const { execution, actions, interactions, scrollSamples, screenshots } = r;
  const notes: string[] = [];

  // A run recorded before device selection existed has no profile. Saying so is
  // the only honest option; assuming desktop would put its points in the wrong
  // heatmap group and its geometry in the wrong column of this table.
  let device: DeviceProfile;
  if (execution.device) {
    device = execution.device;
  } else {
    device = defaultDeviceProfile();
    notes.push(
      'This run predates device selection, so no emulation profile was recorded. The geometry shown is the current default and should not be treated as measured.',
    );
  }

  const stepActions = actions.filter((a) => a.stepId !== null);
  const stepsCompleted = stepActions.filter((a) => a.result === 'ok').length;
  const stepsTotal = Math.max(plan?.steps.length ?? 0, stepActions.length);
  const failedActions = actions.filter((a) => a.result === 'failed').length;
  const skippedActions = actions.filter((a) => a.result === 'skipped').length;
  const destinationMismatches = actions.filter((a) => a.verdict === 'mismatch').length;

  const screensVisited: string[] = [];
  for (const a of actions) {
    const screen = a.actualDestinationNode ?? a.screenId;
    if (screen && screensVisited[screensVisited.length - 1] !== screen) screensVisited.push(screen);
  }

  const depths = scrollSamples
    .map((s) => s.depthFraction)
    .filter((d): d is number => d !== null);
  const maxDepthFraction = depths.length > 0 ? Math.max(...depths) : null;
  if (depths.length === 0 && scrollSamples.length > 0) {
    notes.push(
      'Scroll positions were recorded but the document height was never measurable, so scroll depth is unknown for this run.',
    );
  }

  if (interactions.length === 0) {
    notes.push('No interaction events were recorded for this run.');
  }

  return {
    executionId: execution.id,
    device,
    status: execution.status,
    startedAt: execution.startedAt,
    durationMs:
      execution.startedAt && execution.endedAt
        ? new Date(execution.endedAt).getTime() - new Date(execution.startedAt).getTime()
        : null,
    personaId: execution.personaId,
    personaName: execution.personaName,
    stepsCompleted,
    stepsTotal,
    taskCompleted:
      execution.status === 'succeeded' && stepsTotal > 0 && stepsCompleted === stepsTotal,
    actionCount: execution.actionCount,
    navigationCount: execution.navigationCount,
    failedActions,
    skippedActions,
    destinationMismatches,
    interactionCount: interactions.length,
    screensVisited,
    maxDepthFraction,
    touchTargetConcerns: touchTargetConcerns(interactions, device),
    screenshotIds: screenshots
      .filter((s) => s.status === 'valid' && s.source === 'browser' && s.path)
      .map((s) => s.id),
    notes,
  };
}

/**
 * Controls smaller than the published minimum, measured from what was clicked.
 *
 * Only reported for a profile with touch input - a 24 px mouse target is
 * ordinary. The element's measured size is included so a reader can judge it,
 * and the guideline is named rather than presented as Lenz's own rule.
 *
 * This only sees elements a real DOM reported. A Figma prototype renders to a
 * canvas, so its controls have no measurable box and simply do not appear here;
 * that absence is a limitation of the surface, not evidence of compliance.
 */
export function touchTargetConcerns(
  interactions: InteractionEvent[],
  device: DeviceProfile,
): TouchTargetConcern[] {
  if (!device.hasTouch) return [];
  const seen = new Map<string, TouchTargetConcern>();

  for (const e of interactions) {
    if (e.type !== 'tap' && e.type !== 'click') continue;
    if (e.targetWidth === null || e.targetHeight === null) continue;
    if (e.targetWidth <= 0 || e.targetHeight <= 0) continue;
    if (e.targetWidth >= MIN_TOUCH_TARGET_PX && e.targetHeight >= MIN_TOUCH_TARGET_PX) continue;

    const label = e.targetName ?? e.label ?? e.targetSelector ?? 'unnamed control';
    const key = `${label}|${Math.round(e.targetWidth)}x${Math.round(e.targetHeight)}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      label: label.slice(0, 200),
      width: Math.round(e.targetWidth * 10) / 10,
      height: Math.round(e.targetHeight * 10) / 10,
      screenId: e.screenId,
      guideline: `${MIN_TOUCH_TARGET_PX}px minimum (Apple HIG; Material uses 48dp)`,
    });
  }

  return [...seen.values()];
}

function compareRuns(runs: ResponsiveRun[]): ResponsiveDifference[] {
  const out: ResponsiveDifference[] = [];
  const ids = runs.map((r) => r.executionId);
  const label = (r: ResponsiveRun) => `${r.device.label} (${r.device.width}×${r.device.height})`;

  /* ---- task completion ---- */
  const completed = runs.filter((r) => r.taskCompleted);
  if (completed.length > 0 && completed.length < runs.length) {
    const failed = runs.filter((r) => !r.taskCompleted);
    out.push({
      dimension: 'task-completion',
      summary: `The task completed on ${completed.length} of ${runs.length} device configurations.`,
      detail:
        `Completed: ${completed.map(label).join(', ')}. ` +
        `Did not complete: ${failed
          .map((r) => `${label(r)} — ${r.stepsCompleted}/${r.stepsTotal} steps, status ${r.status}`)
          .join('; ')}.`,
      severity: 'failure',
      executionIds: ids,
    });
  } else if (completed.length === runs.length) {
    out.push({
      dimension: 'task-completion',
      summary: 'The task completed on every device configuration tested.',
      detail: runs.map((r) => `${label(r)}: ${r.stepsCompleted}/${r.stepsTotal} steps`).join('; '),
      severity: 'info',
      executionIds: ids,
    });
  }

  /* ---- execution failures ---- */
  const brokenRuns = runs.filter((r) => r.status === 'failed' || r.failedActions > 0);
  if (brokenRuns.length > 0 && brokenRuns.length < runs.length) {
    out.push({
      dimension: 'execution-failure',
      summary: `Actions failed on ${brokenRuns.length} of ${runs.length} configurations but not on the others.`,
      detail: brokenRuns
        .map((r) => `${label(r)}: ${r.failedActions} failed, ${r.skippedActions} skipped`)
        .join('; '),
      severity: 'failure',
      executionIds: brokenRuns.map((r) => r.executionId),
    });
  }

  /* ---- action count ---- */
  const counts = runs.map((r) => r.actionCount);
  const minC = Math.min(...counts);
  const maxC = Math.max(...counts);
  if (maxC !== minC) {
    out.push({
      dimension: 'action-count',
      summary: `The same plan needed between ${minC} and ${maxC} actions depending on the device.`,
      detail: runs.map((r) => `${label(r)}: ${r.actionCount} actions, ${r.navigationCount} navigations`).join('; '),
      severity: 'info',
      executionIds: ids,
    });
  }

  /* ---- navigation path ---- */
  const paths = new Set(runs.map((r) => r.screensVisited.join('>')));
  if (paths.size > 1) {
    out.push({
      dimension: 'navigation-path',
      summary: 'The route through the product differed between devices.',
      detail: runs
        .map((r) => `${label(r)}: ${r.screensVisited.join(' → ') || '(no screens recorded)'}`)
        .join('   |   '),
      severity: 'info',
      executionIds: ids,
    });
  }

  /* ---- control availability ---- */
  // A screen reached on one device and never reached on another. Reported as a
  // concern because it may be a hidden control - but only as a *candidate*: it
  // is equally often a different-but-valid route, which the detail says.
  const visitedSets = runs.map((r) => new Set(r.screensVisited));
  const union = new Set(runs.flatMap((r) => r.screensVisited));
  const missing: string[] = [];
  for (const screen of union) {
    const absent = runs.filter((_, i) => !visitedSets[i]!.has(screen));
    if (absent.length > 0 && absent.length < runs.length) {
      missing.push(`${screen} was not reached on ${absent.map(label).join(', ')}`);
    }
  }
  if (missing.length > 0) {
    out.push({
      dimension: 'control-availability',
      summary: `${missing.length} screen(s) were reached on some devices but not others.`,
      detail: `${missing.join('; ')}. This can mean a control is hidden or moved at that breakpoint, but it can equally mean the persona took a different valid route. Check the recordings before treating it as a defect.`,
      severity: 'concern',
      executionIds: ids,
    });
  }

  /* ---- scroll depth ---- */
  const withDepth = runs.filter((r) => r.maxDepthFraction !== null);
  if (withDepth.length >= 2) {
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    out.push({
      dimension: 'scroll-depth',
      summary: 'Scroll depth reached differed between devices.',
      detail: withDepth.map((r) => `${label(r)}: ${pct(r.maxDepthFraction!)} of the document`).join('; '),
      severity: 'info',
      executionIds: withDepth.map((r) => r.executionId),
    });
  }

  /* ---- touch targets ---- */
  const withConcerns = runs.filter((r) => r.touchTargetConcerns.length > 0);
  if (withConcerns.length > 0) {
    out.push({
      dimension: 'touch-target',
      summary: `${withConcerns.reduce((a, r) => a + r.touchTargetConcerns.length, 0)} control(s) measured below the published minimum touch target on a touch device.`,
      detail: withConcerns
        .map(
          (r) =>
            `${label(r)}: ${r.touchTargetConcerns
              .map((c) => `"${c.label}" at ${c.width}×${c.height}px`)
              .join(', ')}`,
        )
        .join('; '),
      severity: 'concern',
      executionIds: withConcerns.map((r) => r.executionId),
    });
  }

  /* ---- friction ---- */
  const frictionful = runs.filter((r) => r.destinationMismatches > 0 || r.skippedActions > 0);
  if (frictionful.length > 0) {
    out.push({
      dimension: 'friction',
      summary: 'Unexpected destinations or skipped steps were recorded on some devices.',
      detail: frictionful
        .map(
          (r) =>
            `${label(r)}: ${r.destinationMismatches} destination mismatch(es), ${r.skippedActions} skipped step(s)`,
        )
        .join('; '),
      severity: frictionful.length < runs.length ? 'concern' : 'info',
      executionIds: frictionful.map((r) => r.executionId),
    });
  }

  return out;
}

/**
 * Horizontal overflow, measured from recorded document widths.
 *
 * A document wider than the viewport means the layout overflows sideways, which
 * on a phone is almost always unintended. Returns null when no sample carried a
 * document width, rather than reporting "no overflow" from missing data.
 */
export function detectLayoutOverflow(
  samples: ScrollSample[],
): { overflowPx: number; viewportWidth: number } | null {
  const measured = samples.filter((s) => s.documentWidth !== null && s.viewportWidth > 0);
  if (measured.length === 0) return null;
  let worst: { overflowPx: number; viewportWidth: number } | null = null;
  for (const s of measured) {
    const overflow = s.documentWidth! - s.viewportWidth;
    // 1 px of slack absorbs sub-pixel layout rounding, which is not overflow.
    if (overflow > 1 && (!worst || overflow > worst.overflowPx)) {
      worst = { overflowPx: Math.round(overflow), viewportWidth: s.viewportWidth };
    }
  }
  return worst;
}
