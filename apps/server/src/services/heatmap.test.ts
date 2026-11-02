import { describe, expect, it } from 'vitest';
import type { InteractionEvent, ScrollSample, Screenshot } from '@lenz/shared';
import { buildHeatmap, buildScrollReport, computeRegions, groupKey, summarizeScroll } from './heatmap.js';
import { depthFraction, directionFrom, redact } from './interaction-recorder.js';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const DESKTOP = { deviceId: 'desktop-1440', deviceKind: 'desktop' as const, viewportWidth: 1440, viewportHeight: 900 };
const MOBILE = { deviceId: 'mobile-390', deviceKind: 'mobile' as const, viewportWidth: 390, viewportHeight: 844 };

function event(over: Partial<InteractionEvent> = {}): InteractionEvent {
  return {
    id: over.id ?? `ixn_${Math.random().toString(36).slice(2)}`,
    executionId: 'exe_1',
    projectId: 'prj_1',
    personaId: 'per_1',
    planId: 'pln_1',
    stepId: null,
    actionId: null,
    index: 0,
    type: 'click',
    source: 'lenz-action',
    pointer: 'mouse',
    label: 'Clicked Add to Cart',
    targetRole: null,
    targetName: 'Add to Cart',
    targetSelector: null,
    targetWidth: null,
    targetHeight: null,
    viewportX: 100,
    viewportY: 200,
    pageX: 100,
    pageY: 200,
    coordinateStatus: 'recorded',
    coordinateNote: null,
    deviceScaleFactor: 1,
    url: 'https://www.figma.com/proto/abc',
    screenId: '1:2',
    screenName: 'Home',
    uiStateId: null,
    timestamp: '2026-11-02T10:00:00.000Z',
    elapsedMs: 1000,
    videoOffsetMs: 500,
    result: 'success',
    resultNote: null,
    scrollX: 0,
    scrollY: 0,
    documentWidth: 1440,
    documentHeight: 2400,
    deltaX: null,
    deltaY: null,
    durationMs: null,
    ...DESKTOP,
    ...over,
  };
}

function shot(over: Partial<Screenshot> = {}): Screenshot {
  return {
    id: 'shot_1',
    projectId: 'prj_1',
    executionId: 'exe_1',
    screenId: '1:2',
    uiStateId: null,
    nodeId: '1:2',
    screenName: 'Home',
    actionLabel: 'Open',
    path: '/evidence/shot_1.png',
    width: 1440,
    height: 900,
    bytes: 100_000,
    capturedAt: '2026-11-02T10:00:00.000Z',
    status: 'valid',
    verification: null,
    failureReason: null,
    source: 'browser',
    deviceId: 'desktop-1440',
    deviceScaleFactor: 1,
    ...over,
  };
}

function sample(over: Partial<ScrollSample> = {}): ScrollSample {
  return {
    id: `scr_${Math.random().toString(36).slice(2)}`,
    executionId: 'exe_1',
    projectId: 'prj_1',
    personaId: 'per_1',
    screenId: '1:2',
    screenName: 'Home',
    deviceId: 'desktop-1440',
    deviceKind: 'desktop',
    container: 'window',
    scrollX: 0,
    scrollY: 0,
    viewportWidth: 1440,
    viewportHeight: 900,
    documentHeight: 3000,
    documentWidth: 1440,
    depthFraction: 0.3,
    direction: 'down',
    dwellMs: 200,
    elapsedMs: 1000,
    videoOffsetMs: 500,
    timestamp: '2026-11-02T10:00:00.000Z',
    source: 'browser-listener',
    ...over,
  };
}

/* ------------------------------------------------------------------ *
 * 1 & 2. Desktop click tracking and mobile tap tracking
 * ------------------------------------------------------------------ */

