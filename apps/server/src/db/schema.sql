-- Lenz schema. Forward-only migrations, applied in order at startup.
-- Enum-like columns are TEXT and validated by Zod at the repository boundary,
-- so the database schema and the TypeScript unions cannot drift.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  description       TEXT,
  figma_url         TEXT NOT NULL,
  url_kind          TEXT NOT NULL,
  file_key          TEXT NOT NULL,
  file_name         TEXT,
  start_node_id     TEXT,
  status            TEXT NOT NULL DEFAULT 'created',
  auto_approve_plans INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS screens (
  id                      TEXT PRIMARY KEY,
  project_id              TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  node_id                 TEXT NOT NULL,
  name                    TEXT NOT NULL,
  canvas_id               TEXT NOT NULL,
  canvas_name             TEXT NOT NULL,
  node_type               TEXT NOT NULL,
  classification          TEXT NOT NULL,
  classification_score    REAL NOT NULL DEFAULT 0,
  classification_signals  TEXT NOT NULL DEFAULT '[]',
  device_class            TEXT NOT NULL DEFAULT 'unknown',
  width                   REAL NOT NULL DEFAULT 0,
  height                  REAL NOT NULL DEFAULT 0,
  abs_x                   REAL NOT NULL DEFAULT 0,
  abs_y                   REAL NOT NULL DEFAULT 0,
  is_entry_point          INTEGER NOT NULL DEFAULT 0,
  reachable               INTEGER NOT NULL DEFAULT 0,
  unreachable_reason      TEXT,
  figma_image_url         TEXT,
  UNIQUE (project_id, node_id)
);
CREATE INDEX IF NOT EXISTS idx_screens_project ON screens(project_id);
-- Hot path: destination verification looks up a node id during execution.
CREATE INDEX IF NOT EXISTS idx_screens_project_node ON screens(project_id, node_id);

CREATE TABLE IF NOT EXISTS graph_edges (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_node_id        TEXT NOT NULL,
  to_node_id          TEXT NOT NULL,
  kind                TEXT NOT NULL,
  figma_navigation    TEXT NOT NULL,
  trigger             TEXT NOT NULL,
  source_node_id      TEXT NOT NULL,
  source_node_name    TEXT NOT NULL,
  source_abs_x        REAL,
  source_abs_y        REAL,
  source_abs_w        REAL,
  source_abs_h        REAL,
  supported           INTEGER NOT NULL DEFAULT 1,
  unsupported_reason  TEXT
);
CREATE INDEX IF NOT EXISTS idx_edges_project ON graph_edges(project_id);
-- Graph traversal always filters by kind (ADR-0001).
CREATE INDEX IF NOT EXISTS idx_edges_project_kind ON graph_edges(project_id, kind);
CREATE INDEX IF NOT EXISTS idx_edges_from ON graph_edges(project_id, from_node_id);

CREATE TABLE IF NOT EXISTS ui_states (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  screen_id     TEXT,
  signature     TEXT NOT NULL,
  label         TEXT NOT NULL,
  kind          TEXT NOT NULL,
  discovered_by TEXT NOT NULL,
  UNIQUE (project_id, signature)
);
CREATE INDEX IF NOT EXISTS idx_uistates_project ON ui_states(project_id);

CREATE TABLE IF NOT EXISTS entry_points (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  screen_id   TEXT,
  node_id     TEXT NOT NULL,
  screen_name TEXT NOT NULL,
  kind        TEXT NOT NULL,
  source      TEXT NOT NULL,
  flow_name   TEXT,
  rank        INTEGER NOT NULL DEFAULT 0,
  score       REAL NOT NULL DEFAULT 0,
  signals     TEXT NOT NULL DEFAULT '[]',
  selected    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (project_id, node_id)
);
CREATE INDEX IF NOT EXISTS idx_entrypoints_project ON entry_points(project_id);

