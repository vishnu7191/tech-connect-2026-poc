import { z } from 'zod';

/* ------------------------------------------------------------------ *
 * Device profiles
 *
 * A device profile is a BROWSER EMULATION PROFILE, not a physical device.
 * Playwright drives a desktop Chromium with an overridden viewport, device
 * pixel ratio, touch capability and user-agent string. That reproduces layout
 * and touch-target geometry faithfully; it does NOT reproduce a real device's
 * browser engine, GPU, network, input latency, OS gestures or on-screen
 * keyboard. Every profile therefore carries an `emulationNote` that the UI and
 * the reports surface verbatim - the product must never imply that an emulated
 * run is a physical-device run.
 *
 * The static numbers below were read from the Playwright descriptors installed
 * in this repo (`playwright.devices`) on 2026-11-02 so the web UI can render a
 * selector without a round trip. The SERVER always re-resolves the live
 * descriptor by name at launch time and reports a mismatch rather than trusting
 * these copies; see apps/server/src/browser/devices.ts.
 * ------------------------------------------------------------------ */

export const DeviceKind = z.enum(['desktop', 'tablet', 'mobile']);
export type DeviceKind = z.infer<typeof DeviceKind>;

/** Where a profile's geometry came from. Drives how much we trust it. */
export const DeviceProfileSource = z.enum(['preset', 'playwright-descriptor', 'custom']);
export type DeviceProfileSource = z.infer<typeof DeviceProfileSource>;

export const DeviceProfile = z.object({
  /** Stable id persisted with every execution and interaction event. */
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
  kind: DeviceKind,
  width: z.number().int().min(200).max(4000),
  height: z.number().int().min(200).max(4000),
  deviceScaleFactor: z.number().min(0.5).max(5),
  isMobile: z.boolean(),
  hasTouch: z.boolean(),
  /** Null means "use the browser's own UA" - never a fabricated string. */
  userAgent: z.string().max(400).nullable(),
  /** Name of the Playwright descriptor this profile mirrors, when any. */
  playwrightDevice: z.string().max(80).nullable(),
  source: DeviceProfileSource,
  /**
   * Engine the Playwright descriptor was authored for. Lenz runs Chromium for
   * every profile (one engine keeps screenshots and video comparable), so an
   * iOS descriptor is Chromium emulating iOS metrics, not Safari. Recorded so
   * the limitation is visible in the data, not just in prose.
   */
  descriptorBrowser: z.string().max(40).nullable(),
  emulationNote: z.string().max(400),
});
export type DeviceProfile = z.infer<typeof DeviceProfile>;

const CHROMIUM_NOTE =
  'Browser emulation in Chromium: viewport, device pixel ratio, touch input and user-agent only. Not a physical device.';
const CROSS_ENGINE_NOTE =
  'Browser emulation in Chromium using this device’s metrics. The real device runs WebKit, so engine-specific rendering and behaviour are NOT reproduced.';

function preset(p: {
  id: string;
  label: string;
  kind: DeviceKind;
  width: number;
  height: number;
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
  userAgent?: string | null;
  playwrightDevice?: string | null;
  descriptorBrowser?: string | null;
}): DeviceProfile {
  return {
    userAgent: null,
    playwrightDevice: null,
    descriptorBrowser: null,
    source: p.playwrightDevice ? 'playwright-descriptor' : 'preset',
    emulationNote: p.descriptorBrowser === 'webkit' ? CROSS_ENGINE_NOTE : CHROMIUM_NOTE,
    ...p,
  };
}

/**
 * The selectable presets.
 *
 * Generic entries (`desktop-1440`, `tablet-768`, `mobile-390`) use round
 * numbers chosen for comparability across runs. Named entries mirror a
 * Playwright descriptor so the geometry matches a real device family.
 */
