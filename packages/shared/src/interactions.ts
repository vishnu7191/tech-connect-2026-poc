import { z } from 'zod';
import { DeviceKind, DeviceProfile } from './devices.js';

/* ------------------------------------------------------------------ *
 * Interaction events
 *
 * One row per thing that happened to the pointer, the touch surface or the
 * scroll position during a test run. Two rules govern this model:
 *
 *  1. NEVER fabricate a coordinate. Some actions genuinely have no point - a
 *     keyboard activation, a locator-driven click on an element Playwright
 *     resolved itself, a navigation. Those record `coordinateStatus:
 *     'unavailable'` with a reason, and the heatmap excludes them and SAYS SO.
 *  2. Every event states where it came from. A `lenz-action` event is one Lenz
 *     performed through its own action wrapper; a `browser-listener` event was
 *     observed by page-side instrumentation. They are de-duplicated, but the
 *     provenance is kept because the two have different reliability.
 * ------------------------------------------------------------------ */

export const InteractionType = z.enum([
  'click',
  'tap',
  'swipe',
  'scroll',
  'key',
  'navigation',
  'state-change',
]);
export type InteractionType = z.infer<typeof InteractionType>;

export const InteractionSource = z.enum(['lenz-action', 'browser-listener']);
export type InteractionSource = z.infer<typeof InteractionSource>;

export const PointerKind = z.enum(['mouse', 'touch', 'none']);
export type PointerKind = z.infer<typeof PointerKind>;

/**
 * Outcome of the interaction.
 *
 * `unverified` is a first-class result, not a failure: a click inside a
 * cross-origin iframe or on a canvas surface can be dispatched successfully
 * while Lenz has no way to confirm what it did.
 */
export const InteractionResult = z.enum(['success', 'failure', 'unverified']);
export type InteractionResult = z.infer<typeof InteractionResult>;

export const CoordinateStatus = z.enum(['recorded', 'unavailable']);
export type CoordinateStatus = z.infer<typeof CoordinateStatus>;

export const InteractionEvent = z.object({
  id: z.string(),
  executionId: z.string(),
  projectId: z.string(),
  personaId: z.string().nullable(),
  planId: z.string().nullable(),
  stepId: z.string().nullable(),
  /** The execution_actions row this event belongs to, when it has one. */
  actionId: z.string().nullable(),
  /** Monotonic ordering within the execution. */
  index: z.number().int().min(0),

  type: InteractionType,
  source: InteractionSource,
  pointer: PointerKind,
  /** Human label shown on the video marker, e.g. "Clicked Add to Cart". */
  label: z.string().max(200).nullable(),

  targetRole: z.string().max(80).nullable(),
  targetName: z.string().max(200).nullable(),
  /** A short, structural locator - never a value typed by the persona. */
  targetSelector: z.string().max(300).nullable(),
  targetWidth: z.number().nullable(),
  targetHeight: z.number().nullable(),

  /** CSS pixels, relative to the top-left of the viewport. */
  viewportX: z.number().nullable(),
  viewportY: z.number().nullable(),
  /** CSS pixels, relative to the top-left of the document. */
  pageX: z.number().nullable(),
  pageY: z.number().nullable(),
  coordinateStatus: CoordinateStatus,
  /** Why a coordinate is missing. Required whenever status is 'unavailable'. */
  coordinateNote: z.string().max(300).nullable(),

  viewportWidth: z.number().int(),
  viewportHeight: z.number().int(),
  deviceScaleFactor: z.number(),
  deviceId: z.string(),
  deviceKind: DeviceKind,

  url: z.string().max(2000),
  /** Figma node id, Make state id, or null when the state is unknown. */
  screenId: z.string().nullable(),
  screenName: z.string().max(200).nullable(),
  uiStateId: z.string().nullable(),

  timestamp: z.string(),
  /** Milliseconds from the execution's monotonic clock origin. */
  elapsedMs: z.number().int().min(0),
  /** Milliseconds from the first video frame. Null when nothing was recorded. */
  videoOffsetMs: z.number().int().nullable(),

  result: InteractionResult,
  resultNote: z.string().max(400).nullable(),

  /** Scroll position at the moment of the event. */
  scrollX: z.number().nullable(),
  scrollY: z.number().nullable(),
  documentWidth: z.number().nullable(),
  documentHeight: z.number().nullable(),

  /** Gesture geometry: present for swipes and scrolls. */
  deltaX: z.number().nullable(),
  deltaY: z.number().nullable(),
  durationMs: z.number().nullable(),
});
export type InteractionEvent = z.infer<typeof InteractionEvent>;

