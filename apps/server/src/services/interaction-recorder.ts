import type {
  DeviceProfile,
  InteractionEvent,
  InteractionResult,
  InteractionType,
  PointerKind,
  ScrollDirection,
  ScrollSample,
} from '@lenz/shared';
import { logger } from '../core/logger.js';
import type { Repositories } from '../db/repositories.js';
import type { RawPageEvent } from '../browser/instrumentation.js';

/* ------------------------------------------------------------------ *
 * Execution clock
 * ------------------------------------------------------------------ */

/**
 * One clock for the whole run.
 *
 * Elapsed time is measured with `process.hrtime.bigint()`, which is monotonic
 * and therefore immune to an NTP correction landing mid-run. Events reported
 * BY THE PAGE only carry `Date.now()`, so those are placed on the timeline by
 * subtracting the wall-clock origin captured at the same instant as the
 * monotonic one. The two agree to within a millisecond unless the system clock
 * is stepped during the run, which is rare, bounded, and preferable to the
 * alternative of timing page events by when the binding callback happened to
 * be serviced.
 */
export class ExecutionClock {
  private readonly monotonicOriginNs: bigint;
  readonly wallOriginMs: number;

  constructor() {
    this.wallOriginMs = Date.now();
    this.monotonicOriginNs = process.hrtime.bigint();
  }

  /** Milliseconds since the clock was created, from the monotonic source. */
  elapsedMs(): number {
    return Number((process.hrtime.bigint() - this.monotonicOriginNs) / 1_000_000n);
  }

  /** Place a page-reported wall-clock timestamp on the same timeline. */
  elapsedForWallMs(wallMs: number): number {
    return Math.max(0, Math.round(wallMs - this.wallOriginMs));
  }
}

/* ------------------------------------------------------------------ *
 * Recorder
 * ------------------------------------------------------------------ */

export interface RecorderContext {
  screenId: string | null;
  screenName: string | null;
  uiStateId: string | null;
  stepId: string | null;
  actionId: string | null;
}

export interface RecordPointerInput {
  type: InteractionType;
  pointer: PointerKind;
  /**
   * Wall-clock time the interaction actually happened.
   *
   * Omit only when the call site IS the moment. Anything that waits for a
   * result before recording - a click that polls for the resulting navigation,
   * a scroll that waits for momentum to settle - must pass the time it began,
   * or the event lands after the effect it caused. Measured at ~1.2s late for
   * clicks, which was enough to put every video marker on the next screen.
   */
  occurredAtMs?: number;
  label: string | null;
  /** Viewport CSS pixels. Omit (undefined) when the action genuinely had none. */
  x?: number | null;
  y?: number | null;
  /** Required when x/y are absent - the model forbids an unexplained gap. */
  coordinateNote?: string;
  targetRole?: string | null;
  targetName?: string | null;
  targetSelector?: string | null;
  targetWidth?: number | null;
  targetHeight?: number | null;
  result: InteractionResult;
  resultNote?: string | null;
  url: string;
  deltaX?: number | null;
  deltaY?: number | null;
  durationMs?: number | null;
  scrollX?: number | null;
  scrollY?: number | null;
  documentWidth?: number | null;
  documentHeight?: number | null;
}

/** Window inside which a page-observed pointer event is taken to be the
 *  echo of one Lenz just performed, rather than a separate interaction. */
const DEDUP_WINDOW_MS = 700;
/** Positional tolerance for the same comparison, in CSS pixels. */
const DEDUP_RADIUS_PX = 8;

/** Hard ceiling so a runaway page cannot fill the database. */
const MAX_EVENTS = 5000;
const MAX_SCROLL_SAMPLES = 4000;

/**
 * Collects every interaction in one execution and persists it.
 *
 * Two inputs, one output:
 *   - `record*` methods are called by the executor around each action it
 *     performs. These know the step, the intended target and the verified
 *     outcome.
 *   - `ingestPageEvent` receives what the page itself saw. These fill the gaps
 *     the wrapper cannot see - momentum scrolling, a redirect's own scroll
 *     restoration, a click that landed on a frame the wrapper addressed
 *     indirectly - and are dropped when they merely echo a wrapper action.
 *
 * Nothing here invents data. An action with no coordinate is stored WITH THE
 * REASON it has none, and the heatmap excludes it and reports the exclusion.
 */
