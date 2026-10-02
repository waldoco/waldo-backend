import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchMemory, memoryItemLink, type Claim, type Interpretation, type MemoryPattern } from './memory-model';
import { SignInRequired } from './model';

const SUPPORT_PREVIEW_LIMIT = 6;
const EMPTY_CLAIMS: Claim[] = [];
type Point = { x: number; y: number };
type SceneNode = { id: string; kind: 'pattern' | 'spot'; label: string; point: Point };
type SceneLink = { from: string; to: string; relation: string; kind: 'association' | 'support' };
export type SupportRead = { claims: Claim[]; failed: number; partial: boolean; signedOut: boolean; requested: number; omitted: number };

export async function loadSavedSupport(pattern: Interpretation, signal: AbortSignal): Promise<SupportRead> {
  const ids = [...new Set(pattern.support.claim_ids)];
  const requested = ids.slice(0, SUPPORT_PREVIEW_LIMIT);
  const results = await Promise.allSettled(requested.map(async id => {
    const detail = await fetchMemory(new URLSearchParams({ view: 'detail', id }), signal);
    if (detail.view !== 'detail' || detail.kind !== 'claim' || detail.item.id !== id || detail.state === 'unavailable') throw new Error('Saved supporting Spot unavailable.');
    return { claim: detail.item, partial: detail.state !== 'available' || !detail.complete };
  }));
  if (signal.aborted) throw new DOMException('Support read aborted.', 'AbortError');
  return {
    claims: results.flatMap(result => result.status === 'fulfilled' ? [result.value.claim] : []),
    failed: results.filter(result => result.status === 'rejected').length,
    partial: results.some(result => result.status === 'fulfilled' && result.value.partial),
    signedOut: results.some(result => result.status === 'rejected' && result.reason instanceof SignInRequired),
    requested: requested.length, omitted: ids.length - requested.length,
  };
}

// Positions are presentation only. Links come exclusively from returned associations
// or the selected pattern's stored support IDs, never spatial proximity.
export function constellationScene(data: MemoryPattern, focusId: string, claims: readonly Claim[]) {
  const patterns = [data.center, ...data.nodes];
  const focus = patterns.find(pattern => pattern.id === focusId) ?? data.center;
  const ids = new Set(patterns.map(pattern => pattern.id));
  const associations = data.associations.filter(link => ids.has(link.from) && ids.has(link.to) && link.from !== link.to);
  const adjacent = new Set(associations.filter(link => link.from === focus.id || link.to === focus.id).flatMap(link => [link.from, link.to]));
  const peers = patterns.filter(pattern => pattern.id !== focus.id).sort((a, b) => Number(adjacent.has(b.id)) - Number(adjacent.has(a.id)));
  const nodes: SceneNode[] = [{ id: focus.id, kind: 'pattern', label: focus.label, point: { x: 310, y: 250 } }];
  // Unequal branch lengths and staggered columns keep the scene out of a wheel.
  peers.forEach((pattern, index) => {
    const column = Math.floor(index / 4), row = index % 4;
    nodes.push({ id: pattern.id, kind: 'pattern', label: pattern.label, point: { x: Math.min(690, 440 + column * 105 + (row % 2 ? 15 : -8)), y: 70 + row * 112 + (column % 2 ? 18 : 0) } });
  });
  const supportIds = new Set(focus.support.claim_ids);
  const shown = [...new Map(claims.filter(claim => supportIds.has(claim.id)).map(claim => [claim.id, claim])).values()].slice(0, SUPPORT_PREVIEW_LIMIT);
  shown.forEach((claim, index) => nodes.push({ id: claim.id, kind: 'spot', label: claim.text, point: { x: index % 2 ? 170 : 75, y: 65 + index * 72 } }));
  const links: SceneLink[] = associations.map(link => ({ from: link.from, to: link.to, relation: link.relation, kind: 'association' }));
  shown.forEach(claim => links.push({ from: focus.id, to: claim.id, relation: 'Stored supporting Spot', kind: 'support' }));
  return { focus, nodes, links, claims: shown };
}

