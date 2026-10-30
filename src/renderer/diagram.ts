// Diagrams, for the model's replies: a Mermaid flowchart, drawn as SVG. Built
// node by node with createElementNS, like the Markdown around it, so nothing
// the model writes can become markup. Only the common part of Mermaid is read
// (see parseFlowchart); anything else returns null and is shown as code.

const SVG = 'http://www.w3.org/2000/svg';

type Shape = 'rect' | 'round' | 'diamond' | 'circle';
type Direction = 'TD' | 'BT' | 'LR' | 'RL';

interface DiagramNode {
  id: string;
  label: string;
  shape: Shape;
  // Size and centre, once laid out
  w: number;
  h: number;
  x: number;
  y: number;
}

interface DiagramEdge {
  from: string;
  to: string;
  label: string;
  arrow: boolean;
  line: 'solid' | 'dotted' | 'thick';
}

interface Flowchart {
  direction: Direction;
  nodes: Map<string, DiagramNode>;
  edges: DiagramEdge[];
}

interface Point {
  x: number;
  y: number;
}

const PAD = 16;
const LINE = 18;
const CHAR = 7.5;
const GAP = 28;
// The most a diagram is drawn bigger than its laid-out size in the chat. Only the svg's width and height
// use it; the viewBox keeps the geometry, so nodes, arrows and text all grow together.
const DIAGRAM_SCALE = 1.4;
// The width in px a diagram should fit without scrolling sideways. The renderer cannot measure the bubble, so
// this is a tuned guess: a left-to-right chart wider than it turns to run top-down, and a narrower one is only
// scaled up as far as it.
const TARGET_WIDTH = 960;

const HEADER = /^(?:flowchart|graph)(?:\s+(TD|TB|BT|LR|RL))?$/i;
const IGNORED = /^(?:%%|(?:style|classDef|class|linkStyle|click)\s)/;
// A node: its id, and optionally its text in the brackets that give its shape
const NODE = /(\w+)(?:\[([^\]]*)\]|\(\(([^)]*)\)\)|\(([^)]*)\)|\{([^}]*)\})?/y;
// An arrow or line between two nodes, with its text as -->|text| or -- text -->
const EDGE = /(-->|---|-\.->|-\.-|==>|===)\s*(?:\|([^|]*)\|\s*)?|--\s+(.+?)\s+(-->|---)\s*/y;

const unwrap = (text: string) =>
  text
    .trim()
    .replace(/^\[(.*)\]$|^\((.*)\)$/, '$1$2')
    .replace(/^"(.*)"$/, '$1')
    .replace(/<br\s*\/?>/gi, '\n');

// Reads a flowchart:  flowchart LR / A[Text] --> B{Choice} -->|yes| C(Done)
// Several arrows can be chained on a line. Subgraphs and the like are not
// understood, which makes the whole diagram null rather than half of it.
function parseFlowchart(source: string): Flowchart | null {
  const lines = source
    .split('\n')
    .map((line) => line.trim().replace(/;$/, ''))
    .filter((line) => line && !line.startsWith('%%'));
  const header = HEADER.exec(lines[0] ?? '');
  if (!header) return null;
  const given = header[1]?.toUpperCase();
  const direction = (!given || given === 'TB' ? 'TD' : given) as Direction;
  const chart: Flowchart = { direction, nodes: new Map(), edges: [] };

  const node = (text: string, at: number): { id: string; end: number } | null => {
    NODE.lastIndex = at;
    const m = NODE.exec(text);
    if (!m) return null;
    const [, id, rect, circle, rounded, diamond] = m;
    const label = [rect, circle, rounded, diamond].find((part) => part !== undefined);
    const shape: Shape =
      circle !== undefined ? 'circle' : rounded !== undefined ? 'round' : diamond !== undefined ? 'diamond' : 'rect';
    const known = chart.nodes.get(id);
    // A node can be mentioned again to give it its text, but not to take it away
    if (known && label !== undefined) Object.assign(known, { label: unwrap(label), shape });
    if (!known) chart.nodes.set(id, { id, label: unwrap(label ?? id), shape, w: 0, h: 0, x: 0, y: 0 });
    return { id, end: NODE.lastIndex };
  };

  for (const line of lines.slice(1)) {
    if (IGNORED.test(line)) continue;
    let at = 0;
    let from = node(line, at);
    if (!from) return null;
    at = from.end;
    while (at < line.length) {
      while (line[at] === ' ') at++;
      if (at >= line.length) break;
      EDGE.lastIndex = at;
      const edge = EDGE.exec(line);
      if (!edge) return null;
      const op = edge[1] ?? edge[4];
      const to = node(line, EDGE.lastIndex);
      if (!to) return null;
      // An arrow from a node to itself has no room to be drawn, so it is left out
      if (to.id !== from.id) {
        chart.edges.push({
          from: from.id,
          to: to.id,
          label: unwrap(edge[2] ?? edge[3] ?? ''),
          arrow: op.endsWith('>'),
          line: op.includes('.') ? 'dotted' : op.includes('=') ? 'thick' : 'solid',
        });
      }
      from = to;
      at = to.end;
    }
  }
  return chart.nodes.size ? chart : null;
}

