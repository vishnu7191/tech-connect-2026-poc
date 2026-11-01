import type { ClassificationSignal, EntryPointKind, EntryPointSource } from '@lenz/shared';

/**
 * Pure graph analysis. No I/O, no database, no network - this module takes a
 * screen inventory and typed edges and returns conclusions. That purity is
 * deliberate: this is the most logic-dense part of Lenz and the part most worth
 * testing exhaustively.
 */

export interface GraphNodeInput {
  nodeId: string;
  name: string;
  canvasId: string;
  canvasName: string;
  classification: 'screen' | 'component' | 'ambiguous';
  deviceClass: string;
  width: number;
  height: number;
  absX: number;
  absY: number;
}

export interface GraphEdgeInput {
  fromNodeId: string;
  toNodeId: string;
  kind: 'screen' | 'overlay' | 'ui-state';
  supported: boolean;
}

export interface FlowInput {
  nodeId: string;
  name: string;
  isPrototypeStart: boolean;
}

/* ------------------------------------------------------------------ *
 * Adjacency
 * ------------------------------------------------------------------ */

export interface Adjacency {
  out: Map<string, Set<string>>;
  in: Map<string, Set<string>>;
}

/**
 * Build adjacency from SCREEN edges only.
 *
 * ADR-0001: ui-state and overlay edges are real and tracked, but they do not
 * move the user to a different screen, so they must not contribute to
 * reachability. Including them would make nearly everything look reachable.
 */
export function buildAdjacency(
  nodeIds: Iterable<string>,
  edges: GraphEdgeInput[],
  kinds: ReadonlyArray<'screen' | 'overlay' | 'ui-state'> = ['screen'],
): Adjacency {
  const kindSet = new Set(kinds);
  const out = new Map<string, Set<string>>();
  const inc = new Map<string, Set<string>>();
  for (const id of nodeIds) {
    out.set(id, new Set());
    inc.set(id, new Set());
  }
  for (const e of edges) {
    if (!kindSet.has(e.kind)) continue;
    if (!out.has(e.fromNodeId) || !out.has(e.toNodeId)) continue; // endpoint not a tracked screen
    out.get(e.fromNodeId)!.add(e.toNodeId);
    inc.get(e.toNodeId)!.add(e.fromNodeId);
  }
  return { out, in: inc };
}

/* ------------------------------------------------------------------ *
 * Reachability (BFS)
 * ------------------------------------------------------------------ */

export function reachableFrom(adj: Adjacency, starts: string[]): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const s of starts) {
    if (adj.out.has(s) && !seen.has(s)) {
      seen.add(s);
      queue.push(s);
    }
  }
  while (queue.length) {
    const cur = queue.shift()!;
    for (const next of adj.out.get(cur) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/**
 * Shortest click-path between two screens (BFS = fewest hops).
 * Returns null when no path exists.
 */
export function shortestPath(adj: Adjacency, from: string, to: string): string[] | null {
  if (from === to) return [from];
  if (!adj.out.has(from) || !adj.out.has(to)) return null;
  const prev = new Map<string, string>();
  const seen = new Set<string>([from]);
  const queue: string[] = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const next of adj.out.get(cur) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      prev.set(next, cur);
      if (next === to) {
        const path: string[] = [to];
        let p: string | undefined = cur;
        while (p !== undefined) {
          path.push(p);
          p = prev.get(p);
        }
        return path.reverse();
      }
      queue.push(next);
    }
  }
  return null;
}

/**
 * Weakly connected components over screen edges - these are the independent
 * flows a prototype contains.
 */