export function springStep(point: Point & { vx: number; vy: number }, target: Point) {
  const vx = (point.vx + (target.x - point.x) * .12) * .65;
  const vy = (point.vy + (target.y - point.y) * .12) * .65;
  return { x: Math.max(38, Math.min(722, point.x + vx)), y: Math.max(35, Math.min(465, point.y + vy)), vx, vy };
}
function useReducedMotion() {
  const [reduced, setReduced] = useState(() => typeof window === 'undefined' || !window.matchMedia || window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    if (!window.matchMedia) return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setReduced(query.matches);
    change(); query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  return reduced;
}
function useSettledScene(nodes: SceneNode[], reduced: boolean) {
  const target = useMemo(() => new Map(nodes.map(node => [node.id, node.point])), [nodes]);
  const [positions, setPositions] = useState(target);
  const current = useRef(positions);
  useEffect(() => {
    if (reduced) { current.current = target; setPositions(target); return; }
    let raf = 0, frame = 0;
    let moving = new Map([...target].map(([id, point]) => [id, { ...(current.current.get(id) ?? { x: 310, y: 250 }), vx: 0, vy: 0 }]));
    const step = () => {
      frame++;
      moving = new Map([...moving].map(([id, point]) => [id, springStep(point, target.get(id)!)]));
      const next = new Map([...moving].map(([id, point]) => [id, { x: point.x, y: point.y }]));
      current.current = next; setPositions(next);
      if (frame < 46) raf = requestAnimationFrame(step);
      else { current.current = target; setPositions(target); }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, reduced]);
  return positions;
}
const origin = (value: string) => value === 'shared' || value === 'untrusted' ? `${value} · untrusted provenance` : value;
const shortLabel = (value: string) => value.length > 29 ? `${value.slice(0, 28)}…` : value;

export function PatternExplorer({ data, onNext, onRestart }: { data: MemoryPattern; onNext: () => void; onRestart: () => void }) {
  const [focusId, setFocusId] = useState(data.center.id);
  const [selectedId, setSelectedId] = useState(data.center.id);
  const [supportRetry, setSupportRetry] = useState(0);
  const [support, setSupport] = useState<{ key: string; kind: 'loading' | 'ready'; read: SupportRead }>({ key: '', kind: 'loading', read: { claims: [], failed: 0, partial: false, signedOut: false, requested: 0, omitted: 0 } });
  const patternIds = data.nodes.map(node => node.id).join('|');
  const patterns = useMemo(() => [data.center, ...data.nodes], [data.center, data.nodes]);
  const focused = patterns.find(pattern => pattern.id === focusId) ?? data.center;
  const supportKey = focused.id + JSON.stringify(focused.support.claim_ids);
  useEffect(() => { setFocusId(data.center.id); setSelectedId(data.center.id); }, [data.center.id, patternIds]);
  useEffect(() => {
    const abort = new AbortController();
    setSupport({ key: supportKey, kind: 'loading', read: { claims: [], failed: 0, partial: false, signedOut: false, requested: 0, omitted: Math.max(0, focused.support.claim_ids.length - SUPPORT_PREVIEW_LIMIT) } });
    loadSavedSupport(focused, abort.signal).then(read => { if (!abort.signal.aborted) setSupport({ key: supportKey, kind: 'ready', read }); }).catch(() => {
      if (!abort.signal.aborted) setSupport({ key: supportKey, kind: 'ready', read: { claims: [], failed: Math.min(SUPPORT_PREVIEW_LIMIT, focused.support.claim_ids.length), partial: true, signedOut: false, requested: Math.min(SUPPORT_PREVIEW_LIMIT, focused.support.claim_ids.length), omitted: Math.max(0, focused.support.claim_ids.length - SUPPORT_PREVIEW_LIMIT) } });
    });
    return () => abort.abort();
  }, [supportKey, supportRetry]);
  const activeSupport = support.key === supportKey ? support : null;
  const claims = activeSupport?.read.claims ?? EMPTY_CLAIMS;
  const scene = useMemo(() => constellationScene(data, focused.id, claims), [data, focused.id, claims]);
  const reduced = useReducedMotion();
  const positions = useSettledScene(scene.nodes, reduced);
  const selectedSpot = scene.claims.find(claim => claim.id === selectedId);
  const selected = selectedSpot?.id ?? focused.id;
  const incident = new Set(scene.links.filter(link => link.from === selected || link.to === selected).flatMap(link => [link.from, link.to]));
  const choose = (node: SceneNode) => { setSelectedId(node.id); if (node.kind === 'pattern') setFocusId(node.id); };
  const declared = [...new Set(focused.support.claim_ids)].length;
  return <>
    <a href={memoryItemLink('constellation', data.center.id)}>← Back to pattern details</a>
    <div className="constellation-toolbar"><div><span className="eyebrow">Saved support · opt-in exploration</span><h2>{data.center.label}</h2><p>{data.showing.nodes} of {data.showing.of_nodes} returned neighboring patterns · {data.showing.links} of {data.showing.of_links} saved associations on this page</p></div><button onClick={onRestart}>Restart exploration</button></div>
    {(data.state !== 'available' || !data.complete) && <div className="memory-read-notice" role="status"><p>This Memory read is {data.state}. Missing or withheld records are not an empty Memory or completed removal.</p>{data.unavailable_claim_count > 0 && <p>{data.unavailable_claim_count} claims withheld during removal.</p>}</div>}
    <p className="constellation-guide">Hexagons are tentative patterns. Circles are returned Spots from the selected pattern’s saved support. Lines describe stored links—not truth, causation or verified independent observations.</p>
    {data.omitted_links > 0 && <p className="memory-read-notice">{data.omitted_links} associations omitted from this page.{data.expand.links_capped && ` ${data.expand.capped_links} capped associations cannot be recovered with this cursor.`}</p>}
    <div className="constellation-workspace" data-reduced-motion={reduced}>
      <div className="constellation-canvas"><svg viewBox="0 0 760 500" role="group" aria-label="Saved pattern and supporting Spot branches">
        {scene.links.map((link, index) => {
          const from = positions.get(link.from), to = positions.get(link.to);
          if (!from || !to) return null;
          const active = link.from === selected || link.to === selected;
          return <path key={`${link.kind}:${index}`} d={`M ${from.x} ${from.y} Q ${(from.x + to.x) / 2} ${(from.y + to.y) / 2 - 24} ${to.x} ${to.y}`} className={`constellation-link ${link.kind}${active ? ' active' : ' subdued'}`}><title>{`${link.relation} · ${link.kind === 'association' ? 'Unverified association' : 'Saved support, not independent evidence'}`}</title></path>;
        })}
        {scene.nodes.map(node => {
          const point = positions.get(node.id) ?? node.point;
          const active = node.id === selected, connected = incident.has(node.id);
          return <g key={node.id} transform={`translate(${point.x} ${point.y})`} role="button" tabIndex={0} aria-label={`Inspect ${node.kind === 'pattern' ? 'tentative pattern' : 'supporting Spot'} ${node.label}`} aria-pressed={active} className={`constellation-node ${node.kind}${active ? ' selected' : connected ? ' connected' : ' subdued'}`} onClick={() => choose(node)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(node); } }}>
            <circle r="24" className="constellation-hit"/>{node.kind === 'pattern' ? <polygon points="0,-13 12,-7 12,7 0,13 -12,7 -12,-7"/> : <circle r="8" className="constellation-spot"/>}<text y="35" textAnchor="middle">{shortLabel(node.label)}</text><title>{node.label}</title>
          </g>;
        })}
      </svg><p className="muted">Select a saved branch to inspect it. Keyboard: Tab, then Enter or Space. The returned branches also appear in the list below.</p></div>
      <aside className="panel constellation-inspector" aria-label="Selected saved item">
        {selectedSpot ? <><span className="eyebrow">Saved supporting Spot</span><h3>{selectedSpot.text}</h3><p>Kind: {selectedSpot.kind} · Source: {selectedSpot.source} · Origin: {origin(selectedSpot.origin)} · Status: {selectedSpot.status}</p><p>{selectedSpot.evidence.text}</p><p className="muted">Writer evidence note, not an original-message link or proof. Writer seen count: {selectedSpot.writer_seen_count ?? 'unavailable'}.</p><a href={memoryItemLink('spots', selectedSpot.id)}>Inspect this Spot</a></>
          : <><span className="eyebrow">Tentative pattern · {focused.domain}</span><h3>{focused.label}</h3><p>{focused.summary}</p><p>Stored status: {focused.stored_status}</p><p className="muted">Uncalibrated model estimate: {focused.estimate ?? 'unavailable'}. Independent observations remain unverified.</p><a href={memoryItemLink('constellation', focused.id)}>Inspect pattern details</a><p><a href={`${memoryItemLink('constellation', focused.id)}&explore=1`}>Explore from this pattern</a></p></>}
        <div className="constellation-support"><h4>Saved supporting Spots</h4><p>{scene.claims.length} returned of {declared} declared saved support IDs · {focused.support.unavailable_count} unavailable in the pattern read</p>
          {!activeSupport || activeSupport.kind === 'loading' ? <p role="status">Reading up to six supporting Spots…</p> : <>
            {activeSupport.read.failed > 0 && <p role="alert">{activeSupport.read.failed} selected supporting Spot reads unavailable. Missing details are not proof of an empty support set.</p>}
            {activeSupport.read.partial && <p className="muted">Some support reads are incomplete. Do not treat this branch as verified evidence.</p>}
            {activeSupport.read.omitted > 0 && <p>{activeSupport.read.omitted} declared support IDs omitted from this six-Spot preview.</p>}
            {activeSupport.read.signedOut && <a href="/console/signin">Sign in to read supporting Spots</a>}
            {!scene.claims.length && !declared && <p>No saved supporting Spot IDs were returned for this pattern.</p>}
          </>}
          <ul>{scene.claims.map(claim => <li key={claim.id}><button aria-pressed={claim.id === selected} onClick={() => setSelectedId(claim.id)}>{claim.text}</button><small>{claim.kind} · {claim.source} · {origin(claim.origin)}</small></li>)}</ul>
          <button onClick={() => setSupportRetry(value => value + 1)}>Refresh saved support</button>
        </div>
      </aside>
    </div>
    <section className="panel constellation-list"><h3>Saved branches · list fallback</h3><div className="constellation-pattern-list">{scene.nodes.filter(node => node.kind === 'pattern').map(node => <button key={node.id} aria-pressed={node.id === selected} onClick={() => choose(node)}>{node.label}</button>)}</div>
      <ul>{scene.links.filter(link => link.kind === 'association').map((link, index) => <li key={index}><a href={memoryItemLink('constellation', link.from)}>{patterns.find(pattern => pattern.id === link.from)?.label}</a> → <a href={memoryItemLink('constellation', link.to)}>{patterns.find(pattern => pattern.id === link.to)?.label}</a><p>{link.relation} · Unverified association</p></li>)}</ul>{!data.associations.length && <p>No saved associations returned on this page.</p>}
    </section>
    <nav className="memory-pagination" aria-label="Saved connection pages"><button onClick={onRestart}>First page</button><button disabled={!data.expand.next_cursor} onClick={onNext}>Next neighboring patterns</button></nav>
  </>;
}
