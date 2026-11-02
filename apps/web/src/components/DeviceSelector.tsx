import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Badge, Field } from './ui';

/* ------------------------------------------------------------------ *
 * Device selection
 *
 * The catalogue comes from the server, which reconciles it against the
 * installed Playwright build. Hard-coding the list here would eventually offer
 * a profile that no longer exists or whose geometry has changed.
 * ------------------------------------------------------------------ */

export interface DeviceProfileDto {
  id: string;
  label: string;
  kind: 'desktop' | 'tablet' | 'mobile';
  width: number;
  height: number;
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
  userAgent: string | null;
  playwrightDevice: string | null;
  descriptorBrowser: string | null;
  source: string;
  emulationNote: string;
}

export interface DeviceCatalogue {
  devices: DeviceProfileDto[];
  defaultDeviceId: string;
  note: string;
}

/** What the caller sends to the execute endpoint. */
export interface DeviceSelectionValue {
  presetId: string | null;
  custom: { width: number; height: number; kind?: string; hasTouch?: boolean } | null;
}

export function useDeviceCatalogue() {
  return useQuery({
    queryKey: ['devices'],
    queryFn: () => api.get<DeviceCatalogue>('/devices'),
    // The catalogue only changes when the server restarts with a new Playwright.
    staleTime: 10 * 60_000,
  });
}

export const KIND_LABEL: Record<string, string> = {
  desktop: 'Desktop',
  tablet: 'Tablet',
  mobile: 'Mobile web',
};

const CUSTOM = '__custom__';

export function DeviceSelector({
  value,
  onChange,
  disabled,
}: {
  value: DeviceSelectionValue;
  onChange: (v: DeviceSelectionValue) => void;
  disabled?: boolean;
}) {
  const catalogue = useDeviceCatalogue();
  const [customWidth, setCustomWidth] = useState(414);
  const [customHeight, setCustomHeight] = useState(896);

  const devices = catalogue.data?.devices ?? [];
  const byKind = useMemo(() => {
    const groups: Record<string, DeviceProfileDto[]> = { desktop: [], tablet: [], mobile: [] };
    for (const d of devices) groups[d.kind]?.push(d);
    return groups;
  }, [devices]);

  const isCustom = value.custom !== null;
  const selected = isCustom ? null : devices.find((d) => d.id === value.presetId);

  const applyCustom = (width: number, height: number) => {
    const w = clamp(width, 200, 4000);
    const h = clamp(height, 200, 4000);
    setCustomWidth(w);
    setCustomHeight(h);
    onChange({ presetId: null, custom: { width: w, height: h } });
  };

  return (
    <div className="space-y-2.5">
      <Field label="Device">
        <select
          className="input"
          disabled={disabled || catalogue.isLoading}
          value={isCustom ? CUSTOM : (value.presetId ?? catalogue.data?.defaultDeviceId ?? '')}
          onChange={(e) => {
            if (e.target.value === CUSTOM) applyCustom(customWidth, customHeight);
            else onChange({ presetId: e.target.value, custom: null });
          }}
        >
          {(['desktop', 'tablet', 'mobile'] as const).map((kind) =>
            byKind[kind] && byKind[kind]!.length > 0 ? (
              <optgroup key={kind} label={KIND_LABEL[kind]}>
                {byKind[kind]!.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label} — {d.width}×{d.height} @{d.deviceScaleFactor}x
                  </option>
                ))}
              </optgroup>
            ) : null,
          )}
          <optgroup label="Custom">
            <option value={CUSTOM}>Custom viewport…</option>
          </optgroup>
        </select>
      </Field>

      {isCustom && (
        <div className="flex items-end gap-2">
          <div className="w-24">
            <Field label="Width">
              <input
                type="number"
                className="input"
                min={200}
                max={4000}
                value={customWidth}
                disabled={disabled}
                onChange={(e) => applyCustom(Number(e.target.value) || 200, customHeight)}
              />
            </Field>
          </div>
          <span className="text-ink-500 pb-2.5">×</span>
          <div className="w-24">
            <Field label="Height">
              <input
                type="number"
                className="input"
                min={200}
                max={4000}
                value={customHeight}
                disabled={disabled}
                onChange={(e) => applyCustom(customWidth, Number(e.target.value) || 200)}
              />
            </Field>
          </div>
          <p className="text-2xs text-ink-500 pb-2.5">
            Classified by width: under 600 mobile, under 1100 tablet, otherwise desktop.
          </p>
        </div>
      )}

      {selected && <DeviceNote device={selected} />}
      {isCustom && (
        <p className="text-2xs text-ink-500 leading-relaxed">
          Browser emulation in Chromium at {customWidth}×{customHeight}. Touch input is enabled
          below 1100px wide. This is not a physical device.
        </p>
      )}
    </div>
  );
}

/**
 * The emulation caveat, shown wherever a device is chosen or displayed.
 *
 * Deliberately not collapsible: the one claim this feature must never make is
 * that an emulated run is a real-device run.
 */
export function DeviceNote({ device }: { device: DeviceProfileDto }) {
  return (
    <div className="rounded-lg bg-surface-850 px-3 py-2.5">
      <div className="flex items-center gap-2 flex-wrap">
        <Badge tone="info">{KIND_LABEL[device.kind] ?? device.kind}</Badge>
        <span className="text-2xs font-mono text-ink-400">
          {device.width}×{device.height} · DPR {device.deviceScaleFactor}
        </span>
        {device.hasTouch && <Badge tone="neutral">touch</Badge>}
        {device.playwrightDevice && (
          <Badge tone="neutral" title="Geometry taken from this Playwright device descriptor">
            {device.playwrightDevice}
          </Badge>
        )}
      </div>
      <p className="text-2xs text-ink-500 mt-1.5 leading-relaxed">{device.emulationNote}</p>
    </div>
  );
}

/** Compact inline badge for a device recorded on a past run. */
export function DeviceChip({
  device,
  title,
}: {
  device: { label: string; kind: string; width: number; height: number } | null;
  title?: string;
}) {
  if (!device) {
    return (
      <Badge tone="warn" title="This run predates device selection, so no viewport was recorded.">
        device not recorded
      </Badge>
    );
  }
  return (
    <Badge tone="info" title={title ?? `${device.width}×${device.height} CSS px (emulated)`}>
      {device.label}
    </Badge>
  );
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(v) ? v : min));
}
