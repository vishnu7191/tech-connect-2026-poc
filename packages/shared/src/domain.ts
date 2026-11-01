import { z } from 'zod';

/* ------------------------------------------------------------------ *
 * Figma URL classification
 * ------------------------------------------------------------------ */

/**
 * Every Figma link type Lenz can recognise. Recognising a type it cannot fully
 * support still matters: it lets the product explain WHY, instead of rejecting
 * the URL as unparseable.
 */
export const FigmaUrlKind = z.enum([
  'proto',     // clickable prototype - full support
  'design',    // design file - structural discovery
  'file',      // legacy alias of design
  'make',      // Figma Make app - browser-driven discovery
  'board',     // FigJam board
  'slides',    // Figma Slides
  'deck',      // Slides in presentation view
  'community', // community listing - not a file key
  'unknown',   // recognised host, unrecognised type
]);

/** What Lenz can actually do with each link type. */
export const FigmaUrlSupport = z.enum(['full', 'structural', 'browser-only', 'unsupported']);
export type FigmaUrlSupport = z.infer<typeof FigmaUrlSupport>;
export type FigmaUrlKind = z.infer<typeof FigmaUrlKind>;

export const ParsedFigmaUrl = z.object({
  kind: FigmaUrlKind,
  fileKey: z.string().min(1),
  fileName: z.string().nullable(),
  /** Normalized to Figma's internal `1:2` form (URLs use `1-2`). Null for Scenario B. */
  startNodeId: z.string().nullable(),
  pageId: z.string().nullable(),
  codeNodeId: z.string().nullable(),
  originalUrl: z.string(),
  /** True when the URL carried an explicit start node. Drives Scenario A vs B. */
  hasExplicitStartPoint: z.boolean(),
  /** REST discovery is meaningless for Make; it is browser-only. */
  supportsRestDiscovery: z.boolean(),
  /** How much of the workflow this link type can drive. */
  support: FigmaUrlSupport,
  /** Plain-language explanation shown to the user before they commit. */
  supportNote: z.string(),
  /** Present when the link cannot be used, with what to do instead. */
  blockedReason: z.string().nullable(),
  branchId: z.string().nullable(),
});
export type ParsedFigmaUrl = z.infer<typeof ParsedFigmaUrl>;

/* ------------------------------------------------------------------ *
 * Screens
 * ------------------------------------------------------------------ */

export const ScreenClassification = z.enum(['screen', 'component', 'ambiguous']);
export type ScreenClassification = z.infer<typeof ScreenClassification>;

export const DeviceClass = z.enum(['mobile', 'tablet', 'desktop', 'overlay', 'unknown']);
export type DeviceClass = z.infer<typeof DeviceClass>;

/** Machine-readable reasons a screen was not reached or captured. Never free text. */
export const UnreachableReason = z.enum([
  'no-incoming-navigate-edge',
  'unsupported-trigger-only',
  'disconnected-canvas',
  'api-inaccessible',
  'render-failed',
  'blank-screenshot',
  'destination-mismatch',
  'capture-timeout',
  'cancelled',
  'action-limit-reached',
  'not-attempted',
]);
export type UnreachableReason = z.infer<typeof UnreachableReason>;

export const ClassificationSignal = z.object({
  signal: z.string(),
  weight: z.number(),
  detail: z.string().optional(),
});
export type ClassificationSignal = z.infer<typeof ClassificationSignal>;

export const Screen = z.object({
  id: z.string(),
  projectId: z.string(),
  nodeId: z.string(),
  name: z.string(),
  canvasId: z.string(),
  canvasName: z.string(),
  nodeType: z.string(),
  classification: ScreenClassification,
  classificationScore: z.number(),
  classificationSignals: z.array(ClassificationSignal),
  deviceClass: DeviceClass,
  width: z.number(),
  height: z.number(),
  absX: z.number(),
  absY: z.number(),
  isEntryPoint: z.boolean(),
  reachable: z.boolean(),
  unreachableReason: UnreachableReason.nullable(),
  figmaImageUrl: z.string().nullable(),
});
export type Screen = z.infer<typeof Screen>;

/* ------------------------------------------------------------------ *
 * Navigation graph
 *
 * ADR-0001: edges are typed. Only `screen` edges affect reachability.
 * Measured on the Rosella file: 59% of interactions are NOT screen
 * transitions (740 CHANGE_TO vs 435 NAVIGATE).
 * ------------------------------------------------------------------ */

export const EdgeKind = z.enum(['screen', 'overlay', 'ui-state']);
export type EdgeKind = z.infer<typeof EdgeKind>;

export const FigmaNavigation = z.enum([
  'NAVIGATE',
  'OVERLAY',
  'SWAP',
  'CHANGE_TO',
  'SCROLL_TO',
  'SWAP_STATE',
]);
export type FigmaNavigation = z.infer<typeof FigmaNavigation>;

export const FigmaTrigger = z.enum([
  'ON_CLICK',
  'ON_HOVER',
  'ON_PRESS',
  'ON_DRAG',
  'DRAG',
  'AFTER_TIMEOUT',
  'MOUSE_ENTER',
  'MOUSE_LEAVE',
  'MOUSE_UP',
  'MOUSE_DOWN',
  'ON_KEY_DOWN',
  'ON_MEDIA_HIT',
  'ON_MEDIA_END',
  'UNKNOWN',
]);
export type FigmaTrigger = z.infer<typeof FigmaTrigger>;

export const UnsupportedReason = z.enum([
  'timeout-trigger-not-executable',
  'drag-trigger-not-executable',
  'conditional-logic',
  'variable-dependent',
  'external-link',
  'target-not-in-viewport',
  'missing-geometry',
  'destination-not-found',
]);
export type UnsupportedReason = z.infer<typeof UnsupportedReason>;