CREATE TABLE IF NOT EXISTS discovery_runs (
  id                       TEXT PRIMARY KEY,
  project_id               TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  mode                     TEXT NOT NULL,
  screens_discovered       INTEGER NOT NULL DEFAULT 0,
  components_excluded      INTEGER NOT NULL DEFAULT 0,
  ambiguous_count          INTEGER NOT NULL DEFAULT 0,
  screens_reachable        INTEGER NOT NULL DEFAULT 0,
  disconnected_count       INTEGER NOT NULL DEFAULT 0,
  interactions_found       INTEGER NOT NULL DEFAULT 0,
  screen_edges             INTEGER NOT NULL DEFAULT 0,
  ui_state_edges           INTEGER NOT NULL DEFAULT 0,
  overlay_edges            INTEGER NOT NULL DEFAULT 0,
  unsupported_interactions INTEGER NOT NULL DEFAULT 0,
  confirmed_entry_points   INTEGER NOT NULL DEFAULT 0,
  inferred_entry_points    INTEGER NOT NULL DEFAULT 0,
  flow_count               INTEGER NOT NULL DEFAULT 0,
  warnings                 TEXT NOT NULL DEFAULT '[]',
  started_at               TEXT NOT NULL,
  finished_at              TEXT
);
CREATE INDEX IF NOT EXISTS idx_discovery_project ON discovery_runs(project_id);