describe('heatmap aggregation', () => {
  it('aggregates desktop clicks into one group with success/failure split', () => {
    const report = buildHeatmap({
      projectId: 'prj_1',
      events: [
        event({ id: 'a', viewportX: 10, viewportY: 20, result: 'success' }),
        event({ id: 'b', viewportX: 30, viewportY: 40, result: 'failure' }),
        event({ id: 'c', viewportX: 50, viewportY: 60, result: 'unverified' }),
      ],
      screenshots: [shot()],
    });

    expect(report.groups).toHaveLength(1);
    const g = report.groups[0]!;
    expect(g.totalPoints).toBe(3);
    expect(g.successCount).toBe(1);
    expect(g.failureCount).toBe(1);
    expect(g.unverifiedCount).toBe(1);
    expect(g.sessionCount).toBe(1);
  });

  it('records mobile taps with touch pointer and mobile geometry', () => {
    const report = buildHeatmap({
      projectId: 'prj_1',
      events: [event({ type: 'tap', pointer: 'touch', viewportX: 195, viewportY: 400, ...MOBILE })],
      screenshots: [],
    });

    const g = report.groups[0]!;
    expect(g.deviceKind).toBe('mobile');
    expect(g.viewportWidth).toBe(390);
    expect(g.points[0]!.type).toBe('tap');
  });

  /* ---- 8. Device-specific filtering / separation ---- */

  it('never merges coordinates recorded at different viewports', () => {
    const report = buildHeatmap({
      projectId: 'prj_1',
      events: [
        event({ id: 'd', ...DESKTOP }),
        event({ id: 'm', type: 'tap', pointer: 'touch', ...MOBILE }),
      ],
      screenshots: [],
    });

    expect(report.groups).toHaveLength(2);
    expect(new Set(report.groups.map((g) => g.viewportWidth))).toEqual(new Set([1440, 390]));
  });

  it('separates screens even on the same device', () => {
    const report = buildHeatmap({
      projectId: 'prj_1',
      events: [event({ screenId: '1:2' }), event({ screenId: '3:4' })],
      screenshots: [],
    });
    expect(report.groups).toHaveLength(2);
  });

  it('counts distinct sessions and personas contributing to a group', () => {
    const report = buildHeatmap({
      projectId: 'prj_1',
      events: [
        event({ executionId: 'exe_1', personaId: 'per_1' }),
        event({ executionId: 'exe_2', personaId: 'per_2' }),
        event({ executionId: 'exe_2', personaId: 'per_2' }),
      ],
      screenshots: [],
    });
    const g = report.groups[0]!;
    expect(g.sessionCount).toBe(2);
    expect(g.personaCount).toBe(2);
    expect(report.executionIds).toEqual(['exe_1', 'exe_2']);
  });

  /* ---- 9. Missing or inaccessible elements: never fabricate a position ---- */

  it('excludes events with no coordinate and reports the reason', () => {
    const report = buildHeatmap({
      projectId: 'prj_1',
      events: [
        event({ id: 'ok' }),
        event({
          id: 'nocoord',
          viewportX: null,
          viewportY: null,
          coordinateStatus: 'unavailable',
          coordinateNote: 'Activated from the keyboard, which has no pointer position.',
        }),
      ],
      screenshots: [],
    });

    expect(report.groups[0]!.totalPoints).toBe(1);
    expect(report.exclusions).toContainEqual({
      reason: 'Activated from the keyboard, which has no pointer position.',
      count: 1,
    });
  });

  it('excludes scroll and navigation events from the click map, with a reason', () => {
    const report = buildHeatmap({
      projectId: 'prj_1',
      events: [
        event({ type: 'scroll', coordinateStatus: 'unavailable', viewportX: null, viewportY: null }),
        event({ type: 'navigation', coordinateStatus: 'unavailable', viewportX: null, viewportY: null }),
      ],
      screenshots: [],
    });

    expect(report.groups).toHaveLength(0);
    expect(report.exclusions.map((e) => e.reason)).toEqual(
      expect.arrayContaining([
        'scroll events are not click/tap activations',
        'navigation events are not click/tap activations',
      ]),
    );
  });

  /* ---- 10. Empty data ---- */

  it('returns an empty report rather than failing when nothing was recorded', () => {
    const report = buildHeatmap({ projectId: 'prj_1', events: [], screenshots: [] });
    expect(report.groups).toEqual([]);
    expect(report.exclusions).toEqual([]);
    expect(report.dataNote).toMatch(/synthetic test traffic/i);
  });

  /* ---- 5. Coordinate normalization against a screenshot ---- */

  it('marks a screenshot compatible only when its CSS geometry matches', () => {
    const matched = buildHeatmap({
      projectId: 'prj_1',
      events: [event()],
      screenshots: [shot({ width: 1440, height: 900 })],
    });
    expect(matched.groups[0]!.screenshotCompatible).toBe(true);
    expect(matched.groups[0]!.screenshotId).toBe('shot_1');

    const mismatched = buildHeatmap({
      projectId: 'prj_1',
      events: [event()],
      screenshots: [shot({ width: 390, height: 844 })],
    });
    expect(mismatched.groups[0]!.screenshotCompatible).toBe(false);
    expect(mismatched.groups[0]!.screenshotNote).toMatch(/would misplace every point/i);
  });

  it('reports the absence of a screenshot instead of silently rendering on nothing', () => {
    const report = buildHeatmap({
      projectId: 'prj_1',
      events: [event({ screenId: '9:9' })],
      screenshots: [shot()],
    });
    expect(report.groups[0]!.screenshotId).toBeNull();
    expect(report.groups[0]!.screenshotNote).toMatch(/No validated browser screenshot/i);
  });

  it('ignores failed screenshots as heatmap backgrounds', () => {
    const report = buildHeatmap({
      projectId: 'prj_1',
      events: [event()],
      screenshots: [shot({ status: 'failed', path: '' })],
    });
    expect(report.groups[0]!.screenshotId).toBeNull();
  });

  it('produces a stable group key per screen and geometry', () => {
    expect(groupKey({ screenId: '1:2', deviceId: 'd', viewportWidth: 10, viewportHeight: 20 })).toBe(
      '1:2|d|10x20',
    );
    expect(groupKey({ screenId: null, deviceId: 'd', viewportWidth: 10, viewportHeight: 20 })).toBe(
      'unknown-screen|d|10x20',
    );
  });

  it('orders points deterministically so repeated renders are identical', () => {
    const events = [
      event({ id: '1', elapsedMs: 300, viewportX: 5 }),
      event({ id: '2', elapsedMs: 100, viewportX: 9 }),
      event({ id: '3', elapsedMs: 200, viewportX: 7 }),
    ];
    const a = buildHeatmap({ projectId: 'p', events, screenshots: [] });
    const b = buildHeatmap({ projectId: 'p', events: [...events].reverse(), screenshots: [] });
    expect(a.groups[0]!.points.map((p) => p.elapsedMs)).toEqual([100, 200, 300]);
    expect(a.groups[0]!.points).toEqual(b.groups[0]!.points);
  });
});

