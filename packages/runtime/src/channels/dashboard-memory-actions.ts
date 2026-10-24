import type {ConsoleView,ConsoleAction} from './console';
// A separate owner-session control read. The Memory graph remains read-only and
// local IDs alone do not authorize a change; every target is resolved in this DO.
export function memoryControl(view:ConsoleView,scope:string,id:string){
 const claim=view.spots.find(c=>`${scope}:claim:${c.id}`===id),pending=view.forgettingSpots.find(c=>`${scope}:claim:${c.id}`===id);
 if(claim)return {id,kind:'claim' as const,source:claim.source,origin:claim.origin??'legacy',status:claim.status,review:{label:claim.text,note:claim.evidence,kind:claim.kind,seen:claim.seen_count,last_seen:claim.last_seen_at},actions:[...(claim.source==='inferred'?['spot.confirm']:[]),'spot.dismiss','spot.forget']};
 if(pending)return {id,kind:'claim' as const,source:pending.source,origin:pending.origin??'legacy',status:'purging',actions:['spot.forget']};
 return null;
}
export function resolveMemoryAction(view:ConsoleView,scope:string,action:ConsoleAction):ConsoleAction|null{
 const control=memoryControl(view,scope,action.id);if(!control?.actions.includes(action.action))return null;
 const target=[...view.spots,...view.forgettingSpots].find(row=>`${scope}:claim:${row.id}`===action.id);
 return target?{...action,id:String(target.id)}:null;
}

export const MEMORY_CONTROL_PATH='/console/dashboard/api/v1/memory-controls';
export function projectMemoryControl(view:ConsoleView,scope:string,id:string){const data=memoryControl(view,scope,id);return data?{version:1 as const,view:'memory' as const,state:'available' as const,csrf:view.csrf,data}:null;}
