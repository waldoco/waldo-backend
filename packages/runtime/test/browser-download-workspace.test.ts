import {expect,it} from 'vitest';
import {workspaceStore,type WorkspaceState} from '@waldo/workspace';
import {browserDownloadToWorkspace} from '../src/channels/browser-download-workspace';
import {generalDigest} from '../src/channels/general-browser-observation';

it('imports external attachment bytes, verifies owner retrieval and recovers the committed operation without bytes',async()=>{
 const state:WorkspaceState={binding:null,files:[],bodies:[],operations:[]},bodies=new Map<string,Uint8Array>();
 const workspace=await workspaceStore({binding:{ownerId:'12345678-1234-1234-1234-123456789abc',environment:'staging',namespace:'fixture',doName:'owner',doId:'physical',stateVersion:1,mappingVersion:1},metadata:{transaction:work=>work(state)},admit:async()=>({status:'ok'}),bodies:{put:async(meta,bytes)=>{bodies.set(meta.blob_id,bytes.slice());},get:async meta=>bodies.get(meta.blob_id)??null,remove:async()=>{}},now:Date.now,newId:()=>crypto.randomUUID()});
 const bytes=new TextEncoder().encode('name,value\nfictional,7\n'),metadata={filename:'report.csv',mime:'text/csv',byte_size:bytes.length,sha256:await generalDigest(bytes)};
 const options={workspace,operationId:crypto.randomUUID(),origin:'https://owner.invalid',metadata,deadline:Date.now()+60000,now:Date.now,assertCurrent:async()=>{}};
 const receipt=await browserDownloadToWorkspace({...options,bytes});
 expect(receipt).toMatchObject({...metadata,provenance:'provider_import',audience:'owner_authenticated',retrieval:'verified'});
 expect((await workspace.export(receipt.file_id,receipt.revision)).bytes).toEqual(bytes);
 expect(await browserDownloadToWorkspace(options)).toEqual(receipt);expect(state.files).toHaveLength(1);
});
it('a stalled authority check settles at the actual task expiry without importing bytes',async()=>{
 await expect(browserDownloadToWorkspace({workspace:{} as never,operationId:crypto.randomUUID(),origin:'https://owner.invalid',metadata:{filename:'report.csv',mime:'text/csv',byte_size:1,sha256:'a'.repeat(64)},deadline:Date.now()+20,now:Date.now,assertCurrent:()=>new Promise<void>(()=>{})} as never)).rejects.toMatchObject({code:'unavailable'});
},200);
it.each(['corrupt','revoked'] as const)('%s readback cannot publish a verified download receipt',async mode=>{
 const bytes=new TextEncoder().encode('fictional CSV'),operationId=crypto.randomUUID(),sha256=await generalDigest(bytes),metadata={filename:'report.csv',mime:'text/csv',byte_size:bytes.length,sha256};let revoked=false;
 const meta={...metadata,path:`browser-downloads/${operationId}/report.csv`,file_id:crypto.randomUUID(),revision:1,provenance:'provider_import'};
 const workspace={write:async()=>meta,export:async()=>{revoked=mode==='revoked';return {meta,bytes:mode==='corrupt'?new Uint8Array(bytes.length):bytes};}} as never;
 await expect(browserDownloadToWorkspace({workspace,operationId,origin:'https://owner.invalid',metadata,bytes,deadline:Date.now()+60000,now:Date.now,assertCurrent:async()=>{if(revoked)throw Error('owner revoked during readback');}})).rejects.toMatchObject({code:mode==='corrupt'?'integrity_unavailable':'unavailable'});
});