/* ------------------------------------------------------------------ *
 * 4. Scroll-depth calculation
 * ------------------------------------------------------------------ */

describe('scroll depth', () => {
  it('measures depth from the bottom of the viewport', () => {
    // Top of a 3000px document in a 900px viewport: 900/3000 is already visible.
    expect(depthFraction(0, 900, 3000)).toBeCloseTo(0.3, 5);
    expect(depthFraction(2100, 900, 3000)).toBeCloseTo(1, 5);
  });

  it('clamps overscroll rather than reporting more than 100%', () => {
    expect(depthFraction(5000, 900, 3000)).toBe(1);
    expect(depthFraction(-50, 900, 3000)).toBeCloseTo(0.283, 2);
  });

  it('returns null when the document height is unknown, never 0', () => {
    expect(depthFraction(100, 900, null)).toBeNull();
    expect(depthFraction(100, 900, 0)).toBeNull();
  });

  it('derives direction from the previous position', () => {
    expect(directionFrom(undefined, 0, 0)).toBe('none');
    expect(directionFrom({ x: 0, y: 100 }, 0, 400)).toBe('down');
    expect(directionFrom({ x: 0, y: 400 }, 0, 100)).toBe('up');
    expect(directionFrom({ x: 0, y: 0 }, 50, 0)).toBe('right');
    expect(directionFrom({ x: 50, y: 0 }, 0, 0)).toBe('left');
  });

  it('averages each session’s deepest point, not every sample', () => {
    // Session 1 dwells near the top (three samples) then reaches 80%.
    // Session 2 reaches 40%. The mean of session maxima is 60%, whereas a mean
    // over raw samples would be dragged down by the dwell.
    const summary = summarizeScroll('k', [
      sample({ executionId: 'e1', depthFraction: 0.1 }),
      sample({ executionId: 'e1', depthFraction: 0.1 }),
      sample({ executionId: 'e1', depthFraction: 0.1 }),
      sample({ executionId: 'e1', depthFraction: 0.8, scrollY: 1500 }),
      sample({ executionId: 'e2', depthFraction: 0.4, scrollY: 300 }),
    ]);
    expect(summary.maxDepthFraction).toBeCloseTo(0.8, 5);
    expect(summary.meanDepthFraction).toBeCloseTo(0.6, 5);
    expect(summary.sessionCount).toBe(2);
  });

  it('excludes unmeasurable samples from depth and says how many', () => {
    const summary = summarizeScroll('k', [
      sample({ depthFraction: 0.5 }),
      sample({ depthFraction: null, documentHeight: null }),
      sample({ depthFraction: null, documentHeight: null }),
    ]);
    expect(summary.maxDepthFraction).toBeCloseTo(0.5, 5);
    expect(summary.note).toMatch(/2 of 3 samples/);
    expect(summary.note).toMatch(/rather than counted as zero/);
  });

  it('reports a screen that never exceeded the viewport as not scrollable', () => {
    const summary = summarizeScroll('k', [
      sample({ documentHeight: 900, viewportHeight: 900, scrollY: 0, depthFraction: 1 }),
    ]);
    expect(summary.scrollable).toBe(false);
  });

  it('uses the tallest observed height so lazy-loaded content does not move the bands', () => {
    const summary = summarizeScroll('k', [
      sample({ documentHeight: 1500 }),
      sample({ documentHeight: 4000 }),
    ]);
    expect(summary.documentHeight).toBe(4000);
  });

  it('groups scroll samples by screen, device and container', () => {
    const report = buildScrollReport({
      projectId: 'prj_1',
      samples: [
        sample({ screenId: '1:2' }),
        sample({ screenId: '3:4' }),
        sample({ screenId: '1:2', container: 'div#list' }),
        sample({ screenId: '1:2', deviceId: 'mobile-390', deviceKind: 'mobile', viewportHeight: 844 }),
      ],
    });
    expect(report.summaries).toHaveLength(4);
    expect(report.summaries.find((s) => s.key.includes('div#list'))!.note).toMatch(
      /nested scroll container/i,
    );
  });

  it('returns an empty report for a run with no scrolling', () => {
    const report = buildScrollReport({ projectId: 'prj_1', samples: [] });
    expect(report.summaries).toEqual([]);
  });
});

