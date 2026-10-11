import {expect,it} from 'vitest';
import {browserUploadBinding,browserUploadBytes} from '../src/channels/browser-upload-binding';
import {generalDigest} from '../src/channels/general-browser-observation';
import type {BrowserSession} from '@waldo/contracts';
import type {GeneralActionSnapshot} from '../src/channels/general-browser-observation';
const bytes=new TextEncoder().encode('fictional,7\n');
async function fixture(){
 const now=Date.now(),session={ownerId:'owner',id:'session',generation:1,expiresAt:now+60000} as BrowserSession;
 const snapshot={ownerId:session.ownerId,sessionId:session.id,generation:session.generation,digest:'document-digest',targetId:'private-provider-target',observation:{revision:'revision-1',url:'https://upload.fixture.invalid/account',elements:[{ref:'input-ref'}]},state:{elements:[{tag:'input',type:'file',disabled:false,inForm:true,selector:'input',formAction:'https://upload.fixture.invalid/import',formMethod:'post'}]}} as unknown as GeneralActionSnapshot;
 const file={file_id:crypto.randomUUID(),revision:1,path:'reports/report.csv',mime:'text/csv',byte_size:bytes.length,sha256:await generalDigest(bytes),state:'ready'} as const;
 const binding=browserUploadBinding({session,snapshot,elementRef:'input-ref',file,operationId:crypto.randomUUID(),now});
 return {now,session,snapshot,file,binding};
}
it('binds exact owner/session/generation/document/file revision and destination without provider target or raw bytes',async()=>{
 const f=await fixture();expect(f.binding).toMatchObject({ownerId:'owner',sessionHandle:'session',generation:1,documentDigest:'document-digest',documentRevision:'revision-1',fileId:f.file.file_id,revision:1,filename:'report.csv',byteSize:bytes.length,sha256:f.file.sha256,destination:'https://upload.fixture.invalid/import'});
 expect(JSON.stringify(f.binding)).not.toContain('private-provider-target');expect(JSON.stringify(f.binding)).not.toContain('fictional,7');
});
it.each(['owner','session','generation','document','revision','element','file','hash','size','filename','destination'] as const)('changed %s binding refuses bytes before native input',async field=>{
 const f=await fixture();let exposed=0;
 const changes={owner:{ownerId:'other'},session:{sessionHandle:'other'},generation:{generation:2},document:{documentDigest:'changed'},revision:{revision:2},element:{elementRef:'changed'},file:{fileId:crypto.randomUUID()},hash:{sha256:'a'.repeat(64)},size:{byteSize:bytes.length+1},filename:{filename:'other.csv'},destination:{destination:'https://other.fixture.invalid/import'}};
 const binding={...f.binding,...changes[field]};
 await expect(browserUploadBytes({binding,session:f.session,snapshot:f.snapshot,workspace:{export:async()=>({meta:f.file,bytes})} as never,now:()=>f.now,assertCurrent:async()=>{},beforeExposure:async()=>{},select:async()=>{exposed++;}})).rejects.toThrow();expect(exposed).toBe(0);
});
it('reads back exact approved workspace bytes and checkpoints before file-input exposure',async()=>{
 const f=await fixture(),events:string[]=[];
 await browserUploadBytes({binding:f.binding,session:f.session,snapshot:f.snapshot,workspace:{export:async(id:string,revision:number)=>{expect(id).toBe(f.file.file_id);expect(revision).toBe(1);events.push('readback');return {meta:f.file,bytes};}} as never,now:()=>f.now,assertCurrent:async()=>{},beforeExposure:async()=>{events.push('checkpoint');},select:async(file)=>{events.push('input');expect(file).toEqual({name:'report.csv',mimeType:'text/csv',buffer:bytes});}});
 expect(events).toEqual(['readback','checkpoint','input']);
});
it.each(['revoked','expired','corrupt'] as const)('%s approval cannot expose workspace bytes',async mode=>{
 const f=await fixture();let exposed=0;
 await expect(browserUploadBytes({binding:f.binding,session:f.session,snapshot:f.snapshot,workspace:{export:async()=>({meta:f.file,bytes:mode==='corrupt'?new Uint8Array(bytes.length):bytes})} as never,now:()=>mode==='expired'?f.session.expiresAt+1:f.now,assertCurrent:async()=>{if(mode==='revoked')throw Error('revoked');},beforeExposure:async()=>{},select:async()=>{exposed++;}})).rejects.toThrow();expect(exposed).toBe(0);
});
