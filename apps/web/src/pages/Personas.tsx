import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useJob } from '../lib/useJob';
import { Badge, Card, Empty, ErrorState, Field, Progress, SectionTitle, Skeleton } from '../components/ui';

const PROFICIENCY_TONE: Record<string, 'bad' | 'warn' | 'info' | 'ok'> = {
  low: 'bad',
  medium: 'warn',
  high: 'info',
  expert: 'ok',
};

const EMPTY_FORM = {
  name: '',
  ageRange: '',
  background: '',
  technicalProficiency: 'medium',
  digitalExperience: '',
  goals: '',
  motivations: '',
  frustrations: '',
  accessibilityNeeds: '',
  behavioralCharacteristics: '',
  expectations: '',
};

const toList = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);

export default function Personas() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const [count, setCount] = useState(3);
  const [guidance, setGuidance] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editing, setEditing] = useState<string | null>(null);

  const personas = useQuery({
    queryKey: ['personas', id],
    queryFn: () => api.get<any[]>(`/personas?projectId=${id}`),
  });

  const job = useJob([['personas', id]]);

  const generate = useMutation({
    mutationFn: () => api.post<{ jobId: string }>(`/projects/${id}/personas/generate`, { count, guidance: guidance || null }),
    onSuccess: (r) => job.watch(r.jobId),
  });

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        projectId: id,
        name: form.name,
        ageRange: form.ageRange || null,
        background: form.background,
        technicalProficiency: form.technicalProficiency,
        digitalExperience: form.digitalExperience,
        goals: toList(form.goals),
        motivations: toList(form.motivations),
        frustrations: toList(form.frustrations),
        accessibilityNeeds: toList(form.accessibilityNeeds),
        behavioralCharacteristics: toList(form.behavioralCharacteristics),
        expectations: toList(form.expectations),
      };
      return editing ? api.patch(`/personas/${editing}`, payload) : api.post('/personas', payload);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['personas', id] });
      setShowForm(false);
      setEditing(null);
      setForm(EMPTY_FORM);
    },
  });

  const remove = useMutation({
    mutationFn: (pid: string) => api.del(`/personas/${pid}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['personas', id] }),
  });

  const startEdit = (p: any) => {
    setEditing(p.id);
    setForm({
      name: p.name,
      ageRange: p.ageRange ?? '',
      background: p.background,
      technicalProficiency: p.technicalProficiency,
      digitalExperience: p.digitalExperience,
      goals: p.goals.join('\n'),
      motivations: p.motivations.join('\n'),
      frustrations: p.frustrations.join('\n'),
      accessibilityNeeds: p.accessibilityNeeds.join('\n'),
      behavioralCharacteristics: p.behavioralCharacteristics.join('\n'),
      expectations: p.expectations.join('\n'),
    });
    setShowForm(true);
  };

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Personas"
        subtitle="Synthetic users with different proficiencies and behaviours. They are testing instruments, not research participants."
        actions={
          <button
            className="btn-ghost"
            onClick={() => {
              setEditing(null);
              setForm(EMPTY_FORM);
              setShowForm((s) => !s);
            }}
          >
            {showForm ? 'Cancel' : 'Create manually'}
          </button>
        }
      />

      <Card>
        <SectionTitle title="Generate with AI" subtitle="Grounded in the screens discovered for this project." />
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-28">
            <Field label="How many">
              <input
                type="number"
                min={1}
                max={6}
                className="input"
                value={count}
                onChange={(e) => setCount(Number(e.target.value))}
              />
            </Field>
          </div>
          <div className="flex-1 min-w-[18rem]">
            <Field label="Guidance (optional)">
              <input
                className="input"
                placeholder="e.g. one expert shopper and one hesitant first-time buyer"
                value={guidance}
                onChange={(e) => setGuidance(e.target.value)}
              />
            </Field>
          </div>
          <button className="btn-primary" disabled={job.isActive || generate.isPending} onClick={() => generate.mutate()}>
            {job.isActive ? 'Generating…' : 'Generate'}
          </button>
        </div>

        {job.jobId && job.status !== 'idle' && (
          <div className="mt-4">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-sm text-ink-300">{job.message}</span>
              <span className="text-xs tabular-nums text-ink-500">{Math.round(job.progress * 100)}%</span>
            </div>
            <Progress value={job.progress} tone={job.status === 'failed' ? 'bad' : 'accent'} />
            {job.error && <p className="text-sm text-bad-400 mt-2">{job.error}</p>}
          </div>
        )}
        {generate.error && <div className="mt-3"><ErrorState error={generate.error} /></div>}
      </Card>

      {showForm && (
        <Card>
          <SectionTitle title={editing ? 'Edit persona' : 'New persona'} subtitle="One item per line for list fields." />
          <div className="grid grid-cols-2 gap-4">
            <Field label="Name">
              <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Age range">
              <input className="input" value={form.ageRange} onChange={(e) => setForm({ ...form, ageRange: e.target.value })} placeholder="25-34" />
            </Field>
            <Field label="Technical proficiency">
              <select
                className="input"
                value={form.technicalProficiency}
                onChange={(e) => setForm({ ...form, technicalProficiency: e.target.value })}
              >
                {['low', 'medium', 'high', 'expert'].map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            </Field>
            <Field label="Digital experience">
              <input className="input" value={form.digitalExperience} onChange={(e) => setForm({ ...form, digitalExperience: e.target.value })} />
            </Field>
            <div className="col-span-2">
              <Field label="Background">
                <textarea className="input min-h-[64px]" value={form.background} onChange={(e) => setForm({ ...form, background: e.target.value })} />
              </Field>
            </div>
            {([
              ['goals', 'Goals'],
              ['motivations', 'Motivations'],
              ['frustrations', 'Frustrations'],
              ['accessibilityNeeds', 'Accessibility needs'],
              ['behavioralCharacteristics', 'Behavioural characteristics'],
              ['expectations', 'Expectations'],
            ] as const).map(([key, label]) => (
              <Field key={key} label={label}>
                <textarea
                  className="input min-h-[64px]"
                  value={(form as any)[key]}
                  onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                />
              </Field>
            ))}
          </div>
          {save.error && <div className="mt-3"><ErrorState error={save.error} /></div>}
          <div className="flex justify-end gap-2 mt-4">
            <button className="btn-ghost" onClick={() => { setShowForm(false); setEditing(null); }}>Cancel</button>
            <button className="btn-primary" disabled={!form.name.trim() || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? 'Saving…' : editing ? 'Save changes' : 'Create persona'}
            </button>
          </div>
        </Card>
      )}

      {personas.isLoading && <Skeleton className="h-40" />}
      {personas.error && <ErrorState error={personas.error} retry={() => personas.refetch()} />}

      {personas.data?.length === 0 && !showForm && (
        <Card pad={false}>
          <Empty
            title="No personas yet"
            description="Generate a set with AI, or create one by hand. Personas with different proficiencies surface different usability problems."
          />
        </Card>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {personas.data?.map((p) => (
          <Card key={p.id} className="flex flex-col">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-medium text-ink-100">{p.name}</h3>
                  {p.ageRange && <Badge tone="neutral">{p.ageRange}</Badge>}
                  <Badge tone={PROFICIENCY_TONE[p.technicalProficiency] ?? 'neutral'}>
                    {p.technicalProficiency}
                  </Badge>
                  <Badge tone={p.origin === 'ai' ? 'accent' : 'neutral'}>{p.origin}</Badge>
                </div>
                {p.generatedByModel && (
                  <p className="text-2xs text-ink-500 font-mono mt-1">{p.generatedByModel}</p>
                )}
              </div>
              <div className="flex gap-1.5 shrink-0">
                <button className="btn-ghost text-xs py-1" onClick={() => startEdit(p)}>Edit</button>
                <button className="btn-ghost text-xs py-1 text-bad-400" onClick={() => remove.mutate(p.id)}>Delete</button>
              </div>
            </div>

            <p className="text-sm text-ink-300 mt-3 leading-relaxed">{p.background}</p>

            <div className="grid grid-cols-2 gap-x-5 gap-y-3 mt-4">
              {([
                ['Goals', p.goals, 'ok'],
                ['Frustrations', p.frustrations, 'bad'],
                ['Behaviours', p.behavioralCharacteristics, 'info'],
                ['Expectations', p.expectations, 'neutral'],
              ] as const).map(([label, items]) =>
                items?.length ? (
                  <div key={label}>
                    <p className="label">{label}</p>
                    <ul className="mt-1 space-y-0.5">
                      {items.slice(0, 4).map((g: string, i: number) => (
                        <li key={i} className="text-xs text-ink-400 leading-snug">· {g}</li>
                      ))}
                    </ul>
                  </div>
                ) : null,
              )}
            </div>

            {p.accessibilityNeeds?.length > 0 && (
              <div className="mt-3 pt-3 border-t border-surface-800">
                <p className="label">Accessibility needs</p>
                <p className="text-xs text-ink-400 mt-1">{p.accessibilityNeeds.join(' · ')}</p>
              </div>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
