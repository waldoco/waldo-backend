import type {ConsoleView,ConsoleAction} from './console';
import {PROFILE_KINDS,awaitsOwnerConfirm} from '../memory/claims';
import {nodeConfirmation,nodeSources} from '../memory/node-sources';
// A separate owner-session control read. The Memory graph remains read-only and
// local IDs alone do not authorize a change; every target is resolved in this DO.
export function memoryControl(view:ConsoleView,scope:string,id:string){
 const claim=view.spots.find(c=>`${scope}:claim:${c.id}`===id),pending=view.forgettingSpots.find(c=>`${scope}:claim:${c.id}`===id),node=view.nodes.find(n=>`${scope}:node:${n.id}`===id);
 if(claim)return {id,kind:'claim' as const,source:claim.source,origin:claim.origin??'legacy',status:claim.status,review:{label:claim.text,note:claim.evidence,kind:claim.kind,seen:claim.seen_count,last_seen:claim.last_seen_at},actions:[...(awaitsOwnerConfirm(claim)?['spot.confirm']:[]),...(claim.pinned?['spot.unpin']:PROFILE_KINDS.includes(claim.kind)?['spot.pin']:[]),...(claim.status==='active'?['spot.edit']:[]),'spot.dismiss','spot.forget']};
 if(pending)return {id,kind:'claim' as const,source:pending.source,origin:pending.origin??'legacy',status:'purging',actions:['spot.forget']};
 // Confirm and correct act on a live node only; forget stays on any node, so a stale one can still be removed.
 if(node){const live=[...view.spots,...view.retiredSpots.filter(c=>c.status==='promoted')],confirmation=nodeConfirmation(live,node);
  return {id,kind:'interpretation' as const,status:node.status,review:{label:node.label,note:node.summary,domain:node.domain,support:node.supporting_spots,strength:node.strength,sources:nodeSources(live,node),confirmation},actions:[...(node.status==='active'?[...(confirmation==='waldos_read'?['node.confirm']:[]),'node.correct']:[]),'node.forget']};}
 return null;
}
export function resolveMemoryAction(view:ConsoleView,scope:string,action:ConsoleAction):ConsoleAction|null{
 const control=memoryControl(view,scope,action.id);if(!control?.actions.includes(action.action))return null;
 const rows=control.kind==='claim'?[...view.spots,...view.forgettingSpots]:view.nodes;
 const target=rows.find(row=>`${scope}:${control.kind==='claim'?'claim':'node'}:${row.id}`===action.id);
 return target?{...action,id:String(target.id)}:null;
}

export const MEMORY_CONTROL_PATH='/console/dashboard/api/v1/memory-controls';
export function projectMemoryControl(view:ConsoleView,scope:string,id:string){const data=memoryControl(view,scope,id);return data?{version:1 as const,view:'memory' as const,state:'available' as const,csrf:view.csrf,data}:null;}
