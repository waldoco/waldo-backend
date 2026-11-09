// World units equal CSS pixels at zoom 1. Values describe geometry, not importance.
export const GRAPH_GEOMETRY = {
  labelWidth: 252, // 18 full-em 13px glyphs (234px), both 5px halo sides and 8px font margin. Covers W/M/CJK, not average character width.
  above: 30, // 60px hit circle keeps a 45px target even at minimum 0.75 zoom.
  below: 58, // Node radius + two 16px label baselines + halo.
  gap: 18, // Breathing room between combined label/hit rectangles.
  margin: 80, // Keep edge labels and drag targets away from the initial world border.
  minWidth: 1000, minHeight: 700, // Desktop review surface, not a fixed viewport.
  cellArea: 52000, // Full-em label/hit rectangle plus connecting whitespace.
  radiusBase: 5, radiusPerRootDegree: 2, radiusMax: 16, // Sublinear page degree; cap leaves labels readable.
  linkLength: 270, // Full-em label-width plus gutter keeps linked items distinct.
  linkPull: .018, // Small spring step avoids overshooting collision corrections.
  repel: 16000, // Inverse-square repulsion provides space at the 270px link distance.
  centerPull: .002, // Weak containment, not a semantic grouping force.
  steps: 220, // Finite deterministic settling budget; never a continuous idle animation.
  collisionPasses: 260, // Bounded rectangle relaxation before deterministic grid recovery.
  zoomMin: .75, zoomMax: 1.75, zoomStep: .15, // 45px hit target at min; max preserves context.
} as const;
export type GraphNode = {id:string;label:string;kind:'pattern'|'spot'};
export type GraphLink = {from:string;to:string};
export type GraphPoint = {x:number;y:number};
export type PositionedNode = GraphNode & GraphPoint & {degree:number;radius:number};
export type GraphLayout = {nodes:PositionedNode[];width:number;height:number;recovered:boolean};
export function graphLabel(value:string):string[] {
  const limit=18;
  if(value.length<=limit)return [value];
  const space=value.lastIndexOf(' ',limit),cut=space>7?space:limit,rest=value.slice(cut).trimStart();
  return [value.slice(0,cut),rest.length>limit?rest.slice(0,limit-1)+'…':rest];
}
const hash=(s:string)=>{let h=2166136261;for(const ch of s)h=Math.imul(h^ch.charCodeAt(0),16777619);return h>>>0;};
export const overlaps=(a:GraphPoint,b:GraphPoint)=>Math.abs(a.x-b.x)<GRAPH_GEOMETRY.labelWidth+GRAPH_GEOMETRY.gap && Math.abs(a.y-b.y)<GRAPH_GEOMETRY.above+GRAPH_GEOMETRY.below+GRAPH_GEOMETRY.gap;
export function layoutGraph(input:readonly GraphNode[],links:readonly GraphLink[]):GraphLayout {
  const g=GRAPH_GEOMETRY,items=[...new Map(input.map(n=>[n.id,n])).values()].sort((a,b)=>a.id.localeCompare(b.id));
  const width=Math.max(g.minWidth,Math.sqrt(items.length*g.cellArea)*1.2),height=Math.max(g.minHeight,width/1.45);
  const ids=new Set(items.map(n=>n.id));
  // Parallel relation records remain in the renderer, but degree counts unique neighbors.
  const neighbors=new Map(items.map(n=>[n.id,new Set<string>()]));
  for(const l of links)if(l.from!==l.to&&ids.has(l.from)&&ids.has(l.to)){neighbors.get(l.from)!.add(l.to);neighbors.get(l.to)!.add(l.from);}
  const nodes:PositionedNode[]=items.map(n=>{const seed=hash(n.id),angle=(seed%360)*Math.PI/180,radius=100+(seed%170);const degree=neighbors.get(n.id)!.size;return {...n,x:width/2+Math.cos(angle)*radius,y:height/2+Math.sin(angle)*radius,degree,radius:Math.min(g.radiusMax,g.radiusBase+Math.sqrt(degree)*g.radiusPerRootDegree)};});
  const index=new Map(nodes.map((n,i)=>[n.id,i]));
  const constrain=(n:PositionedNode)=>{n.x=Math.max(g.margin,Math.min(width-g.margin,n.x));n.y=Math.max(g.margin,Math.min(height-g.margin,n.y));};
  const separate=(bounded=true)=>{
    let count=0;
    for(let i=0;i<nodes.length;i++)for(let j=0;j<i;j++){
      const a=nodes[i]!,b=nodes[j]!,dx=a.x-b.x,dy=a.y-b.y;
      const ox=g.labelWidth+g.gap-Math.abs(dx),oy=g.above+g.below+g.gap-Math.abs(dy);
      if(ox<=0||oy<=0)continue;count++;
      if(ox<oy){const step=(ox+.1)/2*(dx>=0?1:-1);a.x+=step;b.x-=step;}else{const step=(oy+.1)/2*(dy>=0?1:-1);a.y+=step;b.y-=step;}
      if(bounded){constrain(a);constrain(b);}
    }return count;
  };
  for(let step=0;step<g.steps;step++){
    const delta=nodes.map(n=>({x:(width/2-n.x)*g.centerPull,y:(height/2-n.y)*g.centerPull}));
    for(let i=0;i<nodes.length;i++)for(let j=0;j<i;j++){
      const a=nodes[i]!,b=nodes[j]!,dx=a.x-b.x,dy=a.y-b.y,d=Math.max(1,Math.hypot(dx,dy)),f=Math.min(6,g.repel/(d*d));
      delta[i]!.x+=dx/d*f;delta[i]!.y+=dy/d*f;delta[j]!.x-=dx/d*f;delta[j]!.y-=dy/d*f;
    }
    for(const a of nodes)for(const target of neighbors.get(a.id)!){if(a.id>=target)continue;const i=index.get(a.id)!,j=index.get(target)!,b=nodes[j]!,dx=b.x-a.x,dy=b.y-a.y,d=Math.max(1,Math.hypot(dx,dy)),f=(d-g.linkLength)*g.linkPull;delta[i]!.x+=dx/d*f;delta[i]!.y+=dy/d*f;delta[j]!.x-=dx/d*f;delta[j]!.y-=dy/d*f;}
    nodes.forEach((n,i)=>{n.x+=delta[i]!.x;n.y+=delta[i]!.y;constrain(n);});separate();
  }
  for(let pass=0;pass<g.collisionPasses&&separate(false)>0;pass++){}
  let recovered=false;
  if(nodes.some((a,i)=>nodes.slice(0,i).some(b=>overlaps(a,b)))) {
    // Honest geometric recovery: every node stays present; no silent drop or new relation.
    recovered=true;const columns=Math.max(1,Math.floor((width-g.margin*2)/(g.labelWidth+g.gap)));
    nodes.forEach((n,i)=>{n.x=g.margin+(i%columns)*(g.labelWidth+g.gap);n.y=g.margin+Math.floor(i/columns)*(g.above+g.below+g.gap);});
  }
  const left=Math.min(g.margin,...nodes.map(n=>n.x-g.labelWidth/2)),top=Math.min(g.margin,...nodes.map(n=>n.y-g.above));
  nodes.forEach(n=>{n.x+=g.margin-left;n.y+=g.margin-top;});
  const right=Math.max(width,...nodes.map(n=>n.x+g.labelWidth/2+g.margin)),bottom=Math.max(height,...nodes.map(n=>n.y+g.below+g.margin));
  return {nodes,width:right,height:bottom,recovered};
}