/* ------------------------------------------------------------------ *
 * Scroll samples
 * ------------------------------------------------------------------ */

export const ScrollDirection = z.enum(['down', 'up', 'left', 'right', 'none']);
export type ScrollDirection = z.infer<typeof ScrollDirection>;

export const ScrollSample = z.object({
  id: z.string(),
  executionId: z.string(),
  projectId: z.string(),
  personaId: z.string().nullable(),
  screenId: z.string().nullable(),
  screenName: z.string().max(200).nullable(),
  deviceId: z.string(),
  deviceKind: DeviceKind,
  /** 'window' for the page itself, or a short structural path for a nested container. */
  container: z.string().max(300),
  scrollX: z.number(),
  scrollY: z.number(),
  viewportWidth: z.number().int(),
  viewportHeight: z.number().int(),
  /** Null when the document height could not be measured (cross-origin frame). */
  documentHeight: z.number().nullable(),
  documentWidth: z.number().nullable(),
  /**
   * (scrollY + viewportHeight) / documentHeight, clamped to 0..1.
   * Null when documentHeight is unknown - never defaulted to 0 or 1.
   */
  depthFraction: z.number().min(0).max(1).nullable(),
  direction: ScrollDirection,
  /** Time this scroll position was held before the next sample. */
  dwellMs: z.number().int().min(0),
  elapsedMs: z.number().int().min(0),
  videoOffsetMs: z.number().int().nullable(),
  timestamp: z.string(),
  source: InteractionSource,
});
export type ScrollSample = z.infer<typeof ScrollSample>;

/* ------------------------------------------------------------------ *
 * Click / tap heatmap
 *
 * Aggregation is deterministic and done from recorded coordinates only. No
 * model is involved at any point, and the report states plainly that the data
 * is synthetic test traffic, not human behaviour.
 * ------------------------------------------------------------------ */

export const HeatmapPoint = z.object({
  x: z.number(),
  y: z.number(),
  /** Always 1 for a single event; kept so a future weighting is additive. */
  weight: z.number(),
  type: InteractionType,
  result: InteractionResult,
  label: z.string().max(200).nullable(),
  executionId: z.string(),
  personaId: z.string().nullable(),
  elapsedMs: z.number().int(),
});
export type HeatmapPoint = z.infer<typeof HeatmapPoint>;

/**
 * One heatmap = one screen at one viewport geometry.
 *
 * Points from a 390-wide run and a 1440-wide run are NOT merged: the layouts
 * differ, so a merged map would be meaningless. The grouping key makes that
 * structural rather than a convention somebody has to remember.
 */
export const HeatmapGroup = z.object({
  key: z.string(),
  screenId: z.string().nullable(),
  screenName: z.string().nullable(),
  deviceId: z.string(),
  deviceKind: DeviceKind,
  viewportWidth: z.number().int(),
  viewportHeight: z.number().int(),
  points: z.array(HeatmapPoint),
  totalPoints: z.number().int(),
  successCount: z.number().int(),
  failureCount: z.number().int(),
  unverifiedCount: z.number().int(),
  sessionCount: z.number().int(),
  personaCount: z.number().int(),
  /** Background evidence. Null when no compatible screenshot exists. */
  screenshotId: z.string().nullable(),
  screenshotWidth: z.number().int().nullable(),
  screenshotHeight: z.number().int().nullable(),
  /**
   * True when points can be drawn over the screenshot with a single uniform
   * scale. False means the screenshot geometry does not match the viewport the
   * events were recorded at, so the overlay would misplace every point.
   */
  screenshotCompatible: z.boolean(),
  screenshotNote: z.string().max(300).nullable(),
});
export type HeatmapGroup = z.infer<typeof HeatmapGroup>;

export const HeatmapExclusion = z.object({
  reason: z.string().max(200),
  count: z.number().int(),
});
export type HeatmapExclusion = z.infer<typeof HeatmapExclusion>;

export const HeatmapReport = z.object({
  projectId: z.string(),
  groups: z.array(HeatmapGroup),
  /** Events that could not contribute, with the reason. Never silently dropped. */
  exclusions: z.array(HeatmapExclusion),
  executionIds: z.array(z.string()),
  generatedAt: z.string(),
  dataNote: z.string(),
});
export type HeatmapReport = z.infer<typeof HeatmapReport>;

/* ------------------------------------------------------------------ *
 * Scroll analytics
 * ------------------------------------------------------------------ */

