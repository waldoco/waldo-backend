import type {GraphPoint} from './constellation-layout';
// 12px bend setback avoids abrupt high-angle corners near node pads. It is geometry, not relationship strength.
export const TRACE_BEND=12;
export function circuitTrace(a:GraphPoint,b:GraphPoint):string {
 const dx=b.x-a.x,dy=b.y-a.y,sx=Math.sign(dx),sy=Math.sign(dy);
 const bend=Math.min(Math.abs(dx),Math.abs(dy),TRACE_BEND);
 const mid=a.x+dx/2;
 // Horizontal trunks, short 45-degree bends and a vertical riser; exact endpoints are the returned nodes.
 return `M ${a.x} ${a.y} L ${mid-sx*bend} ${a.y} L ${mid} ${a.y+sy*bend} L ${mid} ${b.y-sy*bend} L ${mid+sx*bend} ${b.y} L ${b.x} ${b.y}`;
}
