/* ------------------------------------------------------------------ *
 * Overlay geometry and timeline synchronization
 *
 * Pure functions, deliberately kept out of the React component so they can be
 * tested directly. These are the two places this feature is most likely to be
 * subtly wrong - a marker off by the letterbox bar, or a marker a second early
 * because the recording started after the run did - and both are invisible
 * unless something asserts them.
 * ------------------------------------------------------------------ */

export interface TimedEvent {
  /** Offset from the first video frame, when it was measured. */
  videoOffsetMs: number | null;
  /** Offset from the execution clock origin. Always present. */
  elapsedMs: number;
}

export interface PositionedEvent {
  viewportX: number | null;
  viewportY: number | null;
  viewportWidth: number;
  viewportHeight: number;
}

export interface VideoBox {
  /** Offset of the rendered picture inside the element, in CSS px. */
  offsetX: number;
  offsetY: number;
  /** Size of the rendered picture, excluding letterbox bars. */
  renderedWidth: number;
  renderedHeight: number;
}

/**
 * Place an event on the video's own timeline, in seconds.
 *
 * Preference order matters. `videoOffsetMs` was measured against the first
 * video frame and is exact. Failing that, the execution offset minus the
 * recording's start offset reconstructs it. With neither - a recording made
 * before the offset was tracked - the raw execution offset is used, and the
 * caller must label the result approximate: recording begins after the run
 * does, so that fallback always runs early.
 */
export function videoTimeFor(event: TimedEvent, videoStartOffsetMs: number | null): number {
  if (event.videoOffsetMs !== null && event.videoOffsetMs !== undefined) {
    return Math.max(0, event.videoOffsetMs / 1000);
  }
  if (videoStartOffsetMs !== null && videoStartOffsetMs !== undefined) {
    return Math.max(0, (event.elapsedMs - videoStartOffsetMs) / 1000);
  }
  return Math.max(0, event.elapsedMs / 1000);
}

/**
 * Where the picture actually sits inside the <video> element.
 *
 * A <video> letterboxes with `object-fit: contain`, so the picture is centred
 * inside the element with bars on two sides whenever the aspect ratios differ -
 * which they do as soon as the layout is responsive. Positioning a marker
 * against the ELEMENT rather than the PICTURE puts every marker off by the bar
 * width, and the error changes as the window resizes.
 *
 * Returns null when any dimension is still unknown (metadata not loaded,
 * element not laid out) so the caller draws nothing instead of drawing wrongly.
 */
export function computeVideoBox(
  elementWidth: number,
  elementHeight: number,
  intrinsicWidth: number,
  intrinsicHeight: number,
): VideoBox | null {
  if (
    !Number.isFinite(elementWidth) ||
    !Number.isFinite(elementHeight) ||
    !Number.isFinite(intrinsicWidth) ||
    !Number.isFinite(intrinsicHeight) ||
    elementWidth <= 0 ||
    elementHeight <= 0 ||
    intrinsicWidth <= 0 ||
    intrinsicHeight <= 0
  ) {
    return null;
  }
  const scale = Math.min(elementWidth / intrinsicWidth, elementHeight / intrinsicHeight);
  const renderedWidth = intrinsicWidth * scale;
  const renderedHeight = intrinsicHeight * scale;
  return {
    offsetX: (elementWidth - renderedWidth) / 2,
    offsetY: (elementHeight - renderedHeight) / 2,
    renderedWidth,
    renderedHeight,
  };
}

/**
 * Convert a recorded viewport coordinate into a position on the player.
 *
 * Normalizing through a 0..1 fraction of the RECORDED viewport, rather than
 * mapping pixels to pixels, is what makes this independent of the device pixel
 * ratio and of whatever size Playwright settled on for the recording. A phone
 * profile records at 390 CSS px with a DPR of 3 and the video may be any size;
 * the fraction is identical in all of them.
 */
export function markerPosition(
  event: PositionedEvent,
  box: VideoBox,
): { left: number; top: number } | null {
  if (event.viewportX === null || event.viewportY === null) return null;
  if (event.viewportWidth <= 0 || event.viewportHeight <= 0) return null;
  // Clamp: a coordinate just outside the viewport should pin to the edge rather
  // than float over the letterbox bar as though it were part of the page.
  const fx = Math.max(0, Math.min(1, event.viewportX / event.viewportWidth));
  const fy = Math.max(0, Math.min(1, event.viewportY / event.viewportHeight));
  return {
    left: box.offsetX + fx * box.renderedWidth,
    top: box.offsetY + fy * box.renderedHeight,
  };
}

/**
 * Seek target for an execution action, in seconds.
 *
 * Action offsets come from the execution clock, which starts before the
 * recording does; subtracting the recording's start offset is what makes
 * "click a step, land on that moment" actually land on it.
 */
/**
 * How far before the interaction to start playing, in seconds.
 *
 * Seeking exactly onto the press drops the viewer at the instant the screen is
 * about to change, so the thing they asked to see is already half over. A short
 * lead-in means they see the screen as it was, the marker appear, and then the
 * transition it caused.
 */
export const SEEK_PREROLL_S = 0.8;

export function seekTimeFor(
  actionOffsetMs: number,
  videoStartOffsetMs: number | null,
  prerollS: number = SEEK_PREROLL_S,
): number {
  if (!Number.isFinite(actionOffsetMs)) return 0;
  const adjusted = videoStartOffsetMs === null ? actionOffsetMs : actionOffsetMs - videoStartOffsetMs;
  return Math.max(0, adjusted / 1000 - prerollS);
}

/** Whether a marker should be visible at the player's current time. */
export function isMarkerVisible(
  currentTimeS: number,
  markerTimeS: number,
  holdS: number,
): boolean {
  const age = currentTimeS - markerTimeS;
  return age >= 0 && age <= holdS;
}
