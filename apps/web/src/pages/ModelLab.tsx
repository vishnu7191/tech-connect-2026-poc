import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useJob } from '../lib/useJob';
import {
  Badge,
  Card,
  Empty,
  ErrorState,
  Field,
  Progress,
  SectionTitle,
  Skeleton,
  Tabs,
} from '../components/ui';

const TASKS = [
  'screenAnalysis',
  'personaGeneration',
  'testPlanGeneration',
  'autonomousTesting',
  'uxEvaluation',
  'reportGeneration',
] as const;

const TASK_LABELS: Record<string, string> = {
  screenAnalysis: 'Screen Analysis',
  personaGeneration: 'Persona Generation',
  testPlanGeneration: 'Test Plan Generation',
  autonomousTesting: 'Autonomous Testing',
  uxEvaluation: 'UX Evaluation',
  reportGeneration: 'Report Generation',
};

type TabId = 'providers' | 'tasks' | 'compare' | 'history';

export default function ModelLab() {
  const [tab, setTab] = useState<TabId>('providers');
  const providers = useQuery({ queryKey: ['ai-providers'], queryFn: () => api.get<any[]>('/ai/providers') });
  const tasks = useQuery({ queryKey: ['ai-tasks'], queryFn: () => api.get<Record<string, any>>('/ai/tasks') });
  const experiments = useQuery({ queryKey: ['experiments'], queryFn: () => api.get<any[]>('/ai/experiments') });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-ink-100">Model Lab</h1>
        <p className="text-sm text-ink-400 mt-1">
          Providers and models come from <code className="font-mono text-ink-300">config/ai-providers.json</code>. API keys stay
          on the backend and are never sent here.
        </p>
      </div>

      <Tabs<TabId>
        tabs={[
          { id: 'providers', label: 'Providers & models' },
          { id: 'tasks', label: 'Task routing' },
          { id: 'compare', label: 'Compare models' },
          { id: 'history', label: 'Experiments', count: experiments.data?.length },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'providers' && <Providers providers={providers} />}
      {tab === 'tasks' && <TaskRouting providers={providers} tasks={tasks} />}
      {tab === 'compare' && <Compare providers={providers} />}
      {tab === 'history' && <History experiments={experiments} />}
    </div>
  );
}

