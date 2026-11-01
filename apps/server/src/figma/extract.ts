import type {
  ClassificationSignal,
  DeviceClass,
  EdgeKind,
  FigmaNavigation,
  FigmaTrigger,
  ScreenClassification,
  UnsupportedReason,
} from '@lenz/shared';
import type { FigmaCanvas, FigmaFileResponse, FigmaNode } from './types.js';
import { classifyNode } from './classify.js';

/* ------------------------------------------------------------------ *
 * Raw extraction output (pre-persistence)
 * ------------------------------------------------------------------ */

export interface ExtractedScreen {
  nodeId: string;
  name: string;
  canvasId: string;
  canvasName: string;
  nodeType: string;
  classification: ScreenClassification;
  classificationScore: number;
  classificationSignals: ClassificationSignal[];
  deviceClass: DeviceClass;
  width: number;
  height: number;
  absX: number;
  absY: number;
}

export interface ExtractedEdge {
  fromNodeId: string;
  toNodeId: string;
  kind: EdgeKind;
  figmaNavigation: FigmaNavigation;
  trigger: FigmaTrigger;
  sourceNodeId: string;
  sourceNodeName: string;
  sourceAbsX: number | null;
  sourceAbsY: number | null;
  sourceAbsW: number | null;
  sourceAbsH: number | null;
  supported: boolean;
  unsupportedReason: UnsupportedReason | null;
}

export interface ExtractedFlow {
  nodeId: string;
  name: string;
  canvasId: string;
  canvasName: string;
  isPrototypeStart: boolean;
}

export interface DeadInteraction {
  nodeId: string;
  nodeName: string;
  trigger: FigmaTrigger;
  ownerNodeId: string;
}

export interface ExtractionResult {
  screens: ExtractedScreen[];
  edges: ExtractedEdge[];
  flows: ExtractedFlow[];
  /** Triggers wired up with no destination - they look interactive but do nothing. */
  deadInteractions: DeadInteraction[];
  /** True when traversal hit a depth or node-count guard, so results are partial. */
  truncated: boolean;
  /** Total interaction ACTIONS seen, including ones we cannot execute. */
  totalInteractionActions: number;
  /** Actions referencing a destination we could not resolve to a known node. */
  unresolvedDestinations: number;
  canvases: Array<{ id: string; name: string; hasEntryPoint: boolean; childCount: number }>;
}

/* ------------------------------------------------------------------ *
 * Navigation mode -> edge kind  (ADR-0001)
 *
 * Measured on Rosella: 740 CHANGE_TO vs 435 NAVIGATE. Treating every
 * interaction as a screen transition would be wrong 59% of the time.
 * ------------------------------------------------------------------ */

const EDGE_KIND_BY_NAVIGATION: Record<string, EdgeKind> = {
  NAVIGATE: 'screen',
  OVERLAY: 'overlay',
  SWAP: 'overlay',
  SWAP_STATE: 'ui-state',
  CHANGE_TO: 'ui-state',
  SCROLL_TO: 'ui-state',
};

const KNOWN_TRIGGERS = new Set<string>([
  'ON_CLICK',
  'ON_HOVER',
  'ON_PRESS',
  'ON_DRAG',
  'DRAG',
  'AFTER_TIMEOUT',
  'MOUSE_ENTER',
  'MOUSE_LEAVE',
  'MOUSE_UP',
  'MOUSE_DOWN',
  'ON_KEY_DOWN',
  'ON_MEDIA_HIT',
  'ON_MEDIA_END',
]);

/** Triggers Lenz cannot deterministically execute in a browser. */
const UNSUPPORTED_TRIGGERS: Partial<Record<string, UnsupportedReason>> = {
  AFTER_TIMEOUT: 'timeout-trigger-not-executable',
  DRAG: 'drag-trigger-not-executable',
  ON_DRAG: 'drag-trigger-not-executable',
  ON_MEDIA_HIT: 'conditional-logic',
  ON_MEDIA_END: 'conditional-logic',
};

function normalizeTrigger(raw: string | undefined): FigmaTrigger {
  if (!raw) return 'UNKNOWN';
  return (KNOWN_TRIGGERS.has(raw) ? raw : 'UNKNOWN') as FigmaTrigger;
}

