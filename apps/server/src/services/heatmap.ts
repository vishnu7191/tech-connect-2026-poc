import type {
  HeatmapExclusion,
  HeatmapGroup,
  HeatmapPoint,
  HeatmapReport,
  InteractionEvent,
  ScrollRegion,
  ScrollReport,
  ScrollSample,
  ScrollSummary,
  Screenshot,
} from '@lenz/shared';

/**
 * Heatmap and scroll aggregation.
 *
 * Everything in this file is a PURE FUNCTION over recorded rows. No model is
 * consulted, no coordinate is interpolated, and nothing is smoothed into
 * existence: a heatmap with four points renders four points. The density field
 * the UI draws is computed in the browser from these exact points, so the
 * server never ships a picture that cannot be traced back to individual events.
 *
 * The data describes SYNTHETIC TEST TRAFFIC - a persona Lenz drove through a
 * plan. It is not human behaviour, and every report carries that sentence so a
 * screenshot of the UI cannot be mistaken for real analytics.
 */

export const SYNTHETIC_DATA_NOTE =
  'These positions come from interactions Lenz performed while executing test plans. They are synthetic test traffic, not observations of real users.';

/** Only pointer-positioned activations belong on a click map. */
const HEATMAP_TYPES = new Set(['click', 'tap']);

export interface HeatmapInput {
  projectId: string;
  events: InteractionEvent[];
  screenshots: Screenshot[];
}

/**
 * Group events into one heatmap per (screen, device, viewport geometry).
 *
 * Grouping by geometry is not a convenience - it is a correctness requirement.
 * A 390-wide layout and a 1440-wide layout place the same control in different
 * places, so merging their coordinates would produce a map that describes
 * neither. Grouping is therefore structural, and the UI cannot opt out of it.
 */
export function buildHeatmap(input: HeatmapInput): HeatmapReport {
  const { events, screenshots } = input;
  const exclusions = new Map<string, number>();
  const note = (reason: string) => exclusions.set(reason, (exclusions.get(reason) ?? 0) + 1);

  const groups = new Map<string, HeatmapGroup>();
  const sessionsByGroup = new Map<string, Set<string>>();
  const personasByGroup = new Map<string, Set<string>>();

  for (const e of events) {
    if (!HEATMAP_TYPES.has(e.type)) {
      note(`${e.type} events are not click/tap activations`);
      continue;
    }
    if (e.coordinateStatus !== 'recorded' || e.viewportX === null || e.viewportY === null) {
      note(e.coordinateNote ?? 'no pointer coordinate was recorded');
      continue;
    }
    if (e.viewportWidth <= 0 || e.viewportHeight <= 0) {
      note('the viewport geometry for this event is unusable');
      continue;
    }

    const key = groupKey(e);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        screenId: e.screenId,
        screenName: e.screenName,
        deviceId: e.deviceId,
        deviceKind: e.deviceKind,
        viewportWidth: e.viewportWidth,
        viewportHeight: e.viewportHeight,
        points: [],
        totalPoints: 0,
        successCount: 0,
        failureCount: 0,
        unverifiedCount: 0,
        sessionCount: 0,
        personaCount: 0,
        screenshotId: null,
        screenshotWidth: null,
        screenshotHeight: null,
        screenshotCompatible: false,
        screenshotNote: null,
      };
      groups.set(key, group);
      sessionsByGroup.set(key, new Set());
      personasByGroup.set(key, new Set());
    }

    const point: HeatmapPoint = {
      x: e.viewportX,
      y: e.viewportY,
      weight: 1,
      type: e.type,
      result: e.result,
      label: e.label,
      executionId: e.executionId,
      personaId: e.personaId,
      elapsedMs: e.elapsedMs,
    };
    group.points.push(point);
    group.totalPoints++;
    if (e.result === 'success') group.successCount++;
    else if (e.result === 'failure') group.failureCount++;
    else group.unverifiedCount++;

    sessionsByGroup.get(key)!.add(e.executionId);
    if (e.personaId) personasByGroup.get(key)!.add(e.personaId);
  }

  for (const [key, group] of groups) {
    group.sessionCount = sessionsByGroup.get(key)?.size ?? 0;
    group.personaCount = personasByGroup.get(key)?.size ?? 0;
    attachBackground(group, screenshots);
    // Deterministic ordering so the same inputs always render identically.
    group.points.sort((a, b) =>
      a.elapsedMs - b.elapsedMs || a.x - b.x || a.y - b.y || a.executionId.localeCompare(b.executionId),
    );
  }

  const ordered = [...groups.values()].sort(
    (a, b) => b.totalPoints - a.totalPoints || a.key.localeCompare(b.key),
  );

  return {
    projectId: input.projectId,
    groups: ordered,
    exclusions: [...exclusions.entries()]
      .map(([reason, count]): HeatmapExclusion => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    executionIds: [...new Set(events.map((e) => e.executionId))].sort(),
    generatedAt: new Date().toISOString(),
    dataNote: SYNTHETIC_DATA_NOTE,
  };
}

