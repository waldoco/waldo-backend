import {it,expect} from 'vitest';import {circuitTrace} from './graph-traces';
it('deterministically connects exact endpoints with horizontal, vertical or 45 degree segments',()=>{
 for(const b of [{x:300,y:220},{x:-100,y:-60},{x:0,y:0},{x:10,y:250}]){
  const a={x:0,y:0},path=circuitTrace(a,b);expect(circuitTrace(a,b)).toBe(path);
  const values=path.match(/-?\d+(?:\.\d+)?/g)!.map(Number);expect(values.slice(0,2)).toEqual([0,0]);expect(values.slice(-2)).toEqual([b.x,b.y]);
  for(let i=2;i<values.length;i+=2){const dx=Math.abs(values[i]!-values[i-2]!),dy=Math.abs(values[i+1]!-values[i-1]!);expect(dx===0||dy===0||Math.abs(dx-dy)<.001).toBe(true);}
 }
});