function Providers({ providers }: { providers: any }) {
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: (v: { providerId: string; modelId: string; enabled: boolean }) =>
      api.patch(`/ai/models/${v.providerId}/${encodeURIComponent(v.modelId)}`, { enabled: v.enabled }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ai-providers'] }),
  });

  if (providers.isLoading) return <Skeleton className="h-64" />;
  if (providers.error) return <ErrorState error={providers.error} />;

  return (
    <div className="space-y-4">
      {providers.data?.map((p: any) => (
        <Card key={p.id}>
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-medium text-ink-100">{p.displayName}</h3>
                <Badge tone={p.enabled ? 'ok' : 'neutral'}>{p.enabled ? 'enabled' : 'disabled'}</Badge>
                <Badge tone={p.hasApiKey ? 'ok' : 'bad'}>{p.hasApiKey ? 'key resolved' : 'no key'}</Badge>
              </div>
              <p className="text-2xs text-ink-500 font-mono mt-1">
                {p.id} · {p.baseUrlHost} · adapter: {p.adapter}
              </p>
            </div>
          </div>

          <div className="mt-4 space-y-2">
            {p.models.map((m: any) => (
              <div key={m.id} className="rounded-lg bg-surface-850 p-3.5">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-ink-100">{m.name}</span>
                      {m.isReasoningModel && <Badge tone="accent">reasoning</Badge>}
                      {m.supportsVision && <Badge tone="info">vision</Badge>}
                      {m.supportsStructuredOutput && <Badge tone="ok">structured</Badge>}
                      {m.supportsToolCalling && <Badge tone="neutral">tools</Badge>}
                    </div>
                    <p className="text-2xs text-ink-500 font-mono mt-1 break-all">{m.id}</p>
                    <p className="text-2xs text-ink-500 mt-1 tabular-nums">
                      in {m.maxInputTokens.toLocaleString()} · out {m.maxOutputTokens.toLocaleString()} tokens
                    </p>
                  </div>
                  <label className="flex items-center gap-2 shrink-0 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={m.enabled}
                      disabled={!p.enabled}
                      onChange={(e) => toggle.mutate({ providerId: p.id, modelId: m.id, enabled: e.target.checked })}
                      className="accent-violet-500"
                    />
                    <span className="text-2xs text-ink-400">enabled</span>
                  </label>
                </div>
                {m.notes && (
                  <p className="text-2xs text-ink-500 mt-2 leading-relaxed border-t border-surface-800 pt-2">{m.notes}</p>
                )}
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}

function TaskRouting({ providers, tasks }: { providers: any; tasks: any }) {
  const qc = useQueryClient();
  const assign = useMutation({
    mutationFn: (v: { task: string; providerId: string; modelId: string }) =>
      api.put(`/ai/tasks/${v.task}`, { providerId: v.providerId, modelId: v.modelId }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ai-tasks'] }),
  });

  if (tasks.isLoading || providers.isLoading) return <Skeleton className="h-64" />;

  const options: Array<{ providerId: string; modelId: string; label: string }> = [];
  for (const p of providers.data ?? []) {
    if (!p.enabled) continue;
    for (const m of p.models) {
      if (m.enabled) options.push({ providerId: p.id, modelId: m.id, label: `${p.displayName} · ${m.name}` });
    }
  }

  return (
    <Card>
      <SectionTitle
        title="Task routing"
        subtitle="Features address models by task, never by id. Changing an assignment here changes behaviour immediately — no code change, no restart."
      />
      <div className="space-y-2">
        {TASKS.map((t) => {
          const current = tasks.data?.[t];
          const value = current ? `${current.providerId}|${current.modelId}` : '';
          return (
            <div key={t} className="flex items-center justify-between gap-4 rounded-lg bg-surface-850 px-3.5 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink-100">{TASK_LABELS[t]}</p>
                <p className="text-2xs text-ink-500 font-mono">{t}</p>
              </div>
              <select
                className="input w-auto max-w-sm"
                value={value}
                onChange={(e) => {
                  const [providerId, modelId] = e.target.value.split('|');
                  if (providerId && modelId) assign.mutate({ task: t, providerId, modelId });
                }}
              >
                {options.map((o) => (
                  <option key={`${o.providerId}|${o.modelId}`} value={`${o.providerId}|${o.modelId}`}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
      </div>
      {assign.error && <div className="mt-3"><ErrorState error={assign.error} /></div>}
    </Card>
  );
}

function Compare({ providers }: { providers: any }) {
  const qc = useQueryClient();
  const [prompt, setPrompt] = useState(
    'Describe the primary purpose of an e-commerce product listing screen and list three usability risks.',
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [structured, setStructured] = useState(false);
  const job = useJob([['experiments']]);

  const options: Array<{ key: string; providerId: string; modelId: string; label: string }> = [];
  for (const p of providers.data ?? []) {
    if (!p.enabled) continue;
    for (const m of p.models) {
      if (m.enabled) {
        options.push({ key: `${p.id}|${m.id}`, providerId: p.id, modelId: m.id, label: `${p.displayName} · ${m.name}` });
      }
    }
  }

  const run = useMutation({
    mutationFn: () =>
      api.post<{ jobId: string }>('/ai/experiments', {
        task: 'screenAnalysis',
        prompt,
        structured,
        models: selected.map((k) => {
          const [providerId, modelId] = k.split('|');
          return { providerId, modelId };
        }),
      }),
    onSuccess: (r) => {
      job.watch(r.jobId);
      void qc.invalidateQueries({ queryKey: ['experiments'] });
    },
  });

  return (
    <Card>
      <SectionTitle
        title="Run a comparison"
        subtitle="The same input goes to every selected model. Latency, token usage and structured-output validity are recorded."
      />
      <div className="space-y-4">
        <Field label="Prompt">
          <textarea className="input min-h-[88px]" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </Field>

        <div>
          <p className="label mb-1.5">Models (pick at least two)</p>
          <div className="space-y-1.5">
            {options.length < 2 && (
              <p className="text-xs text-warn-400">
                At least two enabled models are needed. Enable another in the Providers tab.
              </p>
            )}
            {options.map((o) => (
              <label key={o.key} className="flex items-center gap-2.5 rounded-lg bg-surface-850 px-3 py-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="accent-violet-500"
                  checked={selected.includes(o.key)}
                  onChange={() =>
                    setSelected((s) => (s.includes(o.key) ? s.filter((x) => x !== o.key) : [...s, o.key]))
                  }
                />
                <span className="text-sm text-ink-200">{o.label}</span>
              </label>
            ))}
          </div>
        </div>

        <label className="flex items-center gap-2.5 cursor-pointer">
          <input type="checkbox" className="accent-violet-500" checked={structured} onChange={(e) => setStructured(e.target.checked)} />
          <span className="text-sm text-ink-300">Require structured JSON output (tests schema compliance)</span>
        </label>

        <button className="btn-primary" disabled={selected.length < 2 || job.isActive || run.isPending} onClick={() => run.mutate()}>
          {job.isActive ? 'Running…' : `Compare ${selected.length} models`}
        </button>

        {job.jobId && job.status !== 'idle' && (
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-sm text-ink-300">{job.message}</span>
              <span className="text-xs tabular-nums text-ink-500">{Math.round(job.progress * 100)}%</span>
            </div>
            <Progress value={job.progress} tone={job.status === 'failed' ? 'bad' : 'accent'} />
          </div>
        )}
        {run.error && <ErrorState error={run.error} />}
      </div>

      <div className="mt-5 pt-5 border-t border-surface-800">
        <p className="text-2xs text-ink-500 leading-relaxed">
          Lenz does not declare a winner automatically. More output is not better — a model inventing findings would
          score highest on volume. Compare structured-output validity, evidence alignment, latency and cost, then apply
          your own rating.
        </p>
      </div>
    </Card>
  );
}

function History({ experiments }: { experiments: any }) {
  const qc = useQueryClient();
  const rate = useMutation({
    mutationFn: (v: { experimentId: string; resultId: string; rating: number }) =>
      api.post(`/ai/experiments/${v.experimentId}/rate`, { resultId: v.resultId, rating: v.rating, notes: null }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['experiments'] }),
  });

  if (experiments.isLoading) return <Skeleton className="h-64" />;
  if (experiments.data?.length === 0) {
    return (
      <Card pad={false}>
        <Empty title="No experiments yet" description="Run a comparison to build a history you can review later." />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {experiments.data?.map((e: any) => (
        <Card key={e.id}>
          <div className="flex items-center gap-2">
            <Badge tone="neutral">{e.task}</Badge>
            <Badge tone={e.status === 'succeeded' ? 'ok' : 'warn'}>{e.status}</Badge>
            <span className="text-2xs text-ink-500 ml-auto">{new Date(e.createdAt).toLocaleString()}</span>
          </div>
          <p className="text-sm text-ink-300 mt-2 line-clamp-2">{e.prompt}</p>

          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-2xs text-ink-500 uppercase tracking-wider">
                  <th className="text-left font-semibold py-1.5">Model</th>
                  <th className="text-right font-semibold">Latency</th>
                  <th className="text-right font-semibold">Prompt</th>
                  <th className="text-right font-semibold">Output</th>
                  <th className="text-right font-semibold">Reasoning</th>
                  <th className="text-right font-semibold">Est. cost</th>
                  <th className="text-center font-semibold">Valid JSON</th>
                  <th className="text-center font-semibold">Your rating</th>
                </tr>
              </thead>
              <tbody>
                {e.results.map((r: any) => (
                  <tr key={r.id} className="border-t border-surface-800">
                    <td className="py-2 pr-3">
                      <span className="text-ink-200 font-mono text-2xs">{r.modelId.split('/').pop()}</span>
                      {r.error && <p className="text-2xs text-bad-400 mt-0.5 max-w-xs">{r.error}</p>}
                    </td>
                    <td className="text-right tabular-nums text-ink-300">{r.latencyMs ? `${r.latencyMs}ms` : '—'}</td>
                    <td className="text-right tabular-nums text-ink-400">{r.promptTokens ?? '—'}</td>
                    <td className="text-right tabular-nums text-ink-400">{r.completionTokens ?? '—'}</td>
                    <td className="text-right tabular-nums text-accent-400">{r.reasoningTokens ?? '—'}</td>
                    <td className="text-right tabular-nums text-ink-400" title="Only shown for models with published pricing in config">
                      {r.estimatedCost === null || r.estimatedCost === undefined
                        ? '—'
                        : `$${r.estimatedCost.toFixed(6)}`}
                    </td>
                    <td className="text-center">
                      {r.structuredValid === null ? (
                        <span className="text-ink-500">n/a</span>
                      ) : (
                        <Badge tone={r.structuredValid ? 'ok' : 'bad'}>{r.structuredValid ? 'yes' : 'no'}</Badge>
                      )}
                    </td>
                    <td className="text-center">
                      <div className="flex justify-center gap-0.5">
                        {[1, 2, 3, 4, 5].map((n) => (
                          <button
                            key={n}
                            onClick={() => rate.mutate({ experimentId: e.id, resultId: r.id, rating: n })}
                            className={`text-xs ${(r.humanRating ?? 0) >= n ? 'text-warn-400' : 'text-surface-600 hover:text-ink-500'}`}
                            title={`Rate ${n}/5`}
                          >
                            ★
                          </button>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <details className="mt-3">
            <summary className="text-2xs text-accent-400 cursor-pointer hover:text-accent-300">Show raw outputs</summary>
            <div className="mt-2 space-y-2">
              {e.results.map((r: any) => (
                <div key={r.id} className="rounded-lg bg-surface-850 p-3">
                  <p className="text-2xs font-mono text-ink-500 mb-1">{r.modelId}</p>
                  <pre className="text-2xs text-ink-300 whitespace-pre-wrap max-h-48 overflow-y-auto">
                    {r.rawContent ?? r.error ?? '(no output)'}
                  </pre>
                </div>
              ))}
            </div>
          </details>
        </Card>
      ))}
    </div>
  );
}