function normalizeNavigation(raw: string | undefined): FigmaNavigation {
  if (raw && raw in EDGE_KIND_BY_NAVIGATION) return raw as FigmaNavigation;
  return 'NAVIGATE';
}

/* ------------------------------------------------------------------ *
 * Extraction
 * ------------------------------------------------------------------ */

/**
 * Guards against pathological documents.
 *
 * Figma trees are normally shallow (the Rosella file is 9 deep), but a
 * malformed or hostile payload must not be able to blow the stack or hang the
 * worker. Traversal is bounded on BOTH depth and total node count, and a
 * visited-set prevents a cycle from looping forever.
 */
export const MAX_TREE_DEPTH = 100;
export const MAX_NODES_VISITED = 500_000;

export function extractFromFile(
  file: FigmaFileResponse,
  opts: { canvases?: FigmaCanvas[] } = {},
): ExtractionResult {
  // Callers that have already validated the document pass its canvases in;
  // otherwise filter defensively here. Both paths tolerate nulls.
  const canvases =
    opts.canvases ??
    (Array.isArray(file?.document?.children) ? file.document.children : []).filter(
      (c): c is FigmaCanvas => Boolean(c) && c.type === 'CANVAS' && Array.isArray(c.children),
    );

  const truncation = { depthExceeded: false, nodeLimitExceeded: false };
  let visitedCount = 0;

  /* Pass 1: flows, plus a map from every node id to its owning top-level node. */
  const flows: ExtractedFlow[] = [];
  const flowStartIds = new Set<string>();
  const ownerOfNode = new Map<string, string>();
  const topLevelOfCanvas = new Map<string, { canvas: FigmaCanvas; node: FigmaNode }>();

  for (const canvas of canvases) {
    if (canvas.prototypeStartNodeID) flowStartIds.add(canvas.prototypeStartNodeID);
    for (const fsp of canvas.flowStartingPoints ?? []) {
      flowStartIds.add(fsp.nodeId);
      flows.push({
        nodeId: fsp.nodeId,
        name: fsp.name,
        canvasId: canvas.id,
        canvasName: canvas.name,
        isPrototypeStart: canvas.prototypeStartNodeID === fsp.nodeId,
      });
    }
    for (const top of canvas.children ?? []) {
      if (!top) continue;
      topLevelOfCanvas.set(top.id, { canvas, node: top });
      indexOwnership(top, top.id, ownerOfNode, 0, new Set());
    }
  }

  /* Pass 2: collect every interaction action, resolved to owning screens. */
  const rawEdges: ExtractedEdge[] = [];
  const deadInteractions: DeadInteraction[] = [];
  let totalInteractionActions = 0;
  let unresolvedDestinations = 0;

  const collect = (n: FigmaNode, depth = 0) => {
    if (!n) return;
    if (depth > MAX_TREE_DEPTH) { truncation.depthExceeded = true; return; }
    if (++visitedCount > MAX_NODES_VISITED) { truncation.nodeLimitExceeded = true; return; }
    const owner = ownerOfNode.get(n.id);
    for (const interaction of n.interactions ?? []) {
      // Figma can serialize a null interaction; skip defensively.
      if (!interaction) continue;
      const trigger = normalizeTrigger(interaction.trigger?.type);
      for (const action of interaction.actions ?? []) {
        totalInteractionActions++;

        /**
         * Figma returns `"actions": [null]` for a trigger that was wired up but
         * never given a destination - observed on a real file where 9 of 76
         * actions were null, e.g. {"trigger":{"type":"ON_CLICK"},"actions":[null]}.
         *
         * That is a control which LOOKS interactive but does nothing, so it is
         * counted and reported as a dead interaction rather than being silently
         * dropped (and, previously, crashing on `action.type`).
         */
        if (!action) {
          deadInteractions.push({
            nodeId: n.id,
            nodeName: n.name ?? n.id,
            trigger,
            ownerNodeId: owner ?? n.id,
          });
          continue;
        }

        if (action.type !== 'NODE' || !action.destinationId) {
          // URL / BACK / CLOSE actions are counted but are not graph edges.
          continue;
        }
        const navigation = normalizeNavigation(action.navigation);
        const kind = EDGE_KIND_BY_NAVIGATION[navigation] ?? 'screen';

        // Resolve the destination to its owning top-level node, so a deep
        // variant target still attributes to the correct screen.
        const destOwner = ownerOfNode.get(action.destinationId) ?? action.destinationId;
        const fromOwner = owner ?? n.id;
        if (!ownerOfNode.has(action.destinationId)) unresolvedDestinations++;

        const box = n.absoluteBoundingBox ?? null;
        const unsupportedReason: UnsupportedReason | null =
          UNSUPPORTED_TRIGGERS[trigger] ?? (box ? null : 'missing-geometry');

        rawEdges.push({
          fromNodeId: fromOwner,
          toNodeId: kind === 'screen' ? destOwner : action.destinationId,
          kind,
          figmaNavigation: navigation,
          trigger,
          sourceNodeId: n.id,
          sourceNodeName: n.name,
          sourceAbsX: box?.x ?? null,
          sourceAbsY: box?.y ?? null,
          sourceAbsW: box?.width ?? null,
          sourceAbsH: box?.height ?? null,
          supported: !unsupportedReason,
          unsupportedReason,
        });
      }
    }
    const kids = Array.isArray(n.children) ? n.children : [];
    for (const c of kids) if (c) collect(c, depth + 1);
  };

  for (const canvas of canvases) for (const top of canvas.children ?? []) if (top) collect(top);

  /* Pass 3: which top-level nodes receive a NAVIGATE edge (classifier input). */
  const inboundNavigate = new Set<string>();
  for (const e of rawEdges) if (e.kind === 'screen') inboundNavigate.add(e.toNodeId);

  /* Pass 4: classify every top-level node. */
  const screens: ExtractedScreen[] = [];
  for (const [nodeId, entry] of topLevelOfCanvas) {
    const result = classifyNode({
      node: entry.node,
      isFlowStart: flowStartIds.has(nodeId),
      hasInboundNavigate: inboundNavigate.has(nodeId),
    });
    const box = entry.node.absoluteBoundingBox;
    screens.push({
      nodeId,
      name: entry.node.name,
      canvasId: entry.canvas.id,
      canvasName: entry.canvas.name,
      nodeType: entry.node.type,
      classification: result.classification,
      classificationScore: result.score,
      classificationSignals: result.signals,
      deviceClass: result.deviceClass,
      width: box?.width ?? 0,
      height: box?.height ?? 0,
      absX: box?.x ?? 0,
      absY: box?.y ?? 0,
    });
  }

  /* Pass 5: deduplicate. The same control repeated across variants produces
     identical edges; collapse them but keep one representative. */
  const seen = new Set<string>();
  const edges: ExtractedEdge[] = [];
  for (const e of rawEdges) {
    const key = [e.fromNodeId, e.toNodeId, e.kind, e.trigger, e.sourceNodeId].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    // Screen-level self-loops carry no navigation meaning.
    if (e.kind === 'screen' && e.fromNodeId === e.toNodeId) continue;
    edges.push(e);
  }

  return {
    screens,
    edges,
    flows,
    deadInteractions,
    truncated: truncation.depthExceeded || truncation.nodeLimitExceeded,
    totalInteractionActions,
    unresolvedDestinations,
    canvases: canvases.map((c) => ({
      id: c.id,
      name: c.name,
      hasEntryPoint: Boolean(c.prototypeStartNodeID) || (c.flowStartingPoints?.length ?? 0) > 0,
      childCount: (c.children ?? []).length,
    })),
  };
}

function indexOwnership(
  node: FigmaNode,
  owner: string,
  out: Map<string, string>,
  depth: number,
  seen: Set<string>,
): void {
  // Depth and cycle guards: a malformed tree must not blow the stack.
  if (!node || depth > MAX_TREE_DEPTH) return;
  if (node.id) {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    out.set(node.id, owner);
  }
  const kids = Array.isArray(node.children) ? node.children : [];
  for (const c of kids) if (c) indexOwnership(c, owner, out, depth + 1, seen);
}
