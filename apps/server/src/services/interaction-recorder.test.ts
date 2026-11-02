import { describe, expect, it, beforeEach } from 'vitest';
import type { DeviceProfile } from '@lenz/shared';
import { openDatabase } from '../db/index.js';
import { Repositories } from '../db/repositories.js';
import { listDeviceProfiles } from '../browser/devices.js';
import type { RawPageEvent } from '../browser/instrumentation.js';
import { ExecutionClock, InteractionRecorder, seekOffsetForAction } from './interaction-recorder.js';

/* ------------------------------------------------------------------ *
 * The recorder, against a real in-memory database.
 *
 * Using the actual schema rather than a stub means these also exercise the
 * persistence path: a column that does not exist, or a field the mapper
 * forgets, fails here rather than at run time.
 * ------------------------------------------------------------------ */

const mobile = (): DeviceProfile => listDeviceProfiles().find((d) => d.id === 'mobile-390')!;
const desktop = (): DeviceProfile => listDeviceProfiles().find((d) => d.id === 'desktop-1440')!;

function setup(device: DeviceProfile = desktop()) {
  const db = openDatabase(':memory:');
  const repos = new Repositories(db);
  const project = repos.createProject({
    name: 'p',
    description: null,
    figmaUrl: 'https://www.figma.com/proto/abc/x',
    urlKind: 'proto',
    fileKey: 'abc',
    fileName: 'x',
    startNodeId: '1:2',
  });
  const persona = repos.createPersona({
    projectId: project.id,
    name: 'Ada',
    ageRange: null,
    background: '',
    technicalProficiency: 'medium',
    digitalExperience: '',
    goals: [],
    motivations: [],
    frustrations: [],
    accessibilityNeeds: [],
    behavioralCharacteristics: [],
    expectations: [],
    origin: 'manual',
    generatedByModel: null,
  });
  const plan = repos.createPlan(
    {
      projectId: project.id,
      personaId: persona.id,
      name: 'plan',
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
      origin: 'manual',
      generatedByModel: null,
    },
    [
      {
        index: 0,
        description: 'tap',
        actionType: 'click',
        targetHint: null,
        expectedOutcome: '',
        expectedScreenId: null,
        expectedScreenName: null,
      },
    ],
  );
  const execution = repos.createExecution(project.id, plan.id, persona.id, 'live', device);
  const clock = new ExecutionClock();
  const recorder = new InteractionRecorder(
    repos,
    { executionId: execution.id, projectId: project.id, personaId: persona.id, planId: plan.id },
    device,
    clock,
  );
  return { db, repos, project, persona, plan, execution, clock, recorder };
}

function pageEvent(over: Partial<RawPageEvent> = {}): RawPageEvent {
  return {
    type: 'click',
    pointer: 'mouse',
    x: 100,
    y: 200,
    pageX: 100,
    pageY: 200,
    role: 'button',
    name: 'Add to Cart',
    selector: 'button#add',
    targetWidth: 120,
    targetHeight: 40,
    scrollX: 0,
    scrollY: 0,
    docWidth: 1440,
    docHeight: 3000,
    viewportWidth: 1440,
    viewportHeight: 900,
    devicePixelRatio: 1,
    deltaX: null,
    deltaY: null,
    durationMs: null,
    container: 'window',
    url: 'https://www.figma.com/proto/abc',
    ts: Date.now(),
    frameUrl: 'https://www.figma.com/proto/abc',
    ...over,
  };
}

/* ------------------------------------------------------------------ *
 * Timeline seek target
 *
 * Regression cover for a real defect: clicking a timeline step seeked to the
 * action's own offset, which is stamped when the step FINISHES. Measured on
 * live runs it trailed the click by 1.9s (desktop) and 5.5s (mobile), landing
 * the player on the following screen.
 * ------------------------------------------------------------------ */

