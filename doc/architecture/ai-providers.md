# AI Provider Architecture

## Goal

Adding a provider or model, or changing which model performs a task, must be a **configuration
edit** — never a code change. No feature module may know a provider name, a model id, a base
URL or an API key.

## 1. Centralized configuration

`config/ai-providers.json` is the single source of truth. The structure from the brief is
preserved exactly:

```jsonc
{
  "providers": [
    {
      "id": "nvidia-nim",
      "displayName": "NVIDIA NIM",
      "baseUrl": "https://integrate.api.nvidia.com/v1",
      "apiKey": "${NVIDIA_API_KEY}",        // env placeholder, never a literal
      "adapter": "openai-compatible",
      "models": [
        {
          "id": "nvidia/nemotron-3.5-super-vl-120b-a12b",
          "name": "Nemotron 3.5 Super VL 120B A12B",
          "maxInputTokens": 128000,
          "maxOutputTokens": 4096,
          "supportsToolCalling": true,
          "supportsVision": true,
          "supportsStructuredOutput": true,
          "isReasoningModel": true
        }
      ]
    }
  ],
  "taskModels": {
    "screenAnalysis":      { "providerId": "nvidia-nim", "modelId": "..." },
    "personaGeneration":   { "providerId": "nvidia-nim", "modelId": "..." },
    "testPlanGeneration":  { "providerId": "nvidia-nim", "modelId": "..." },
    "autonomousTesting":   { "providerId": "nvidia-nim", "modelId": "..." },
    "uxEvaluation":        { "providerId": "nvidia-nim", "modelId": "..." },
    "reportGeneration":    { "providerId": "nvidia-nim", "modelId": "..." }
  }
}
```

**`${VAR}` interpolation** is resolved at startup from `process.env`. An unresolved
placeholder for an *enabled* provider is a **fatal startup error** with a clear message —
Lenz refuses to boot half-configured rather than failing mysteriously on the first AI call.

