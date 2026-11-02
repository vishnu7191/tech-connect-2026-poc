import { devices as playwrightDevices } from 'playwright';
import {
  DEVICE_PRESETS,
  DEFAULT_DEVICE_ID,
  DeviceProfile,
  customDeviceProfile,
  findDevicePreset,
  type DeviceSelection,
} from '@lenz/shared';
import { logger } from '../core/logger.js';

/**
 * Device profiles, reconciled against the Playwright build actually installed.
 *
 * `packages/shared/src/devices.ts` carries static geometry so the web UI can
 * render a selector without a round trip, but Playwright revises its device
 * descriptors between releases. Copying numbers from memory is exactly the
 * failure mode this repo forbids, so every named profile is re-read from
 * `playwright.devices` here, and a disagreement is logged rather than silently
 * absorbed.
 *
 * Lenz launches CHROMIUM for every profile. Running one engine keeps
 * screenshots, video and coordinates comparable across devices, which is the
 * whole point of the responsive comparison. The cost is that a WebKit-authored
 * descriptor (every iOS entry) is Chromium wearing iOS metrics, not Safari.
 * That is recorded in the profile itself so a report can never imply otherwise.
 */

export interface ResolvedDevice {
  profile: DeviceProfile;
  /** Context options to pass straight to `browser.newContext()`. */
  contextOptions: {
    viewport: { width: number; height: number };
    deviceScaleFactor: number;
    isMobile: boolean;
    hasTouch: boolean;
    userAgent?: string;
  };
}

let reconciled: DeviceProfile[] | null = null;

/** Every selectable profile, with named entries refreshed from Playwright. */
export function listDeviceProfiles(): DeviceProfile[] {
  if (reconciled) return reconciled;

  reconciled = DEVICE_PRESETS.map((preset) => {
    if (!preset.playwrightDevice) return preset;

    const descriptor = (playwrightDevices as Record<string, PlaywrightDescriptor | undefined>)[
      preset.playwrightDevice
    ];
    if (!descriptor?.viewport) {
      logger.warn(
        { preset: preset.id, descriptor: preset.playwrightDevice },
        'Playwright no longer ships this device descriptor; using the recorded geometry and marking the profile as a preset',
      );
      return {
        ...preset,
        source: 'preset' as const,
        playwrightDevice: null,
        emulationNote: `${preset.emulationNote} Playwright no longer ships a "${preset.playwrightDevice}" descriptor, so the recorded geometry is used.`,
      };
    }

    const drifted =
      descriptor.viewport.width !== preset.width ||
      descriptor.viewport.height !== preset.height ||
      descriptor.deviceScaleFactor !== preset.deviceScaleFactor;
    if (drifted) {
      logger.info(
        {
          preset: preset.id,
          recorded: { w: preset.width, h: preset.height, dsf: preset.deviceScaleFactor },
          live: {
            w: descriptor.viewport.width,
            h: descriptor.viewport.height,
            dsf: descriptor.deviceScaleFactor,
          },
        },
        'Playwright device descriptor differs from the recorded geometry; the live descriptor wins',
      );
    }

    return DeviceProfile.parse({
      ...preset,
      width: descriptor.viewport.width,
      height: descriptor.viewport.height,
      deviceScaleFactor: descriptor.deviceScaleFactor ?? preset.deviceScaleFactor,
      isMobile: descriptor.isMobile ?? preset.isMobile,
      hasTouch: descriptor.hasTouch ?? preset.hasTouch,
      userAgent: descriptor.userAgent ?? null,
      descriptorBrowser: descriptor.defaultBrowserType ?? preset.descriptorBrowser,
    });
  });

  return reconciled;
}

interface PlaywrightDescriptor {
  viewport?: { width: number; height: number };
  deviceScaleFactor?: number;
  isMobile?: boolean;
  hasTouch?: boolean;
  userAgent?: string;
  defaultBrowserType?: string;
}

/** Resolve a request's device selection into a profile plus context options. */
export function resolveDevice(selection: DeviceSelection | null | undefined): ResolvedDevice {
  const profile = selection?.custom
    ? customDeviceProfile(selection.custom)
    : (listDeviceProfiles().find((d) => d.id === selection?.presetId) ?? defaultDeviceProfile());
  return { profile, contextOptions: contextOptionsFor(profile) };
}

export function defaultDeviceProfile(): DeviceProfile {
  return (
    listDeviceProfiles().find((d) => d.id === DEFAULT_DEVICE_ID) ??
    findDevicePreset(DEFAULT_DEVICE_ID)!
  );
}

export function contextOptionsFor(profile: DeviceProfile): ResolvedDevice['contextOptions'] {
  return {
    viewport: { width: profile.width, height: profile.height },
    deviceScaleFactor: profile.deviceScaleFactor,
    isMobile: profile.isMobile,
    hasTouch: profile.hasTouch,
    ...(profile.userAgent ? { userAgent: profile.userAgent } : {}),
  };
}

/**
 * Chromium rejects `isMobile` on some platforms when combined with certain
 * options; a run must not be lost to that. The caller retries with this
 * degraded profile and records the downgrade in the execution's notes.
 */
export function withoutMobileEmulation(profile: DeviceProfile): ResolvedDevice['contextOptions'] {
  const opts = contextOptionsFor(profile);
  return { ...opts, isMobile: false };
}