// Puts each node in a layer after the ones that point to it (an arrow back to
// a node already on the way down is drawn but doesn't count), the layers one
// after another in the direction of the chart, and each layer centred.
function layout(chart: Flowchart): Point {
  const { nodes, edges, direction } = chart;
  const horizontal = direction === 'LR' || direction === 'RL';
  for (const n of nodes.values()) {
    const lines = n.label.split('\n');
    const text = { w: Math.max(...lines.map((line) => line.length)) * CHAR, h: lines.length * LINE };
    const scale = n.shape === 'diamond' ? 1.6 : n.shape === 'circle' ? 1.3 : 1;
    n.w = Math.max(56, text.w + 28) * scale;
    n.h = (text.h + 18) * scale;
  }

  const forward: DiagramEdge[] = [];
  const state = new Map<string, 'open' | 'done'>();
  const visit = (id: string) => {
    state.set(id, 'open');
    for (const edge of edges.filter((e) => e.from === id)) {
      if (state.get(edge.to) === 'open') continue;
      forward.push(edge);
      if (!state.has(edge.to)) visit(edge.to);
    }
    state.set(id, 'done');
  };
  for (const id of nodes.keys()) if (!state.has(id)) visit(id);

  const rank = new Map([...nodes.keys()].map((id) => [id, 0]));
  for (let changed = true, pass = 0; changed && pass <= nodes.size; pass++) {
    changed = false;
    for (const { from, to } of forward) {
      if ((rank.get(to) as number) <= (rank.get(from) as number)) {
        rank.set(to, (rank.get(from) as number) + 1);
        changed = true;
      }
    }
  }

  const layers: DiagramNode[][] = [];
  for (const n of nodes.values()) (layers[rank.get(n.id) as number] ??= []).push(n);
  const along = (n: DiagramNode) => (horizontal ? n.w : n.h);
  const across = (n: DiagramNode) => (horizontal ? n.h : n.w);
  const widths = layers.map((layer) => layer.reduce((sum, n) => sum + across(n) + GAP, -GAP));
  const widest = Math.max(...widths);
  const gap = horizontal ? GAP * 3 : GAP * 2;
  const depth = layers.reduce((sum, layer) => sum + Math.max(...layer.map(along)) + gap, -gap);

  let offset = PAD;
  layers.forEach((layer, i) => {
    const thick = Math.max(...layer.map(along));
    let side = PAD + (widest - widths[i]) / 2;
    for (const n of layer) {
      const main = offset + thick / 2;
      const cross = side + across(n) / 2;
      const reversed = direction === 'BT' || direction === 'RL' ? 2 * PAD + depth - main : main;
      [n.x, n.y] = horizontal ? [reversed, cross] : [cross, reversed];
      side += across(n) + GAP;
    }
    offset += thick + gap;
  });
  return horizontal ? { x: depth + 2 * PAD, y: widest + 2 * PAD } : { x: widest + 2 * PAD, y: depth + 2 * PAD };
}

