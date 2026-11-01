import type { FigmaUrlKind, FigmaUrlSupport, ParsedFigmaUrl } from '@lenz/shared';
import { invalidUrl } from '../core/errors.js';

/**
 * Figma URL parsing and classification.
 *
 * This is the product's front door: whatever a user pastes arrives here first.
 * The goal is that NO input produces a confusing failure. Every outcome is
 * either a usable plan or a specific, actionable explanation - never
 * "unrecognized URL" when we can say something more useful.
 *
 * It is also the SSRF gate: only hosts allowed here are ever opened.
 */

export const ALLOWED_FIGMA_HOSTS = new Set(['figma.com', 'www.figma.com']);

/** Figma Make renders its app on this suffix; resolved dynamically per file. */
export const MAKE_PREVIEW_HOST_SUFFIX = '.figma.site';

/** Figma file keys are URL-safe base62-ish tokens. */
const FILE_KEY_PATTERN = /^[A-Za-z0-9]{10,64}$/;

interface KindSpec {
  kind: FigmaUrlKind;
  support: FigmaUrlSupport;
  supportsRestDiscovery: boolean;
  note: string;
  blocked?: string;
}

/**
 * Path segment -> what Lenz can do with it.
 * Confirmed segments: file, design, proto, board, slides, deck, make.
 */
const KIND_BY_SEGMENT: Record<string, KindSpec> = {
  proto: {
    kind: 'proto',
    support: 'full',
    supportsRestDiscovery: true,
    note: 'Clickable prototype. Lenz can discover screens, build the navigation graph, and run browser-verified usability tests.',
  },
  design: {
    kind: 'design',
    support: 'structural',
    supportsRestDiscovery: true,
    note: 'Design file. Lenz can extract the screen inventory, but a design link has no prototype flows, so navigation testing is unavailable. Open it as a prototype (/proto/ link) to test journeys.',
  },
  file: {
    kind: 'file',
    support: 'structural',
    supportsRestDiscovery: true,
    note: 'Legacy design link. Lenz can extract the screen inventory, but there are no prototype flows to traverse.',
  },
  make: {
    kind: 'make',
    support: 'browser-only',
    supportsRestDiscovery: false,
    note: 'Figma Make application. Lenz drives the live app in a browser and records meaningful UI states, including ones that do not change the URL.',
  },
  board: {
    kind: 'board',
    support: 'structural',
    supportsRestDiscovery: true,
    note: 'FigJam board. Lenz can read its structure, but a board is not an interactive product surface, so personas and journey testing do not apply.',
  },
  slides: {
    kind: 'slides',
    support: 'structural',
    supportsRestDiscovery: true,
    note: 'Figma Slides deck. Lenz can read its structure, but slides are linear content rather than a navigable interface.',
  },
  deck: {
    kind: 'deck',
    support: 'structural',
    supportsRestDiscovery: true,
    note: 'Figma Slides in presentation view. Lenz can read its structure, but slides are linear content rather than a navigable interface.',
  },
};

export function isAllowedFigmaHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return ALLOWED_FIGMA_HOSTS.has(h) || h.endsWith(MAKE_PREVIEW_HOST_SUFFIX);
}

/** URLs may use `1-2`; the REST API and node ids use `1:2`. Both are accepted. */
export function normalizeNodeId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = decodeURIComponent(raw.trim());
  if (!trimmed) return null;
  // Only treat it as a node id if it looks like one; junk becomes null rather
  // than a bogus id that would silently fail downstream.
  if (!/^[0-9]+[:-][0-9]+$/.test(trimmed) && !/^[0-9]+$/.test(trimmed)) return null;
  return trimmed.replace(/-/g, ':');
}

/** Inverse of normalizeNodeId - for building prototype URLs. */
export function nodeIdToUrlForm(nodeId: string): string {
  return nodeId.replace(/:/g, '-');
}

/**
 * Parse and classify any Figma URL.
 *
 * Absence of `node-id` is NOT an error - it selects the Scenario B
 * (no declared starting point) discovery path.
 */
