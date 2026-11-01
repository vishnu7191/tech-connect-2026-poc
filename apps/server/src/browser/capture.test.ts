import { describe, it, expect } from 'vitest';
import {
  assessBlankness,
  mapToViewport,
  BLANK_BYTES_PER_PIXEL,
  SOLID_FILL_BYTES_PER_PIXEL,
} from './capture.js';

/**
 * Calibrated against REAL measurements taken from this project at 1440x900.
 * See the comment block in capture.ts for the full table.
 */
const VIEWPORT = { width: 1440, height: 900 };
const MEASURED = {
  solidFill: 5_934, // a genuinely unpainted page
  searchFrame: 7_597, // 390x30 frame - sparse but genuinely rendered
  loginPhone: 11_993, // 195x380 frame
  homePage: 462_558, // full Rosella home screen
};

describe('assessBlankness - calibration against measured captures', () => {
  const at = (bytes: number) => assessBlankness(bytes, VIEWPORT.width, VIEWPORT.height);

  it('treats a solid-colour fill as blank', () => {
    expect(at(MEASURED.solidFill).nonBlank).toBe(false);
  });

  it('accepts the full home page as definitely not blank', () => {
    const r = at(MEASURED.homePage);
    expect(r.nonBlank).toBe(true);
    expect(r.sparse).toBe(false);
  });

  it('accepts a sparse-but-real frame instead of failing it', () => {
    // The earlier threshold rejected this genuinely-rendered 390x30 frame.
    const r = at(MEASURED.searchFrame);
    expect(r.nonBlank).toBe(true);
    expect(r.sparse).toBe(true);
  });

  it('flags a small phone-sized frame as sparse but valid', () => {
    const r = at(MEASURED.loginPhone);
    expect(r.nonBlank).toBe(true);
    expect(r.sparse).toBe(true);
  });

  it('keeps the blank threshold above the measured solid-fill floor', () => {
    expect(BLANK_BYTES_PER_PIXEL).toBeGreaterThan(SOLID_FILL_BYTES_PER_PIXEL);
  });

  it('reports a zero-byte capture as blank', () => {
    expect(at(0).nonBlank).toBe(false);
  });
});

describe('mapToViewport - Figma canvas coordinates to click points', () => {
  const viewport = { width: 1440, height: 900 };

  it('maps a target inside a 1:1 frame to its centre', () => {
    const p = mapToViewport({
      frame: { absX: 0, absY: 0, width: 1440, height: 5446 },
      target: { absX: 144, absY: 460, width: 240, height: 64 },
      viewport,
    });
    expect(p).not.toBeNull();
    expect(p!.scale).toBe(1);
    expect(p!.x).toBeCloseTo(264, 0); // 144 + 240/2
    expect(p!.y).toBeCloseTo(492, 0); // 460 + 64/2
  });

  it('accounts for a frame offset on the canvas', () => {
    const p = mapToViewport({
      frame: { absX: 1000, absY: 2000, width: 1440, height: 3000 },
      target: { absX: 1100, absY: 2100, width: 100, height: 50 },
      viewport,
    });
    expect(p!.x).toBeCloseTo(150, 0); // (1100-1000) + 50
    expect(p!.y).toBeCloseTo(125, 0); // (2100-2000) + 25
  });

  it('scales down a frame wider than the viewport', () => {
    const p = mapToViewport({
      frame: { absX: 0, absY: 0, width: 2880, height: 1800 },
      target: { absX: 1440, absY: 900, width: 100, height: 100 },
      viewport,
    });
    expect(p!.scale).toBeCloseTo(0.5, 3);
    expect(p!.x).toBeCloseTo(745, 0); // (1440 + 50) * 0.5
  });

  it('centres a frame narrower than the viewport', () => {
    const p = mapToViewport({
      frame: { absX: 0, absY: 0, width: 390, height: 844 },
      target: { absX: 0, absY: 0, width: 390, height: 100 },
      viewport,
    });
    // Offset by (1440-390)/2 = 525, plus half the target width.
    expect(p!.x).toBeCloseTo(720, 0);
  });

  it('returns null for a degenerate frame rather than guessing a point', () => {
    expect(
      mapToViewport({
        frame: { absX: 0, absY: 0, width: 0, height: 0 },
        target: { absX: 10, absY: 10, width: 10, height: 10 },
        viewport,
      }),
    ).toBeNull();
  });
});