export const GraphEdge = z.object({
  id: z.string(),
  projectId: z.string(),
  fromScreenId: z.string(),
  toScreenId: z.string(),
  kind: EdgeKind,
  figmaNavigation: FigmaNavigation,
  trigger: FigmaTrigger,
  /** The deep descendant that actually owns the interaction - the click target. */
  sourceNodeId: z.string(),
  sourceNodeName: z.string(),
  sourceAbsX: z.number().nullable(),
  sourceAbsY: z.number().nullable(),
  sourceAbsW: z.number().nullable(),
  sourceAbsH: z.number().nullable(),
  supported: z.boolean(),
  unsupportedReason: UnsupportedReason.nullable(),
});
export type GraphEdge = z.infer<typeof GraphEdge>;

/* ------------------------------------------------------------------ *
 * Entry points - confirmed vs inferred (never conflated)
 * ------------------------------------------------------------------ */

export const EntryPointKind = z.enum(['confirmed', 'inferred']);
export type EntryPointKind = z.infer<typeof EntryPointKind>;

export const EntryPointSource = z.enum([
  'prototypeStartNodeID',
  'flowStartingPoint',
  'urlStartNode',
  'heuristic',
]);
export type EntryPointSource = z.infer<typeof EntryPointSource>;

export const EntryPoint = z.object({
  id: z.string(),
  projectId: z.string(),
  screenId: z.string(),
  nodeId: z.string(),
  screenName: z.string(),
  kind: EntryPointKind,
  source: EntryPointSource,
  flowName: z.string().nullable(),
  rank: z.number(),
  score: z.number(),
  signals: z.array(ClassificationSignal),
  selected: z.boolean(),
});
export type EntryPoint = z.infer<typeof EntryPoint>;

/* ------------------------------------------------------------------ *
 * UI states (component variants, overlays, and Make DOM states)
 * ------------------------------------------------------------------ */

export const UiStateKind = z.enum(['variant', 'overlay', 'scroll', 'dom', 'route']);
export type UiStateKind = z.infer<typeof UiStateKind>;

export const UiState = z.object({
  id: z.string(),
  projectId: z.string(),
  screenId: z.string().nullable(),
  signature: z.string(),
  label: z.string(),
  kind: UiStateKind,
  discoveredBy: z.enum(['figma', 'browser']),
});
export type UiState = z.infer<typeof UiState>;

/* ------------------------------------------------------------------ *
 * Coverage - seven independent dimensions (never collapsed into one)
 * ------------------------------------------------------------------ */

export const CoverageDimension = z.enum([
  'designDiscovery',
  'reachability',
  'interactionDiscovery',
  'interactionExecution',
  'screenshotCapture',
  'testExecution',
  'videoRecording',
]);
export type CoverageDimension = z.infer<typeof CoverageDimension>;

export const CoverageMiss = z.object({
  id: z.string(),
  label: z.string(),
  reason: z.string(),
});
export type CoverageMiss = z.infer<typeof CoverageMiss>;

export const CoverageMetric = z.object({
  dimension: CoverageDimension,
  numerator: z.number(),
  denominator: z.number(),
  /** null when denominator is 0 - "not applicable", never silently 100%. */
  percentage: z.number().nullable(),
  misses: z.array(CoverageMiss),
  /** Excluded-by-design items (e.g. COMPONENT_SETs). Not failures - reported separately. */
  excludedCount: z.number(),
  note: z.string().nullable(),
});
export type CoverageMetric = z.infer<typeof CoverageMetric>;

export const CoverageReport = z.object({
  projectId: z.string(),
  executionId: z.string().nullable(),
  metrics: z.array(CoverageMetric),
  computedAt: z.string(),
});
export type CoverageReport = z.infer<typeof CoverageReport>;

/* ------------------------------------------------------------------ *
 * Projects & discovery
 * ------------------------------------------------------------------ */

export const ProjectStatus = z.enum([
  'created',
  'discovering',
  'discovered',
  'discovery-failed',
  'testing',
  'analyzed',
]);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

export const Project = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  figmaUrl: z.string(),
  urlKind: FigmaUrlKind,
  fileKey: z.string(),
  startNodeId: z.string().nullable(),
  status: ProjectStatus,
  autoApprovePlans: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Project = z.infer<typeof Project>;

export const DiscoveryWarning = z.object({
  code: z.string(),
  message: z.string(),
  severity: z.enum(['info', 'warning', 'error']),
  context: z.record(z.string(), z.unknown()).optional(),
});
export type DiscoveryWarning = z.infer<typeof DiscoveryWarning>;

export const DiscoveryMode = z.enum(['rest+browser', 'rest-only', 'browser-only', 'failed']);
export type DiscoveryMode = z.infer<typeof DiscoveryMode>;

export const DiscoveryReport = z.object({
  projectId: z.string(),
  runId: z.string(),
  mode: DiscoveryMode,
  screensDiscovered: z.number(),
  componentsExcluded: z.number(),
  ambiguousCount: z.number(),
  screensReachable: z.number(),
  disconnectedCount: z.number(),
  interactionsFound: z.number(),
  screenEdges: z.number(),
  uiStateEdges: z.number(),
  overlayEdges: z.number(),
  unsupportedInteractions: z.number(),
  confirmedEntryPoints: z.number(),
  inferredEntryPoints: z.number(),
  flowCount: z.number(),
  warnings: z.array(DiscoveryWarning),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type DiscoveryReport = z.infer<typeof DiscoveryReport>;
