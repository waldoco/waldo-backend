import type {GraphPoint} from './constellation-layout';
// World/CSS px at zoom 1. Geometry is presentation only, not relationship strength.
export const TRACE_BEND=8; // Compact chamfer, below the earlier 12px circuit corner.
export const TRACE_TRUNK=64; // Source-side risers stay in a compact band near the pad.
const hash=(s:string)=>{let h=2166136261;for(const c of s)h=Math.imul(h^c.charCodeAt(0),16777619);return h>>>0;};
export function circuitTrace(a:GraphPoint,b:GraphPoint,traceId=''):string {
 const dx=b.x-a.x,dy=b.y-a.y,sx=Math.sign(dx),sy=Math.sign(dy),seed=hash(traceId);
 // ID-seeded variation: 32-64px trunk band, 0.36-0.50 local fraction, 4-8px chamfer.
 // These bounds keep traces closed together and cannot change between selection renders.
 const trunk=TRACE_TRUNK/2+(seed%33),fraction=.36+((seed>>>8)%15)/100;
 const offset=Math.min(trunk,Math.abs(dx)*fraction),mid=a.x+sx*offset;
 // Half-distance bounds prevent backtracking for small dx/dy. Offset is tighter than dx/2 where trunk is near source.
 const bend=Math.min(4+((seed>>>16)%5),TRACE_BEND,Math.abs(dx)/2,Math.abs(dy)/2,offset,Math.abs(dx)-offset);
 return `M ${a.x} ${a.y} L ${mid-sx*bend} ${a.y} L ${mid} ${a.y+sy*bend} L ${mid} ${b.y-sy*bend} L ${mid+sx*bend} ${b.y} L ${b.x} ${b.y}`;
}