describe('page region exposure', () => {
  it('attributes dwell to every band inside the viewport', () => {
    // 1000px document, 10 bands of 100px. A 200px viewport at the top covers
    // bands 0 and 1.
    const regions = computeRegions(
      [sample({ scrollY: 0, viewportHeight: 200, documentHeight: 1000, dwellMs: 500 })],
      1000,
    );
    expect(regions).toHaveLength(10);
    expect(regions[0]!.exposureMs).toBe(500);
    expect(regions[1]!.exposureMs).toBe(500);
    expect(regions[2]!.exposureMs).toBe(0);
    expect(regions[9]!.sessionsReached).toBe(0);
  });

  it('counts a band once per session however many samples it had', () => {
    const regions = computeRegions(
      [
        sample({ executionId: 'e1', scrollY: 0, viewportHeight: 100, documentHeight: 1000, dwellMs: 100 }),
        sample({ executionId: 'e1', scrollY: 0, viewportHeight: 100, documentHeight: 1000, dwellMs: 100 }),
        sample({ executionId: 'e2', scrollY: 0, viewportHeight: 100, documentHeight: 1000, dwellMs: 100 }),
      ],
      1000,
    );
    expect(regions[0]!.sessionsReached).toBe(2);
    expect(regions[0]!.exposureMs).toBe(300);
  });

  it('produces no regions when the document height was never measurable', () => {
    expect(computeRegions([sample({ documentHeight: null })], null)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Privacy
 * ------------------------------------------------------------------ */

describe('label redaction', () => {
  it('strips email addresses and long digit runs from labels', () => {
    expect(redact('Contact ada@example.com')).toBe('Contact [email]');
    expect(redact('Card 4111 1111 1111 1111')).toBe('Card [number]');
    expect(redact('Add to Cart')).toBe('Add to Cart');
  });

  it('leaves short numbers that carry real meaning alone', () => {
    expect(redact('Step 3 of 5')).toBe('Step 3 of 5');
  });

  it('passes null through unchanged', () => {
    expect(redact(null)).toBeNull();
  });
});
