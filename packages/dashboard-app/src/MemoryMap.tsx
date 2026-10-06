import { type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ForceSim, type SimNode } from './force-sim';
import { buildModel, nodeOf, ROOT, SOURCE, visible, type Focus, type GLink, type GNode, type MapModel, type Shape } from './memory-map-graph';
import { fetchMemory, memoryItemLink, type Claim, type Interpretation, type MemoryPage } from './memory-model';
import type { MemoryListDestination } from './destinations';
import { relativeTime } from './time';
import './memory-map.css';

// The Spots and constellations map from waldo-landing (components/site/memory-map.tsx, after andrewtrousdale.com),
// fed by this read's saved Spots and patterns. Drag any node and the rest follow on their springs; choose one and
// the web narrows to it, with a panel saying what it is and where it connects. It runs edge to edge as a night
// scene: drag the empty sky to pan, and a field of dust drifts behind (decoration, never data).

const SIZE: Record<Shape, number> = { root: 24, hexagon: 26, circle: 20, square: 20, triangle: 26 };

function Glyph({ shape, number, current, size }: { shape: Shape; number?: number; current?: boolean; size?: number }) {
  const s = size ?? SIZE[shape];
  const common = { className: shape === 'root' ? 'mm-shape mm-shape--root' : 'mm-shape', width: s, height: s, 'aria-hidden': true, 'data-current': current ? '' : undefined } as const;
  if (shape === 'root') return <svg {...common} viewBox="0 0 23 20"><g className="mm-mark" fill="currentColor">
    <path d="M12.0455 8.19435C8.5546 8.63273 6.68628 1.37044 10.4049 0.0167778C14.1721 -0.400611 15.7586 7.09811 12.0455 8.19435Z"/>
    <path d="M8.3092 10.5135C6.58923 13.9893 -0.949651 11.5404 0.0997341 7.32816C2.00498 3.60923 9.58249 6.4543 8.3092 10.5135Z"/>
    <path d="M16.2786 9.83065C13.9189 7.43667 17.1194 2.50187 20.161 4.61989C22.6742 7.23047 19.1635 12.07 16.2786 9.83065Z"/>
    <path d="M17.6058 13.2603C18.102 11.0572 22.6427 11.375 22.6197 13.8989C22.0525 16.2652 17.4372 15.7294 17.6058 13.2603Z"/>
    <path d="M14.9478 15.3381C16.0796 14.5281 18.5029 18.2428 17.5123 19.5964C16.2774 20.4397 13.8966 16.5483 14.9478 15.3381Z"/></g></svg>;
  return <svg {...common} viewBox="0 0 26 26">
    {shape === 'hexagon' && <path d="M13 2 L22.5 7.5 V18.5 L13 24 L3.5 18.5 V7.5 Z"/>}
    {shape === 'circle' && <circle cx="13" cy="13" r="8.5"/>}
    {shape === 'square' && <rect x="4.5" y="4.5" width="17" height="17"/>}
    {shape === 'triangle' && <path d="M13 3.5 L23.5 22 H2.5 Z"/>}
    {shape === 'hexagon' && number && !current && <text x="13" y="16.4" textAnchor="middle">{number}</text>}
    {current && <path className="mm-x" d="M9.6 9.6l6.8 6.8M16.4 9.6l-6.8 6.8"/>}
  </svg>;
}

const typeOf = (node: GNode) => node.shape === 'root' ? 'Waldo' : node.shape === 'hexagon' ? 'Pattern' : `Spot · ${node.summary}`;

