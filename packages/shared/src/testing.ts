import { z } from 'zod';
import { UnreachableReason } from './domain.js';
import { DeviceProfile } from './devices.js';

/* ------------------------------------------------------------------ *
 * Personas
 * ------------------------------------------------------------------ */

export const TechnicalProficiency = z.enum(['low', 'medium', 'high', 'expert']);
export type TechnicalProficiency = z.infer<typeof TechnicalProficiency>;

export const Persona = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  name: z.string().min(1),
  ageRange: z.string().nullable(),
  background: z.string(),
  technicalProficiency: TechnicalProficiency,
  digitalExperience: z.string(),
  goals: z.array(z.string()),
  motivations: z.array(z.string()),
  frustrations: z.array(z.string()),
  accessibilityNeeds: z.array(z.string()),
  behavioralCharacteristics: z.array(z.string()),
  expectations: z.array(z.string()),
  origin: z.enum(['manual', 'ai']),
  generatedByModel: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Persona = z.infer<typeof Persona>;

/** Shape the AI must return when generating personas. Validated before persistence. */
export const GeneratedPersona = Persona.omit({
  id: true,
  projectId: true,
  origin: true,
  generatedByModel: true,
  createdAt: true,
  updatedAt: true,
});
export type GeneratedPersona = z.infer<typeof GeneratedPersona>;

export const GeneratedPersonaBatch = z.object({
  personas: z.array(GeneratedPersona).min(1).max(8),
});
export type GeneratedPersonaBatch = z.infer<typeof GeneratedPersonaBatch>;

/* ------------------------------------------------------------------ *
 * Test plans
 * ------------------------------------------------------------------ */

export const TestPlanStatus = z.enum(['draft', 'approved', 'archived']);
export type TestPlanStatus = z.infer<typeof TestPlanStatus>;

export const StepActionType = z.enum([
  'navigate',
  'click',
  'scroll',
  'type',
  'wait',
  'verify',
  'back',
]);
export type StepActionType = z.infer<typeof StepActionType>;

export const TestStep = z.object({
  id: z.string(),
  planId: z.string(),
  index: z.number(),
  description: z.string(),
  actionType: StepActionType,
  /** Free-text hint the executor resolves against the graph or via AI vision. */
  targetHint: z.string().nullable(),
  expectedOutcome: z.string(),
  expectedScreenId: z.string().nullable(),
  expectedScreenName: z.string().nullable(),
});
export type TestStep = z.infer<typeof TestStep>;

