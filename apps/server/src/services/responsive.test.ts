import { describe, expect, it } from 'vitest';
import type {
  DeviceProfile,
  Execution,
  ExecutionAction,
  InteractionEvent,
  ScrollSample,
  TestPlan,
} from '@lenz/shared';
import { listDeviceProfiles } from '../browser/devices.js';
import {
  buildResponsiveComparison,
  detectLayoutOverflow,
  touchTargetConcerns,
} from './responsive.js';

const desktop = (): DeviceProfile => listDeviceProfiles().find((d) => d.id === 'desktop-1440')!;
const mobile = (): DeviceProfile => listDeviceProfiles().find((d) => d.id === 'mobile-390')!;
const tablet = (): DeviceProfile => listDeviceProfiles().find((d) => d.id === 'tablet-768')!;

function execution(over: Partial<Execution> = {}): Execution {
  return {
    id: 'exe_1',
    projectId: 'prj_1',
    planId: 'pln_1',
    personaId: 'per_1',
    planName: 'Buy a dress',
    personaName: 'Ada',
    status: 'succeeded',
    startedAt: '2026-11-02T10:00:00.000Z',
    endedAt: '2026-11-02T10:01:00.000Z',
    actionCount: 4,
    navigationCount: 2,
    failureReason: null,
    mode: 'live',
    device: desktop(),
    createdAt: '2026-11-02T10:00:00.000Z',
    ...over,
  };
}

function action(over: Partial<ExecutionAction> = {}): ExecutionAction {
  return {
    id: `act_${Math.random().toString(36).slice(2)}`,
    executionId: 'exe_1',
    index: 0,
    stepId: 'stp_1',
    description: 'Tap the cart',
    actionType: 'click',
    screenId: '1:2',
    screenName: 'Home',
    expectedDestinationNode: '3:4',
    actualDestinationNode: '3:4',
    verdict: 'match',
    screenshotId: null,
    timestamp: '2026-11-02T10:00:10.000Z',
    offsetMs: 10_000,
    result: 'ok',
    error: null,
    decidedBy: 'figma-metadata',
    ...over,
  };
}

function plan(stepCount = 2): TestPlan {
  return {
    id: 'pln_1',
    projectId: 'prj_1',
    personaId: 'per_1',
    name: 'Buy a dress',
    objective: '',
    scenario: '',
    preconditions: null,
    startScreenId: '1:2',
    startScreenName: 'Home',
    screensInvolved: [],
    successCriteria: [],
    frictionPoints: [],
    status: 'approved',
    approvedAt: null,
    origin: 'ai',
    generatedByModel: null,
    steps: Array.from({ length: stepCount }, (_, i) => ({
      id: `stp_${i + 1}`,
      planId: 'pln_1',
      index: i,
      description: `Step ${i + 1}`,
      actionType: 'click' as const,
      targetHint: null,
      expectedOutcome: '',
      expectedScreenId: null,
      expectedScreenName: null,
    })),
    createdAt: '',
    updatedAt: '',
  };
}

function interaction(over: Partial<InteractionEvent> = {}): InteractionEvent {
  return {
    id: 'ixn_1',
    executionId: 'exe_1',
    projectId: 'prj_1',
    personaId: 'per_1',
    planId: 'pln_1',
    stepId: null,
    actionId: null,
    index: 0,
    type: 'tap',
    source: 'lenz-action',
    pointer: 'touch',
    label: 'Tapped Buy',
    targetRole: null,
    targetName: 'Buy',
    targetSelector: null,
    targetWidth: 30,
    targetHeight: 20,
    viewportX: 10,
    viewportY: 10,
    pageX: 10,
    pageY: 10,
    coordinateStatus: 'recorded',
    coordinateNote: null,
    viewportWidth: 390,
    viewportHeight: 844,
    deviceScaleFactor: 3,
    deviceId: 'mobile-390',
    deviceKind: 'mobile',
    url: '',
    screenId: '1:2',
    screenName: 'Home',
    uiStateId: null,
    timestamp: '',
    elapsedMs: 0,
    videoOffsetMs: 0,
    result: 'success',
    resultNote: null,
    scrollX: 0,
    scrollY: 0,
    documentWidth: 390,
    documentHeight: 1200,
    deltaX: null,
    deltaY: null,
    durationMs: null,
    ...over,
  };
}

