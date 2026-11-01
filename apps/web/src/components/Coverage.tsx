import { useState } from 'react';
import { Badge, Card, Progress, SectionTitle, type Tone } from './ui';

export interface CoverageMetric {
  dimension: string;
  numerator: number;
  denominator: number;
  percentage: number | null;
  misses: Array<{ id: string; label: string; reason: string }>;
  excludedCount: number;
  note: string | null;
}

const LABELS: Record<string, { title: string; help: string }> = {
  designDiscovery: {
    title: 'Design discovery',
    help: 'Nodes confidently classified as screens. Design-system components are excluded by design, not counted as failures.',
  },
  reachability: {
    title: 'Reachability',
    help: 'Screens reachable from a selected entry point by following real NAVIGATE transitions.',
  },
  interactionDiscovery: {
    title: 'Interaction discovery',
    help: 'Prototype interactions that became usable graph edges.',
  },
  interactionExecution: {
    title: 'Interaction execution',
    help: 'Interactions actually exercised in a browser during this test.',
  },
  screenshotCapture: {
    title: 'Screenshot capture',
    help: 'Captures that passed verification: readable, non-blank, and on the expected screen.',
  },
  testExecution: { title: 'Test execution', help: 'Plan steps that completed successfully.' },
  videoRecording: { title: 'Video recording', help: 'Whether a complete session recording was produced.' },
};

function toneFor(m: CoverageMetric): Tone {
  if (m.percentage === null) return 'neutral';
  if (m.misses.length === 0 && m.percentage >= 1) return 'ok';
  if (m.percentage >= 0.8) return 'info';
  if (m.percentage >= 0.5) return 'warn';
  return 'bad';
}

/**
 * Coverage is shown as SEPARATE dimensions, each with its miss-list.
 * There is deliberately no single roll-up percentage: averaging these would
 * hide exactly the gaps this panel exists to expose.
 */
export function CoveragePanel({
  metrics,
  title = 'Coverage',
  subtitle,
}: {
  metrics: CoverageMetric[];
  title?: string;
  subtitle?: string;
}) {
  const [open, setOpen] = useState<string | null>(null);
  if (metrics.length === 0) return null;

  return (
    <Card>
      <SectionTitle
        title={title}
        subtitle={
          subtitle ??
          'Tracked independently. Each dimension shows what was missed and why — there is no combined score, because averaging these would hide real gaps.'
        }
      />
      <div className="space-y-3">
        {metrics.map((m) => {
          const meta = LABELS[m.dimension] ?? { title: m.dimension, help: '' };
          const tone = toneFor(m);
          const isOpen = open === m.dimension;
          const pct = m.percentage === null ? null : Math.round(m.percentage * 1000) / 10;

          return (
            <div key={m.dimension} className="rounded-lg bg-surface-850 p-3.5">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-ink-100">{meta.title}</span>
                    {m.excludedCount > 0 && (
                      <Badge tone="neutral" title="Excluded by classification, not a failure">
                        {m.excludedCount} excluded
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-ink-500 mt-0.5">{meta.help}</p>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-sm font-semibold tabular-nums text-ink-100">
                    {pct === null ? 'n/a' : `${pct}%`}
                  </div>
                  <div className="text-2xs text-ink-500 tabular-nums">
                    {m.numerator}/{m.denominator}
                  </div>
                </div>
              </div>

              <Progress value={m.percentage ?? 0} tone={tone} className="mt-2.5" />

              {m.note && <p className="text-2xs text-ink-500 mt-2 leading-relaxed">{m.note}</p>}

              {m.misses.length > 0 && (
                <div className="mt-2">
                  <button
                    className="text-2xs font-medium text-accent-400 hover:text-accent-300"
                    onClick={() => setOpen(isOpen ? null : m.dimension)}
                  >
                    {isOpen ? 'Hide' : 'Show'} {m.misses.length} not covered
                  </button>
                  {isOpen && (
                    <ul className="mt-2 space-y-1 max-h-56 overflow-y-auto pr-1">
                      {m.misses.map((miss, i) => (
                        <li
                          key={`${miss.id}-${i}`}
                          className="flex items-start justify-between gap-3 text-2xs rounded bg-surface-900 px-2.5 py-1.5"
                        >
                          <span className="text-ink-300 truncate">{miss.label || miss.id}</span>
                          <span className="font-mono text-ink-500 shrink-0">{miss.reason}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