export const TestPlan = z.object({
  id: z.string(),
  projectId: z.string(),
  personaId: z.string(),
  name: z.string(),
  objective: z.string(),
  scenario: z.string(),
  preconditions: z.string().nullable(),
  startScreenId: z.string().nullable(),
  startScreenName: z.string().nullable(),
  screensInvolved: z.array(z.string()),
  successCriteria: z.array(z.string()),
  frictionPoints: z.array(z.string()),
  status: TestPlanStatus,
  approvedAt: z.string().nullable(),
  origin: z.enum(['manual', 'ai']),
  generatedByModel: z.string().nullable(),
  steps: z.array(TestStep),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TestPlan = z.infer<typeof TestPlan>;

/** AI output contract for plan generation. */
export const GeneratedTestPlan = z.object({
  name: z.string(),
  objective: z.string(),
  scenario: z.string(),
  preconditions: z.string().nullable().optional(),
  startScreenNodeId: z.string().nullable().optional(),
  successCriteria: z.array(z.string()),
  frictionPoints: z.array(z.string()),
  steps: z
    .array(
      z.object({
        description: z.string(),
        actionType: StepActionType,
        targetHint: z.string().nullable().optional(),
        expectedOutcome: z.string(),
        expectedScreenNodeId: z.string().nullable().optional(),
      }),
    )
    .min(1)
    .max(30),
});
export type GeneratedTestPlan = z.infer<typeof GeneratedTestPlan>;

export const GeneratedTestPlanBatch = z.object({
  plans: z.array(GeneratedTestPlan).min(1).max(6),
});
export type GeneratedTestPlanBatch = z.infer<typeof GeneratedTestPlanBatch>;

/* ------------------------------------------------------------------ *
 * Execution
 * ------------------------------------------------------------------ */

export const ExecutionStatus = z.enum([
  'queued',
  'running',
  'paused',
  'succeeded',
  'failed',
  'cancelled',
]);
export type ExecutionStatus = z.infer<typeof ExecutionStatus>;

/** ADR-0004: the destination verdict is what turns a click into an assertion. */
export const NavigationVerdict = z.enum([
  'match',
  'mismatch',
  'no-navigation',
  'timeout',
  'not-applicable',
]);
export type NavigationVerdict = z.infer<typeof NavigationVerdict>;

export const ActionResult = z.enum(['ok', 'failed', 'skipped']);
export type ActionResult = z.infer<typeof ActionResult>;

export const ExecutionAction = z.object({
  id: z.string(),
  executionId: z.string(),
  index: z.number(),
  stepId: z.string().nullable(),
  description: z.string(),
  actionType: StepActionType,
  screenId: z.string().nullable(),
  screenName: z.string().nullable(),
  expectedDestinationNode: z.string().nullable(),
  actualDestinationNode: z.string().nullable(),
  verdict: NavigationVerdict,
  screenshotId: z.string().nullable(),
  timestamp: z.string(),
  /** Offset from execution start - lets the timeline seek the recap video. */
  offsetMs: z.number(),
  result: ActionResult,
  error: z.string().nullable(),
  /** Whether deterministic metadata or AI vision chose this action. */
  decidedBy: z.enum(['figma-metadata', 'ai-vision', 'plan-step', 'system']),
});
export type ExecutionAction = z.infer<typeof ExecutionAction>;

export const Execution = z.object({
  id: z.string(),
  projectId: z.string(),
  planId: z.string(),
  personaId: z.string(),
  planName: z.string().nullable(),
  personaName: z.string().nullable(),
  status: ExecutionStatus,
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  actionCount: z.number(),
  navigationCount: z.number(),
  failureReason: z.string().nullable(),
  mode: z.enum(['live', 'mock']),
  /**
   * The emulation profile this run actually used.
   *
   * Null for executions recorded before device selection existed. The UI shows
   * those as "device not recorded" rather than assuming desktop - an assumed
   * viewport would silently corrupt every heatmap built from the run.
   */
  device: DeviceProfile.nullable(),
  createdAt: z.string(),
});
export type Execution = z.infer<typeof Execution>;

/* ------------------------------------------------------------------ *
 * Safe action vocabulary (ADR-0008)
 *
 * This is the COMPLETE set of operations the AI may propose. Raw
 * JavaScript execution and arbitrary URL navigation are deliberately
 * not representable in this type.
 * ------------------------------------------------------------------ */

export const SafeAction = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('click'),
    x: z.number().min(0).max(4000),
    y: z.number().min(0).max(4000),
    label: z.string().max(200),
    reasoning: z.string().max(500).optional(),
  }),
  z.object({
    type: z.literal('clickElement'),
    /** Index into the discovered-element list - never a raw selector from the model. */
    elementIndex: z.number().int().min(0).max(500),
    label: z.string().max(200),
    reasoning: z.string().max(500).optional(),
  }),
  z.object({
    type: z.literal('navigateToNode'),
    /** Must already exist in the graph; validated before execution. */
    nodeId: z.string().max(64),
    reasoning: z.string().max(500).optional(),
  }),
  z.object({
    type: z.literal('scroll'),
    direction: z.enum(['up', 'down']),
    amount: z.number().min(0).max(5000),
    reasoning: z.string().max(500).optional(),
  }),
  z.object({
    type: z.literal('type'),
    elementIndex: z.number().int().min(0).max(500),
    /** Synthetic test data only - screened before use. */
    text: z.string().max(200),
    reasoning: z.string().max(500).optional(),
  }),
  z.object({ type: z.literal('wait'), ms: z.number().min(0).max(15000) }),
  z.object({ type: z.literal('back'), reasoning: z.string().max(500).optional() }),
  z.object({ type: z.literal('done'), reason: z.string().max(500) }),
]);
export type SafeAction = z.infer<typeof SafeAction>;

export const AiActionProposal = z.object({
  action: SafeAction,
  observation: z.string().max(2000),
  confidence: z.number().min(0).max(1),
});
export type AiActionProposal = z.infer<typeof AiActionProposal>;

/* ------------------------------------------------------------------ *
 * Evidence
 * ------------------------------------------------------------------ */

export const ScreenshotStatus = z.enum(['valid', 'failed']);
export type ScreenshotStatus = z.infer<typeof ScreenshotStatus>;

export const ScreenshotVerification = z.object({
  fileExists: z.boolean(),
  readable: z.boolean(),
  nonBlank: z.boolean(),
  blanknessScore: z.number(),
  nodeMatches: z.boolean().nullable(),
  settled: z.boolean(),
  /** Rendered, but with very little content - evidence is thin, not absent. */
  sparse: z.boolean().default(false),
});
export type ScreenshotVerification = z.infer<typeof ScreenshotVerification>;

