import { describe, expect, it } from 'vitest';
import { devices as playwrightDevices } from 'playwright';
import {
  DEFAULT_DEVICE_ID,
  DEVICE_PRESETS,
  DeviceProfile,
  MIN_TOUCH_TARGET_PX,
  customDeviceProfile,
  kindForWidth,
  resolveDeviceSelection,
} from '@lenz/shared';
import {
  contextOptionsFor,
  defaultDeviceProfile,
  listDeviceProfiles,
  resolveDevice,
  withoutMobileEmulation,
} from './devices.js';

/* ------------------------------------------------------------------ *
 * 3. Tablet viewport execution, plus the whole device catalogue
 * ------------------------------------------------------------------ */

describe('device catalogue', () => {
  it('offers at least one profile of each kind', () => {
    const kinds = new Set(listDeviceProfiles().map((d) => d.kind));
    expect(kinds).toEqual(new Set(['desktop', 'tablet', 'mobile']));
  });

  it('includes the tablet preset the brief asks for', () => {
    const tablet = listDeviceProfiles().find((d) => d.id === 'tablet-768')!;
    expect(tablet.width).toBe(768);
    expect(tablet.height).toBe(1024);
    expect(tablet.hasTouch).toBe(true);
  });

  it('includes both an iPhone and an Android mobile profile', () => {
    const mobile = listDeviceProfiles().filter((d) => d.kind === 'mobile');
    expect(mobile.some((d) => /iphone/i.test(d.label))).toBe(true);
    expect(mobile.some((d) => /android|pixel/i.test(d.label))).toBe(true);
  });

  it('every profile validates against the shared schema', () => {
    for (const d of listDeviceProfiles()) {
      expect(() => DeviceProfile.parse(d)).not.toThrow();
    }
  });

  it('has unique ids', () => {
    const ids = listDeviceProfiles().map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * The static table in packages/shared exists only so the web UI can render a
   * selector without a round trip. This asserts the server does not trust it:
   * what it serves must match the Playwright descriptor that will actually run.
   */
  it('resolves named profiles from the installed Playwright build, not the static table', () => {
    for (const profile of listDeviceProfiles()) {
      if (!profile.playwrightDevice) continue;
      const descriptor = (playwrightDevices as Record<string, any>)[profile.playwrightDevice];
      expect(descriptor, `${profile.playwrightDevice} should exist`).toBeTruthy();
      expect(profile.width).toBe(descriptor.viewport.width);
      expect(profile.height).toBe(descriptor.viewport.height);
      expect(profile.deviceScaleFactor).toBe(descriptor.deviceScaleFactor);
      expect(profile.userAgent).toBe(descriptor.userAgent);
    }
  });

  it('records that an iOS descriptor is being emulated in Chromium', () => {
    const ios = listDeviceProfiles().filter((d) => d.descriptorBrowser === 'webkit');
    expect(ios.length).toBeGreaterThan(0);
    for (const d of ios) {
      expect(d.emulationNote).toMatch(/WebKit/i);
    }
  });

  it('never claims a profile is a physical device', () => {
    for (const d of listDeviceProfiles()) {
      expect(d.emulationNote.toLowerCase()).toContain('emulation');
    }
  });
});

describe('device selection', () => {
  it('falls back to the default when no selection is made', () => {
    expect(resolveDevice(null).profile.id).toBe(DEFAULT_DEVICE_ID);
    expect(resolveDevice({}).profile.id).toBe(DEFAULT_DEVICE_ID);
  });

  it('falls back to the default for an unknown preset rather than throwing', () => {
    expect(resolveDevice({ presetId: 'not-a-device' }).profile.id).toBe(DEFAULT_DEVICE_ID);
  });

  it('selects a named preset', () => {
    expect(resolveDevice({ presetId: 'tablet-768' }).profile.kind).toBe('tablet');
  });

  it('lets a custom viewport win over a preset id', () => {
    const resolved = resolveDevice({ presetId: 'desktop-1440', custom: { width: 360, height: 640 } });
    expect(resolved.profile.source).toBe('custom');
    expect(resolved.profile.width).toBe(360);
  });

  it('classifies custom viewports by width', () => {
    expect(kindForWidth(390)).toBe('mobile');
    expect(kindForWidth(768)).toBe('tablet');
    expect(kindForWidth(1440)).toBe('desktop');
  });

  it('enables touch for a custom viewport below the desktop breakpoint', () => {
    expect(customDeviceProfile({ width: 414, height: 896 }).hasTouch).toBe(true);
    expect(customDeviceProfile({ width: 1600, height: 900 }).hasTouch).toBe(false);
  });

  it('honours an explicit touch override on a custom viewport', () => {
    expect(customDeviceProfile({ width: 1600, height: 900, hasTouch: true }).hasTouch).toBe(true);
  });

  it('rejects an out-of-range custom viewport', () => {
    expect(() => customDeviceProfile({ width: 10, height: 10 })).toThrow();
    expect(() => customDeviceProfile({ width: 99_999, height: 500 })).toThrow();
  });

  it('agrees with the shared resolver for preset selections', () => {
    expect(resolveDeviceSelection({ presetId: 'mobile-390' }).id).toBe('mobile-390');
    expect(DEVICE_PRESETS.some((d) => d.id === DEFAULT_DEVICE_ID)).toBe(true);
  });
});

describe('Playwright context options', () => {
  it('passes viewport, scale factor, touch and mobile flags through', () => {
    const profile = listDeviceProfiles().find((d) => d.id === 'mobile-pixel-7')!;
    const opts = contextOptionsFor(profile);
    expect(opts.viewport).toEqual({ width: profile.width, height: profile.height });
    expect(opts.deviceScaleFactor).toBe(profile.deviceScaleFactor);
    expect(opts.hasTouch).toBe(true);
    expect(opts.isMobile).toBe(true);
    expect(opts.userAgent).toBe(profile.userAgent);
  });

  it('omits the user agent when the profile has none, rather than inventing one', () => {
    const opts = contextOptionsFor(defaultDeviceProfile());
    expect(opts.userAgent).toBeUndefined();
  });

  it('can degrade to a context without mobile emulation', () => {
    const profile = listDeviceProfiles().find((d) => d.id === 'mobile-390')!;
    const degraded = withoutMobileEmulation(profile);
    expect(degraded.isMobile).toBe(false);
    // The viewport and touch capability are kept - only the mobile flag goes.
    expect(degraded.hasTouch).toBe(true);
    expect(degraded.viewport).toEqual({ width: profile.width, height: profile.height });
  });
});

describe('touch target guideline', () => {
  it('uses the published 44px minimum', () => {
    expect(MIN_TOUCH_TARGET_PX).toBe(44);
  });
});