export const DEVICE_PRESETS: DeviceProfile[] = [
  preset({
    id: 'desktop-1440',
    label: 'Desktop — 1440 × 900',
    kind: 'desktop',
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  }),
  preset({
    id: 'desktop-1920',
    label: 'Desktop — 1920 × 1080',
    kind: 'desktop',
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  }),
  preset({
    id: 'desktop-1280',
    label: 'Laptop — 1280 × 800',
    kind: 'desktop',
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  }),
  preset({
    id: 'tablet-768',
    label: 'Tablet — 768 × 1024',
    kind: 'tablet',
    width: 768,
    height: 1024,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  }),
  preset({
    id: 'tablet-ipad-mini',
    label: 'iPad Mini',
    kind: 'tablet',
    width: 768,
    height: 1024,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    playwrightDevice: 'iPad Mini',
    descriptorBrowser: 'webkit',
  }),
  preset({
    id: 'tablet-ipad-gen7',
    label: 'iPad (gen 7)',
    kind: 'tablet',
    width: 810,
    height: 1080,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    playwrightDevice: 'iPad (gen 7)',
    descriptorBrowser: 'webkit',
  }),
  preset({
    id: 'tablet-galaxy-tab-s4',
    label: 'Galaxy Tab S4',
    kind: 'tablet',
    width: 712,
    height: 1138,
    deviceScaleFactor: 2.25,
    isMobile: true,
    hasTouch: true,
    playwrightDevice: 'Galaxy Tab S4',
    descriptorBrowser: 'chromium',
  }),
  preset({
    id: 'mobile-390',
    label: 'Mobile — 390 × 844',
    kind: 'mobile',
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  }),
  preset({
    id: 'mobile-iphone-14',
    label: 'iPhone 14',
    kind: 'mobile',
    width: 390,
    height: 664,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    playwrightDevice: 'iPhone 14',
    descriptorBrowser: 'webkit',
  }),
  preset({
    id: 'mobile-pixel-7',
    label: 'Pixel 7 (Android)',
    kind: 'mobile',
    width: 412,
    height: 839,
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    playwrightDevice: 'Pixel 7',
    descriptorBrowser: 'chromium',
  }),
  preset({
    id: 'mobile-pixel-5',
    label: 'Pixel 5 (Android)',
    kind: 'mobile',
    width: 393,
    height: 727,
    deviceScaleFactor: 2.75,
    isMobile: true,
    hasTouch: true,
    playwrightDevice: 'Pixel 5',
    descriptorBrowser: 'chromium',
  }),
];

export const DEFAULT_DEVICE_ID = 'desktop-1440';

export function findDevicePreset(id: string | null | undefined): DeviceProfile | null {
  if (!id) return null;
  return DEVICE_PRESETS.find((d) => d.id === id) ?? null;
}

/** What a client may send when starting a run. Either a preset id or a custom viewport. */
export const DeviceSelection = z.object({
  presetId: z.string().max(64).nullable().optional(),
  custom: z
    .object({
      label: z.string().max(120).optional(),
      kind: DeviceKind.optional(),
      width: z.number().int().min(200).max(4000),
      height: z.number().int().min(200).max(4000),
      deviceScaleFactor: z.number().min(0.5).max(5).optional(),
      hasTouch: z.boolean().optional(),
      isMobile: z.boolean().optional(),
    })
    .nullable()
    .optional(),
});
export type DeviceSelection = z.infer<typeof DeviceSelection>;

/**
 * Classify a custom viewport width.
 *
 * These breakpoints are a reporting convenience only - they group runs in the
 * UI. They are not a claim about any particular device, which is why a custom
 * profile keeps its exact dimensions alongside the label.
 */
export function kindForWidth(width: number): DeviceKind {
  if (width < 600) return 'mobile';
  if (width < 1100) return 'tablet';
  return 'desktop';
}

/** Build a validated profile from a user-supplied custom viewport. */
export function customDeviceProfile(input: {
  label?: string;
  kind?: DeviceKind;
  width: number;
  height: number;
  deviceScaleFactor?: number;
  hasTouch?: boolean;
  isMobile?: boolean;
}): DeviceProfile {
  const kind = input.kind ?? kindForWidth(input.width);
  const hasTouch = input.hasTouch ?? kind !== 'desktop';
  return DeviceProfile.parse({
    id: `custom-${input.width}x${input.height}`,
    label: input.label ?? `Custom — ${input.width} × ${input.height}`,
    kind,
    width: input.width,
    height: input.height,
    deviceScaleFactor: input.deviceScaleFactor ?? (kind === 'desktop' ? 1 : 2),
    isMobile: input.isMobile ?? kind !== 'desktop',
    hasTouch,
    userAgent: null,
    playwrightDevice: null,
    descriptorBrowser: null,
    source: 'custom',
    emulationNote: CHROMIUM_NOTE,
  });
}

/**
 * Resolve a selection to a profile.
 *
 * A custom viewport wins over a preset id when both are supplied, and an
 * unknown preset id falls back to the default rather than throwing - the run
 * still happens, and the profile actually used is persisted with the execution,
 * so the report can never disagree with what was run.
 */
export function resolveDeviceSelection(selection: DeviceSelection | null | undefined): DeviceProfile {
  if (selection?.custom) return customDeviceProfile(selection.custom);
  return findDevicePreset(selection?.presetId) ?? findDevicePreset(DEFAULT_DEVICE_ID)!;
}

/**
 * Minimum comfortable touch target, in CSS pixels.
 *
 * 44 px is the figure published in Apple's Human Interface Guidelines; Google's
 * Material guidance uses 48 dp. Lenz reports a control smaller than this as a
 * CONCERN with the measured size attached - it is a guideline, not a defect,
 * and the report says so.
 */
export const MIN_TOUCH_TARGET_PX = 44;