function scrollSample(over: Partial<ScrollSample> = {}): ScrollSample {
  return {
    id: 's1',
    executionId: 'exe_1',
    projectId: 'prj_1',
    personaId: 'per_1',
    screenId: '1:2',
    screenName: 'Home',
    deviceId: 'mobile-390',
    deviceKind: 'mobile',
    container: 'window',
    scrollX: 0,
    scrollY: 0,
    viewportWidth: 390,
    viewportHeight: 844,
    documentHeight: 2000,
    documentWidth: 390,
    depthFraction: 0.5,
    direction: 'down',
    dwellMs: 100,
    elapsedMs: 0,
    videoOffsetMs: 0,
    timestamp: '',
    source: 'browser-listener',
    ...over,
  };
}

const emptyRun = (execution: Execution) => ({
  execution,
  actions: [] as ExecutionAction[],
  interactions: [] as InteractionEvent[],
  scrollSamples: [] as ScrollSample[],
  screenshots: [],
});

/* ------------------------------------------------------------------ *
 * 12. Responsive comparison behaviour
 * ------------------------------------------------------------------ */

describe('responsive comparison', () => {
  it('needs two runs before it reports differences', () => {
    const c = buildResponsiveComparison({
      projectId: 'prj_1',
      plan: plan(),
      runs: [emptyRun(execution())],
    });
    expect(c.differences).toEqual([]);
    expect(c.note).toMatch(/at least two runs/i);
  });

  it('orders runs desktop, tablet, mobile', () => {
    const c = buildResponsiveComparison({
      projectId: 'prj_1',
      plan: plan(),
      runs: [
        emptyRun(execution({ id: 'm', device: mobile() })),
        emptyRun(execution({ id: 'd', device: desktop() })),
        emptyRun(execution({ id: 't', device: tablet() })),
      ],
    });
    expect(c.runs.map((r) => r.device.kind)).toEqual(['desktop', 'tablet', 'mobile']);
  });

  it('treats a different navigation path as information, not a defect', () => {
    const c = buildResponsiveComparison({
      projectId: 'prj_1',
      plan: plan(1),
      runs: [
        {
          ...emptyRun(execution({ id: 'd', device: desktop() })),
          actions: [action({ actualDestinationNode: '3:4' })],
        },
        {
          ...emptyRun(execution({ id: 'm', device: mobile() })),
          actions: [action({ actualDestinationNode: '9:9' })],
        },
      ],
    });
    const nav = c.differences.find((d) => d.dimension === 'navigation-path')!;
    expect(nav.severity).toBe('info');
  });

  it('raises a failure only when one device completed and another did not', () => {
    const c = buildResponsiveComparison({
      projectId: 'prj_1',
      plan: plan(1),
      runs: [
        {
          ...emptyRun(execution({ id: 'd', device: desktop(), status: 'succeeded' })),
          actions: [action({ result: 'ok' })],
        },
        {
          ...emptyRun(execution({ id: 'm', device: mobile(), status: 'failed' })),
          actions: [action({ result: 'failed', error: 'no navigation' })],
        },
      ],
    });
    const task = c.differences.find((d) => d.dimension === 'task-completion')!;
    expect(task.severity).toBe('failure');
    expect(task.detail).toMatch(/Did not complete/);
  });

  it('reports equal completion as informational', () => {
    const run = (id: string, device: DeviceProfile) => ({
      ...emptyRun(execution({ id, device })),
      actions: [action({ result: 'ok' })],
    });
    const c = buildResponsiveComparison({
      projectId: 'prj_1',
      plan: plan(1),
      runs: [run('d', desktop()), run('m', mobile())],
    });
    expect(c.differences.find((d) => d.dimension === 'task-completion')!.severity).toBe('info');
  });

  it('flags a screen reached on one device but not another as a candidate, not a verdict', () => {
    const c = buildResponsiveComparison({
      projectId: 'prj_1',
      plan: plan(1),
      runs: [
        {
          ...emptyRun(execution({ id: 'd', device: desktop() })),
          actions: [action({ actualDestinationNode: '3:4' }), action({ actualDestinationNode: '5:6' })],
        },
        {
          ...emptyRun(execution({ id: 'm', device: mobile() })),
          actions: [action({ actualDestinationNode: '3:4' })],
        },
      ],
    });
    const avail = c.differences.find((d) => d.dimension === 'control-availability')!;
    expect(avail.severity).toBe('concern');
    expect(avail.detail).toMatch(/different valid route/i);
  });

  it('says so when a run predates device recording instead of assuming desktop', () => {
    const c = buildResponsiveComparison({
      projectId: 'prj_1',
      plan: plan(),
      runs: [emptyRun(execution({ device: null }))],
    });
    expect(c.runs[0]!.notes.join(' ')).toMatch(/predates device selection/i);
  });

  it('reports scroll depth per device when it was measurable', () => {
    const c = buildResponsiveComparison({
      projectId: 'prj_1',
      plan: plan(1),
      runs: [
        {
          ...emptyRun(execution({ id: 'd', device: desktop() })),
          scrollSamples: [scrollSample({ depthFraction: 1 })],
        },
        {
          ...emptyRun(execution({ id: 'm', device: mobile() })),
          scrollSamples: [scrollSample({ depthFraction: 0.4 })],
        },
      ],
    });
    const depth = c.differences.find((d) => d.dimension === 'scroll-depth')!;
    expect(depth.detail).toMatch(/100%/);
    expect(depth.detail).toMatch(/40%/);
  });

  it('notes unknown scroll depth rather than reporting zero', () => {
    const c = buildResponsiveComparison({
      projectId: 'prj_1',
      plan: plan(),
      runs: [
        {
          ...emptyRun(execution({ device: mobile() })),
          scrollSamples: [scrollSample({ depthFraction: null, documentHeight: null })],
        },
      ],
    });
    expect(c.runs[0]!.maxDepthFraction).toBeNull();
    expect(c.runs[0]!.notes.join(' ')).toMatch(/scroll depth is unknown/i);
  });
});