function Panel({ model, current, returnTo, onPick, onClose }: { model: MapModel; current: string | null; returnTo?: MemoryListDestination; onPick: (id: string) => void; onClose: () => void }) {
  const node = current ? nodeOf(model, current) : null;
  if (!current || !node) return null;
  const pattern = model.patterns.find(p => p.id === current);
  const spot: Claim | undefined = model.spots.get(current);
  const linked = pattern ? (model.spotsOf.get(pattern.id) ?? []) : (model.patternsOf.get(current) ?? []);
  const links = linked.map(id => nodeOf(model, id)).filter((n): n is GNode => !!n);
  return <div key={current} className="mm-page">
    <div className="mm-page-top"><p className="mm-type"><Glyph shape={node.shape} number={node.number} size={15}/>{pattern ? 'Pattern' : 'Spot'}</p>
      <button type="button" className="mm-close" onClick={onClose} aria-label="Back to the whole map"><svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg></button></div>
    <h3 className="mm-page-title">{node.title}</h3>
    {pattern && <><p className="mm-sub">{links.length} returned of {pattern.support.claim_ids.length} saved supporting {links.length === 1 ? 'Spot' : 'Spots'} · {relativeTime(pattern.recorded_active_at)}</p><p className="mm-text">{pattern.summary}</p><p className="mm-sub">Stored status: {pattern.stored_status} · {pattern.support.unavailable_count} supports withheld/unavailable · {pattern.support.claim_ids.length-links.length} saved support IDs absent from these returned pages</p><p className="mm-note">A pattern is his tentative reading of your Spots, not a fact.</p></>}
    {spot && <><p className="mm-sub">{SOURCE[spot.source]?.name ?? 'Saved'} · {relativeTime(spot.recorded_at)}</p><p className="mm-sub">Origin: {spot.origin} · Status: {spot.status}</p>{spot.evidence.text && <p className="mm-text">{spot.evidence.text}</p>}<p className="mm-note">His note on why he saved it. Not proof that it’s true.</p></>}
    {links.length > 0 && <div className="mm-tab"><p className="mm-tab-title">{pattern ? 'Returned supporting Spots' : 'Saved support membership, returned patterns'}</p>
      <ul className="mm-list">{links.map(n => <li key={n.id}><button type="button" onClick={() => onPick(n.id)}><Glyph shape={n.shape} number={n.number} size={16}/><span><b>{n.title}</b><i>{typeOf(n)}</i></span></button></li>)}</ul></div>}
    <a className="button-link mm-open" href={memoryItemLink(pattern ? 'constellation' : 'spots', current, returnTo)}>{pattern ? 'Open pattern' : 'Open Spot'} <span aria-hidden="true">→</span></a>
  </div>;
}

// Day to night is never a cut: the page crossfades over 1.6s (a View Transition), and where that isn't supported a
// veil fades in instead, so no frame changes the whole screen's brightness at once.
function setScene(night: boolean) {
  const root = document.documentElement;
  if ((root.dataset.scene === 'night') === night) return;
  const apply = () => { if (night) root.dataset.scene = 'night'; else delete root.dataset.scene; };
  const doc = document as Document & { startViewTransition?: (update: () => void) => unknown };
  if (typeof doc.startViewTransition === 'function') { doc.startViewTransition(apply); return; }
  root.dataset.dusk = night ? 'in' : 'out';
  window.setTimeout(() => { apply(); delete root.dataset.dusk; }, 700);
}

const pathOf = (a: SimNode, b: SimNode, kind: GLink['kind']) => {
  if (kind === 'angled') {
    // the landing's dog-leg: out a third of the way, a level run, then in
    const lean = a.y > b.y ? -30 : 30, x1 = a.x + (b.x - a.x) / 3, y1 = a.y + (b.y - a.y) / 3 + lean, x2 = a.x + (2 * (b.x - a.x)) / 3;
    return `M${a.x.toFixed(1)},${a.y.toFixed(1)} L${x1.toFixed(1)},${y1.toFixed(1)} L${x2.toFixed(1)},${y1.toFixed(1)} L${b.x.toFixed(1)},${b.y.toFixed(1)}`;
  }
  return `M${a.x.toFixed(1)},${a.y.toFixed(1)} L${b.x.toFixed(1)},${b.y.toFixed(1)}`;
};

/** Deterministic dust: the same sky on every visit. */
const DUST = (() => { let h = 2463534242; const next = () => (h ^= h << 13, h ^= h >>> 17, h ^= h << 5, (h >>> 0) / 4294967296); return Array.from({ length: 260 }, () => ({ x: next() * 100, y: next() * 100, r: next() < 0.12 ? 1.6 : 0.9, o: 0.12 + next() * 0.4, d: next() * 6 })); })();