export const Screenshot = z.object({
  id: z.string(),
  projectId: z.string(),
  executionId: z.string().nullable(),
  screenId: z.string().nullable(),
  uiStateId: z.string().nullable(),
  nodeId: z.string().nullable(),
  screenName: z.string().nullable(),
  actionLabel: z.string().nullable(),
  path: z.string(),
  width: z.number(),
  height: z.number(),
  bytes: z.number(),
  capturedAt: z.string(),
  status: ScreenshotStatus,
  verification: ScreenshotVerification.nullable(),
  failureReason: UnreachableReason.nullable(),
  /** ADR-0003: figma-render is a design reference, never browser evidence. */
  source: z.enum(['browser', 'figma-render']),
  /**
   * Device context, so an overlay can tell whether this image and a set of
   * recorded coordinates describe the same geometry.
   *
   * `width`/`height` above are the CSS VIEWPORT size. The PNG itself is
   * `width * deviceScaleFactor` pixels across, which is why overlays normalize
   * to fractions rather than pixels. Null on screenshots captured before device
   * profiles existed.
   */
  deviceId: z.string().nullable().default(null),
  deviceScaleFactor: z.number().nullable().default(null),
});
export type Screenshot = z.infer<typeof Screenshot>;

export const VideoStatus = z.enum(['complete', 'incomplete', 'failed']);
export type VideoStatus = z.infer<typeof VideoStatus>;

export const VideoRecord = z.object({
  id: z.string(),
  executionId: z.string(),
  path: z.string(),
  bytes: z.number(),
  durationMs: z.number().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  status: VideoStatus,
  failureReason: z.string().nullable(),
  /**
   * Milliseconds between the execution's monotonic clock origin and the first
   * recorded video frame.
   *
   * Playwright starts recording when the page is created, which is strictly
   * after the execution record is opened. Without this offset every marker in
   * the recap player is early by the browser's startup time. Null for
   * recordings made before this was tracked; the player then falls back to the
   * raw action offset and labels the timing as approximate.
   */
  startOffsetMs: z.number().int().nullable().default(null),
  /** Emulation profile the recording was made under. */
  deviceId: z.string().nullable().default(null),
  createdAt: z.string(),
});
export type VideoRecord = z.infer<typeof VideoRecord>;

/* ------------------------------------------------------------------ *
 * UX findings
 * ------------------------------------------------------------------ */

export const Severity = z.enum(['critical', 'high', 'medium', 'low', 'info']);
export type Severity = z.infer<typeof Severity>;

export const FindingCategory = z.enum([
  'navigation-clarity',
  'visual-hierarchy',
  'discoverability',
  'content-clarity',
  'form-usability',
  'interaction-feedback',
  'visual-consistency',
  'accessibility',
  'cognitive-friction',
  'unnecessary-steps',
  'confusing-labels',
  'journey-interruption',
]);
export type FindingCategory = z.infer<typeof FindingCategory>;

/**
 * Section 12: observed issues must be distinguishable from heuristics.
 * A finding with no linked screenshot cannot be stored as `observed`.
 */
export const EvidenceType = z.enum([
  'observed',
  'potential',
  'heuristic',
  'needs-human-validation',
]);
export type EvidenceType = z.infer<typeof EvidenceType>;

export const Finding = z.object({
  id: z.string(),
  projectId: z.string(),
  executionId: z.string().nullable(),
  title: z.string(),
  description: z.string(),
  severity: Severity,
  category: FindingCategory,
  screenId: z.string().nullable(),
  screenName: z.string().nullable(),
  screenshotId: z.string().nullable(),
  actionId: z.string().nullable(),
  personaImpact: z.string(),
  recommendation: z.string(),
  confidence: z.number().min(0).max(1),
  evidenceType: EvidenceType,
  generatedByModel: z.string().nullable(),
  createdAt: z.string(),
});
export type Finding = z.infer<typeof Finding>;

/** AI output contract for UX analysis. */
export const GeneratedFinding = z.object({
  title: z.string().max(200),
  description: z.string().max(2000),
  severity: Severity,
  category: FindingCategory,
  /** Must reference a screen actually present in the evidence bundle. */
  screenNodeId: z.string().nullable().optional(),
  personaImpact: z.string().max(1000),
  recommendation: z.string().max(1000),
  confidence: z.number().min(0).max(1),
  evidenceType: EvidenceType,
});
export type GeneratedFinding = z.infer<typeof GeneratedFinding>;

export const GeneratedFindingBatch = z.object({
  findings: z.array(GeneratedFinding).max(25),
  overallObservation: z.string().max(2000).optional(),
});
export type GeneratedFindingBatch = z.infer<typeof GeneratedFindingBatch>;

/* ------------------------------------------------------------------ *
 * Screen analysis (vision over a single screenshot)
 * ------------------------------------------------------------------ */

export const ScreenAnalysis = z.object({
  screenPurpose: z.string().max(600),
  primaryElements: z.array(z.string().max(160)).max(25),
  interactiveElements: z.array(z.string().max(160)).max(25),
  visualHierarchyNotes: z.string().max(800),
  potentialIssues: z.array(z.string().max(300)).max(12),
});
export type ScreenAnalysis = z.infer<typeof ScreenAnalysis>;