// Where a line from the middle of n towards another point leaves n's outline
function leaves(n: DiagramNode, towards: Point): Point {
  const dx = towards.x - n.x;
  const dy = towards.y - n.y;
  const hw = n.w / 2;
  const hh = n.h / 2;
  const t =
    n.shape === 'diamond'
      ? 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh)
      : n.shape === 'circle'
        ? 1 / Math.hypot(dx / hw, dy / hh)
        : Math.min(hw / Math.abs(dx), hh / Math.abs(dy));
  return { x: n.x + dx * t, y: n.y + dy * t };
}

const round = (n: number) => String(Math.round(n * 10) / 10);

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) {
  const el = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs))
    el.setAttribute(name, typeof value === 'number' ? round(value) : value);
  return el;
}

function drawText(lines: string[], at: Point, className?: string) {
  const text = svg('text');
  if (className) text.setAttribute('class', className);
  lines.forEach((line, i) => {
    const tspan = svg('tspan', { x: at.x, y: at.y + (i - (lines.length - 1) / 2) * LINE });
    tspan.textContent = line;
    text.append(tspan);
  });
  return text;
}

function drawNode(n: DiagramNode) {
  const g = svg('g', { class: 'node', 'data-node': n.id });
  const [x, y, hw, hh] = [n.x - n.w / 2, n.y - n.h / 2, n.w / 2, n.h / 2];
  const corners = [
    [n.x, y],
    [x + n.w, n.y],
    [n.x, y + n.h],
    [x, n.y],
  ];
  g.append(
    n.shape === 'diamond'
      ? svg('polygon', { points: corners.map((corner) => corner.map(round).join(',')).join(' ') })
      : n.shape === 'circle'
        ? svg('ellipse', { cx: n.x, cy: n.y, rx: hw, ry: hh })
        : svg('rect', { x, y, width: n.w, height: n.h, rx: n.shape === 'round' ? 12 : 4 }),
    drawText(n.label.split('\n'), n)
  );
  return g;
}

function drawEdge(chart: Flowchart, edge: DiagramEdge) {
  const a = chart.nodes.get(edge.from) as DiagramNode;
  const b = chart.nodes.get(edge.to) as DiagramNode;
  const start = leaves(a, b);
  const end = leaves(b, a);
  const g = svg('g', { class: `edge ${edge.line}`, 'data-edge': `${edge.from}->${edge.to}` });
  g.append(svg('path', { d: `M${round(start.x)},${round(start.y)} L${round(end.x)},${round(end.y)}` }));
  if (edge.arrow) {
    const angle = Math.atan2(end.y - start.y, end.x - start.x);
    const wing = (turn: number) =>
      `${round(end.x - 9 * Math.cos(angle + turn))},${round(end.y - 9 * Math.sin(angle + turn))}`;
    g.append(svg('polygon', { points: `${round(end.x)},${round(end.y)} ${wing(0.4)} ${wing(-0.4)}` }));
  }
  if (edge.label) {
    g.append(drawText(edge.label.split('\n'), { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }, 'edge-label'));
  }
  return g;
}

// The diagram for the text of a ```mermaid block, or null where it is not a
// flowchart this can read
export function renderDiagram(source: string): HTMLElement | null {
  const chart = parseFlowchart(source);
  if (!chart) return null;
  let size = layout(chart);
  // A chart that would run past the target width turns to run down the page instead; layout() starts afresh
  if ((chart.direction === 'LR' || chart.direction === 'RL') && size.x * DIAGRAM_SCALE > TARGET_WIDTH) {
    chart.direction = chart.direction === 'LR' ? 'TD' : 'BT';
    size = layout(chart);
  }
  const scale = Math.min(DIAGRAM_SCALE, Math.max(1, TARGET_WIDTH / size.x));
  const root = svg('svg', {
    viewBox: `0 0 ${round(size.x)} ${round(size.y)}`,
    width: round(size.x * scale),
    height: round(size.y * scale),
  });
  root.append(...chart.edges.map((edge) => drawEdge(chart, edge)), ...[...chart.nodes.values()].map(drawNode));
  const wrap = document.createElement('div');
  wrap.className = 'diagram';
  wrap.dataset.language = 'mermaid';
  wrap.append(root);
  return wrap;
}