describe('touch target measurement', () => {
  it('reports controls below the published minimum on a touch device', () => {
    const concerns = touchTargetConcerns([interaction({ targetWidth: 30, targetHeight: 20 })], mobile());
    expect(concerns).toHaveLength(1);
    expect(concerns[0]!.guideline).toMatch(/44px/);
    expect(concerns[0]!.width).toBe(30);
  });

  it('reports nothing on a device without touch', () => {
    expect(touchTargetConcerns([interaction({ targetWidth: 10, targetHeight: 10 })], desktop())).toEqual([]);
  });

  it('ignores controls that meet the guideline', () => {
    expect(touchTargetConcerns([interaction({ targetWidth: 48, targetHeight: 48 })], mobile())).toEqual([]);
  });

  it('cannot report on an element whose size was never measured', () => {
    expect(
      touchTargetConcerns([interaction({ targetWidth: null, targetHeight: null })], mobile()),
    ).toEqual([]);
  });

  it('de-duplicates the same control hit repeatedly', () => {
    const concerns = touchTargetConcerns(
      [interaction({ id: 'a' }), interaction({ id: 'b' }), interaction({ id: 'c' })],
      mobile(),
    );
    expect(concerns).toHaveLength(1);
  });
});

describe('layout overflow detection', () => {
  it('detects a document wider than the viewport', () => {
    const overflow = detectLayoutOverflow([
      scrollSample({ documentWidth: 520, viewportWidth: 390 }),
    ]);
    expect(overflow).toEqual({ overflowPx: 130, viewportWidth: 390 });
  });

  it('ignores sub-pixel rounding', () => {
    expect(detectLayoutOverflow([scrollSample({ documentWidth: 390.5, viewportWidth: 390 })])).toBeNull();
  });

  it('returns null when no width was ever measured, rather than "no overflow"', () => {
    expect(detectLayoutOverflow([scrollSample({ documentWidth: null })])).toBeNull();
    expect(detectLayoutOverflow([])).toBeNull();
  });
});