export class InteractionRecorder {
  private readonly events: InteractionEvent[] = [];
  private readonly scrollSamples: ScrollSample[] = [];
  private index = 0;
  private context: RecorderContext = {
    screenId: null,
    screenName: null,
    uiStateId: null,
    stepId: null,
    actionId: null,
  };
  /** Recent wrapper-performed pointer events, for de-duplication. */
  private readonly recentWrapperPointers: Array<{ x: number; y: number; wallMs: number }> = [];
  private lastScrollByContainer = new Map<string, { wallMs: number; y: number; x: number }>();
  private droppedDuplicates = 0;
  private droppedOverLimit = 0;
  private videoStartedAtMs: number | null = null;

  constructor(
    private readonly repos: Repositories,
    private readonly ids: {
      executionId: string;
      projectId: string;
      personaId: string | null;
      planId: string | null;
    },
    private readonly device: DeviceProfile,
    readonly clock: ExecutionClock,
  ) {}

  /** Called once the browser page exists and recording has begun. */
  setVideoStart(wallMs: number | null): void {
    this.videoStartedAtMs = wallMs;
  }

  /** Milliseconds from the execution origin to the first video frame. */
  get videoStartOffsetMs(): number | null {
    if (this.videoStartedAtMs === null) return null;
    return Math.max(0, this.videoStartedAtMs - this.clock.wallOriginMs);
  }

  setContext(patch: Partial<RecorderContext>): void {
    this.context = { ...this.context, ...patch };
  }

  get currentContext(): RecorderContext {
    return this.context;
  }

  get eventCount(): number {
    return this.events.length;
  }

  get scrollSampleCount(): number {
    return this.scrollSamples.length;
  }

  /** Notes about fidelity, surfaced to the user rather than kept in a log. */
  limitations(): string[] {
    const out: string[] = [];
    if (this.droppedOverLimit > 0) {
      out.push(
        `${this.droppedOverLimit} interaction event(s) were discarded after the per-run limit of ${MAX_EVENTS} was reached. The recorded set is a prefix of the run, not a sample of it.`,
      );
    }
    return out;
  }

  /* ---------------- wrapper-initiated ---------------- */

  /**
   * Record an interaction Lenz performed.
   *
   * Returns the stored event so the caller can link it to the execution action
   * row once that row exists.
   */
  recordPointer(input: RecordPointerInput): InteractionEvent | null {
    const hasPoint = typeof input.x === 'number' && typeof input.y === 'number';
    if (!hasPoint && !input.coordinateNote) {
      // A missing coordinate must always be explained; refusing to guess is the
      // whole point, but an unexplained null is just as useless downstream.
      input.coordinateNote = 'The executor performed this action without a viewport coordinate.';
    }

    const elapsed =
      typeof input.occurredAtMs === 'number'
        ? this.clock.elapsedForWallMs(input.occurredAtMs)
        : this.clock.elapsedMs();
    const event = this.build({
      type: input.type,
      source: 'lenz-action',
      pointer: input.pointer,
      label: input.label,
      targetRole: input.targetRole ?? null,
      targetName: redact(input.targetName ?? null),
      targetSelector: input.targetSelector ?? null,
      targetWidth: input.targetWidth ?? null,
      targetHeight: input.targetHeight ?? null,
      viewportX: hasPoint ? input.x! : null,
      viewportY: hasPoint ? input.y! : null,
      pageX:
        hasPoint && typeof input.scrollX === 'number' ? input.x! + input.scrollX : null,
      pageY:
        hasPoint && typeof input.scrollY === 'number' ? input.y! + input.scrollY : null,
      coordinateStatus: hasPoint ? 'recorded' : 'unavailable',
      coordinateNote: hasPoint ? null : (input.coordinateNote ?? null),
      url: input.url,
      elapsedMs: elapsed,
      result: input.result,
      resultNote: input.resultNote ?? null,
      scrollX: input.scrollX ?? null,
      scrollY: input.scrollY ?? null,
      documentWidth: input.documentWidth ?? null,
      documentHeight: input.documentHeight ?? null,
      deltaX: input.deltaX ?? null,
      deltaY: input.deltaY ?? null,
      durationMs: input.durationMs ?? null,
    });

    if (!event) return null;

    if (hasPoint && (input.type === 'click' || input.type === 'tap')) {
      // De-duplication compares against the page's own timestamps, so this must
      // be when the press happened, not when the wrapper got round to storing it.
      this.recentWrapperPointers.push({
        x: input.x!,
        y: input.y!,
        wallMs: input.occurredAtMs ?? Date.now(),
      });
      if (this.recentWrapperPointers.length > 40) this.recentWrapperPointers.shift();
    }
    return event;
  }

