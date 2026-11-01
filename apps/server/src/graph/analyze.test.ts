import { describe, it, expect } from 'vitest';
import {
  buildAdjacency,
  reachableFrom,
  shortestPath,
  weaklyConnectedComponents,
  rankEntryPoints,
  analyzeGraph,
  type GraphNodeInput,
  type GraphEdgeInput,
} from './analyze.js';

const screen = (nodeId: string, name: string, extra: Partial<GraphNodeInput> = {}): GraphNodeInput => ({
  nodeId,
  name,
  canvasId: '0:1',
  canvasName: 'Mockup',
  classification: 'screen',
  deviceClass: 'desktop',
  width: 1440,
  height: 900,
  absX: 0,
  absY: 0,
  ...extra,
});

const edge = (
  from: string,
  to: string,
  kind: GraphEdgeInput['kind'] = 'screen',
): GraphEdgeInput => ({ fromNodeId: from, toNodeId: to, kind, supported: true });

describe('buildAdjacency - typed edges (ADR-0001)', () => {
  const screens = [screen('a', 'Home'), screen('b', 'Details'), screen('c', 'Cart')];
  const ids = screens.map((s) => s.nodeId);

  it('includes only screen edges in reachability adjacency', () => {
    const adj = buildAdjacency(ids, [edge('a', 'b', 'screen'), edge('a', 'c', 'ui-state')]);
    expect([...adj.out.get('a')!]).toEqual(['b']);
  });

  it('EXCLUDES ui-state edges - a variant swap is not a screen transition', () => {
    // This is the 59%-of-interactions case measured on the real Rosella file.
    // If ui-state edges counted, nearly everything would look reachable.
    const adj = buildAdjacency(ids, [edge('a', 'c', 'ui-state')]);
    expect(reachableFrom(adj, ['a']).has('c')).toBe(false);
  });

  it('excludes overlay edges from screen reachability', () => {
    const adj = buildAdjacency(ids, [edge('a', 'b', 'overlay')]);
    expect(reachableFrom(adj, ['a']).has('b')).toBe(false);
  });

  it('can be asked for other edge kinds explicitly', () => {
    const adj = buildAdjacency(ids, [edge('a', 'b', 'overlay')], ['overlay']);
    expect(reachableFrom(adj, ['a']).has('b')).toBe(true);
  });

  it('ignores edges whose endpoints are not tracked screens', () => {
    const adj = buildAdjacency(ids, [edge('a', 'zzz')]);
    expect([...adj.out.get('a')!]).toEqual([]);
  });
});

