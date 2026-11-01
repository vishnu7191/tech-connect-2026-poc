import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { Badge, Card, ErrorState, Field, SectionTitle } from '../components/ui';

interface ParsedUrl {
  kind: string;
  fileKey: string;
  fileName: string | null;
  startNodeId: string | null;
  hasExplicitStartPoint: boolean;
  supportsRestDiscovery: boolean;
  support: 'full' | 'structural' | 'browser-only' | 'unsupported';
  supportNote: string;
  blockedReason: string | null;
  scenario: 'A' | 'B' | 'C' | 'D';
}

const SUPPORT_TONE: Record<string, 'ok' | 'warn' | 'info' | 'bad'> = {
  full: 'ok',
  'browser-only': 'info',
  structural: 'warn',
  unsupported: 'bad',
};

const SUPPORT_LABEL: Record<string, string> = {
  full: 'Full workflow supported',
  'browser-only': 'Browser-driven discovery',
  structural: 'Structure only',
  unsupported: 'Not supported',
};

const SCENARIOS: Record<string, { title: string; detail: string }> = {
  A: {
    title: 'Prototype with a declared starting point',
    detail:
      'The URL names a start node. Lenz will use it as the confirmed entry point and verify navigation in a real browser.',
  },
  B: {
    title: 'Prototype without a starting point',
    detail:
      'No node-id in the URL. Lenz will read the file’s declared flows, and where a canvas declares none it will rank candidate entry points for you to choose from. Nothing is discarded.',
  },
  C: {
    title: 'Figma Make application',
    detail:
      'An interactive web app rather than a frame graph. Lenz drives the live application in a browser and records meaningful UI states, including ones that change nothing in the URL.',
  },
  D: {
    title: 'Design file',
    detail:
      'Not an interactive prototype. Lenz can extract the design structure, but there are no prototype flows to traverse, so navigation testing is unavailable.',
  },
};

const EXAMPLES = [
  {
    label: 'Rosella · with start point',
    url: 'https://www.figma.com/proto/TJEIgarZebWrehJFEFycYw/E-commerce_website_Rosella?node-id=1-2',
  },
  {
    label: 'Rosella · no start point',
    url: 'https://www.figma.com/proto/TJEIgarZebWrehJFEFycYw/E-commerce_website_Rosella',
  },
  {
    label: 'Figma Make app',
    url: 'https://www.figma.com/make/p1kRdgwLVWLh06BbR8fpIB/Lenz-UX-Validation-Engine?fullscreen=1&code-node-id=0-6',
  },
];

export default function NewProject() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [parsed, setParsed] = useState<ParsedUrl | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  // Live URL validation, debounced - tells the user which discovery path
  // their link will take before they commit to creating anything.
  useEffect(() => {
    if (!url.trim()) {
      setParsed(null);
      setParseError(null);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const res = await api.post<ParsedUrl>('/figma/parse-url', { url });
        setParsed(res);
        setParseError(null);
        setName((n) => n || res.fileName || '');
      } catch (err) {
        setParsed(null);
        setParseError(err instanceof ApiError ? err.message : 'Could not parse that URL');
      }
    }, 400);
    return () => clearTimeout(t);
  }, [url]);

  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>('/projects', { name, figmaUrl: url, description: description || null }),
    onSuccess: (p) => navigate(`/projects/${p.id}`),
  });

  const canSubmit = Boolean(parsed && name.trim() && !create.isPending);

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-ink-100">New project</h1>
        <p className="text-sm text-ink-400 mt-1">
          Lenz accepts Figma prototype, Make and design URLs. A missing <code className="font-mono text-ink-300">node-id</code> is
          supported, not an error.
        </p>
      </div>

      <Card className="space-y-5">
        <Field label="Figma URL" hint="Prototype, Make or design link.">
          <input
            className="input font-mono text-xs"
            placeholder="https://www.figma.com/proto/..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            autoFocus
          />
        </Field>

        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((e) => (
            <button key={e.url} onClick={() => setUrl(e.url)} className="btn-ghost text-xs py-1.5">
              {e.label}
            </button>
          ))}
        </div>

        {parseError && (
          <div className="rounded-lg border border-bad-600/30 bg-bad-600/10 px-3.5 py-2.5">
            <p className="text-sm text-bad-400">{parseError}</p>
          </div>
        )}

        {parsed && (
          <div className="rounded-lg border border-surface-700 bg-surface-850 p-4 animate-fade-in">
            <div className="flex items-center gap-2 mb-2.5 flex-wrap">
              <Badge tone="accent">Scenario {parsed.scenario}</Badge>
              <Badge tone={SUPPORT_TONE[parsed.support] ?? 'neutral'}>
                {SUPPORT_LABEL[parsed.support] ?? parsed.support}
              </Badge>
              <span className="text-sm font-medium text-ink-100">{SCENARIOS[parsed.scenario]?.title}</span>
            </div>
            <p className="text-sm text-ink-400 leading-relaxed">{SCENARIOS[parsed.scenario]?.detail}</p>

            {/* Say plainly what this link type can and cannot do, before the
                user invests time creating a project from it. */}
            {parsed.support !== 'full' && (
              <p className="text-sm text-warn-400 leading-relaxed mt-2 rounded-lg bg-warn-600/10 px-3 py-2">
                {parsed.supportNote}
              </p>
            )}
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 mt-3.5 text-xs">
              <div className="flex justify-between border-b border-surface-700 pb-1.5">
                <dt className="text-ink-500">File key</dt>
                <dd className="font-mono text-ink-300">{parsed.fileKey}</dd>
              </div>
              <div className="flex justify-between border-b border-surface-700 pb-1.5">
                <dt className="text-ink-500">Start node</dt>
                <dd className="font-mono text-ink-300">{parsed.startNodeId ?? 'not specified'}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-500">Type</dt>
                <dd className="text-ink-300">{parsed.kind}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-500">REST discovery</dt>
                <dd className={parsed.supportsRestDiscovery ? 'text-ok-400' : 'text-warn-400'}>
                  {parsed.supportsRestDiscovery ? 'available' : 'browser-only'}
                </dd>
              </div>
            </dl>
          </div>
        )}

        <Field label="Project name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="E-commerce checkout review" />
        </Field>

        <Field label="Description" hint="Optional. Helps ground AI-generated personas and test plans.">
          <textarea
            className="input min-h-[72px] resize-y"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What are you trying to learn from this prototype?"
          />
        </Field>

        {create.error && <ErrorState error={create.error} />}

        <div className="flex justify-end pt-1">
          <button className="btn-primary" disabled={!canSubmit} onClick={() => create.mutate()}>
            {create.isPending ? 'Creating…' : 'Create project'}
          </button>
        </div>
      </Card>
    </div>
  );
}
