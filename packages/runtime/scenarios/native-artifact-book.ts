// Test-only source mapping through the existing artifact read handlers. No product
// tool changes, provider effects or readiness declaration. Every revision mapping
// is explicit supervisor input; never turn an unknown source revision into r1.
import { createHash } from 'node:crypto';
import type { ArtifactBook, ArtifactMeta } from '../src/channels/artifacts';
import type { ArtifactKind } from '@waldo/contracts';
import type { IsolatedSourceWorld } from './isolated-source-world';
export type NativeArtifactBinding=Readonly<{source_id:string;name:string;kind:ArtifactKind;revisions:Readonly<Record<string,number>>}>;
export const nativeArtifactBook=(source:Pick<IsolatedSourceWorld,'read'|'list'>,owner:string,bindings:readonly NativeArtifactBinding[]):ArtifactBook=>{
 const map=structuredClone(bindings);
 if(!owner||new Set(map.map(b=>b.source_id)).size!==map.length||map.some(b=>!b.source_id||!b.name||!['document','research','data','shortlist'].includes(b.kind)||!Object.keys(b.revisions).length||new Set(Object.values(b.revisions)).size!==Object.values(b.revisions).length||Object.values(b.revisions).some(r=>!Number.isSafeInteger(r)||r<1)))throw new Error('invalid native artifact bindings');
 const load=(id:string):{meta:ArtifactMeta;bytes:string}|null=>{
  const binding=map.find(b=>b.source_id===id);if(!binding)throw new Error('native artifact selection denied');
  const row=source.read(owner,'files',id);if(!row)return null;
  if(row.owner_id!==owner||row.id!==id||typeof row.bytes!=='string'||typeof row.revision!=='string'||!Object.hasOwn(binding.revisions,row.revision))throw new Error('native artifact source differs');
  if(typeof row.digest!=='string'||row.digest!==`sha256:${createHash('sha256').update(row.bytes,'utf8').digest('hex')}`)throw new Error('native artifact bytes differ');
  const at=typeof row.dated==='string'?Date.parse(row.dated):NaN;if(!Number.isFinite(at))throw new Error('native artifact source time missing');
  return {bytes:row.bytes,meta:{id,name:binding.name,kind:binding.kind,revision:binding.revisions[row.revision]!,byte_size:new TextEncoder().encode(row.bytes).length,r2_key:'synthetic-only-no-body-key',provenance:`synthetic-source:${row.revision}`,taint:'external',created_at:at,updated_at:at}};
 };
 const reject=():never=>{throw new Error('native artifact writes unsupported');};
 return {
  create:async()=>reject(),revise:async()=>reject(),
  list:kind=>map.flatMap(b=>{if(kind!==undefined&&kind!==b.kind)return [];const row=load(b.source_id);return row?[structuredClone(row.meta)]:[];}),
  byId:id=>{const row=load(id);return row?structuredClone(row.meta):null;},
  read:async(id,offset,length)=>{
   if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)||length<1||length>8000)throw new Error('invalid native artifact range');
   const row=load(id);if(!row)return null;const text=row.bytes.slice(offset,offset+length),next=offset+text.length;
   return {meta:structuredClone(row.meta),text,total_chars:row.bytes.length,next_offset:next<row.bytes.length?next:null};
  },
 };
};