export function groupKey(e: {
  screenId: string | null;
  deviceId: string;
  viewportWidth: number;
  viewportHeight: number;
}): string {
  return `${e.screenId ?? 'unknown-screen'}|${e.deviceId}|${e.viewportWidth}x${e.viewportHeight}`;
}

/**
 * Choose a screenshot to draw the map over, and judge whether it can be.
 *
 * `Screenshot.width/height` are the CSS viewport the capture was taken at, not
 * the PNG's pixel dimensions, so compatibility is a comparison of CSS geometry.
 * When no compatible image exists the group still carries its points and says
 * why there is no background - a heatmap floating over the wrong screenshot
 * would be worse than one with no screenshot at all.
 */
function attachBackground(group: HeatmapGroup, screenshots: Screenshot[]): void {
  const forScreen = screenshots.filter(
    (s) => s.status === 'valid' && s.source === 'browser' && s.path && s.nodeId === group.screenId,
  );
  if (forScreen.length === 0) {
    group.screenshotNote = 'No validated browser screenshot was captured for this screen.';
    return;
  }

  const exact = forScreen.filter(
    (s) => s.width === group.viewportWidth && s.height === group.viewportHeight,
  );
  if (exact.length > 0) {
    // Latest capture: most likely to show the screen in its settled state.
    const chosen = exact[exact.length - 1]!;
    group.screenshotId = chosen.id;
    group.screenshotWidth = chosen.width;
    group.screenshotHeight = chosen.height;
    group.screenshotCompatible = true;
    return;
  }

  const sameWidth = forScreen.filter((s) => s.width === group.viewportWidth);
  const fallback = (sameWidth.length > 0 ? sameWidth : forScreen)[
    (sameWidth.length > 0 ? sameWidth : forScreen).length - 1
  ]!;
  group.screenshotId = fallback.id;
  group.screenshotWidth = fallback.width;
  group.screenshotHeight = fallback.height;
  group.screenshotCompatible = false;
  group.screenshotNote =
    `The available screenshot was captured at ${fallback.width}x${fallback.height} CSS px but these interactions were recorded at ` +
    `${group.viewportWidth}x${group.viewportHeight}. Overlaying them would misplace every point, so the markers are listed instead of drawn.`;
}

/* ------------------------------------------------------------------ *
 * Scroll analytics
 * ------------------------------------------------------------------ */

/**
 * Number of bands the document is divided into for region exposure.
 *
 * Ten gives a readable "how far down did they get" profile without implying
 * more precision than samples taken every 120 ms can support.
 */
export const SCROLL_REGION_COUNT = 10;

export interface ScrollInput {
  projectId: string;
  samples: ScrollSample[];
}

export function buildScrollReport(input: ScrollInput): ScrollReport {
  const buckets = new Map<string, ScrollSample[]>();
  for (const s of input.samples) {
    const key = `${s.screenId ?? 'unknown-screen'}|${s.deviceId}|${s.viewportHeight}|${s.container}`;
    const list = buckets.get(key);
    if (list) list.push(s);
    else buckets.set(key, [s]);
  }

  const summaries = [...buckets.entries()]
    .map(([key, samples]) => summarizeScroll(key, samples))
    .sort((a, b) => b.sampleCount - a.sampleCount || a.key.localeCompare(b.key));

  return {
    projectId: input.projectId,
    summaries,
    executionIds: [...new Set(input.samples.map((s) => s.executionId))].sort(),
    generatedAt: new Date().toISOString(),
    dataNote: SYNTHETIC_DATA_NOTE,
  };
}