describe('reachableFrom', () => {
  const ids = ['a', 'b', 'c', 'd', 'orphan'];
  const adj = buildAdjacency(ids, [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')]);

  it('walks transitively', () => {
    expect([...reachableFrom(adj, ['a'])].sort()).toEqual(['a', 'b', 'c', 'd']);
  });
  it('excludes orphans', () => {
    expect(reachableFrom(adj, ['a']).has('orphan')).toBe(false);
  });
  it('supports multiple entry points', () => {
    expect(reachableFrom(adj, ['c', 'orphan']).has('orphan')).toBe(true);
  });
  it('terminates on cycles', () => {
    const cyc = buildAdjacency(['x', 'y'], [edge('x', 'y'), edge('y', 'x')]);
    expect([...reachableFrom(cyc, ['x'])].sort()).toEqual(['x', 'y']);
  });
});

describe('shortestPath', () => {
  const ids = ['home', 'list', 'detail', 'cart', 'far'];
  const adj = buildAdjacency(ids, [
    edge('home', 'list'),
    edge('list', 'detail'),
    edge('detail', 'cart'),
    edge('home', 'cart'), // a shortcut
  ]);

  it('prefers the fewest hops when several paths exist', () => {
    expect(shortestPath(adj, 'home', 'cart')).toEqual(['home', 'cart']);
  });
  it('finds a multi-hop path', () => {
    expect(shortestPath(adj, 'list', 'cart')).toEqual(['list', 'detail', 'cart']);
  });
  it('returns a single-element path for identical endpoints', () => {
    expect(shortestPath(adj, 'home', 'home')).toEqual(['home']);
  });
  it('returns null when unreachable', () => {
    expect(shortestPath(adj, 'home', 'far')).toBeNull();
  });
});

describe('weaklyConnectedComponents - independent flows', () => {
  it('separates independent flows and orders largest first', () => {
    const ids = ['a', 'b', 'c', 'x', 'y', 'lonely'];
    const adj = buildAdjacency(ids, [edge('a', 'b'), edge('b', 'c'), edge('x', 'y')]);
    const comps = weaklyConnectedComponents(ids, adj);
    expect(comps.map((c) => c.length)).toEqual([3, 2, 1]);
    expect(comps[2]).toEqual(['lonely']);
  });
});

describe('rankEntryPoints - confirmed vs inferred', () => {
  const screens = [
    screen('1:2', 'Home'),
    screen('80:18', 'Details'),
    screen('9:9', 'Orphan Screen'),
  ];
  const edges = [edge('1:2', '80:18')];

  it('ranks the URL-supplied start node first (Scenario A)', () => {
    const r = rankEntryPoints({ screens, edges, flows: [], urlStartNodeId: '1:2' });
    expect(r[0]!.nodeId).toBe('1:2');
    expect(r[0]!.kind).toBe('confirmed');
    expect(r[0]!.source).toBe('urlStartNode');
  });

  it('treats declared flow starting points as confirmed', () => {
    const r = rankEntryPoints({
      screens,
      edges,
      flows: [{ nodeId: '80:18', name: 'Flow 2', isPrototypeStart: false }],
      urlStartNodeId: null,
    });
    const details = r.find((e) => e.nodeId === '80:18')!;
    expect(details.kind).toBe('confirmed');
    expect(details.source).toBe('flowStartingPoint');
    expect(details.flowName).toBe('Flow 2');
  });

  it('ranks the prototype start node above other declared flows', () => {
    const r = rankEntryPoints({
      screens,
      edges,
      flows: [
        { nodeId: '80:18', name: 'Flow 2', isPrototypeStart: false },
        { nodeId: '1:2', name: 'Flow 1', isPrototypeStart: true },
      ],
      urlStartNodeId: null,
    });
    expect(r[0]!.nodeId).toBe('1:2');
    expect(r[0]!.source).toBe('prototypeStartNodeID');
  });

  it('ALWAYS places confirmed entries above inferred ones', () => {
    const r = rankEntryPoints({
      screens,
      edges,
      flows: [{ nodeId: '1:2', name: 'Flow 1', isPrototypeStart: true }],
      urlStartNodeId: null,
    });
    const firstInferred = r.findIndex((e) => e.kind === 'inferred');
    const lastConfirmed = r.map((e) => e.kind).lastIndexOf('confirmed');
    expect(lastConfirmed).toBeLessThan(firstInferred);
  });

  it('Scenario B: produces inferred candidates when nothing is declared', () => {
    const r = rankEntryPoints({ screens, edges, flows: [], urlStartNodeId: null });
    expect(r.length).toBeGreaterThan(0);
    // Nothing may be labelled confirmed when Figma declared nothing.
    expect(r.every((e) => e.kind === 'inferred')).toBe(true);
  });

  it('never silently promotes the first frame to a confirmed start', () => {
    const r = rankEntryPoints({ screens, edges, flows: [], urlStartNodeId: null });
    expect(r[0]!.kind).toBe('inferred');
    expect(r[0]!.source).toBe('heuristic');
  });

  it('explains every inferred candidate with signals', () => {
    const r = rankEntryPoints({ screens, edges, flows: [], urlStartNodeId: null });
    for (const e of r.filter((x) => x.kind === 'inferred')) {
      expect(e.signals.length).toBeGreaterThan(0);
    }
  });

  it('favours a screen with no inbound navigation, without discarding the others', () => {
    const r = rankEntryPoints({ screens, edges, flows: [], urlStartNodeId: null });
    const home = r.find((e) => e.nodeId === '1:2')!;     // no inbound, leads to Details
    const details = r.find((e) => e.nodeId === '80:18')!; // has inbound -> weaker candidate
    expect(home.signals.some((s) => s.signal === 'no-inbound-navigation')).toBe(true);
    expect(details.signals.some((s) => s.signal === 'has-inbound-navigation')).toBe(true);
    // Scenario B must not drop screens - it ranks them.
    expect(home.score).toBeGreaterThan(details.score);
    expect(home.rank).toBeLessThan(details.rank);
  });

  it('does not propose screens already covered by a confirmed flow', () => {
    const r = rankEntryPoints({
      screens,
      edges,
      flows: [{ nodeId: '1:2', name: 'Flow 1', isPrototypeStart: true }],
      urlStartNodeId: null,
    });
    // Details is reachable from the confirmed Home entry, so it is not a candidate.
    expect(r.find((e) => e.nodeId === '80:18')).toBeUndefined();
    // The genuinely orphaned screen still is.
    expect(r.find((e) => e.nodeId === '9:9')?.kind).toBe('inferred');
  });
});

describe('analyzeGraph', () => {
  const screens = [
    screen('1:2', 'Home'),
    screen('80:18', 'Details'),
    screen('wf:1', 'Wireframe Home', { canvasId: '463:985', canvasName: 'Wireframe' }),
    screen('comp:1', 'Heart', { classification: 'component' }),
  ];
  const edges = [edge('1:2', '80:18'), edge('1:2', 'comp:1', 'ui-state')];

  const result = analyzeGraph({
    screens,
    edges,
    flows: [{ nodeId: '1:2', name: 'Flow 1', isPrototypeStart: true }],
    urlStartNodeId: null,
  });

  it('excludes components from the screen graph entirely', () => {
    expect(result.reachable.has('comp:1')).toBe(false);
    expect(result.unreachable).not.toContain('comp:1');
  });

  it('reports reachable screens', () => {
    expect(result.reachable.has('1:2')).toBe(true);
    expect(result.reachable.has('80:18')).toBe(true);
  });

  it('reports unreachable screens rather than dropping them', () => {
    // The Wireframe-canvas screen must survive into the report.
    expect(result.unreachable).toContain('wf:1');
  });

  it('identifies disconnected screens', () => {
    expect(result.disconnected).toContain('wf:1');
  });

  it('counts independent flows', () => {
    // {1:2, 80:18} and {wf:1}
    expect(result.flows).toHaveLength(2);
    expect(result.flows[0]).toHaveLength(2);
  });

  it('honours an explicit entry point selection', () => {
    const fromWireframe = analyzeGraph({
      screens,
      edges,
      flows: [],
      urlStartNodeId: null,
      selectedEntryNodeIds: ['wf:1'],
    });
    expect(fromWireframe.reachable.has('wf:1')).toBe(true);
    expect(fromWireframe.reachable.has('80:18')).toBe(false);
  });
});
