import {it,expect} from 'vitest';import {circuitTrace,TRACE_TRUNK} from './graph-traces';
it('deterministically connects exact endpoints with horizontal, vertical or 45 degree segments',()=>{
 for(const b of [{x:300,y:220},{x:-100,y:-60},{x:0,y:0},{x:10,y:250}]){
  const a={x:0,y:0},path=circuitTrace(a,b);expect(circuitTrace(a,b)).toBe(path);
  const values=path.match(/-?\d+(?:\.\d+)?/g)!.map(Number);expect(values.slice(0,2)).toEqual([0,0]);expect(values.slice(-2)).toEqual([b.x,b.y]);
  for(let i=2;i<values.length;i+=2){const dx=Math.abs(values[i]!-values[i-2]!),dy=Math.abs(values[i+1]!-values[i-1]!);expect(dx===0||dy===0||Math.abs(dx-dy)<.001).toBe(true);}
 }
});

it('keeps source-side risers in a compact band without changing endpoints',()=>{
 const path=circuitTrace({x:100,y:100},{x:900,y:700});const values=path.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
 expect(values[4]!-100).toBeLessThanOrEqual(TRACE_TRUNK);expect(values.slice(-2)).toEqual([900,700]);
});
it('never reverses x or y on small-dx or small-dy routes',()=>{
 for(const b of [{x:10,y:250},{x:300,y:15},{x:-10,y:-250},{x:-300,y:-15}]){
  const values=circuitTrace({x:0,y:0},b).match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  for(let i=2;i<values.length;i+=2){expect((values[i]!-values[i-2]!)*Math.sign(b.x)).toBeGreaterThanOrEqual(0);expect((values[i+1]!-values[i-1]!)*Math.sign(b.y)).toBeGreaterThanOrEqual(0);}
 }
});
it('varies traces only by stable ids within monotonic compact bounds',()=>{
 const a={x:0,y:0},b={x:700,y:500};const paths=['a:b:association','a:c:support','b:c:association'].map(id=>circuitTrace(a,b,id));
 expect(new Set(paths).size).toBeGreaterThan(1);expect(circuitTrace(a,b,'a:b:association')).toBe(paths[0]);
 for(const path of paths){const v=path.match(/-?\d+(?:\.\d+)?/g)!.map(Number);for(let i=2;i<v.length;i+=2){expect(v[i]!-v[i-2]!).toBeGreaterThanOrEqual(0);expect(v[i+1]!-v[i-1]!).toBeGreaterThanOrEqual(0);}expect(v[4]).toBeLessThanOrEqual(TRACE_TRUNK);}
});
