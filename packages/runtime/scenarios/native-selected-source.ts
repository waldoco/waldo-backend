// Selection boundary precedes collection. Never list/read denied rows then filter.
import type { IsolatedSourceWorld } from './isolated-source-world';
export const nativeSelectedSource=(world:IsolatedSourceWorld,owner:string,selected:Readonly<Record<string,readonly string[]>>):Pick<IsolatedSourceWorld,'read'|'list'|'now'>=>{
 const scope=structuredClone(selected);
 return {
 now:()=>world.now(),
 read:(requestedOwner,family,id)=>{
  if(requestedOwner!==owner||!scope[family]?.includes(id)){world.deniedAccess(owner,family,id);throw new Error('native source selection denied');}
  return world.read(owner,family,id);
 },
 list:(requestedOwner,family)=>{
  if(requestedOwner!==owner||!scope[family]){world.deniedAccess(owner,family,null);throw new Error('native source family denied');}
  return scope[family]!.flatMap(id=>{const row=world.read(owner,family,id);return row?[row]:[];});
 },
 };
};
