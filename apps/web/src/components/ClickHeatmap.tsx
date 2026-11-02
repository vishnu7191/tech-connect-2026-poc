import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { screenshotUrl } from '../lib/api';
import { Badge, Empty } from './ui';

/* ------------------------------------------------------------------ *
 * Click / tap heatmap
 *
 * The server supplies the exact recorded points; this component only draws
 * them. Rendering is deterministic - the same points always produce the same
 * image - and uses a plain 2D canvas rather than a charting dependency, since
 * the whole algorithm is "accumulate radial falloff, then map intensity to a
 * colour ramp".
 *
 * There is no interpolation beyond that falloff, and no smoothing that would
 * suggest activity where none was recorded.
 * ------------------------------------------------------------------ */

export interface HeatmapPointDto {
  x: number;
  y: number;
  weight: number;
  type: string;
  result: string;
  label: string | null;
  executionId: string;
  personaId: string | null;
  elapsedMs: number;
}

export interface HeatmapGroupDto {
  key: string;
  screenId: string | null;
  screenName: string | null;
  deviceId: string;
  deviceKind: string;
  viewportWidth: number;
  viewportHeight: number;
  points: HeatmapPointDto[];
  totalPoints: number;
  successCount: number;
  failureCount: number;
  unverifiedCount: number;
  sessionCount: number;
  personaCount: number;
  screenshotId: string | null;
  screenshotWidth: number | null;
  screenshotHeight: number | null;
  screenshotCompatible: boolean;
  screenshotNote: string | null;
}

export interface HeatmapReportDto {
  projectId: string;
  groups: HeatmapGroupDto[];
  exclusions: Array<{ reason: string; count: number }>;
  executionIds: string[];
  generatedAt: string;
  dataNote: string;
}

export type HeatmapMode = 'density' | 'markers';

/**
 * Intensity ramp.
 *
 * Stops are spaced so a single isolated click is still clearly visible rather
 * than fading into the background: a map that only lights up for clusters
 * would hide exactly the one-off interactions a small test run produces.
 */
const RAMP: Array<[number, [number, number, number]]> = [
  [0.0, [59, 130, 246]], // blue
  [0.35, [34, 211, 238]], // cyan
  [0.55, [74, 222, 128]], // green
  [0.75, [250, 204, 21]], // amber
  [1.0, [248, 113, 113]], // red
];

function rampColor(t: number): [number, number, number] {
  const clamped = Math.max(0, Math.min(1, t));
  for (let i = 1; i < RAMP.length; i++) {
    const [stop, color] = RAMP[i]!;
    const [prevStop, prevColor] = RAMP[i - 1]!;
    if (clamped <= stop) {
      const f = stop === prevStop ? 0 : (clamped - prevStop) / (stop - prevStop);
      return [
        Math.round(prevColor[0] + (color[0] - prevColor[0]) * f),
        Math.round(prevColor[1] + (color[1] - prevColor[1]) * f),
        Math.round(prevColor[2] + (color[2] - prevColor[2]) * f),
      ];
    }
  }
  return RAMP[RAMP.length - 1]![1];
}

/**
 * Draw the density field.
 *
 * Two passes, which is the standard construction: accumulate each point as a
 * radial alpha falloff into a greyscale buffer, then translate accumulated
 * alpha into the colour ramp. Doing it in one pass with coloured gradients
 * would make overlapping points brighten rather than climb the ramp, so a
 * cluster would look like one strong click instead of several.
 */
export function renderHeatmap(
  canvas: HTMLCanvasElement,
  points: HeatmapPointDto[],
  viewport: { width: number; height: number },
  opts: { radius?: number; intensity?: number } = {},
): void {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  if (points.length === 0 || viewport.width <= 0 || viewport.height <= 0) return;

  const radius = opts.radius ?? Math.max(16, width * 0.045);
  const perPoint = opts.intensity ?? 0.5;

  // Pass 1 - greyscale accumulation.
  ctx.globalCompositeOperation = 'source-over';
  for (const p of points) {
    const cx = (p.x / viewport.width) * width;
    const cy = (p.y / viewport.height) * height;
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    const a = Math.min(1, perPoint * (p.weight || 1));
    gradient.addColorStop(0, `rgba(0,0,0,${a})`);
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  // Pass 2 - colourize by accumulated alpha.
  const image = ctx.getImageData(0, 0, width, height);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3]!;
    if (alpha === 0) continue;
    const [r, g, b] = rampColor(alpha / 255);
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    // Keep the screenshot readable underneath; a fully opaque map hides the
    // very thing the positions are supposed to be explained against.
    data[i + 3] = Math.min(215, alpha);
  }
  ctx.putImageData(image, 0, 0);
}

