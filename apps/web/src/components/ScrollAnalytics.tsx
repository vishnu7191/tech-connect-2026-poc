import { Badge, Card, Empty, SectionTitle } from './ui';

/* ------------------------------------------------------------------ *
 * Scroll depth and page-region exposure
 *
 * The one thing this panel must never do is present exposure as attention. No
 * eye position was measured; what was measured is which part of the document
 * was inside the viewport, and for how long. The wording below says exactly
 * that, everywhere it appears.
 * ------------------------------------------------------------------ */

export interface ScrollRegionDto {
  fromFraction: number;
  toFraction: number;
  exposureMs: number;
  sessionsReached: number;
}

export interface ScrollSummaryDto {
  key: string;
  screenId: string | null;
  screenName: string | null;
  deviceId: string;
  deviceKind: string;
  viewportHeight: number;
  documentHeight: number | null;
  maxScrollY: number;
  maxDepthFraction: number | null;
  meanDepthFraction: number | null;
  sessionCount: number;
  sampleCount: number;
  totalDwellMs: number;
  scrollable: boolean;
  regions: ScrollRegionDto[];
  note: string | null;
}

export interface ScrollReportDto {
  projectId: string;
  summaries: ScrollSummaryDto[];
  executionIds: string[];
  generatedAt: string;
  dataNote: string;
}

const pct = (v: number | null): string => (v === null ? '—' : `${Math.round(v * 100)}%`);

export function ScrollAnalytics({
  report,
  title = 'Scroll depth',
  subtitle = 'How far down each screen the persona actually got, measured from recorded scroll positions.',
  bare = false,
}: {
  report: ScrollReportDto | undefined;
  title?: string;
  subtitle?: string;
  /** Render without the surrounding Card, for use inside an existing panel. */
  bare?: boolean;
}) {
  const empty = !report || report.summaries.length === 0;

  const body = empty ? (
    <Empty
      title="No scroll activity recorded"
      description="Scroll positions are sampled during a run. A screen that fits in the viewport produces none, which is a valid result rather than missing data."
    />
  ) : (
    <>
      <div className="space-y-5">
        {report!.summaries.map((s) => (
          <ScrollSummaryRow key={s.key} summary={s} />
        ))}
      </div>
      <p className="text-2xs text-ink-500 mt-4 pt-3 border-t border-surface-800 leading-relaxed">
        {report!.dataNote} Region exposure is the time a band of the page was inside the viewport.
        It is not a measure of attention — no gaze was tracked.
      </p>
    </>
  );

  if (bare) {
    return (
      <div>
        <SectionTitle title={title} subtitle={subtitle} />
        {body}
      </div>
    );
  }

  return (
    <Card pad={!empty}>
      {empty ? (
        <>
          <div className="p-5 pb-0">
            <SectionTitle title={title} subtitle={subtitle} />
          </div>
          {body}
        </>
      ) : (
        <>
          <SectionTitle title={title} subtitle={subtitle} />
          {body}
        </>
      )}
    </Card>
  );
}

function ScrollSummaryRow({ summary: s }: { summary: ScrollSummaryDto }) {
  const maxExposure = Math.max(1, ...s.regions.map((r) => r.exposureMs));

  return (
    <div>
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <span className="text-sm font-medium text-ink-100">
          {s.screenName ?? s.screenId ?? 'Unidentified screen'}
        </span>
        <Badge tone="info">{s.deviceId}</Badge>
        {!s.scrollable && (
          <Badge tone="neutral" title="The document never exceeded the viewport height.">
            fits the viewport
          </Badge>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
        <Metric label="Max depth reached" value={pct(s.maxDepthFraction)} />
        <Metric
          label="Mean depth per session"
          value={pct(s.meanDepthFraction)}
          hint="Average of each session's own deepest point"
        />
        <Metric
          label="Document height"
          value={s.documentHeight === null ? 'not measurable' : `${Math.round(s.documentHeight)}px`}
          hint={`viewport ${s.viewportHeight}px`}
        />
        <Metric
          label="Sessions"
          value={String(s.sessionCount)}
          hint={`${s.sampleCount} samples`}
        />
      </div>

      {s.regions.length > 0 ? (
        <div>
          <p className="label mb-1.5">Page region exposure</p>
          <div className="space-y-1">
            {s.regions.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-2xs text-ink-500 tabular-nums w-16 shrink-0">
                  {Math.round(r.fromFraction * 100)}–{Math.round(r.toFraction * 100)}%
                </span>
                <div className="flex-1 h-3 rounded bg-surface-800 overflow-hidden">
                  <div
                    className="h-full rounded bg-accent-600/70"
                    style={{ width: `${(r.exposureMs / maxExposure) * 100}%` }}
                  />
                </div>
                <span className="text-2xs text-ink-500 tabular-nums w-20 text-right shrink-0">
                  {(r.exposureMs / 1000).toFixed(1)}s
                </span>
                <span
                  className="text-2xs text-ink-500 tabular-nums w-10 text-right shrink-0"
                  title="Sessions that brought this band into the viewport"
                >
                  {r.sessionsReached}×
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-2xs text-ink-500">
          Region exposure needs a measurable document height, which was not available for this
          screen.
        </p>
      )}

      {s.note && <p className="text-2xs text-warn-400 mt-2 leading-relaxed">{s.note}</p>}
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg bg-surface-850 px-3 py-2">
      <p className="label">{label}</p>
      <p className="text-sm font-semibold text-ink-100 tabular-nums mt-0.5">{value}</p>
      {hint && <p className="text-2xs text-ink-500 mt-0.5">{hint}</p>}
    </div>
  );
}
