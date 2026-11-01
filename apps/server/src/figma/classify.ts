import type { ClassificationSignal, DeviceClass, ScreenClassification } from '@lenz/shared';
import type { FigmaNode } from './types.js';

/**
 * ADR-0002: a top-level frame is NOT automatically a screen.
 *
 * Measured on the Rosella file: of 102 top-level children on the Mockup canvas,
 * a large share are COMPONENT_SETs (Heart, XS, "Add to bag", ei:arrow-left).
 * Counting those as screens would roughly double the screen count and corrupt
 * every downstream coverage percentage.
 *
 * The classifier is a transparent scoring function: every signal that fired is
 * recorded so the verdict can be audited and overridden in the UI, rather than
 * being an opaque guess.
 */

export interface ClassifyInput {
  node: FigmaNode;
  /** Node is a declared flow starting point or prototype start node. */
  isFlowStart: boolean;
  /** Node is the destination of at least one NAVIGATE edge. */
  hasInboundNavigate: boolean;
}

export interface ClassifyResult {
  classification: ScreenClassification;
  score: number;
  signals: ClassificationSignal[];
  deviceClass: DeviceClass;
}

/** Common device widths seen in Figma files, with tolerance. */
const DEVICE_WIDTHS: Array<{ min: number; max: number; cls: DeviceClass; label: string }> = [
  { min: 320, max: 480, cls: 'mobile', label: 'mobile width' },
  { min: 744, max: 1024, cls: 'tablet', label: 'tablet width' },
  { min: 1200, max: 1920, cls: 'desktop', label: 'desktop width' },
];

const COMPONENT_NAME_PATTERNS = [
  /\bicon\b/i,
  /\bbutton\b/i,
  /\barrow\b/i,
  /\bcheck\s?(box|mark)\b/i,
  /\bheart\b/i,
  /^(xs|s|m|l|xl|xxl)(\s|_|$)/i,
  /\bquantity\b/i,
  /\bqty\b/i,
  /property\s*\d*\s*=/i,
  /\bvariant\b/i,
  /:/, // iconify-style names such as "ei:arrow-left"
];

const SCREEN_NAME_PATTERNS = [
  /\bhome\b/i,
  /\blogin\b/i,
  /\bsign\s?(up|in)\b/i,
  /\bregister\b/i,
  /\bcart\b/i,
  /\bcheckout\b/i,
  /\baccount\b/i,
  /\bprofile\b/i,
  /\bdetails?\b/i,
  /\bsearch\b/i,
  /\bwishlist\b/i,
  /\bpolicy\b/i,
  /\bterms\b/i,
  /\babout\b/i,
  /\bshop\b/i,
  /\bmenu\b/i,
];

function deviceClassFor(width: number, height: number): { cls: DeviceClass; label: string | null } {
  for (const d of DEVICE_WIDTHS) {
    if (width >= d.min && width <= d.max) return { cls: d.cls, label: d.label };
  }
  // Small and roughly square/portrait => likely an overlay/dialog surface.
  if (width >= 180 && width <= 1100 && height >= 180 && height <= 1100) {
    return { cls: 'overlay', label: null };
  }
  return { cls: 'unknown', label: null };
}

export function classifyNode(input: ClassifyInput): ClassifyResult {
  const { node, isFlowStart, hasInboundNavigate } = input;
  const signals: ClassificationSignal[] = [];
  let score = 0;

  const box = node.absoluteBoundingBox;
  const width = box?.width ?? 0;
  const height = box?.height ?? 0;
  const area = width * height;

  const add = (signal: string, weight: number, detail?: string) => {
    signals.push(detail ? { signal, weight, detail } : { signal, weight });
    score += weight;
  };

  /* ---- Decisive positives ------------------------------------------------ */

  // A declared flow starting point is a screen by definition - Figma says so.
  if (isFlowStart) add('declared-flow-start', 100, 'Declared as a prototype flow starting point');
  if (hasInboundNavigate) add('inbound-navigate-edge', 40, 'Another screen navigates to this node');

  /* ---- Node type --------------------------------------------------------- */

  switch (node.type) {
    case 'COMPONENT_SET':
      // A variant container. Never a screen on its own.
      add('type-component-set', -80, 'COMPONENT_SET is a variant container, not a screen');
      break;
    case 'FRAME':
      add('type-frame', 15, 'FRAME is the usual container for a screen');
      break;
    case 'COMPONENT':
    case 'INSTANCE':
      // Rosella's Login screen is a COMPONENT - eligible, but weaker evidence.
      add('type-component', 5, `${node.type} can be a screen but is often a reusable part`);
      break;
    default:
      add('type-other', -30, `${node.type} is not a screen container`);
  }

  /* ---- Geometry ---------------------------------------------------------- */

  const device = deviceClassFor(width, height);
  if (device.label) {
    add('device-width', 35, `${Math.round(width)}px matches ${device.label}`);
  }

  if (area > 0 && area < 40000) {
    add('tiny-area', -45, `${Math.round(width)}x${Math.round(height)} is control-sized`);
  } else if (height > 1500) {
    // Long scrolling pages are a strong screen signal.
    add('tall-page', 20, `${Math.round(height)}px tall suggests a scrollable page`);
  }

  if (!box) add('no-geometry', -20, 'Node has no absolute bounding box');

  /* ---- Naming ------------------------------------------------------------ */

  const name = node.name ?? '';
  if (COMPONENT_NAME_PATTERNS.some((re) => re.test(name))) {
    add('component-name-pattern', -35, `Name "${name}" looks like a component`);
  }
  if (SCREEN_NAME_PATTERNS.some((re) => re.test(name))) {
    add('screen-name-pattern', 20, `Name "${name}" looks like a screen`);
  }

  /* ---- Verdict ----------------------------------------------------------- */

  let classification: ScreenClassification;
  if (score >= 40) classification = 'screen';
  else if (score <= 0) classification = 'component';
  else classification = 'ambiguous';

  return { classification, score, signals, deviceClass: device.cls };
}