export function ClickHeatmap({
  group,
  mode,
  onModeChange,
}: {
  group: HeatmapGroupDto;
  mode: HeatmapMode;
  onModeChange: (m: HeatmapMode) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [hovered, setHovered] = useState<HeatmapPointDto | null>(null);

  // The drawing surface must track the rendered size of the frame, so a resize
  // re-renders at the new resolution instead of scaling a stale bitmap.
  useLayoutEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const update = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size || size.width === 0) return;
    canvas.width = size.width;
    canvas.height = size.height;
    if (mode === 'density') {
      renderHeatmap(canvas, group.points, {
        width: group.viewportWidth,
        height: group.viewportHeight,
      });
    } else {
      const ctx = canvas.getContext('2d');
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    }
  }, [group, mode, size]);

  const aspect = group.viewportHeight / Math.max(1, group.viewportWidth);

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <h4 className="text-sm font-medium text-ink-100">
            {group.screenName ?? group.screenId ?? 'Unidentified screen'}
          </h4>
          <Badge tone="info">
            {group.viewportWidth}×{group.viewportHeight}
          </Badge>
          <Badge tone="neutral">{group.deviceId}</Badge>
        </div>
        <div className="flex items-center gap-1">
          {(['density', 'markers'] as const).map((m) => (
            <button
              key={m}
              onClick={() => onModeChange(m)}
              className={`rounded-lg px-2.5 py-1 text-2xs font-medium transition-colors ${
                mode === m ? 'bg-accent-600/20 text-accent-400' : 'bg-surface-800 text-ink-400 hover:text-ink-200'
              }`}
            >
              {m === 'density' ? 'Heatmap' : 'Individual points'}
            </button>
          ))}
        </div>
      </div>

      <div
        ref={frameRef}
        className="relative w-full overflow-hidden rounded-lg bg-surface-850 border border-surface-700"
        style={{ aspectRatio: `${group.viewportWidth} / ${group.viewportHeight}` }}
      >
        {group.screenshotId && group.screenshotCompatible ? (
          <img
            src={screenshotUrl(group.screenshotId)}
            alt=""
            /* contain, not cover: the frame's aspect ratio is set from the
               recorded viewport, so any mismatch must letterbox rather than
               crop — a cropped background would silently move every point. */
            className="absolute inset-0 h-full w-full object-contain object-top"
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center px-6 text-center">
            <p className="text-2xs text-ink-500 max-w-md leading-relaxed">
              {group.screenshotNote ??
                'No compatible screenshot is available, so the positions are shown on a blank frame at the recorded viewport size.'}
            </p>
          </div>
        )}

        <canvas
          ref={canvasRef}
          className="absolute inset-0 h-full w-full pointer-events-none"
          style={{ display: mode === 'density' ? 'block' : 'none' }}
        />

        {mode === 'markers' &&
          group.points.map((p, i) => (
            <button
              key={`${p.executionId}-${i}`}
              className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full"
              style={{
                left: `${(p.x / group.viewportWidth) * 100}%`,
                top: `${(p.y / group.viewportHeight) * 100}%`,
                width: 14,
                height: 14,
                background:
                  p.result === 'failure'
                    ? 'rgba(248,113,113,0.85)'
                    : p.result === 'success'
                      ? 'rgba(74,222,128,0.85)'
                      : 'rgba(148,163,184,0.85)',
                boxShadow: '0 0 0 2px rgba(0,0,0,0.55)',
              }}
              title={`${p.label ?? p.type} · ${p.result} · ${(p.elapsedMs / 1000).toFixed(1)}s`}
              onMouseEnter={() => setHovered(p)}
              onMouseLeave={() => setHovered(null)}
            />
          ))}

        {hovered && (
          <div className="absolute bottom-2 left-2 right-2 rounded bg-black/85 px-2 py-1.5">
            <p className="text-2xs text-ink-100 truncate">{hovered.label ?? hovered.type}</p>
            <p className="text-2xs text-ink-500">
              {Math.round(hovered.x)}, {Math.round(hovered.y)} · {hovered.result} ·{' '}
              {(hovered.elapsedMs / 1000).toFixed(1)}s
            </p>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap text-2xs">
        <span className="text-ink-300 tabular-nums">
          {group.totalPoints} interaction{group.totalPoints === 1 ? '' : 's'}
        </span>
        <span className="text-ink-500">·</span>
        <span className="text-ink-400 tabular-nums">
          {group.sessionCount} session{group.sessionCount === 1 ? '' : 's'}
        </span>
        {group.personaCount > 0 && (
          <>
            <span className="text-ink-500">·</span>
            <span className="text-ink-400 tabular-nums">
              {group.personaCount} persona{group.personaCount === 1 ? '' : 's'}
            </span>
          </>
        )}
        <span className="ml-auto flex items-center gap-2">
          <Legend color="rgba(74,222,128,0.9)" label={`${group.successCount} succeeded`} />
          <Legend color="rgba(248,113,113,0.9)" label={`${group.failureCount} failed`} />
          <Legend color="rgba(148,163,184,0.9)" label={`${group.unverifiedCount} unverified`} />
        </span>
      </div>

      {group.screenshotId && !group.screenshotCompatible && group.screenshotNote && (
        <p className="text-2xs text-warn-400 leading-relaxed">{group.screenshotNote}</p>
      )}
      {!Number.isNaN(aspect) && null}
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-ink-400">
      <span className="h-2 w-2 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

/** Empty state plus the exclusion list, so a blank map always explains itself. */
export function HeatmapEmpty({ report }: { report: HeatmapReportDto | undefined }) {
  return (
    <div>
      <Empty
        title="No positioned interactions yet"
        description="Click and tap positions are recorded during a test run. Run a plan to populate the heatmap."
      />
      {report && report.exclusions.length > 0 && (
        <div className="px-5 pb-4">
          <p className="label mb-1.5">Events that could not contribute</p>
          <ul className="space-y-0.5">
            {report.exclusions.map((x, i) => (
              <li key={i} className="text-2xs text-ink-500">
                · {x.count} × {x.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
