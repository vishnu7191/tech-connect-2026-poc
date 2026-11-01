import { nanoid } from 'nanoid';
import type {
  ClassificationSignal,
  CoverageMetric,
  DiscoveryWarning,
  EntryPoint,
  Execution,
  ExecutionAction,
  Finding,
  GraphEdge,
  Job,
  Persona,
  Project,
  Screen,
  Screenshot,
  TestPlan,
  TestStep,
  VideoRecord,
} from '@lenz/shared';
import { fromBool, fromJson, getDb, nowIso, toBool, toJson, type Db } from './index.js';

export const newId = (prefix: string): string => `${prefix}_${nanoid(12)}`;

/* ------------------------------------------------------------------ *
 * Row mappers - the single place SQLite conventions become domain types
 * ------------------------------------------------------------------ */

type Row = Record<string, any>;

const mapProject = (r: Row): Project => ({
  id: r.id,
  name: r.name,
  description: r.description,
  figmaUrl: r.figma_url,
  urlKind: r.url_kind,
  fileKey: r.file_key,
  startNodeId: r.start_node_id,
  status: r.status,
  autoApprovePlans: toBool(r.auto_approve_plans),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const mapScreen = (r: Row): Screen => ({
  id: r.id,
  projectId: r.project_id,
  nodeId: r.node_id,
  name: r.name,
  canvasId: r.canvas_id,
  canvasName: r.canvas_name,
  nodeType: r.node_type,
  classification: r.classification,
  classificationScore: r.classification_score,
  classificationSignals: fromJson<ClassificationSignal[]>(r.classification_signals, []),
  deviceClass: r.device_class,
  width: r.width,
  height: r.height,
  absX: r.abs_x,
  absY: r.abs_y,
  isEntryPoint: toBool(r.is_entry_point),
  reachable: toBool(r.reachable),
  unreachableReason: r.unreachable_reason,
  figmaImageUrl: r.figma_image_url,
});

const mapEdge = (r: Row): GraphEdge => ({
  id: r.id,
  projectId: r.project_id,
  fromScreenId: r.from_node_id,
  toScreenId: r.to_node_id,
  kind: r.kind,
  figmaNavigation: r.figma_navigation,
  trigger: r.trigger,
  sourceNodeId: r.source_node_id,
  sourceNodeName: r.source_node_name,
  sourceAbsX: r.source_abs_x,
  sourceAbsY: r.source_abs_y,
  sourceAbsW: r.source_abs_w,
  sourceAbsH: r.source_abs_h,
  supported: toBool(r.supported),
  unsupportedReason: r.unsupported_reason,
});

const mapEntryPoint = (r: Row): EntryPoint => ({
  id: r.id,
  projectId: r.project_id,
  screenId: r.screen_id ?? r.node_id,
  nodeId: r.node_id,
  screenName: r.screen_name,
  kind: r.kind,
  source: r.source,
  flowName: r.flow_name,
  rank: r.rank,
  score: r.score,
  signals: fromJson<ClassificationSignal[]>(r.signals, []),
  selected: toBool(r.selected),
});

const mapPersona = (r: Row): Persona => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  ageRange: r.age_range,
  background: r.background,
  technicalProficiency: r.technical_proficiency,
  digitalExperience: r.digital_experience,
  goals: fromJson<string[]>(r.goals, []),
  motivations: fromJson<string[]>(r.motivations, []),
  frustrations: fromJson<string[]>(r.frustrations, []),
  accessibilityNeeds: fromJson<string[]>(r.accessibility_needs, []),
  behavioralCharacteristics: fromJson<string[]>(r.behavioral_characteristics, []),
  expectations: fromJson<string[]>(r.expectations, []),
  origin: r.origin,
  generatedByModel: r.generated_by_model,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const mapStep = (r: Row): TestStep => ({
  id: r.id,
  planId: r.plan_id,
  index: r.step_index,
  description: r.description,
  actionType: r.action_type,
  targetHint: r.target_hint,
  expectedOutcome: r.expected_outcome,
  expectedScreenId: r.expected_node_id,
  expectedScreenName: r.expected_screen_name,
});

const mapPlan = (r: Row, steps: TestStep[]): TestPlan => ({
  id: r.id,
  projectId: r.project_id,
  personaId: r.persona_id,
  name: r.name,
  objective: r.objective,
  scenario: r.scenario,
  preconditions: r.preconditions,
  startScreenId: r.start_node_id,
  startScreenName: r.start_screen_name,
  screensInvolved: fromJson<string[]>(r.screens_involved, []),
  successCriteria: fromJson<string[]>(r.success_criteria, []),
  frictionPoints: fromJson<string[]>(r.friction_points, []),
  status: r.status,
  approvedAt: r.approved_at,
  origin: r.origin,
  generatedByModel: r.generated_by_model,
  steps,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const mapExecution = (r: Row): Execution => ({
  id: r.id,
  projectId: r.project_id,
  planId: r.plan_id,
  personaId: r.persona_id,
  planName: r.plan_name ?? null,
  personaName: r.persona_name ?? null,
  status: r.status,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  actionCount: r.action_count,
  navigationCount: r.navigation_count,
  failureReason: r.failure_reason,
  mode: r.mode,
  createdAt: r.created_at,
});

const mapAction = (r: Row): ExecutionAction => ({
  id: r.id,
  executionId: r.execution_id,
  index: r.action_index,
  stepId: r.step_id,
  description: r.description,
  actionType: r.action_type,
  screenId: r.screen_node_id,
  screenName: r.screen_name,
  expectedDestinationNode: r.expected_destination_node,
  actualDestinationNode: r.actual_destination_node,
  verdict: r.verdict,
  screenshotId: r.screenshot_id,
  timestamp: r.timestamp,
  offsetMs: r.offset_ms,
  result: r.result,
  error: r.error,
  decidedBy: r.decided_by,
});

const mapScreenshot = (r: Row): Screenshot => ({
  id: r.id,
  projectId: r.project_id,
  executionId: r.execution_id,
  screenId: r.screen_id,
  uiStateId: r.ui_state_id,
  nodeId: r.node_id,
  screenName: r.screen_name,
  actionLabel: r.action_label,
  path: r.path,
  width: r.width,
  height: r.height,
  bytes: r.bytes,
  capturedAt: r.captured_at,
  status: r.status,
  verification: fromJson(r.verification, null),
  failureReason: r.failure_reason,
  source: r.source,
});

const mapVideo = (r: Row): VideoRecord => ({
  id: r.id,
  executionId: r.execution_id,
  path: r.path,
  bytes: r.bytes,
  durationMs: r.duration_ms,
  width: r.width,
  height: r.height,
  status: r.status,
  failureReason: r.failure_reason,
  createdAt: r.created_at,
});

const mapFinding = (r: Row): Finding => ({
  id: r.id,
  projectId: r.project_id,
  executionId: r.execution_id,
  title: r.title,
  description: r.description,
  severity: r.severity,
  category: r.category,
  screenId: r.screen_id,
  screenName: r.screen_name,
  screenshotId: r.screenshot_id,
  actionId: r.action_id,
  personaImpact: r.persona_impact,
  recommendation: r.recommendation,
  confidence: r.confidence,
  evidenceType: r.evidence_type,
  generatedByModel: r.generated_by_model,
  createdAt: r.created_at,
});

const mapJob = (r: Row): Job => ({
  id: r.id,
  projectId: r.project_id,
  kind: r.kind,
  status: r.status,
  progress: r.progress,
  message: r.message,
  phase: r.phase,
  error: r.error,
  cancelRequested: toBool(r.cancel_requested),
  result: fromJson(r.result, null),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/* ------------------------------------------------------------------ *
 * Repositories
 * ------------------------------------------------------------------ */

export class Repositories {
  constructor(private readonly db: Db) {}

  /* ---------------- projects ---------------- */

  createProject(input: {
    name: string;
    description: string | null;
    figmaUrl: string;
    urlKind: string;
    fileKey: string;
    fileName: string | null;
    startNodeId: string | null;
  }): Project {
    const id = newId('prj');
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO projects (id,name,description,figma_url,url_kind,file_key,file_name,start_node_id,status,auto_approve_plans,created_at,updated_at)
         VALUES (@id,@name,@description,@figmaUrl,@urlKind,@fileKey,@fileName,@startNodeId,'created',0,@ts,@ts)`,
      )
      .run({ id, ...input, ts });
    return this.getProject(id)!;
  }

  getProject(id: string): Project | null {
    const r = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined;
    return r ? mapProject(r) : null;
  }

  listProjects(): Project[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as Row[]).map(
      mapProject,
    );
  }

  updateProject(id: string, patch: Partial<{ name: string; description: string | null; status: string; autoApprovePlans: boolean }>): void {
    const sets: string[] = [];
    const params: Row = { id, ts: nowIso() };
    if (patch.name !== undefined) { sets.push('name = @name'); params.name = patch.name; }
    if (patch.description !== undefined) { sets.push('description = @description'); params.description = patch.description; }
    if (patch.status !== undefined) { sets.push('status = @status'); params.status = patch.status; }
    if (patch.autoApprovePlans !== undefined) {
      sets.push('auto_approve_plans = @autoApprovePlans');
      params.autoApprovePlans = fromBool(patch.autoApprovePlans);
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE projects SET ${sets.join(', ')}, updated_at = @ts WHERE id = @id`).run(params);
  }

  deleteProject(id: string): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }

  /* ---------------- screens & graph ---------------- */

  replaceScreens(projectId: string, screens: Array<Omit<Screen, 'id' | 'projectId'>>): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM screens WHERE project_id = ?').run(projectId);
      const stmt = this.db.prepare(
        `INSERT INTO screens (id,project_id,node_id,name,canvas_id,canvas_name,node_type,classification,
          classification_score,classification_signals,device_class,width,height,abs_x,abs_y,
          is_entry_point,reachable,unreachable_reason,figma_image_url)
         VALUES (@id,@projectId,@nodeId,@name,@canvasId,@canvasName,@nodeType,@classification,
          @classificationScore,@classificationSignals,@deviceClass,@width,@height,@absX,@absY,
          @isEntryPoint,@reachable,@unreachableReason,@figmaImageUrl)`,
      );
      for (const s of screens) {
        stmt.run({
          id: newId('scr'),
          projectId,
          ...s,
          classificationSignals: toJson(s.classificationSignals),
          isEntryPoint: fromBool(s.isEntryPoint),
          reachable: fromBool(s.reachable),
        });
      }
    });
    tx();
  }

  listScreens(projectId: string, filter: { classification?: string; reachable?: boolean } = {}): Screen[] {
    let sql = 'SELECT * FROM screens WHERE project_id = ?';
    const params: unknown[] = [projectId];
    if (filter.classification) { sql += ' AND classification = ?'; params.push(filter.classification); }
    if (filter.reachable !== undefined) { sql += ' AND reachable = ?'; params.push(fromBool(filter.reachable)); }
    sql += ' ORDER BY canvas_name, abs_y, abs_x';
    return (this.db.prepare(sql).all(...params) as Row[]).map(mapScreen);
  }

  getScreenByNodeId(projectId: string, nodeId: string): Screen | null {
    const r = this.db
      .prepare('SELECT * FROM screens WHERE project_id = ? AND node_id = ?')
      .get(projectId, nodeId) as Row | undefined;
    return r ? mapScreen(r) : null;
  }

  setScreenImage(projectId: string, nodeId: string, url: string | null): void {
    this.db
      .prepare('UPDATE screens SET figma_image_url = ? WHERE project_id = ? AND node_id = ?')
      .run(url, projectId, nodeId);
  }

  replaceEdges(projectId: string, edges: Array<Omit<GraphEdge, 'id' | 'projectId'>>): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM graph_edges WHERE project_id = ?').run(projectId);
      const stmt = this.db.prepare(
        `INSERT INTO graph_edges (id,project_id,from_node_id,to_node_id,kind,figma_navigation,trigger,
          source_node_id,source_node_name,source_abs_x,source_abs_y,source_abs_w,source_abs_h,supported,unsupported_reason)
         VALUES (@id,@projectId,@fromScreenId,@toScreenId,@kind,@figmaNavigation,@trigger,
          @sourceNodeId,@sourceNodeName,@sourceAbsX,@sourceAbsY,@sourceAbsW,@sourceAbsH,@supported,@unsupportedReason)`,
      );
      for (const e of edges) {
        stmt.run({ id: newId('edg'), projectId, ...e, supported: fromBool(e.supported) });
      }
    });
    tx();
  }

  listEdges(projectId: string, kind?: string): GraphEdge[] {
    const sql = kind
      ? 'SELECT * FROM graph_edges WHERE project_id = ? AND kind = ?'
      : 'SELECT * FROM graph_edges WHERE project_id = ?';
    const params = kind ? [projectId, kind] : [projectId];
    return (this.db.prepare(sql).all(...params) as Row[]).map(mapEdge);
  }

  replaceEntryPoints(projectId: string, entries: Array<Omit<EntryPoint, 'id' | 'projectId'>>): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM entry_points WHERE project_id = ?').run(projectId);
      const stmt = this.db.prepare(
        `INSERT INTO entry_points (id,project_id,screen_id,node_id,screen_name,kind,source,flow_name,rank,score,signals,selected)
         VALUES (@id,@projectId,@screenId,@nodeId,@screenName,@kind,@source,@flowName,@rank,@score,@signals,@selected)`,
      );
      for (const e of entries) {
        stmt.run({
          id: newId('ent'),
          projectId,
          ...e,
          signals: toJson(e.signals),
          selected: fromBool(e.selected),
        });
      }
    });
    tx();
  }

  listEntryPoints(projectId: string): EntryPoint[] {
    return (
      this.db.prepare('SELECT * FROM entry_points WHERE project_id = ? ORDER BY rank').all(projectId) as Row[]
    ).map(mapEntryPoint);
  }

  selectEntryPoints(projectId: string, nodeIds: string[]): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('UPDATE entry_points SET selected = 0 WHERE project_id = ?').run(projectId);
      const stmt = this.db.prepare(
        'UPDATE entry_points SET selected = 1 WHERE project_id = ? AND node_id = ?',
      );
      for (const n of nodeIds) stmt.run(projectId, n);
    });
    tx();
  }

  setScreenReachability(projectId: string, reachable: Set<string>, reasons: Map<string, string>): void {
    const tx = this.db.transaction(() => {
      const stmt = this.db.prepare(
        'UPDATE screens SET reachable = ?, unreachable_reason = ? WHERE project_id = ? AND node_id = ?',
      );
      for (const s of this.listScreens(projectId)) {
        const ok = reachable.has(s.nodeId);
        stmt.run(fromBool(ok), ok ? null : (reasons.get(s.nodeId) ?? 'no-incoming-navigate-edge'), projectId, s.nodeId);
      }
    });
    tx();
  }

  /* ---------------- discovery runs ---------------- */

  createDiscoveryRun(projectId: string, mode: string): string {
    const id = newId('dsc');
    this.db
      .prepare('INSERT INTO discovery_runs (id,project_id,mode,started_at) VALUES (?,?,?,?)')
      .run(id, projectId, mode, nowIso());
    return id;
  }

  finishDiscoveryRun(
    id: string,
    stats: {
      mode: string;
      screensDiscovered: number;
      componentsExcluded: number;
      ambiguousCount: number;
      screensReachable: number;
      disconnectedCount: number;
      interactionsFound: number;
      screenEdges: number;
      uiStateEdges: number;
      overlayEdges: number;
      unsupportedInteractions: number;
      confirmedEntryPoints: number;
      inferredEntryPoints: number;
      flowCount: number;
      warnings: DiscoveryWarning[];
    },
  ): void {
    this.db
      .prepare(
        `UPDATE discovery_runs SET mode=@mode, screens_discovered=@screensDiscovered, components_excluded=@componentsExcluded,
         ambiguous_count=@ambiguousCount, screens_reachable=@screensReachable, disconnected_count=@disconnectedCount,
         interactions_found=@interactionsFound, screen_edges=@screenEdges, ui_state_edges=@uiStateEdges,
         overlay_edges=@overlayEdges, unsupported_interactions=@unsupportedInteractions,
         confirmed_entry_points=@confirmedEntryPoints, inferred_entry_points=@inferredEntryPoints,
         flow_count=@flowCount, warnings=@warnings, finished_at=@finishedAt WHERE id=@id`,
      )
      .run({ id, ...stats, warnings: toJson(stats.warnings), finishedAt: nowIso() });
  }

  getLatestDiscoveryRun(projectId: string): Row | null {
    return (
      (this.db
        .prepare('SELECT * FROM discovery_runs WHERE project_id = ? ORDER BY started_at DESC LIMIT 1')
        .get(projectId) as Row | undefined) ?? null
    );
  }

  /* ---------------- personas ---------------- */

  createPersona(p: Omit<Persona, 'id' | 'createdAt' | 'updatedAt'>): Persona {
    const id = newId('per');
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO personas (id,project_id,name,age_range,background,technical_proficiency,digital_experience,
          goals,motivations,frustrations,accessibility_needs,behavioral_characteristics,expectations,origin,generated_by_model,created_at,updated_at)
         VALUES (@id,@projectId,@name,@ageRange,@background,@technicalProficiency,@digitalExperience,
          @goals,@motivations,@frustrations,@accessibilityNeeds,@behavioralCharacteristics,@expectations,@origin,@generatedByModel,@ts,@ts)`,
      )
      .run({
        id,
        ...p,
        goals: toJson(p.goals),
        motivations: toJson(p.motivations),
        frustrations: toJson(p.frustrations),
        accessibilityNeeds: toJson(p.accessibilityNeeds),
        behavioralCharacteristics: toJson(p.behavioralCharacteristics),
        expectations: toJson(p.expectations),
        ts,
      });
    return this.getPersona(id)!;
  }

  getPersona(id: string): Persona | null {
    const r = this.db.prepare('SELECT * FROM personas WHERE id = ?').get(id) as Row | undefined;
    return r ? mapPersona(r) : null;
  }

  listPersonas(projectId?: string): Persona[] {
    const sql = projectId
      ? 'SELECT * FROM personas WHERE project_id = ? OR project_id IS NULL ORDER BY created_at DESC'
      : 'SELECT * FROM personas ORDER BY created_at DESC';
    const rows = (projectId ? this.db.prepare(sql).all(projectId) : this.db.prepare(sql).all()) as Row[];
    return rows.map(mapPersona);
  }

  updatePersona(id: string, patch: Partial<Persona>): void {
    const cur = this.getPersona(id);
    if (!cur) return;
    const next = { ...cur, ...patch };
    this.db
      .prepare(
        `UPDATE personas SET name=@name, age_range=@ageRange, background=@background,
         technical_proficiency=@technicalProficiency, digital_experience=@digitalExperience,
         goals=@goals, motivations=@motivations, frustrations=@frustrations,
         accessibility_needs=@accessibilityNeeds, behavioral_characteristics=@behavioralCharacteristics,
         expectations=@expectations, updated_at=@ts WHERE id=@id`,
      )
      .run({
        id,
        name: next.name,
        ageRange: next.ageRange,
        background: next.background,
        technicalProficiency: next.technicalProficiency,
        digitalExperience: next.digitalExperience,
        goals: toJson(next.goals),
        motivations: toJson(next.motivations),
        frustrations: toJson(next.frustrations),
        accessibilityNeeds: toJson(next.accessibilityNeeds),
        behavioralCharacteristics: toJson(next.behavioralCharacteristics),
        expectations: toJson(next.expectations),
        ts: nowIso(),
      });
  }

  deletePersona(id: string): void {
    this.db.prepare('DELETE FROM personas WHERE id = ?').run(id);
  }

  /* ---------------- test plans ---------------- */

  createPlan(
    plan: Omit<TestPlan, 'id' | 'steps' | 'createdAt' | 'updatedAt'>,
    steps: Array<Omit<TestStep, 'id' | 'planId'>>,
  ): TestPlan {
    const id = newId('pln');
    const ts = nowIso();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO test_plans (id,project_id,persona_id,name,objective,scenario,preconditions,start_node_id,start_screen_name,
            screens_involved,success_criteria,friction_points,status,approved_at,origin,generated_by_model,created_at,updated_at)
           VALUES (@id,@projectId,@personaId,@name,@objective,@scenario,@preconditions,@startScreenId,@startScreenName,
            @screensInvolved,@successCriteria,@frictionPoints,@status,@approvedAt,@origin,@generatedByModel,@ts,@ts)`,
        )
        .run({
          id,
          ...plan,
          screensInvolved: toJson(plan.screensInvolved),
          successCriteria: toJson(plan.successCriteria),
          frictionPoints: toJson(plan.frictionPoints),
          ts,
        });
      this.insertSteps(id, steps);
    });
    tx();
    return this.getPlan(id)!;
  }

  private insertSteps(planId: string, steps: Array<Omit<TestStep, 'id' | 'planId'>>): void {
    const stmt = this.db.prepare(
      `INSERT INTO test_steps (id,plan_id,step_index,description,action_type,target_hint,expected_outcome,expected_node_id,expected_screen_name)
       VALUES (@id,@planId,@index,@description,@actionType,@targetHint,@expectedOutcome,@expectedScreenId,@expectedScreenName)`,
    );
    steps.forEach((s, i) => stmt.run({ id: newId('stp'), planId, ...s, index: s.index ?? i }));
  }

  getPlan(id: string): TestPlan | null {
    const r = this.db.prepare('SELECT * FROM test_plans WHERE id = ?').get(id) as Row | undefined;
    if (!r) return null;
    const steps = (
      this.db.prepare('SELECT * FROM test_steps WHERE plan_id = ? ORDER BY step_index').all(id) as Row[]
    ).map(mapStep);
    return mapPlan(r, steps);
  }

  listPlans(projectId: string): TestPlan[] {
    const rows = this.db
      .prepare('SELECT * FROM test_plans WHERE project_id = ? ORDER BY created_at DESC')
      .all(projectId) as Row[];
    return rows.map((r) => {
      const steps = (
        this.db.prepare('SELECT * FROM test_steps WHERE plan_id = ? ORDER BY step_index').all(r.id) as Row[]
      ).map(mapStep);
      return mapPlan(r, steps);
    });
  }

  updatePlan(id: string, patch: Partial<TestPlan>, steps?: Array<Omit<TestStep, 'id' | 'planId'>>): void {
    const cur = this.getPlan(id);
    if (!cur) return;
    const n = { ...cur, ...patch };
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE test_plans SET name=@name, objective=@objective, scenario=@scenario, preconditions=@preconditions,
           start_node_id=@startScreenId, start_screen_name=@startScreenName, screens_involved=@screensInvolved,
           success_criteria=@successCriteria, friction_points=@frictionPoints, status=@status,
           approved_at=@approvedAt, updated_at=@ts WHERE id=@id`,
        )
        .run({
          id,
          name: n.name,
          objective: n.objective,
          scenario: n.scenario,
          preconditions: n.preconditions,
          startScreenId: n.startScreenId,
          startScreenName: n.startScreenName,
          screensInvolved: toJson(n.screensInvolved),
          successCriteria: toJson(n.successCriteria),
          frictionPoints: toJson(n.frictionPoints),
          status: n.status,
          approvedAt: n.approvedAt,
          ts: nowIso(),
        });
      if (steps) {
        this.db.prepare('DELETE FROM test_steps WHERE plan_id = ?').run(id);
        this.insertSteps(id, steps);
      }
    });
    tx();
  }

  approvePlan(id: string): void {
    this.db
      .prepare("UPDATE test_plans SET status='approved', approved_at=?, updated_at=? WHERE id=?")
      .run(nowIso(), nowIso(), id);
  }

  /* ---------------- executions ---------------- */

  createExecution(projectId: string, planId: string, personaId: string, mode: 'live' | 'mock'): Execution {
    const id = newId('exe');
    this.db
      .prepare(
        `INSERT INTO executions (id,project_id,plan_id,persona_id,status,mode,created_at)
         VALUES (?,?,?,?,'queued',?,?)`,
      )
      .run(id, projectId, planId, personaId, mode, nowIso());
    return this.getExecution(id)!;
  }

  getExecution(id: string): Execution | null {
    const r = this.db
      .prepare(
        `SELECT e.*, p.name AS plan_name, pe.name AS persona_name
         FROM executions e
         LEFT JOIN test_plans p ON p.id = e.plan_id
         LEFT JOIN personas pe ON pe.id = e.persona_id
         WHERE e.id = ?`,
      )
      .get(id) as Row | undefined;
    return r ? mapExecution(r) : null;
  }

  listExecutions(projectId: string): Execution[] {
    const rows = this.db
      .prepare(
        `SELECT e.*, p.name AS plan_name, pe.name AS persona_name
         FROM executions e
         LEFT JOIN test_plans p ON p.id = e.plan_id
         LEFT JOIN personas pe ON pe.id = e.persona_id
         WHERE e.project_id = ? ORDER BY e.created_at DESC`,
      )
      .all(projectId) as Row[];
    return rows.map(mapExecution);
  }

  updateExecution(id: string, patch: Partial<Execution>): void {
    const sets: string[] = [];
    const params: Row = { id };
    const map: Record<string, string> = {
      status: 'status',
      startedAt: 'started_at',
      endedAt: 'ended_at',
      actionCount: 'action_count',
      navigationCount: 'navigation_count',
      failureReason: 'failure_reason',
    };
    for (const [k, col] of Object.entries(map)) {
      const v = (patch as Row)[k];
      if (v !== undefined) {
        sets.push(`${col} = @${k}`);
        params[k] = v;
      }
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE executions SET ${sets.join(', ')} WHERE id = @id`).run(params);
  }

  addAction(a: Omit<ExecutionAction, 'id'>): ExecutionAction {
    const id = newId('act');
    this.db
      .prepare(
        `INSERT INTO execution_actions (id,execution_id,action_index,step_id,description,action_type,screen_node_id,screen_name,
          expected_destination_node,actual_destination_node,verdict,screenshot_id,timestamp,offset_ms,result,error,decided_by)
         VALUES (@id,@executionId,@index,@stepId,@description,@actionType,@screenId,@screenName,
          @expectedDestinationNode,@actualDestinationNode,@verdict,@screenshotId,@timestamp,@offsetMs,@result,@error,@decidedBy)`,
      )
      .run({ id, ...a });
    return { id, ...a };
  }

  listActions(executionId: string): ExecutionAction[] {
    return (
      this.db
        .prepare('SELECT * FROM execution_actions WHERE execution_id = ? ORDER BY action_index')
        .all(executionId) as Row[]
    ).map(mapAction);
  }

  /* ---------------- evidence ---------------- */

  addScreenshot(s: Omit<Screenshot, 'id'>): Screenshot {
    const id = newId('shot');
    this.db
      .prepare(
        `INSERT INTO screenshots (id,project_id,execution_id,screen_id,ui_state_id,node_id,screen_name,action_label,
          path,width,height,bytes,captured_at,status,verification,failure_reason,source)
         VALUES (@id,@projectId,@executionId,@screenId,@uiStateId,@nodeId,@screenName,@actionLabel,
          @path,@width,@height,@bytes,@capturedAt,@status,@verification,@failureReason,@source)`,
      )
      .run({ id, ...s, verification: toJson(s.verification) });
    return { id, ...s };
  }

  listScreenshots(filter: { projectId?: string; executionId?: string; source?: string }): Screenshot[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.projectId) { where.push('project_id = ?'); params.push(filter.projectId); }
    if (filter.executionId) { where.push('execution_id = ?'); params.push(filter.executionId); }
    if (filter.source) { where.push('source = ?'); params.push(filter.source); }
    const sql = `SELECT * FROM screenshots${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY captured_at`;
    return (this.db.prepare(sql).all(...params) as Row[]).map(mapScreenshot);
  }

  getScreenshot(id: string): Screenshot | null {
    const r = this.db.prepare('SELECT * FROM screenshots WHERE id = ?').get(id) as Row | undefined;
    return r ? mapScreenshot(r) : null;
  }

  addVideo(v: Omit<VideoRecord, 'id'>): VideoRecord {
    const id = newId('vid');
    this.db
      .prepare(
        `INSERT INTO videos (id,execution_id,path,bytes,duration_ms,width,height,status,failure_reason,created_at)
         VALUES (@id,@executionId,@path,@bytes,@durationMs,@width,@height,@status,@failureReason,@createdAt)`,
      )
      .run({ id, ...v });
    return { id, ...v };
  }

  getVideoForExecution(executionId: string): VideoRecord | null {
    const r = this.db.prepare('SELECT * FROM videos WHERE execution_id = ?').get(executionId) as Row | undefined;
    return r ? mapVideo(r) : null;
  }

  /* ---------------- findings ---------------- */

  addFinding(f: Omit<Finding, 'id'>): Finding {
    const id = newId('fnd');
    this.db
      .prepare(
        `INSERT INTO findings (id,project_id,execution_id,title,description,severity,category,screen_id,screen_name,
          screenshot_id,action_id,persona_impact,recommendation,confidence,evidence_type,generated_by_model,created_at)
         VALUES (@id,@projectId,@executionId,@title,@description,@severity,@category,@screenId,@screenName,
          @screenshotId,@actionId,@personaImpact,@recommendation,@confidence,@evidenceType,@generatedByModel,@createdAt)`,
      )
      .run({ id, ...f });
    return { id, ...f };
  }

  listFindings(filter: { projectId?: string; executionId?: string }): Finding[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.projectId) { where.push('project_id = ?'); params.push(filter.projectId); }
    if (filter.executionId) { where.push('execution_id = ?'); params.push(filter.executionId); }
    const order = `ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, confidence DESC`;
    const sql = `SELECT * FROM findings${where.length ? ' WHERE ' + where.join(' AND ') : ''} ${order}`;
    return (this.db.prepare(sql).all(...params) as Row[]).map(mapFinding);
  }

  deleteFindingsForExecution(executionId: string): void {
    this.db.prepare('DELETE FROM findings WHERE execution_id = ?').run(executionId);
  }

  /* ---------------- coverage ---------------- */

  replaceCoverage(projectId: string, executionId: string | null, metrics: CoverageMetric[]): void {
    const tx = this.db.transaction(() => {
      if (executionId) {
        this.db.prepare('DELETE FROM coverage_snapshots WHERE project_id=? AND execution_id=?').run(projectId, executionId);
      } else {
        this.db.prepare('DELETE FROM coverage_snapshots WHERE project_id=? AND execution_id IS NULL').run(projectId);
      }
      const stmt = this.db.prepare(
        `INSERT INTO coverage_snapshots (id,project_id,execution_id,dimension,numerator,denominator,misses,excluded_count,note,computed_at)
         VALUES (@id,@projectId,@executionId,@dimension,@numerator,@denominator,@misses,@excludedCount,@note,@computedAt)`,
      );
      const computedAt = nowIso();
      for (const m of metrics) {
        stmt.run({
          id: newId('cov'),
          projectId,
          executionId,
          dimension: m.dimension,
          numerator: m.numerator,
          denominator: m.denominator,
          misses: toJson(m.misses),
          excludedCount: m.excludedCount,
          note: m.note,
          computedAt,
        });
      }
    });
    tx();
  }

  getCoverage(projectId: string, executionId?: string | null): CoverageMetric[] {
    const rows = (
      executionId
        ? this.db.prepare('SELECT * FROM coverage_snapshots WHERE project_id=? AND execution_id=?').all(projectId, executionId)
        : this.db.prepare('SELECT * FROM coverage_snapshots WHERE project_id=? AND execution_id IS NULL').all(projectId)
    ) as Row[];
    return rows.map((r) => ({
      dimension: r.dimension,
      numerator: r.numerator,
      denominator: r.denominator,
      percentage: r.denominator > 0 ? r.numerator / r.denominator : null,
      misses: fromJson(r.misses, []),
      excludedCount: r.excluded_count,
      note: r.note,
    }));
  }

  /* ---------------- jobs ---------------- */

  createJob(kind: string, projectId: string | null): Job {
    const id = newId('job');
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO jobs (id,project_id,kind,status,progress,message,created_at,updated_at)
         VALUES (?,?,?,'queued',0,'Queued',?,?)`,
      )
      .run(id, projectId, kind, ts, ts);
    return this.getJob(id)!;
  }

  getJob(id: string): Job | null {
    const r = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Row | undefined;
    return r ? mapJob(r) : null;
  }

  updateJob(id: string, patch: Partial<Job>): void {
    const sets: string[] = [];
    const params: Row = { id, ts: nowIso() };
    const map: Record<string, string> = {
      status: 'status', progress: 'progress', message: 'message',
      phase: 'phase', error: 'error',
    };
    for (const [k, col] of Object.entries(map)) {
      const v = (patch as Row)[k];
      if (v !== undefined) { sets.push(`${col} = @${k}`); params[k] = v; }
    }
    if (patch.cancelRequested !== undefined) {
      sets.push('cancel_requested = @cancelRequested');
      params.cancelRequested = fromBool(patch.cancelRequested);
    }
    if (patch.result !== undefined) { sets.push('result = @result'); params.result = toJson(patch.result); }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE jobs SET ${sets.join(', ')}, updated_at = @ts WHERE id = @id`).run(params);
  }

  listJobs(projectId?: string): Job[] {
    const sql = projectId
      ? 'SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 50'
      : 'SELECT * FROM jobs ORDER BY created_at DESC LIMIT 50';
    const rows = (projectId ? this.db.prepare(sql).all(projectId) : this.db.prepare(sql).all()) as Row[];
    return rows.map(mapJob);
  }

  /* ---------------- experiments ---------------- */

  createExperiment(task: string, prompt: string, projectId: string | null, screenshotId: string | null): string {
    const id = newId('exp');
    this.db
      .prepare('INSERT INTO experiments (id,project_id,task,prompt,screenshot_id,status,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, projectId, task, prompt, screenshotId, 'queued', nowIso());
    return id;
  }

  setExperimentStatus(id: string, status: string): void {
    this.db.prepare('UPDATE experiments SET status = ? WHERE id = ?').run(status, id);
  }

  addExperimentResult(r: {
    experimentId: string; providerId: string; modelId: string;
    latencyMs: number | null; promptTokens: number | null; completionTokens: number | null;
    reasoningTokens: number | null; estimatedCost: number | null; structuredValid: boolean | null;
    repairAttempts: number | null; output: unknown; rawContent: string | null; error: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO experiment_results (id,experiment_id,provider_id,model_id,latency_ms,prompt_tokens,completion_tokens,
          reasoning_tokens,estimated_cost,structured_valid,repair_attempts,output,raw_content,error)
         VALUES (@id,@experimentId,@providerId,@modelId,@latencyMs,@promptTokens,@completionTokens,
          @reasoningTokens,@estimatedCost,@structuredValid,@repairAttempts,@output,@rawContent,@error)`,
      )
      .run({
        id: newId('exr'),
        ...r,
        structuredValid: r.structuredValid === null ? null : fromBool(r.structuredValid),
        output: toJson(r.output),
      });
  }

  getExperiment(id: string): Row | null {
    const exp = this.db.prepare('SELECT * FROM experiments WHERE id = ?').get(id) as Row | undefined;
    if (!exp) return null;
    const results = this.db
      .prepare('SELECT * FROM experiment_results WHERE experiment_id = ?')
      .all(id) as Row[];
    return {
      id: exp.id,
      projectId: exp.project_id,
      task: exp.task,
      prompt: exp.prompt,
      screenshotId: exp.screenshot_id,
      status: exp.status,
      createdAt: exp.created_at,
      results: results.map((r) => ({
        id: r.id,
        experimentId: r.experiment_id,
        providerId: r.provider_id,
        modelId: r.model_id,
        latencyMs: r.latency_ms,
        promptTokens: r.prompt_tokens,
        completionTokens: r.completion_tokens,
        reasoningTokens: r.reasoning_tokens,
        estimatedCost: r.estimated_cost,
        structuredValid: r.structured_valid === null ? null : toBool(r.structured_valid),
        repairAttempts: r.repair_attempts,
        output: fromJson(r.output, null),
        rawContent: r.raw_content,
        error: r.error,
        humanRating: r.human_rating,
        humanNotes: r.human_notes,
      })),
    };
  }

  listExperiments(): Row[] {
    const rows = this.db.prepare('SELECT * FROM experiments ORDER BY created_at DESC LIMIT 50').all() as Row[];
    return rows.map((r) => this.getExperiment(r.id)!);
  }

  rateExperimentResult(resultId: string, rating: number, notes: string | null): void {
    this.db
      .prepare('UPDATE experiment_results SET human_rating = ?, human_notes = ? WHERE id = ?')
      .run(rating, notes, resultId);
  }

  /* ---------------- dashboard ---------------- */

  dashboardStats(): Record<string, number> {
    const one = (sql: string): number => (this.db.prepare(sql).get() as Row).c as number;
    return {
      projects: one('SELECT COUNT(*) c FROM projects'),
      screens: one("SELECT COUNT(*) c FROM screens WHERE classification != 'component'"),
      executions: one('SELECT COUNT(*) c FROM executions'),
      executionsSucceeded: one("SELECT COUNT(*) c FROM executions WHERE status='succeeded'"),
      executionsFailed: one("SELECT COUNT(*) c FROM executions WHERE status='failed'"),
      findings: one('SELECT COUNT(*) c FROM findings'),
      personas: one('SELECT COUNT(*) c FROM personas'),
      screenshots: one("SELECT COUNT(*) c FROM screenshots WHERE source='browser' AND status='valid'"),
    };
  }
}

let repos: Repositories | null = null;
export function getRepositories(db?: Db): Repositories {
  if (db) return new Repositories(db);
  // getDb() creates the data directory on first use, so this stays lazy.
  if (!repos) repos = new Repositories(getDb());
  return repos;
}
export function resetRepositoriesForTests(): void {
  repos = null;
}
