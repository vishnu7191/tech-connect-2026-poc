import { describe, expect, it } from 'vitest';
import {
  SEEK_PREROLL_S,
  computeVideoBox,
  isMarkerVisible,
  markerPosition,
  seekTimeFor,
  videoTimeFor,
} from './overlay.js';

/* ------------------------------------------------------------------ *
 * 6. Video timeline synchronization
 * ------------------------------------------------------------------ */

describe('video timeline synchronization', () => {
  it('prefers the measured video offset', () => {
    expect(videoTimeFor({ videoOffsetMs: 2500, elapsedMs: 4000 }, 1500)).toBe(2.5);
  });

  it('reconstructs the video time from the recording start offset', () => {
    // The run started 1.5s before the first frame, so an action 4s into the run
    // is 2.5s into the video.
    expect(videoTimeFor({ videoOffsetMs: null, elapsedMs: 4000 }, 1500)).toBe(2.5);
  });

  it('falls back to the raw execution offset when nothing else is known', () => {
    expect(videoTimeFor({ videoOffsetMs: null, elapsedMs: 4000 }, null)).toBe(4);
  });

  it('never produces a negative time', () => {
    expect(videoTimeFor({ videoOffsetMs: null, elapsedMs: 500 }, 1500)).toBe(0);
    expect(videoTimeFor({ videoOffsetMs: -10, elapsedMs: 0 }, null)).toBe(0);
  });

  it('maps an execution offset onto video time', () => {
    // prerollS: 0 isolates the mapping from the deliberate lead-in below.
    expect(seekTimeFor(10_000, 1500, 0)).toBe(8.5);
    expect(seekTimeFor(10_000, null, 0)).toBe(10);
    expect(seekTimeFor(500, 1500, 0)).toBe(0);
    expect(seekTimeFor(Number.NaN, 1500, 0)).toBe(0);
  });

  it('starts playback shortly BEFORE the interaction, so the click can be watched', () => {
    // Landing exactly on the press drops the viewer at the instant the screen
    // is already changing; the lead-in shows the screen, the marker, then the
    // transition it caused.
    expect(seekTimeFor(10_000, 1500)).toBeCloseTo(8.5 - SEEK_PREROLL_S, 6);
    expect(SEEK_PREROLL_S).toBeGreaterThan(0);
  });

  it('never seeks before the start of the recording', () => {
    expect(seekTimeFor(200, 0)).toBe(0);
    expect(seekTimeFor(0, null)).toBe(0);
  });

  it('round-trips: the marker time is the interaction, the seek leads it', () => {
    const videoStartOffsetMs = 1800;
    const actionOffsetMs = 7300;
    // The recorder derived videoOffsetMs from the same two numbers, so the
    // marker sits exactly on the interaction and the seek sits one preroll
    // ahead of it - never after, which would skip the thing being inspected.
    const interaction = { videoOffsetMs: actionOffsetMs - videoStartOffsetMs, elapsedMs: actionOffsetMs };
    const markerT = videoTimeFor(interaction, videoStartOffsetMs);
    const seekT = seekTimeFor(actionOffsetMs, videoStartOffsetMs);
    expect(seekT).toBeCloseTo(markerT - SEEK_PREROLL_S, 6);
    expect(seekT).toBeLessThan(markerT);
  });

  it('shows a marker only within its hold window', () => {
    expect(isMarkerVisible(5, 5, 1.8)).toBe(true);
    expect(isMarkerVisible(6.5, 5, 1.8)).toBe(true);
    expect(isMarkerVisible(7.0, 5, 1.8)).toBe(false);
    // Seeking backwards past the marker hides it again.
    expect(isMarkerVisible(4.9, 5, 1.8)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 5. Coordinate normalization, including letterboxing and resize
 * ------------------------------------------------------------------ */

describe('video box', () => {
  it('fills the element when the aspect ratios match', () => {
    const box = computeVideoBox(720, 450, 1440, 900)!;
    expect(box.offsetX).toBe(0);
    expect(box.offsetY).toBe(0);
    expect(box.renderedWidth).toBe(720);
    expect(box.renderedHeight).toBe(450);
  });

  it('letterboxes vertically when the element is taller than the video', () => {
    // 1440x900 (16:10) inside a 720x600 box scales to 720x450, leaving 75px
    // bars top and bottom.
    const box = computeVideoBox(720, 600, 1440, 900)!;
    expect(box.offsetX).toBe(0);
    expect(box.offsetY).toBe(75);
    expect(box.renderedHeight).toBe(450);
  });

  it('pillarboxes when the element is wider than the video', () => {
    // A phone recording (390x844) inside a wide box.
    const box = computeVideoBox(800, 844, 390, 844)!;
    expect(box.renderedWidth).toBe(390);
    expect(box.offsetX).toBe(205);
    expect(box.offsetY).toBe(0);
  });

  it('returns null while dimensions are still unknown', () => {
    expect(computeVideoBox(0, 450, 1440, 900)).toBeNull();
    expect(computeVideoBox(720, 450, 0, 0)).toBeNull();
    expect(computeVideoBox(Number.NaN, 450, 1440, 900)).toBeNull();
  });
});

describe('marker positioning', () => {
  const desktopEvent = {
    viewportX: 720,
    viewportY: 450,
    viewportWidth: 1440,
    viewportHeight: 900,
  };

  it('places a centre click at the centre of the rendered picture', () => {
    const box = computeVideoBox(720, 450, 1440, 900)!;
    expect(markerPosition(desktopEvent, box)).toEqual({ left: 360, top: 225 });
  });

  it('accounts for letterbox bars', () => {
    const box = computeVideoBox(720, 600, 1440, 900)!;
    // Horizontally centred, vertically centred inside the 450px picture that
    // starts 75px down.
    expect(markerPosition(desktopEvent, box)).toEqual({ left: 360, top: 300 });
  });

  it('rescales when the player is resized', () => {
    const small = markerPosition(desktopEvent, computeVideoBox(720, 450, 1440, 900)!)!;
    const large = markerPosition(desktopEvent, computeVideoBox(1440, 900, 1440, 900)!)!;
    expect(large.left).toBeCloseTo(small.left * 2, 6);
    expect(large.top).toBeCloseTo(small.top * 2, 6);
  });

  /**
   * The device-pixel-ratio case. A phone profile records at 390 CSS px with a
   * DPR of 3, so the underlying frames are 1170px across. Markers are recorded
   * in CSS px, and normalizing through a fraction is what keeps them correct
   * whatever size the video turns out to be.
   */
  it('is independent of the device pixel ratio and the recorded video size', () => {
    const tap = { viewportX: 195, viewportY: 422, viewportWidth: 390, viewportHeight: 844 };
    const atCssSize = markerPosition(tap, computeVideoBox(390, 844, 390, 844)!)!;
    const atDprSize = markerPosition(tap, computeVideoBox(390, 844, 1170, 2532)!)!;
    expect(atDprSize.left).toBeCloseTo(atCssSize.left, 6);
    expect(atDprSize.top).toBeCloseTo(atCssSize.top, 6);
    expect(atCssSize).toEqual({ left: 195, top: 422 });
  });

  it('clamps a coordinate outside the viewport to the edge of the picture', () => {
    const box = computeVideoBox(720, 450, 1440, 900)!;
    const outside = { viewportX: 2000, viewportY: -40, viewportWidth: 1440, viewportHeight: 900 };
    expect(markerPosition(outside, box)).toEqual({ left: 720, top: 0 });
  });

  it('draws nothing for an event with no recorded position', () => {
    const box = computeVideoBox(720, 450, 1440, 900)!;
    expect(
      markerPosition({ viewportX: null, viewportY: null, viewportWidth: 1440, viewportHeight: 900 }, box),
    ).toBeNull();
  });

  it('draws nothing when the recorded viewport is unusable', () => {
    const box = computeVideoBox(720, 450, 1440, 900)!;
    expect(markerPosition({ viewportX: 10, viewportY: 10, viewportWidth: 0, viewportHeight: 0 }, box)).toBeNull();
  });
});