type MapProps = { read: MemoryPage; focus: Focus; patterns?: Interpretation[]; spots?: Claim[]; returnTo?: MemoryListDestination; corner?: ReactNode; note?: ReactNode };
export function MemoryMap({ focus, patterns, spots, returnTo, corner, note, read }: MapProps) {
  const [fetched, setFetched] = useState<MemoryPage | null>(null);
  const [error,setError]=useState<string|null>(null),[retry,setRetry]=useState(0);
  // Whichever side the page did not read is read here: Spots for the constellations, patterns for the Spots.
  useEffect(() => {
    const abort = new AbortController();setFetched(null);setError(null);
    fetchMemory(new URLSearchParams({ view: patterns ? 'claims' : 'interpretations', limit: '25' }), abort.signal)
      .then(data => { if (!abort.signal.aborted) setFetched(data as MemoryPage); })
      .catch(e => { if (!abort.signal.aborted) setError(e instanceof Error?e.message:'Read failed'); });
    return () => abort.abort();
  }, [!!patterns,retry]);
  const model = useMemo(() => buildModel(patterns ?? (fetched?.items ?? []).filter((item): item is Interpretation => !('text' in item)), spots ?? (fetched?.items ?? []).filter((item): item is Claim => 'text' in item)), [patterns, spots, fetched]);
  // The page turns to night while the map is open, and back when it closes.
  useEffect(() => { setScene(true); return () => setScene(false); }, []);
  const complete=read.state==='available'&&read.complete&&!!fetched&&fetched.state==='available'&&fetched.complete&&read.page.total===read.page.returned&&fetched.page.total===fetched.page.returned;
  const status=<div className="mm-read-status" role="status"><p>Map of two returned pages, not all Memory. {read.page.returned} of {read.page.total} {patterns?'patterns':'Spots'} on the main page.</p>{error?<p>Other page unavailable: {error} <button onClick={()=>setRetry(n=>n+1)}>Retry other page</button></p>:fetched?<p>Other page: {fetched.page.returned} of {fetched.page.total} {patterns?'Spots':'patterns'} · {fetched.state}, {fetched.complete?'complete read':'incomplete read'} · {fetched.unavailable_claim_count} claims withheld.</p>:<p>Loading other page…</p>}<p>Map limits: 30 Spots in Spots view, 12 patterns, 14 supports per focused pattern, 2 per overview pattern, 6 loose Spots. Root spokes are layout only (any line style). Solid/dashed edges between records are saved support membership. Dotted Spot-pattern edges are also saved support; dotted pattern-pattern edges are shared support derived here, not saved associations or proof.</p></div>;
  return <>{status}<Web model={model} focus={focus} returnTo={returnTo} complete={complete} corner={corner} note={note}/></>;
}