CREATE TABLE IF NOT EXISTS personas (
  id                         TEXT PRIMARY KEY,
  project_id                 TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name                       TEXT NOT NULL,
  age_range                  TEXT,
  background                 TEXT NOT NULL DEFAULT '',
  technical_proficiency      TEXT NOT NULL DEFAULT 'medium',
  digital_experience         TEXT NOT NULL DEFAULT '',
  goals                      TEXT NOT NULL DEFAULT '[]',
  motivations                TEXT NOT NULL DEFAULT '[]',
  frustrations               TEXT NOT NULL DEFAULT '[]',
  accessibility_needs        TEXT NOT NULL DEFAULT '[]',
  behavioral_characteristics TEXT NOT NULL DEFAULT '[]',
  expectations               TEXT NOT NULL DEFAULT '[]',
  origin                     TEXT NOT NULL DEFAULT 'manual',
  generated_by_model         TEXT,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_personas_project ON personas(project_id);

CREATE TABLE IF NOT EXISTS test_plans (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  persona_id         TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  objective          TEXT NOT NULL DEFAULT '',
  scenario           TEXT NOT NULL DEFAULT '',
  preconditions      TEXT,
  start_node_id      TEXT,
  start_screen_name  TEXT,
  screens_involved   TEXT NOT NULL DEFAULT '[]',
  success_criteria   TEXT NOT NULL DEFAULT '[]',
  friction_points    TEXT NOT NULL DEFAULT '[]',
  status             TEXT NOT NULL DEFAULT 'draft',
  approved_at        TEXT,
  origin             TEXT NOT NULL DEFAULT 'manual',
  generated_by_model TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plans_project ON test_plans(project_id);

CREATE TABLE IF NOT EXISTS test_steps (
  id                  TEXT PRIMARY KEY,
  plan_id             TEXT NOT NULL REFERENCES test_plans(id) ON DELETE CASCADE,
  step_index          INTEGER NOT NULL,
  description         TEXT NOT NULL,
  action_type         TEXT NOT NULL,
  target_hint         TEXT,
  expected_outcome    TEXT NOT NULL DEFAULT '',
  expected_node_id    TEXT,
  expected_screen_name TEXT
);
CREATE INDEX IF NOT EXISTS idx_steps_plan ON test_steps(plan_id);

CREATE TABLE IF NOT EXISTS executions (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  plan_id          TEXT NOT NULL REFERENCES test_plans(id) ON DELETE CASCADE,
  persona_id       TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  status           TEXT NOT NULL DEFAULT 'queued',
  started_at       TEXT,
  ended_at         TEXT,
  action_count     INTEGER NOT NULL DEFAULT 0,
  navigation_count INTEGER NOT NULL DEFAULT 0,
  failure_reason   TEXT,
  mode             TEXT NOT NULL DEFAULT 'live',
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_executions_project ON executions(project_id);
CREATE INDEX IF NOT EXISTS idx_executions_plan ON executions(plan_id);

CREATE TABLE IF NOT EXISTS execution_actions (
  id                        TEXT PRIMARY KEY,
  execution_id              TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  action_index              INTEGER NOT NULL,
  step_id                   TEXT,
  description               TEXT NOT NULL,
  action_type               TEXT NOT NULL,
  screen_node_id            TEXT,
  screen_name               TEXT,
  expected_destination_node TEXT,
  actual_destination_node   TEXT,
  verdict                   TEXT NOT NULL DEFAULT 'not-applicable',
  screenshot_id             TEXT,
  timestamp                 TEXT NOT NULL,
  offset_ms                 INTEGER NOT NULL DEFAULT 0,
  result                    TEXT NOT NULL DEFAULT 'ok',
  error                     TEXT,
  decided_by                TEXT NOT NULL DEFAULT 'plan-step'
);
CREATE INDEX IF NOT EXISTS idx_actions_execution ON execution_actions(execution_id);

CREATE TABLE IF NOT EXISTS screenshots (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  execution_id   TEXT,
  screen_id      TEXT,
  ui_state_id    TEXT,
  node_id        TEXT,
  screen_name    TEXT,
  action_label   TEXT,
  path           TEXT NOT NULL,
  width          INTEGER NOT NULL DEFAULT 0,
  height         INTEGER NOT NULL DEFAULT 0,
  bytes          INTEGER NOT NULL DEFAULT 0,
  captured_at    TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'valid',
  verification   TEXT,
  failure_reason TEXT,
  -- ADR-0003: 'figma-render' is a design reference, never browser evidence.
  source         TEXT NOT NULL DEFAULT 'browser'
);
CREATE INDEX IF NOT EXISTS idx_shots_project ON screenshots(project_id);
CREATE INDEX IF NOT EXISTS idx_shots_execution ON screenshots(execution_id);

CREATE TABLE IF NOT EXISTS videos (
  id             TEXT PRIMARY KEY,
  execution_id   TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  path           TEXT NOT NULL,
  bytes          INTEGER NOT NULL DEFAULT 0,
  duration_ms    INTEGER,
  width          INTEGER,
  height         INTEGER,
  status         TEXT NOT NULL DEFAULT 'complete',
  failure_reason TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_videos_execution ON videos(execution_id);

CREATE TABLE IF NOT EXISTS findings (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  execution_id       TEXT,
  title              TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  severity           TEXT NOT NULL DEFAULT 'medium',
  category           TEXT NOT NULL,
  screen_id          TEXT,
  screen_name        TEXT,
  screenshot_id      TEXT,
  action_id          TEXT,
  persona_impact     TEXT NOT NULL DEFAULT '',
  recommendation     TEXT NOT NULL DEFAULT '',
  confidence         REAL NOT NULL DEFAULT 0.5,
  evidence_type      TEXT NOT NULL DEFAULT 'heuristic',
  generated_by_model TEXT,
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_findings_project ON findings(project_id);
CREATE INDEX IF NOT EXISTS idx_findings_execution ON findings(execution_id);

CREATE TABLE IF NOT EXISTS jobs (
  id               TEXT PRIMARY KEY,
  project_id       TEXT,
  kind             TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'queued',
  progress         REAL NOT NULL DEFAULT 0,
  message          TEXT NOT NULL DEFAULT '',
  phase            TEXT,
  error            TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  result           TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id);

CREATE TABLE IF NOT EXISTS experiments (
  id            TEXT PRIMARY KEY,
  project_id    TEXT,
  task          TEXT NOT NULL,
  prompt        TEXT NOT NULL DEFAULT '',
  screenshot_id TEXT,
  status        TEXT NOT NULL DEFAULT 'queued',
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS experiment_results (
  id                TEXT PRIMARY KEY,
  experiment_id     TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  provider_id       TEXT NOT NULL,
  model_id          TEXT NOT NULL,
  latency_ms        INTEGER,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  reasoning_tokens  INTEGER,
  estimated_cost    REAL,
  structured_valid  INTEGER,
  repair_attempts   INTEGER,
  output            TEXT,
  raw_content       TEXT,
  error             TEXT,
  human_rating      INTEGER,
  human_notes       TEXT
);
CREATE INDEX IF NOT EXISTS idx_expresults_experiment ON experiment_results(experiment_id);

CREATE TABLE IF NOT EXISTS coverage_snapshots (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  execution_id TEXT,
  dimension    TEXT NOT NULL,
  numerator    INTEGER NOT NULL DEFAULT 0,
  denominator  INTEGER NOT NULL DEFAULT 0,
  -- Misses are persisted so a historical number can always be explained.
  misses       TEXT NOT NULL DEFAULT '[]',
  excluded_count INTEGER NOT NULL DEFAULT 0,
  note         TEXT,
  computed_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_coverage_project ON coverage_snapshots(project_id);