The whole file is validated with Zod at startup. Capability flags
(`supportsVision`, `supportsStructuredOutput`, ...) are declared per model because, as the
brief requires, **capabilities must not be assumed uniform across providers**. The AI service
checks the flag and raises a precise `CapabilityError` ("model X does not declare vision
support") instead of sending a request destined to fail.

## 2. Layering

```
feature code  ->  AiService  ->  ProviderAdapter  ->  HTTP
(no model ids)   (task routing)  (provider quirks)
```

### `AiService` — the only entry point features use

```ts
complete(task: AiTask, req: AiRequest): Promise<AiResponse>
completeStructured<T>(task: AiTask, req, schema: ZodSchema<T>): Promise<AiStructured<T>>
```

Callers name a **task** (`uxEvaluation`), never a model. The service resolves the task to a
provider+model via `taskModels`, applies overrides, checks capabilities, invokes the adapter,
normalizes errors and records telemetry (latency, tokens, mode) for the Model Lab.

Features that need a *specific* model — only the Model Lab comparison — pass an explicit
override, which is the single sanctioned bypass.

### `ProviderAdapter` — where provider weirdness is contained

```ts
interface ProviderAdapter {
  readonly id: string;
  complete(model: ModelConfig, req: NormalizedRequest): Promise<NormalizedResponse>;
}
```

`openai-compatible` covers NVIDIA NIM and any OpenAI-shaped endpoint. Adding Anthropic or a
local vLLM server means writing one adapter file and adding a JSON entry.

## 3. Handling the reasoning model (measured behaviour)

`nvidia/nemotron-3.5-super-vl-120b-a12b` is a **reasoning model**. Verified behaviour:

- Returns `message.reasoning_content` alongside `message.content`.
- Reports `usage.completion_tokens_details.reasoning_tokens` separately.
- **With `max_tokens: 300` a vision call returned `content: null` and
  `finish_reason: "length"`** — reasoning consumed the entire budget.

The adapter therefore:

1. **Budgets for reasoning.** Requests carry a floor on output tokens for reasoning models,
   so a modest answer is never starved by the reasoning trace.
2. **Separates the trace from the answer.** `reasoning_content` is returned as
   `response.reasoning` and surfaced in the Model Lab, but never parsed as the answer or
   shown as a finding.
3. **Treats truncation as retryable.** `finish_reason === "length"` with empty content is a
   `TruncatedResponseError`, retried once with a raised budget before being reported as a
   failure. Without this, the product's most common failure mode would look like an
   unexplained empty result.

This is exactly the kind of quirk the adapter boundary exists to absorb: no feature module
knows reasoning models exist.

### Reasoning can be switched off per task

NVIDIA NIM accepts `chat_template_kwargs: { thinking: false }`, which disables the reasoning
trace entirely. Measured on `nemotron-3.5-super-vl-120b-a12b`:

| Setting | Latency | Output tokens | Reasoning tokens | Correct? |
|---|---|---|---|---|
| `thinking: true` (default) | 1698 ms | 220 | 201 | yes |
| `thinking: false` | 891 ms | 18 | 0 | yes |

On a structured persona task, disabling it cut output tokens roughly **6x** (59-68 vs
264-412) and still produced schema-valid JSON on 3 of 3 runs.

It is therefore exposed as a **per-task setting** in `taskModels[task].thinking`, not applied
globally:

- Left **`true` everywhere by default**, so behaviour is unchanged until someone measures.
- Judgement-heavy tasks (`uxEvaluation`, `autonomousTesting`, `screenAnalysis`) plausibly
  benefit from the trace; mechanical extraction probably does not. That is a question for the
  Model Lab, not an assumption to bake in.
- When `thinking` is false the reasoning output floor is skipped automatically, since there is
  no trace to budget for.

The flag is only sent to models flagged `isReasoningModel`, so it is inert elsewhere.

## 4. Structured output

Both `json_schema` and `json_object` modes were verified working. `completeStructured`:

1. Converts the caller's Zod schema to JSON Schema and requests `json_schema` mode when the
   model declares support.
2. Falls back to `json_object` + explicit prompt instructions otherwise.
3. Extracts JSON defensively (handles fenced code blocks and surrounding prose).
4. **Validates against the Zod schema.** A schema violation is a typed failure with the
   validation error — never a half-parsed object passed downstream.
5. Retries once with the validation error fed back as a correction hint.

Step 4 is a security control as much as a correctness one: it is where untrusted model output
stops being trusted. Nothing reaches the browser engine or the database unvalidated.

## 5. Reliability

| Concern | Treatment |
|---|---|
| Timeouts | Per-request `AbortController`; configurable, generous for vision |
| Retries | Exponential backoff with jitter on 429/5xx/network and truncation; never on 4xx auth/validation |
| Error normalization | Provider errors mapped to `AuthError`, `RateLimitError`, `CapabilityError`, `TruncatedResponseError`, `ProviderError` |
| Telemetry | Every call records latency, prompt/completion/reasoning tokens, provider, model, task, outcome |
| Secret hygiene | API keys never logged, never serialized, never returned by any API |

## 6. Frontend exposure (Model Lab)

`GET /api/v1/ai/providers` returns a **redacted** view — ids, display names, model metadata,
capability flags, enabled state, and whether a key is present (`hasApiKey: boolean`). The key
itself never leaves the backend.

The Model Lab allows: viewing providers and models, reassigning any task to any model,
enabling/disabling models, and running experiments.

## 7. Experiments

An experiment runs **identical input** against two or more models and records, for each:
latency, token usage, estimated cost where known, structured-output validity, and the parsed
result. Runs are persisted so history is reviewable, and a human can attach a quality rating.

The comparison view deliberately **does not declare a winner by output volume.** More findings
is not better — a model inventing findings would score highest on that metric. Surfaced
instead: structured-output validity rate, evidence alignment (does each finding reference a
real screen and screenshot?), self-consistency across repeat runs, latency and cost, plus the
human rating. The product's position is that model quality for UX work is a judgement the
operator makes with good data, not a number the tool asserts.