describe('timeline seek target', () => {
  it('uses the first interaction of the step, not the action offset', () => {
    // Real shape from exe_wXV5pFkMmE_Q step 2: action stamped at 21019,
    // the click itself recorded at 19961.
    expect(seekOffsetForAction(21019, [19961, 20400])).toBe(19961);
  });

  it('matches the measured mobile gap', () => {
    // exe_FF81fDUGVaZ9 step 2: action at 18559, click at 12626.
    expect(seekOffsetForAction(18559, [12626])).toBe(12626);
  });

  it('falls back to the action offset when the step recorded nothing', () => {
    expect(seekOffsetForAction(12905, [])).toBe(12905);
  });

  it('ignores unusable timestamps rather than seeking to NaN', () => {
    expect(seekOffsetForAction(500, [Number.NaN, -1])).toBe(500);
    expect(seekOffsetForAction(500, [Number.NaN, 300])).toBe(300);
  });

  it('never seeks later than the action finished', () => {
    const actionOffset = 21019;
    const seek = seekOffsetForAction(actionOffset, [19961]);
    expect(seek).toBeLessThanOrEqual(actionOffset);
  });
});

describe('execution clock', () => {
  it('reports a non-negative monotonic elapsed time', () => {
    const clock = new ExecutionClock();
    expect(clock.elapsedMs()).toBeGreaterThanOrEqual(0);
  });

  it('places a page wall-clock timestamp on the same timeline', () => {
    const clock = new ExecutionClock();
    expect(clock.elapsedForWallMs(clock.wallOriginMs + 2500)).toBe(2500);
  });

  it('clamps a timestamp from before the run started rather than going negative', () => {
    const clock = new ExecutionClock();
    expect(clock.elapsedForWallMs(clock.wallOriginMs - 5000)).toBe(0);
  });
});

