import type { ReactNode } from 'react';

/* ------------------------------------------------------------------ *
 * Primitives shared across the app
 * ------------------------------------------------------------------ */

export function Card({
  children,
  className = '',
  pad = true,
}: {
  children: ReactNode;
  className?: string;
  pad?: boolean;
}) {
  return <div className={`card ${pad ? 'card-pad' : ''} ${className}`}>{children}</div>;
}

export function SectionTitle({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 mb-4">
      <div>
        <h2 className="text-lg font-semibold text-ink-100">{title}</h2>
        {subtitle && <p className="text-sm text-ink-400 mt-0.5">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

const TONES = {
  neutral: 'bg-surface-700 text-ink-300',
  accent: 'bg-accent-600/20 text-accent-400',
  ok: 'bg-ok-600/15 text-ok-400',
  warn: 'bg-warn-600/15 text-warn-400',
  bad: 'bg-bad-600/15 text-bad-400',
  info: 'bg-info-600/15 text-info-400',
} as const;

export type Tone = keyof typeof TONES;

export function Badge({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode;
  tone?: Tone;
  title?: string;
}) {
  return (
    <span className={`chip ${TONES[tone]}`} title={title}>
      {children}
    </span>
  );
}

/** Status dot + label used for jobs, executions and screenshots. */
export function StatusDot({ tone }: { tone: Tone }) {
  const color = {
    neutral: 'bg-ink-500',
    accent: 'bg-accent-500',
    ok: 'bg-ok-400',
    warn: 'bg-warn-400',
    bad: 'bg-bad-400',
    info: 'bg-info-400',
  }[tone];
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${color}`} />;
}

export function Empty({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-14 px-6">
      {icon && <div className="mb-3 text-ink-500">{icon}</div>}
      <h3 className="text-sm font-semibold text-ink-200">{title}</h3>
      <p className="text-sm text-ink-400 mt-1 max-w-md">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Something went wrong';
  return (
    <div className="rounded-lg border border-bad-600/30 bg-bad-600/10 p-4">
      <div className="flex items-start gap-3">
        <span className="text-bad-400 mt-0.5">⚠</span>
        <div className="flex-1">
          <p className="text-sm font-medium text-ink-100">Request failed</p>
          <p className="text-sm text-ink-400 mt-0.5">{message}</p>
        </div>
        {retry && (
          <button className="btn-ghost text-xs" onClick={retry}>
            Retry
          </button>
        )}
      </div>
    </div>
  );
}

export function Skeleton({ className = 'h-4 w-full' }: { className?: string }) {
  return <div className={`skeleton ${className}`} />;
}

export function SkeletonCard() {
  return (
    <Card className="space-y-3">
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-3 w-2/3" />
      <Skeleton className="h-3 w-1/2" />
    </Card>
  );
}

/** A labelled progress bar; `tone` conveys meaning, not decoration. */
export function Progress({
  value,
  tone = 'accent',
  className = '',
}: {
  value: number;
  tone?: Tone;
  className?: string;
}) {
  const bar = {
    neutral: 'bg-ink-500',
    accent: 'bg-accent-500',
    ok: 'bg-ok-400',
    warn: 'bg-warn-400',
    bad: 'bg-bad-400',
    info: 'bg-info-400',
  }[tone];
  return (
    <div className={`h-1.5 w-full rounded-full bg-surface-700 overflow-hidden ${className}`}>
      <div
        className={`h-full rounded-full transition-all duration-300 ${bar}`}
        style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }}
      />
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: Tone;
}) {
  const color = {
    neutral: 'text-ink-100',
    accent: 'text-accent-400',
    ok: 'text-ok-400',
    warn: 'text-warn-400',
    bad: 'text-bad-400',
    info: 'text-info-400',
  }[tone];
  return (
    <Card>
      <p className="label">{label}</p>
      <p className={`mt-1.5 text-2xl font-semibold tabular-nums ${color}`}>{value}</p>
      {hint && <p className="text-xs text-ink-500 mt-1">{hint}</p>}
    </Card>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <div className="mt-1.5">{children}</div>
      {hint && <p className="text-xs text-ink-500 mt-1">{hint}</p>}
    </label>
  );
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: Array<{ id: T; label: string; count?: number }>;
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="flex items-center gap-1 border-b border-surface-800 overflow-x-auto">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`relative px-3.5 py-2.5 text-sm font-medium whitespace-nowrap transition-colors ${
            active === t.id ? 'text-ink-100' : 'text-ink-400 hover:text-ink-200'
          }`}
        >
          {t.label}
          {t.count !== undefined && (
            <span className="ml-1.5 text-2xs text-ink-500 tabular-nums">{t.count}</span>
          )}
          {active === t.id && (
            <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent-500" />
          )}
        </button>
      ))}
    </div>
  );
}

export const SEVERITY_TONE: Record<string, Tone> = {
  critical: 'bad',
  high: 'bad',
  medium: 'warn',
  low: 'info',
  info: 'neutral',
};

export const STATUS_TONE: Record<string, Tone> = {
  succeeded: 'ok',
  running: 'accent',
  queued: 'neutral',
  paused: 'warn',
  failed: 'bad',
  cancelled: 'neutral',
  valid: 'ok',
  approved: 'ok',
  draft: 'warn',
  discovered: 'ok',
  discovering: 'accent',
  created: 'neutral',
  'discovery-failed': 'bad',
  testing: 'accent',
  analyzed: 'ok',
  complete: 'ok',
  incomplete: 'warn',
  confirmed: 'ok',
  inferred: 'warn',
  observed: 'ok',
  potential: 'warn',
  heuristic: 'info',
  'needs-human-validation': 'warn',
};
