import { useMemo, useRef, useState } from 'react';
import { Badge } from './ui';

interface Node {
  nodeId: string;
  name: string;
  canvasName: string;
  classification: string;
  reachable: boolean;
  isEntryPoint: boolean;
  absX: number;
  absY: number;
  width: number;
  height: number;
  deviceClass: string;
}

interface Edge {
  fromScreenId: string;
  toScreenId: string;
  kind: string;
  trigger: string;
  sourceNodeName: string;
  supported: boolean;
}

/**
 * Navigation graph rendered as inline SVG.
 *
 * Layout follows the designer's own canvas positions rather than a force
 * simulation: a designer already arranged these frames meaningfully, and
 * preserving that makes the graph recognisable instead of an abstract blob.
 */
export function GraphView({ nodes, edges }: { nodes: Node[]; edges: Edge[] }) {
  const [hover, setHover] = useState<string | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  const screenEdges = useMemo(() => edges.filter((e) => e.kind === 'screen'), [edges]);

  /**
   * Layered layout by navigation depth.
   *
   * Canvas coordinates were tried first and produced an unreadable result: a
   * designer's board is very wide and short relative to the node count, so
   * scale-to-fit squashed 50+ frames into two overlapping bands. Depth from an
   * entry point is also more meaningful here - it shows how far into a journey
   * each screen sits, which is what a navigation graph is for.
   */
  const layout = useMemo(() => {
    if (nodes.length === 0) return { placed: [], w: 800, h: 500, depths: 0 };

    const out = new Map<string, string[]>();
    for (const n of nodes) out.set(n.nodeId, []);
    for (const e of screenEdges) {
      if (out.has(e.fromScreenId) && out.has(e.toScreenId)) out.get(e.fromScreenId)!.push(e.toScreenId);
    }

    // BFS depth from the declared entry points.
    const depth = new Map<string, number>();
    const queue: string[] = [];
    for (const n of nodes) {
      if (n.isEntryPoint) {
        depth.set(n.nodeId, 0);
        queue.push(n.nodeId);
      }
    }
    while (queue.length) {
      const cur = queue.shift()!;
      const d = depth.get(cur)!;
      for (const next of out.get(cur) ?? []) {
        if (!depth.has(next)) {
          depth.set(next, d + 1);
          queue.push(next);
        }
      }
    }

    // Anything not reached sits in a trailing "unreached" band rather than
    // being hidden - orphans are exactly what this view should expose.
    const maxDepth = Math.max(0, ...[...depth.values()]);
    const ORPHAN_LAYER = maxDepth + 1;
    for (const n of nodes) if (!depth.has(n.nodeId)) depth.set(n.nodeId, ORPHAN_LAYER);

    const layers = new Map<number, Node[]>();
    for (const n of nodes) {
      const d = depth.get(n.nodeId)!;
      if (!layers.has(d)) layers.set(d, []);
      layers.get(d)!.push(n);
    }
    for (const list of layers.values()) list.sort((a, b) => a.name.localeCompare(b.name));

    const layerKeys = [...layers.keys()].sort((a, b) => a - b);
    const COL_W = 215;
    const ROW_H = 46;
    const maxRows = Math.max(...[...layers.values()].map((l) => l.length));

    const placed: Array<Node & { x: number; y: number; r: number; depth: number }> = [];
    layerKeys.forEach((d, col) => {
      const list = layers.get(d)!;
      list.forEach((n, i) => {
        placed.push({
          ...n,
          depth: d,
          x: 90 + col * COL_W,
          // Centre each column vertically so short layers do not hug the top.
          y: 60 + (maxRows - list.length) * (ROW_H / 2) + i * ROW_H,
          // Size conveys device class, not frame size - a 5000px-tall page
          // would otherwise dwarf everything else.
          r: n.deviceClass === 'mobile' ? 6 : n.deviceClass === 'desktop' ? 9 : 7,
        });
      });
    });

    return {
      placed,
      w: 90 + layerKeys.length * COL_W + 110,
      h: 60 + maxRows * ROW_H + 70,
      depths: layerKeys.length,
      orphanLayer: ORPHAN_LAYER,
      layerKeys,
    };
  }, [nodes, screenEdges]);

  const pos = useMemo(() => {
    const m = new Map<string, { x: number; y: number; r: number }>();
    for (const n of layout.placed) m.set(n.nodeId, { x: n.x, y: n.y, r: n.r });
    return m;
  }, [layout]);

  const connected = useMemo(() => {
    if (!hover) return new Set<string>();
    const s = new Set<string>([hover]);
    for (const e of screenEdges) {
      if (e.fromScreenId === hover) s.add(e.toScreenId);
      if (e.toScreenId === hover) s.add(e.fromScreenId);
    }
    return s;
  }, [hover, screenEdges]);

  if (nodes.length === 0) {
    return <p className="text-sm text-ink-400 py-10 text-center">No screens to graph yet.</p>;
  }

  const hovered = layout.placed.find((n) => n.nodeId === hover);

  return (
    <div className="relative">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3 text-2xs text-ink-400">
          <span className="flex items-center gap-1.5">
            {/* Confirmed entries AND inferred candidates both appear here, so
                the label must not imply they are all confirmed. */}
            <span className="h-2 w-2 rounded-full bg-accent-500" /> entry point or candidate
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-ok-400" /> reachable
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-bad-400" /> unreachable
          </span>
          <span className="text-ink-500">· {screenEdges.length} transitions</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button className="btn-ghost text-xs py-1 px-2" onClick={() => setZoom((z) => Math.max(0.4, z - 0.2))}>
            −
          </button>
          <span className="text-2xs text-ink-500 tabular-nums w-10 text-center">{Math.round(zoom * 100)}%</span>
          <button className="btn-ghost text-xs py-1 px-2" onClick={() => setZoom((z) => Math.min(3, z + 0.2))}>
            +
          </button>
          <button
            className="btn-ghost text-xs py-1 px-2"
            onClick={() => {
              setZoom(1);
              setPan({ x: 0, y: 0 });
            }}
          >
            Reset
          </button>
        </div>
      </div>

      {/* Natural-size rendering with scroll: fitting 50+ nodes into a fixed
          viewBox shrank everything to illegibility. */}
      <div
        className="rounded-lg bg-surface-950 border border-surface-800 overflow-auto max-h-[34rem] cursor-grab active:cursor-grabbing"
        onMouseDown={(e) => {
          drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
        }}
        onMouseMove={(e) => {
          if (!drag.current) return;
          setPan({
            x: drag.current.px + (e.clientX - drag.current.x),
            y: drag.current.py + (e.clientY - drag.current.y),
          });
        }}
        onMouseUp={() => (drag.current = null)}
        onMouseLeave={() => (drag.current = null)}
      >
        <svg
          width={layout.w * zoom}
          height={layout.h * zoom}
          viewBox={`0 0 ${layout.w} ${layout.h}`}
          style={{ minWidth: '100%' }}
        >
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto">
              <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
            </marker>
          </defs>
          <g transform={`translate(${pan.x} ${pan.y})`}>
            {/* edges first so nodes sit above them */}
            <g>
              {screenEdges.map((e, i) => {
                const a = pos.get(e.fromScreenId);
                const b = pos.get(e.toScreenId);
                if (!a || !b) return null;
                const active = hover && (e.fromScreenId === hover || e.toScreenId === hover);
                const mx = (a.x + b.x) / 2;
                return (
                  <path
                    key={i}
                    d={`M ${a.x + a.r} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x - b.r - 3} ${b.y}`}
                    fill="none"
                    stroke={active ? '#a78bfa' : '#2c3142'}
                    strokeWidth={active ? 1.5 : 0.7}
                    opacity={hover && !active ? 0.1 : 0.8}
                    markerEnd="url(#arrow)"
                    className={active ? 'text-accent-400' : 'text-surface-700'}
                  />
                );
              })}
            </g>
            {/* column headers: how deep into a journey each layer sits */}
            <g>
              {(layout.layerKeys ?? []).map((d, col) => (
                <text
                  key={d}
                  x={90 + col * 215}
                  y={30}
                  textAnchor="middle"
                  className="fill-ink-500"
                  style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.06em' }}
                >
                  {d === layout.orphanLayer ? 'UNREACHED' : d === 0 ? 'ENTRY' : `STEP ${d}`}
                </text>
              ))}
            </g>

            <g>
              {layout.placed.map((n) => {
                const dim = hover && !connected.has(n.nodeId);
                const fill = n.isEntryPoint ? '#8b5cf6' : n.reachable ? '#4ade80' : '#f87171';
                return (
                  <g
                    key={n.nodeId}
                    opacity={dim ? 0.18 : 1}
                    onMouseEnter={() => setHover(n.nodeId)}
                    onMouseLeave={() => setHover(null)}
                    className="cursor-pointer"
                  >
                    <circle cx={n.x} cy={n.y} r={n.r} fill={fill} stroke="#0a0b10" strokeWidth="1.5" />
                    <text
                      x={n.x + n.r + 6}
                      y={n.y + 3.5}
                      className={hover === n.nodeId ? 'fill-ink-100' : 'fill-ink-400'}
                      style={{ fontSize: 10, fontWeight: hover === n.nodeId ? 600 : 400 }}
                    >
                      {n.name.length > 22 ? `${n.name.slice(0, 21)}…` : n.name}
                    </text>
                  </g>
                );
              })}
            </g>
          </g>
        </svg>
      </div>

      {hovered && (
        <div className="absolute bottom-3 left-3 rounded-lg bg-surface-850 shadow-lift px-3.5 py-2.5 pointer-events-none">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-ink-100">{hovered.name}</span>
            {hovered.isEntryPoint && <Badge tone="accent">entry</Badge>}
            <Badge tone={hovered.reachable ? 'ok' : 'bad'}>{hovered.reachable ? 'reachable' : 'unreachable'}</Badge>
          </div>
          <p className="text-2xs text-ink-500 font-mono mt-0.5">
            {hovered.nodeId} · {hovered.canvasName} · {hovered.deviceClass}
          </p>
          <p className="text-2xs text-ink-400 mt-1">
            {screenEdges.filter((e) => e.fromScreenId === hovered.nodeId).length} out ·{' '}
            {screenEdges.filter((e) => e.toScreenId === hovered.nodeId).length} in
          </p>
        </div>
      )}
    </div>
  );
}