describe('interaction recorder', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  /* ---- 1. Desktop click tracking ---- */

  it('records a wrapper click with its coordinate and context', () => {
    ctx.recorder.setContext({ screenId: '1:2', screenName: 'Home', stepId: 'stp_1' });
    ctx.recorder.recordPointer({
      type: 'click',
      pointer: 'mouse',
      label: 'Clicked Add to Cart',
      x: 300,
      y: 400,
      result: 'success',
      url: 'https://www.figma.com/proto/abc',
      targetName: 'Add to Cart',
      targetWidth: 120,
      targetHeight: 44,
    });
    ctx.recorder.flush();

    const [stored] = ctx.repos.listInteractionEvents({ executionId: ctx.execution.id });
    expect(stored!.viewportX).toBe(300);
    expect(stored!.viewportY).toBe(400);
    expect(stored!.coordinateStatus).toBe('recorded');
    expect(stored!.screenId).toBe('1:2');
    expect(stored!.stepId).toBe('stp_1');
    expect(stored!.source).toBe('lenz-action');
    expect(stored!.viewportWidth).toBe(1440);
  });

  /* ---- 2. Mobile tap tracking ---- */

  it('records a mobile tap with the mobile viewport and touch pointer', () => {
    const m = setup(mobile());
    m.recorder.recordPointer({
      type: 'tap',
      pointer: 'touch',
      label: 'Tapped Buy',
      x: 195,
      y: 500,
      result: 'success',
      url: '',
    });
    m.recorder.flush();

    const [stored] = m.repos.listInteractionEvents({ executionId: m.execution.id });
    expect(stored!.type).toBe('tap');
    expect(stored!.pointer).toBe('touch');
    expect(stored!.deviceKind).toBe('mobile');
    expect(stored!.viewportWidth).toBe(390);
    expect(stored!.deviceScaleFactor).toBe(mobile().deviceScaleFactor);
  });

  /* ---- 9. Missing elements: never fabricate a coordinate ---- */

  it('stores a reason, not a zero, when an action had no coordinate', () => {
    ctx.recorder.recordPointer({
      type: 'navigation',
      pointer: 'none',
      label: 'Opened Home',
      coordinateNote: 'Opening a screen by node id is not a pointer interaction.',
      result: 'success',
      url: '',
    });
    ctx.recorder.flush();

    const [stored] = ctx.repos.listInteractionEvents({ executionId: ctx.execution.id });
    expect(stored!.viewportX).toBeNull();
    expect(stored!.coordinateStatus).toBe('unavailable');
    expect(stored!.coordinateNote).toMatch(/not a pointer interaction/);
  });

  it('supplies a reason even when the caller forgot one', () => {
    ctx.recorder.recordPointer({ type: 'click', pointer: 'mouse', label: null, result: 'failure', url: '' });
    ctx.recorder.flush();
    const [stored] = ctx.repos.listInteractionEvents({ executionId: ctx.execution.id });
    expect(stored!.coordinateStatus).toBe('unavailable');
    expect(stored!.coordinateNote).toBeTruthy();
  });

  /* ---- de-duplication of page echoes ---- */

  it('drops a page-observed click that merely echoes one Lenz performed', () => {
    ctx.recorder.recordPointer({
      type: 'click',
      pointer: 'mouse',
      label: 'Clicked Add to Cart',
      x: 300,
      y: 400,
      result: 'success',
      url: '',
    });
    ctx.recorder.ingestPageEvent(pageEvent({ x: 302, y: 401 }));
    ctx.recorder.flush();

    expect(ctx.repos.listInteractionEvents({ executionId: ctx.execution.id })).toHaveLength(1);
  });

  it('keeps a page-observed click that happened somewhere else', () => {
    ctx.recorder.recordPointer({
      type: 'click',
      pointer: 'mouse',
      label: 'Clicked Add to Cart',
      x: 300,
      y: 400,
      result: 'success',
      url: '',
    });
    ctx.recorder.ingestPageEvent(pageEvent({ x: 900, y: 100 }));
    ctx.recorder.flush();

    const stored = ctx.repos.listInteractionEvents({ executionId: ctx.execution.id });
    expect(stored).toHaveLength(2);
    expect(stored.map((e) => e.source)).toEqual(['lenz-action', 'browser-listener']);
  });

  it('keeps a page-observed click at the same place much later', () => {
    ctx.recorder.recordPointer({
      type: 'click',
      pointer: 'mouse',
      label: 'first',
      x: 300,
      y: 400,
      result: 'success',
      url: '',
    });
    ctx.recorder.ingestPageEvent(pageEvent({ x: 300, y: 400, ts: Date.now() + 5000 }));
    ctx.recorder.flush();
    expect(ctx.repos.listInteractionEvents({ executionId: ctx.execution.id })).toHaveLength(2);
  });

  it('marks page-observed interactions as unverified', () => {
    ctx.recorder.ingestPageEvent(pageEvent({ x: 10, y: 10 }));
    ctx.recorder.flush();
    const [stored] = ctx.repos.listInteractionEvents({ executionId: ctx.execution.id });
    expect(stored!.result).toBe('unverified');
    expect(stored!.resultNote).toMatch(/not verified by the executor/i);
  });

  it('records a keyboard activation as having no position, by design', () => {
    ctx.recorder.ingestPageEvent(pageEvent({ type: 'key', pointer: 'none', x: null, y: null }));
    ctx.recorder.flush();
    const [stored] = ctx.repos.listInteractionEvents({ executionId: ctx.execution.id });
    expect(stored!.type).toBe('key');
    expect(stored!.coordinateStatus).toBe('unavailable');
    expect(stored!.coordinateNote).toMatch(/keyboard/i);
  });

  it('distinguishes a swipe from a tap', () => {
    ctx.recorder.ingestPageEvent(
      pageEvent({ type: 'swipe', pointer: 'touch', deltaX: 5, deltaY: -140, durationMs: 220 }),
    );
    ctx.recorder.flush();
    const [stored] = ctx.repos.listInteractionEvents({ executionId: ctx.execution.id });
    expect(stored!.type).toBe('swipe');
    expect(stored!.deltaY).toBe(-140);
    expect(stored!.durationMs).toBe(220);
  });

  it('survives a malformed page payload without losing the run', () => {
    expect(() => ctx.recorder.ingestPageEvent(null as unknown as RawPageEvent)).not.toThrow();
    expect(() => ctx.recorder.ingestPageEvent({} as RawPageEvent)).not.toThrow();
    ctx.recorder.flush();
    // The empty object still describes *something* the page saw, so it is kept
    // with an explicit "no position" rather than discarded silently.
    const stored = ctx.repos.listInteractionEvents({ executionId: ctx.execution.id });
    expect(stored.every((e) => e.coordinateStatus === 'unavailable')).toBe(true);
  });

  /* ---- video offsets ---- */

  it('derives a video offset from the recording start', () => {
    ctx.recorder.setVideoStart(ctx.clock.wallOriginMs + 1500);
    expect(ctx.recorder.videoStartOffsetMs).toBe(1500);
    ctx.recorder.ingestPageEvent(pageEvent({ ts: ctx.clock.wallOriginMs + 4000 }));
    ctx.recorder.flush();
    const [stored] = ctx.repos.listInteractionEvents({ executionId: ctx.execution.id });
    expect(stored!.elapsedMs).toBe(4000);
    expect(stored!.videoOffsetMs).toBe(2500);
  });

  it('leaves the video offset null when nothing was recorded', () => {
    ctx.recorder.setVideoStart(null);
    expect(ctx.recorder.videoStartOffsetMs).toBeNull();
    ctx.recorder.recordPointer({ type: 'click', pointer: 'mouse', label: null, x: 1, y: 1, result: 'success', url: '' });
    ctx.recorder.flush();
    const [stored] = ctx.repos.listInteractionEvents({ executionId: ctx.execution.id });
    expect(stored!.videoOffsetMs).toBeNull();
  });

  /* ---- scroll sampling ---- */

  it('records scroll samples with a computed depth', () => {
    ctx.recorder.setContext({ screenId: '1:2', screenName: 'Home' });
    ctx.recorder.ingestPageEvent(
      pageEvent({ type: 'scroll', scrollY: 0, docHeight: 3000, viewportHeight: 900 }),
    );
    ctx.recorder.ingestPageEvent(
      pageEvent({ type: 'scroll', scrollY: 2100, docHeight: 3000, viewportHeight: 900 }),
    );
    ctx.recorder.flush();

    const samples = ctx.repos.listScrollSamples({ executionId: ctx.execution.id });
    expect(samples).toHaveLength(2);
    expect(samples[0]!.depthFraction).toBeCloseTo(0.3, 5);
    expect(samples[1]!.depthFraction).toBeCloseTo(1, 5);
    expect(samples[1]!.direction).toBe('down');
    // Scroll samples are not interaction events - they would otherwise double
    // up with the wrapper's own scroll record.
    expect(ctx.repos.listInteractionEvents({ executionId: ctx.execution.id })).toHaveLength(0);
  });

  it('leaves depth null when the document height was not measurable', () => {
    ctx.recorder.ingestPageEvent(pageEvent({ type: 'scroll', scrollY: 100, docHeight: null }));
    ctx.recorder.flush();
    const [sample] = ctx.repos.listScrollSamples({ executionId: ctx.execution.id });
    expect(sample!.depthFraction).toBeNull();
  });

  it('back-fills dwell time once the next sample arrives', () => {
    const base = ctx.clock.wallOriginMs;
    ctx.recorder.ingestPageEvent(pageEvent({ type: 'scroll', scrollY: 0, ts: base }));
    ctx.recorder.ingestPageEvent(pageEvent({ type: 'scroll', scrollY: 300, ts: base + 400 }));
    ctx.recorder.flush();
    const samples = ctx.repos.listScrollSamples({ executionId: ctx.execution.id });
    expect(samples[0]!.dwellMs).toBe(400);
  });

  it('tracks nested scroll containers separately from the window', () => {
    ctx.recorder.ingestPageEvent(pageEvent({ type: 'scroll', container: 'div#list', scrollY: 50 }));
    ctx.recorder.flush();
    const [sample] = ctx.repos.listScrollSamples({ executionId: ctx.execution.id });
    expect(sample!.container).toBe('div#list');
  });

  /* ---- 10. Empty data ---- */

  it('flushing an empty run writes nothing and does not fail', () => {
    const result = ctx.recorder.flush();
    expect(result).toEqual({ events: 0, scrollSamples: 0 });
    expect(ctx.repos.listInteractionEvents({ executionId: ctx.execution.id })).toEqual([]);
  });

  /* ---- filtering ---- */

  it('filters stored events by device, persona and type', () => {
    ctx.recorder.recordPointer({ type: 'click', pointer: 'mouse', label: null, x: 1, y: 1, result: 'success', url: '' });
    ctx.recorder.recordPointer({
      type: 'navigation',
      pointer: 'none',
      label: null,
      coordinateNote: 'n/a',
      result: 'success',
      url: '',
    });
    ctx.recorder.flush();

    expect(
      ctx.repos.listInteractionEvents({ projectId: ctx.project.id, deviceId: 'desktop-1440' }),
    ).toHaveLength(2);
    expect(ctx.repos.listInteractionEvents({ projectId: ctx.project.id, deviceId: 'mobile-390' })).toHaveLength(0);
    expect(
      ctx.repos.listInteractionEvents({ projectId: ctx.project.id, types: ['click'] }),
    ).toHaveLength(1);
    expect(
      ctx.repos.listInteractionEvents({ projectId: ctx.project.id, personaId: ctx.persona.id }),
    ).toHaveLength(2);
  });

  it('links events to the action row that covers them', () => {
    ctx.recorder.recordPointer({ type: 'click', pointer: 'mouse', label: 'a', x: 1, y: 1, result: 'success', url: '' });
    ctx.recorder.recordPointer({ type: 'click', pointer: 'mouse', label: 'b', x: 2, y: 2, result: 'success', url: '' });
    ctx.recorder.attachActionIdSince(0, 'act_123');
    ctx.recorder.flush();

    const stored = ctx.repos.listInteractionEvents({ executionId: ctx.execution.id });
    expect(stored.every((e) => e.actionId === 'act_123')).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 10. Backward compatibility
 * ------------------------------------------------------------------ */

describe('backward compatibility', () => {
  it('reads an execution written without a device as "not recorded"', () => {
    const { db, repos, project, plan, persona } = setup();
    const execution = repos.createExecution(project.id, plan.id, persona.id, 'live');
    expect(repos.getExecution(execution.id)!.device).toBeNull();
    db.close();
  });

  it('ignores a persisted device profile that no longer validates', () => {
    const { db, repos, project, plan, persona } = setup();
    const execution = repos.createExecution(project.id, plan.id, persona.id, 'live');
    db.prepare('UPDATE executions SET device = ? WHERE id = ?').run('{"id":"x"}', execution.id);
    // A half-written profile is worse than none: it would be used as geometry.
    expect(repos.getExecution(execution.id)!.device).toBeNull();
    db.close();
  });

  it('reads a video written without a start offset, so old recordings still play', () => {
    const { db, repos, project, plan, persona } = setup();
    const execution = repos.createExecution(project.id, plan.id, persona.id, 'live');
    repos.addVideo({
      executionId: execution.id,
      path: '/x.webm',
      bytes: 100,
      durationMs: 1000,
      width: 1440,
      height: 900,
      status: 'complete',
      failureReason: null,
      createdAt: new Date().toISOString(),
    });
    const video = repos.getVideoForExecution(execution.id)!;
    expect(video.startOffsetMs).toBeNull();
    expect(video.status).toBe('complete');
    db.close();
  });

  it('reads a screenshot written without device context', () => {
    const { db, repos, project } = setup();
    const shot = repos.addScreenshot({
      projectId: project.id,
      executionId: null,
      screenId: '1:2',
      uiStateId: null,
      nodeId: '1:2',
      screenName: 'Home',
      actionLabel: 'Open',
      path: '/x.png',
      width: 1440,
      height: 900,
      bytes: 10,
      capturedAt: new Date().toISOString(),
      status: 'valid',
      verification: null,
      failureReason: null,
      source: 'browser',
    });
    expect(repos.getScreenshot(shot.id)!.deviceId).toBeNull();
    db.close();
  });

  it('adds the new columns to a database created before this feature', () => {
    // Build the old shape, then let the migration run over it.
    const db = openDatabase(':memory:');
    const columns = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

    expect(columns('executions')).toContain('device');
    expect(columns('videos')).toContain('start_offset_ms');
    expect(columns('videos')).toContain('device_id');
    expect(columns('screenshots')).toContain('device_id');
    expect(columns('screenshots')).toContain('device_scale_factor');
    expect(columns('interaction_events')).toContain('coordinate_status');
    expect(columns('scroll_samples')).toContain('depth_fraction');
    db.close();
  });
});