  /** Link already-recorded events to the execution action row they belong to. */
  attachActionId(eventIds: Array<string | null | undefined>, actionId: string): void {
    const wanted = new Set(eventIds.filter(Boolean) as string[]);
    if (wanted.size === 0) return;
    for (const e of this.events) {
      if (wanted.has(e.id)) e.actionId = actionId;
    }
  }

  /** Attach an action id to every event recorded since a marker index. */
  attachActionIdSince(fromIndex: number, actionId: string): void {
    for (const e of this.events) {
      if (e.index >= fromIndex && e.actionId === null) e.actionId = actionId;
    }
  }

  get nextIndex(): number {
    return this.index;
  }

  /* ---------------- page-observed ---------------- */

  ingestPageEvent(raw: RawPageEvent): void {
    try {
      if (!raw || typeof raw !== 'object') return;

      if (raw.type === 'scroll') {
        this.ingestScroll(raw);
        return;
      }

      const wallMs = Number.isFinite(raw.ts) ? raw.ts : Date.now();
      const hasPoint = typeof raw.x === 'number' && typeof raw.y === 'number';

      if (hasPoint && this.isDuplicate(raw.x!, raw.y!, wallMs)) {
        this.droppedDuplicates++;
        return;
      }

      this.build({
        type: normalizeType(raw.type),
        source: 'browser-listener',
        pointer: raw.pointer === 'touch' ? 'touch' : raw.pointer === 'mouse' ? 'mouse' : 'none',
        label: raw.name ? `${verbFor(raw.type)} ${redact(raw.name)}` : null,
        targetRole: raw.role ?? null,
        targetName: redact(raw.name ?? null),
        targetSelector: raw.selector ?? null,
        targetWidth: numberOrNull(raw.targetWidth),
        targetHeight: numberOrNull(raw.targetHeight),
        viewportX: hasPoint ? raw.x! : null,
        viewportY: hasPoint ? raw.y! : null,
        pageX: numberOrNull(raw.pageX),
        pageY: numberOrNull(raw.pageY),
        coordinateStatus: hasPoint ? 'recorded' : 'unavailable',
        coordinateNote: hasPoint
          ? null
          : raw.type === 'key'
            ? 'Activated from the keyboard, which has no pointer position.'
            : 'The page reported this interaction without a pointer position.',
        url: raw.url ?? '',
        elapsedMs: this.clock.elapsedForWallMs(wallMs),
        // The page cannot see whether a navigation was the intended one; only
        // the wrapper verifies that. Saying "unverified" is accurate.
        result: 'unverified',
        resultNote: 'Observed by page instrumentation; outcome not verified by the executor.',
        scrollX: numberOrNull(raw.scrollX),
        scrollY: numberOrNull(raw.scrollY),
        documentWidth: numberOrNull(raw.docWidth),
        documentHeight: numberOrNull(raw.docHeight),
        deltaX: numberOrNull(raw.deltaX),
        deltaY: numberOrNull(raw.deltaY),
        durationMs: numberOrNull(raw.durationMs),
        viewportOverride:
          raw.viewportWidth && raw.viewportHeight
            ? { width: Math.round(raw.viewportWidth), height: Math.round(raw.viewportHeight) }
            : undefined,
      });
    } catch (err) {
      // Never let a malformed page payload break the run, but never swallow it
      // silently either - a bare catch once hid a real crash in this codebase.
      logger.warn({ err: (err as Error).message }, 'Could not ingest a page interaction event');
    }
  }

