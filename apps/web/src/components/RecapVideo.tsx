import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { videoUrl } from '../lib/api';
import {
  computeVideoBox,
  isMarkerVisible,
  markerPosition,
  videoTimeFor,
  type VideoBox,
} from '../lib/overlay';
import { Badge } from './ui';

/* ------------------------------------------------------------------ *
 * Recap player with click / tap indicators
 *
 * The recording itself is never modified. Markers are DOM elements positioned
 * over the <video>, driven by `currentTime` on every animation frame - which is
 * what keeps them correct through pause, seek, a changed playback rate and
 * replay without any of those needing special handling.
 * ------------------------------------------------------------------ */

export interface InteractionEventDto {
  id: string;
  type: string;
  source: string;
  pointer: string;
  label: string | null;
  targetName: string | null;
  viewportX: number | null;
  viewportY: number | null;
  coordinateStatus: string;
  coordinateNote: string | null;
  viewportWidth: number;
  viewportHeight: number;
  elapsedMs: number;
  videoOffsetMs: number | null;
  result: string;
  resultNote: string | null;
  actionId: string | null;
}

/** How long a marker stays on screen after its moment, in seconds. */
const MARKER_HOLD_S = 1.8;
/** Ripple duration, in seconds. */
const RIPPLE_S = 0.7;

