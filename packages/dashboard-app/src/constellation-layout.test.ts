import {it,expect} from 'vitest';
import {layoutGraph,overlaps,GRAPH_GEOMETRY as g,type GraphNode} from './constellation-layout';
const fixture=(count:number):GraphNode[]=>Array.from({length:count},(_,i)=>({id:`node:${i}`,label:`Long tentative saved pattern ${i}`,kind:'pattern'}));
it('is deterministic under input order and preserves all returned nodes and isolates',()=>{
 const nodes=fixture(26),links=[{from:nodes[0]!.id,to:nodes[1]!.id}];
 expect(layoutGraph(nodes,links)).toEqual(layoutGraph([...nodes].reverse(),links));
 expect(layoutGraph(nodes,links).nodes).toHaveLength(26);
 expect(layoutGraph(nodes,links).nodes.find(n=>n.id==='node:2')?.degree).toBe(0);
});
it('settles hit and two-line label boxes without collisions for dense and sparse scenes',()=>{
 for(const count of [0,1,2,26,32,60]){
  const nodes=fixture(count),scene=layoutGraph(nodes,nodes.slice(1).map(n=>({from:'node:0',to:n.id})));
  for(const [i,a] of scene.nodes.entries()){
   expect(a.x-g.labelWidth/2).toBeGreaterThanOrEqual(0);expect(a.y+g.below).toBeLessThan(scene.height);
   for(const b of scene.nodes.slice(0,i))expect(overlaps(a,b)).toBe(false);
  }
 }
});
it('uses unique returned neighbors for radius, never foreign/self links or confidence',()=>{
 const nodes=fixture(3),scene=layoutGraph(nodes,[{from:'node:0',to:'node:1'},{from:'node:0',to:'node:1'},{from:'node:0',to:'foreign'},{from:'node:2',to:'node:2'}]);
 expect(scene.nodes.map(n=>n.degree)).toEqual([1,1,0]);expect(scene.nodes[0]!.radius).toBeGreaterThan(scene.nodes[2]!.radius);
});
it('bounds 18 full-em glyphs plus halo, including wide Latin and CJK labels',()=>{
 // 13px rendered text: conservative full-em advance for each glyph, plus both halo sides.
 const measuredWorstWidth=18*13+10;
 expect(g.labelWidth).toBeGreaterThanOrEqual(measuredWorstWidth);
 for(const text of ['W'.repeat(18),'M'.repeat(18),'界'.repeat(18)]){
  const scene=layoutGraph(fixture(26).map(n=>({...n,label:text})),fixture(26).slice(1).map(n=>({from:'node:0',to:n.id})));
  for(const [i,a] of scene.nodes.entries())for(const b of scene.nodes.slice(0,i)){
   expect(Math.abs(a.x-b.x)>=measuredWorstWidth || Math.abs(a.y-b.y)>=g.above+g.below).toBe(true);
  }
 }
});