  private ingestScroll(raw: RawPageEvent): void {
    if (this.scrollSamples.length >= MAX_SCROLL_SAMPLES) return;

    const container = raw.container || 'window';
    const wallMs = Number.isFinite(raw.ts) ? raw.ts : Date.now();
    const prev = this.lastScrollByContainer.get(container);
    const scrollY = numberOrNull(raw.scrollY) ?? 0;
    const scrollX = numberOrNull(raw.scrollX) ?? 0;

    // Dwell is the time the PREVIOUS position was held, which is only knowable
    // once the next sample arrives. Back-fill it there rather than guessing.
    if (prev) {
      const last = this.scrollSamples[this.scrollSamples.length - 1];
      if (last && last.container === container) {
        last.dwellMs = Math.max(0, Math.round(wallMs - prev.wallMs));
      }
    }

    const viewportHeight = Math.round(raw.viewportHeight || this.device.height);
    const viewportWidth = Math.round(raw.viewportWidth || this.device.width);
    const documentHeight = numberOrNull(raw.docHeight);
    const documentWidth = numberOrNull(raw.docWidth);

    const sample: ScrollSample = {
      id: `scr_${this.ids.executionId}_${this.scrollSamples.length}`,
      executionId: this.ids.executionId,
      projectId: this.ids.projectId,
      personaId: this.ids.personaId,
      screenId: this.context.screenId,
      screenName: this.context.screenName,
      deviceId: this.device.id,
      deviceKind: this.device.kind,
      container,
      scrollX,
      scrollY,
      viewportWidth,
      viewportHeight,
      documentHeight,
      documentWidth,
      depthFraction: depthFraction(scrollY, viewportHeight, documentHeight),
      direction: directionFrom(prev, scrollX, scrollY),
      dwellMs: 0,
      elapsedMs: this.clock.elapsedForWallMs(wallMs),
      videoOffsetMs: this.videoOffsetFor(wallMs),
      timestamp: new Date(wallMs).toISOString(),
      source: 'browser-listener',
    };

    this.scrollSamples.push(sample);
    this.lastScrollByContainer.set(container, { wallMs, y: scrollY, x: scrollX });
  }

  /* ---------------- persistence ---------------- */

  /** Write everything collected. Called once, after the browser is released. */
  flush(): { events: number; scrollSamples: number } {
    try {
      this.repos.addInteractionEvents(this.events);
      this.repos.addScrollSamples(this.scrollSamples);
    } catch (err) {
      logger.error(
        { err: (err as Error).message, executionId: this.ids.executionId },
        'Could not persist interaction events',
      );
    }
    return { events: this.events.length, scrollSamples: this.scrollSamples.length };
  }

  /* ---------------- internals ---------------- */

  private build(
    input: Omit<
      InteractionEvent,
      | 'id'
      | 'executionId'
      | 'projectId'
      | 'personaId'
      | 'planId'
      | 'stepId'
      | 'actionId'
      | 'index'
      | 'deviceId'
      | 'deviceKind'
      | 'deviceScaleFactor'
      | 'viewportWidth'
      | 'viewportHeight'
      | 'screenId'
      | 'screenName'
      | 'uiStateId'
      | 'timestamp'
      | 'videoOffsetMs'
    > & { viewportOverride?: { width: number; height: number } },
  ): InteractionEvent | null {
    if (this.events.length >= MAX_EVENTS) {
      this.droppedOverLimit++;
      return null;
    }
    const { viewportOverride, ...rest } = input;
    const wallMs = this.clock.wallOriginMs + rest.elapsedMs;

    const event: InteractionEvent = {
      id: `ixn_${this.ids.executionId}_${this.index}`,
      executionId: this.ids.executionId,
      projectId: this.ids.projectId,
      personaId: this.ids.personaId,
      planId: this.ids.planId,
      stepId: this.context.stepId,
      actionId: this.context.actionId,
      index: this.index++,
      deviceId: this.device.id,
      deviceKind: this.device.kind,
      deviceScaleFactor: this.device.deviceScaleFactor,
      // The emulated viewport is authoritative. A page-reported innerWidth can
      // differ by the scrollbar width, which would split one screen into two
      // heatmap groups for no real reason.
      viewportWidth: this.device.width,
      viewportHeight: viewportOverride?.height ?? this.device.height,
      screenId: this.context.screenId,
      screenName: this.context.screenName,
      uiStateId: this.context.uiStateId,
      timestamp: new Date(wallMs).toISOString(),
      videoOffsetMs: this.videoOffsetFor(wallMs),
      ...rest,
    };

    this.events.push(event);
    return event;
  }