export function weaklyConnectedComponents(
  nodeIds: string[],
  adj: Adjacency,
): string[][] {
  const seen = new Set<string>();
  const components: string[][] = [];
  for (const start of nodeIds) {
    if (seen.has(start)) continue;
    const comp: string[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const cur = stack.pop()!;
      comp.push(cur);
      const neighbours = [...(adj.out.get(cur) ?? []), ...(adj.in.get(cur) ?? [])];
      for (const n of neighbours) {
        if (!seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    components.push(comp.sort());
  }
  // Largest flow first - the main journey is usually the biggest component.
  return components.sort((a, b) => b.length - a.length);
}

/* ------------------------------------------------------------------ *
 * Entry point ranking
 * ------------------------------------------------------------------ */

export interface RankedEntryPoint {
  nodeId: string;
  name: string;
  kind: EntryPointKind;
  source: EntryPointSource;
  flowName: string | null;
  score: number;
  rank: number;
  signals: ClassificationSignal[];
}

const ENTRY_NAME_PATTERNS: Array<{ re: RegExp; weight: number; label: string }> = [
  { re: /\bhome\b/i, weight: 30, label: 'named like a home screen' },
  { re: /\blanding\b/i, weight: 28, label: 'named like a landing screen' },
  { re: /\bsplash\b/i, weight: 25, label: 'named like a splash screen' },
  { re: /\bstart\b/i, weight: 22, label: 'named like a start screen' },
  { re: /\blogin\b|\bsign\s?in\b/i, weight: 18, label: 'named like an auth entry' },
  { re: /\bonboard/i, weight: 18, label: 'named like onboarding' },
];

/**
 * Rank entry points.
 *
 * Confirmed entries come from Figma itself (prototypeStartNodeID,
 * flowStartingPoints) and always outrank inferred candidates. Lenz never
 * promotes a guess to a confirmed start, and never assumes the first frame is
 * the entry point - that is why inferred candidates keep a distinct `kind`.
 */
export function rankEntryPoints(params: {
  screens: GraphNodeInput[];
  edges: GraphEdgeInput[];
  flows: FlowInput[];
  /** Node id supplied in the URL, if any (Scenario A). */
  urlStartNodeId: string | null;
}): RankedEntryPoint[] {
  const { screens, edges, flows, urlStartNodeId } = params;
  const screenOnly = screens.filter((s) => s.classification !== 'component');
  const ids = screenOnly.map((s) => s.nodeId);
  const adj = buildAdjacency(ids, edges, ['screen']);
  const byId = new Map(screenOnly.map((s) => [s.nodeId, s]));

  const results = new Map<string, RankedEntryPoint>();

  const put = (
    nodeId: string,
    kind: EntryPointKind,
    source: EntryPointSource,
    flowName: string | null,
    baseScore: number,
    signals: ClassificationSignal[],
  ) => {
    const existing = results.get(nodeId);
    // A node can be both the URL start and a declared flow start - keep the
    // strongest evidence rather than double-counting it.
    if (existing && existing.score >= baseScore) return;
    const screen = byId.get(nodeId);
    results.set(nodeId, {
      nodeId,
      name: screen?.name ?? nodeId,
      kind,
      source,
      flowName,
      score: baseScore,
      rank: 0,
      signals,
    });
  };

  /* ---- Confirmed entries ------------------------------------------------ */

  for (const flow of flows) {
    if (!byId.has(flow.nodeId)) continue;
    put(
      flow.nodeId,
      'confirmed',
      flow.isPrototypeStart ? 'prototypeStartNodeID' : 'flowStartingPoint',
      flow.name,
      flow.isPrototypeStart ? 1000 : 900,
      [
        {
          signal: flow.isPrototypeStart ? 'prototype-start-node' : 'declared-flow',
          weight: flow.isPrototypeStart ? 1000 : 900,
          detail: flow.isPrototypeStart
            ? 'Declared as the prototype start node by Figma'
            : `Declared as flow starting point "${flow.name}"`,
        },
      ],
    );
  }

  if (urlStartNodeId && byId.has(urlStartNodeId)) {
    put(urlStartNodeId, 'confirmed', 'urlStartNode', null, 1100, [
      {
        signal: 'url-start-node',
        weight: 1100,
        detail: 'Supplied explicitly in the prototype URL',
      },
    ]);
  }

  /* ---- Inferred candidates ---------------------------------------------- */

  // Only screens not already reachable from a confirmed entry are worth
  // proposing: a screen already covered by a known flow is not a new entry.
  const confirmedIds = [...results.values()]
    .filter((r) => r.kind === 'confirmed')
    .map((r) => r.nodeId);
  const covered = reachableFrom(adj, confirmedIds);

  for (const screen of screenOnly) {
    if (results.has(screen.nodeId)) continue;
    if (covered.has(screen.nodeId)) continue;

    const signals: ClassificationSignal[] = [];
    let score = 0;
    const add = (signal: string, weight: number, detail: string) => {
      signals.push({ signal, weight, detail });
      score += weight;
    };

    const inDeg = adj.in.get(screen.nodeId)?.size ?? 0;
    const outDeg = adj.out.get(screen.nodeId)?.size ?? 0;

    if (inDeg === 0) add('no-inbound-navigation', 40, 'Nothing navigates to this screen');
    else add('has-inbound-navigation', -25, `${inDeg} screen(s) navigate here`);

    if (outDeg > 0) {
      add('leads-somewhere', 25, `Navigates to ${outDeg} screen(s)`);
      // A candidate that opens a large subgraph is a better entry than a dead end.
      const subtree = reachableFrom(adj, [screen.nodeId]).size - 1;
      if (subtree > 0) {
        add('opens-subgraph', Math.min(30, subtree * 3), `Reaches ${subtree} screen(s) downstream`);
      }
    } else {
      add('dead-end', -20, 'No outgoing navigation');
    }

    for (const p of ENTRY_NAME_PATTERNS) {
      if (p.re.test(screen.name)) {
        add('entry-name-pattern', p.weight, `Name "${screen.name}" is ${p.label}`);
        break;
      }
    }

    if (screen.deviceClass === 'desktop' || screen.deviceClass === 'mobile') {
      add('full-device-screen', 10, `Full ${screen.deviceClass} screen`);
    }

    if (screen.classification === 'ambiguous') {
      add('ambiguous-classification', -15, 'Classified as ambiguous, may not be a screen');
    }

    // Designers lay flows out left-to-right, top-to-bottom; the top-left-most
    // node in a canvas is a weak but genuine positional signal.
    signals.push({
      signal: 'canvas-position',
      weight: 0,
      detail: `Positioned at (${Math.round(screen.absX)}, ${Math.round(screen.absY)})`,
    });

    put(screen.nodeId, 'inferred', 'heuristic', null, score, signals);
  }

  /* ---- Order and rank ---------------------------------------------------- */

  const ordered = [...results.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'confirmed' ? -1 : 1;
    if (b.score !== a.score) return b.score - a.score;
    const sa = byId.get(a.nodeId);
    const sb = byId.get(b.nodeId);
    // Tie-break on canvas position: top-left first.
    const ay = sa ? sa.absY : 0;
    const by = sb ? sb.absY : 0;
    if (ay !== by) return ay - by;
    return (sa?.absX ?? 0) - (sb?.absX ?? 0);
  });

  ordered.forEach((e, i) => {
    e.rank = i + 1;
  });
  return ordered;
}

/* ------------------------------------------------------------------ *
 * Full graph analysis
 * ------------------------------------------------------------------ */

export interface GraphAnalysis {
  /** Screens reachable from at least one selected/confirmed entry point. */
  reachable: Set<string>;
  unreachable: string[];
  /** Screens with no screen-edges at all, in either direction. */
  disconnected: string[];
  flows: string[][];
  entryPoints: RankedEntryPoint[];
  adjacency: Adjacency;
}

export function analyzeGraph(params: {
  screens: GraphNodeInput[];
  edges: GraphEdgeInput[];
  flows: FlowInput[];
  urlStartNodeId: string | null;
  /** Explicit entry selection; defaults to all confirmed entries. */
  selectedEntryNodeIds?: string[];
}): GraphAnalysis {
  const screenOnly = params.screens.filter((s) => s.classification !== 'component');
  const ids = screenOnly.map((s) => s.nodeId);
  const adjacency = buildAdjacency(ids, params.edges, ['screen']);

  const entryPoints = rankEntryPoints(params);
  const entries =
    params.selectedEntryNodeIds && params.selectedEntryNodeIds.length > 0
      ? params.selectedEntryNodeIds
      : entryPoints.filter((e) => e.kind === 'confirmed').map((e) => e.nodeId);

  const reachable = reachableFrom(adjacency, entries);
  const unreachable = ids.filter((id) => !reachable.has(id));
  const disconnected = ids.filter(
    (id) => (adjacency.in.get(id)?.size ?? 0) === 0 && (adjacency.out.get(id)?.size ?? 0) === 0,
  );
  const flows = weaklyConnectedComponents(ids, adjacency);

  return { reachable, unreachable, disconnected, flows, entryPoints, adjacency };
}