export function parseFigmaUrl(input: string): ParsedFigmaUrl {
  const raw = (input ?? '').trim();
  if (!raw) throw invalidUrl('Paste a Figma link to get started.');

  const url = toUrl(raw);

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw invalidUrl('Only http(s) links are supported.', { protocol: url.protocol });
  }

  if (!isAllowedFigmaHost(url.hostname)) {
    throw invalidUrl(
      `Lenz only opens figma.com links, and "${url.hostname}" is not one.`,
      { hostname: url.hostname },
    );
  }

  // An embed wrapper carries the real link in ?url=...
  const embedded = url.pathname.replace(/\/+$/, '') === '/embed' ? url.searchParams.get('url') : null;
  if (embedded) return parseFigmaUrl(embedded);

  const segments = url.pathname.split('/').filter(Boolean);

  if (segments.length === 0) {
    throw invalidUrl(
      'That is the Figma home page, not a file. Open the file you want to test and copy its link from the address bar.',
    );
  }

  // Community listings use a different id space and cannot be read by file key.
  if (segments[0] === 'community') {
    throw invalidUrl(
      'That is a Figma Community listing, not a file you own. Open it in Figma, choose "Open in Figma" or "Duplicate", then paste the link of your own copy.',
      { kind: 'community' },
    );
  }

  const segment = segments[0]!;
  const spec = KIND_BY_SEGMENT[segment];

  if (!spec) {
    throw invalidUrl(
      `Lenz does not recognise "/${segment}/" Figma links. Supported links are prototypes (/proto/), designs (/design/ or /file/), Figma Make apps (/make/), FigJam boards (/board/) and Slides (/slides/).`,
      { pathname: url.pathname, segment },
    );
  }

  const fileKey = segments[1];
  if (!fileKey) {
    throw invalidUrl(
      'That link is missing its file key. Open the file in Figma and copy the full link from the address bar.',
      { pathname: url.pathname },
    );
  }

  if (!FILE_KEY_PATTERN.test(fileKey)) {
    throw invalidUrl(
      `"${fileKey}" does not look like a Figma file key. Copy the whole link from the Figma address bar, without editing it.`,
      { fileKey },
    );
  }

  // The name segment is optional (embed and shortened links often omit it).
  const fileName = segments[2]
    ? safeDecode(segments[2]).replace(/[-_]+/g, ' ').trim() || null
    : null;

  const startNodeId =
    normalizeNodeId(url.searchParams.get('node-id')) ??
    normalizeNodeId(url.searchParams.get('node_id'));

  return {
    kind: spec.kind,
    fileKey,
    fileName,
    startNodeId,
    pageId: normalizeNodeId(url.searchParams.get('page-id')),
    codeNodeId: normalizeNodeId(url.searchParams.get('code-node-id')),
    branchId: url.searchParams.get('branch-id'),
    originalUrl: raw,
    hasExplicitStartPoint: startNodeId !== null,
    supportsRestDiscovery: spec.supportsRestDiscovery,
    support: spec.support,
    supportNote: spec.note,
    blockedReason: spec.blocked ?? null,
  };
}

/** Accept links pasted without a scheme, e.g. "figma.com/proto/...". */
function toUrl(raw: string): URL {
  try {
    return new URL(raw);
  } catch {
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
      try {
        return new URL(`https://${raw}`);
      } catch {
        /* fall through */
      }
    }
    throw invalidUrl('That does not look like a valid link.', { input: raw.slice(0, 120) });
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Build a prototype URL pointing at a specific node (used for direct capture). */
export function buildPrototypeUrl(
  fileKey: string,
  fileName: string | null,
  nodeId: string,
  opts: { scaling?: string; hideUi?: boolean } = {},
): string {
  const slug = (fileName ?? 'prototype').replace(/\s+/g, '-');
  const u = new URL(`https://www.figma.com/proto/${fileKey}/${encodeURIComponent(slug)}`);
  u.searchParams.set('node-id', nodeIdToUrlForm(nodeId));
  if (opts.scaling) u.searchParams.set('scaling', opts.scaling);
  if (opts.hideUi) u.searchParams.set('hide-ui', '1');
  return u.toString();
}

/** Read the node id the viewer is currently showing, from its URL. (ADR-0004) */
export function extractNodeIdFromViewerUrl(viewerUrl: string): string | null {
  try {
    return normalizeNodeId(new URL(viewerUrl).searchParams.get('node-id'));
  } catch {
    return null;
  }
}