  private videoOffsetFor(wallMs: number): number | null {
    if (this.videoStartedAtMs === null) return null;
    return Math.max(0, Math.round(wallMs - this.videoStartedAtMs));
  }

  private isDuplicate(x: number, y: number, wallMs: number): boolean {
    for (let i = this.recentWrapperPointers.length - 1; i >= 0; i--) {
      const p = this.recentWrapperPointers[i]!;
      if (Math.abs(wallMs - p.wallMs) > DEDUP_WINDOW_MS) continue;
      if (Math.hypot(x - p.x, y - p.y) <= DEDUP_RADIUS_PX) return true;
    }
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Pure helpers (exported for tests)
 * ------------------------------------------------------------------ */

/**
 * Scroll depth as a fraction of the document.
 *
 * Measures the BOTTOM of the viewport, so "100%" means the end of the document
 * was on screen. Returns null when the document height is unknown rather than
 * defaulting - a fabricated 0% would read as "the persona never scrolled",
 * which is a different claim entirely.
 */
export function depthFraction(
  scrollY: number,
  viewportHeight: number,
  documentHeight: number | null,
): number | null {
  if (documentHeight === null || !Number.isFinite(documentHeight) || documentHeight <= 0) return null;
  if (!Number.isFinite(scrollY) || !Number.isFinite(viewportHeight)) return null;
  const bottom = scrollY + viewportHeight;
  return Math.max(0, Math.min(1, bottom / documentHeight));
}

export function directionFrom(
  prev: { x: number; y: number } | undefined,
  x: number,
  y: number,
): ScrollDirection {
  if (!prev) return y > 0 ? 'down' : 'none';
  const dy = y - prev.y;
  const dx = x - prev.x;
  if (dy === 0 && dx === 0) return 'none';
  if (Math.abs(dy) >= Math.abs(dx)) return dy > 0 ? 'down' : 'up';
  return dx > 0 ? 'right' : 'left';
}

function normalizeType(t: RawPageEvent['type']): InteractionType {
  switch (t) {
    case 'tap':
    case 'swipe':
    case 'click':
    case 'key':
    case 'navigation':
      return t;
    default:
      return 'state-change';
  }
}

function verbFor(t: RawPageEvent['type']): string {
  switch (t) {
    case 'tap':
      return 'Tapped';
    case 'swipe':
      return 'Swiped on';
    case 'key':
      return 'Activated';
    default:
      return 'Clicked';
  }
}

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Where the recap player should jump when a timeline step is clicked.
 *
 * NOT the action's own `offsetMs`: that is stamped when the step FINISHES —
 * after the click, the navigation, the settle wait and the screenshot. Measured
 * on real runs it trails the actual click by ~1.9s on desktop and ~5.5s on
 * mobile, which is far enough to land on the next screen and read as the
 * markers being out of sync with the video.
 *
 * The first interaction recorded against the step is the moment the persona
 * actually did something, so that is the seek target. A step that recorded no
 * interaction (a pure wait, or a capture that failed before anything happened)
 * has nothing better to offer than the action offset.
 */
export function seekOffsetForAction(
  actionOffsetMs: number,
  interactionElapsedMs: number[],
): number {
  const usable = interactionElapsedMs.filter((n) => Number.isFinite(n) && n >= 0);
  if (usable.length === 0) return actionOffsetMs;
  return Math.min(...usable);
}

/**
 * Last-line redaction for anything that reaches an element label.
 *
 * The page-side listeners already refuse to read values and blank out
 * credential-shaped fields, so this is a safety net, not the primary control:
 * a long run of digits in a visible label is far more likely to be a card
 * number, an OTP or an account number than something a UX report needs.
 */
export function redact(text: string | null): string | null {
  if (!text) return text;
  return text
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/g, '[email]')
    .replace(/\b\d[\d\s-]{5,}\d\b/g, '[number]')
    .slice(0, 200);
}
