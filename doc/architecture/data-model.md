# Data Model and Persistence

## Strategy

SQLite via `better-sqlite3`, one file at `data/lenz.db`. Evidence binaries (screenshots,
videos) live on disk under `data/evidence/<projectId>/<executionId>/` and are referenced by
path — storing multi-megabyte blobs in SQLite would bloat the database and complicate backup.

All filesystem access goes through an `EvidenceStorage` interface (`put`, `get`, `url`,
`delete`). The local-disk implementation is the only one today; swapping in S3 later touches
one file and no business logic.

Migrations are numbered SQL files applied in order at startup, tracked in a `migrations`
table. Forward-only — appropriate for a single-operator local tool.

Enum-like columns are stored as `TEXT` and validated by Zod at the repository boundary, so
the database schema and the TypeScript union never drift.

## Entities

```
Project ──1:N─ Screen ───1:N─ Screenshot
   │             │
   │             └──1:N─ UiState
   ├──1:N─ GraphEdge
   ├──1:N─ EntryPoint
   ├──1:N─ DiscoveryRun ──1:N─ DiscoveryWarning
   ├──1:N─ Persona
   ├──1:N─ TestPlan ─1:N─ TestStep
   │             │
   │             └──1:N─ Execution ──1:N─ ExecutionAction
   │                        │
   │                        ├──1:1─ Video
   │                        └──1:N─ Finding
   ├──1:N─ Job
   └──1:N─ Experiment ──1:N─ ExperimentResult
```

## Tables

### `projects`
`id`, `name`, `description`, `figma_url`, `url_kind` (`proto|make|design|file`), `file_key`,
`start_node_id`, `status`, `created_at`, `updated_at`.

### `screens`
`id`, `project_id`, `node_id`, `name`, `canvas_id`, `canvas_name`, `node_type`,
`classification` (`screen|component|ambiguous`), `classification_reasons` (JSON),
`device_class`, `width`, `height`, `abs_x`, `abs_y`, `is_entry_point`, `reachable`,
`unreachable_reason`, `figma_image_url`.

> `classification_reasons` is persisted so a user can audit *why* a node was excluded. This
> is what makes the component-vs-screen decision reviewable rather than opaque.

### `graph_edges`
`id`, `project_id`, `from_screen_id`, `to_screen_id`, `kind` (`screen|overlay|ui-state`),
`figma_navigation` (`NAVIGATE|OVERLAY|SWAP|CHANGE_TO|SCROLL_TO`), `trigger`,
`source_node_id`, `source_node_name`, `source_abs_x/y/w/h`, `supported`,
`unsupported_reason`.

> `kind` is what the graph algorithms traverse; `figma_navigation` is kept for reporting and
> debugging. Source geometry is required to compute click coordinates.

### `ui_states`
`id`, `project_id`, `screen_id`, `signature`, `label`, `kind` (`variant|overlay|scroll|dom`),
`discovered_by` (`figma|browser`). Carries Make's DOM-signature states and Figma's variant
states in one table.

### `entry_points`
`id`, `project_id`, `screen_id`, `kind` (`confirmed|inferred`), `source`
(`prototypeStartNodeID|flowStartingPoint|heuristic`), `flow_name`, `rank`, `score`,
`signals` (JSON).

### `personas`
`id`, `project_id` (nullable — library personas are reusable across projects), `name`,
`age_range`, `background`, `technical_proficiency`, `digital_experience`, `goals` (JSON),
`motivations` (JSON), `frustrations` (JSON), `accessibility_needs` (JSON),
`behavioral_characteristics` (JSON), `expectations` (JSON), `origin` (`manual|ai`),
`generated_by_model`.

### `test_plans` / `test_steps`
Plan: `id`, `project_id`, `persona_id`, `name`, `objective`, `scenario`, `preconditions`,
`start_screen_id`, `success_criteria` (JSON), `friction_points` (JSON), `status`
(`draft|approved|archived`), `approved_at`, `origin`, `generated_by_model`.
Step: `id`, `plan_id`, `index`, `description`, `action_type`, `target_hint`,
`expected_outcome`, `expected_screen_id`.

> `status` is the approval gate: the execution service refuses any plan not `approved`,
> unless the project explicitly enables auto-approval.

### `executions` / `execution_actions`
Execution: `id`, `project_id`, `plan_id`, `persona_id`, `status`
(`queued|running|paused|succeeded|failed|cancelled`), `started_at`, `ended_at`,
`action_count`, `navigation_count`, `failure_reason`, `mode` (`live|mock`).
Action: `id`, `execution_id`, `index`, `step_id`, `description`, `action_type`,
`screen_id`, `expected_destination_node`, `actual_destination_node`, `verdict`
(`match|mismatch|no-navigation|timeout`), `screenshot_id`, `timestamp`, `offset_ms`,
`result` (`ok|failed|skipped`), `error`, `decided_by` (`figma-metadata|ai-vision`).

> `offset_ms` is what lets the timeline seek the recap video. `decided_by` records whether an
> action came from deterministic metadata or AI vision — essential for evaluating models.

### `screenshots`
`id`, `project_id`, `execution_id`, `screen_id`, `ui_state_id`, `node_id`, `action_label`,
`path`, `width`, `height`, `bytes`, `captured_at`, `status` (`valid|failed`),
`verification` (JSON: blankness score, settle result, node match), `failure_reason`,
`source` (`browser|figma-render`).

> `source` enforces the rule that Figma renders are never passed off as browser evidence.

### `videos`
`id`, `execution_id`, `path`, `bytes`, `duration_ms`, `width`, `height`, `status`
(`complete|incomplete|failed`), `failure_reason`.

### `findings`
`id`, `project_id`, `execution_id`, `title`, `description`, `severity`
(`critical|high|medium|low|info`), `category`, `screen_id`, `screenshot_id`, `action_id`,
`persona_impact`, `recommendation`, `confidence` (0-1), `evidence_type`
(`observed|potential|heuristic|needs-human-validation`), `generated_by_model`.

> `evidence_type` is the mechanism for section 12's requirement to distinguish directly
> observed issues from heuristic suggestions. A finding with no linked screenshot cannot be
> stored as `observed`.

### `jobs`
`id`, `project_id`, `kind` (`discovery|execution|analysis|experiment`), `status`,
`progress` (0-1), `message`, `error`, `cancel_requested`, `created_at`, `updated_at`,
`result` (JSON).

### `experiments` / `experiment_results`
Experiment: `id`, `task`, `input` (JSON), `input_screenshot_id`, `created_at`.
Result: `id`, `experiment_id`, `provider_id`, `model_id`, `latency_ms`, `prompt_tokens`,
`completion_tokens`, `reasoning_tokens`, `estimated_cost`, `structured_valid`, `output`
(JSON), `error`, `human_rating`, `human_notes`.

### `coverage_snapshots`
`id`, `project_id`, `execution_id`, `dimension`, `numerator`, `denominator`, `misses` (JSON
array of `{ id, reason }`), `computed_at`.

> Misses are persisted with the snapshot so a historical coverage number can always be
> explained, not just displayed.

## Indexing

Indexes on every foreign key, plus `screens(project_id, node_id)` (hot path for destination
verification), `graph_edges(project_id, kind)` (graph traversal filters by kind), and
`jobs(status)` (worker polling).