function Web({ model, focus, returnTo, complete, corner, note }: { model: MapModel; focus: Focus; returnTo?: MemoryListDestination; complete: boolean; corner?: ReactNode; note?: ReactNode }) {
  const root = useRef<HTMLDivElement>(null), stage = useRef<HTMLDivElement>(null), world = useRef<HTMLDivElement>(null), panel = useRef<HTMLElement>(null);
  const paintRef = useRef<() => void>(() => {});
  const [sim] = useState(() => new ForceSim(() => paintRef.current()));
  const bodies = useRef(new Map<string, SimNode>()), nodeEls = useRef(new Map<string, HTMLElement>()), pathEls = useRef(new Map<string, SVGPathElement>());
  const drag = useRef<{ node: SimNode; x: number; y: number; ox: number; oy: number; moved: boolean } | null>(null);
  const pan = useRef({ x: 0, y: 0 }), panning = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const live = useRef<GLink[]>([]);
  const zoom=useRef(1);
  const motion = useRef(true);
  const [current, setCurrent] = useState<string | null>(null);
  const [size, setSize] = useState<'wide' | 'mid' | 'small'>('wide');
  const graph = useMemo(() => visible(model, current, focus), [model, current, focus]);

  const paint = () => {
    const occupied:{x:number;y:number;w:number;h:number}[]=[];
    for (const n of [...sim.nodes].sort((a,b)=>Number(b.id===current)-Number(a.id===current))) {
      const el=nodeEls.current.get(n.id);if(!el)continue;
      el.style.setProperty('transform', `translate(${n.x.toFixed(1)}px,${n.y.toFixed(1)}px)`);
      const label=el.querySelector<HTMLElement>('.mm-label');if(!label)continue;
      const w=150,h=52,x=n.x-w/2,y=n.y+17;
      const collides=occupied.some(r=>x<r.x+r.w&&x+w>r.x&&y<r.y+r.h&&y+h>r.y);
      label.style.visibility=collides&&n.id!==current?'hidden':'visible';if(!collides)occupied.push({x,y,w,h});
    }
    for (const l of live.current) { const a = bodies.current.get(l.source), b = bodies.current.get(l.target); if (a && b) pathEls.current.get(l.id)?.setAttribute('d', pathOf(a, b, l.kind)); }
  };
  const setPan = (x: number, y: number) => { x=Math.max(-600,Math.min(600,x));y=Math.max(-400,Math.min(400,y));pan.current = { x, y }; stage.current?.style.setProperty('--px', `${x}px`); stage.current?.style.setProperty('--py', `${y}px`); };
  useLayoutEffect(() => { paintRef.current = paint; });
  useEffect(() => () => sim.stop(), [sim]);

  const freeWidth = () => { const el = world.current; if (!el) return 0; return current && size !== 'small' && panel.current ? panel.current.offsetLeft - 20 : el.clientWidth; };
  function fit() {
    const el = world.current; if (!el) return;
    sim.setCentre(freeWidth() / 2, el.clientHeight / 2);
    sim.setBounds(freeWidth(), el.clientHeight, 85);
    if (root.current?.dataset.ready !== undefined && motion.current) sim.restart(Math.max(sim.alpha, 0.3));
  }

  useEffect(() => {
    const el = world.current; if (!el) return;
    const measure = () => { const w = el.clientWidth; setSize(w >= 1100 ? 'wide' : w >= 640 ? 'mid' : 'small'); fit(); };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(measure); watch.observe(el);
    return () => watch.disconnect();
  }, [current, size]);

  useLayoutEffect(() => {
    const el = world.current; if (!el) return;
    motion.current = !(typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const params = { ...{ wide: { strength: 0.1, charge: -300, chargeMax: 340, chargeMin: 12 }, mid: { strength: 0.1, charge: -240, chargeMax: 280, chargeMin: 12 }, small: { strength: 0.1, charge: -170, chargeMax: 210, chargeMin: 10 } }[size] };
    // the Spots view carries about three times the nodes, so it stands a little closer together
    const scale = (size === 'wide' ? 0.95 : size === 'mid' ? 0.7 : 0.45) * (focus === 'spots' ? 0.74 : 1);
    if (focus === 'spots') params.charge *= 0.7;
    sim.setParams(params);
    live.current = graph.links;
    const free = freeWidth(), h = el.clientHeight;
    sim.setCentre(free / 2, h / 2); sim.setBounds(free, h, 85);
    // nodes already on the map keep their place; new ones start beside what they hang on, fanned away from Waldo
    const parentOf = new Map<string, GLink>();
    for (const l of graph.links) if (!parentOf.has(l.target)) parentOf.set(l.target, l);
    const kids = new Map<string, string[]>();
    for (const [child, l] of parentOf) kids.set(l.source, [...(kids.get(l.source) ?? []), child]);
    const nodes: SimNode[] = graph.nodes.map(n => {
      let body = bodies.current.get(n.id);
      if (!body) {
        const link = parentOf.get(n.id), from = link ? bodies.current.get(link.source) : undefined;
        let x = free / 2, y = h / 2;
        if (link && from) {
          const siblings = kids.get(link.source) ?? [n.id], k = siblings.indexOf(n.id), count = siblings.length;
          const up = parentOf.get(link.source), grand = up ? bodies.current.get(up.source) : undefined;
          const angle = !grand ? -Math.PI / 2 + (2 * Math.PI * k) / count
            : Math.atan2(from.y - grand.y, from.x - grand.x) + (count === 1 ? 0 : (k / (count - 1) - 0.5) * Math.min((260 * Math.PI) / 180, (42 * Math.PI * count) / 180));
          const r = link.distance * scale * 0.9;
          x = from.x + Math.cos(angle) * r; y = from.y + Math.sin(angle) * r;
        }
        body = { id: n.id, x, y, vx: 0, vy: 0, fx: null, fy: null };
        bodies.current.set(n.id, body);
      }
      return body;
    });
    sim.setGraph(nodes, graph.links.map(l => ({ source: l.source, target: l.target, distance: l.distance * scale })));
    if (motion.current) { if (root.current?.dataset.ready !== undefined) sim.restart(1); }
    else { sim.alpha = 1; sim.settle(); }
    paint();
  }, [graph, size, focus]);

  useEffect(() => { const t = window.setTimeout(fit, 30); return () => window.clearTimeout(t); }, [current]);

  // It arrives once, the first time it comes into view
  useEffect(() => {
    const el = root.current; if (!el) return;
    const arrive = () => { el.dataset.ready = ''; if (motion.current) sim.restart(1); };
    if (typeof IntersectionObserver === 'undefined') { arrive(); return; }
    const watch = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) { watch.disconnect(); arrive(); } }, { threshold: 0.15 });
    watch.observe(el);
    return () => watch.disconnect();
  }, [sim]);

  const choose = (id: string) => {
    const next = id === current || id === ROOT ? null : id;
    setCurrent(next);
    if (next && size === 'small') requestAnimationFrame(() => {
      const top = root.current?.querySelector('.mm-sheet')?.getBoundingClientRect().top ?? 0;
      if (top > window.innerHeight - 160) window.scrollBy({ top: top - window.innerHeight + 300, behavior: 'smooth' });
    });
  };
  const back = () => setCurrent(null);
  const down = (e: PointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement, el = target.closest<HTMLElement>('.mm-node'), stageEl = stage.current;
    if (!stageEl || e.button !== 0) return;
    if (!el) {
      if (e.pointerType !== 'mouse' || target.closest('.mm-panel,.mm-corner,.mm-note,a,button')) return;
      panning.current = { x: e.clientX, y: e.clientY, px: pan.current.x, py: pan.current.y };
      stageEl.setPointerCapture?.(e.pointerId); stageEl.dataset.panning = '';
      return;
    }
    const body = bodies.current.get(el.dataset.id ?? ''); if (!body || !world.current) return;
    const r = world.current.getBoundingClientRect();
    el.setPointerCapture?.(e.pointerId);
    drag.current = { node: body, x: e.clientX, y: e.clientY, ox: (e.clientX - r.left)/zoom.current - body.x, oy: (e.clientY - r.top)/zoom.current - body.y, moved: false };
    body.fx = body.x; body.fy = body.y;
    sim.alphaTarget(0.3).restart();
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const p = panning.current;
    if (p) { setPan(Math.max(-600, Math.min(600, p.px + e.clientX - p.x)), Math.max(-400, Math.min(400, p.py + e.clientY - p.y))); return; }
    const d = drag.current, worldEl = world.current; if (!d || !worldEl) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) d.moved = true;
    const r = worldEl.getBoundingClientRect();
    d.node.fx = (e.clientX - r.left)/zoom.current - d.ox; d.node.fy = (e.clientY - r.top)/zoom.current - d.oy;
    if (!motion.current) paint();
  };
  const up = () => { if (panning.current) { panning.current = null; if (stage.current) delete stage.current.dataset.panning; return; } const d = drag.current; drag.current = null; if (!d) return; d.node.fx = null; d.node.fy = null; sim.alphaTarget(0); if (!d.moved) choose(d.node.id); };
  const setZoom=(value:number)=>{zoom.current=Math.max(.5,Math.min(2,value));stage.current?.style.setProperty('--zoom',String(zoom.current));};
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if(e.key==='Escape'&&current)back();
    if(e.target!==stage.current)return;
    const deltas:Record<string,[number,number]>={ArrowLeft:[40,0],ArrowRight:[-40,0],ArrowUp:[0,40],ArrowDown:[0,-40]};
    if(deltas[e.key]){e.preventDefault();const [x,y]=deltas[e.key]!;setPan(pan.current.x+x,pan.current.y+y);}
    if(e.key==='+'||e.key==='='){e.preventDefault();setZoom(zoom.current+.1);}
    if(e.key==='-'){e.preventDefault();setZoom(zoom.current-.1);}
    if(e.key==='Home'){e.preventDefault();home();}
  };
  const home = () => {setPan(0, 0);setZoom(1);};

  return <div className="mm scene" ref={root} data-focus={current ? '' : undefined} onKeyDown={key}>
    <div className="mm-stage" ref={stage} tabIndex={0} role="group" aria-label="Memory map. Arrow keys pan, plus and minus zoom, Home resets." onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <div className="mm-field">
        <div className="mm-dust" aria-hidden="true"><div className="mm-dust-drift">{DUST.map((d, i) => <i key={i} style={{ left: `${d.x}%`, top: `${d.y}%`, width: d.r * 2, height: d.r * 2, opacity: d.o, animationDelay: `${d.d}s` } as CSSProperties}/>)}</div></div>
        <div className="mm-world" ref={world}>
          <svg className="mm-links" aria-hidden="true">{graph.links.map((l, i) => <path key={l.id} ref={el => void (el ? pathEls.current.set(l.id, el) : pathEls.current.delete(l.id))} className={`mm-link mm-link--${l.kind}`} style={{ '--ed': `${i * 40}ms` } as CSSProperties}/>)}</svg>
          <div className="mm-nodes" role="group" aria-label="A map of what Waldo has saved. Drag a node and the rest follow; drag the empty space to look around. Choose one to read about it.">
            {graph.nodes.map((n, i) => <div key={n.id} ref={el => void (el ? nodeEls.current.set(n.id, el) : nodeEls.current.delete(n.id))} className="mm-node" data-id={n.id} data-shape={n.shape} data-current={n.id === current ? '' : undefined} data-connected={n.connected ? '' : undefined} style={{ '--ed': `${i * 50}ms` } as CSSProperties}>
              <button type="button" className="mm-hit" aria-label={`${n.title}, ${typeOf(n).toLowerCase()}`} aria-pressed={n.id === current} onFocus={()=>{setPan(0,0);setZoom(1);}} onClick={e => { if (e.detail === 0) choose(n.id); }}><Glyph shape={n.shape} number={n.number} current={n.id === current}/></button>
              <span className="mm-label"><b>{n.title}</b><i>{n.summary}</i></span>
            </div>)}
          </div>
        </div>
      </div>
      {corner && <div className="mm-corner">{corner}</div>}
      <div className="mm-note">{note}<button type="button" className="quiet" aria-label="Zoom out" onClick={()=>setZoom(zoom.current-.1)}>−</button><button type="button" className="quiet" aria-label="Zoom in" onClick={()=>setZoom(zoom.current+.1)}>+</button><button type="button" className="quiet" onClick={home}>Recentre</button></div>
      {complete && model.patterns.length === 0 && model.spots.size === 0 && <p className="mm-empty">Nothing saved yet. As he notices things, they’ll appear here.</p>}
      <ul className="mm-legend" aria-label="What the shapes mean">
        <li><Glyph shape="hexagon" size={13}/>Pattern</li><li><Glyph shape="circle" size={13}/>You said</li><li><Glyph shape="square" size={13}/>You confirmed</li><li><Glyph shape="triangle" size={13}/>He inferred</li>
      </ul>
      <aside className="mm-panel" ref={panel} data-open={current ? '' : undefined} aria-live="polite" aria-label="About the one you chose"><Panel model={model} current={current} returnTo={returnTo} onPick={choose} onClose={back}/></aside>
    </div>
    <details className="mm-inspect"><summary>Inspect returned map records ({model.returnedPatterns} patterns, {model.spots.size} Spots)</summary><p>Showing {graph.nodes.length-1} records on the map. Overlapping labels are hidden; all returned records remain available below or in List.</p><ul>{[...model.allPatterns.map(p=>({id:p.id,title:p.label,view:'constellation' as const})),...[...model.spots.values()].map(s=>({id:s.id,title:s.text,view:'spots' as const}))].map(n=><li key={n.id}><a href={memoryItemLink(n.view,n.id,returnTo)}>{n.title}</a></li>)}</ul><p>{model.returnedPatterns-model.patterns.length} returned patterns omitted by the map cap. All are inspectable above or in List.</p></details>
    <div className="mm-sheet" data-open={current ? '' : undefined}><div className="mm-sheet-in"><Panel model={model} current={current} returnTo={returnTo} onPick={choose} onClose={back}/></div></div>
  </div>;
}
