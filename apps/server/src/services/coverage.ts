import type {
  CoverageMetric,
  CoverageMiss,
  ExecutionAction,
  GraphEdge,
  Screen,
  Screenshot,
  TestPlan,
  VideoRecord,
} from '@lenz/shared';

/**
 * The seven coverage dimensions, tracked INDEPENDENTLY.
 *
 * Collapsing them into a single percentage is exactly the misleading summary
 * the product must avoid. Two rules are enforced here:
 *
 *   1. A dimension reaches 100% only when its miss-list is empty.
 *   2. Every miss carries a machine-readable reason, so the UI can explain a
 *      gap instead of showing an unexplained shortfall.
 *
 * Items excluded BY DESIGN (component sets, for instance) are reported
 * separately from failures. Excluding a COMPONENT_SET is correct behaviour, not
 * a coverage gap, and conflating the two would hide real failures.
 */

function metric(
  dimension: CoverageMetric['dimension'],
  numerator: number,
  denominator: number,
  misses: CoverageMiss[],
  excludedCount = 0,
  note: string | null = null,
): CoverageMetric {
  // Guard against a rounding path that would display 100% with misses present.
  const pct = denominator > 0 ? numerator / denominator : null;
  const safePct = pct !== null && misses.length > 0 ? Math.min(pct, 0.999) : pct;
  return { dimension, numerator, denominator, percentage: safePct, misses, excludedCount, note };
}

export function computeDiscoveryCoverage(input: {
  screens: Screen[];
  edges: GraphEdge[];
  screenshots: Screenshot[];
  totalInteractionActions: number;
  /** Triggers wired with no destination. They reduce the numerator, so they
   *  must appear in the miss-list or the shortfall would be unexplained. */
  deadInteractions?: Array<{ nodeId: string; nodeName: string; trigger: string }>;
}): CoverageMetric[] {
  const { screens, edges, screenshots, totalInteractionActions } = input;
  const deadInteractions = input.deadInteractions ?? [];

  const realScreens = screens.filter((s) => s.classification !== 'component');
  const components = screens.filter((s) => s.classification === 'component');
  const ambiguous = realScreens.filter((s) => s.classification === 'ambiguous');

  /* 1. Design discovery - how much of the file did we successfully interpret? */
  const designMisses: CoverageMiss[] = ambiguous.map((s) => ({
    id: s.nodeId,
    label: s.name,
    reason: 'classification-ambiguous',
  }));
  const designDiscovery = metric(
    'designDiscovery',
    realScreens.length - ambiguous.length,
    realScreens.length,
    designMisses,
    components.length,
    `${components.length} design-system component(s) excluded by classification.`,
  );

  /* 2. Reachability */
  const unreachable = realScreens.filter((s) => !s.reachable);
  const reachability = metric(
    'reachability',
    realScreens.length - unreachable.length,
    realScreens.length,
    unreachable.map((s) => ({
      id: s.nodeId,
      label: s.name,
      reason: s.unreachableReason ?? 'no-incoming-navigate-edge',
    })),
  );

  /* 3. Interaction discovery - of all interaction actions in the file, how many
        became usable graph edges? */
  const unsupported = edges.filter((e) => !e.supported);
  const interactionMisses: CoverageMiss[] = [
    ...unsupported.map((e) => ({
      id: e.sourceNodeId,
      label: e.sourceNodeName,
      reason: e.unsupportedReason ?? 'unsupported-trigger',
    })),
    // A trigger with no destination lowers the numerator, so it must be
    // explained here - otherwise the shortfall has no stated cause.
    ...deadInteractions.map((d) => ({
      id: d.nodeId,
      label: d.nodeName,
      reason: `no-destination-configured (${d.trigger})`,
    })),
  ];
  const interactionDiscovery = metric(
    'interactionDiscovery',
    edges.length - unsupported.length,
    Math.max(edges.length, totalInteractionActions),
    interactionMisses,
    0,
    totalInteractionActions > edges.length + deadInteractions.length
      ? `${totalInteractionActions - edges.length - deadInteractions.length} interaction action(s) were duplicates across component variants or targeted non-node actions.`
      : null,
  );

  /* 5. Screenshot capture (4 and 6/7 require an execution) */
  const attempted = screenshots.filter((s) => s.source === 'browser');
  const valid = attempted.filter((s) => s.status === 'valid');
  const failed = attempted.filter((s) => s.status === 'failed');
  const screenshotCapture = metric(
    'screenshotCapture',
    valid.length,
    Math.max(attempted.length, valid.length),
    failed.map((s) => ({
      id: s.nodeId ?? s.id,
      label: s.screenName ?? 'unknown screen',
      reason: s.failureReason ?? 'render-failed',
    })),
    0,
    attempted.length < realScreens.length
      ? `${realScreens.length - attempted.length} screen(s) were not attempted in this run.`
      : null,
  );

  return [designDiscovery, reachability, interactionDiscovery, screenshotCapture];
}

export function computeExecutionCoverage(input: {
  plan: TestPlan;
  actions: ExecutionAction[];
  edges: GraphEdge[];
  screenshots: Screenshot[];
  video: VideoRecord | null;
}): CoverageMetric[] {
  const { plan, actions, edges, screenshots, video } = input;

  /* 4. Interaction execution */
  const supportedEdges = edges.filter((e) => e.supported);
  const executedSources = new Set(
    actions.filter((a) => a.result === 'ok' && a.actionType === 'click').map((a) => a.screenId),
  );
  const notExecuted = supportedEdges.filter((e) => !executedSources.has(e.fromScreenId));
  const interactionExecution = metric(
    'interactionExecution',
    supportedEdges.length - notExecuted.length,
    supportedEdges.length,
    notExecuted.slice(0, 200).map((e) => ({
      id: e.sourceNodeId,
      label: e.sourceNodeName,
      reason: 'not-exercised-by-this-plan',
    })),
    0,
    'Measured against this execution only; a single test plan is not expected to exercise every interaction.',
  );

  /* 6. Test execution - plan steps completed */
  const stepActions = actions.filter((a) => a.stepId !== null);
  const failedSteps = stepActions.filter((a) => a.result === 'failed');
  const skippedSteps = stepActions.filter((a) => a.result === 'skipped');
  const testExecution = metric(
    'testExecution',
    stepActions.filter((a) => a.result === 'ok').length,
    Math.max(plan.steps.length, stepActions.length),
    [
      ...failedSteps.map((a) => ({
        id: a.id,
        label: a.description,
        reason: a.error ?? 'step-failed',
      })),
      ...skippedSteps.map((a) => ({
        id: a.id,
        label: a.description,
        reason: 'step-skipped',
      })),
    ],
  );

  /* 5. Screenshot capture within the execution */
  const shots = screenshots.filter((s) => s.source === 'browser');
  const failedShots = shots.filter((s) => s.status === 'failed');
  const screenshotCapture = metric(
    'screenshotCapture',
    shots.filter((s) => s.status === 'valid').length,
    shots.length,
    failedShots.map((s) => ({
      id: s.id,
      label: s.screenName ?? 'unknown screen',
      reason: s.failureReason ?? 'render-failed',
    })),
  );

  /* 7. Video recording */
  const videoOk = video !== null && video.status === 'complete' && video.bytes > 0;
  const videoRecording = metric(
    'videoRecording',
    videoOk ? 1 : 0,
    1,
    videoOk
      ? []
      : [
          {
            id: video?.id ?? 'none',
            label: 'Recap recording',
            reason: video?.failureReason ?? 'no-recording-produced',
          },
        ],
  );

  return [interactionExecution, testExecution, screenshotCapture, videoRecording];
}
