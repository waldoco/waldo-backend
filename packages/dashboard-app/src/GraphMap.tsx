import {useEffect,useMemo,useRef,useState} from 'react';
import {GRAPH_GEOMETRY as g,graphLabel,layoutGraph,type GraphNode,type GraphLink,type GraphPoint} from './constellation-layout';
export type MapLink=GraphLink & {relation:string;kind:'association'|'support'};
export function GraphMap({nodes,links,selected,onSelect,reduced,resetKey}:{nodes:GraphNode[];links:MapLink[];selected:string;onSelect:(id:string)=>void;reduced:boolean;resetKey?:string}) {
 const inputSignature=JSON.stringify([nodes,links]);
 const scene=useMemo(()=>layoutGraph(nodes,links),[inputSignature]);
 const [moved,setMoved]=useState(new Map<string,GraphPoint>()),[hover,setHover]=useState<string|null>(null);
 const [view,setView]=useState({x:0,y:0,zoom:1});
 const gesture=useRef<{id:number;node:string|null;clientX:number;clientY:number;start:GraphPoint;dragged:boolean}|null>(null);
 const svg=useRef<SVGSVGElement>(null),scroll=useRef<HTMLDivElement>(null),dragged=useRef(false);
 useEffect(()=>{setMoved(new Map());setView({x:0,y:0,zoom:1});const p=scene.nodes.find(n=>n.id===selected);if(scroll.current&&p)scroll.current.scrollLeft=Math.max(0,p.x-scroll.current.clientWidth/2);},[resetKey]);
 const active=hover??selected,neighbors=new Set(links.filter(l=>l.from===active||l.to===active).flatMap(l=>[l.from,l.to]));
 const point=(id:string)=>moved.get(id)??scene.nodes.find(n=>n.id===id);
 const zoom=(amount:number)=>setView(v=>({...v,zoom:Math.max(g.zoomMin,Math.min(g.zoomMax,v.zoom+amount))}));
 const begin=(event:React.PointerEvent<SVGSVGElement>)=>{
  const target=(event.target as Element).closest('[data-node]'),id=target?.getAttribute('data-node')??null,p=id?point(id):null;
  if(event.pointerType==='touch'&&!id)return; // Background touch stays native scrolling; nodes opt into dragging.

  gesture.current={id:event.pointerId,node:id,clientX:event.clientX,clientY:event.clientY,start:p?{x:p.x,y:p.y}:{x:view.x,y:view.y},dragged:false};
  dragged.current=false;
 };
 const move=(event:React.PointerEvent<SVGSVGElement>)=>{
  const state=gesture.current;if(!state||state.id!==event.pointerId)return;
  const factor=scene.width/(svg.current?.getBoundingClientRect().width||scene.width),dx=(event.clientX-state.clientX)*factor,dy=(event.clientY-state.clientY)*factor;
  if(!state.dragged&&Math.hypot(dx,dy)>4){state.dragged=true;dragged.current=true;event.currentTarget.setPointerCapture?.(event.pointerId);}
  if(!state.dragged)return; // 4 world px distinguishes a click from minor pointer jitter.
  if(state.node)setMoved(old=>new Map(old).set(state.node!,{x:state.start.x+dx/view.zoom,y:state.start.y+dy/view.zoom}));
  else setView(v=>({...v,x:state.start.x+dx,y:state.start.y+dy}));
 };
 const reset=()=>{setView({x:0,y:0,zoom:1});setMoved(new Map());};
 return <div className="force-map" data-reduced-motion={reduced}>
  <div className="graph-tools" aria-label="Graph view controls"><button onClick={()=>zoom(-g.zoomStep)} aria-label="Zoom out" disabled={view.zoom<=g.zoomMin}>-</button><output aria-live="polite">{Math.round(view.zoom*100)}%</output><button onClick={()=>zoom(g.zoomStep)} aria-label="Zoom in" disabled={view.zoom>=g.zoomMax}>+</button><button onClick={reset}>Reset view</button><button onClick={()=>setView(v=>({...v,x:v.x+g.margin}))} aria-label="Pan left">←</button><button onClick={()=>setView(v=>({...v,x:v.x-g.margin}))} aria-label="Pan right">→</button><button onClick={()=>setView(v=>({...v,y:v.y+g.margin}))} aria-label="Pan up">↑</button><button onClick={()=>setView(v=>({...v,y:v.y-g.margin}))} aria-label="Pan down">↓</button></div>
  <div ref={scroll} className="force-map-scroll" role="region" aria-label="Saved graph map; horizontal scroll available" tabIndex={0}>
   <svg ref={svg} style={{width:scene.width,minWidth:scene.width}} viewBox={`0 0 ${scene.width} ${scene.height}`} role="group" aria-label="Saved pattern and supporting Spot graph" onPointerDown={begin} onPointerMove={move} onPointerUp={()=>{gesture.current=null;}} onPointerCancel={()=>{gesture.current=null;}}
    tabIndex={0} onKeyDown={event=>{
     if(event.target!==event.currentTarget)return;
     if(event.key==='+'||event.key==='='){event.preventDefault();zoom(g.zoomStep);}else if(event.key==='-'){event.preventDefault();zoom(-g.zoomStep);}else if(event.key==='0'){event.preventDefault();reset();}
     else if(event.key==='Escape')setHover(null);
     else if(event.key.startsWith('Arrow')){event.preventDefault();setView(v=>({...v,x:v.x+(event.key==='ArrowLeft'?g.margin:event.key==='ArrowRight'?-g.margin:0),y:v.y+(event.key==='ArrowUp'?g.margin:event.key==='ArrowDown'?-g.margin:0)}));}
    }}>
    <g transform={`translate(${scene.width/2+view.x} ${scene.height/2+view.y}) scale(${view.zoom}) translate(${-scene.width/2} ${-scene.height/2})`}>
    {links.map((link,i)=>{const a=point(link.from),b=point(link.to);if(!a||!b)return null;return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={`graph-edge ${link.kind} ${link.from===active||link.to===active?'active':'subdued'}`}><title>{link.relation} · {link.kind==='support'?'Saved support, not independent evidence':'Unverified association'}</title></line>;})}
    {scene.nodes.map(node=>{const p=point(node.id)!;return <g key={node.id} data-node={node.id} transform={`translate(${p.x} ${p.y})`} className={`graph-node ${node.kind} ${node.id===selected?'selected':neighbors.has(node.id)?'neighbor':'subdued'}`} role="button" tabIndex={0} aria-label={`Inspect ${node.kind==='pattern'?'tentative pattern':'supporting Spot'} ${node.label}; ${node.degree} links on this returned page`} aria-pressed={node.id===selected}
     onPointerEnter={()=>setHover(node.id)} onPointerLeave={()=>setHover(null)} onFocus={()=>{setHover(node.id);if(scroll.current)scroll.current.scrollLeft=Math.max(0,p.x-scroll.current.clientWidth/2);}} onBlur={()=>setHover(null)} onClick={()=>{if(!dragged.current)onSelect(node.id);dragged.current=false;}} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onSelect(node.id);}if(e.key==='Escape'){setHover(null);svg.current?.focus();}}}>
     <circle r="30" className="graph-hit"/>{node.kind==='pattern'?<circle r={node.radius} className="graph-glyph"/>:<circle r={node.radius} className="graph-glyph spot"/>}
     <text y="34" textAnchor="middle">{graphLabel(node.label).map((label,i)=><tspan x="0" dy={i?16:0} key={i}>{label}</tspan>)}</text><title>{node.label}</title>
    </g>;})}</g>
   </svg>
  </div>
  <p className="graph-legend">● Tentative pattern · ○ Supporting Spot · Size = unique links on this returned page</p>
  <p className="muted">Select to inspect. Hover or focus highlights saved neighbors. Mouse: drag nodes or pan background. Touch: drag a node, or scroll the background and use view controls. Keyboard: Tab then Enter; map arrows pan, +/- zoom, 0 resets.</p>
  {scene.recovered&&<p className="muted">A spaced layout was used to keep all returned labels readable.</p>}
 </div>;
}