export function RecapVideo({
  executionId,
  videoRef,
  video,
  interactions,
  videoStartOffsetMs,
  timingExact,
  deviceLabel,
}: {
  executionId: string;
  videoRef: RefObject<HTMLVideoElement>;
  video: { status: string; bytes: number; durationMs: number | null; width: number | null; height: number | null; failureReason: string | null } | null;
  interactions: InteractionEventDto[];
  videoStartOffsetMs: number | null;
  timingExact: boolean;
  deviceLabel: string | null;
}) {
  const [showMarkers, setShowMarkers] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [box, setBox] = useState<VideoBox | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number | null>(null);

  const measure = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    setBox(computeVideoBox(v.clientWidth, v.clientHeight, v.videoWidth, v.videoHeight));
  }, [videoRef]);

  // Re-measure whenever the element can change size, not only on window resize:
  // a sidebar collapsing or a panel appearing changes the box without one.
  useLayoutEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(v);
    v.addEventListener('loadedmetadata', measure);
    return () => {
      observer.disconnect();
      v.removeEventListener('loadedmetadata', measure);
    };
  }, [measure, videoRef, video?.status]);

  /**
   * Drive the markers from `currentTime` on every frame.
   *
   * Listening to `timeupdate` instead would fire roughly four times a second,
   * which is visibly coarse for a ripple. Reading the clock each frame also
   * means seeking, pausing and a changed playback rate need no special case:
   * whatever the video says the time is, that is what is drawn.
   */
  useEffect(() => {
    const tick = () => {
      const v = videoRef.current;
      if (v) setCurrentTime(v.currentTime);
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [videoRef]);

  const playable = video && video.status === 'complete' && video.bytes > 0;

  const positioned = interactions.filter(
    (e) => e.coordinateStatus === 'recorded' && (e.type === 'click' || e.type === 'tap'),
  );
  const unpositioned = interactions.length - positioned.length;

  if (!playable) {
    return (
      <div className="rounded-lg bg-surface-850 px-4 py-6 text-center">
        <p className="text-sm text-ink-300">No complete recording for this session</p>
        <p className="text-2xs text-ink-500 mt-1">
          {video?.failureReason ?? 'The run may still be in progress.'}
        </p>
      </div>
    );
  }

  return (
    <div>
      <div ref={wrapRef} className="relative">
        <video
          ref={videoRef}
          src={videoUrl(executionId)}
          controls
          className="w-full rounded-lg bg-black block"
          preload="metadata"
          onLoadedMetadata={measure}
        />

        {/* Overlay never intercepts pointer events: the native controls stay usable. */}
        {showMarkers && box && (
          <div className="absolute inset-0 pointer-events-none overflow-hidden rounded-lg">
            {positioned.map((e) => {
              const at = videoTimeFor(e, videoStartOffsetMs);
              if (!isMarkerVisible(currentTime, at, MARKER_HOLD_S)) return null;
              const age = currentTime - at;
              const pos = markerPosition(e, box);
              if (!pos) return null;
              return (
                <ClickMarker
                  key={e.id}
                  left={pos.left}
                  top={pos.top}
                  age={age}
                  touch={e.pointer === 'touch'}
                  failed={e.result === 'failure'}
                />
              );
            })}
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 flex-wrap mt-2">
        <label className="flex items-center gap-1.5 text-2xs text-ink-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showMarkers}
            onChange={(e) => setShowMarkers(e.target.checked)}
            className="accent-accent-500"
          />
          Click &amp; tap indicators
        </label>
        <span className="text-2xs text-ink-500 tabular-nums">
          {positioned.length} positioned interaction{positioned.length === 1 ? '' : 's'}
        </span>
        {unpositioned > 0 && (
          <Badge
            tone="neutral"
            title="Scrolls, keyboard activations and navigations have no single click position, so they are not drawn on the video."
          >
            {unpositioned} without a position
          </Badge>
        )}
        {deviceLabel && <Badge tone="info">{deviceLabel}</Badge>}
        {!timingExact && (
          <Badge
            tone="warn"
            title="This recording predates video start-offset tracking, so markers are aligned using the execution clock and may run early by the browser's start-up time."
          >
            timing approximate
          </Badge>
        )}
      </div>

      <p className="text-2xs text-ink-500 mt-1.5">
        {((video.bytes ?? 0) / 1_048_576).toFixed(1)} MB ·{' '}
        {Math.round((video.durationMs ?? 0) / 1000)}s · {video.width}×{video.height} · click any
        timeline step to seek
      </p>
    </div>
  );
}

/**
 * One marker.
 *
 * A mouse click and a touch tap get visually distinct treatments - a crosshair
 * ring versus a filled fingertip disc - because "where did the persona press"
 * reads differently on the two, and a report that shows the same glyph for both
 * loses the distinction the recording went to the trouble of capturing.
 */
function ClickMarker({
  left,
  top,
  age,
  touch,
  failed,
}: {
  left: number;
  top: number;
  age: number;
  touch: boolean;
  failed: boolean;
}) {
  // Ripple expands and fades over its first moments, then the dot persists so
  // the position stays readable for a beat afterwards.
  //
  // No text is drawn over the video: a caption covers the very interface the
  // viewer is trying to watch. The action label lives in the timeline beside
  // the player, where it can be read without obscuring anything.
  const t = Math.min(1, age / RIPPLE_S);
  const rippleScale = 0.4 + t * 1.9;
  const rippleOpacity = Math.max(0, 0.75 * (1 - t));
  const settle = Math.min(1, age / 0.18);

  const color = failed ? '#f87171' : touch ? '#60a5fa' : '#a78bfa';
  const size = touch ? 34 : 22;

  return (
    <div className="absolute" style={{ left, top, transform: 'translate(-50%, -50%)' }}>
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          width: size,
          height: size,
          marginLeft: -size / 2,
          marginTop: -size / 2,
          borderRadius: '50%',
          border: `2px solid ${color}`,
          transform: `scale(${rippleScale})`,
          opacity: rippleOpacity,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          width: touch ? 18 : 10,
          height: touch ? 18 : 10,
          marginLeft: touch ? -9 : -5,
          marginTop: touch ? -9 : -5,
          borderRadius: '50%',
          background: color,
          opacity: 0.35 + 0.55 * settle,
          boxShadow: `0 0 0 2px rgba(0,0,0,0.5)`,
        }}
      />
    </div>
  );
}