export const ScrollRegion = z.object({
  /** Page region, as a fraction of document height. */
  fromFraction: z.number().min(0).max(1),
  toFraction: z.number().min(0).max(1),
  /** Milliseconds this band was inside the viewport. Measured, not inferred. */
  exposureMs: z.number().int().min(0),
  /** How many sessions ever brought this band into the viewport. */
  sessionsReached: z.number().int().min(0),
});
export type ScrollRegion = z.infer<typeof ScrollRegion>;

export const ScrollSummary = z.object({
  key: z.string(),
  screenId: z.string().nullable(),
  screenName: z.string().nullable(),
  deviceId: z.string(),
  deviceKind: DeviceKind,
  viewportHeight: z.number().int(),
  /** Tallest document height observed. Null when never measurable. */
  documentHeight: z.number().nullable(),
  maxScrollY: z.number(),
  /** Deepest point reached, as a fraction of the document. Null when unknown. */
  maxDepthFraction: z.number().min(0).max(1).nullable(),
  /** Mean of each session's own deepest point. Null when unknown. */
  meanDepthFraction: z.number().min(0).max(1).nullable(),
  sessionCount: z.number().int(),
  sampleCount: z.number().int(),
  totalDwellMs: z.number().int(),
  /** Did the content ever exceed the viewport? */
  scrollable: z.boolean(),
  regions: z.array(ScrollRegion),
  note: z.string().max(400).nullable(),
});
export type ScrollSummary = z.infer<typeof ScrollSummary>;

export const ScrollReport = z.object({
  projectId: z.string(),
  summaries: z.array(ScrollSummary),
  executionIds: z.array(z.string()),
  generatedAt: z.string(),
  dataNote: z.string(),
});
export type ScrollReport = z.infer<typeof ScrollReport>;

/* ------------------------------------------------------------------ *
 * Responsive comparison
 * ------------------------------------------------------------------ */

export const TouchTargetConcern = z.object({
  label: z.string().max(200),
  width: z.number(),
  height: z.number(),
  screenId: z.string().nullable(),
  /** The guideline the measurement is being compared against. */
  guideline: z.string().max(120),
});
export type TouchTargetConcern = z.infer<typeof TouchTargetConcern>;

export const ResponsiveRun = z.object({
  executionId: z.string(),
  device: DeviceProfile,
  status: z.string(),
  startedAt: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  personaId: z.string().nullable(),
  personaName: z.string().nullable(),
  /** Steps whose recorded result was 'ok', over total plan steps. */
  stepsCompleted: z.number().int(),
  stepsTotal: z.number().int(),
  taskCompleted: z.boolean(),
  actionCount: z.number().int(),
  navigationCount: z.number().int(),
  failedActions: z.number().int(),
  skippedActions: z.number().int(),
  destinationMismatches: z.number().int(),
  interactionCount: z.number().int(),
  /** Screens actually reached, in order. Drives the navigation-difference list. */
  screensVisited: z.array(z.string()),
  maxDepthFraction: z.number().min(0).max(1).nullable(),
  touchTargetConcerns: z.array(TouchTargetConcern),
  /** Evidence: one screenshot id per visited screen, for side-by-side display. */
  screenshotIds: z.array(z.string()),
  notes: z.array(z.string()),
});
export type ResponsiveRun = z.infer<typeof ResponsiveRun>;

/**
 * A difference between device runs.
 *
 * `severity` is deliberately limited: a responsive layout that differs is
 * NORMAL. Only an execution failure or a measured guideline breach is raised
 * above `info`, and every entry carries the evidence it was derived from.
 */
export const ResponsiveDifferenceSeverity = z.enum(['info', 'concern', 'failure']);
export type ResponsiveDifferenceSeverity = z.infer<typeof ResponsiveDifferenceSeverity>;

export const ResponsiveDifference = z.object({
  dimension: z.enum([
    'task-completion',
    'action-count',
    'navigation-path',
    'control-availability',
    'layout-overflow',
    'touch-target',
    'scroll-depth',
    'friction',
    'execution-failure',
  ]),
  summary: z.string().max(400),
  detail: z.string().max(1200),
  severity: ResponsiveDifferenceSeverity,
  executionIds: z.array(z.string()),
});
export type ResponsiveDifference = z.infer<typeof ResponsiveDifference>;

export const ResponsiveComparison = z.object({
  projectId: z.string(),
  planId: z.string().nullable(),
  planName: z.string().nullable(),
  runs: z.array(ResponsiveRun),
  differences: z.array(ResponsiveDifference),
  generatedAt: z.string(),
  note: z.string(),
});
export type ResponsiveComparison = z.infer<typeof ResponsiveComparison>;