export function summarizeScroll(key: string, samples: ScrollSample[]): ScrollSummary {
  const first = samples[0]!;
  const sessions = new Set(samples.map((s) => s.executionId));

  const measurable = samples.filter((s) => s.depthFraction !== null);
  const unmeasured = samples.length - measurable.length;

  const documentHeights = samples
    .map((s) => s.documentHeight)
    .filter((h): h is number => h !== null && h > 0);
  const documentHeight = documentHeights.length > 0 ? Math.max(...documentHeights) : null;

  const maxDepthFraction =
    measurable.length > 0 ? Math.max(...measurable.map((s) => s.depthFraction!)) : null;

  // Mean of each SESSION's deepest point, not of every sample. Averaging raw
  // samples would make a session that paused near the top look shallower than
  // it was, because dwell produces more samples at that position.
  const perSessionMax = new Map<string, number>();
  for (const s of measurable) {
    const current = perSessionMax.get(s.executionId);
    if (current === undefined || s.depthFraction! > current) {
      perSessionMax.set(s.executionId, s.depthFraction!);
    }
  }
  const meanDepthFraction =
    perSessionMax.size > 0
      ? [...perSessionMax.values()].reduce((a, b) => a + b, 0) / perSessionMax.size
      : null;

  const scrollable = samples.some(
    (s) => s.documentHeight !== null && s.documentHeight > s.viewportHeight + 1,
  );

  return {
    key,
    screenId: first.screenId,
    screenName: first.screenName,
    deviceId: first.deviceId,
    deviceKind: first.deviceKind,
    viewportHeight: first.viewportHeight,
    documentHeight,
    maxScrollY: Math.max(...samples.map((s) => s.scrollY), 0),
    maxDepthFraction,
    meanDepthFraction,
    sessionCount: sessions.size,
    sampleCount: samples.length,
    totalDwellMs: samples.reduce((a, s) => a + s.dwellMs, 0),
    scrollable,
    regions: computeRegions(samples, documentHeight),
    note: buildScrollNote(first.container, unmeasured, samples.length),
  };
}

function buildScrollNote(container: string, unmeasured: number, total: number): string | null {
  const parts: string[] = [];
  if (container !== 'window') {
    parts.push(`Measured on a nested scroll container (${container}), not the page itself.`);
  }
  if (unmeasured > 0) {
    parts.push(
      `${unmeasured} of ${total} samples could not be converted to a depth because the document height was not measurable at that moment; they are excluded from the depth figures rather than counted as zero.`,
    );
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

/**
 * Exposure per page region.
 *
 * `exposureMs` is the time a band was AT LEAST PARTLY INSIDE THE VIEWPORT.
 * That is what the scroll position can actually tell us. It is explicitly NOT a
 * claim that the persona looked at the band, and the UI must not label it as
 * attention - no eye position was measured, and Lenz does not report unmeasured
 * visibility as observed behaviour.
 *
 * A dynamically changing document height is handled by measuring each sample
 * against the tallest height seen for the screen, so a band does not move
 * underneath the data when lazy content loads.
 */
export function computeRegions(
  samples: ScrollSample[],
  documentHeight: number | null,
): ScrollRegion[] {
  if (documentHeight === null || documentHeight <= 0) return [];

  const bandHeight = documentHeight / SCROLL_REGION_COUNT;
  const exposure = new Array<number>(SCROLL_REGION_COUNT).fill(0);
  const reached = Array.from({ length: SCROLL_REGION_COUNT }, () => new Set<string>());

  for (const s of samples) {
    const top = s.scrollY;
    const bottom = s.scrollY + s.viewportHeight;
    const firstBand = Math.max(0, Math.floor(top / bandHeight));
    const lastBand = Math.min(SCROLL_REGION_COUNT - 1, Math.floor((bottom - 1) / bandHeight));
    for (let b = firstBand; b <= lastBand; b++) {
      exposure[b] = (exposure[b] ?? 0) + s.dwellMs;
      reached[b]!.add(s.executionId);
    }
  }

  return exposure.map((ms, i) => ({
    fromFraction: i / SCROLL_REGION_COUNT,
    toFraction: (i + 1) / SCROLL_REGION_COUNT,
    exposureMs: Math.round(ms),
    sessionsReached: reached[i]!.size,
  }));
}
